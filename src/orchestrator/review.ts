import path from "node:path";
import { AGENT_PROVIDER, modelText, parseTicketModel, ranModelText, type TicketModel } from "../agents.js";
import { fromMicroUsd, toMicroUsd } from "../config.js";
import { ticketDifficulty, WorkflowError, type CommandResult, type ModelReview, type PlanDocument, type ReviewStage, type TaskState } from "../domain.js";
import { runModelReview, unreviewedDiff } from "../review/model-review.js";
import { droppedNote } from "../review/scored-json.js";
import { reviewDiff } from "../review/review.js";
import { redact } from "../redact.js";
import { atomicWrite } from "../storage/store.js";
import { budgetState, gateBudget, record, SESSION_TASK_ID } from "./budget.js";
import { done, excludedPaths, guard, iso, type WorkflowContext } from "./context.js";
import { activeTask, displayName } from "./tasks.js";
import { runFixInTab } from "./review-fix.js";
import { herdrSpace } from "../runner/ticket.js";
import { formatDuration, formatUsd } from "./format.js";
import { findingsTable, reviewItems, reviewMarkdown, type ReviewItem, type ReviewTicketRow } from "./review-report.js";
import { costLabel, reviewLabel } from "./build.js";
import { announce, reviewModel, routeFor, type Route } from "./routing.js";
import { carriedFindings } from "./ticket-review.js";
import { sweepAgentLogs } from "./agent-sweep.js";
import { runAgentReview, type ReviewAgent } from "./agent-review.js";
import { splitCheckLine } from "./tickets.js";

export { reviewItems, reviewMarkdown, type ReviewItem };

/**
 * The checks a review runs: the configured ones, else every distinct check the plan's tickets carry (already
 * validated at plan time), so a project without `checks:` still gets tool evidence.
 */
export function reviewChecks(ctx: WorkflowContext, plan?: PlanDocument): { name: string; command: string; args: string[] }[] {
  if (ctx.config.checks.length > 0) return ctx.config.checks.map((check) => ({ name: check.name, command: check.command, args: check.args }));
  const lines = [...new Set((plan?.tickets ?? []).flatMap((ticket) => ticket.checks ?? []))];
  return lines.map((line) => ({ name: line, ...splitCheckLine(line) }));
}

/**
 * The model that runs the /review model pass: `models.review`, or `override` (`/review --with`). A Pi model is a one-shot
 * call on the diff; an agent reads the repository in a herdr tab (`agent-review.ts`).
 */
function passModel(ctx: WorkflowContext, override?: TicketModel): { route: Route; candidate?: { provider: string; model: string }; agent?: ReviewAgent; problem?: string } {
  const model = override ?? reviewModel(ctx.config);
  const route = routeFor(ctx, "review", model);
  if (model.kind === "agent") return { route, agent: { name: model.name, ...(model.model ? { model: model.model } : {}) } };
  if (route.blocked) return { route, problem: route.blocked };
  return { route, candidate: { provider: model.provider, model: model.id } };
}

/** `--with <ref>` from the arguments: the review model for this run. Throws a `USAGE`/`CONFIG_INVALID` error for anything else. */
export function parseReviewArgs(ctx: WorkflowContext, args: string): TicketModel | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  if (words[0] !== "--with" || words.length !== 2) throw new WorkflowError("USAGE", "Use /review, or /review --with <provider/id | agent:name[/model]> to review with another model for this run.");
  return parseTicketModel(words[1]!, ctx.config);
}

/**
 * The model pass: the review model reads the diff and lists advisory findings. A failed part is retried once on the
 * same model. Budget-gated before every call, each call ledgered under REVIEWING with reason "model review", and never
 * a reason for the review to pass or fail. Returns undefined when the pass is off: `review.model: false`, unless `--with` names a model.
 */
