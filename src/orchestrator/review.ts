import path from "node:path";
import { fromMicroUsd, tierCandidates, toMicroUsd } from "../config.js";
import { ticketDifficulty, type AcceptedClassification, type CommandResult, type ModelReview, type PlanDocument, type ReviewReport, type ReviewStage, type RoutingDecision, type TaskState, type TierCandidate } from "../domain.js";
import { availableAdvisors, reviewAdvisorsFor } from "../review/advisors.js";
import { runModelReview, unreviewedDiff } from "../review/model-review.js";
import { advisorsHeader } from "../review/review-resolution.js";
import { reviewDiff } from "../review/review.js";
import { classifyKeywords } from "../router/classify.js";
import { reviewMetricType } from "../router/stats.js";
import { redact } from "../redact.js";
import { atomicWrite } from "../storage/store.js";
import { budgetState, gateBudget, record, SESSION_TASK_ID } from "./budget.js";
import { active, done, guard, iso, type WorkflowContext } from "./context.js";
import { formatDuration, formatUsd } from "./format.js";
import { findingsTable, reviewItems, reviewMarkdown, reviewNotes, type ReviewItem, type ReviewTicketRow } from "./review-report.js";
import { costLabel, reviewLabel } from "./build.js";
import { summarizeCutFiles } from "./cut-summary.js";
import { adviseReview, changedFiles, changedLineCount, planMaxDifficulty } from "./review-advisors.js";
import { announce, decide } from "./routing.js";
import { splitCheckLine } from "./tickets.js";

export { reviewItems, reviewMarkdown, reviewNotes, type ReviewItem };

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
 * The review tier in the order the model pass tries it: the routed candidate, then the other usable candidates of the
 * same tier (not excluded by policy, circuit, budget, or availability), another provider first, then by score, and
 * last the standard tier.
 */
export function reviewCandidates(ctx: WorkflowContext, decision: RoutingDecision): TierCandidate[] {
  const primary = decision.candidate;
  if (!primary) return [];
  const key = (item: { provider: string; model: string }) => `${item.provider}/${item.model}`;
  const usable = new Map((decision.considered ?? []).filter((item) => !item.excludedReason).map((item) => [key(item), item.score]));
  const rest = tierCandidates(ctx.config, decision.tier)
    .map((candidate, order) => ({ candidate, order, score: usable.get(key(candidate)) }))
    .filter((row) => key(row.candidate) !== key(primary) && usable.has(key(row.candidate)));
  rest.sort((a, b) => {
    const otherA = a.candidate.provider === primary.provider ? 1 : 0;
    const otherB = b.candidate.provider === primary.provider ? 1 : 0;
    if (otherA !== otherB) return otherA - otherB;
    if ((a.score === undefined) !== (b.score === undefined)) return a.score === undefined ? 1 : -1;
    if (a.score !== undefined && b.score !== undefined && a.score !== b.score) return a.score - b.score;
    return a.order - b.order;
  });
  const ordered = [primary, ...rest.map((row) => row.candidate)];
  // A failed part stays within the review tier first; when none is left, standard-tier models take over.
  if (decision.tier !== "standard") {
    const standard = tierCandidates(ctx.config, "standard").filter((candidate) => !ordered.some((item) => key(item) === key(candidate)));
    // Another provider first: a failed part is usually a provider problem.
    ordered.push(...standard.filter((item) => item.provider !== primary.provider), ...standard.filter((item) => item.provider === primary.provider));
  }
  return ordered;
}

/**
 * The model pass: the review-tier model reads the diff and lists advisory findings. A failed part is retried once on
 * the next review candidate. Budget-gated before every call, each call ledgered under REVIEWING with reason "model
 * review" and counted against its own candidate, and never a reason for the review to pass or fail. Returns undefined
 * when the pass is off in config.
 */
