import { describe, expect, it } from "vitest";
import type { PricingRow } from "../src/config.js";
import { layerConfigs, parseConfig } from "../src/config.js";
import { budgetStatus, budgetStatusFor, makeDayKey, recordsForDay, summarize } from "../src/cost/ledger.js";
import type { CostRecord } from "../src/domain.js";

const pricing: PricingRow[] = [
  { provider: "openai", model: "cheap", effectiveFrom: "2026-01-01", inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
  { provider: "openai", model: "big", effectiveFrom: "2026-01-01", inputPerMillionUsd: 10, outputPerMillionUsd: 20 },
];

function record(over: Partial<CostRecord>): CostRecord {
  return {
    id: "r", at: "2026-10-14T12:00:00.000Z", taskId: "t", phase: "IMPLEMENTING", provider: "openai", model: "cheap", tier: "cheap",
    requests: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    estimatedUsd: null, actualUsd: null, usageKnown: false, outcome: "unknown", retries: 0, reason: "", ...over,
  };
}

describe("ledger unknown spend", () => {
  it("estimates unknown spend with the most expensive provider price", () => {
    const summary = summarize([record({ inputTokens: 1_000_000, outputTokens: 100_000 })], { pricing });
    expect(summary.unknownCount).toBe(1);
    expect(summary.estimatedUnknownUsd).toBe(12);
    expect(summary.unestimatedUnknownCount).toBe(0);
    expect(budgetStatus(summary.knownUsd, 14, 0.8, summary)).toBe("soft");
    expect(budgetStatus(summary.knownUsd, 12, 0.8, summary)).toBe("hard");
    expect(budgetStatus(summary.knownUsd, 100, 0.8, summary)).toBe("ok");
  });

  it("counts an unknown charge with no token counts at the flat estimate without flipping the status", () => {
    const summary = summarize([record({})], { pricing });
    expect(summary.unestimatedUnknownCount).toBe(1);
    expect(summary.estimatedUnknownUsd).toBe(0.05);
    expect(budgetStatusFor(summary, 1000, 0.8)).toBe("ok");
    expect(budgetStatus(0, 1000, 0.8)).toBe("ok");
  });

  it("11 unknown no-token classifier rows stay ok and add $0.55 of estimated spend", () => {
    const rows = Array.from({ length: 11 }, (_, i) => record({ id: `c${i}`, tier: "classifier", reason: "classify" }));
    const summary = summarize(rows, { pricing });
    expect(summary.unknownCount).toBe(11);
    expect(summary.knownUsd).toBe(0);
    expect(summary.estimatedUnknownUsd).toBe(0.55);
    expect(budgetStatusFor(summary, 20, 0.8)).toBe("ok");
    // With $1.91 known, the estimate adds to spend: 1.91 + 0.55 = 2.46 of 20.
    expect(budgetStatus(1.91, 20, 0.8, summary)).toBe("ok");
  });

  it("goes soft when enough unknown rows cross the soft ratio, and hard at the limit", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => record({ id: `u${i}` }));
    expect(budgetStatusFor(summarize(rows(15), { pricing }), 1, 0.8)).toBe("ok"); // $0.75 of $1
    expect(budgetStatusFor(summarize(rows(16), { pricing }), 1, 0.8)).toBe("soft"); // $0.80 = the ratio
    expect(budgetStatusFor(summarize(rows(19), { pricing }), 1, 0.8)).toBe("soft"); // $0.95
    expect(budgetStatusFor(summarize(rows(20), { pricing }), 1, 0.8)).toBe("hard");
    // The estimate is configurable.
    expect(summarize(rows(3), { pricing, unknownCallUsd: 0.2 }).estimatedUnknownUsd).toBe(0.6);
  });

  it("keeps the ledger entries unknown: the estimate lives only in the summary", () => {
    const rows = [record({}), record({ id: "r2" })];
    const before = JSON.stringify(rows);
    const summary = summarize(rows, { pricing });
    expect(JSON.stringify(rows)).toBe(before);
    expect(rows.every((row) => row.actualUsd === null)).toBe(true);
    expect(summary.knownUsd).toBe(0);
    expect(summary.unknownRecords).toBe(2);
  });

  it("sums in integer micro-USD", () => {
    const records = Array.from({ length: 10 }, () => record({ actualUsd: 0.1, usageKnown: true }));
    expect(summarize(records).knownUsd).toBe(1);
  });

  it("supports a timezone day key and defaults to UTC", () => {
    const late = record({ at: "2026-10-14T02:00:00.000Z" });
    const now = new Date("2026-10-14T12:00:00.000Z");
    expect(recordsForDay([late], now)).toHaveLength(1);
    expect(recordsForDay([late], now, makeDayKey("America/Los_Angeles"))).toHaveLength(0);
  });
});

describe("budgets.unknownCallUsd layering", () => {
  const layered = (user: Record<string, unknown> | undefined, project: Record<string, unknown> | undefined) =>
    (layerConfigs(user, project, []).budgets as { unknownCallUsd?: number } | undefined)?.unknownCallUsd;

  it("defaults to 0.05", () => {
    expect(parseConfig("{}").budgets.unknownCallUsd).toBe(0.05);
  });

  it("a project can only raise it: the higher of user and project wins", () => {
    expect(layered({ budgets: { unknownCallUsd: 0.1 } }, { budgets: { unknownCallUsd: 0.01 } })).toBe(0.1);
    expect(layered({ budgets: { unknownCallUsd: 0.1 } }, { budgets: { unknownCallUsd: 0.5 } })).toBe(0.5);
    // The user sets none: the project is compared with the default, so it cannot lower it below 0.05.
    expect(layered(undefined, { budgets: { unknownCallUsd: 0 } })).toBe(0.05);
    expect(layered({ budgets: { taskUsd: 5 } }, { budgets: { unknownCallUsd: 0.2 } })).toBe(0.2);
  });
});
