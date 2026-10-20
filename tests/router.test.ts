import { describe, expect, it } from "vitest";
import { testConfig } from "./helpers.js";
import { classifyKeywords, clipMiddle, isSecuritySensitive, plannerClassification } from "../src/router/classify.js";
import { decideRoute, needsConfirmation, needsPremiumReview, nextTier, type SuccessTable } from "../src/router/policy.js";

describe("classification and policy", () => {
  const base = { task_type: "general", complexity: "medium" as const, risk: "low" as const, required_capabilities: [], reason_codes: [], source: "planner" as const };
  const at = new Date("2026-10-14T12:00:00Z");

  it("escalates a failed tier one step, stops at the cap, and flags security work for confirmation", () => {
    const config = testConfig();
    expect(decideRoute(base, config, {}, { purpose: "implement", failedTier: "cheap", at }).tier).toBe("standard");
    expect(nextTier("premium", "premium")).toBeUndefined();
    const security = { task_type: "security", complexity: "high" as const, risk: "high" as const, required_capabilities: ["auth", "secrets"], reason_codes: [], source: "keywords" as const };
    expect(needsPremiumReview(security, config)).toBe(true);
    expect(needsConfirmation(security, config)).toBe(true);
    expect(decideRoute(security, config, {}, { purpose: "review", at }).tier).toBe("premium");
    // High risk alone asks for confirmation, but premium review is only for the configured categories.
    expect(needsConfirmation({ ...base, risk: "high", required_capabilities: ["perf"] }, config)).toBe(true);
    expect(needsPremiumReview({ ...base, risk: "high", required_capabilities: ["perf"] }, config)).toBe(false);
    expect(needsConfirmation(base, config)).toBe(false);
  });

  it("opens the circuit per tier within a time window", () => {
    const config = testConfig();
    const stamp = (minutesAgo: number, ok: boolean) => ({ at: new Date(at.getTime() - minutesAgo * 60_000).toISOString(), ok });
    const route = (table: SuccessTable, cfg = config) => decideRoute(base, cfg, table, { purpose: "implement", ticketTier: "cheap", at });
    const failing = { general: { cheap: { success: 5, failure: 3, recent: [stamp(30, false), stamp(20, false), stamp(10, false)] } } };
    const open = route(failing);
    // A failing tier is skipped: the ticket moves up to a healthy one, which is not a stall.
    expect(open.circuitOpen).toBe(false);
    expect(open.tier).toBe("standard");
    expect(open.reason).toContain("circuit_escalated_from_cheap");
    // R1: when the final tier is open too (nothing healthy above it), the circuit is reported open.
    const capped = testConfig();
    capped.routing.maxTier = "cheap";
    expect(route(failing, capped).circuitOpen).toBe(true);
    expect(route({ general: { cheap: { success: 5, failure: 3, recent: [stamp(300, false), stamp(290, false), stamp(280, false)] } } }).circuitOpen).toBe(false);
    expect(route({ general: { cheap: { success: 5, failure: 3, recent: [stamp(30, false), stamp(20, true), stamp(10, false)] } } }).circuitOpen).toBe(false);
    expect(route({ general: { premium: { success: 0, failure: 9 } } }).circuitOpen).toBe(false);
  });

  it("skips escalation tiers that resolve to the same provider and model", () => {
    const config = testConfig();
    config.tiers.standard = [{ provider: "foundry", model: "classifier" }];
    const next = decideRoute(base, config, {}, { purpose: "implement", failedTier: "cheap", at });
    expect(next.tier).toBe("premium");
    config.tiers.premium = [{ provider: "foundry", model: "classifier" }];
    expect(decideRoute(base, config, {}, { purpose: "implement", failedTier: "cheap", at }).tier).toBe("cheap");
  });

  it("routes review to routing.reviewTier, and the premium-review categories to premium", () => {
    const config = testConfig();
    const risky = { ...base, risk: "high" as const, required_capabilities: ["perf"] };
    expect(decideRoute(risky, config, {}, { purpose: "review", at }).tier).toBe("premium");
    config.routing.reviewTier = "standard";
    expect(decideRoute(risky, config, {}, { purpose: "review", at }).tier).toBe("standard");
    expect(decideRoute({ ...base, required_capabilities: ["auth"] }, config, {}, { purpose: "review", at }).tier).toBe("premium");
  });

  it("does not flag common words as security-sensitive", () => {
    expect(classifyKeywords("add a token counter to the parser").task_type).toBe("general");
    expect(classifyKeywords("fix the prod build script").task_type).toBe("general");
    expect(classifyKeywords("fix the author field").task_type).toBe("general");
    expect(classifyKeywords("rotate the oauth credentials").task_type).toBe("security");
    expect(classifyKeywords("token handling in prod").task_type).toBe("security");
    expect(classifyKeywords("rename a typo in README")).toMatchObject({ task_type: "general", source: "keywords" });
    expect(classifyKeywords("anything")).not.toHaveProperty("confidence");
  });

  it("keyword scan marks security work high risk and premium", () => {
    const hit = classifyKeywords("rotate the oauth credentials");
    expect(hit).toMatchObject({ risk: "high", complexity: "high", source: "keywords" });
    expect(isSecuritySensitive(hit)).toBe(true);
    expect(isSecuritySensitive(classifyKeywords("add a retry counter"))).toBe(false);
  });

  it("takes complexity and risk from the planner", () => {
    const rated = plannerClassification({ complexity: "low", risk: "low", securitySensitive: false, reason: "one-line config change" }, "Add a retry counter to the parser");
    expect(rated).toMatchObject({ task_type: "general", complexity: "low", risk: "low", source: "planner", required_capabilities: [] });
    expect(rated.reason_codes).toEqual(["planner", "reason: one-line config change"]);
    expect(plannerClassification({ complexity: "high", risk: "medium", securitySensitive: false }, "Rework the scheduler")).toMatchObject({ complexity: "high" });
    expect(plannerClassification({ complexity: "medium", risk: "low", securitySensitive: true }, "Add a retry counter")).toMatchObject({ task_type: "security", risk: "high", reason_codes: expect.arrayContaining(["planner_security_sensitive"]) });
  });

  it("lets the keyword scan raise the security flag but never lets the planner lower it", () => {
    const rated = plannerClassification({ complexity: "low", risk: "low", securitySensitive: false, reason: "tiny" }, "Rotate the oauth credentials used by the sync job");
    expect(isSecuritySensitive(rated)).toBe(true);
    expect(rated).toMatchObject({ task_type: "security", risk: "high", complexity: "low", source: "planner" });
    expect(rated.reason_codes).toContain("security_keyword_override");
  });

  it("does not let weak keywords alone overrule the planner", () => {
    const rated = plannerClassification({ complexity: "medium", risk: "low", securitySensitive: false }, "Cache the session token count and log it in production");
    expect(isSecuritySensitive(rated)).toBe(false);
    expect(rated).toMatchObject({ task_type: "general", risk: "low" });
  });

  it("clips long text in the middle", () => {
    const clipped = clipMiddle("x".repeat(50_000), 8000);
    expect(clipped.length).toBeLessThan(8100);
    expect(clipped).toContain("truncated");
    expect(clipMiddle("short", 8000)).toBe("short");
  });
});
