import { estimateUsd, priceFor, type PricingRow } from "../config.js";
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

export interface SpendSummary {
  knownUsd: number;
  unknownRecords: number;
  byPhase: Record<string, { knownUsd: number; unknown: number }>;
  byProvider: Record<string, { knownUsd: number; unknown: number }>;
  byModel: Record<string, { knownUsd: number; unknown: number }>;
  byTask: Record<string, { knownUsd: number; unknown: number }>;
}

function bump(bucket: Record<string, { knownUsd: number; unknown: number }>, key: string, record: CostRecord): void {
  const current = bucket[key] ?? { knownUsd: 0, unknown: 0 };
  if (record.actualUsd === null) current.unknown += 1;
  else current.knownUsd += record.actualUsd;
  bucket[key] = current;
}

export function summarize(records: CostRecord[]): SpendSummary {
  const summary: SpendSummary = { knownUsd: 0, unknownRecords: 0, byPhase: {}, byProvider: {}, byModel: {}, byTask: {} };
  for (const record of records) {
    if (record.actualUsd === null) summary.unknownRecords += 1;
    else summary.knownUsd += record.actualUsd;
    bump(summary.byPhase, record.phase, record);
    bump(summary.byProvider, record.provider, record);
    bump(summary.byModel, record.model, record);
    bump(summary.byTask, record.taskId, record);
  }
  return summary;
}

export function budgetStatus(knownUsd: number, limit: number, ratio: number): "ok" | "soft" | "hard" {
  if (knownUsd >= limit) return "hard";
  if (knownUsd >= limit * ratio) return "soft";
  return "ok";
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
