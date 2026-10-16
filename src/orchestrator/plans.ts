import type { CommandResult, TaskState } from "../domain.js";
import { dirtyPaths } from "./build.js";
import { done, fail, guard, type WorkflowContext } from "./context.js";
import { cell, mdTable } from "./format.js";
import { showTaskPlan } from "./planning.js";
import { clock, taskState } from "./state-label.js";
import { activeTask, closeTask, displayName, findTask, isClosed, listTasks, unfinishedTasks } from "./tasks.js";

/** `/plans`: list tasks. `/plans <name>`: switch to one. `/plans close <name>`: close one. */
export function plans(ctx: WorkflowContext, arg = ""): Promise<CommandResult> {
  return guard(async () => {
    const words = arg.trim().split(/\s+/).filter(Boolean);
    const all = words.includes("--all");
    const rest = words.filter((word) => word !== "--all");
    if (rest.length === 0) return listPlans(ctx, all);
    if (rest[0] === "close") return closePlan(ctx, rest.slice(1).join(" "));
    return switchPlan(ctx, rest.join(" "));
  });
}

/** Names of open tasks (and closed ones with `all`), newest first, for completion. */
export function taskNames(ctx: WorkflowContext, all = false): string[] {
  return listTasks(ctx).filter((task) => all || !isClosed(task)).map(displayName);
}

/** "14:32" for a time today, else "2026-10-12" (local time). */
function updated(ctx: WorkflowContext, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "-";
  const now = ctx.now();
  const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return day(at) === day(now) ? (clock(iso) ?? "-") : day(at);
}

function ticketCount(task: TaskState): string {
  const tickets = task.plan?.tickets ?? [];
  const runs = task.ticketRuns ?? {};
  const finished = Object.values(runs).filter((run) => run.status === "done").length;
  return `${finished}/${tickets.length || Object.keys(runs).length}`;
}

async function listPlans(ctx: WorkflowContext, all: boolean): Promise<CommandResult> {
  const current = await activeTask(ctx);
  const everything = listTasks(ctx);
  const open = everything.filter((task) => !isClosed(task));
  const shown = all ? everything : open;
  const closedCount = everything.length - open.length;
  if (shown.length === 0) return done(`No open tasks.${closedCount > 0 ? " /plans --all lists the closed ones." : ""} /plan <request> starts one.`);
  const rows = shown.map((task) => [
    task.taskId === current?.taskId ? "●" : "",
    cell(displayName(task), 40),
    cell(taskState(task, task.review).line, 100),
    ticketCount(task),
    cell(task.build?.branch ?? "-", 60),
    updated(ctx, task.updatedAt),
  ]);
  const markdown = ["## Tasks", "", ...mdTable(["", "Name", "State", "Tickets", "Branch", "Updated"], rows), "", "● is the active task. /plans <name> switches; /plans close <name> closes."].join("\n");
  const summary = `${open.length} open task(s)${all ? ` and ${closedCount} closed` : closedCount > 0 ? ` (${closedCount} closed; /plans --all)` : ""}. ${current && !isClosed(current) ? `Active: ${displayName(current)}.` : "No active task."} /plans <name> switches.`;
  // The chat block holds the table; the result stays one line. Without a UI the result is the table.
  ctx.report?.(markdown);
  return done(ctx.report ? summary : markdown, { tasks: shown.map((task) => task.taskId), active: current?.taskId });
}

/** Moves the checkout to the task's branch when that is safe; returns what happened, if there is a branch. */
async function followBranch(ctx: WorkflowContext, task: TaskState): Promise<string | undefined> {
  const branch = task.build?.branch;
  if (!branch) return undefined;
  let current: string;
  try {
    current = await ctx.git.currentBranch();
  } catch {
    return undefined;
  }
  if (current === branch) return undefined;
  if (!(await ctx.git.branchExists(branch))) return `Its branch ${branch} no longer exists, so the checkout was not changed.`;
  if ((await dirtyPaths(ctx)).length > 0) {
    const owner = listTasks(ctx).find((other) => other.taskId !== task.taskId && !isClosed(other) && other.build?.branch === current);
    return `The branch was not changed: the working tree has uncommitted changes. /build needs a clean tree to switch to ${branch}; commit or stash, then /plans ${displayName(task)} again.${owner ? ` You are on ${current}, which belongs to ${displayName(owner)}, so that task stays active until you switch branches.` : ""}`;
  }
  try {
    await ctx.git.switchTo(branch);
  } catch (error) {
    return `Could not switch to ${branch}: ${(error as Error).message}`;
  }
  return `Switched to branch ${branch}.`;
}

async function switchPlan(ctx: WorkflowContext, ref: string): Promise<CommandResult> {
  const found = findTask(listTasks(ctx), ref);
  if ("error" in found) return fail("NO_TASK", found.error);
  const task = found.task;
  const name = displayName(task);
  if (isClosed(task)) return fail("CLOSED", `${name} is closed. Its files stay on disk; /plan <request> starts a new task.`);
  ctx.store.setActive(task.taskId);
  const note = await followBranch(ctx, task);
  // Record the branch as it is now (switched or not), so only a later checkout moves the active task.
  try {
    ctx.store.setActive(task.taskId, await ctx.git.currentBranch());
  } catch {
    /* not a repository: the pointer alone is enough */
  }
  const line = `Switched to ${name} (${taskState(task, task.review).line}).${note ? ` ${note}` : ""}`;
  if (!task.plan) return done(`${line} It has no plan yet.`, { taskId: task.taskId });
  const shown = await showTaskPlan(ctx, task);
  return { ok: shown.ok, code: shown.code, text: `${line} ${shown.ok ? shown.text.split("\n")[0]! : shown.text}`, data: { taskId: task.taskId } };
}

async function closePlan(ctx: WorkflowContext, ref: string): Promise<CommandResult> {
  if (!ref.trim()) return fail("USAGE", "Use /plans close <name>. /plans lists the tasks.");
  const found = findTask(listTasks(ctx), ref);
  if ("error" in found) return fail("NO_TASK", found.error);
  const task = found.task;
  const name = displayName(task);
  if (isClosed(task)) return done(`${name} is already closed.`);
  const unbuilt = (task.plan?.tickets ?? []).filter((ticket) => task.ticketRuns?.[ticket.id]?.status !== "done").length;
  const unreviewed = !!task.build && !task.review?.passed;
  if (unbuilt > 0 || unreviewed) {
    const what = [...(unbuilt > 0 ? [`${unbuilt} ticket(s) not built`] : []), ...(unreviewed ? ["a build that has not passed review"] : [])].join(" and ");
    const go = await ctx.confirm("Close task", `${name} has ${what}. Close it anyway? Its files and branch are kept.`);
    if (!go) return fail("DECLINED", `${name} stays open.`);
  }
  await closeTask(ctx, task.taskId, "closed by user");
  // Only the stored pointer matters here: closing never reads or touches git.
  let moved = "";
  if (ctx.store.readActive() === task.taskId) {
    const next = unfinishedTasks(listTasks(ctx))[0];
    if (next) {
      ctx.store.setActive(next.taskId);
      moved = ` Active task: ${displayName(next)}.`;
    } else {
      ctx.store.clearActive();
      moved = " No active task.";
    }
  }
  return done(`Closed ${name}. Its files${task.build ? ` and branch ${task.build.branch}` : ""} are kept.${moved}`, { taskId: task.taskId });
}
