export const PHASES = [
  "IDLE",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "IMPLEMENTING",
  "REVIEWING",
  "AWAITING_PUBLISH_APPROVAL",
  "PUBLISHED",
  "AUTOPILOT",
  "MERGE_READY",
  "COMPLETE",
  "BLOCKED",
  "PAUSED",
  "FAILED",
] as const;

export type Phase = (typeof PHASES)[number];

export const PROVIDERS = ["openai", "anthropic", "xai", "foundry", "local", "vercel"] as const;
/** Providers Pi signs in to with an account (oauth). Pi itself registers them; an API key is used only when the user allows it. */
export const ACCOUNT_PROVIDERS = ["openai", "anthropic", "xai"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];
export function isAccountProvider(value: string): value is AccountProvider {
  return (ACCOUNT_PROVIDERS as readonly string[]).includes(value);
}
export type ProviderId = (typeof PROVIDERS)[number];

/** The general ladder: cheapest to strongest. */
export const BASE_TIERS = ["deterministic", "classifier", "cheap", "standard", "premium"] as const;
/** /build ticket tiers, by the difficulty the planner assigns. A failed ticket climbs low, medium, high, then premium. */
export const TICKET_TIERS = ["ticketLow", "ticketMedium", "ticketHigh"] as const;
export type TicketTier = (typeof TICKET_TIERS)[number];
export const TIERS = [...BASE_TIERS, ...TICKET_TIERS] as const;
export type Tier = (typeof TIERS)[number];

export const DIFFICULTIES = ["low", "medium", "high"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}
/** The ticket tier a difficulty starts on. */
export const DIFFICULTY_TIER: Record<Difficulty, TicketTier> = { low: "ticketLow", medium: "ticketMedium", high: "ticketHigh" };
/** Difficulty of a ticket from an old plan that only has suggestedTier: deterministic/cheap low, standard medium, premium high. */
export function ticketDifficulty(ticket: { difficulty?: Difficulty; suggestedTier?: Tier }): Difficulty {
  if (ticket.difficulty) return ticket.difficulty;
  switch (ticket.suggestedTier) {
    case "deterministic":
    case "cheap":
    case "ticketLow":
      return "low";
    case "premium":
    case "ticketHigh":
      return "high";
    default:
      return "medium";
  }
}

/** Tiers a config can list candidates for. `advisor` is on-demand and never part of the escalation ladder. */
export const TIER_KEYS = [...TIERS, "advisor"] as const;
export type TierKey = (typeof TIER_KEYS)[number];

/** One model that can serve a tier. `decisions` models answer structured questions instead of chatting. */
export interface TierCandidate {
  provider: ProviderId;
  model: string;
  api: "chat" | "decisions";
  label?: string;
}

/** Why a candidate was or was not picked. Exactly one of score and excludedReason is set. */
export interface ConsideredCandidate {
  provider: ProviderId;
  model: string;
  score?: number;
  excludedReason?: string;
  priced?: boolean;
  /** Quota shadow cost (USD per task) included in `score`. Ranking only; never billed. */
  quotaUsd?: number;
}

/** Metrics key for one model inside a tier (additive to the per-tier key the circuit breaker reads). */
export function modelMetricKey(tier: string, provider: string, model: string): string {
  return `model:${tier}:${provider}/${model}`;
}

export type Complexity = "low" | "medium" | "high";

/** Schema returned by the classifier. Never executed as instructions. */
export interface Classification {
  task_type: string;
  complexity: Complexity;
  risk: Complexity;
  required_capabilities: string[];
  recommended_tier: Tier;
  confidence: number;
  reason_codes: string[];
}

export interface AcceptedClassification extends Classification {
  source: "model" | "fallback";
}

export interface PlanEdit {
  path: string;
  content: string;
}

export interface PlanGroup {
  id: string;
  summary: string;
  files: string[];
  dependsOn: string[];
  edits: PlanEdit[];
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
  /** How hard the ticket is; picks the model tier for the first attempt. Wins over suggestedTier. */
  difficulty?: Difficulty;
  /** Read from old plans only; use ticketDifficulty(). */
  suggestedTier?: Tier;
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
  estimatedUsd: number | null;
  groups: PlanGroup[];
  overlap: string[];
  securitySensitive: boolean;
  /** Present when the plan came from the interview and ticket flow; each ticket is one group. */
  tickets?: Ticket[];
}

export interface RoutingDecision {
  tier: Tier;
  provider: ProviderId | "none";
  model: string;
  reason: string[];
  estimatedUsd: number | null;
  expectedUsd: number | null;
  rateUsdPerMillion: number | null;
  requireHumanApproval: boolean;
  reviewTier: Tier;
  escalations: number;
  circuitOpen: boolean;
  /** The selected candidate, when the tier has a model. Absent for the literal-edit path. */
  candidate?: TierCandidate;
  /** One line on why this candidate won (or why none could be used). */
  selectionReason?: string;
  considered?: ConsideredCandidate[];
  /** Set when no model can serve the tier. Callers must stop instead of running literal edits. */
  blocked?: string;
}

