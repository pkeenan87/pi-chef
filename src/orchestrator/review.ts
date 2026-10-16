import path from "node:path";
import { fromMicroUsd, tierCandidates, toMicroUsd } from "../config.js";
import { type AcceptedClassification, type CommandResult, type ModelReview, type PlanDocument, type ReviewReport, type RoutingDecision, type TierCandidate } from "../domain.js";
import { modelReviewLines, runModelReview } from "../review/model-review.js";
import { reviewDiff } from "../review/review.js";
import { fallbackClassification } from "../router/classify.js";
import { reviewMetricType } from "../router/stats.js";
import { redact } from "../redact.js";
import { atomicWrite } from "../storage/store.js";
import { budgetState, gateBudget, record, SESSION_TASK_ID } from "./budget.js";
import { active, done, guard, iso, type WorkflowContext } from "./context.js";
import { formatDuration, formatUsd } from "./format.js";
import { announce, decide } from "./routing.js";
import { splitCheckLine } from "./tickets.js";

/**
 * The checks a review runs: the configured ones, else every distinct check the plan's tickets carry (already
 * validated at plan time), so a project without `checks:` still gets tool evidence.
 */
export function reviewChecks(ctx: WorkflowContext, plan?: PlanDocument): { name: string; command: string; args: string[] }[] {
  if (ctx.config.checks.length > 0) return ctx.config.checks.map((check) => ({ name: check.name, command: check.command, args: check.args }));
  const lines = [...new Set((plan?.tickets ?? []).flatMap((ticket) => ticket.checks ?? []))];
  return lines.map((line) => ({ name: line, ...splitCheckLine(line) }));
}

/** A check that failed for want of installed tools. */
const MISSING_TOOLING = /command not found|Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|not recognized as an internal or external command/i;

/** Why a check that did not pass says it failed: the tail of its output. */
function checkTail(check: { stderr: string; stdout: string }): string {
  return (check.stderr.trim() || check.stdout.trim()).split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 400);
}

/** A hint when a check failed for want of a tool: nothing may be installed in this checkout. */
function setupHint(report: ReviewReport, setupConfigured: boolean): string | undefined {
  if (setupConfigured || !report.checks.some((check) => check.exitCode !== 0 && MISSING_TOOLING.test(`${check.stderr}\n${check.stdout}`))) return undefined;
  return "A check failed because a tool or package is missing. Install it in this checkout, or list the install command under `setup:` in .pi-workflows/config.yaml (for example npm ci) so /review runs it before the checks.";
}

/**
 * The structured review, as the chat block and as the saved report: verdict, then checks with durations and failure
 * tails, then static findings, then the model's findings, then what to do next.
 */
