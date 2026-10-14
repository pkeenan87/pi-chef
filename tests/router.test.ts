import { describe, expect, it } from "vitest";
import { testConfig } from "./helpers.js";
import { classifyTask, validateClassification } from "../src/router/classify.js";
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
      { security: { cheap: { success: 0, failure: 3 } } },
      { purpose: "implement" },
    );
    expect(open.circuitOpen).toBe(true);
  });
});
