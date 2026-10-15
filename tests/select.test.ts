import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { modelMetricKey } from "../src/domain.js";
import { classificationFromAnswers, validateClassification } from "../src/router/classify.js";
import { decideRoute } from "../src/router/policy.js";
import { sampleBeta, selectCandidate } from "../src/router/select.js";
import type { SuccessTable } from "../src/router/stats.js";
import { seededRng, tieredConfig } from "./helpers.js";

const at = new Date("2026-10-14T12:00:00.000Z");

/** Two standard candidates: A costs about twice B per call. */
function pair(extraTop = "", extraPricing = "") {
  return parseConfig(`
providers:
  anthropic: { type: anthropic, auth: account-login }
  openai: { type: openai, auth: account-login }
${extraTop}
tiers:
  classifier: [ { provider: anthropic, model: a } ]
  cheap: [ { provider: anthropic, model: a } ]
  premium: [ { provider: anthropic, model: a } ]
  standard:
    - { provider: anthropic, model: a }
    - { provider: openai, model: b }
workers: { tokenBudget: 8000 }
pricing:
  - { provider: anthropic, model: a, effectiveFrom: "2026-01-01", inputPerMillionUsd: 1, outputPerMillionUsd: 4 }
  - { provider: openai, model: b, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0.5, outputPerMillionUsd: 2 }
${extraPricing}`);
}

function cells(a: [number, number], b: [number, number]): SuccessTable {
  return {
    general: {
      [modelMetricKey("standard", "anthropic", "a")]: { success: a[0], failure: a[1] },
      [modelMetricKey("standard", "openai", "b")]: { success: b[0], failure: b[1] },
    },
  };
}

const run = (config = pair(), table: SuccessTable = {}, extra: Partial<Parameters<typeof selectCandidate>[0]> = {}, seed = 1) =>
  selectCandidate({ tier: "standard", taskType: "general", config, table, at, rng: seededRng(seed), ...extra });

describe("selector filters", () => {
  it("excludes by org allowlist and reports why", () => {
    const config = pair("orgProviderAllowlist: [anthropic]\n");
    const result = run(config);
    expect(result.candidate?.model).toBe("a");
    expect(result.considered.find((item) => item.model === "b")?.excludedReason).toBe("org_allowlist");
  });

  it("applies the proprietary-code policy when no allowlist is set", () => {
    const config = pair();
    config.proprietaryCode = true;
    const result = run(config);
    expect(result.candidate).toBeUndefined();
    expect(result.blocked?.code).toBe("excluded");
    expect(result.considered.every((item) => item.excludedReason === "proprietary_code_policy")).toBe(true);
  });

  it("prefers a ready provider, and falls back to all when none is ready (so the auth gate speaks)", () => {
    const someReady = run(pair(), {}, { availability: { anthropic: { ok: false, detail: "expired" }, openai: { ok: true } } });
    expect(someReady.candidate?.model).toBe("b");
    expect(someReady.considered.find((item) => item.model === "a")?.excludedReason).toMatch(/expired/);
    const none = run(pair(), {}, { availability: { anthropic: { ok: false }, openai: { ok: false } } });
    expect(none.candidate).toBeDefined();
    expect(none.reason).toMatch(/no provider reported ready/);
    const strict = run(pair(), {}, { availability: { anthropic: { ok: false }, openai: { ok: false } }, strictAvailability: true });
    expect(strict.candidate).toBeUndefined();
    expect(strict.blocked?.code).toBe("unavailable");
  });

  it("skips a candidate whose own circuit is open, and blocks with circuit_open when all are open", () => {
    const failures = { success: 0, failure: 3, recent: [0, 1, 2].map((i) => ({ at: new Date(at.getTime() - i * 1000).toISOString(), ok: false })) };
    const one = run(pair(), { general: { [modelMetricKey("standard", "openai", "b")]: failures } });
    expect(one.candidate?.model).toBe("a");
    expect(one.considered.find((item) => item.model === "b")?.excludedReason).toBe("circuit_open");
    const both = run(pair(), { general: { [modelMetricKey("standard", "openai", "b")]: failures, [modelMetricKey("standard", "anthropic", "a")]: failures } });
    expect(both.blocked?.code).toBe("circuit_open");
  });

  it("excludes candidates whose expected cost exceeds the remaining budget", () => {
    const cost = 6400 * 1e-6 + 1600 * 4e-6; // candidate a: 0.0128
    const result = run(pair(), {}, { budgetRemainingUsd: cost - 0.001 });
    expect(result.candidate?.model).toBe("b");
    expect(result.considered.find((item) => item.model === "a")?.excludedReason).toBe("over_budget");
    const none = run(pair(), {}, { budgetRemainingUsd: 0.0001 });
    expect(none.blocked?.code).toBe("over_budget");
  });
});

