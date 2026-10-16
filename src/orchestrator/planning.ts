import path from "node:path";
import type { AcceptedClassification, CommandResult, PlanDocument, TaskState } from "../domain.js";
import { classifyKeywords } from "../router/classify.js";
import { redact } from "../redact.js";
import { budgetState, remember } from "./budget.js";
import { active, done, fail, guard, iso, knownZero, type WorkflowContext } from "./context.js";
import { move } from "./machine.js";
import { acceptanceCriteria, applyOverlap, assertGraph, parseGroups, PLAN_FILE, renderPlan, renderPlanReview } from "./plan.js";
import { requestPlanChanges, SPEC_FILE } from "./interview.js";
import { announce, availability, decide, routingSummary, suggestAdvisor } from "./routing.js";
import { taskState } from "./state-label.js";
import { activeTask, closeTask, displayName, isFinished, lastSeenBranch, nameForNewTask, requireActiveTask } from "./tasks.js";

export function blank(taskId: string, request: string, at: string, name?: string): TaskState {
  return {
    taskId,
    ...(name ? { name } : {}),
    phase: "PLANNING",
    createdAt: at,
    updatedAt: at,
    phaseEnteredAt: at,
    request,
    publishApproved: false,
    attempts: [],
  };
}

/** A new task for a request: a fresh id (the directory name) and a readable name that no other task uses. */
export function newTask(ctx: WorkflowContext, request: string, at: string): TaskState {
  const taskId = `task-${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${ctx.id()}`;
  return blank(taskId, request, at, nameForNewTask(ctx, request));
}

/** Moves a task back to AWAITING_PLAN_APPROVAL for a new draft; a paused task resumes through PLANNING first. */
export function backToApproval(task: TaskState, at: string, note?: string): TaskState {
  return move(task.phase === "PAUSED" ? move(task, "PLANNING", at) : task, "AWAITING_PLAN_APPROVAL", at, note);
}

/**
 * What the active task becomes when a new /plan starts. A finished task (all tickets built, or an older published one)
 * is closed. Any other unfinished task is left exactly as it is and is returned: it is parked, and the caller says so
 * once the new task exists. /plan never revises another task's plan.
 */
export async function retireCurrent(ctx: WorkflowContext, task: TaskState | undefined): Promise<TaskState | undefined> {
  if (!task || task.phase === "COMPLETE" || task.phase === "IDLE") return undefined;
  if (isFinished(task)) {
    await closeTask(ctx, task.taskId, "closed by a new plan");
    ctx.progress?.(`Closed ${displayName(task)}.`);
    return undefined;
  }
  return task;
}

/** The chat line for a task that a new /plan parked. */
export function announceParked(ctx: WorkflowContext, parked: TaskState | undefined): void {
  if (!parked) return;
  const name = displayName(parked);
  // The active task follows the checked-out branch, so a task parked while you sit on its branch comes back on the next command.
  const onIt = parked.build?.branch !== undefined && parked.build.branch === lastSeenBranch(ctx);
  ctx.progress?.(`Parked ${name} (${taskState(parked, parked.review).line}). /plans ${name} switches back.${onIt ? ` You are on its branch ${parked.build!.branch}, so it becomes active again on the next command; switch branches first to work on the new task.` : ""}`);
}

/** Starts a new task for a literal ```tasks request and drafts its plan. The old active task is closed if finished, else parked. */
export function plan(ctx: WorkflowContext, request: string): Promise<CommandResult> {
  return guard(async () => {
    const safe = redact(request);
    const at = iso(ctx);
    if (budgetState(ctx).status === "hard") {
      return fail("BUDGET", "Task or daily budget is exhausted. /plan was not run. Run /cost for details.");
    }
    const parsed = applyOverlap(parseGroups(safe));
    assertGraph(parsed.groups);
    const parked = await retireCurrent(ctx, await activeTask(ctx));
    const classification: AcceptedClassification = classifyKeywords(safe);
    const routing = await decide(ctx, classification, "plan", {});
    let state = await ctx.store.create(newTask(ctx, safe, at));
    announceParked(ctx, parked);
    const draft: PlanDocument = {
      version: 1,
      createdAt: at,
      summary: safe.slice(0, 400),
      risks: classification.risk === "high" ? ["Security-sensitive change. Human approval stays required."] : ["Ordinary change. Plan approval stays required."],
      acceptance: acceptanceCriteria(safe),
      estimatedUsd: routing.expectedUsd,
      groups: parsed.groups,
      overlap: parsed.overlap,
      securitySensitive: routing.requireHumanApproval,
    };
    state = await ctx.store.update(state.taskId, "plan drafted", (task) => move({ ...task, plan: draft, classification, routing, request: safe }, "AWAITING_PLAN_APPROVAL", at));
    ctx.store.writeText(state.taskId, "plan.json", JSON.stringify(draft, null, 2));
    ctx.store.writeText(state.taskId, PLAN_FILE, renderPlan(draft));
    remember(ctx, state, state.phase, routing.tier, routing.provider, routing.model, knownZero(), "success", 0, "plan");
    await announce(ctx, state.taskId, "plan", routing);
    if (draft.securitySensitive) suggestAdvisor(ctx, state.taskId, "security-sensitive plan");
    const overlap = draft.overlap.length ? ` Overlap on ${draft.overlap.join(", ")} will be serialized.` : " No file overlap.";
    return done(`Draft v${draft.version} of ${displayName(state)} is waiting for approval (/show-plan).${overlap} Nothing was committed.`, { taskId: state.taskId, plan: draft, routing });
  });
}

