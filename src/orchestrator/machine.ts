import { WorkflowError, type Phase, type TaskState } from "../domain.js";

const ACTIVE: Phase[] = [
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "IMPLEMENTING",
  "REVIEWING",
  "AWAITING_PUBLISH_APPROVAL",
  "PUBLISHED",
  "AUTOPILOT",
  "MERGE_READY",
];

const EDGES: Record<Phase, Phase[]> = {
  IDLE: ["PLANNING", "PAUSED"],
  PLANNING: ["AWAITING_PLAN_APPROVAL", "FAILED", "BLOCKED", "PAUSED"],
  AWAITING_PLAN_APPROVAL: ["IMPLEMENTING", "PLANNING", "AWAITING_PLAN_APPROVAL", "PAUSED", "FAILED", "BLOCKED"],
  IMPLEMENTING: ["REVIEWING", "PUBLISHED", "IMPLEMENTING", "AWAITING_PLAN_APPROVAL", "FAILED", "BLOCKED", "PAUSED"],
  REVIEWING: ["AWAITING_PUBLISH_APPROVAL", "IMPLEMENTING", "AWAITING_PLAN_APPROVAL", "FAILED", "BLOCKED", "PAUSED"],
  AWAITING_PUBLISH_APPROVAL: ["PUBLISHED", "IMPLEMENTING", "REVIEWING", "AWAITING_PLAN_APPROVAL", "PAUSED", "FAILED", "BLOCKED"],
  PUBLISHED: ["AUTOPILOT", "COMPLETE", "PUBLISHED", "IMPLEMENTING", "PAUSED", "BLOCKED", "FAILED"],
  AUTOPILOT: ["MERGE_READY", "COMPLETE", "IMPLEMENTING", "AUTOPILOT", "PAUSED", "BLOCKED", "FAILED"],
  MERGE_READY: ["COMPLETE", "AUTOPILOT", "PAUSED"],
  COMPLETE: ["IDLE", "PLANNING"],
  FAILED: ["IDLE", "PLANNING", "IMPLEMENTING", "PAUSED"],
  BLOCKED: ["PAUSED", "PLANNING", "IMPLEMENTING", "AWAITING_PLAN_APPROVAL", "IDLE"],
  PAUSED: [],
};

export function canTransition(from: Phase, to: Phase, state?: Pick<TaskState, "pausedFrom">): boolean {
  if (from === to && from !== "PAUSED") {
    return EDGES[from].includes(to) || from === "IMPLEMENTING" || from === "AUTOPILOT" || from === "AWAITING_PLAN_APPROVAL";
  }
  if (from === "PAUSED") {
    return to === state?.pausedFrom || to === "FAILED" || to === "IDLE" || to === "PLANNING";
  }
  if (ACTIVE.includes(from) && (to === "PAUSED" || to === "BLOCKED" || to === "FAILED")) return true;
  return EDGES[from].includes(to);
}

export function assertTransition(from: Phase, to: Phase, state?: Pick<TaskState, "pausedFrom">): void {
  if (!canTransition(from, to, state)) {
    throw new WorkflowError("ILLEGAL_TRANSITION", `Cannot move from ${from} to ${to}.`);
  }
}

export function move(state: TaskState, to: Phase, at: string, reason?: string): TaskState {
  assertTransition(state.phase, to, state);
  const next: TaskState = { ...state, phase: to, updatedAt: at, phaseEnteredAt: to === state.phase ? state.phaseEnteredAt : at };
  if (to === "PAUSED") next.pausedFrom = state.phase === "PAUSED" ? state.pausedFrom : state.phase;
  if (to !== "PAUSED") next.pausedFrom = undefined;
  if (to === "BLOCKED" || to === "FAILED" || to === "PAUSED") {
    if (reason) next.blockedReason = reason;
  } else {
    next.blockedReason = undefined;
  }
  if (to === "MERGE_READY") next.mergeReadyAt = at;
  return next;
}
