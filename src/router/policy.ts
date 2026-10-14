import { estimateUsd, modelNameFor, priceFor, type PricingRow, type WorkflowConfig } from "../config.js";
import { TIERS, type AcceptedClassification, type ProviderId, type RoutingDecision, type Tier } from "../domain.js";

export interface SuccessTable {
  [taskType: string]: { [tier: string]: { success: number; failure: number } } | undefined;
}

const ORDER: Tier[] = [...TIERS];

export function nextTier(tier: Tier, maxTier: Tier): Tier | undefined {
  const index = ORDER.indexOf(tier);
  const cap = ORDER.indexOf(maxTier);
  if (index < 0 || index >= cap) return undefined;
  return ORDER[index + 1];
}

function rate(table: SuccessTable, taskType: string, tier: Tier): { rate: number; samples: number } {
  const cell = table[taskType]?.[tier];
  if (!cell) return { rate: 0.5, samples: 0 };
  const samples = cell.success + cell.failure;
  if (samples === 0) return { rate: 0.5, samples: 0 };
  return { rate: cell.success / samples, samples };
}

function recentFailures(table: SuccessTable, taskType: string, limit: number): boolean {
  const cells = table[taskType];
  if (!cells) return false;
  let failure = 0;
  let success = 0;
  for (const cell of Object.values(cells)) {
    failure += cell.failure;
    success += cell.success;
  }
  return success === 0 && failure >= limit;
}

function tierRate(pricing: PricingRow[], provider: ProviderId, model: string, at: Date): number | null {
  const row = priceFor(pricing, provider, model, at);
  if (!row) return null;
  return estimateUsd(row, { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
}

export function providerForTier(config: WorkflowConfig, tier: Tier): ProviderId | "none" {
  if (tier === "deterministic") return "none";
  const provider = config.models[tier === "classifier" ? "classifier" : tier];
  if (config.orgProviderAllowlist.length > 0 && !config.orgProviderAllowlist.includes(provider)) {
    return "none";
  }
  return provider;
}

export function decideRoute(
  classification: AcceptedClassification,
  config: WorkflowConfig,
  table: SuccessTable,
  options: { escalations?: number; at?: Date; failedTier?: Tier; purpose?: "plan" | "implement" | "review" | "preview" } = {},
): RoutingDecision {
  const at = options.at ?? new Date();
  const escalations = options.escalations ?? 0;
  const purpose = options.purpose ?? "preview";
  const sensitive =
    classification.required_capabilities.some((cap) => config.routing.requirePremiumReviewFor.includes(cap)) ||
    classification.risk === "high";
  const circuitOpen = recentFailures(table, classification.task_type, config.routing.circuitBreakerFailures);
  const cap = config.routing.maxTier;
  let tier: Tier;
  if (options.failedTier) {
    tier = escalateImplementation(options.failedTier, cap);
  } else if (purpose === "review") {
    tier = sensitive ? "premium" : "standard";
  } else if (purpose === "plan") {
    tier = classification.complexity === "high" || sensitive ? "premium" : classification.recommended_tier;
  } else if (purpose === "implement") {
    const proven = ORDER.filter((candidate) => {
      const stat = rate(table, classification.task_type, candidate);
      return stat.samples >= 3 && stat.rate >= 0.6 && ORDER.indexOf(candidate) <= ORDER.indexOf(classification.recommended_tier);
    });
    if (proven.length > 0) {
      tier = proven
        .map((candidate) => ({ candidate, expected: expectedFor(candidate, config, table, classification.task_type, at) }))
        .sort((a, b) => a.expected - b.expected)[0]!.candidate;
    } else if (sensitive) {
      tier = "standard";
    } else if (classification.complexity === "low" || classification.recommended_tier === "deterministic") {
      tier = "deterministic";
    } else {
      tier = "cheap";
    }
  } else {
    tier = classification.recommended_tier;
  }
  if (ORDER.indexOf(tier) > ORDER.indexOf(cap)) tier = cap;
  if (escalations > config.routing.maxEscalations && options.failedTier) tier = options.failedTier;
  const provider = providerForTier(config, tier);
  const model = provider === "none" ? "deterministic" : modelNameFor(config, provider, tier);
  const rateUsdPerMillion = provider === "none" ? 0 : tierRate(config.pricing, provider, model, at);
  const stat = rate(table, classification.task_type, tier);
  const success = stat.samples === 0 ? 0.5 : stat.rate;
  const expectedUsd = rateUsdPerMillion === null ? null : rateUsdPerMillion / Math.max(success, 0.05);
  const reasons = [...classification.reason_codes, `purpose_${purpose}`];
  if (stat.samples === 0) reasons.push("success_prior_0.5");
  else reasons.push(`success_rate_${stat.rate.toFixed(2)}`);
  if (sensitive) reasons.push("security_sensitive");
  if (circuitOpen) reasons.push("circuit_open");
  return {
    tier,
    provider,
    model,
    reason: reasons,
    estimatedUsd: null,
    expectedUsd,
    rateUsdPerMillion,
    requireHumanApproval: sensitive,
    reviewTier: sensitive ? "premium" : purpose === "review" ? tier : "standard",
    escalations,
    circuitOpen,
  };
}

function escalateImplementation(failed: Tier, cap: Tier): Tier {
  let cursor: Tier | undefined = failed;
  while (cursor) {
    const upcoming = nextTier(cursor, cap);
    if (!upcoming) return failed;
    if (upcoming !== "classifier") return upcoming;
    cursor = upcoming;
  }
  return failed;
}

function expectedFor(candidate: Tier, config: WorkflowConfig, table: SuccessTable, taskType: string, at: Date): number {
  const provider = providerForTier(config, candidate);
  if (provider === "none") return 0;
  const model = modelNameFor(config, provider, candidate);
  const price = tierRate(config.pricing, provider, model, at);
  const stat = rate(table, taskType, candidate);
  if (price === null) return Number.POSITIVE_INFINITY;
  return price / Math.max(stat.rate, 0.05);
}