async function modelPass(ctx: WorkflowContext, taskId: string, plan: PlanDocument, picked: ReturnType<typeof passModel>, enabled: boolean, diff: string, agentInput?: Omit<Parameters<typeof runAgentReview>[1], "taskId" | "plan" | "agent">): Promise<ModelReview | undefined> {
  if (!enabled) return undefined;
  const { candidate } = picked;
  if (picked.agent) {
    const exhausted = budgetState(ctx, taskId).status === "hard" ? "the task or daily budget is exhausted." : undefined;
    if (exhausted) return { provider: AGENT_PROVIDER, model: picked.agent.name, findings: [], truncated: false, error: exhausted };
    return runAgentReview(ctx, { ...agentInput!, taskId, plan, agent: picked.agent }, (line) => ctx.progress?.(`Review: ${line}`));
  }
  const skip = (error: string): ModelReview => ({ provider: candidate?.provider ?? "none", model: candidate?.model ?? picked.route.label, findings: [], truncated: false, error });
  if (!ctx.chat) return skip("no model connection (only available inside a Pi session).");
  if (!candidate) return skip(picked.problem ?? "no review model is available.");
  const exhausted = () => (budgetState(ctx, taskId).status === "hard" ? "the task or daily budget is exhausted." : undefined);
  const stop = exhausted();
  if (stop) return skip(stop);
  const started = ctx.now().getTime();
  const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
  // Unknown cost stays unknown: one call with no price makes the pass's cost null, never zero.
  let micro: number | null = 0;
  let review: ModelReview;
  try {
    // Parts beyond review.maxChunks are not sent; the report only names the files they hold.
    const skipped = unreviewedDiff(diff, ctx.config.review.maxDiffChars, ctx.config.review.maxChunks);
    const notSentFiles = skipped.split(/(?=^diff --git )/m).flatMap((text) => {
      const name = /^diff --git a\/.+? b\/(.+)$/m.exec(text.split("\n", 1)[0] ?? "")?.[1];
      return name ? [name] : [];
    });
    review = await runModelReview(ctx.chat!, candidate, {
      notSent: notSentFiles.length > 0 ? notSentFiles.map((name) => `- ${name}`).join("\n") : undefined,
      plan,
      diff,
      maxDiffChars: ctx.config.review.maxDiffChars,
      maxChunks: ctx.config.review.maxChunks,
      timeoutMs: ctx.config.review.timeoutMs,
      signal: ctx.shutdown.signal,
      onProgress: progress,
      stop: () => exhausted()?.replace(/\.$/, ""),
      onCall: async (call) => {
        // A failed call may or may not have been billed: its usage is unknown, never zero.
        const entry = record(ctx, taskId, "REVIEWING", "review", call.candidate.provider, call.candidate.model, call.usage, call.outcome === "success" ? "success" : "failure", call.retry, "model review");
        micro = micro === null || entry.actualUsd === null ? null : micro + toMicroUsd(entry.actualUsd);
      },
    });
  } catch (error) {
    // Failed model calls do not throw; this is the bookkeeping around them. The pass is advisory, so /review goes on.
    return skip(`the model pass stopped: ${redact((error as Error).message || "unknown error")}`);
  }
  const costUsd = micro === null ? null : fromMicroUsd(micro);
  const elapsedMs = ctx.now().getTime() - started;
  progress(`model pass done: ${review.findings.length} finding(s)${droppedNote(review.dropped ?? 0)} in ${formatDuration(elapsedMs)}, ${formatUsd(costUsd)}`);
  return { ...review, elapsedMs, costUsd };
}

/**
 * What the ledger entries of this review cost: the model pass. An unknown charge makes the stage unknown, never $0.
 * Undefined when the review made no billed call.
 */
function modelCost(ctx: WorkflowContext, taskId: string, sinceMs: number): ReviewStage | undefined {
  let sum: number | null | undefined;
  let metered = false;
  for (const entry of ctx.store.readLedger()) {
    if (entry.taskId !== taskId || new Date(entry.at).getTime() < sinceMs || entry.reason !== "model review") continue;
    // A subscription agent's "not metered" row is no dollar figure: the stage reads "not metered" unless something else billed.
    if (entry.meter !== "not-metered") metered = true;
    sum = sum === null || entry.actualUsd === null ? null : (sum ?? 0) + toMicroUsd(entry.actualUsd);
  }
  if (sum === undefined) return undefined;
  if (!metered) return { notMetered: true };
  return { costUsd: sum === null ? null : fromMicroUsd(sum) };
}

/** The plan's tickets for the Tickets table; none without a plan. */
function ticketRows(state: TaskState | undefined): ReviewTicketRow[] {
  return (state?.plan?.tickets ?? []).map((ticket) => {
    const run = state?.ticketRuns?.[ticket.id];
    return {
      id: ticket.id,
      difficulty: ticketDifficulty(ticket),
      implementer: run?.provider && run.model ? ranModelText(run.provider, run.model) : "—",
      review: reviewLabel(run),
      cost: run ? costLabel(run) : "—",
    };
  });
}

/** "20261014-120000" from the injected clock. */
function stamp(ctx: WorkflowContext): string {
  return ctx.now().toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
}

