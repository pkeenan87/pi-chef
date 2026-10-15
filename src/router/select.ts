import { tierCandidates, type WorkflowConfig } from "../config.js";
import { modelMetricKey, type ConsideredCandidate, type ProviderId, type TierCandidate, type TierKey } from "../domain.js";
import type { QuotaUsage } from "../cost/quota.js";
import { circuitOpenFor, shadowCost, tierCost, type SuccessTable } from "./stats.js";

/** Snapshot of which providers can be called right now (auth ready, local server reachable). */
export type Availability = Partial<Record<ProviderId, { ok: boolean; detail?: string }>>;

export interface SelectOptions {
  tier: TierKey;
  taskType: string;
  config: WorkflowConfig;
  table: SuccessTable;
  /** Omitted means every provider is assumed available. */
  availability?: Availability;
  /** Candidates whose expected cost exceeds this are excluded. Real prices only; quota shadow prices never count. */
  budgetRemainingUsd?: number;
  /** Subscription quota use, which scales `quota.models` shadow prices. Affects ranking only. */
  quota?: QuotaUsage;
  /** Uniform [0, 1). Injectable so tests are deterministic. */
  rng?: () => number;
  at?: Date;
  /** Only consider candidates that speak this API. Defaults to "chat". */
  api?: "chat" | "decisions";
  /**
   * When true an unavailable provider is a hard exclusion. When false and every otherwise-eligible
   * candidate is unavailable, the choice ignores availability so the caller's auth gate can say
   * "run /login" instead of silently escalating to a more expensive tier.
   */
  strictAvailability?: boolean;
}

export interface Selection {
  tier: TierKey;
  candidate?: TierCandidate;
  reason: string;
  considered: ConsideredCandidate[];
  /** Set when there is no candidate. `circuit` and `budget` let the policy escalate or stop. */
  blocked?: { code: "no_candidates" | "excluded" | "circuit_open" | "over_budget" | "unavailable"; message: string };
  /** The chosen candidate has no pricing row. */
  unpriced: boolean;
}

/** Floor on the sampled success probability so one unlucky draw cannot make the cost infinite. */
const MIN_P = 0.05;
/** Beta sampling cost is linear in the sample count, so very long histories are scaled down. */
const MAX_SAMPLES = 400;

/**
 * Beta(a, b) for integer a, b >= 1 is the a-th smallest of a + b - 1 uniforms, so Thompson sampling
 * needs no gamma sampler and stays exact under a seeded rng.
 */
export function sampleBeta(successes: number, failures: number, rng: () => number): number {
  let s = Math.max(0, Math.floor(successes));
  let f = Math.max(0, Math.floor(failures));
  const total = s + f;
  if (total > MAX_SAMPLES) {
    s = Math.round((s / total) * MAX_SAMPLES);
    f = MAX_SAMPLES - s;
  }
  const a = 1 + s;
  const n = a + (1 + f) - 1;
  const draws: number[] = [];
  for (let i = 0; i < n; i++) draws.push(rng());
  draws.sort((x, y) => x - y);
  return draws[a - 1]!;
}

function label(candidate: TierCandidate): string {
  return candidate.label ?? `${candidate.provider}/${candidate.model}`;
}

