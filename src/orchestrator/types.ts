import type { WorkflowConfig } from "../config.js";
import type { ProviderId } from "../domain.js";
import type { GitWorkspace } from "../git/workspace.js";
import type { AuthProbe } from "../providers/auth.js";
import type { ChatFn } from "../providers/pi-chat.js";
import type { CheckRunner } from "../review/review.js";
import type { TaskStore } from "../storage/store.js";

export interface WorkflowBinding {
  /** Chat access to the selected model (/advisor and the model review). */
  chat?: ChatFn;
  /** Persistent routing status line (for example ctx.ui.setStatus("cost-router", text)). */
  status?: (text: string | undefined) => void;
  planStatus?: (text: string | undefined) => void;
  /** Sends a user message to the Pi session and starts a turn (used by /plan to begin the interview). */
  startTurn?: (text: string) => void;
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string) => void;
  /** Posts a progress line in the chat (ticket started, done, failed). Informational, never a warning. */
  progress?: (message: string) => void;
  /** Posts a multi-line markdown block in the chat transcript (a ticket's result, the build summary, a review). */
  report?: (markdown: string) => void;
  /** Shows a full plan in a scrollable dialog and returns the chosen action. Absent without a UI. */
  review?: PlanReviewFn;
  /** Posts a plan as a displayed message in the chat transcript. */
  show?: (markdown: string) => void;
}

export interface PlanReviewAction {
  value: string;
  label: string;
  /** When set, choosing the action asks the person for text first (shown as this prompt). */
  input?: string;
}

export interface PlanReviewRequest {
  title: string;
  markdown: string;
  actions: PlanReviewAction[];
}

/** Resolves with the chosen action (and typed text for an `input` action), or undefined when dismissed. */
export type PlanReviewFn = (request: PlanReviewRequest) => Promise<{ value: string; text?: string } | undefined>;

export interface WorkflowOptions {
  cwd: string;
  config?: WorkflowConfig;
  store?: TaskStore;
  now?: () => Date;
  id?: () => string;
  auth: AuthProbe;
  git?: GitWorkspace;
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string) => void;
  progress?: (message: string) => void;
  report?: (markdown: string) => void;
  runner?: CheckRunner;
  chat?: ChatFn;
  status?: (text: string | undefined) => void;
  planStatus?: (text: string | undefined) => void;
  startTurn?: (text: string) => void;
  /** Uniform [0, 1) used for exploration when choosing among a tier's candidates. */
  rng?: () => number;
}