/**
 * The ref to diff against. On a branch: the local base branch, else its remote-tracking copy. On the base branch
 * itself, `origin/<base>` when it exists (so local commits it lacks are reviewed too), else the branch (uncommitted
 * changes only).
 */
async function baseRef(ctx: WorkflowContext, base: string, onBase: boolean): Promise<string> {
  const exists = async (ref: string) => (await ctx.git.git(["rev-parse", "--verify", "--quiet", ref])).code === 0;
  if (onBase) return (await exists(`refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
  if (await exists(`refs/heads/${base}`)) return base;
  if (await exists(`refs/remotes/origin/${base}`)) return `origin/${base}`;
  return base;
}

const numbered = (items: ReviewItem[]) => items.map((item, index) => `${index + 1}. ${item.text}`).join("\n");

/**
 * The message that sends findings to a model: the current session's (`tab` false), or a model in its own herdr tab, which
 * gets no "run /review again" (it cannot) and is told to stop when done.
 */
function fixMessage(items: ReviewItem[], checks: { command: string; args: string[] }[], request?: string, tab = false): string {
  const commands = checks.map((check) => `- \`${[check.command, ...check.args].join(" ")}\``);
  return redact(
    [
      request ? `Fix this from the review: ${request}` : `Fix all ${items.length} finding(s) from the review.`,
      "",
      request ? "All findings, for reference (the numbers match the list):" : "Findings:",
      numbered(items),
      "",
      "Rules:",
      "- Fix them in this working tree and keep the changes scoped to what is listed.",
      ...(commands.length ? ["- Run these checks and make them pass:", ...commands] : ["- No checks are configured; run the project's own tests if it has any."]),
      "- Do not commit, push, or switch branches.",
      "- Finish with one line per finding addressed, and say which ones you left and why.",
      "",
      ...(tab ? ["Then stop."] : ["Run /review again when done."]),
    ].join("\n"),
  );
}

/**
 * `/review`: reviews whatever differs from the base branch (commits ahead of it, uncommitted and untracked edits) with
 * the checks, a static scan, and the advisory model pass. Nothing is committed or pushed. With a UI, the findings open
 * in a dialog that offers to send them to the model in this session. A task is optional.
 */
export function review(ctx: WorkflowContext, args = ""): Promise<CommandResult> {
  return guard(() => runReview(ctx, parseReviewArgs(ctx, args)));
}

async function runReview(ctx: WorkflowContext, override?: TicketModel): Promise<CommandResult> {
  const found = await activeTask(ctx);
  const state = found && found.phase !== "COMPLETE" && found.phase !== "IDLE" ? found : undefined;
  const taskId = state?.taskId ?? SESSION_TASK_ID;
  const base = state?.build?.base ?? (await ctx.git.defaultBranch());
  const branch = await ctx.git.currentBranch();
  const ref = await baseRef(ctx, base, branch === base);
  // Workflow state is not the user's code: it stays out of the review and out of every model packet.
  const rawDiff = await ctx.git.workingDiff(ref, excludedPaths(ctx));
  if (!rawDiff.trim()) return done(`Nothing to review: no changes against ${base}.`);
  if (state) sweepAgentLogs(ctx, state.taskId);
  const exhausted = gateBudget(ctx, taskId);
  if (exhausted) return exhausted;

  const plan = state?.plan;
  const picked = passModel(ctx, override);
  // `--with` asks for the model pass by name, so it runs even when `review.model` is off.
  const modelOn = ctx.config.review.model || override !== undefined;
  await announce(ctx, state?.taskId, "review", picked.route);
  const started = ctx.now().getTime();
  const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
  const checks = reviewChecks(ctx, plan);
  progress(`started · ${branch} against ${ref} · ${ctx.config.setup.length} setup step(s), ${checks.length} check(s) · model ${modelOn ? (picked.candidate || picked.agent ? picked.route.label : `unavailable (${picked.problem})`) : "off"}`);
  const diff = redact(rawDiff);
  const report = await reviewDiff({
    diff: rawDiff,
    checks,
    setup: ctx.config.setup,
    now: () => ctx.now().getTime(),
    onProgress: progress,
    cwd: ctx.git.repoRoot,
    runner: ctx.checkRunner,
    planAcceptance: plan?.acceptance ?? [],
  });
  const reviewPlan: PlanDocument = plan ?? { version: 0, createdAt: iso(ctx), summary: `Ad-hoc changes on ${branch}.`, risks: [], acceptance: [], groups: [], overlap: [], securitySensitive: false };
  const mergeBase = picked.agent ? await ctx.git.mergeBase(ref).catch(() => ref) : ref;
  const modelReview = await modelPass(ctx, taskId, reviewPlan, picked, modelOn, report.diff ?? diff, { hasTask: !!state, base: { ref, sha: mergeBase }, exclude: excludedPaths(ctx), stamp: stamp(ctx) });
  report.modelReview = modelReview;
  const carried = carriedFindings(state, modelReview?.findings);
  if (carried.length > 0) report.carried = carried;
  report.elapsedMs = ctx.now().getTime() - started;
  report.at = iso(ctx);
  report.headSha = await ctx.git.head().catch(() => undefined);
  report.stages = {
    ...report.stages,
    ...(modelReview ? { model: { elapsedMs: modelReview.elapsedMs, ...modelCost(ctx, taskId, started) } } : {}),
  };
  const setupConfigured = ctx.config.setup.length > 0;
  const saved = state ? `.pi-workflows/tasks/${state.taskId}/reports/review.md` : `.pi-workflows/reports/review-${stamp(ctx)}.md`;
  const markdown = reviewMarkdown(report, { setupConfigured, savedAs: saved, tickets: ticketRows(state) });
  ctx.report?.(markdown);
  if (state) {
    ctx.store.writeText(state.taskId, "reports/review.json", JSON.stringify(report, null, 2));
    ctx.store.writeText(state.taskId, "reports/review.md", markdown);
    await ctx.store.update(state.taskId, "review", (task) => ({ ...task, review: report, updatedAt: iso(ctx) }));
  } else {
    const name = path.join(ctx.store.root, "reports", `review-${stamp(ctx)}`);
    atomicWrite(`${name}.json`, JSON.stringify(report, null, 2));
    atomicWrite(`${name}.md`, markdown);
  }

  // The chat block above holds the detail; the command result stays short.
  const text = ctx.report ? `${report.summary} (${formatDuration(report.elapsedMs)}; details above)` : markdown;
  const items = reviewItems(report);
  const result = (message: string): CommandResult =>
    report.passed ? { ok: true, text: message, data: report } : { ok: false, code: "REVIEW_BLOCKING", text: `${message}\nFix the problems, then /review again. Nothing was committed or pushed.`, data: report };
  if (items.length === 0 && report.passed) return result(`Review passed: ${report.checks.length} check(s), no findings.`);
  if (!ctx.review || items.length === 0) return result(text);

  // Fixing in a tab is offered only inside herdr, when `models.medium` parses (and, for a Pi model, Pi can start a child).
  let fixModel: TicketModel | undefined;
  try {
    const medium = parseTicketModel(ctx.config.models.medium, ctx.config);
    if (!("problem" in (await herdrSpace(ctx.herdr))) && (medium.kind === "agent" || ctx.ticketModePath)) fixModel = medium;
  } catch {
    fixModel = undefined;
  }
  const choice = await ctx.review({
    title: `Review · ${items.length} finding(s)`,
    markdown: [`## ${items.length} finding(s)`, "", ...findingsTable(report)].join("\n"),
    // The report above already holds this table; only the choice is shown.
    alreadyShown: !!ctx.report,
    actions: [
      ...(fixModel ? [{ value: "fix-tab", label: `Fix all in a tab (${modelText(fixModel)})` }] : []),
      { value: "fix-all", label: "Fix all" },
      { value: "fix-some", label: "Fix…", input: "What should be fixed? (finding numbers like 1, 3, and/or your own instructions)" },
      { value: "close", label: "Close" },
    ],
  });
  if (choice?.value === "fix-tab" && fixModel) {
    const fixed = await runFixInTab(ctx, { prompt: fixMessage(items, checks, undefined, true), model: fixModel, taskId, taskName: state ? displayName(state) : "" });
    // The verdict is in the report and in state.review; this is what the fix did.
    return fixed.ok ? done(fixed.text, report) : { ok: false, code: "REVIEW_FIX_FAILED", text: fixed.text, data: report };
  }
  const request = choice?.value === "fix-some" ? (choice.text ?? "").trim() : undefined;
  if (ctx.startTurn && (choice?.value === "fix-all" || (choice?.value === "fix-some" && request))) {
    ctx.startTurn(fixMessage(items, checks, request));
    // The turn is the outcome here; the verdict is in the report and in state.review.
    return done(request ? `Sent your fix request to the model (${items.length} finding(s) listed for reference).` : `Sent ${items.length} finding(s) to the model to fix.`, report);
  }
  return result(text);
}
