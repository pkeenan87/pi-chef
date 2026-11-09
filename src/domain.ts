export const PHASES = [
  "IDLE",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "IMPLEMENTING",
  "REVIEWING",
  "COMPLETE",
  "BLOCKED",
  "PAUSED",
  "FAILED",
] as const;

export type Phase = (typeof PHASES)[number];

export const DIFFICULTIES = ["low", "medium", "high"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}
/** The difficulty a ticket was rated; one the planner left out is medium. */
export function ticketDifficulty(ticket: { difficulty?: Difficulty }): Difficulty {
  return ticket.difficulty ?? "medium";
}
/** The rung (low, medium, high) a stored `tier` names, else `fallback`. */
export function rungOf(tier: string | undefined, fallback: Difficulty): Difficulty {
  return tier && isDifficulty(tier) ? tier : fallback;
}

/** Pi's thinking levels, lowest first. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type Complexity = "low" | "medium" | "high";

/**
 * How a task is rated. `default`: before a spec exists (older task files say `keywords`). `planner`: the complexity,
 * risk and security flag the planning model gave in plan_spec.
 */
export interface Classification {
  task_type: string;
  complexity: Complexity;
  risk: Complexity;
  required_capabilities: string[];
  reason_codes: string[];
}

export interface AcceptedClassification extends Classification {
  source: "default" | "planner";
}

export interface PlanGroup {
  id: string;
  summary: string;
  files: string[];
  dependsOn: string[];
}

/** One vertical slice of work that fits a single fresh context window. */
export interface Ticket {
  /** Two-digit ordinal such as "01". */
  id: string;
  slug: string;
  title: string;
  whatToBuild: string;
  /** Technical steps: files, functions, types and signatures to add or change, and how they connect. */
  implementation?: string;
  acceptanceCriteria: string[];
  blockedBy: string[];
  /** How hard the ticket is; picks the model (`models.<difficulty>`) for the first attempt. Read it with `ticketDifficulty()`. */
  difficulty?: Difficulty;
  /** Ownership hints, not a hard allowlist. */
  files?: string[];
  estimatedContextTokens: number;
  checks?: string[];
}

export interface PlanDocument {
  version: number;
  createdAt: string;
  summary: string;
  risks: string[];
  acceptance: string[];
  groups: PlanGroup[];
  overlap: string[];
  securitySensitive: boolean;
  /** Present when the plan came from the interview and ticket flow; each ticket is one group. */
  tickets?: Ticket[];
}

export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  requests: number;
  /** Pi's own price for the call (its model catalog), when Pi reported one. Stored, and used to estimate an unpriced row. */
  listPriceUsd?: number;
}

export interface CostRecord {
  id: string;
  at: string;
  taskId: string;
  phase: Phase;
  provider: string;
  model: string;
  tier: string;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  actualUsd: number | null;
  /**
   * Pi's own price for the call (its model catalog). Never the charge: `actualUsd` comes from the config's rows. Budgets
   * use it to estimate a row whose cost is unknown, before the flat `budgets.unknownCallUsd`.
   */
  listPriceUsd?: number | null;
  usageKnown: boolean;
  /**
   * Where an external agent's row came from: `agent-log` (tokens read from the agent's own session log), or
   * `not-metered` (a subscription agent with no reader: one row for the attempt, $0, never an unknown-cost estimate).
   */
  meter?: "agent-log" | "not-metered";
  outcome: "success" | "failure" | "unknown";
  retries: number;
  reason: string;
}

export interface CheckEvidence {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ran: boolean;
  /** Wall time of the run; absent when it did not run. A cached pass reports the cache lookup's time. */
  durationMs?: number;
}

export interface Finding {
  severity: "blocking" | "suggestion";
  category: string;
  message: string;
  evidence: string;
}

/** One finding from the model pass of /review. Advisory: it is shown for a person to judge and never gates anything. */
export interface ModelFinding {
  /** 1-10: how likely it is a real defect that will actually trigger. */
  likelihood: number;
  /** 1-10: how bad the damage is if it does. */
  severity: number;
  category: string;
  file?: string;
  message: string;
  evidence?: string;
}

