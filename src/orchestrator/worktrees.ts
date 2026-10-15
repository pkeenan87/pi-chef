import type { CommandResult } from "../domain.js";
import { active, done, fail, guard, iso, type WorkflowContext } from "./context.js";

/** /worktrees status|list|cleanup. Cleanup asks before deleting unmerged work and refuses while a PR is active. */
export function worktrees(ctx: WorkflowContext, arg = "", confirmed = false): Promise<CommandResult> {
  return guard(async () => {
    const command = arg.trim() || "status";
    const state = active(ctx);
    const live = await ctx.git.listWorktrees();
    if (command === "status" || command === "list") {
      const recorded = state?.worktrees ?? [];
      const lines = recorded.map((item) => {
        const found = live.find((entry) => entry.path === item.path);
        return `${item.groupId} ${item.branch} base ${item.baseSha.slice(0, 7)} head ${item.headSha.slice(0, 7)} ${found ? "present" : "missing"}`;
      });
      return done(lines.join("\n") || "No recorded worktrees.", { recorded, live });
    }
    if (command !== "cleanup") return fail("USAGE", "Use /worktrees status, list, or cleanup.");
    if (!state) return fail("NO_TASK", "No task to clean up.");
    const prActive = !!state.pullRequest && ["PUBLISHED", "AUTOPILOT", "MERGE_READY", "AWAITING_PUBLISH_APPROVAL"].includes(state.phase);
    if (prActive) return fail("PR_ACTIVE", "Cleanup is blocked while the pull request is active.");
    const removed: string[] = [];
    const skipped: string[] = [];
    const failures: string[] = [];
    const integrationBranch = state.integration?.branch;
    const merged = await Promise.all(state.worktrees.map((item) => (integrationBranch ? ctx.git.isMerged(item.branch, integrationBranch) : Promise.resolve(false))));
    for (const [index, item] of state.worktrees.entries()) {
      const safe = merged[index] || item.abandoned || state.phase === "COMPLETE";
      if (!safe && !confirmed) {
        skipped.push(item.groupId);
        continue;
      }
      if (!safe && confirmed && ctx.config.worktrees.cleanupRequiresConfirmation) {
        const allowed = await ctx.confirm("Delete unmerged worktree", `Delete ${item.branch}?`);
        if (!allowed) {
          skipped.push(item.groupId);
          continue;
        }
      }
      const result = await ctx.git.removeWorktree(item.path, item.branch);
      if (result.ok) removed.push(item.groupId);
      else failures.push(`${item.groupId}: ${result.error ?? "removal failed"}`);
    }
    if (state.integration?.path && (state.phase === "COMPLETE" || confirmed)) {
      const result = await ctx.git.removeWorktree(state.integration.path, state.integration.branch);
      if (result.ok) removed.push("integration");
      else failures.push(`integration: ${result.error ?? "removal failed"}`);
    }
    // Only worktrees git actually removed leave the recorded state.
    await ctx.store.update(state.taskId, "worktree cleanup", (task) => ({
      ...task,
      worktrees: task.worktrees.filter((item) => !removed.includes(item.groupId)),
      updatedAt: iso(ctx),
    }));
    const text = `Removed ${removed.join(", ") || "nothing"}. Skipped ${skipped.join(", ") || "nothing"}.`;
    if (failures.length > 0) return fail("CLEANUP_FAILED", `${text} Failed (kept in state): ${failures.join("; ")}`);
    return done(text);
  });
}
