import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CHILD_ROOT_ENV, CHILD_TASK_ENV, CHILD_TICKET_ENV, TICKET_TOOLS, type RunnerEvent, type RunnerSpend, type TicketRunResult } from "../agents/pi-runner.js";
import { buildCostRecord } from "../cost/ledger.js";
import { fromMicroUsd, toMicroUsd } from "../config.js";
import type { CheckEvidence, RoutingDecision, TaskState, Ticket, TicketRun, WorkerArtifact, WorktreeRecord } from "../domain.js";
import { redact } from "../redact.js";
import { assertCommandAllowed } from "../sandbox.js";
import { budgetState, chargeInFlight, recordTicketUsage } from "./budget.js";
import type { InFlightRun } from "./inflight.js";
import { iso, knownZero, requireActive, type WorkflowContext } from "./context.js";
import { SPEC_FILE } from "./interview.js";
import { TICKET_WORKER_RULES, ticketPrompt } from "./prompts.js";
import { announce, decide, suggestAdvisor } from "./routing.js";
import { addTicketWarning, groupId, parseCriteriaMet, setTicketStatus, tickCriteria, ticketFileName, type TicketStatus } from "./tickets.js";

const MAX_SUMMARY_CHARS = 3000;

export interface TicketJobOutcome {
  artifact: WorkerArtifact;
  warnings: string[];
  /** True when the job stopped because the budget is exhausted. No further tickets should start. */
  budget: boolean;
}

const BLANK: TicketRun = { status: "in-progress", attempts: 0, turns: 0, tokens: 0, costUsd: 0, maxContextTokens: 0, crossedTarget: false };

function ticketPath(ticket: Ticket): string {
  return `tickets/${ticketFileName(ticket)}`;
}

async function patchRun(ctx: WorkflowContext, taskId: string, ticket: Ticket, patch: (previous: TicketRun) => TicketRun): Promise<void> {
  await ctx.store.update(taskId, `ticket ${ticket.id}`, (task) => ({
    ...task,
    ticketRuns: { ...task.ticketRuns, [ticket.id]: patch(task.ticketRuns?.[ticket.id] ?? BLANK) },
    updatedAt: iso(ctx),
  }));
}

function editTicketFile(ctx: WorkflowContext, taskId: string, ticket: Ticket, edit: (markdown: string) => string): void {
  const relative = ticketPath(ticket);
  const current = ctx.store.readText(taskId, relative);
  if (current === undefined) return;
  const next = edit(current);
  if (next !== current) ctx.store.writeText(taskId, relative, next);
}

