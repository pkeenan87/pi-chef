import { tierCandidates, type WorkflowConfig } from "../config.js";
import { BASE_TIERS, modelMetricKey, TICKET_TIERS, type AcceptedClassification, type RoutingDecision, type Tier, type TicketTier } from "../domain.js";
import { selectCandidate, type Availability, type CandidateCheck, type Selection } from "./select.js";
import type { QuotaUsage } from "../cost/quota.js";
import { circuitOpenFor, rankingCost, rate, reviewMetricType, SUCCESS_PRIOR, tierCost, type SuccessTable } from "./stats.js";

export { circuitOpenFor, DEFAULT_CIRCUIT_WINDOW_MS, EXPECTED_INPUT_SHARE, SUCCESS_PRIOR } from "./stats.js";
export type { AttemptOutcome, SuccessCell, SuccessTable } from "./stats.js";

const ORDER: Tier[] = [...BASE_TIERS];
/** The /build ladder: a ticket starts on its difficulty tier and moves one step up after each failure. */
export const TICKET_LADDER: Tier[] = [...TICKET_TIERS, "premium"];

/** Strength of a tier for the maxTier cap. The ticket tiers sit between standard and premium. */
function capRank(tier: Tier): number {
  return (TICKET_TIERS as readonly string[]).includes(tier) ? ORDER.indexOf("standard") : ORDER.indexOf(tier);
}

export function nextTier(tier: Tier, maxTier: Tier): Tier | undefined {
  const ladder = TICKET_LADDER.includes(tier) ? TICKET_LADDER : ORDER;
  const index = ladder.indexOf(tier);
  const next = index < 0 ? undefined : ladder[index + 1];
  return next && capRank(next) <= capRank(maxTier) ? next : undefined;
}

/** Tiers that share the same candidate list would repeat identical work when escalated between. */
function signature(config: WorkflowConfig, tier: Tier): string {
  const candidates = tierCandidates(config, tier);
  return candidates.length === 0 ? "literal" : candidates.map((item) => `${item.provider}/${item.model}`).join(",");
}

export interface RouteOptions {
  escalations?: number;
  at?: Date;
  failedTier?: Tier;
  purpose?: "plan" | "implement" | "review" | "preview";
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
   * that runs unattended (ticket children), where nobody can answer a login prompt.
   */
  strictAvailability?: boolean;
}

