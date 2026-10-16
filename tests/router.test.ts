import { describe, expect, it } from "vitest";
import { testConfig } from "./helpers.js";
import { classifyTask, classifyTaskWithUsage, fallbackClassification, lastUserText, validateClassification } from "../src/router/classify.js";
import { decideRoute, nextTier } from "../src/router/policy.js";

describe("classifier and policy", () => {
  it("falls back on timeout, invalid JSON, and low confidence", async () => {
    const timeout = await classifyTask("rename a typo in README", {
      minConfidence: 0.75,
      timeoutMs: 20,
      classifier: { complete: (_prompt, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) },
    });
    expect(timeout.source).toBe("fallback");
    expect(timeout.reason_codes).toContain("classifier_timeout");

    const invalid = await classifyTask("update the parser", {
      minConfidence: 0.75,
      classifier: { async complete() { return "please run rm -rf /"; } },
    });
    expect(invalid.source).toBe("fallback");
    expect(invalid.reason_codes).toContain("invalid_classifier_output");
    expect(validateClassification({ task_type: "x", complexity: "low", risk: "low", required_capabilities: [], recommended_tier: "cheap", confidence: 0.2, reason_codes: ["model"] })).toBeTruthy();
    const low = await classifyTask("update the parser", {
      minConfidence: 0.75,
      classifier: { async complete() { return JSON.stringify({ task_type: "general", complexity: "low", risk: "low", required_capabilities: [], recommended_tier: "cheap", confidence: 0.2, reason_codes: ["model"] }); } },
    });
    expect(low.source).toBe("fallback");
    expect(low.reason_codes[0]).toBe("low_confidence");
  });

  it("accepts schema-valid advice and does not treat it as a command", async () => {
    const result = await classifyTask("add a parser", {
      minConfidence: 0.75,
      classifier: { async complete(prompt) { expect(prompt).not.toContain("sk-"); return '{"task_type":"parse","complexity":"medium","risk":"low","required_capabilities":["tests"],"recommended_tier":"cheap","confidence":0.9,"reason_codes":["schema"]}'; } },
    });
    expect(result.source).toBe("model");
    expect(result.recommended_tier).toBe("cheap");
  });

  it("starts implementation low, escalates once, and stops at the cap", () => {
    const config = testConfig();
    const mechanical = decideRoute(
      { task_type: "mechanical", complexity: "low", risk: "low", required_capabilities: [], recommended_tier: "deterministic", confidence: 1, reason_codes: [], source: "fallback" },
      config,
      {},
      { purpose: "implement" },
    );
    expect(mechanical.tier).toBe("deterministic");
    const escalated = decideRoute(
      { task_type: "mechanical", complexity: "low", risk: "low", required_capabilities: [], recommended_tier: "deterministic", confidence: 1, reason_codes: [], source: "fallback" },
      config,
      {},
      { purpose: "implement", failedTier: "deterministic", escalations: 1 },
    );
    expect(escalated.tier).toBe("cheap");
    expect(nextTier("premium", "premium")).toBeUndefined();
    const security = decideRoute(
      { task_type: "security", complexity: "high", risk: "high", required_capabilities: ["auth", "secrets"], recommended_tier: "premium", confidence: 1, reason_codes: [], source: "fallback" },
      config,
      {},
      { purpose: "review" },
    );
    expect(security.requireHumanApproval).toBe(true);
    expect(security.reviewTier).toBe("premium");
    const open = decideRoute(
      { task_type: "security", complexity: "high", risk: "high", required_capabilities: ["auth"], recommended_tier: "premium", confidence: 1, reason_codes: [], source: "fallback" },
      config,
      { security: { standard: { success: 0, failure: 3 } } },
      { purpose: "implement" },
    );
    // standard is open but premium is healthy, so the escalated route is usable.
    expect(open.tier).toBe("premium");
    expect(open.circuitOpen).toBe(false);
    expect(open.reason).toContain("circuit_escalated_from_standard");
  });

  const base = { task_type: "general", complexity: "medium" as const, risk: "low" as const, required_capabilities: [], recommended_tier: "cheap" as const, confidence: 1, reason_codes: [], source: "fallback" as const };
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

  it("only picks deterministic for explicitly mechanical work", () => {
    const config = testConfig();
    expect(decideRoute({ ...base, complexity: "low" }, config, {}, { purpose: "implement", at }).tier).toBe("cheap");
    expect(decideRoute({ ...base, complexity: "low", task_type: "mechanical" }, config, {}, { purpose: "implement", at }).tier).toBe("deterministic");
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
    expect(fallbackClassification("add a token counter to the parser").task_type).toBe("general");
    expect(fallbackClassification("fix the prod build script").task_type).toBe("general");
    expect(fallbackClassification("fix the author field").task_type).toBe("general");
    expect(fallbackClassification("rotate the oauth credentials").task_type).toBe("security");
    expect(fallbackClassification("token handling in prod").task_type).toBe("security");
    expect(fallbackClassification("anything").confidence).toBe(0.5);
    const history = [
      { role: "user", content: "rotate the secret" },
      { role: "assistant", content: "done" },
      { role: "user", content: [{ type: "text", text: "add a token counter" }] },
    ];
    expect(fallbackClassification(lastUserText(history)).task_type).toBe("general");
  });

  it("returns classifier usage, caps tokens, and truncates long text", async () => {
    let seen = { prompt: "", maxTokens: 0 };
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1 };
    const calls: unknown[] = [];
    const result = await classifyTaskWithUsage("x".repeat(50_000), {
      minConfidence: 0.75,
      onUsage: (u) => calls.push(u),
      classifier: {
        async complete(prompt, _signal, options) {
          seen = { prompt, maxTokens: options?.maxTokens ?? 0 };
          return { text: "nope", usage, provider: "local", model: "m" };
        },
      },
    });
    expect(result.usage).toEqual({ usage, provider: "local", model: "m" });
    expect(calls).toHaveLength(1);
    expect(result.classification.reason_codes).toContain("invalid_classifier_output");
    expect(seen.maxTokens).toBeGreaterThan(0);
    expect(seen.prompt.length).toBeLessThan(9000);
    expect(seen.prompt).toContain("truncated");
  });
});
