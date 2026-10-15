import path from "node:path";
import { emptyUsage, WorkflowError, type AttemptRecord, type RoutingDecision, type TaskState, type Tier, type TokenUsage, type WorktreeRecord } from "../domain.js";
import { runWorkerPool, type WorkerJob } from "../agents/pool.js";
import { createModelExecutor } from "../agents/model-executor.js";
import { redact } from "../redact.js";
import { addUsage, iso, knownZero, type WorkflowContext } from "./context.js";
import { formatDuration, formatTokens, formatUsd } from "./format.js";
import { assertGraph, waves } from "./plan.js";
import { groupId } from "./tickets.js";
import { runTicket } from "./ticket-run.js";

/** Set for ticket plans: each ticket already ledgered its own usage and metrics, so the caller must not add more. */
interface TicketBookkeeping {
  ledgered?: true;
  warnings?: string[];
}

export type ImplementationOutcome =
  | ({ ok: true; summary: string; handoff: string; usage: TokenUsage } & TicketBookkeeping)
  | ({
      ok: false;
      error: string;
      usage: TokenUsage;
      /** Retrying at a higher tier cannot help. */
      fatal?: boolean;
      /** A ticket ran out of escalations: park the task as BLOCKED and suggest /advisor. */
      blocked?: boolean;
      /** The budget ran out, so no further tickets were started. */
      budget?: boolean;
    } & TicketBookkeeping);

function mergeWorktrees(current: WorktreeRecord[], next: WorktreeRecord[]): WorktreeRecord[] {
  const map = new Map(current.map((item) => [item.groupId, item]));
  for (const item of next) map.set(item.groupId, item);
  return [...map.values()];
}

function describeFailure(item: { id: string; status?: string; error?: string; artifact?: { unresolvedIssues: string[] } }): string {
  if (item.status === "skipped") return `${item.id} skipped${item.error ? ` (${item.error})` : ""}`;
  if (item.status === "cancelled") return `${item.id} cancelled`;
  if (item.error === "deadline") return `${item.id} exceeded its deadline`;
  if (item.error) return `${item.id}: ${item.error}`;
  return `${item.id}: ${item.artifact?.unresolvedIssues.join("; ") ?? "failed"}`;
}

function attempt(tier: Tier, provider: string, model: string, outcome: AttemptRecord["outcome"], at: string): AttemptRecord {
  return { tier, provider, model, outcome, at };
}

