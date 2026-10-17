import { billingFor, DEFAULT_UNKNOWN_CALL_USD, estimateUsd, priceFor, type PricingRow } from "../config.js";
import type { CostRecord, Phase, TokenUsage } from "../domain.js";

export interface UsageInput {
  provider: string;
  model: string;
  phase: Phase;
  taskId: string;
  tier: string;
  usage: TokenUsage;
  outcome: CostRecord["outcome"];
  retries: number;
  reason: string;
  estimatedUsd?: number | null;
}

export function buildCostRecord(input: UsageInput, pricing: PricingRow[], at: Date, id: string): CostRecord {
  const reported =
    input.usage.input !== null &&
    input.usage.output !== null &&
    input.usage.requests > 0;
  const row = priceFor(pricing, input.provider, input.model, at);
  const actualUsd = reported ? estimateUsd(row, input.usage) : null;
  return {
    id,
    at: at.toISOString(),
    taskId: input.taskId,
    phase: input.phase,
    provider: input.provider,
    model: input.model,
    tier: input.tier,
    requests: input.usage.requests,
    inputTokens: input.usage.input,
    outputTokens: input.usage.output,
    cacheReadTokens: input.usage.cacheRead,
    cacheWriteTokens: input.usage.cacheWrite,
    estimatedUsd: input.estimatedUsd ?? null,
    actualUsd,
    usageKnown: actualUsd !== null,
    outcome: input.outcome,
    retries: input.retries,
    reason: input.reason,
  };
}

export interface SpendBucket {
  knownUsd: number;
  unknown: number;
  /** Estimated spend for unknown-cost entries in this bucket (additive field). */
  estimatedUnknownUsd?: number;
}

