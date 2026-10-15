import { estimateUsd, priceFor, type PricingRow } from "../config.js";

/** One recorded attempt. Optional; lets the circuit breaker look at recent attempts in a time window. */
export interface AttemptOutcome {
  at: string;
  ok: boolean;
}

export interface SuccessCell {
  success: number;
  failure: number;
  /** Optional, newest last (any order is tolerated). Producers should cap this to a small tail (for example 20). */
  recent?: AttemptOutcome[];
}

/** Keyed by task type, then by tier name or by `modelMetricKey(...)` for a single model. */
export interface SuccessTable {
  [taskType: string]: { [key: string]: SuccessCell } | undefined;
}

/** Success rate assumed when a tier has no samples. Used identically for display and ranking. */
export const SUCCESS_PRIOR = 0.5;
/** Share of the token budget assumed to be input; the rest is output (4:1). */
export const EXPECTED_INPUT_SHARE = 0.8;
export const DEFAULT_CIRCUIT_WINDOW_MS = 60 * 60 * 1000;

export function rate(table: SuccessTable, taskType: string, key: string): { rate: number; samples: number } {
  const cell = table[taskType]?.[key];
  if (!cell) return { rate: SUCCESS_PRIOR, samples: 0 };
  const samples = cell.success + cell.failure;
  if (samples === 0) return { rate: SUCCESS_PRIOR, samples: 0 };
  return { rate: cell.success / samples, samples };
}

/**
 * Per task type and key (a tier or a model key): open when the last `limit` attempts inside the window all failed.
 * Old-shape cells (no `recent`) fall back to: no successes ever and at least `limit` failures.
 */
export function circuitOpenFor(
  table: SuccessTable,
  taskType: string,
  key: string,
  limit: number,
  at: Date,
  windowMs = DEFAULT_CIRCUIT_WINDOW_MS,
): boolean {
  const cell = table[taskType]?.[key];
  if (!cell || limit <= 0) return false;
  if (cell.recent) {
    const since = at.getTime() - windowMs;
    const attempts = cell.recent
      .map((item) => ({ time: Date.parse(item.at), ok: item.ok }))
      .filter((item) => !Number.isNaN(item.time) && item.time >= since && item.time <= at.getTime())
      .sort((x, y) => x.time - y.time)
      .slice(-limit);
    return attempts.length >= limit && attempts.every((item) => !item.ok);
  }
  return cell.success === 0 && cell.failure >= limit;
}

/** Expected USD for one task at this model's price, using the configured input:output mix of workers.tokenBudget. */
export function tierCost(pricing: PricingRow[], provider: string, model: string, at: Date, tokenBudget: number): number | null {
  const row = priceFor(pricing, provider, model, at);
  if (!row) return null;
  const input = Math.round(tokenBudget * EXPECTED_INPUT_SHARE);
  return estimateUsd(row, { input, output: Math.max(0, tokenBudget - input), cacheRead: 0, cacheWrite: 0 });
}
