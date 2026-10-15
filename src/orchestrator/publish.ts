import type { CommandResult, PlanDocument, ReviewReport, TaskState } from "../domain.js";
import { reviewDiff } from "../review/review.js";
import { redact } from "../redact.js";
import { gateBudget } from "./budget.js";
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

/** The summary plus the suggestions, so a review that did not pass says what to do. */
function reviewText(report: ReviewReport): string {
  const suggestions = report.findings.filter((finding) => finding.severity === "suggestion").slice(0, 5);
  return suggestions.length ? `${report.summary}\nSuggestions:\n${suggestions.map((finding) => `- ${finding.message}`).join("\n")}` : report.summary;
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
    if (state.classification) await announce(ctx, state.taskId, "review", await decide(ctx, state.classification, "review", { taskId: state.taskId }));
    if (state.phase !== "REVIEWING") state = await transition(ctx, state.taskId, "start review", "REVIEWING");
    const [diffs, integrated] = await Promise.all([
      Promise.all(state.worktrees.map(async (worktree) => ({ groupId: worktree.groupId, diff: await ctx.git.diff(worktree.path, worktree.baseSha) }))),
      integration.path ? ctx.git.diff(integration.path, state.worktrees[0]?.baseSha ?? integration.sha) : Promise.resolve(""),
    ]);
    const report = await reviewDiff({
      diffs,
      integratedDiff: integrated,
      checks: reviewChecks(ctx, plan),
      cwd: integration.path ?? ctx.git.repoRoot,
      runner: ctx.checkRunner,
      allowlist: ctx.config.commandAllowlist,
      planAcceptance: plan.acceptance,
    });
    ctx.store.writeText(state.taskId, "reports/review.json", JSON.stringify(report, null, 2));
    const at = iso(ctx);
    if (report.passed) {
      await ctx.store.update(state.taskId, "review passed", (task) => move({ ...task, review: report }, "AWAITING_PUBLISH_APPROVAL", at));
      return done(reviewText(report), report);
    }
    await ctx.store.update(state.taskId, "review blocking", (task) => move({ ...task, review: report }, "IMPLEMENTING", at, "blocking review findings"));
    return { ok: false, code: "REVIEW_BLOCKING", text: reviewText(report), data: report };
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