/** The block posted when a ticket implementation ends: one line per ticket with its trail, then the totals. */
export function implementationReport(state: TaskState, elapsedMs: number, outcome: "done" | "failed", integration?: string): string {
  const runs = Object.entries(state.ticketRuns ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const lines = runs.map(([id, run]) => {
    const title = state.plan?.tickets?.find((ticket) => ticket.id === id)?.title ?? "";
    const trail = (run.attemptLog ?? []).map((item) => `${item.provider}/${item.model} ${item.outcome === "success" ? "✓" : "✗"} ${formatDuration(item.elapsedMs)}`).join(" → ");
    return `- ${id} ${run.status === "done" ? "✓" : run.status === "failed" ? "✗" : "…"} ${title}: ${run.turns} turn(s), ${formatTokens(run.tokens)} tokens, ${formatUsd(run.costUsd)}, ${formatDuration(run.elapsedMs ?? 0)}${trail ? ` [${trail}]` : ""}${run.error && run.status !== "done" ? ` — ${run.error.slice(0, 160)}` : ""}`;
  });
  const cost = runs.some(([, run]) => run.costUsd === null) ? "cost partly unknown" : formatUsd(runs.reduce((sum, [, run]) => sum + (run.costUsd ?? 0), 0));
  const turns = runs.reduce((sum, [, run]) => sum + run.turns, 0);
  return [
    `## Implementation ${outcome} in ${formatDuration(elapsedMs)}`,
    ...lines,
    `- Total: ${runs.filter(([, run]) => run.status === "done").length} of ${runs.length} ticket(s) done, ${turns} turn(s), ${cost}`,
    ...(integration ? [`- Integration: ${integration}`] : []),
  ].join("\n");
}

/** Runs the plan's groups wave by wave in their own worktrees, then merges them into the integration branch. */
export async function runImplementation(ctx: WorkflowContext, initial: TaskState, decision: RoutingDecision): Promise<ImplementationOutcome> {
  let state = initial;
  const startedAt = ctx.now().getTime();
  const report = (outcome: "done" | "failed", integration?: string) => {
    if (tickets) ctx.report?.(implementationReport(requireActiveState(), ctx.now().getTime() - startedAt, outcome, integration));
  };
  const requireActiveState = () => ctx.store.load(state.taskId) ?? state;
  const tier = decision.tier;
  const plan = state.plan!;
  assertGraph(plan.groups);
  const explicit = ctx.executors[tier];
  // Without an explicit executor, a model-backed tier writes edits only for groups the plan left empty;
  // groups with approved literal edits keep applying those exact edits.
  const modelExecutor = !explicit && ctx.chat && decision.provider !== "none" ? createModelExecutor(ctx.chat) : undefined;
  // Worktrees of groups an earlier plan version had (abandoned) take no part: not as the base, not as inputs, not in the merge.
  const liveWorktrees = (task: TaskState) => task.worktrees.filter((item) => !item.abandoned);
  const baseSha = liveWorktrees(state)[0]?.baseSha ?? (await ctx.git.head());
  // Tickets run in child pi processes, one fresh process per ticket attempt; the plan's groups are their worktrees.
  const tickets = ctx.ticketRunner ? plan.tickets : undefined;
  const warnings: string[] = [];
  let budgetStop = false;
  const heads = new Map(liveWorktrees(state).map((item) => [item.groupId, item.headSha]));
  const branches = new Map(liveWorktrees(state).map((item) => [item.groupId, item.branch]));
  // Literal edits need no model, so they are a known zero. An executor that omits usage makes this unknown.
  let usage = knownZero();
  const ordered = waves(plan.groups);
  for (const [index, wave] of ordered.entries()) {
    if (tickets) ctx.progress?.(`Wave ${index + 1} of ${ordered.length}: ${wave.map((group) => group.id).join(", ")}`);
    const jobs: { groupId: string; record: WorktreeRecord; job: WorkerJob }[] = [];
    // Worktree creation stays sequential: git serializes on its own lock.
    for (const group of wave) {
      const existing = liveWorktrees(state).find((item) => item.groupId === group.id);
      const [first, ...others] = group.dependsOn;
      const base = first ? heads.get(first) ?? baseSha : baseSha;
      const dir = existing?.path ?? path.join(ctx.store.root, "worktrees", state.taskId, group.id);
      const branch = existing?.branch ?? `${ctx.config.worktrees.branchPrefix}/${state.taskId}/${group.id}`;
      const created = existing ?? (await ctx.git.createWorktree({ dir, branch, baseSha: base }));
      const record: WorktreeRecord = existing ?? { groupId: group.id, branch, path: dir, baseSha: base, headSha: created.headSha };
      if (!existing && others.length > 0) {
        // Branch from the first dependency and merge the rest in, so the group sees all of its inputs.
        for (const dep of others) {
          const depBranch = branches.get(dep);
          if (!depBranch) continue;
          const merged = await ctx.git.git(["merge", "--no-edit", "--no-ff", "--", depBranch], dir);
          if (merged.code !== 0) {
            await ctx.git.git(["merge", "--abort"], dir);
            throw new WorkflowError("GIT", `Could not merge dependency ${dep} into ${group.id}: ${(merged.stderr || merged.stdout).trim()}`);
          }
        }
        record.headSha = await ctx.git.head(dir);
      }
      jobs.push({
        groupId: group.id,
        record,
        job: {
          id: group.id,
          files: group.files,
          summary: group.summary,
          // A child's context is far larger than a model-executor reply, and its deadline covers every escalation.
          tokenBudget: tickets ? Number.MAX_SAFE_INTEGER : ctx.config.workers.tokenBudget,
          deadlineMs: tickets ? ctx.config.workers.deadlineMs * (ctx.config.routing.maxEscalations + 1) : ctx.config.workers.deadlineMs,
        },
      });
    }
    const sharedBudget = ctx.config.workers.tokenBudget * jobs.length;
    let usedTokens = 0;
    const pool = await runWorkerPool({
      jobs: jobs.map((item) => item.job),
      concurrency: ctx.config.workers.concurrency,
      signal: ctx.shutdown.signal,
      // Ticket attempts are not retried by the pool: escalation is the ticket runner's job, and a retry would respawn a child.
      ...(tickets ? { maxAttempts: 1 } : { budgetRemaining: () => sharedBudget - usedTokens }),
      run: async (job, signal, context) => {
        const group = plan.groups.find((item) => item.id === job.id)!;
        const located = jobs.find((item) => item.groupId === job.id)!;
        const ticket = tickets?.find((item) => groupId(item) === job.id);
        if (ticket) {
          // Done only counts with its worktree still live; a run left by an abandoned plan version is not this ticket's.
          if (state.ticketRuns?.[ticket.id]?.status === "done" && liveWorktrees(state).some((item) => item.groupId === job.id)) {
            return { summary: ticket.title, changedFiles: [], testResults: [], unresolvedIssues: [], usage: knownZero() };
          }
          const outcome = await runTicket(ctx, state.taskId, ticket, located.record, signal);
          warnings.push(...outcome.warnings);
          budgetStop ||= outcome.budget;
          return outcome.artifact;
        }
        let changedFiles = group.edits.map((edit) => edit.path);
        let groupUsage = knownZero();
        const executor = explicit ?? (modelExecutor && group.edits.length === 0 ? modelExecutor : undefined);
        if (executor) {
          try {
            const result = await executor({
              group,
              tier,
              provider: decision.provider,
              model: decision.model,
              cwd: located.record.path,
              write: (file, content) => ctx.git.writeOwned(located.record.path, file, content, group.files),
              signal,
              budgetRemaining: context?.budgetRemaining,
            });
            groupUsage = result.usage ?? emptyUsage();
            if (result.changedFiles) changedFiles = result.changedFiles;
          } catch (error) {
            usage = addUsage(usage, emptyUsage());
            throw error;
          }
        } else {
          for (const edit of group.edits) ctx.git.writeOwned(located.record.path, edit.path, edit.content, group.files);
        }
        usage = addUsage(usage, groupUsage);
        usedTokens += (groupUsage.input ?? 0) + (groupUsage.output ?? 0);
        if (executor || group.edits.length > 0) located.record.headSha = await ctx.git.commitAll(located.record.path, group.summary);
        const testResults = [];
        for (const check of ctx.config.checks) {
          const result = await ctx.checkRunner.run(check.command, check.args, located.record.path);
          testResults.push({
            name: check.name,
            command: check.command,
            args: check.args,
            cwd: located.record.path,
            exitCode: result.code,
            stdout: redact(result.stdout).slice(0, 2000),
            stderr: redact(result.stderr).slice(0, 2000),
            ran: true,
          });
        }
        const unresolved = testResults.filter((item) => item.exitCode !== 0).map((item) => `${item.name} exited ${item.exitCode}`);
        return { summary: group.summary, changedFiles, testResults, unresolvedIssues: unresolved, usage: groupUsage };
      },
    });
    // Record what exists on disk even if the wave failed, so a retry and /status see the same worktrees.
    const failures = pool.artifacts.filter((item) => (item.status && item.status !== "ok") || item.error || (item.artifact?.unresolvedIssues.length ?? 0) > 0);
    state = await ctx.store.update(state.taskId, `wave ${tier}`, (task) => ({
      ...task,
      worktrees: mergeWorktrees(task.worktrees, jobs.map((item) => item.record)),
      attempts: [...task.attempts, attempt(tier, decision.provider, decision.model, failures.length || pool.stopped !== "completed" ? "failure" : "success", iso(ctx))],
      updatedAt: iso(ctx),
    }));
    for (const item of jobs) {
      heads.set(item.groupId, item.record.headSha);
      branches.set(item.groupId, item.record.branch);
    }
    if (pool.stopped !== "completed" || failures.length > 0) {
      const detail = failures.map(describeFailure).join("; ");
      const stopped = pool.stopped !== "completed" ? `Workers stopped: ${pool.stopped}. ` : "";
      const error = `${stopped}${detail}`.trim() || "Workers failed.";
      if (tickets) {
        report("failed");
        return { ok: false, error, usage, fatal: true, blocked: !budgetStop && pool.stopped !== "cancelled", budget: budgetStop, ledgered: true, warnings };
      }
      return { ok: false, error, usage, fatal: pool.stopped === "cancelled" || pool.stopped === "budget" };
    }
  }
  const integrationBranch = `${ctx.config.worktrees.branchPrefix}/${state.taskId}/integration`;
  const integrationPath = path.join(ctx.store.root, "worktrees", state.taskId, "integration");
  let integrated;
  try {
    integrated = await ctx.git.integrate({
      integrationBranch,
      baseSha,
      worktreePath: integrationPath,
      branches: liveWorktrees(state).map((item) => item.branch),
    });
  } catch (error) {
    // A git failure is not a merge conflict, and a higher tier cannot fix it.
    if (error instanceof WorkflowError && error.code === "GIT") return { ok: false, error: `Integration failed: ${error.message}`, usage, fatal: true };
    throw error;
  }
  if (integrated.conflicts.length > 0 || !integrated.sha) {
    return { ok: false, error: `Conflict integrating ${integrated.conflicts.map((item) => item.branch).join(", ")}`, usage, ...(tickets ? { ledgered: true as const, warnings } : {}) };
  }
  const integrationSha = integrated.sha;
  await ctx.store.update(state.taskId, "integrated", (task) => ({
    ...task,
    integration: { branch: integrationBranch, sha: integrationSha, path: integrationPath },
    updatedAt: iso(ctx),
  }));
  ctx.store.writeText(state.taskId, "reports/implementation.json", JSON.stringify({ tier, integration: integrationSha, worktrees: liveWorktrees(state) }, null, 2));
  report("done", `${integrationBranch} @ ${integrationSha.slice(0, 12)}`);
  return {
    ok: true,
    summary: `Implemented ${liveWorktrees(state).length} worktree(s) on ${integrationBranch} at ${integrationSha}.`,
    usage,
    ...(tickets ? { ledgered: true as const, warnings } : {}),
    handoff: [
      "# Handoff after implementation",
      "",
      `Integration ${integrationBranch} @ ${integrationSha}`,
      `Base ${baseSha}`,
      ...liveWorktrees(state).map((item) => `- ${item.groupId} ${item.branch} ${item.headSha}`),
      "",
      "Review the diff against the approved plan. Do not treat this note as a test pass.",
    ].join("\n"),
  };
}
