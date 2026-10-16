import { describe, expect, it } from "vitest";
import { testConfig } from "./helpers.js";
import { classifyKeywords, clipMiddle, isSecuritySensitive, plannerClassification } from "../src/router/classify.js";
import { decideRoute, nextTier } from "../src/router/policy.js";

describe("classification and policy", () => {
  it("starts implementation low, escalates once, and stops at the cap", () => {
    const config = testConfig();
    const mechanical = decideRoute(
      { task_type: "general", complexity: "low", risk: "low", required_capabilities: [], recommended_tier: "cheap", reason_codes: [], source: "planner" },
      config,
      {},
      { purpose: "implement" },
    );
    expect(mechanical.tier).toBe("cheap");
    const escalated = decideRoute(
      { task_type: "mechanical", complexity: "low", risk: "low", required_capabilities: [], recommended_tier: "deterministic", reason_codes: [], source: "keywords" },
      config,
      {},
      { purpose: "implement", failedTier: "deterministic", escalations: 1 },
    );
    expect(escalated.tier).toBe("cheap");
    expect(nextTier("premium", "premium")).toBeUndefined();
    const security = decideRoute(
      { task_type: "security", complexity: "high", risk: "high", required_capabilities: ["auth", "secrets"], recommended_tier: "premium", reason_codes: [], source: "keywords" },
      config,
      {},
      { purpose: "review" },
    );
    expect(security.requireHumanApproval).toBe(true);
    expect(security.reviewTier).toBe("premium");
    const open = decideRoute(
      { task_type: "security", complexity: "high", risk: "high", required_capabilities: ["auth"], recommended_tier: "premium", reason_codes: [], source: "keywords" },
      config,
      { security: { standard: { success: 0, failure: 3 } } },
      { purpose: "implement" },
    );
    // standard is open but premium is healthy, so the escalated route is usable.
    expect(open.tier).toBe("premium");
    expect(open.circuitOpen).toBe(false);
    expect(open.reason).toContain("circuit_escalated_from_standard");
  });

  const base = { task_type: "general", complexity: "medium" as const, risk: "low" as const, required_capabilities: [], recommended_tier: "cheap" as const, reason_codes: [], source: "planner" as const };
  const at = new Date("2026-10-14T12:00:00Z");

  it("opens the circuit per tier within a time window", () => {
    const config = testConfig();
    const stamp = (minutesAgo: number, ok: boolean) => ({ at: new Date(at.getTime() - minutesAgo * 60_000).toISOString(), ok });
    const failing = { general: { cheap: { success: 5, failure: 3, recent: [stamp(30, false), stamp(20, false), stamp(10, false)] } } };
    const open = decideRoute(base, config, failing, { purpose: "implement", at });
    expect(open.circuitOpen).toBe(false);
    expect(open.tier).toBe("standard");
    expect(open.reason).toContain("circuit_escalated_from_cheap");
    // R1: when the final tier is open too (nothing healthy above it), the circuit is reported open.
    const capped = testConfig();
    capped.routing.maxTier = "cheap";
    expect(decideRoute(base, capped, failing, { purpose: "implement", at }).circuitOpen).toBe(true);
    const stale = { general: { cheap: { success: 5, failure: 3, recent: [stamp(300, false), stamp(290, false), stamp(280, false)] } } };
    expect(decideRoute(base, config, stale, { purpose: "implement", at }).circuitOpen).toBe(false);
    const mixed = { general: { cheap: { success: 5, failure: 3, recent: [stamp(30, false), stamp(20, true), stamp(10, false)] } } };
    expect(decideRoute(base, config, mixed, { purpose: "implement", at }).circuitOpen).toBe(false);
    const otherTier = { general: { premium: { success: 0, failure: 9 } } };
    expect(decideRoute(base, config, otherTier, { purpose: "implement", at }).circuitOpen).toBe(false);
  });

  it("skips escalation tiers that resolve to the same provider and model", () => {
    const config = testConfig();
    config.models.standard = "foundry";
    config.providers.foundry!.deployments = { classifier: "classifier", cheap: "classifier", reasoning: "classifier" };
    const next = decideRoute(base, config, {}, { purpose: "implement", failedTier: "cheap", at });
    expect(next.tier).toBe("premium");
    config.models.premium = "foundry";
    expect(decideRoute(base, config, {}, { purpose: "implement", failedTier: "cheap", at }).tier).toBe("cheap");
  });

  it("never routes an implementation to the deterministic tier from a classification", () => {
    const config = testConfig();
    expect(decideRoute({ ...base, complexity: "low" }, config, {}, { purpose: "implement", at }).tier).toBe("cheap");
    expect(decideRoute({ ...base, complexity: "low", task_type: "mechanical", recommended_tier: "deterministic" }, config, {}, { purpose: "implement", at }).tier).toBe("cheap");
  });

  it("limits premium review to configured categories and prices a 4:1 token mix", () => {
    const config = testConfig();
    const risky = { ...base, risk: "high" as const, required_capabilities: ["perf"] };
    // The review pass routes to routing.reviewTier (premium by default).
    const decision = decideRoute(risky, config, {}, { purpose: "review", at });
    expect(decision.requireHumanApproval).toBe(true);
    expect(decision.tier).toBe("premium");
    config.routing.reviewTier = "standard";
    const lowered = decideRoute(risky, config, {}, { purpose: "review", at });
    expect(lowered.tier).toBe("standard");
    expect(lowered.reviewTier).toBe("standard");
    const auth = decideRoute({ ...base, required_capabilities: ["auth"] }, config, {}, { purpose: "review", at });
    expect(auth.tier).toBe("premium");
    const cheap = decideRoute(base, config, {}, { purpose: "preview", at });
    // 6400 input at 0.15 + 1600 output at 0.6 per million, success prior 0.5
    expect(cheap.expectedUsd).toBeCloseTo(((6400 * 0.15 + 1600 * 0.6) / 1e6) / 0.5, 8);
  });

  it("does not flag common words as security-sensitive", () => {
    expect(classifyKeywords("add a token counter to the parser").task_type).toBe("general");
    expect(classifyKeywords("fix the prod build script").task_type).toBe("general");
    expect(classifyKeywords("fix the author field").task_type).toBe("general");
    expect(classifyKeywords("rotate the oauth credentials").task_type).toBe("security");
    expect(classifyKeywords("token handling in prod").task_type).toBe("security");
    expect(classifyKeywords("rename a typo in README")).toMatchObject({ task_type: "general", recommended_tier: "standard", source: "keywords" });
    expect(classifyKeywords("anything")).not.toHaveProperty("confidence");
  });

  it("keyword scan marks security work high risk and premium", () => {
    const hit = classifyKeywords("rotate the oauth credentials");
    expect(hit).toMatchObject({ risk: "high", complexity: "high", recommended_tier: "premium", source: "keywords" });
    expect(isSecuritySensitive(hit)).toBe(true);
    expect(isSecuritySensitive(classifyKeywords("add a retry counter"))).toBe(false);
  });

  it("takes complexity and risk from the planner", () => {
    const rated = plannerClassification({ complexity: "low", risk: "low", securitySensitive: false, reason: "one-line config change" }, "Add a retry counter to the parser");
    expect(rated).toMatchObject({ task_type: "general", complexity: "low", risk: "low", recommended_tier: "cheap", source: "planner", required_capabilities: [] });
    expect(rated.reason_codes).toEqual(["planner", "reason: one-line config change"]);
    expect(plannerClassification({ complexity: "high", risk: "medium", securitySensitive: false }, "Rework the scheduler")).toMatchObject({ complexity: "high", recommended_tier: "premium" });
    expect(plannerClassification({ complexity: "medium", risk: "low", securitySensitive: true }, "Add a retry counter")).toMatchObject({ task_type: "security", risk: "high", recommended_tier: "premium", reason_codes: expect.arrayContaining(["planner_security_sensitive"]) });
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
    expect(rated).toMatchObject({ task_type: "general", risk: "low", recommended_tier: "standard" });
  });

  it("clips long text in the middle", () => {
    const clipped = clipMiddle("x".repeat(50_000), 8000);
    expect(clipped.length).toBeLessThan(8100);
    expect(clipped).toContain("truncated");
    expect(clipMiddle("short", 8000)).toBe("short");
  });
});
