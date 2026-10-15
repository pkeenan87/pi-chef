import path from "node:path";
import { emptyUsage, WorkflowError, type AcceptedClassification, type CommandResult, type ModelReview, type PlanDocument, type ReviewReport, type RoutingDecision } from "../domain.js";
import { modelReviewLines, runModelReview } from "../review/model-review.js";
import { reviewDiff } from "../review/review.js";
import { fallbackClassification } from "../router/classify.js";
import { redact } from "../redact.js";
import { atomicWrite } from "../storage/store.js";
import { budgetState, gateBudget, record, SESSION_TASK_ID } from "./budget.js";
import { active, done, fail, guard, iso, type WorkflowContext } from "./context.js";
import { formatDuration, formatUsd } from "./format.js";
import { canTransition, move } from "./machine.js";
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
  return "A check failed because a tool or package is missing. Install it in this checkout, or list the install command under `setup:` in .pi-workflows/config.yaml (for example npm ci) so /ship runs it before the checks.";
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
    ? "Confirm to push the branch and open or update the pull request (publish approval stays required)."
    : hint ?? (report.checks.some((check) => check.ran && check.exitCode !== 0) ? "Fix the failing check(s) in chat, then /ship again." : "Address the blocking findings in chat, then /ship again.");
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
 * The model pass: the review-tier model reads the diff and lists advisory findings. Budget-gated, ledgered under
 * REVIEWING with reason "model review", and never a reason for the review to pass or fail. Returns undefined when the
 * pass is off in config.
 */
async function modelPass(ctx: WorkflowContext, taskId: string, taskType: string, plan: PlanDocument, decision: RoutingDecision | undefined, diff: string): Promise<ModelReview | undefined> {
  if (!ctx.config.review.model) return undefined;
  const skip = (error: string): ModelReview => ({ provider: decision?.provider ?? "none", model: decision?.model ?? "none", findings: [], truncated: false, error });
  if (!ctx.chat) return skip("no model connection (only available inside a Pi session).");
  const candidate = decision?.candidate;
  if (!candidate) return skip(decision?.blocked ?? "no review model is available.");
  if (budgetState(ctx, taskId).status === "hard") return skip("the task or daily budget is exhausted.");
  const started = ctx.now().getTime();
  const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
  try {
    const { review, usage } = await runModelReview(ctx.chat, candidate, {
      plan,
      diff,
      maxDiffChars: ctx.config.review.maxDiffChars,
      maxChunks: ctx.config.review.maxChunks,
      timeoutMs: ctx.config.review.timeoutMs,
      signal: ctx.shutdown.signal,
      onProgress: progress,
    });
    const entry = record(ctx, taskId, "REVIEWING", decision.tier, candidate.provider, candidate.model, usage, review.error ? "failure" : "success", 0, "model review");
    await ctx.store.bumpMetric(taskType, decision.tier, !review.error, ctx.now(), candidate);
    const elapsedMs = ctx.now().getTime() - started;
    progress(`model pass done: ${review.findings.length} finding(s) in ${formatDuration(elapsedMs)}, ${formatUsd(entry.actualUsd)}`);
    return { ...review, elapsedMs, costUsd: entry.actualUsd };
  } catch (error) {
    // The call may or may not have been billed: unknown usage, never zero.
    record(ctx, taskId, "REVIEWING", decision.tier, candidate.provider, candidate.model, emptyUsage(), "failure", 0, "model review");
    await ctx.store.bumpMetric(taskType, decision.tier, false, ctx.now(), candidate);
    return skip(`the call failed: ${redact((error as Error).message || (error instanceof WorkflowError ? error.code : "unknown error"))}`);
  }
}

/** Working-tree changes outside the workspace dir (`.pi-workflows/` state is not the user's code). */
async function dirtyPaths(ctx: WorkflowContext): Promise<string[]> {
  const workspace = ctx.config.workspaceDir.replace(/^\.\//, "").replace(/\/$/, "");
  return (await ctx.git.changedPaths()).filter((file) => file !== workspace && !file.startsWith(`${workspace}/`));
}

/** "20261014-120000" from the injected clock. */
function stamp(ctx: WorkflowContext): string {
  return ctx.now().toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
}

/** The ref to diff against: the local base branch, else its remote-tracking copy. */
async function baseRef(ctx: WorkflowContext, base: string): Promise<string> {
  if ((await ctx.git.git(["rev-parse", "--verify", "--quiet", `refs/heads/${base}`])).code === 0) return base;
  if ((await ctx.git.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])).code === 0) return `origin/${base}`;
  return base;
}