/** provider/model pairs in the ledger that have no pricing row for the provider's current billing, in first-seen order. */
export function unpricedModels(records: CostRecord[], pricing: PricingRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!record.model) continue;
    const key = `${record.provider}/${record.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!priceFor(pricing, record.provider, record.model, new Date(record.at))) out.push(key);
  }
  return out;
}

export interface SpendSummary {
  knownUsd: number;
  unknownRecords: number;
  /** Same as unknownRecords; named to match budget callers. */
  unknownCount: number;
  /**
   * Budget-only estimate for unknown-cost entries: tokens x the most expensive configured price for the provider, or
   * the flat `budgets.unknownCallUsd` for an entry with nothing to price it from. The ledger entries stay null.
   */
  estimatedUnknownUsd: number;
  /** Unknown entries that were counted at the flat `unknownCallUsd` (no token counts or no configured price for the provider). */
  unestimatedUnknownCount: number;
  byPhase: Record<string, SpendBucket>;
  byProvider: Record<string, SpendBucket>;
  byModel: Record<string, SpendBucket>;
  byTask: Record<string, SpendBucket>;
}

const MICRO = 1_000_000;

/** Integer micro-USD so repeated sums do not drift. */
function toMicro(usd: number): number {
  return Math.round(usd * MICRO);
}

function fromMicro(micro: number): number {
  return Math.round(micro) / MICRO;
}

/**
 * Worst-case micro-USD for an unknown record, or null when tokens or prices are unavailable. Only rows for the provider's
 * current billing count: a subscription session is not estimated at API-key rates.
 */
function estimateUnknownMicro(record: CostRecord, pricing: PricingRow[]): number | null {
  if (record.inputTokens === null && record.outputTokens === null) return null;
  const apiKey = billingFor(record.provider) === "api-key";
  const rows = pricing.filter((row) => row.provider === record.provider && (row.billing === "api-key") === apiKey);
  if (rows.length === 0) return null;
  let worst = 0;
  for (const row of rows) {
    const usd =
      ((record.inputTokens ?? 0) * row.inputPerMillionUsd +
        (record.outputTokens ?? 0) * row.outputPerMillionUsd +
        // As in estimateUsd: a row without cache rates bills cache tokens at the input rate, never free.
        (record.cacheReadTokens ?? 0) * (row.cacheReadPerMillionUsd ?? row.inputPerMillionUsd) +
        (record.cacheWriteTokens ?? 0) * (row.cacheWritePerMillionUsd ?? row.inputPerMillionUsd)) /
      MICRO;
    worst = Math.max(worst, toMicro(usd));
  }
  return worst;
}

interface MicroBucket {
  known: number;
  unknown: number;
  estimated: number;
}

function bump(bucket: Record<string, MicroBucket>, key: string, known: number, unknown: number, estimated: number): void {
  const current = bucket[key] ?? { known: 0, unknown: 0, estimated: 0 };
  current.known += known;
  current.unknown += unknown;
  current.estimated += estimated;
  bucket[key] = current;
}

function finish(bucket: Record<string, MicroBucket>): Record<string, SpendBucket> {
  const out: Record<string, SpendBucket> = {};
  for (const [key, value] of Object.entries(bucket)) {
    out[key] = { knownUsd: fromMicro(value.known), unknown: value.unknown, estimatedUnknownUsd: fromMicro(value.estimated) };
  }
  return out;
}

/**
 * Pass `pricing` to estimate unknown-cost entries from their token counts. An unknown entry that cannot be priced counts
 * as `unknownCallUsd` (default 0.05, never zero) in the estimate; `knownUsd` and the entries themselves are untouched.
 */
export function summarize(records: CostRecord[], options: { pricing?: PricingRow[]; unknownCallUsd?: number } = {}): SpendSummary {
  const pricing = options.pricing ?? [];
  const flat = toMicro(options.unknownCallUsd ?? DEFAULT_UNKNOWN_CALL_USD);
  let known = 0;
  let unknown = 0;
  let estimated = 0;
  let unestimated = 0;
  const phase: Record<string, MicroBucket> = {};
  const provider: Record<string, MicroBucket> = {};
  const model: Record<string, MicroBucket> = {};
  const task: Record<string, MicroBucket> = {};
  for (const record of records) {
    let k = 0;
    let u = 0;
    let e = 0;
    if (record.actualUsd === null) {
      u = 1;
      unknown += 1;
      const guess = estimateUnknownMicro(record, pricing);
      if (guess === null) {
        unestimated += 1;
        e = flat;
      } else e = guess;
      estimated += e;
    } else {
      k = toMicro(record.actualUsd);
      known += k;
    }
    bump(phase, record.phase, k, u, e);
    bump(provider, record.provider, k, u, e);
    bump(model, record.model, k, u, e);
    bump(task, record.taskId, k, u, e);
  }
  return {
    knownUsd: fromMicro(known),
    unknownRecords: unknown,
    unknownCount: unknown,
    estimatedUnknownUsd: fromMicro(estimated),
    unestimatedUnknownCount: unestimated,
    byPhase: finish(phase),
    byProvider: finish(provider),
    byModel: finish(model),
    byTask: finish(task),
  };
}

/**
 * Budget state. Estimated unknown spend counts as spend, including the flat per-call estimate for entries that cannot
 * be priced, so unknown charges are never invisible to caps and never flip the status by themselves.
 */
export function budgetStatus(
  knownUsd: number,
  limit: number,
  ratio: number,
  unknown: { estimatedUnknownUsd?: number } = {},
): "ok" | "soft" | "hard" {
  const spent = toMicro(knownUsd) + toMicro(unknown.estimatedUnknownUsd ?? 0);
  const cap = toMicro(limit);
  if (spent >= cap) return "hard";
  return spent >= Math.round(cap * ratio) ? "soft" : "ok";
}

export function budgetStatusFor(summary: SpendSummary, limit: number, ratio: number): "ok" | "soft" | "hard" {
  return budgetStatus(summary.knownUsd, limit, ratio, summary);
}

/**
 * Day bucket key (YYYY-MM-DD). Default is the UTC date, matching the previous behavior.
 * Pass an IANA timezone such as "America/New_York" for local-day budget windows.
 */
export function makeDayKey(timeZone?: string): (at: string | Date) => string {
  if (!timeZone) return (at) => (typeof at === "string" ? at : at.toISOString()).slice(0, 10);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (at) => format.format(typeof at === "string" ? new Date(at) : at);
}

/** Records on the same day as `now` under `dayKey` (default UTC). */
export function recordsForDay(
  records: CostRecord[],
  now: Date,
  dayKey: (at: string | Date) => string = makeDayKey(),
): CostRecord[] {
  const today = dayKey(now);
  return records.filter((record) => dayKey(record.at) === today);
}

export function toCsv(records: CostRecord[]): string {
  const headers = [
    "id",
    "at",
    "taskId",
    "phase",
    "provider",
    "model",
    "tier",
    "requests",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "estimatedUsd",
    "actualUsd",
    "usageKnown",
    "outcome",
    "retries",
    "reason",
  ];
  const lines = [headers.join(",")];
  for (const record of records) {
    const values = headers.map((key) => {
      const value = record[key as keyof CostRecord];
      if (value === null || value === undefined) return "";
      const text = String(value).replaceAll('"', '""');
      return /[",\n]/.test(text) ? `"${text}"` : text;
    });
    lines.push(values.join(","));
  }
  return `${lines.join("\n")}\n`;
}

export interface BaselineSample {
  source: string;
  costPerMergedPrUsd: number | null;
  timeToMergeReadyMs: number | null;
  successRate: number | null;
  retries: number | null;
  regressions: number | null;
  interventions: number | null;
}

export function compareBaseline(current: BaselineSample, reference: BaselineSample): Record<string, number | null> {
  const delta = (left: number | null, right: number | null) => (left === null || right === null ? null : left - right);
  return {
    costPerMergedPrUsd: delta(current.costPerMergedPrUsd, reference.costPerMergedPrUsd),
    timeToMergeReadyMs: delta(current.timeToMergeReadyMs, reference.timeToMergeReadyMs),
    successRate: delta(current.successRate, reference.successRate),
    retries: delta(current.retries, reference.retries),
    regressions: delta(current.regressions, reference.regressions),
    interventions: delta(current.interventions, reference.interventions),
  };
}

export function baselineFromRecords(records: CostRecord[], extras: Partial<BaselineSample> = {}): BaselineSample {
  const known = records.filter((record) => record.actualUsd !== null);
  const cost = known.reduce((sum, record) => sum + (record.actualUsd ?? 0), 0);
  const successes = records.filter((record) => record.outcome === "success").length;
  const retries = records.reduce((sum, record) => sum + record.retries, 0);
  return {
    source: extras.source ?? "this-workflow",
    costPerMergedPrUsd: extras.costPerMergedPrUsd ?? (known.length ? cost : null),
    timeToMergeReadyMs: extras.timeToMergeReadyMs ?? null,
    successRate: extras.successRate ?? (records.length ? successes / records.length : null),
    retries: extras.retries ?? retries,
    regressions: extras.regressions ?? null,
    interventions: extras.interventions ?? null,
  };
}
