import type { WorkflowConfig } from "../config.js";
import type { ContextReset, PlanGroup, ProviderId, Tier, TokenUsage } from "../domain.js";
import type { GitWorkspace } from "../git/worktrees.js";
import type { FixRequest, FixResult } from "../github/autopilot.js";
import type { GitHubClient } from "../github/types.js";
import type { AuthProbe } from "../providers/auth.js";
import type { DecisionsClient } from "../providers/clients.js";
import type { ChatFn } from "../providers/pi-chat.js";
import type { CheckRunner } from "../review/review.js";
import type { Classifier } from "../router/classify.js";
import type { TaskStore } from "../storage/store.js";

export interface SessionControl {
  reset(input: { boundary: ContextReset["boundary"]; handoff: string }): Promise<{ mode: ContextReset["mode"]; cancelled: boolean }>;
}

/** What a tier-aware worker executor receives for one plan group. */
export interface ExecutorInput {
  group: PlanGroup;
  tier: Tier;
  provider: string;
  model: string;
  /** Worktree this group owns. */
  cwd: string;
  /** Writes a file, restricted to the group's files. */
  write(file: string, content: string): void;
  signal: AbortSignal;
  /** Shared tokens left for the wave when the worker started, if the pool reported one. */
  budgetRemaining?: number;
}

export interface ExecutorResult {
  /** Omit when the executor cannot report usage; the charge is then recorded as unknown. */
  usage?: TokenUsage;
  changedFiles?: string[];
}

export type GroupExecutor = (input: ExecutorInput) => Promise<ExecutorResult>;

/** Runs one ticket in a fresh child pi process (see agents/pi-runner.ts). Tests inject a fake-spawn version. */
export type TicketRunnerFn = import("../agents/pi-runner.js").TicketRunner;

export interface WorkflowBinding {
  /** Chat access to the selected model (implementation executors and /advisor). */
  chat?: ChatFn;
  /** Persistent routing status line (for example ctx.ui.setStatus("cost-router", text)). */
  status?: (text: string | undefined) => void;
  planStatus?: (text: string | undefined) => void;
  /** Sends a user message to the Pi session and starts a turn (used by /plan to begin the interview). */
  startTurn?: (text: string) => void;
  session?: SessionControl;
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string) => void;
}

export interface WorkflowOptions {
  cwd: string;
  config?: WorkflowConfig;
  store?: TaskStore;
  now?: () => Date;
  id?: () => string;
  auth: AuthProbe;
  classifier?: Classifier;
  git?: GitWorkspace;
  github?: GitHubClient;
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string) => void;
  session?: SessionControl;
  runner?: CheckRunner;
  fixer?: (request: FixRequest) => Promise<FixResult>;
  push?: (branch: string) => Promise<void>;
  schedule?: (delayMs: number, run: () => void) => () => void;
  /**
   * Per-tier worker executors. A tier without one applies the plan's literal edits with no model, so
   * escalating between two such tiers would repeat identical work and is refused.
   */
  executors?: Partial<Record<Tier, GroupExecutor>>;
  /** Decisions-API classifiers by provider (foundry, vercel). Preferred over `classifier` when the tier selects one. */
  deciders?: Partial<Record<ProviderId, DecisionsClient>>;
  chat?: ChatFn;
  /** Runs approved tickets in child pi processes. Without it, a plan with tickets cannot be implemented. */
  ticketRunner?: TicketRunnerFn;
  status?: (text: string | undefined) => void;
  planStatus?: (text: string | undefined) => void;
  startTurn?: (text: string) => void;
  /** Uniform [0, 1) used for exploration when choosing among a tier's candidates. */
  rng?: () => number;
}