/** One part of the diff in the model pass: who reviewed it, and the attempts that failed first (or instead). */
export interface ModelReviewPart {
  /** 1-based. */
  index: number;
  /** "provider/model" that answered; absent when no attempt succeeded. */
  reviewedBy?: string;
  findings: number;
  /** "provider/model: why" per failed attempt, in order; or why the part was not attempted. */
  failures: string[];
}

export interface ModelReview {
  /** The routed review model (the first candidate). `parts` says who actually reviewed each part. */
  provider: string;
  model: string;
  findings: ModelFinding[];
  /** The diff was cut to fit the configured size, so the model did not see all of it. */
  truncated: boolean;
  /** Diff parts sent for review, each of at most review.maxDiffChars. */
  chunks?: number;
  parts?: ModelReviewPart[];
  elapsedMs?: number;
  costUsd?: number | null;
  /** An agent reviewed and its usage is not metered (a subscription): shown as "not metered", not as a cost. */
  notMetered?: boolean;
  /** Findings dropped for scoring below the risk threshold (likelihood × severity < 5) or lacking a score. */
  dropped?: number;
  /** Why there are no or fewer model findings (budget, no model, failed parts, or unparseable output). */
  error?: string;
}

/** Wall time and spend of one stage of /review. `costUsd` is null when a call's price is unknown, absent when the stage made no billed call. */
export interface ReviewStage {
  elapsedMs?: number;
  costUsd?: number | null;
  /** The stage ran on an external agent whose usage is not metered (a subscription): there is no dollar figure. */
  notMetered?: boolean;
}

export interface ReviewReport {
  passed: boolean;
  claimedPass: boolean;
  findings: Finding[];
  checks: CheckEvidence[];
  /** The reviewed diff, redacted. */
  diff?: string;
  summary: string;
  /** The model pass, when it ran. Separate from `findings` so policy stays deterministic. */
  modelReview?: ModelReview;
  /** Findings of the tickets' reviews in /build that passed (risk below the ticket-failing score), listed after the model findings. */
  carried?: CarriedFinding[];
  /** When the review finished (ISO). */
  at?: string;
  /** Git HEAD when the review ran. */
  headSha?: string;
  /** Wall time of the whole review. */
  elapsedMs?: number;
  /** Time per stage, and spend for the model stages (from the ledger entries this review recorded). */
  stages?: { setup?: ReviewStage; checks?: ReviewStage; model?: ReviewStage };
}

/** Where an interview-driven /plan stands while the task is in PLANNING (or PAUSED from it). */
export interface PlanningProgress {
  stage: "interview" | "tickets";
  /** True when /plan --no-questions skipped the interview. */
  noQuestions: boolean;
  /** The person's requested changes when a drafted plan was sent back from the plan review. */
  revision?: string;
}

/** Where one ticket stands during /build. */
export interface TicketRun {
  status: "in-progress" | "done" | "failed";
  /** The rung (low, medium, high) the latest attempt ran on. */
  tier?: Difficulty;
  provider?: string;
  model?: string;
  /** Attempts so far, one per rung tried. */
  attempts: number;
  turns: number;
  /** All tokens the model used across attempts (input, output, cache). */
  tokens: number;
  /** Known cost across attempts; null when any attempt's cost was unknown. */
  costUsd: number | null;
  maxContextTokens: number;
  crossedTarget: boolean;
  /** Redacted tail of the model's final message, passed to tickets this one blocks. */
  summary?: string;
  error?: string;
  /** When the first attempt started. */
  startedAt?: string;
  /** Wall time across attempts. */
  elapsedMs?: number;
  /** One entry per attempt, oldest first. */
  attemptLog?: TicketAttempt[];
  /** Commit that /build made for this ticket. */
  commit?: string;
  /** What was not verified before the commit ("no checks", "review unavailable"); tables show it as Unverified. */
  unverified?: string;
  /** When the latest attempt began and HEAD then: a commit after it with the ticket's subject means it was committed. */
  attemptStart?: { at: string; head: string };
  difficulty?: Difficulty;
  /** Why the ticket last failed, for /build: a review failure is not settled by running the checks again. */
  /** What failed the attempt. `turns`: the model used up `routing.maxTicketTurns` without finishing (model-attributable, escalates). */
  failedBy?: "checks" | "unrunnable" | "setup" | "review" | "turns";
  /** Every per-ticket review, oldest first. */
  reviews?: TicketReviewRecord[];
  /** Known cost across attempts by who incurred it; null when any entry was unknown. `costUsd` is their sum. */
  costSplit?: CostSplit;
  /** An attempt ran on an external agent whose usage is not metered (`costUsd` leaves it out). */
  notMetered?: boolean;
}

