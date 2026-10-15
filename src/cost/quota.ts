import type { QuotaCap, WorkflowConfig } from "../config.js";
import type { CostRecord } from "../domain.js";
import { makeDayKey } from "./ledger.js";

/**
 * Subscription quota use per provider. This is a ranking signal only: it never changes `actualUsd`,
 * budget status, or what the ledger stores.
 */
export interface ProviderQuota {
  dailyTokens: number;
  weeklyTokens: number;
  dailyCap?: number;
  weeklyCap?: number;
  /** At or over the daily or weekly cap. */
  overCap: boolean;
  /** Applied to this provider's shadow prices: 1 under the caps, `quota.overCapMultiplier` at or over one. */
  multiplier: number;
}

export type QuotaUsage = Record<string, ProviderQuota>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Every token count the provider reported for the call. Unknown counts add nothing. */
export function quotaTokens(record: CostRecord): number {
  return (record.inputTokens ?? 0) + (record.outputTokens ?? 0) + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0);
}

/** Providers that have a cap or at least one weighted model, sorted by name. */
function quotaProviders(config: WorkflowConfig): string[] {
  return [...new Set([...Object.keys(config.quota.providers), ...config.quota.models.map((row) => row.provider)])].sort();
}

/**
 * Tokens per quota provider for the budget day of `now` (same day key as the daily budget) and the rolling
 * seven days ending at `now`.
 */
export function quotaUsage(
  records: CostRecord[],
  config: WorkflowConfig,
  now: Date,
  dayKey: (at: string | Date) => string = makeDayKey(),
): QuotaUsage {
  const providers = quotaProviders(config);
  const out: QuotaUsage = {};
  if (providers.length === 0) return out;
  const today = dayKey(now);
  const since = now.getTime() - WEEK_MS;
  const daily = new Map<string, number>();
  const weekly = new Map<string, number>();
  for (const record of records) {
    if (!providers.includes(record.provider)) continue;
    const time = Date.parse(record.at);
    if (Number.isNaN(time) || time > now.getTime()) continue;
    const tokens = quotaTokens(record);
    if (time > since) weekly.set(record.provider, (weekly.get(record.provider) ?? 0) + tokens);
    if (dayKey(record.at) === today) daily.set(record.provider, (daily.get(record.provider) ?? 0) + tokens);
  }
  for (const provider of providers) {
    const cap: QuotaCap = config.quota.providers[provider as keyof WorkflowConfig["quota"]["providers"]] ?? {};
    const dailyTokens = daily.get(provider) ?? 0;
    const weeklyTokens = weekly.get(provider) ?? 0;
    const overCap = (cap.dailyTokens !== undefined && dailyTokens >= cap.dailyTokens) || (cap.weeklyTokens !== undefined && weeklyTokens >= cap.weeklyTokens);
    out[provider] = {
      dailyTokens,
      weeklyTokens,
      ...(cap.dailyTokens !== undefined ? { dailyCap: cap.dailyTokens } : {}),
      ...(cap.weeklyTokens !== undefined ? { weeklyCap: cap.weeklyTokens } : {}),
      overCap,
      multiplier: overCap ? config.quota.overCapMultiplier : 1,
    };
  }
  return out;
}

/** One line per quota provider for /cost. */
export function quotaLines(usage: QuotaUsage): string[] {
  const count = (value: number) => value.toLocaleString("en-US");
  return Object.entries(usage).map(([provider, view]) => {
    const day = `${count(view.dailyTokens)} tokens today${view.dailyCap !== undefined ? ` / ${count(view.dailyCap)} cap` : ""}`;
    const week = `${count(view.weeklyTokens)} this week${view.weeklyCap !== undefined ? ` / ${count(view.weeklyCap)} cap` : ""}`;
    return `${provider}: ${day}, ${week}${view.overCap ? ` (over cap: shadow prices x${view.multiplier})` : ""}`;
  });
}