/** Commits the branch has beyond what the remote base already has (0 when there is no remote base). */
async function aheadOfRemote(ctx: WorkflowContext, base: string): Promise<number> {
  if ((await ctx.git.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])).code !== 0) return 0;
  return ctx.git.aheadOf(`origin/${base}`);
}

function pullRequestBody(ctx: WorkflowContext, report: ReviewReport, plan: PlanDocument | undefined, runs: Record<string, { status: string }> | undefined): string {
  const lines: string[] = [];
  if (plan) {
    lines.push("## Summary", plan.summary, "");
    if (plan.tickets?.length) {
      lines.push("## Tickets", ...plan.tickets.map((ticket) => `- ${ticket.id} ${ticket.title}: ${runs?.[ticket.id]?.status ?? "not built"}`), "");
    }
  }
  lines.push(
    "## Checks",
    ...(report.checks.length ? report.checks.map((check) => `- ${check.name} (${[check.command, ...check.args].join(" ")}): ${check.ran && check.exitCode === 0 ? "pass" : "fail"}`) : ["- none"]),
    "",
    `Static findings: ${report.findings.length}`,
    `Model review findings: ${report.modelReview ? report.modelReview.findings.length : "not run"} (advisory)`,
    "",
    "Not merged; merge stays manual.",
  );
  return redact(lines.join("\n"));
}

/**
 * `/ship`: reviews whatever is on the current branch (built commits, ad-hoc commits, uncommitted edits) and, on a pass
 * and after confirmation, commits leftovers, pushes, and opens or updates the pull request. A task is optional.
 */