export interface CostSplit {
  implementer: number | null;
  review: number | null;
}

/** One finding of the per-ticket review, scored 1-10 for likelihood and severity like a `ModelFinding`. */
export interface TicketReviewFinding {
  likelihood: number;
  severity: number;
  file?: string;
  issue: string;
}

/** A finding a ticket's passing review in /build carried to the final /review report. */
export interface CarriedFinding extends TicketReviewFinding {
  ticket: string;
}

/**
 * One review of a ticket's diff during /build, after its checks passed. `unavailable`: the review call failed twice, so
 * the ticket was committed without it. The verdict is a rule over the findings' scores: `fail` when one scores at least
 * TICKET_FAIL_RISK, else `pass`, whose findings (the lower scores) are carried to the final report.
 */
export interface TicketReviewRecord {
  /** The ticket's attempt (one per rung tried). */
  attempt: number;
  /** 1 for the first review of the attempt, 2 after a fix. */
  round: number;
  tier: Difficulty;
  /** "provider/model" of the implementer. */
  implementer: string;
  /** "provider/model" that gave the verdict; absent when unavailable. */
  reviewer?: string;
  verdict: "pass" | "fail" | "unavailable";
  findings: TicketReviewFinding[];
  /** The reviewer's reasoning, or why the review was unavailable. */
  rationale: string;
  costUsd: { review: number | null };
  /** When the review finished (ISO): /review carries a ticket's findings only when this is newer than the task's last saved report. */
  at?: string;
}

/** Where /build works: the task's own branch in the current checkout. */
export interface BuildRecord {
  branch: string;
  /** The branch /build started from; /review diffs against it. */
  base: string;
  /** Merge base of the branch and `base` when the build started. */
  baseSha: string;
  /** The ticket a chunk is running now. Set only between nextChunk and finishChunk. */
  currentTicket?: string;
  /** When the running chunk began. */
  chunkStartedAt?: string;
  /** The config `setup` steps already ran for this build. */
  setupDone?: boolean;
}

export interface TicketAttempt {
  attempt: number;
  tier: Difficulty;
  provider: string;
  model: string;
  startedAt: string;
  elapsedMs: number;
  turns: number;
  costUsd: number | null;
  outcome: "success" | "failure";
  failedBy?: TicketRun["failedBy"];
  /** What this attempt cost by who incurred it. */
  costSplit?: CostSplit;
  error?: string;
}

export interface TaskState {
  taskId: string;
  /** Short readable name from the request (`fix-login-redirect`); also names the default build branch. Older tasks have none. */
  name?: string;
  /** Set when the task was closed (a person, or a new /plan after it finished). Its files and branch are kept. */
  closedAt?: string;
  closedReason?: string;
  phase: Phase;
  planning?: PlanningProgress;
  /** A freshly drafted plan that has not been shown yet: the extension posts it and asks for the decision when the planning turn settles. */
  presentPlan?: { version: number };
  pausedFrom?: Phase;
  createdAt: string;
  updatedAt: string;
  request: string;
  classification?: AcceptedClassification;
  plan?: PlanDocument;
  approvedVersion?: number;
  /** When the plan was approved (ISO). */
  approvedAt?: string;
  /** Per-ticket progress, keyed by ticket id. */
  ticketRuns?: Record<string, TicketRun>;
  build?: BuildRecord;
  review?: ReviewReport;
  blockedReason?: string;
  phaseEnteredAt: string;
}

export interface CommandResult {
  ok: boolean;
  code?: string;
  text: string;
  data?: unknown;
}

export class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}
