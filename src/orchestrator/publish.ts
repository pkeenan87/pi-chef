import { emptyUsage, WorkflowError, type CommandResult, type ModelReview, type PlanDocument, type ReviewReport, type RoutingDecision, type TaskState } from "../domain.js";
import { modelReviewLines, runModelReview } from "../review/model-review.js";
import { reviewDiff } from "../review/review.js";
import { redact } from "../redact.js";
import { budgetState, gateBudget, record } from "./budget.js";
import { done, fail, guard, handoff, iso, PUBLISHED_PHASES, requireActive, transition, type WorkflowContext } from "./context.js";
import { move } from "./machine.js";
import { announce, decide } from "./routing.js";
import { splitCheckLine } from "./tickets.js";

/**
 * The checks a review runs on the integration branch: the configured ones, else every distinct check the plan's tickets
 * carry (already validated against the allowlist at plan time), so a project without `checks:` still gets tool evidence.
 */
export function reviewChecks(ctx: WorkflowContext, plan: PlanDocument): { name: string; command: string; args: string[] }[] {
  if (ctx.config.checks.length > 0) return ctx.config.checks.map((check) => ({ name: check.name, command: check.command, args: check.args }));
  const lines = [...new Set((plan.tickets ?? []).flatMap((ticket) => ticket.checks ?? []))];
  return lines.map((line) => ({ name: line, ...splitCheckLine(line) }));
}

/** A check that failed for want of installed tools: the integration worktree is a fresh checkout. */
const MISSING_TOOLING = /command not found|Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|not recognized as an internal or external command/i;

/** The summary, the model findings, and the suggestions, so a review that did not pass says what to do. */
function reviewText(report: ReviewReport, setupConfigured: boolean): string {
  const lines = [report.summary];
  if (!setupConfigured && report.checks.some((check) => check.exitCode !== 0 && MISSING_TOOLING.test(`${check.stderr}\n${check.stdout}`))) {
    lines.push("A check failed because a tool or package is missing: the integration worktree is a fresh checkout with nothing installed. List the install command under `setup:` in .pi-workflows/config.yaml (for example npm ci) and allowlist it.");
  }
  if (report.modelReview) lines.push(...modelReviewLines(report.modelReview));
  const suggestions = report.findings.filter((finding) => finding.severity === "suggestion").slice(0, 5);
  if (suggestions.length) lines.push("Suggestions:", ...suggestions.map((finding) => `- ${finding.message}`));
  return lines.join("\n");
}

/** The review as a markdown file next to review.json, for reading outside the chat. */
function reviewMarkdown(report: ReviewReport): string {
  const checks = report.checks.map((check) => `- ${check.name}: ${check.ran ? `exit ${check.exitCode}` : "did not run"}`);
  const findings = report.findings.map((finding) => `- **${finding.severity}** ${finding.category}: ${finding.message}`);
  const model = report.modelReview ? modelReviewLines(report.modelReview) : ["Model review did not run."];
  return ["# Review", "", report.summary, "", "## Checks", ...(checks.length ? checks : ["(none)"]), "", "## Findings", ...(findings.length ? findings : ["(none)"]), "", "## Model review", ...model, ""].join("\n");
}

/**
 * The model pass: the review-tier model reads the integrated diff and lists advisory findings. Budget-gated, ledgered
 * under REVIEWING with reason "model review", and never a reason for the review to pass or fail. Returns undefined
 * when the pass is off in config.
 */
async function modelPass(ctx: WorkflowContext, state: TaskState, plan: PlanDocument, decision: RoutingDecision | undefined, diff: string): Promise<ModelReview | undefined> {
  if (!ctx.config.review.model) return undefined;
  const skip = (error: string): ModelReview => ({ provider: decision?.provider ?? "none", model: decision?.model ?? "none", findings: [], truncated: false, error });
  if (!ctx.chat) return skip("no model connection (only available inside a Pi session).");
  const candidate = decision?.candidate;
  if (!candidate) return skip(decision?.blocked ?? "no review model is available.");
  if (budgetState(ctx, state.taskId).status === "hard") return skip("the task or daily budget is exhausted.");
  const taskType = state.classification?.task_type ?? "general";
  try {
    const { review, usage } = await runModelReview(ctx.chat, candidate, { plan, diff, maxDiffChars: ctx.config.review.maxDiffChars, signal: ctx.shutdown.signal });
    record(ctx, state.taskId, "REVIEWING", decision.tier, candidate.provider, candidate.model, usage, review.error ? "failure" : "success", 0, "model review");
    await ctx.store.bumpMetric(taskType, decision.tier, !review.error, ctx.now(), candidate);
    return review;
  } catch (error) {
    // The call may or may not have been billed: unknown usage, never zero.
    record(ctx, state.taskId, "REVIEWING", decision.tier, candidate.provider, candidate.model, emptyUsage(), "failure", 0, "model review");
    await ctx.store.bumpMetric(taskType, decision.tier, false, ctx.now(), candidate);
    return skip(`the call failed: ${redact((error as Error).message || (error instanceof WorkflowError ? error.code : "unknown error"))}`);
  }
}

/** Completes a task and stops its autopilot watcher. */
export async function finish(ctx: WorkflowContext, state: TaskState, reason: string): Promise<TaskState> {
  ctx.poller.stop();
  return ctx.store.update(state.taskId, reason, (task) =>
    move({ ...task, ...(task.autopilot ? { autopilot: { ...task.autopilot, running: false } } : {}) }, "COMPLETE", iso(ctx)),
  );
}