export function selectCandidate(options: SelectOptions): Selection {
  const { tier, taskType, config, table } = options;
  const at = options.at ?? new Date();
  const rng = options.rng ?? Math.random;
  const candidates = tierCandidates(config, tier);
  if (candidates.length === 0) {
    return { tier, considered: [], reason: `no candidates configured for ${tier}`, unpriced: false, blocked: { code: "no_candidates", message: `No models are configured for the ${tier} tier.` } };
  }
  const allow = config.orgProviderAllowlist;
  const hard = new Map<TierCandidate, string>();
  const soft = new Map<TierCandidate, string>();
  const cost = new Map<TierCandidate, number | null>();
  for (const candidate of candidates) {
    const price = tierCost(config.pricing, candidate.provider, candidate.model, at, config.workers.tokenBudget);
    cost.set(candidate, price);
    // Chat purposes (the default) never get a Decisions-only model: it cannot answer a chat turn.
    const wanted = options.api ?? "chat";
    if (candidate.api !== wanted) hard.set(candidate, `api_${candidate.api}_not_${wanted}`);
    else if (allow.length > 0 && !allow.includes(candidate.provider)) hard.set(candidate, "org_allowlist");
    else if (config.proprietaryCode && allow.length === 0 && candidate.provider !== "local") hard.set(candidate, "proprietary_code_policy");
    else if (circuitOpenFor(table, taskType, modelMetricKey(tier, candidate.provider, candidate.model), config.routing.circuitBreakerFailures, at)) {
      hard.set(candidate, "circuit_open");
    } else if (options.budgetRemainingUsd !== undefined && (price === null ? options.budgetRemainingUsd <= 0 : price > options.budgetRemainingUsd)) {
      // An unpriced model has unknown cost, so only a known-zero price may pass once the budget is spent.
      hard.set(candidate, "over_budget");
    }
    const view = options.availability?.[candidate.provider];
    if (!hard.has(candidate) && view && !view.ok) soft.set(candidate, `unavailable${view.detail ? `: ${view.detail}` : ""}`);
  }
  const eligible = candidates.filter((candidate) => !hard.has(candidate));
  const consideredBase = (picked?: Map<TierCandidate, { score: number | undefined; priced: boolean; quotaUsd?: number }>, pool?: TierCandidate[]): ConsideredCandidate[] =>
    candidates.map((candidate) => {
      const softOut = options.strictAvailability || (pool !== undefined && !pool.includes(candidate));
      const reason = hard.get(candidate) ?? (softOut ? soft.get(candidate) : undefined);
      if (reason) return { provider: candidate.provider, model: candidate.model, excludedReason: reason };
      const ranked = picked?.get(candidate);
      return {
        provider: candidate.provider,
        model: candidate.model,
        score: ranked?.score,
        priced: ranked?.priced ?? cost.get(candidate) !== null,
        ...(ranked?.quotaUsd ? { quotaUsd: ranked.quotaUsd } : {}),
      };
    });
  if (eligible.length === 0) {
    const reasons = new Set(hard.values());
    const code = reasons.size === 1 && reasons.has("circuit_open") ? "circuit_open" : reasons.size === 1 && reasons.has("over_budget") ? "over_budget" : "excluded";
    return {
      tier,
      considered: consideredBase(),
      reason: `all ${tier} candidates excluded (${[...reasons].join(", ")})`,
      unpriced: false,
      blocked: { code, message: `No ${tier} model can be used: ${[...reasons].join(", ")}.` },
    };
  }
  let pool = eligible.filter((candidate) => !soft.has(candidate));
  let fellBack = false;
  if (pool.length === 0) {
    if (options.strictAvailability) {
      return {
        tier,
        considered: consideredBase(),
        reason: `no ${tier} provider is available`,
        unpriced: false,
        blocked: { code: "unavailable", message: `No ${tier} provider is available: ${[...soft.values()].join("; ")}.` },
      };
    }
    pool = eligible;
    fellBack = true;
  }
  const ranked = new Map<TierCandidate, { score: number | undefined; priced: boolean; quotaUsd?: number }>();
  const rows = pool.map((candidate, order) => {
    const cell = table[taskType]?.[modelMetricKey(tier, candidate.provider, candidate.model)];
    // A lone candidate needs no exploration draw.
    const p = pool.length === 1 ? (cell && cell.success + cell.failure > 0 ? cell.success / (cell.success + cell.failure) : 0.5) : sampleBeta(cell?.success ?? 0, cell?.failure ?? 0, rng);
    const price = cost.get(candidate) ?? null;
    // The quota shadow price ranks scarce subscription models; the budget filter above used the real price only.
    const quotaUsd = price === null ? 0 : shadowCost(config, candidate.provider, candidate.model, options.quota);
    const score = price === null ? undefined : (price + quotaUsd) / Math.max(p, MIN_P);
    ranked.set(candidate, { score, priced: price !== null, quotaUsd });
    return { candidate, order, p, price, quotaUsd, score };
  });
  rows.sort((a, b) => {
    if ((a.score === undefined) !== (b.score === undefined)) return a.score === undefined ? 1 : -1;
    if (a.score !== undefined && b.score !== undefined && a.score !== b.score) return a.score - b.score;
    if (a.p !== b.p) return b.p - a.p;
    return a.order - b.order;
  });
  const best = rows[0]!;
  const why =
    pool.length === 1
      ? "only eligible candidate"
      : best.score === undefined
        ? "no candidate has a price; first by config order"
        : `lowest expected cost per success ($${best.score.toFixed(4)}${best.quotaUsd > 0 ? ` incl. $${best.quotaUsd.toFixed(4)} quota shadow` : ""}, sampled p=${best.p.toFixed(2)})`;
  return {
    tier,
    candidate: best.candidate,
    reason: `${label(best.candidate)}: ${why}${best.quotaUsd > 0 && options.quota?.[best.candidate.provider]?.overCap ? `; ${best.candidate.provider} over quota cap` : ""}${fellBack ? "; no provider reported ready" : ""}${best.price === null ? "; price unknown" : ""}`,
    considered: consideredBase(ranked, pool),
    unpriced: best.price === null,
  };
}