async function modelPass(ctx: WorkflowContext, taskId: string, taskType: string, plan: PlanDocument, decision: RoutingDecision | undefined, diff: string, askQuestions = false): Promise<ModelReview | undefined> {
  if (!ctx.config.review.model) return undefined;
  const skip = (error: string): ModelReview => ({ provider: decision?.provider ?? "none", model: decision?.model ?? "none", findings: [], truncated: false, error });
  if (!ctx.chat) return skip("no model connection (only available inside a Pi session).");
  if (!decision?.candidate) return skip(decision?.blocked ?? "no review model is available.");
  const exhausted = () => (budgetState(ctx, taskId).status === "hard" ? "the task or daily budget is exhausted." : undefined);
  const stop = exhausted();
  if (stop) return skip(stop);
  const started = ctx.now().getTime();
  const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
  // Unknown cost stays unknown: one call with no price makes the pass's cost null, never zero.
  let micro: number | null = 0;
  let review: ModelReview;
  try {
    // Parts beyond review.maxChunks are not sent; the batch tier says in a line each what those files change.
    const skipped = unreviewedDiff(diff, ctx.config.review.maxDiffChars, ctx.config.review.maxChunks);
    const sections = skipped.split(/(?=^diff --git )/m).flatMap((text) => {
      const name = /^diff --git a\/.+? b\/(.+)$/m.exec(text.split("\n", 1)[0] ?? "")?.[1];
      return name ? [{ name, label: name, text }] : [];
    });
    const lines = sections.length > 0 ? await summarizeCutFiles(ctx, taskId, sections) : new Map<string, string>();
    review = await runModelReview(ctx.chat, reviewCandidates(ctx, decision), {
      notSent: lines.size > 0 ? sections.map((item) => `- ${item.name}${lines.has(item.name) ? `: ${lines.get(item.name)}` : ""}`).join("\n") : undefined,
      plan,
      diff,
      maxDiffChars: ctx.config.review.maxDiffChars,
      maxChunks: ctx.config.review.maxChunks,
      timeoutMs: ctx.config.review.timeoutMs,
      signal: ctx.shutdown.signal,
      onProgress: progress,
      onStage: (text) => ctx.indicator?.stage(text),
      askQuestions,
      stop: () => exhausted()?.replace(/\.$/, ""),
      onCall: async (call) => {
        // A failed call may or may not have been billed: its usage is unknown, never zero.
        const entry = record(ctx, taskId, "REVIEWING", decision.tier, call.candidate.provider, call.candidate.model, call.usage, call.outcome === "success" ? "success" : "failure", call.retry, "model review");
        micro = micro === null || entry.actualUsd === null ? null : micro + toMicroUsd(entry.actualUsd);
        // Only model-attributable outcomes count, and only against the candidate that made the call.
        if (call.outcome !== "stopped") await ctx.store.bumpMetric(reviewMetricType(taskType), decision.tier, call.outcome === "success", ctx.now(), call.candidate);
      },
    });
  } catch (error) {
    // Failed model calls do not throw; this is the bookkeeping around them. The pass is advisory, so /review goes on.
    return skip(`the model pass stopped: ${redact((error as Error).message || "unknown error")}`);
  }
  const costUsd = micro === null ? null : fromMicroUsd(micro);
  const elapsedMs = ctx.now().getTime() - started;
  progress(`model pass done: ${review.findings.length} finding(s) in ${formatDuration(elapsedMs)}, ${formatUsd(costUsd)}`);
  return { ...review, elapsedMs, costUsd };
}

/**
 * What the ledger entries of this review cost, by stage: the review model (its parts and the cut-file summaries) and
 * the advisors (their answers and the reviewer's resolve call). An unknown charge makes the stage unknown, never $0.
 * A stage with no entry is left out.
 */
function stageCosts(ctx: WorkflowContext, taskId: string, sinceMs: number): { model?: ReviewStage; advisors?: ReviewStage } {
  const sums: Record<"model" | "advisors", number | null | undefined> = { model: undefined, advisors: undefined };
  for (const entry of ctx.store.readLedger()) {
    if (entry.taskId !== taskId || new Date(entry.at).getTime() < sinceMs) continue;
    const stage = entry.reason === "model review" || entry.reason === "batch summary" ? "model" : entry.reason === "model review resolve" || entry.reason.startsWith("advisor") ? "advisors" : undefined;
    if (!stage) continue;
    const before = sums[stage];
    sums[stage] = before === null || entry.actualUsd === null ? null : (before ?? 0) + toMicroUsd(entry.actualUsd);
  }
  const stageOf = (micro: number | null | undefined) => (micro === undefined ? undefined : { costUsd: micro === null ? null : fromMicroUsd(micro) });
  return { model: stageOf(sums.model), advisors: stageOf(sums.advisors) };
}