export function decideRoute(
  classification: AcceptedClassification,
  config: WorkflowConfig,
  table: SuccessTable,
  options: RouteOptions = {},
): RoutingDecision {
  const at = options.at ?? new Date();
  const escalations = options.escalations ?? 0;
  const purpose = options.purpose ?? "preview";
  const categories = config.routing.requirePremiumReviewFor;
  // Premium review applies only to the configured categories (capabilities or task type).
  const premiumReview =
    classification.required_capabilities.some((cap) => categories.includes(cap)) || categories.includes(classification.task_type);
  // Human approval additionally covers any high-risk task.
  const sensitive = premiumReview || classification.risk === "high";
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
      // A local model that is down must fall back to literal edits, not to a login prompt.
      strictAvailability: tier === "deterministic" || options.strictAvailability === true,
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
  } else if (purpose === "plan") {
    tier = classification.complexity === "high" || sensitive ? "premium" : classification.recommended_tier;
  } else if (purpose === "implement" && options.ticketTier) {
    // Deterministic: the ticket's own difficulty tier, whatever the plan's security flag says (the planner rates
    // security-heavy tickets high). Unavailable or blocked tiers move up the same ladder below. The proven-tier
    // shortcut does not apply: it could only pick another tier.
    tier = options.ticketTier;
    if (breaker(tier) || probe(tier).blocked?.code === "circuit_open") {
      const escalated = escalateImplementation(tier, cap, config);
      if (escalated !== tier) reasons.push(`circuit_escalated_from_${tier}`);
      tier = escalated;
    }
  } else if (purpose === "implement") {
    const proven = ORDER.filter((candidate) => {
      const stat = rate(table, classification.task_type, candidate);
      return stat.samples >= 3 && stat.rate >= 0.6 && ORDER.indexOf(candidate) <= ORDER.indexOf(classification.recommended_tier);
    });
    if (proven.length > 0) {
      tier = proven
        .map((candidate) => ({ candidate, expected: expectedFor(candidate, config, table, classification.task_type, at, options.quota) }))
        .sort((a, b) => a.expected - b.expected)[0]!.candidate;
    } else if (sensitive) {
      tier = "standard";
    } else {
      tier = "cheap";
    }
    if (breaker(tier) || probe(tier).blocked?.code === "circuit_open") {
      const escalated = escalateImplementation(tier, cap, config);
      if (escalated !== tier) reasons.push(`circuit_escalated_from_${tier}`);
      tier = escalated;
    }
  } else {
    tier = classification.recommended_tier;
  }
  if (capRank(tier) > capRank(cap)) tier = cap;
  let selection = probe(tier);
  // Nothing usable at this tier (allowlist, open circuit): move up the ladder rather than stall.
  const movable = (code: string) => code === "excluded" || code === "no_candidates" || code === "circuit_open" || (code === "unavailable" && options.strictAvailability === true);
  // What each tier tried before the ladder moved up, so a final stop names every candidate and its reason.
  const tried: string[] = [];
  while (selection.blocked && tier !== "deterministic" && movable(selection.blocked.code)) {
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
  let candidate = selection.candidate;
  let blocked: string | undefined;
  let selectionReason = selection.reason;
  if (!candidate) {
    if (tier === "deterministic") {
      // No local model configured or reachable: the plan's literal edits are the deterministic path.
      selectionReason = selection.blocked?.code === "unavailable" ? "local model unreachable; applying the plan's literal edits" : "no model; applying the plan's literal edits";
      if (selection.blocked?.code === "unavailable") reasons.push("local_unreachable");
    } else {
      blocked = [...tried, selection.blocked?.message ?? "No model is available for this tier."].join(" ");
    }
  }
  const provider = candidate?.provider ?? "none";
  const model = candidate ? candidate.model : blocked ? "blocked" : "deterministic";
  const cost = blocked ? null : candidate ? tierCost(config.pricing, candidate.provider, candidate.model, at, config.workers.tokenBudget) : 0;
  const rateUsdPerMillion = cost === null ? null : config.workers.tokenBudget > 0 ? (cost / config.workers.tokenBudget) * 1_000_000 : 0;
  const modelStat = candidate ? rate(table, metricType, modelMetricKey(tier, candidate.provider, candidate.model)) : undefined;
  const stat = modelStat && modelStat.samples > 0 ? modelStat : rate(table, metricType, tier);
  // Real price only: the quota shadow and the attempt overhead rank, they never count as spend.
  const expectedUsd = cost === null ? null : cost / Math.max(stat.rate, 0.05);
  if (stat.samples === 0) reasons.push(`success_prior_${SUCCESS_PRIOR}`);
  else reasons.push(`success_rate_${stat.rate.toFixed(2)}`);
  if (sensitive) reasons.push("security_sensitive");
  if (circuitOpen) reasons.push("circuit_open");
  if (selection.unpriced) reasons.push("price_unknown");
  return {
    tier,
    provider,
    model,
    reason: reasons,
    estimatedUsd: null,
    expectedUsd,
    rateUsdPerMillion,
    requireHumanApproval: sensitive,
    reviewTier: premiumReview ? "premium" : purpose === "review" ? tier : "standard",
    escalations,
    circuitOpen,
    ...(candidate ? { candidate } : {}),
    selectionReason,
    considered: selection.considered,
    ...(blocked ? { blocked } : {}),
  };
}

/** Next tier above `failed` whose candidate list differs; returns `failed` if none. */
function escalateImplementation(failed: Tier, cap: Tier, config: WorkflowConfig): Tier {
  const from = signature(config, failed);
  let cursor: Tier | undefined = nextTier(failed, cap);
  while (cursor) {
    if (signature(config, cursor) !== from) return cursor;
    cursor = nextTier(cursor, cap);
  }
  return failed;
}

/** Cheapest expected ranking cost (real plus quota shadow plus attempt overhead) among a tier's priced candidates; unpriced tiers rank last. */
function expectedFor(candidate: Tier, config: WorkflowConfig, table: SuccessTable, taskType: string, at: Date, quota?: QuotaUsage): number {
  const candidates = tierCandidates(config, candidate);
  if (candidates.length === 0) return 0;
  const costs = candidates
    .map((item) => rankingCost(config, item.provider, item.model, at, quota))
    .filter((value): value is number => value !== null);
  if (costs.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...costs) / Math.max(rate(table, taskType, candidate).rate, 0.05);
}