describe("selector ranking", () => {
  it("Thompson sampling prefers the cheaper candidate per success, not the cheaper per call", () => {
    // B is half the price per call but nearly always fails; A is reliable.
    const table = cells([19, 1], [1, 19]);
    const picks = { a: 0, b: 0 };
    for (let seed = 1; seed <= 200; seed++) picks[run(pair(), table, {}, seed).candidate!.model as "a" | "b"] += 1;
    expect(picks.a).toBeGreaterThan(190);
    // and the reverse: with B reliable and A failing, B wins.
    const flipped = cells([1, 19], [19, 1]);
    expect(run(pair(), flipped, {}, 7).candidate?.model).toBe("b");
  });

  it("is deterministic for a given seed", () => {
    const a = run(pair(), {}, {}, 42);
    const b = run(pair(), {}, {}, 42);
    expect(a.candidate).toEqual(b.candidate);
    expect(a.considered).toEqual(b.considered);
  });

  it("explores: with no history both candidates get chosen across seeds", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) seen.add(run(pair(), {}, {}, seed).candidate!.model);
    expect(seen).toEqual(new Set(["a", "b"]));
  });

  it("ranks an unpriced candidate after priced ones and flags it", () => {
    const config = pair("", "");
    config.pricing = config.pricing.filter((row) => row.model !== "b");
    // even a perfect record for unpriced B does not beat priced A
    const result = run(config, cells([1, 5], [50, 0]));
    expect(result.candidate?.model).toBe("a");
    expect(result.unpriced).toBe(false);
    expect(result.considered.find((item) => item.model === "b")?.priced).toBe(false);
    // when it is the only one left, it is chosen and flagged
    const only = run(config, {}, { availability: { anthropic: { ok: false }, openai: { ok: true } } });
    expect(only.candidate?.model).toBe("b");
    expect(only.unpriced).toBe(true);
    expect(only.reason).toMatch(/price unknown/);
  });

  it("breaks exact ties by config order", () => {
    const config = pair();
    config.pricing = config.pricing.map((row) => ({ ...row, inputPerMillionUsd: 0, outputPerMillionUsd: 0 }));
    // a constant rng gives both candidates the same sampled p
    for (const value of [0.2, 0.5, 0.9]) {
      expect(selectCandidate({ tier: "standard", taskType: "general", config, table: {}, at, rng: () => value }).candidate?.model).toBe("a");
    }
  });

  it("returns blocked no_candidates for a tier with nothing configured", () => {
    const result = selectCandidate({ tier: "advisor", taskType: "general", config: pair(), table: {}, at });
    expect(result.blocked?.code).toBe("no_candidates");
  });

  it("sampleBeta stays in (0, 1) and tracks the mean", () => {
    const rng = seededRng(3);
    const draws = Array.from({ length: 400 }, () => sampleBeta(8, 2, rng));
    expect(draws.every((value) => value > 0 && value < 1)).toBe(true);
    expect(draws.reduce((sum, value) => sum + value, 0) / draws.length).toBeGreaterThan(0.7);
  });
});

describe("decideRoute integration", () => {
  const classification = (overrides = {}) => ({
    task_type: "general", complexity: "medium" as const, risk: "medium" as const, required_capabilities: [], recommended_tier: "cheap" as const, confidence: 1, reason_codes: [], source: "fallback" as const, ...overrides,
  });

  it("returns the chosen model, reason and considered list", () => {
    const decision = decideRoute(classification(), tieredConfig(), {}, { purpose: "implement", at, rng: seededRng(5) });
    expect(decision.tier).toBe("cheap");
    expect(["gpt-6-luna", "claude-haiku-5-5"]).toContain(decision.model);
    expect(decision.candidate?.model).toBe(decision.model);
    expect(decision.considered).toHaveLength(2);
    expect(decision.selectionReason).toBeTruthy();
  });

  it("moves up a tier when every candidate is excluded by policy, and blocks when none remain", () => {
    const config = tieredConfig("orgProviderAllowlist: [anthropic]\n");
    // cheap still has anthropic haiku; premium keeps opus
    expect(decideRoute(classification(), config, {}, { purpose: "implement", at }).provider).toBe("anthropic");
    const onlyOpenai = tieredConfig("orgProviderAllowlist: [openai]\n");
    const standard = decideRoute(classification({ recommended_tier: "standard" }), onlyOpenai, {}, { purpose: "preview", at });
    // standard has no openai candidate, so the policy escalates to premium (sol)
    expect(standard.tier).toBe("premium");
    expect(standard.model).toBe("gpt-6.1-sol");
    expect(standard.reason).toContain("escalated_from_standard_excluded");
    const capped = tieredConfig("orgProviderAllowlist: [openai]\nrouting: { maxTier: standard }\n");
    const blocked = decideRoute(classification({ recommended_tier: "standard" }), capped, {}, { purpose: "preview", at });
    expect(blocked.blocked).toMatch(/standard/);
    expect(blocked.provider).toBe("none");
  });
});

