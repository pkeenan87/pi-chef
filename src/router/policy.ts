import { tierCandidates, type WorkflowConfig } from "../config.js";
import { BASE_TIERS, LOCAL_TIERS, TICKET_TIERS, type AcceptedClassification, type RoutingDecision, type Tier } from "../domain.js";
import { selectCandidate, type Availability, type CandidateCheck, type Selection } from "./select.js";
import type { QuotaUsage } from "../cost/quota.js";
import { circuitOpenFor, reviewMetricType, type SuccessTable } from "./stats.js";

export { circuitOpenFor, SUCCESS_PRIOR } from "./stats.js";
export type { AttemptOutcome, SuccessCell, SuccessTable } from "./stats.js";

const ORDER: Tier[] = [...BASE_TIERS];
/** The /build ladder: a ticket starts on its difficulty tier and moves one step up after each failure. */
export const TICKET_LADDER: Tier[] = [...TICKET_TIERS, "premium"];
/**
 * The local-mode ladder: the local model, then premium (Opus) to finish a ticket the local model could not pass, by
 * the user's decision. Then stop.
 */
export const LOCAL_LADDER: Tier[] = [...LOCAL_TIERS, "premium"];

/** Strength of a tier for the maxTier cap. The ticket tiers sit between standard and premium; the local tiers count as cheap. */
function capRank(tier: Tier): number {
  if ((LOCAL_TIERS as readonly string[]).includes(tier)) return ORDER.indexOf("cheap");
  return (TICKET_TIERS as readonly string[]).includes(tier) ? ORDER.indexOf("standard") : ORDER.indexOf(tier);
}

export function nextTier(tier: Tier, maxTier: Tier): Tier | undefined {
  const ladder = LOCAL_LADDER.includes(tier) ? LOCAL_LADDER : TICKET_LADDER.includes(tier) ? TICKET_LADDER : ORDER;
  const index = ladder.indexOf(tier);
  const next = index < 0 ? undefined : ladder[index + 1];
  return next && capRank(next) <= capRank(maxTier) ? next : undefined;
}

/** Tiers that share the same candidate list would repeat identical work when escalated between. */
function signature(config: WorkflowConfig, tier: Tier): string {
  const candidates = tierCandidates(config, tier);
  return candidates.map((item) => `${item.provider}/${item.model}`).join(",");
}

export interface RouteOptions {
  escalations?: number;
  at?: Date;
  failedTier?: Tier;
  /** implement: a /build ticket on `ticketTier` (or one up from `failedTier`); review: the /review and per-ticket review model. */
  purpose?: "implement" | "review";
  circuitWindowMs?: number;
  /** Which providers are callable now. Omitted means all are. */
  availability?: Availability;
  /** Per-candidate usability (Pi's registry knows the model and holds credentials for it). */
  candidateCheck?: CandidateCheck;
  /** Smaller of the task and daily budget left, in USD. */
  budgetRemainingUsd?: number;
  /** Subscription quota use for shadow-price ranking. Never affects budgets. */
  quota?: QuotaUsage;
  /** The tier to implement on: a ticket's difficulty tier, or the tier an interrupted attempt was on. */
  ticketTier?: Tier;
  /** Uniform [0, 1) for exploration. Defaults to Math.random. */
  rng?: () => number;
  /**
   * Never pick a provider that is not signed in, and move up a tier when none in the chosen tier is. For work
   * that runs unattended (a /build ticket), where nobody can answer a login prompt.
   */
  strictAvailability?: boolean;
}

/** Premium review applies to the configured categories (capabilities or task type). */
export function needsPremiumReview(classification: AcceptedClassification, config: WorkflowConfig): boolean {
  const categories = config.routing.requirePremiumReviewFor;
  return classification.required_capabilities.some((cap) => categories.includes(cap)) || categories.includes(classification.task_type);
}

/** A security-sensitive plan: premium review, or any high-risk task. /build asks before it starts one. */
export function needsConfirmation(classification: AcceptedClassification, config: WorkflowConfig): boolean {
  return needsPremiumReview(classification, config) || classification.risk === "high";
}

/**
 * Picks the tier and model for a /build ticket (its difficulty tier, one step up the ladder after a failure, a tier up
 * when the chosen one has nothing usable) or for a review (premium for the premium-review categories, else
 * routing.reviewTier). Planning, compaction and advisors do not route through here.
 */
