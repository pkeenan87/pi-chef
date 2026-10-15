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

export const TIERS = ["deterministic", "classifier", "cheap", "standard", "premium"] as const;
export type Tier = (typeof TIERS)[number];

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

export interface WorktreeRecord {
  groupId: string;
  branch: string;
  path: string;
  baseSha: string;
  headSha: string;
  abandoned?: boolean;
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
}

export interface Finding {
  severity: "blocking" | "suggestion";
  category: string;
  message: string;
  evidence: string;
}

export interface ReviewReport {
  passed: boolean;
  claimedPass: boolean;
  findings: Finding[];
  checks: CheckEvidence[];
  worktreeDiffs: { groupId: string; diff: string }[];
  integratedDiff: string;
  summary: string;
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

export interface ContextReset {
  boundary: "post-approval" | "post-implementation" | "post-publish" | "manual";
  at: string;
  mode: "new-session" | "compact" | "handoff-only";
  cancelled: boolean;
  handoffFile: string;
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
  /** The person's requested changes when a drafted plan was sent back from /approve-plan. */
  revision?: string;
}

/** Where one ticket stands during /implement (tickets run in child pi processes). */
export interface TicketRun {
  status: "in-progress" | "done" | "failed";
  tier?: Tier;
  provider?: string;
  model?: string;
  /** Attempts so far, one per tier tried. */
  attempts: number;
  turns: number;
  /** All tokens the child reported across attempts (input, output, cache). */
  tokens: number;
  /** Known cost across attempts; null when any attempt's cost was unknown. */
  costUsd: number | null;
  maxContextTokens: number;
  crossedTarget: boolean;
  /** Redacted tail of the child's final message, passed to tickets this one blocks. */
  summary?: string;
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
  worktrees: WorktreeRecord[];
  /** Per-ticket progress, keyed by ticket id. */
  ticketRuns?: Record<string, TicketRun>;
  integration?: { branch: string; sha?: string; path?: string };
  review?: ReviewReport;
  pullRequest?: PullRequestRef;
  attempts: AttemptRecord[];
  blockedReason?: string;
  contextResets: ContextReset[];
  phaseEnteredAt: string;
  mergeReadyAt?: string;
  autopilot?: import("./github/autopilot.js").AutopilotCursor;
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
