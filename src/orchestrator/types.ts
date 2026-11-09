import type { WorkflowConfig } from "../config.js";
import type { HerdrClient } from "../herdr/client.js";
import type { TabTimings } from "../runner/tab.js";
import type { GitWorkspace } from "../git/workspace.js";
import type { ChatFn } from "../providers/pi-chat.js";
import type { UsableRegistry } from "../providers/usable.js";
import type { CheckRunner } from "../review/review.js";
import type { TaskStore } from "../storage/store.js";

export interface WorkflowBinding {
  /** Chat access to the selected model (the model review and the ticket review). */
  chat?: ChatFn;
  /** The herdr client an agent review opens its tab with. */
  herdr?: HerdrClient;
  /** Absolute path of `ticket-mode.ts`, for a review fix run by a Pi model in a tab. */
  ticketModePath?: string;
  /** Pi's model registry for the live session (see WorkflowContext.registry). Set on every bind. */
  registry?: UsableRegistry;
  /** Persistent routing status line (for example ctx.ui.setStatus("chef", text)). */
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
  /** Opens Pi's editor with a prompt and prefill (Edit tickets). Absent without a UI. */
  edit?: (title: string, prefill: string) => Promise<string | undefined>;
  /** Shows a plan or review inline and returns the action chosen in a compact picker. Absent without a UI. */
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
  /** The markdown is already in the transcript (a /review report); only the choice is shown. */
  alreadyShown?: boolean;
}

/** Posts the markdown inline, then offers the actions in a compact picker. Resolves with the chosen action (and typed text for an `input` action), or undefined when dismissed. */
export type PlanReviewFn = (request: PlanReviewRequest) => Promise<{ value: string; text?: string } | undefined>;

export interface WorkflowOptions {
  /** The checkout commands work in: git, checks, project files. */
  cwd: string;
  config?: WorkflowConfig;
  store?: TaskStore;
  now?: () => Date;
  id?: () => string;
  git?: GitWorkspace;
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string) => void;
  progress?: (message: string) => void;
  report?: (markdown: string) => void;
  runner?: CheckRunner;
  chat?: ChatFn;
  herdr?: HerdrClient;
  /** Test seam: timings and sleeps of the herdr tab waits. */
  herdrTimings?: TabTimings;
  ticketModePath?: string;
  status?: (text: string | undefined) => void;
  planStatus?: (text: string | undefined) => void;
  startTurn?: (text: string) => void;
}