export function decideRoute(
  classification: AcceptedClassification,
  config: WorkflowConfig,
  table: SuccessTable,
  options: RouteOptions = {},
): RoutingDecision {
  const at = options.at ?? new Date();
  const purpose = options.purpose ?? "implement";
  const premiumReview = needsPremiumReview(classification, config);
  // The /review model pass keeps its own record (reviewMetricType), so review picks never read implementation cells.
  const metricType = purpose === "review" ? reviewMetricType(classification.task_type) : classification.task_type;
  const breaker = (tier: Tier) =>
    circuitOpenFor(table, metricType, tier, config.routing.circuitBreakerFailures, at, options.circuitWindowMs);
  const select = (tier: Tier, rng: (() => number) | undefined = options.rng): Selection =>
    selectCandidate({
      tier,
      taskType: metricType,
      config,
      table,
      availability: options.availability,
      candidateCheck: options.candidateCheck,
      budgetRemainingUsd: options.budgetRemainingUsd,
      quota: options.quota,
      rng,
      at,
      strictAvailability: options.strictAvailability === true,
    });
  // Whether a tier is blocked never depends on sampling, so probes use a constant and leave the caller's rng alone.
  const probe = (tier: Tier): Selection => select(tier, () => 0.5);
  const cap = config.routing.maxTier;
  const reasons = [...classification.reason_codes, `purpose_${purpose}`];
  let tier: Tier;
  if (options.failedTier) {
    tier = escalateImplementation(options.failedTier, cap, config);
  } else if (purpose === "review") {
    tier = premiumReview ? "premium" : config.routing.reviewTier;
  } else {
    // The ticket's own difficulty tier, whatever the plan's security flag says (the planner rates security-heavy
    // tickets high). Unavailable or blocked tiers move up the same ladder below.
    tier = options.ticketTier ?? "ticketMedium";
    // The local tier has no circuit escalation: a new local ticket always starts on the local model.
    if (tier !== "local" && (breaker(tier) || probe(tier).blocked?.code === "circuit_open")) {
      const escalated = escalateImplementation(tier, cap, config);
      if (escalated !== tier) reasons.push(`circuit_escalated_from_${tier}`);
      tier = escalated;
    }
  }
  if (capRank(tier) > capRank(cap)) tier = cap;
  let selection = probe(tier);
  // Nothing usable at this tier (allowlist, open circuit): move up the ladder rather than stall.
  const movable = (code: string) => code === "excluded" || code === "no_candidates" || code === "circuit_open" || (code === "unavailable" && options.strictAvailability === true);
  // What each tier tried before the ladder moved up, so a final stop names every candidate and its reason.
  const tried: string[] = [];
  // A down local server never moves a local ticket on: Opus finishes only a ticket the local model tried and failed.
  while (selection.blocked && tier !== "local" && movable(selection.blocked.code)) {
    const escalated = escalateImplementation(tier, cap, config);
    if (escalated === tier) break;
    if (selection.blocked.code === "unavailable") tried.push(selection.blocked.message);
    reasons.push(`escalated_from_${tier}_${selection.blocked.code}`);
    tier = escalated;
    selection = probe(tier);
  }
  // Only the final choice draws from the rng, so a seeded run picks the same model however many tiers were probed.
  selection = select(tier);
  // Open only when the tier finally chosen is itself open: an escalation to a healthy tier is not a stall.
  const circuitOpen = breaker(tier) || selection.blocked?.code === "circuit_open";
  const candidate = selection.candidate;
  const blocked = candidate ? undefined : [...tried, selection.blocked?.message ?? "No model is available for this tier."].join(" ");
  if (circuitOpen) reasons.push("circuit_open");
  if (selection.unpriced) reasons.push("price_unknown");
  return {
    tier,
    provider: candidate?.provider ?? "none",
    model: candidate?.model ?? "blocked",
    reason: reasons,
    escalations: options.escalations ?? 0,
    circuitOpen,
    ...(candidate ? { candidate } : {}),
    selectionReason: selection.reason,
    considered: selection.considered,
    ...(blocked ? { blocked } : {}),
  };
}

/** The next tier up from `failed` (within `cap`) whose models differ, or `failed` itself when there is none. */
export function escalateImplementation(failed: Tier, cap: Tier, config: WorkflowConfig): Tier {
  const from = signature(config, failed);
  let cursor: Tier | undefined = nextTier(failed, cap);
  while (cursor) {
    if (signature(config, cursor) !== from) return cursor;
    cursor = nextTier(cursor, cap);
  }
  return failed;
}