/** The plan's tickets for the Tickets table; none without a plan. */
function ticketRows(state: TaskState | undefined): ReviewTicketRow[] {
  return (state?.plan?.tickets ?? []).map((ticket) => {
    const run = state?.ticketRuns?.[ticket.id];
    return {
      id: ticket.id,
      difficulty: ticketDifficulty(ticket),
      implementer: run?.provider && run.model ? `${run.provider}/${run.model}` : "—",
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

/** The message that sends findings to the model in the current session. */
function fixMessage(items: ReviewItem[], checks: { command: string; args: string[] }[], request?: string, notes: string[] = []): string {
  const commands = checks.map((check) => `- \`${[check.command, ...check.args].join(" ")}\``);
  return redact(
    [
      request ? `Fix this from the review: ${request}` : `Fix all ${items.length} finding(s) from the review.`,
      "",
      request ? "All findings, for reference (the numbers match the list):" : "Findings:",
      numbered(items),
      ...(request && notes.length ? ["", "Not numbered (rejected by the reviewer or unresolved; fix one only if the request refers to it):", ...notes.map((line) => `- ${line.replace(/^> /, "")}`)] : []),
      "",
      "Rules:",
      "- Fix them in this working tree and keep the changes scoped to what is listed.",
      ...(commands.length ? ["- Run these checks and make them pass:", ...commands] : ["- No checks are configured; run the project's own tests if it has any."]),
      "- Do not commit, push, or switch branches.",
      "- Finish with one line per finding addressed, and say which ones you left and why.",
      "",
      "Run /review again when done.",
    ].join("\n"),
  );
}

/**
 * `/review`: reviews whatever differs from the base branch (commits ahead of it, uncommitted and untracked edits) with
 * the checks, a static scan, and the advisory model pass. Nothing is committed or pushed. With a UI, the findings open
 * in a dialog that offers to send them to the model in this session. A task is optional.
 */
export function review(ctx: WorkflowContext): Promise<CommandResult> {
  // The progress line is always taken down, however the review ends.
  return guard(async () => {
    try {
      return await runReview(ctx);
    } finally {
      ctx.indicator?.stop();
    }
  });
}

async function runReview(ctx: WorkflowContext): Promise<CommandResult> {
  const found = active(ctx);
  const state = found && found.phase !== "COMPLETE" && found.phase !== "IDLE" ? found : undefined;
  const taskId = state?.taskId ?? SESSION_TASK_ID;
  const base = state?.build?.base ?? (await ctx.git.defaultBranch());
  const branch = await ctx.git.currentBranch();
  const ref = await baseRef(ctx, base, branch === base);
  const rawDiff = await ctx.git.workingDiff(ref);
  if (!rawDiff.trim()) return done(`Nothing to review: no changes against ${base}.`);
  const exhausted = gateBudget(ctx, taskId);
  if (exhausted) return exhausted;

  const plan = state?.plan;
  const classification: AcceptedClassification = state?.classification ?? classifyKeywords("ad-hoc changes");
  const decision = await decide(ctx, classification, "review", { taskId: state?.taskId });
  await announce(ctx, state?.taskId, "review", decision);
  const started = ctx.now().getTime();
  ctx.indicator?.start("Review");
  const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
  const checks = reviewChecks(ctx, plan);
  progress(`started · ${branch} against ${ref} · ${ctx.config.setup.length} setup step(s), ${checks.length} check(s) · model ${decision.candidate ? `${decision.provider}/${decision.model}` : "off"}`);
  const diff = redact(rawDiff);
  // Which advisors this branch gets, by its plan's ticket difficulty (or its size when there is no plan).
  const foundAdvisors = ctx.config.review.model && ctx.chat && decision.candidate ? await availableAdvisors(ctx, state?.taskId, classification.task_type) : undefined;
  const pick = foundAdvisors
    ? reviewAdvisorsFor({
        maxDifficulty: planMaxDifficulty(plan),
        changedLines: changedLineCount(changedFiles(diff)),
        adHocMinLines: ctx.config.advisors.adHocMinLines,
        reviewerProvider: decision.provider,
        candidates: foundAdvisors.candidates,
      })
    : undefined;
  let advisorsMs: number | undefined;
  const report = await reviewDiff({
    diff,
    checks,
    setup: ctx.config.setup,
    now: () => ctx.now().getTime(),
    onProgress: progress,
    onStage: (text) => ctx.indicator?.stage(text),
    cwd: ctx.git.repoRoot,
    runner: ctx.checkRunner,
    planAcceptance: plan?.acceptance ?? [],
  });
  const reviewPlan: PlanDocument = plan ?? { version: 0, createdAt: iso(ctx), summary: `Ad-hoc changes on ${branch}.`, risks: [], acceptance: [], estimatedUsd: null, groups: [], overlap: [], securitySensitive: false };
  const modelReview = await modelPass(ctx, taskId, classification.task_type, reviewPlan, decision, report.diff ?? diff, !!pick?.advisors.length);
  if (modelReview && pick) {
    const rule = { reason: pick.reason, planned: pick.advisors.map((item) => item.model) };
    const reviewed = modelReview.parts?.some((part) => part.reviewedBy);
    const advisorsStarted = ctx.now().getTime();
    const advice = pick.advisors.length === 0 ? {} : reviewed
      ? await adviseReview(ctx, { taskId, taskType: classification.task_type, decision, candidates: reviewCandidates(ctx, decision), review: modelReview, plan: reviewPlan, diff: report.diff ?? diff, advisors: pick.advisors, progress })
      : { advisorsSkipped: "the model pass produced no result" };
    const skippedNote = [(advice as { advisorsSkipped?: string }).advisorsSkipped, ...(foundAdvisors?.notes ?? [])].filter(Boolean).join("; ");
    report.modelReview = { ...modelReview, ...advice, ...(skippedNote ? { advisorsSkipped: skippedNote } : {}), advisorRule: rule };
    if (pick.advisors.length > 0) advisorsMs = ctx.now().getTime() - advisorsStarted;
  } else report.modelReview = modelReview;
  report.elapsedMs = ctx.now().getTime() - started;
  const costs = stageCosts(ctx, taskId, started);
  report.stages = {
    ...report.stages,
    ...(modelReview ? { model: { elapsedMs: modelReview.elapsedMs, ...costs.model } } : {}),
    ...(advisorsMs !== undefined ? { advisors: { elapsedMs: advisorsMs, ...costs.advisors } } : {}),
  };
  const setupConfigured = ctx.config.setup.length > 0;
  const saved = state ? `.pi-workflows/tasks/${state.taskId}/reports/review.md` : `.pi-workflows/reports/review-${stamp(ctx)}.md`;
  const markdown = reviewMarkdown(report, { setupConfigured, savedAs: saved, tickets: ticketRows(state) });
  ctx.report?.(markdown);
  // Done working: the dialog below waits for the person, so the line goes before it.
  ctx.indicator?.stop();
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
  const notes = reviewNotes(report);
  const header = advisorsHeader(report.modelReview);
  const result = (message: string): CommandResult =>
    report.passed ? { ok: true, text: message, data: report } : { ok: false, code: "REVIEW_BLOCKING", text: `${message}\nFix the problems, then /review again. Nothing was committed or pushed.`, data: report };
  if (items.length === 0 && report.passed) return result(`Review passed: ${report.checks.length} check(s), no findings.`);
  if (!ctx.review || items.length === 0) return result(text);

  const choice = await ctx.review({
    title: `Review · ${items.length} finding(s)`,
    markdown: [...(header ? [header, ""] : []), `## ${items.length} finding(s)`, "", ...findingsTable(report), ...(notes.length ? ["", "Rows numbered – are listed only; Fix all does not send them."] : [])].join("\n"),
    actions: [
      { value: "fix-all", label: "Fix all" },
      { value: "fix-some", label: "Fix…", input: "What should be fixed? (finding numbers like 1, 3, and/or your own instructions)" },
      { value: "close", label: "Close" },
    ],
  });
  const request = choice?.value === "fix-some" ? (choice.text ?? "").trim() : undefined;
  if (ctx.startTurn && (choice?.value === "fix-all" || (choice?.value === "fix-some" && request))) {
    ctx.startTurn(fixMessage(items, checks, request, notes));
    // The turn is the outcome here; the verdict is in the report and in state.review.
    return done(request ? `Sent your fix request to the model (${items.length} finding(s) listed for reference).` : `Sent ${items.length} finding(s) to the model to fix.`, report);
  }
  return result(text);
}