export function ship(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    const found = active(ctx);
    let state = found && found.phase !== "COMPLETE" && found.phase !== "IDLE" ? found : undefined;
    const taskId = state?.taskId ?? SESSION_TASK_ID;
    const base = state?.build?.base ?? (await ctx.git.defaultBranch());
    let branch = await ctx.git.currentBranch();
    if (branch === "HEAD") return fail("GIT_NOT_READY", "HEAD is detached. Switch to a branch (git switch -c <name>), then run /ship again.");
    if (branch === base) {
      const ahead = await aheadOfRemote(ctx, base);
      const dirty = (await dirtyPaths(ctx)).length > 0;
      if (ahead > 0) {
        return fail(
          "ON_BASE_BRANCH",
          `You are on ${base} with ${ahead} local commit(s) it does not have on origin. Move them to a branch: \`git switch -c <name>\`, then reset ${base} to origin (\`git branch -f ${base} origin/${base}\`), then run /ship again.`,
        );
      }
      if (!dirty) return fail("NOTHING_TO_SHIP", `Nothing to ship: you are on ${base} with no changes.`);
      branch = `${ctx.config.branchPrefix}/${state?.taskId ?? `ship-${stamp(ctx)}`}`;
      await ctx.git.switchCreate(branch);
      ctx.progress?.(`Ship: created branch ${branch} for the uncommitted changes`);
    }
    const ref = await baseRef(ctx, base);
    const rawDiff = await ctx.git.workingDiff(ref);
    if (!rawDiff.trim()) return fail("NOTHING_TO_SHIP", `Nothing to ship: ${branch} has no changes against ${base}.`);
    const exhausted = gateBudget(ctx, taskId);
    if (exhausted) return exhausted;

    const plan = state?.plan;
    const classification: AcceptedClassification = state?.classification ?? fallbackClassification("ad-hoc changes");
    const decision = await decide(ctx, classification, "review", { taskId: state?.taskId });
    await announce(ctx, state?.taskId, "review", decision);
    const started = ctx.now().getTime();
    const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
    const checks = reviewChecks(ctx, plan);
    progress(`started · ${branch} against ${base} · ${ctx.config.setup.length} setup step(s), ${checks.length} check(s) · model ${decision.candidate ? `${decision.provider}/${decision.model}` : "off"}`);
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
    const reviewPlan: PlanDocument = plan ?? { version: 0, createdAt: iso(ctx), summary: `Ad-hoc changes on branch ${branch}.`, risks: [], acceptance: [], estimatedUsd: null, groups: [], overlap: [], securitySensitive: false };
    report.modelReview = await modelPass(ctx, taskId, classification.task_type, reviewPlan, decision, report.diff ?? diff);
    report.elapsedMs = ctx.now().getTime() - started;
    const setupConfigured = ctx.config.setup.length > 0;
    const saved = state ? `.pi-workflows/tasks/${state.taskId}/reports/ship.md` : `.pi-workflows/reports/ship-${stamp(ctx)}.md`;
    const markdown = reviewMarkdown(report, { setupConfigured, savedAs: saved });
    ctx.report?.(markdown);
    // Saved on every exit, after any commit below, so a report file cannot land in the shipped commit.
    const persist = async () => {
      if (state) {
        ctx.store.writeText(state.taskId, "reports/ship.json", JSON.stringify(report, null, 2));
        ctx.store.writeText(state.taskId, "reports/ship.md", markdown);
        await ctx.store.update(state.taskId, "ship review", (task) => ({ ...task, review: report, updatedAt: iso(ctx) }));
      } else {
        const name = path.join(ctx.store.root, "reports", `ship-${stamp(ctx)}`);
        atomicWrite(`${name}.json`, JSON.stringify(report, null, 2));
        atomicWrite(`${name}.md`, markdown);
      }
    };
    try {
      // The chat block above holds the detail; the command result stays short.
      const text = ctx.report ? `${report.summary} (${formatDuration(report.elapsedMs)}; details above)` : markdown;
      if (!report.passed) {
        return { ok: false, code: "REVIEW_BLOCKING", text: `${text}\nFix in chat, then /ship again. Nothing was committed or pushed.`, data: report };
      }
      if (!ctx.github) return fail("GITHUB", "No GitHub client is configured.");
      // Config layering stops a project file from setting publish to "auto"; only user-level config can.
      if (ctx.config.approvals.publish === "required") {
        const allowed = await ctx.confirm("Ship", `Push ${branch} and open or update the pull request against ${base}?`);
        if (!allowed) return fail("NOT_SHIPPED", "Not shipped: the push was not approved. Nothing was committed or pushed.");
      }
      const summaryLine = plan?.summary.split("\n")[0]?.trim();
      if ((await dirtyPaths(ctx)).length > 0) {
        await ctx.git.commitAll(ctx.git.repoRoot, redact(`Ship: ${summaryLine ? summaryLine.slice(0, 60) : "changes"}`));
      }
      let title = summaryLine?.slice(0, 72);
      if (!title) {
        const log = await ctx.git.git(["log", "--format=%s", `${ref}..HEAD`, "--"]);
        title = log.stdout.trim().split("\n").filter(Boolean).pop()?.slice(0, 72) || `Changes on ${branch}`;
      }
      await ctx.pushBranch(branch);
      const snapshot = await ctx.github.upsert({ branch, base, title: redact(title), body: pullRequestBody(ctx, report, plan, state?.ticketRuns) });
      if (state) {
        const at = iso(ctx);
        state = await ctx.store.update(state.taskId, "published", (task) => {
          const next = {
            ...task,
            publishApproved: true,
            pullRequest: { number: snapshot.number, url: snapshot.url, branch: snapshot.branch, base: snapshot.base, headSha: snapshot.headSha, baseSha: snapshot.baseSha },
          };
          // A task in a phase with no way to PUBLISHED (failed, blocked) still records the PR.
          return canTransition(next.phase, "PUBLISHED", next) ? move(next, "PUBLISHED", at) : next;
        });
      }
      return done(`Shipped ${branch} as PR #${snapshot.number} (${snapshot.url}). Not merged; merge stays manual.`, snapshot);
    } finally {
      await persist();
    }
  });
}
