import { type CommandResult, type TaskState } from "../domain.js";
import { done, fail, guard, iso, PUBLISHED_PHASES, requireActive, type WorkflowContext } from "./context.js";
import { move } from "./machine.js";

/** Completes a task and stops its autopilot watcher. */
export async function finish(ctx: WorkflowContext, state: TaskState, reason: string): Promise<TaskState> {
  ctx.poller.stop();
  return ctx.store.update(state.taskId, reason, (task) =>
    move({ ...task, ...(task.autopilot ? { autopilot: { ...task.autopilot, running: false } } : {}) }, "COMPLETE", iso(ctx)),
  );
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
