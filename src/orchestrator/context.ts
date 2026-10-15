import { WorkflowError, type CommandResult, type Phase, type ProviderId, type TaskState, type TokenUsage } from "../domain.js";
import type { WorkflowConfig } from "../config.js";
import type { GitWorkspace } from "../git/workspace.js";
import type { GitHubClient } from "../github/types.js";
import type { AuthProbe } from "../providers/auth.js";
import type { DecisionsClient } from "../providers/clients.js";
import type { ChatFn } from "../providers/pi-chat.js";
import type { CheckRunner } from "../review/review.js";
import type { Classifier } from "../router/classify.js";
import { redact } from "../redact.js";
import type { TaskStore } from "../storage/store.js";
import { move } from "./machine.js";
import type { PlanReviewFn } from "./types.js";

/** Everything the orchestrator modules share. The UI hooks are mutable: `Workflow.bind` swaps them per command. */
export interface WorkflowContext {
  readonly cwd: string;
  /** Swapped by `Workflow.reconfigure` when a config file changes. */
  config: WorkflowConfig;
  readonly store: TaskStore;
  readonly git: GitWorkspace;
  readonly github?: GitHubClient;
  readonly now: () => Date;
  readonly id: () => string;
  authProbe: AuthProbe;
  readonly classifier?: Classifier;
  readonly rng?: () => number;
  deciders: Partial<Record<ProviderId, DecisionsClient>>;
  readonly pushBranch: (branch: string) => Promise<void>;
  /** Check runner that skips a check already passed on an identical clean tree. */
  readonly checkRunner: CheckRunner;
  /** Aborted by `Workflow.dispose`; the advisory model review passes its signal so a running call is stopped. */
  shutdown: AbortController;
  /** Keys of warnings already shown, so each appears once. */
  readonly warned: Set<string>;
  confirm: (title: string, message: string) => Promise<boolean>;
  notify: (message: string) => void;
  /** Progress lines for the chat while /build runs. Absent without a UI. */
  progress?: (message: string) => void;
  /** Multi-line markdown blocks kept in the chat transcript. Absent without a UI. */
  report?: (markdown: string) => void;
  chat?: ChatFn;
  status?: (text: string | undefined) => void;
  /** Plan-interview progress line (separate from the routing status so a routed turn does not overwrite it). */
  planStatus?: (text: string | undefined) => void;
  /** Starts a model turn in the Pi session with this user message. Absent outside Pi. */
  startTurn?: (text: string) => void;
  /** Full-plan review dialog. Absent without a UI; approval then proceeds as before. */
  review?: PlanReviewFn;
  /** Posts a plan as a displayed chat message. */
  show?: (markdown: string) => void;
}

/** Phases where a published pull request is being tracked. */
export const PUBLISHED_PHASES: Phase[] = ["PUBLISHED", "AUTOPILOT", "MERGE_READY"];

export function fail(code: string, text: string): CommandResult {
  return { ok: false, code, text };
}

export function done(text: string, data?: unknown): CommandResult {
  return { ok: true, text, data };
}

export function knownZero(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

export function iso(ctx: WorkflowContext): string {
  return ctx.now().toISOString();
}

export function active(ctx: WorkflowContext): TaskState | undefined {
  const id = ctx.store.readActive();
  return id ? ctx.store.load(id) : undefined;
}

export function requireActive(ctx: WorkflowContext): TaskState {
  const state = active(ctx);
  if (!state) throw new WorkflowError("NO_TASK", "No active task.");
  return state;
}

export function asResult(error: unknown): CommandResult {
  if (error instanceof WorkflowError) return fail(error.code, error.message);
  return fail("ERROR", redact((error as Error).message || "Unknown error"));
}

/** Runs a command body and turns anything it throws into a failed CommandResult. */
export async function guard(fn: () => Promise<CommandResult>): Promise<CommandResult> {
  try {
    return await fn();
  } catch (error) {
    return asResult(error);
  }
}

/** Moves a task to another phase through the store, so the change is logged under `reason`. */
export function transition(ctx: WorkflowContext, taskId: string, reason: string, to: Phase, note?: string): Promise<TaskState> {
  return ctx.store.update(taskId, reason, (task) => move(task, to, iso(ctx), note));
}
