import { WorkflowError, type TaskState } from "../domain.js";
import { active, iso, type WorkflowContext } from "./context.js";
import { move } from "./machine.js";

/** Words that carry no meaning in a task name. */
const STOP_WORDS = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our please so that the their then there these this those to us we want with would you your add make new need should could let lets just also some any".split(" "),
);

export const NAME_MAX = 32;
const NAME_WORDS = 5;

/**
 * A short readable name for a request: lowercase ascii, the first meaningful words (stop-words dropped), at most 32
 * characters. Empty when the request has no usable word.
 */
export function slugName(request: string): string {
  let fenced = false;
  const line =
    request.split("\n").find((item) => {
      if (item.trim().startsWith("```")) fenced = !fenced;
      else if (!fenced && /[a-z0-9]/i.test(item)) return true;
      return false;
    }) ?? "";
  const words = line
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const meaningful = words.filter((word) => !STOP_WORDS.has(word));
  const pool = meaningful.length > 0 ? meaningful : words;
  let name = "";
  for (const word of pool.slice(0, NAME_WORDS)) {
    const next = name ? `${name}-${word}` : word;
    if (next.length > NAME_MAX) {
      if (!name) name = next.slice(0, NAME_MAX);
      break;
    }
    name = next;
  }
  return name;
}

/** `name`, or `name-2`, `name-3`… so it differs from every name in `taken`. The suffix counts toward the 32 characters. */
export function uniqueName(base: string, taken: Set<string>): string {
  const root = base || "task";
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, NAME_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The task's name: the stored one, else one derived from its request (older tasks), else its id. */
export function displayName(task: Pick<TaskState, "taskId" | "name" | "request">): string {
  return task.name || slugName(task.request) || task.taskId;
}

/** Every task on disk, most recently updated first. */
export function listTasks(ctx: WorkflowContext): TaskState[] {
  const tasks: TaskState[] = [];
  for (const id of ctx.store.listTaskIds()) {
    const task = ctx.store.load(id);
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.taskId < b.taskId ? 1 : -1));
}

/** A name for a new task that no existing task uses. */
export function nameForNewTask(ctx: WorkflowContext, request: string): string {
  return uniqueName(slugName(request), new Set(listTasks(ctx).map(displayName)));
}

export function isClosed(task: TaskState): boolean {
  return task.phase === "COMPLETE";
}

/** True when the task has a plan with tickets and every one of them is done. */
export function allTicketsDone(task: TaskState): boolean {
  const tickets = task.plan?.tickets ?? [];
  return tickets.length > 0 && tickets.every((ticket) => task.ticketRuns?.[ticket.id]?.status === "done");
}

/** Closed, or built to the last ticket with a passed review: a new /plan closes it rather than parking it. */
export function isFinished(task: TaskState): boolean {
  if (isClosed(task)) return true;
  // Built is not finished: the work counts as done once its review passed, so a new /plan parks an unreviewed task.
  return ["IMPLEMENTING", "REVIEWING"].includes(task.phase) && allTicketsDone(task) && task.review?.passed === true;
}

/** Tasks still being worked on: not closed and not finished. */
export function unfinishedTasks(tasks: TaskState[]): TaskState[] {
  return tasks.filter((task) => task.phase !== "IDLE" && !isFinished(task));
}

/** Closes a task: COMPLETE with a time and a reason. Files and branches stay. Never touches git. */
export function closeTask(ctx: WorkflowContext, taskId: string, reason: string): Promise<TaskState> {
  const at = iso(ctx);
  return ctx.store.update(taskId, reason, (task) => ({ ...move(task, "COMPLETE", at, reason), closedAt: at, closedReason: reason }));
}

export type TaskLookup = { task: TaskState } | { error: string };

