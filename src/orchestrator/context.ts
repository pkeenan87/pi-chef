import { WorkflowError, type CommandResult, type ContextReset, type Phase, type ProviderId, type TaskState, type Tier, type TokenUsage } from "../domain.js";
import type { WorkflowConfig } from "../config.js";
import type { GitWorkspace } from "../git/worktrees.js";
import type { GitHubClient } from "../github/types.js";
import type { AuthProbe } from "../providers/auth.js";
import type { DecisionsClient } from "../providers/clients.js";
import type { ChatFn } from "../providers/pi-chat.js";
import type { CheckRunner } from "../review/review.js";
import type { Classifier } from "../router/classify.js";
import { redact } from "../redact.js";
import type { TaskStore } from "../storage/store.js";
import type { InFlightSpend } from "./inflight.js";
import { move } from "./machine.js";
import type { Poller } from "./poller.js";
import type { SessionControl, WorkflowOptions, GroupExecutor, PlanReviewFn, TicketRunnerFn } from "./types.js";

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
  readonly executors: Partial<Record<Tier, GroupExecutor>>;
  /** Runs a ticket in a child pi process. Absent outside Pi unless a test injects one. */
  readonly ticketRunner?: TicketRunnerFn;
  deciders: Partial<Record<ProviderId, DecisionsClient>>;
  readonly fixer?: WorkflowOptions["fixer"];
  readonly pushBranch: (branch: string) => Promise<void>;
  /** Check runner that skips a check already passed on an identical clean tree. */
  readonly checkRunner: CheckRunner;
  readonly poller: Poller;
  /** Spend by running ticket children that is not in the ledger yet. */
  readonly inflight: InFlightSpend;
  /** Aborted by `Workflow.dispose`; ticket waves pass its signal to the worker pool so running children are stopped. */
  shutdown: AbortController;
  /** Keys of warnings already shown, so each appears once. */
  readonly warned: Set<string>;
  confirm: (title: string, message: string) => Promise<boolean>;
  notify: (message: string) => void;
  session?: SessionControl;
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

/** Phases from which /implement may start or resume work. */
export const IMPLEMENTABLE: Phase[] = ["AWAITING_PLAN_APPROVAL", "FAILED", "REVIEWING", "IMPLEMENTING", "BLOCKED"];
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

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum = (x: number | null, y: number | null) => (x === null || y === null ? null : x + y);
  return { input: sum(a.input, b.input), output: sum(a.output, b.output), cacheRead: sum(a.cacheRead, b.cacheRead), cacheWrite: sum(a.cacheWrite, b.cacheWrite), requests: a.requests + b.requests };
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

/** Writes the redacted handoff note and resets the session around it. */
export async function handoff(ctx: WorkflowContext, state: TaskState, boundary: ContextReset["boundary"], body: string): Promise<ContextReset> {
  const relative = `handoffs/${boundary}.md`;
  const clean = redact(body);
  const file = ctx.store.writeText(state.taskId, relative, clean);
  const result = ctx.session ? await ctx.session.reset({ boundary, handoff: clean }) : { mode: "handoff-only" as const, cancelled: false };
  return { boundary, at: iso(ctx), mode: result.mode, cancelled: result.cancelled, handoffFile: file };
}
