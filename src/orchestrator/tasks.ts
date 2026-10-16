import { WorkflowError, type TaskState } from "../domain.js";
import { PUBLISHED_PHASES, active, iso, type WorkflowContext } from "./context.js";
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

/** Closed, published by an older version, or built to the last ticket: a new /plan closes it rather than parking it. */
export function isFinished(task: TaskState): boolean {
  if (isClosed(task) || PUBLISHED_PHASES.includes(task.phase)) return true;
  return ["IMPLEMENTING", "REVIEWING", "AWAITING_PUBLISH_APPROVAL"].includes(task.phase) && allTicketsDone(task);
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

/** The branch the last `activeTask` call saw per context (undefined: detached HEAD, or git failed). */
const seenBranch = new WeakMap<WorkflowContext, string | undefined>();

export function lastSeenBranch(ctx: WorkflowContext): string | undefined {
  return seenBranch.get(ctx);
}

/**
 * The active task. When the checked-out branch is some open task's build branch, that task is active and
 * active-task.json is updated so every reader agrees. Otherwise (default branch, a branch no task owns, detached HEAD,
 * or git failing) the stored task is used: the last one created or switched to. One git call per command; hot paths
 * such as usage ledgering read the stored task with `active` and never call git.
 */
export async function activeTask(ctx: WorkflowContext): Promise<TaskState | undefined> {
  const stored = active(ctx);
  let branch: string | undefined;
  try {
    branch = await ctx.git.currentBranch();
  } catch {
    branch = undefined;
  }
  seenBranch.set(ctx, branch);
  if (!branch || branch === "HEAD") return stored;
  if (stored && !isClosed(stored) && stored.build?.branch === branch) return stored;
  const owner = listTasks(ctx).find((task) => !isClosed(task) && task.build?.branch === branch);
  if (!owner) return stored;
  if (owner.taskId !== stored?.taskId) ctx.store.setActive(owner.taskId);
  return owner;
}

export async function requireActiveTask(ctx: WorkflowContext): Promise<TaskState> {
  const task = await activeTask(ctx);
  if (!task) throw new WorkflowError("NO_TASK", "No active task.");
  return task;
}