/** The plan document for a task as it is shown for review: `plan.md`, or rendered from the stored plan. */
export function planMarkdown(ctx: WorkflowContext, task: TaskState): string {
  return ctx.store.readText(task.taskId, PLAN_FILE) ?? renderPlanReview(task.plan!, ctx.store.readText(task.taskId, SPEC_FILE), ctx.config);
}

/** Freezes the draft as plan.v{N}.approved.json and records the approved version. No dialog and no session reset. */
export async function freezeApproval(ctx: WorkflowContext, state: TaskState): Promise<TaskState> {
  const plan = state.plan!;
  const body = `${JSON.stringify(plan, null, 2)}\n`;
  ctx.store.writeOnceText(state.taskId, `plan.v${plan.version}.approved.json`, body);
  const at = iso(ctx);
  return ctx.store.update(state.taskId, "plan approved", (task) => ({ ...task, approvedVersion: task.plan?.version, approvedAt: at, updatedAt: at }));
}

/** Approves the active draft (the choice was already made on a review screen). */
export function approveDraft(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    const current = await requireActiveTask(ctx);
    if (current.phase !== "AWAITING_PLAN_APPROVAL" || !current.plan) {
      return fail("APPROVAL_REQUIRED", "There is no draft waiting for approval.");
    }
    const version = current.plan.version;
    if (current.approvedVersion === version) return done(`Plan v${version} is already approved.`);
    assertGraph(current.plan.groups);
    const state = await freezeApproval(ctx, current);
    return done(`Approved plan v${version}. Run /build.`, state);
  });
}

/** Posts the active task's plan in the chat. A draft opens the review screen, so it can be approved from here. */
export function showPlan(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    const current = await requireActiveTask(ctx);
    if (!current.plan) return fail("NO_PLAN", "The active task has no plan yet. Run /plan <request>.");
    const markdown = planMarkdown(ctx, current);
    const version = current.plan.version;
    const approved = current.approvedVersion === version;
    const where = path.join(ctx.store.taskDir(current.taskId), PLAN_FILE);
    if (!approved && current.phase === "AWAITING_PLAN_APPROVAL" && ctx.review) {
      assertGraph(current.plan.groups);
      const revisable = !!current.plan.tickets?.length;
      const choice = await ctx.review({
        title: `Plan v${version} (draft)`,
        markdown,
        actions: [
          { value: "approve", label: `Approve plan v${version}` },
          ...(revisable ? [{ value: "revise", label: "Request changes", input: "What should change in the plan?" }] : []),
          { value: "close", label: "Close" },
        ],
      });
      if (choice?.value === "revise") return requestPlanChanges(ctx, current, choice.text ?? "");
      if (choice?.value === "approve") {
        const state = await freezeApproval(ctx, current);
        return done(`Approved plan v${version}. Run /build.`, state);
      }
      return done(`Plan v${version} is still a draft. /show-plan to approve later. File: ${where}`, { taskId: current.taskId, file: where });
    }
    if (ctx.show) ctx.show(markdown);
    const status = approved ? "approved" : current.phase === "AWAITING_PLAN_APPROVAL" ? "a draft; /show-plan in a session with a UI approves it" : current.phase.toLowerCase();
    return done(ctx.show ? `Plan v${version} (${status}) is shown above. File: ${where}` : markdown, { taskId: current.taskId, file: where });
  });
}

/** Previews the keyword classification and route for a task without changing its state. The planner sets complexity during /plan. */
export function route(ctx: WorkflowContext, task: string): Promise<CommandResult> {
  return guard(async () => {
    const classification = classifyKeywords(redact(task));
    const current = await activeTask(ctx);
    const decision = await decide(ctx, classification, "preview", { taskId: current?.taskId });
    await announce(ctx, current?.taskId, "preview", decision);
    const routing = routingSummary(ctx);
    const note = "Keyword scan only: security keywords raise risk, and the planner sets complexity and risk during /plan (plan_spec).";
    return done(JSON.stringify({ note, classification, decision, routing }, null, 2), { classification, decision, routing });
  });
}