/** Finds a task by id or name; a unique prefix of either is enough. Open tasks win over closed ones on an exact name. */
export function findTask(tasks: TaskState[], ref: string): TaskLookup {
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return { error: "Name a task. /plans lists them." };
  const byId = tasks.find((task) => task.taskId.toLowerCase() === wanted);
  if (byId) return { task: byId };
  const exact = tasks.filter((task) => displayName(task).toLowerCase() === wanted);
  if (exact.length > 0) return { task: exact.find((task) => !isClosed(task)) ?? exact[0]! };
  const prefixed = tasks.filter((task) => displayName(task).toLowerCase().startsWith(wanted) || task.taskId.toLowerCase().startsWith(wanted));
  if (prefixed.length === 1) return { task: prefixed[0]! };
  if (prefixed.length > 1) return { error: `"${ref}" matches ${prefixed.length} tasks: ${prefixed.slice(0, 6).map(displayName).join(", ")}. Type more of the name.` };
  return { error: `No task matches "${ref}". /plans lists them (--all includes closed ones).` };
}

/**
 * The active task. It reacts to a branch change, not to the branch state: `active-task.json` records the branch seen at
 * the last resolution, and only when the checked-out branch differs from it is the branch looked up. If it is an open
 * task's build branch, that task becomes active (and the file says so); otherwise the stored task stays, the last one
 * created or switched to. An older file with no recorded branch keeps its stored task and starts recording. Detached
 * HEAD and a failing git leave the stored task alone. One git call per command; hot paths such as usage ledgering read
 * the stored task with `active` and never call git.
 */
export async function activeTask(ctx: WorkflowContext): Promise<TaskState | undefined> {
  const stored = active(ctx);
  let branch: string | undefined;
  try {
    branch = await ctx.git.currentBranch();
  } catch {
    return stored;
  }
  const seen = ctx.store.readActiveFile().seenBranch;
  if (stored && branch === seen) return stored;
  if (stored && seen === undefined) {
    ctx.store.setActive(stored.taskId, branch);
    return stored;
  }
  const owner = branch === "HEAD" ? undefined : listTasks(ctx).find((task) => !isClosed(task) && task.build?.branch === branch);
  if (owner) {
    ctx.store.setActive(owner.taskId, branch);
    return owner;
  }
  if (stored) ctx.store.setActive(stored.taskId, branch);
  return stored;
}

export async function requireActiveTask(ctx: WorkflowContext): Promise<TaskState> {
  const task = await activeTask(ctx);
  if (!task) throw new WorkflowError("NO_TASK", "No active task.");
  return task;
}

/** The task's state in a few words, from its phase and ticket runs: "building 2 of 5 tickets", "built, run /review". */
export function stateText(state: TaskState | undefined): string {
  if (!state || state.phase === "IDLE") return "no active task";
  const reason = state.blockedReason ? ` (${state.blockedReason.replace(/\s+/g, " ").slice(0, 80)})` : "";
  switch (state.phase) {
    case "PLANNING":
      return `planning (${state.planning?.stage === "tickets" ? "writing tickets" : "interview"})`;
    case "AWAITING_PLAN_APPROVAL":
      return state.approvedVersion && state.approvedVersion === state.plan?.version ? "plan approved, run /build" : "plan draft, /show-plan";
    case "COMPLETE":
      return "complete";
    case "BLOCKED":
    case "PAUSED":
    case "FAILED":
      return `${state.phase.toLowerCase()}${reason}`;
  }
  const runs = state.ticketRuns ?? {};
  const total = state.plan?.tickets?.length || Object.keys(runs).length;
  const finished = Object.values(runs).filter((run) => run.status === "done").length;
  const failed = Object.values(runs).filter((run) => run.status === "failed").length;
  if (state.review) return state.review.passed ? "reviewed, passed" : "reviewed, findings to fix";
  if (!state.build && Object.keys(runs).length === 0) return "plan approved, run /build";
  if (state.build?.currentTicket) return `building ticket ${state.build.currentTicket} of ${total}`;
  if (failed > 0) return `stopped, ${finished} of ${total} tickets done, ${failed} failed; /build resumes`;
  if (finished >= total && total > 0) return `built, ${total} tickets done; run /review`;
  return `building, ${finished} of ${total} tickets done`;
}