export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  requests: number;
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
  estimatedUsd: number | null;
  actualUsd: number | null;
  /** Pi's own cost figure for the call (its list-price pricing), kept for information when the config priced the call differently. */
  listPriceUsd?: number | null;
  usageKnown: boolean;
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
  severity: "high" | "medium" | "low";
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
  /** Why there are no or fewer model findings (budget, no model, failed parts, or unparseable output). */
  error?: string;
}

export interface ReviewReport {
  passed: boolean;
  claimedPass: boolean;
  findings: Finding[];
  checks: CheckEvidence[];
  /** The reviewed diff, redacted. Older task files may carry `integratedDiff` and `worktreeDiffs` instead; both are ignored. */
  diff?: string;
  summary: string;
  /** The model pass, when it ran. Separate from `findings` so policy stays deterministic. */
  modelReview?: ModelReview;
  /** Wall time of the whole review. */
  elapsedMs?: number;
}

export interface WorkerArtifact {
  summary: string;
  changedFiles: string[];
  testResults: CheckEvidence[];
  unresolvedIssues: string[];
  usage: TokenUsage;
}

export interface PullRequestRef {
  number: number;
  url: string;
  branch: string;
  base: string;
  headSha: string;
  baseSha: string;
}

export interface AttemptRecord {
  tier: Tier;
  provider: string;
  model: string;
  outcome: "success" | "failure";
  at: string;
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
  tier?: Tier;
  provider?: string;
  model?: string;
  /** Attempts so far, one per tier tried. */
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
  /** One entry per attempt, oldest first: the trail /status shows. */
  attemptLog?: TicketAttempt[];
  /** Commit that /build made for this ticket. */
  commit?: string;
  difficulty?: Difficulty;
  /** Why the ticket last failed, for /build: a review failure is not settled by running the checks again. */
  failedBy?: "checks" | "unrunnable" | "setup" | "review";
  /** Every per-ticket review, oldest first. */
  reviews?: TicketReviewRecord[];
  /** Known cost across attempts by who incurred it; null when any entry was unknown. `costUsd` is their sum. */
  costSplit?: CostSplit;
}

export interface CostSplit {
  implementer: number | null;
  review: number | null;
  advisors: number | null;
}

/** One concern an advisor raised. */
export interface AdvisorConcern {
  severity: "high" | "medium" | "low";
  file?: string;
  issue: string;
  suggestion?: string;
}

export interface AdvisorAnswer {
  question: string;
  answer: string;
}

/** One advisor's outcome. Either an opinion (`verdict`, `answers`, `concerns`) or `error`; never both. */
export interface AdvisorOpinion {
  provider: ProviderId;
  model: string;
  verdict?: "agree" | "disagree" | "unsure";
  answers: AdvisorAnswer[];
  concerns: AdvisorConcern[];
  error?: string;
  /** Known cost of this call; null when unknown (a failed call may still have been billed). */
  costUsd: number | null;
}

/** One finding of the per-ticket review. */
export interface TicketReviewFinding {
  severity: "high" | "medium" | "low";
  file?: string;
  issue: string;
}

/**
 * One review of a ticket's diff during /build, after its checks passed. `unavailable`: the review call failed twice, so
 * the ticket was committed without it. The review model's final verdict is the only one that counts; advisors advise.
 */
export interface TicketReviewRecord {
  /** The ticket's attempt (one per tier tried). */
  attempt: number;
  /** 1 for the first review of the attempt, 2 after a fix. */
  round: number;
  tier: Tier;
  /** "provider/model" of the implementer. */
  implementer: string;
  /** "provider/model" that gave the verdict; absent when unavailable. */
  reviewer?: string;
  verdict: "pass" | "fail" | "unavailable";
  findings: TicketReviewFinding[];
  advisors: AdvisorOpinion[];
  /** Why advisors were not consulted, when they should have been. */
  advisorsSkipped?: string;
  /** The reviewer's reasoning (after the advisors, when any answered), or why the review was unavailable. */
  rationale: string;
  costUsd: { review: number | null; advisors: number | null };
}

/** Where /build works: one branch in the main checkout. */
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
  tier: Tier;
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
  phase: Phase;
  planning?: PlanningProgress;
  pausedFrom?: Phase;
  createdAt: string;
  updatedAt: string;
  request: string;
  classification?: AcceptedClassification;
  routing?: RoutingDecision;
  plan?: PlanDocument;
  approvedVersion?: number;
  publishApproved: boolean;
  /** Per-ticket progress, keyed by ticket id. */
  ticketRuns?: Record<string, TicketRun>;
  build?: BuildRecord;
  review?: ReviewReport;
  pullRequest?: PullRequestRef;
  attempts: AttemptRecord[];
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

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

export function emptyUsage(): TokenUsage {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, requests: 0 };
}