describe("review fixes", () => {
  const cls = { task_type: "general", complexity: "medium" as const, risk: "high" as const, required_capabilities: ["auth"], recommended_tier: "standard" as const, confidence: 1, reason_codes: [], source: "fallback" as const };

  it("R3: an exhausted budget excludes unpriced candidates but keeps known-zero prices", () => {
    const config = pair("", "  - { provider: local, model: free, effectiveFrom: \"2026-01-01\", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }\n");
    config.providers.local = { type: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:1/v1", model: "free" };
    config.tiers.standard = [
      { provider: "openai", model: "unpriced-model", api: "chat" },
      { provider: "local", model: "free", api: "chat" },
    ];
    const spent = selectCandidate({ tier: "standard", taskType: "general", config, table: {}, at, rng: seededRng(1), budgetRemainingUsd: 0 });
    expect(spent.candidate?.model).toBe("free");
    expect(spent.considered.find((item) => item.model === "unpriced-model")?.excludedReason).toBe("over_budget");
    config.tiers.standard = [{ provider: "openai", model: "unpriced-model", api: "chat" }];
    expect(selectCandidate({ tier: "standard", taskType: "general", config, table: {}, at, budgetRemainingUsd: 0 }).blocked?.code).toBe("over_budget");
    // with money left an unpriced model stays eligible and is flagged
    const left = selectCandidate({ tier: "standard", taskType: "general", config, table: {}, at, budgetRemainingUsd: 5 });
    expect(left.candidate?.model).toBe("unpriced-model");
    expect(left.unpriced).toBe(true);
  });

  it("R7: a decisions-only candidate is never chosen for a chat purpose", () => {
    const config = tieredConfig();
    const chat = selectCandidate({ tier: "classifier", taskType: "general", config, table: {}, at });
    expect(chat.candidate).toBeUndefined();
    expect(chat.considered.every((item) => item.excludedReason?.startsWith("api_decisions_not_chat"))).toBe(true);
    expect(selectCandidate({ tier: "classifier", taskType: "general", config, table: {}, at, api: "decisions" }).candidate?.api).toBe("decisions");
  });

  it("R7: a recommended_tier of classifier is mapped to cheap", () => {
    const parsed = validateClassification({ task_type: "general", complexity: "low", risk: "low", required_capabilities: [], recommended_tier: "classifier", confidence: 0.9, reason_codes: [] });
    expect(parsed?.recommended_tier).toBe("cheap");
    const fromAnswers = classificationFromAnswers([
      { type: "choice", name: "task_type", choice: "docs", confidence: 0.9 },
      { type: "choice", name: "complexity", choice: "low", confidence: 0.9 },
      { type: "choice", name: "risk", choice: "low", confidence: 0.9 },
      { type: "choice", name: "recommended_tier", choice: "classifier", confidence: 0.9 },
    ]);
    expect(fromAnswers?.recommended_tier).toBe("cheap");
  });

  it("R9: probing other tiers does not consume the rng, so a seeded pick matches a direct selection", () => {
    const config = pair();
    for (let seed = 1; seed <= 25; seed++) {
      const direct = selectCandidate({ tier: "standard", taskType: "general", config, table: cells([3, 1], [2, 2]), at, rng: seededRng(seed) });
      const routed = decideRoute(cls, config, cells([3, 1], [2, 2]), { purpose: "implement", at, rng: seededRng(seed) });
      expect(routed.tier).toBe("standard");
      expect(routed.model).toBe(direct.candidate?.model);
    }
  });
});
