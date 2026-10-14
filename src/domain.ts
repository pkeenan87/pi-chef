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

export const PROVIDERS = ["openai", "anthropic", "foundry", "local"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const TIERS = ["deterministic", "classifier", "cheap", "standard", "premium"] as const;
export type Tier = (typeof TIERS)[number];

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

export interface TaskState {
  taskId: string;
  phase: Phase;
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
