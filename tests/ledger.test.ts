import { describe, expect, it } from "vitest";
import type { PricingRow } from "../src/config.js";
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

  it("is at least soft when unknown charges have no token counts", () => {
    const summary = summarize([record({})], { pricing });
    expect(summary.unestimatedUnknownCount).toBe(1);
    expect(budgetStatusFor(summary, 1000, 0.8)).toBe("soft");
    expect(budgetStatus(0, 1000, 0.8)).toBe("ok");
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