export function reviewMarkdown(report: ReviewReport, options: { setupConfigured: boolean; savedAs?: string } = { setupConfigured: true }): string {
  const checks = report.checks.map((check) => {
    const took = check.durationMs !== undefined ? ` (${formatDuration(check.durationMs)})` : "";
    if (!check.ran) return `- ✗ ${check.name}: did not run — ${check.stderr.split("\n")[0] ?? ""}`;
    if (check.exitCode === 0) return `- ✓ ${check.name}${check.stdout.startsWith("cached:") ? " (cached pass)" : took}`;
    return `- ✗ ${check.name}: exit ${check.exitCode}${took}\n  ${checkTail(check) || "(no output)"}`;
  });
  const blocking = report.findings.filter((finding) => finding.severity === "blocking" && finding.category !== "tests" && finding.category !== "checks");
  const suggestions = report.findings.filter((finding) => finding.severity === "suggestion");
  const hint = setupHint(report, options.setupConfigured);
  const next = report.passed
    ? "Nothing blocks. Commit and push when you are ready; /review never does."
    : hint ?? (report.checks.some((check) => check.ran && check.exitCode !== 0) ? "Fix the failing check(s) in chat, then /review again." : "Address the blocking findings in chat, then /review again.");
  return [
    `## Review ${report.passed ? "passed" : "did not pass"}${report.elapsedMs !== undefined ? ` · ${formatDuration(report.elapsedMs)}` : ""}`,
    report.summary,
    "",
    `### Checks (${report.checks.filter((check) => check.ran && check.exitCode === 0).length} of ${report.checks.length} passed)`,
    ...(checks.length ? checks : ["- none ran"]),
    "",
    `### Static findings (${blocking.length} blocking, ${suggestions.length} suggestion(s))`,
    ...(blocking.length ? blocking.map((finding) => `- BLOCKING ${finding.category}: ${finding.message} (${finding.evidence.split("\n")[0]?.slice(0, 160)})`) : []),
    ...(suggestions.length ? suggestions.map((finding) => `- suggestion ${finding.category}: ${finding.message}`) : []),
    ...(!blocking.length && !suggestions.length ? ["- none"] : []),
    "",
    "### Model review",
    ...(report.modelReview ? modelReviewLines(report.modelReview) : ["- did not run"]),
    "",
    `### Next`,
    `- ${next}`,
    ...(options.savedAs ? [`- Full report: ${options.savedAs}`] : []),
  ].join("\n");
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
    .filter((row) => row.candidate.api === "chat" && key(row.candidate) !== key(primary) && usable.has(key(row.candidate)));
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
    const standard = tierCandidates(ctx.config, "standard").filter((candidate) => candidate.api === "chat" && !ordered.some((item) => key(item) === key(candidate)));
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
async function modelPass(ctx: WorkflowContext, taskId: string, taskType: string, plan: PlanDocument, decision: RoutingDecision | undefined, diff: string): Promise<ModelReview | undefined> {
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
    review = await runModelReview(ctx.chat, reviewCandidates(ctx, decision), {
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

/** One numbered, fixable finding from the report. */
export interface ReviewItem {
  kind: "static" | "check" | "model";
  text: string;
}

/**
 * Everything the review found, in the order the person sees and numbers it: static findings (blocking first), failed
 * checks with the command, then the model's findings. A blocking `tests` finding is its failed check, so it is not listed twice.
 */
export function reviewItems(report: ReviewReport): ReviewItem[] {
  const items: ReviewItem[] = [];
  const rank = (finding: { severity: string }) => (finding.severity === "blocking" ? 0 : 1);
  const statics = report.findings.filter((finding) => !(finding.severity === "blocking" && (finding.category === "tests" || finding.category === "checks")));
  for (const finding of [...statics].sort((a, b) => rank(a) - rank(b))) {
    const evidence = finding.evidence.split("\n")[0]?.slice(0, 160);
    items.push({ kind: "static", text: `${finding.severity === "blocking" ? "BLOCKING" : "suggestion"} ${finding.category}: ${finding.message}${evidence ? ` (${evidence})` : ""}` });
  }
  for (const check of report.checks) {
    if ((check.ran && check.exitCode === 0) || check.stderr.startsWith("skipped:")) continue;
    const command = [check.command, ...check.args].join(" ");
    items.push({ kind: "check", text: `Check failed: ${check.name} (\`${command}\`)${check.ran ? ` exit ${check.exitCode}` : " did not run"}: ${checkTail(check) || "no output"}` });
  }
  for (const finding of report.modelReview?.findings ?? []) {
    const evidence = finding.evidence ? ` (evidence: ${finding.evidence.replace(/\s+/g, " ").slice(0, 200)})` : "";
    items.push({ kind: "model", text: `${finding.severity.toUpperCase()} ${finding.file ? `${finding.file}: ` : ""}${finding.message}${evidence}` });
  }
  return items;
}

const numbered = (items: ReviewItem[]) => items.map((item, index) => `${index + 1}. ${item.text}`).join("\n");

/** The message that sends findings to the model in the current session. */
function fixMessage(items: ReviewItem[], checks: { command: string; args: string[] }[], request?: string): string {
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
  return guard(async () => {
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
    const classification: AcceptedClassification = state?.classification ?? fallbackClassification("ad-hoc changes");
    const decision = await decide(ctx, classification, "review", { taskId: state?.taskId });
    await announce(ctx, state?.taskId, "review", decision);
    const started = ctx.now().getTime();
    const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
    const checks = reviewChecks(ctx, plan);
    progress(`started · ${branch} against ${ref} · ${ctx.config.setup.length} setup step(s), ${checks.length} check(s) · model ${decision.candidate ? `${decision.provider}/${decision.model}` : "off"}`);
    const diff = redact(rawDiff);
    const report = await reviewDiff({
      diff,
      checks,
      setup: ctx.config.setup,
      now: () => ctx.now().getTime(),
      onProgress: progress,
      cwd: ctx.git.repoRoot,
      runner: ctx.checkRunner,
      planAcceptance: plan?.acceptance ?? [],
    });
    const reviewPlan: PlanDocument = plan ?? { version: 0, createdAt: iso(ctx), summary: `Ad-hoc changes on ${branch}.`, risks: [], acceptance: [], estimatedUsd: null, groups: [], overlap: [], securitySensitive: false };
    report.modelReview = await modelPass(ctx, taskId, classification.task_type, reviewPlan, decision, report.diff ?? diff);
    report.elapsedMs = ctx.now().getTime() - started;
    const setupConfigured = ctx.config.setup.length > 0;
    const saved = state ? `.pi-workflows/tasks/${state.taskId}/reports/review.md` : `.pi-workflows/reports/review-${stamp(ctx)}.md`;
    const markdown = reviewMarkdown(report, { setupConfigured, savedAs: saved });
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

    const choice = await ctx.review({
      title: `Review · ${items.length} finding(s)`,
      markdown: `## ${items.length} finding(s)\n\n${numbered(items)}`,
      actions: [
        { value: "fix-all", label: "Fix all" },
        { value: "fix-some", label: "Fix…", input: "What should be fixed? (finding numbers like 1, 3, and/or your own instructions)" },
        { value: "close", label: "Close" },
      ],
    });
    const request = choice?.value === "fix-some" ? (choice.text ?? "").trim() : undefined;
    if (ctx.startTurn && (choice?.value === "fix-all" || (choice?.value === "fix-some" && request))) {
      ctx.startTurn(fixMessage(items, checks, request));
      // The turn is the outcome here; the verdict is in the report and in state.review.
      return done(request ? `Sent your fix request to the model (${items.length} finding(s) listed for reference).` : `Sent ${items.length} finding(s) to the model to fix.`, report);
    }
    return result(text);
  });
}