export function review(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    let state = requireActive(ctx);
    if (!state.plan || !state.integration?.sha) return fail("NOT_READY", "Review needs an implementation and an integration SHA.");
    const exhausted = gateBudget(ctx, state.taskId);
    if (exhausted) return exhausted;
    const plan = state.plan;
    const integration = state.integration;
    const decision = state.classification ? await decide(ctx, state.classification, "review", { taskId: state.taskId }) : undefined;
    if (decision) await announce(ctx, state.taskId, "review", decision);
    if (state.phase !== "REVIEWING") state = await transition(ctx, state.taskId, "start review", "REVIEWING");
    const [diffs, integrated] = await Promise.all([
      Promise.all(state.worktrees.map(async (worktree) => ({ groupId: worktree.groupId, diff: await ctx.git.diff(worktree.path, worktree.baseSha) }))),
      integration.path ? ctx.git.diff(integration.path, state.worktrees[0]?.baseSha ?? integration.sha) : Promise.resolve(""),
    ]);
    // Setup commands (an install) run first, in the integration worktree, as checks: a failed install is a failed review.
    const report = await reviewDiff({
      diffs,
      integratedDiff: integrated,
      checks: reviewChecks(ctx, plan),
      setup: ctx.config.setup,
      cwd: integration.path ?? ctx.git.repoRoot,
      runner: ctx.checkRunner,
      allowlist: ctx.config.commandAllowlist,
      planAcceptance: plan.acceptance,
    });
    report.modelReview = await modelPass(ctx, state, plan, decision, report.integratedDiff);
    ctx.store.writeText(state.taskId, "reports/review.json", JSON.stringify(report, null, 2));
    ctx.store.writeText(state.taskId, "reports/review.md", reviewMarkdown(report));
    const text = reviewText(report, ctx.config.setup.length > 0);
    const at = iso(ctx);
    if (report.passed) {
      await ctx.store.update(state.taskId, "review passed", (task) => move({ ...task, review: report }, "AWAITING_PUBLISH_APPROVAL", at));
      return done(text, report);
    }
    await ctx.store.update(state.taskId, "review blocking", (task) => move({ ...task, review: report }, "IMPLEMENTING", at, "blocking review findings"));
    return { ok: false, code: "REVIEW_BLOCKING", text, data: report };
  });
}

export function push(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    const state = requireActive(ctx);
    if (state.phase !== "AWAITING_PUBLISH_APPROVAL") return fail("APPROVAL_REQUIRED", "Publish waits until review is clean.");
    if (!state.review?.passed || !state.review.claimedPass) return fail("NO_EVIDENCE", "Publish refused: review did not pass on tool evidence.");
    const exhausted = gateBudget(ctx, state.taskId);
    if (exhausted) return exhausted;
    // Config layering stops a project file from setting publish to "auto"; only user-level config can.
    if (ctx.config.approvals.publish === "required") {
      const allowed = await ctx.confirm("Publish", "Push the integration branch and open or update the pull request?");
      if (!allowed) return fail("APPROVAL_REQUIRED", "Publish was not approved.");
    }
    if (!ctx.github) return fail("GITHUB", "No GitHub client is configured.");
    const branch = state.integration?.branch;
    if (!branch || !state.integration?.sha) return fail("GIT", "Integration branch is missing.");
    await ctx.pushBranch(branch);
    const snapshot = await ctx.github.upsert({
      branch,
      base: "main",
      title: state.plan?.summary.slice(0, 72) || state.taskId,
      body: redact(state.plan?.summary ?? ""),
    });
    const at = iso(ctx);
    // The PR exists now: record it and move to PUBLISHED before anything else can fail, so a retry
    // cannot be mistaken for an unpublished task.
    await ctx.store.update(state.taskId, "published", (task) =>
      move(
        {
          ...task,
          publishApproved: true,
          pullRequest: { number: snapshot.number, url: snapshot.url, branch: snapshot.branch, base: snapshot.base, headSha: snapshot.headSha, baseSha: snapshot.baseSha },
        },
        "PUBLISHED",
        at,
      ),
    );
    let contextNote = "";
    try {
      const note = await handoff(ctx, state, "post-publish", [
        "# Handoff after publish",
        "",
        `PR #${snapshot.number} ${snapshot.url}`,
        `Branch: ${snapshot.branch}`,
        `Head: ${snapshot.headSha}`,
        `Checks: ${snapshot.checks.map((check) => `${check.name}=${check.conclusion ?? check.status}`).join(", ") || "none yet"}`,
        `Findings: ${state.review.findings.length}`,
      ].join("\n"));
      await ctx.store.update(state.taskId, "publish handoff", (task) => ({ ...task, contextResets: [...task.contextResets, note], updatedAt: iso(ctx) }));
      contextNote = ` Context reset: ${note.mode}.`;
    } catch (error) {
      const warning = `The pull request was created, but the post-publish handoff failed: ${redact((error as Error).message || "unknown error")}`;
      ctx.notify(warning);
      contextNote = ` Warning: ${warning}`;
    }
    return done(`Published PR #${snapshot.number}.${contextNote} Not merged.`, snapshot);
  });
}

/** Marks a published task complete (after the PR is merged) so a new task can start. */
export function complete(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    const state = requireActive(ctx);
    if (!PUBLISHED_PHASES.includes(state.phase)) {
      return fail("ILLEGAL_TRANSITION", `Only a published task can be completed. This task is ${state.phase}.`);
    }
    let note = "";
    if (state.pullRequest && ctx.github?.wasMerged) {
      try {
        if (!(await ctx.github.wasMerged(state.pullRequest.branch))) note = " Note: GitHub does not show this pull request as merged.";
      } catch {
        note = " Note: could not confirm the merge with GitHub.";
      }
    }
    await finish(ctx, state, "completed by command");
    return done(`Task ${state.taskId} is complete. A new /plan starts a new task.${note}`);
  });
}