function repoRules(ctx: WorkflowContext): string | undefined {
  const file = path.join(ctx.cwd, "AGENTS.md");
  try {
    return existsSync(file) ? redact(readFileSync(file, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

function splitCommand(line: string): { command: string; args: string[] } {
  const [command = "", ...args] = line.trim().split(/\s+/);
  return { command, args };
}

/** Parent variables the child needs by name: the Foundry endpoint variable and the local provider's key variable, as configured. */
function childEnvNames(ctx: WorkflowContext): string[] {
  const providers = ctx.config.providers;
  return [providers.foundry?.endpointEnv, providers.local?.apiKeyEnv].filter((name): name is string => !!name);
}

/** Configured checks, then the ticket's own, through the sandbox allowlist and the caching runner. */
async function runChecks(ctx: WorkflowContext, ticket: Ticket, cwd: string): Promise<CheckEvidence[]> {
  const planned = [
    ...ctx.config.checks.map((check) => ({ name: check.name, command: check.command, args: check.args })),
    ...(ticket.checks ?? []).map((line) => ({ name: line, ...splitCommand(line) })),
  ];
  const out: CheckEvidence[] = [];
  for (const check of planned) {
    const base = { name: check.name, command: check.command, args: check.args, cwd };
    try {
      assertCommandAllowed(check.command, check.args, ctx.config.commandAllowlist);
    } catch (error) {
      out.push({ ...base, exitCode: 126, stdout: "", stderr: redact((error as Error).message).slice(0, 2000), ran: false });
      continue;
    }
    const result = await ctx.checkRunner.run(check.command, check.args, cwd);
    out.push({ ...base, exitCode: result.code, stdout: redact(result.stdout).slice(0, 2000), stderr: redact(result.stderr).slice(0, 2000), ran: true });
  }
  return out;
}

/** The route for one ticket attempt. A tier with no model cannot run a child, so it moves up one tier. */
async function pick(ctx: WorkflowContext, state: TaskState, ticket: Ticket, failedTier: RoutingDecision["tier"] | undefined, escalations: number): Promise<RoutingDecision> {
  const classification = state.classification!;
  // A ticket child cannot answer a login prompt, so only signed-in providers are eligible; an unusable tier moves up.
  let decision = await decide(ctx, classification, "implement", { taskId: state.taskId, failedTier, escalations, tierHint: failedTier ? undefined : ticket.suggestedTier, strictAvailability: true });
  if (decision.provider === "none" && !decision.blocked) {
    decision = await decide(ctx, classification, "implement", { taskId: state.taskId, failedTier: decision.tier, escalations, strictAvailability: true });
  }
  return decision;
}

function failureReason(result: TicketRunResult | undefined, thrown: string | undefined, checks: CheckEvidence[]): string | undefined {
  if (thrown) return thrown;
  if (!result) return "The ticket runner returned nothing.";
  if (result.aborted) return "Cancelled.";
  if (result.timedOut) return "The child pi process exceeded its deadline.";
  if (!result.ok) return result.error ?? `pi exited with code ${result.exitCode}${result.stderrTail.trim() ? `: ${result.stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`;
  const failed = checks.filter((item) => item.exitCode !== 0);
  return failed.length ? `Checks failed: ${failed.map((item) => `${item.name} exited ${item.exitCode}`).join("; ")}` : undefined;
}

/**
 * Runs one ticket to done or failed: routes it, runs a fresh child pi in its worktree, commits, runs checks,
 * ledgers the child's usage, updates the ticket file, and on failure retries at the next tier in a fresh child
 * on the same worktree (up to routing.maxEscalations).
 */
export async function runTicket(ctx: WorkflowContext, taskId: string, ticket: Ticket, record: WorktreeRecord, signal: AbortSignal): Promise<TicketJobOutcome> {
  const runner = ctx.ticketRunner!;
  const warnings: string[] = [];
  const startHead = record.headSha;
  const target = ctx.config.workers.ticketContextTokens;
  const issues: string[] = [];
  let evidence: CheckEvidence[] = [];
  let budgetStop = false;
  let succeeded = false;
  let failedTier: RoutingDecision["tier"] | undefined;
  let previousFailure: string | undefined;
  const taskType = () => requireActive(ctx).classification?.task_type ?? "general";

  const finish = async (status: TicketStatus, finalText: string): Promise<void> => {
    const met = parseCriteriaMet(finalText, ticket.acceptanceCriteria);
    editTicketFile(ctx, taskId, ticket, (markdown) => {
      let next = setTicketStatus(tickCriteria(markdown, met), status);
      const run = ctx.store.load(taskId)?.ticketRuns?.[ticket.id];
      if (run?.crossedTarget) next = addTicketWarning(next, `exceeded the soft ${target}-token context target (peak ~${run.maxContextTokens}); consider splitting this ticket.`);
      return next;
    });
  };

  let finalText = "";
  const flights: InFlightRun[] = [];
  try {
    for (let escalations = 0; ; escalations++) {
      if (signal.aborted) {
        issues.push("Cancelled.");
        break;
      }
      if (budgetState(ctx, taskId).status === "hard") {
        budgetStop = true;
        issues.push("Task or daily budget is exhausted; the ticket was not started.");
        break;
      }
      const state = requireActive(ctx);
      const decision = await pick(ctx, state, ticket, failedTier, escalations);
      if (decision.blocked || decision.provider === "none") {
        issues.push(decision.blocked ?? "No model is available for this ticket.");
        break;
      }
      const view = await ctx.authProbe.inspect(decision.provider);
      if (view.status !== "ready") {
        issues.push(view.detail);
        break;
      }
      await announce(ctx, taskId, "implement", decision, () => ctx.status?.(`ticket ${ticket.id} → ${decision.provider}/${decision.model}`));
      await patchRun(ctx, taskId, ticket, (run) => ({ ...run, status: "in-progress", tier: decision.tier, provider: decision.provider, model: decision.model, attempts: run.attempts + 1, error: undefined }));
      editTicketFile(ctx, taskId, ticket, (markdown) => setTicketStatus(markdown, "in-progress"));

      const latest = ctx.store.load(taskId)!;
      const blockers = ticket.blockedBy.map((id) => {
        const blocker = latest.plan?.tickets?.find((item) => item.id === id);
        return { id, title: blocker?.title ?? id, summary: latest.ticketRuns?.[id]?.summary ?? "" };
      });
      const prompt = ticketPrompt({ ticket, spec: ctx.store.readText(taskId, SPEC_FILE), blockers, repoRules: repoRules(ctx), previousFailure });
      let result: TicketRunResult | undefined;
      let thrown: string | undefined;
      // This attempt's own abort: the caller's signal, or a budget stop raised by any concurrent ticket's spend.
      const attemptStop = new AbortController();
      let budgetReason: string | undefined;
      const flight = ctx.inflight.begin(taskId, (why) => {
        budgetReason ??= why;
        attemptStop.abort();
      });
      flights.push(flight);
      const forward = () => attemptStop.abort();
      if (signal.aborted) attemptStop.abort();
      else signal.addEventListener("abort", forward, { once: true });
      const charge = (spend: RunnerSpend) => {
        const priced = spend.costUsd !== null && spend.costUsd > 0 ? spend.costUsd : buildCostRecord(
          { provider: decision.provider, model: decision.model, phase: "IMPLEMENTING", taskId, tier: decision.tier, usage: { ...spend.usage, requests: 1 }, outcome: "unknown", retries: 0, reason: "in-flight", estimatedUsd: null },
          ctx.config.pricing,
          ctx.now(),
          "in-flight",
        ).actualUsd;
        chargeInFlight(ctx, flight, priced ?? 0);
      };
      try {
        result = await runner({
          ticket,
          prompt,
          worktreePath: record.path,
          model: { provider: decision.provider, id: decision.model },
          tools: TICKET_TOOLS,
          systemPromptAppend: TICKET_WORKER_RULES,
          env: { [CHILD_TASK_ENV]: taskId, [CHILD_TICKET_ENV]: ticket.id, [CHILD_ROOT_ENV]: ctx.cwd, ...(await ctx.git.childGitEnv(record.path)) },
          allowEnv: childEnvNames(ctx),
          signal: attemptStop.signal,
          deadlineMs: ctx.config.workers.deadlineMs,
          contextTarget: target,
          onEvent: (event: RunnerEvent) => {
            if ((event.kind === "turn" || event.kind === "compaction") && event.spend) charge(event.spend);
            if (event.kind === "turn") ctx.status?.(`ticket ${ticket.id} · turn ${event.turn} · ~${Math.round(event.contextTokens / 1000)}k ctx`);
            else if (event.kind === "crossed-target") {
              const note = `Ticket ${ticket.id} passed the soft ${target}-token context target (~${event.contextTokens}). Pi's compaction continues; consider splitting it.`;
              if (!warnings.includes(note)) {
                warnings.push(note);
                ctx.notify(note);
              }
            }
          },
        });
      } catch (error) {
        thrown = redact((error as Error).message || "The ticket runner failed.");
      } finally {
        signal.removeEventListener("abort", forward);
      }
      // Commit whatever the child left, so a retry or escalation builds on it and review sees it.
      try {
        record.headSha = await ctx.git.commitAll(record.path, `ticket ${ticket.id}: ${ticket.title}`);
      } catch (error) {
        thrown ??= `Could not commit the ticket's changes: ${redact((error as Error).message)}`;
      }
      evidence = result?.ok && !thrown ? await runChecks(ctx, ticket, record.path) : [];
      const reason = failureReason(result, thrown ?? budgetReason, evidence);
      const ok = reason === undefined;
      finalText = result?.finalText ?? "";
      const usage = result?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: 0 };
      // The parent ledgers the child's usage exactly once, here; the child records none of its own model calls.
      const entry = recordTicketUsage(ctx, requireActive(ctx), { tier: decision.tier, provider: decision.provider, model: decision.model, usage, outcome: ok ? "success" : "failure", retries: escalations, reason: `ticket ${ticket.id}` });
      ctx.inflight.release(flight);
      if (budgetReason) budgetStop = true;
      await ctx.store.bumpMetric(taskType(), decision.tier, ok, ctx.now(), decision.candidate);
      await patchRun(ctx, taskId, ticket, (run) => ({
        ...run,
        status: "in-progress",
        turns: run.turns + usage.turns,
        tokens: run.tokens + usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        costUsd: run.costUsd === null || entry.actualUsd === null ? null : fromMicroUsd(toMicroUsd(run.costUsd) + toMicroUsd(entry.actualUsd)),
        maxContextTokens: Math.max(run.maxContextTokens, result?.maxContextTokens ?? 0),
        crossedTarget: run.crossedTarget || !!result?.crossedTarget,
        summary: result?.finalText ? result.finalText.slice(0, MAX_SUMMARY_CHARS) : run.summary,
        error: reason,
      }));
      if (ok) {
        succeeded = true;
        break;
      }
      issues.push(`${decision.provider}/${decision.model}: ${reason}`);
      previousFailure = reason;
      if (result?.aborted || signal.aborted) break;
      if (escalations >= ctx.config.routing.maxEscalations) break;
      failedTier = decision.tier;
    }
  } finally {
    for (const flight of flights) ctx.inflight.release(flight);
  }

  await patchRun(ctx, taskId, ticket, (run) => ({ ...run, status: succeeded ? "done" : "failed", error: succeeded ? undefined : issues.at(-1) }));
  await finish(succeeded ? "done" : "failed", finalText);
  if (!succeeded && !budgetStop) suggestAdvisor(ctx, taskId, `ticket ${ticket.id} failed`);
  const run = ctx.store.load(taskId)?.ticketRuns?.[ticket.id];
  if (run?.crossedTarget) {
    const note = `Ticket ${ticket.id} exceeded the soft ${target}-token target (peak ~${run.maxContextTokens}); consider splitting it.`;
    if (!warnings.some((item) => item.startsWith(`Ticket ${ticket.id} `))) warnings.push(note);
  }
  const changed = await ctx.git.git(["diff", "--name-only", startHead, "HEAD"], record.path);
  return {
    budget: budgetStop,
    warnings,
    artifact: {
      summary: ticket.title,
      changedFiles: changed.code === 0 ? changed.stdout.split("\n").filter(Boolean) : [],
      testResults: evidence,
      unresolvedIssues: succeeded ? [] : issues.length ? issues : [`${groupId(ticket)} failed`],
      usage: knownZero(),
    },
  };
}
