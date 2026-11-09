import { describe, expect, it } from "vitest";
import { MIN_RISK, TICKET_FAIL_RISK, compareRisk, findingKey, keepFinding, readScore, risk, riskLabel, scoreLabel } from "../src/review/risk.js";

describe("risk scoring", () => {
  it("multiplies the two scores and labels them", () => {
    expect(risk({ likelihood: 7, severity: 8 })).toBe(56);
    expect(scoreLabel({ likelihood: 7, severity: 8 })).toBe("L7×S8");
    expect(riskLabel({ likelihood: 7, severity: 8 })).toBe("L7×S8=56");
    expect([MIN_RISK, TICKET_FAIL_RISK]).toEqual([5, 20]);
  });

  it("reads numbers and numeric strings, rounds, clamps to 1..10, and leaves the rest undefined", () => {
    expect(readScore(0)).toBe(1);
    expect(readScore(11)).toBe(10);
    expect(readScore("7")).toBe(7);
    expect(readScore(" 6.6 ")).toBe(7);
    expect(readScore(-3)).toBe(1);
    for (const bad of [undefined, null, "", "  ", "high", "7/10", Number.NaN, Infinity, true, {}, []]) expect(readScore(bad), String(bad)).toBeUndefined();
  });

  it("keeps a finding at risk 5 and drops one at 4", () => {
    expect(keepFinding({ likelihood: 5, severity: 1 })).toBe(true);
    expect(keepFinding({ likelihood: 2, severity: 2 })).toBe(false);
    expect(keepFinding({ likelihood: 1, severity: 4 })).toBe(false);
    expect(keepFinding({ likelihood: 1, severity: 5 })).toBe(true);
  });

  it("drops a finding with a missing or non-numeric score instead of defaulting it", () => {
    expect(keepFinding({ severity: 10 })).toBe(false);
    expect(keepFinding({ likelihood: 10 })).toBe(false);
    expect(keepFinding({})).toBe(false);
    // A record from before scores kept a string severity.
    expect(keepFinding({ likelihood: 9, severity: "high" as unknown as number })).toBe(false);
  });

  it("sorts by risk, then severity, both descending", () => {
    const rows = [
      { id: "low", likelihood: 5, severity: 1 },
      { id: "wide", likelihood: 8, severity: 3 },
      { id: "deep", likelihood: 3, severity: 8 },
      { id: "top", likelihood: 9, severity: 9 },
    ];
    expect(rows.sort(compareRisk).map((row) => row.id)).toEqual(["top", "deep", "wide", "low"]);
  });

  it("keys a finding by file and message without case, punctuation or spacing", () => {
    expect(findingKey("a.ts", "Retry  never stops!")).toBe(findingKey("a.ts", "retry never stops"));
    expect(findingKey("a.ts", "x")).not.toBe(findingKey("b.ts", "x"));
    expect(findingKey(undefined, "x")).not.toBe(findingKey("a.ts", "x"));
  });
});
