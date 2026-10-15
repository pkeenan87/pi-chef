import { realpathSync } from "node:fs";
import path from "node:path";
import type { CommandResult, TaskState } from "../domain.js";
import { active, done, fail, guard, iso, type WorkflowContext } from "./context.js";

/** Canonical form of a path for comparison (git prints worktree paths with symlinks resolved). */
function real(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** Worktrees under this task's directory that the state does not record (left by an earlier plan version or a crash). */
function orphans(ctx: WorkflowContext, state: TaskState, live: { path: string; branch: string }[]): { path: string; branch: string }[] {
  const root = real(path.join(ctx.store.root, "worktrees", state.taskId)) + path.sep;
  // The integration worktree is tool-owned and rebuilt by the next run, so it is never an orphan even between plan versions.
  const known = new Set([...state.worktrees.map((item) => real(item.path)), real(path.join(ctx.store.root, "worktrees", state.taskId, "integration")), ...(state.integration?.path ? [real(state.integration.path)] : [])]);
  return live.filter((entry) => real(entry.path).startsWith(root) && !known.has(real(entry.path)));
}

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
        return `${item.groupId} ${item.branch} base ${item.baseSha.slice(0, 7)} head ${item.headSha.slice(0, 7)} ${found ? "present" : "missing"}${item.abandoned ? " abandoned" : ""}`;
      });
      const stray = state ? orphans(ctx, state, live) : [];
      lines.push(...stray.map((entry) => `orphan ${path.basename(entry.path)} ${entry.branch || "(detached)"} (not in state; /worktrees cleanup removes it)`));
      return done(lines.join("\n") || "No recorded worktrees.", { recorded, live, orphans: stray });
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
    // Worktrees no plan version owns any more: nothing to confirm. Listed afresh, after the recorded ones were removed.
    for (const entry of orphans(ctx, state, await ctx.git.listWorktrees())) {
      const result = await ctx.git.removeWorktree(entry.path, entry.branch || undefined);
      if (result.ok) removed.push(`orphan ${path.basename(entry.path)}`);
      else failures.push(`orphan ${path.basename(entry.path)}: ${result.error ?? "removal failed"}`);
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
