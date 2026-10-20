import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layerConfigs, parseConfig } from "../src/config.js";
import { budgetStatusFor, buildCostRecord, summarize } from "../src/cost/ledger.js";
import { quotaLines, quotaUsage } from "../src/cost/quota.js";
import { modelMetricKey, type CostRecord } from "../src/domain.js";
import { decideRoute } from "../src/router/policy.js";
import { hardExclusion, sampleBeta, selectCandidate } from "../src/router/select.js";
import { reviewMetricType, type SuccessTable } from "../src/router/stats.js";
import { seededRng, tempRepo, tieredConfig, workflow } from "./helpers.js";

const at = new Date("2026-10-14T12:00:00.000Z");

/** Two standard candidates: A costs about twice B per call. */
/** Adaptive selection: these tests cover the cost-per-success ranking. Ordered selection has its own block below. */
function adaptive<T extends { routing: { selection: string } }>(config: T): T {
  config.routing.selection = "adaptive";
  return config;
}

function pair(extraTop = "", extraPricing = "") {
  return adaptive(parseConfig(`
providers:
  anthropic: { type: anthropic, auth: account-login }
  openai: { type: openai, auth: account-login }
${extraTop}
tiers:
  cheap: [ { provider: anthropic, model: a } ]
  premium: [ { provider: anthropic, model: a } ]
  standard:
    - { provider: anthropic, model: a }
    - { provider: openai, model: b }
workers: { tokenBudget: 8000 }
pricing:
  - { provider: anthropic, model: a, effectiveFrom: "2026-01-01", inputPerMillionUsd: 1, outputPerMillionUsd: 4 }
  - { provider: openai, model: b, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0.5, outputPerMillionUsd: 2 }
${extraPricing}`));
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

  it("returns blocked no_candidates for a tier with nothing usable, and never picks an empty model id", () => {
    const config = pair();
    config.tiers.cheap = [{ provider: "anthropic", model: "" }];
    const result = selectCandidate({ tier: "cheap", taskType: "general", config, table: {}, at });
    expect(result.blocked).toMatchObject({ code: "no_candidates", message: "No model configured for tier cheap; add tiers.cheap to your config." });
    const direct = hardExclusion({ config, table: {}, taskType: "general", tier: "cheap", candidate: { provider: "anthropic", model: "" }, price: 0, at });
    expect(direct).toBe("no model id");
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
    task_type: "general", complexity: "medium" as const, risk: "medium" as const, required_capabilities: [], reason_codes: [], source: "keywords" as const, ...overrides,
  });

  it("returns the chosen model, reason and considered list", () => {
    const decision = decideRoute(classification(), tieredConfig(), {}, { purpose: "implement", ticketTier: "cheap", at, rng: seededRng(5) });
    expect(decision.tier).toBe("cheap");
    expect(["gpt-6-luna", "claude-haiku-5-5"]).toContain(decision.model);
    expect(decision.candidate?.model).toBe(decision.model);
    expect(decision.considered).toHaveLength(2);
    expect(decision.selectionReason).toBeTruthy();
  });

  it("moves up a tier when every candidate is excluded by policy, and blocks when none remain", () => {
    const config = tieredConfig("orgProviderAllowlist: [anthropic]\n");
    // cheap still has anthropic haiku; premium keeps opus
    expect(decideRoute(classification(), config, {}, { purpose: "implement", ticketTier: "cheap", at }).provider).toBe("anthropic");
    const onlyOpenai = tieredConfig("orgProviderAllowlist: [openai]\n");
    const standard = decideRoute(classification(), onlyOpenai, {}, { purpose: "implement", ticketTier: "standard", at });
    // standard has no openai candidate, so the policy escalates to premium (sol)
    expect(standard.tier).toBe("premium");
    expect(standard.model).toBe("gpt-6.1-sol");
    expect(standard.reason).toContain("escalated_from_standard_excluded");
    const capped = tieredConfig("orgProviderAllowlist: [openai]\nrouting: { maxTier: standard }\n");
    const blocked = decideRoute(classification(), capped, {}, { purpose: "implement", ticketTier: "standard", at });
    expect(blocked.blocked).toMatch(/standard/);
    expect(blocked.provider).toBe("none");
  });
});

describe("review fixes", () => {
  const cls = { task_type: "general", complexity: "medium" as const, risk: "high" as const, required_capabilities: ["auth"], reason_codes: [], source: "keywords" as const };

  it("R3: an exhausted budget excludes unpriced candidates but keeps known-zero prices", () => {
    const config = pair("", "  - { provider: local, model: free, effectiveFrom: \"2026-01-01\", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }\n");
    config.providers.local = { type: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:1/v1", model: "free" };
    config.tiers.standard = [
      { provider: "openai", model: "unpriced-model" },
      { provider: "local", model: "free" },
    ];
    const spent = selectCandidate({ tier: "standard", taskType: "general", config, table: {}, at, rng: seededRng(1), budgetRemainingUsd: 0 });
    expect(spent.candidate?.model).toBe("free");
    expect(spent.considered.find((item) => item.model === "unpriced-model")?.excludedReason).toBe("over_budget");
    config.tiers.standard = [{ provider: "openai", model: "unpriced-model" }];
    expect(selectCandidate({ tier: "standard", taskType: "general", config, table: {}, at, budgetRemainingUsd: 0 }).blocked?.code).toBe("over_budget");
    // with money left an unpriced model stays eligible and is flagged
    const left = selectCandidate({ tier: "standard", taskType: "general", config, table: {}, at, budgetRemainingUsd: 5 });
    expect(left.candidate?.model).toBe("unpriced-model");
    expect(left.unpriced).toBe(true);
  });

  it("R9: probing other tiers does not consume the rng, so a seeded pick matches a direct selection", () => {
    const config = pair();
    for (let seed = 1; seed <= 25; seed++) {
      const direct = selectCandidate({ tier: "standard", taskType: "general", config, table: cells([3, 1], [2, 2]), at, rng: seededRng(seed) });
      const routed = decideRoute(cls, config, cells([3, 1], [2, 2]), { purpose: "implement", ticketTier: "standard", at, rng: seededRng(seed) });
      expect(routed.tier).toBe("standard");
      expect(routed.model).toBe(direct.candidate?.model);
    }
  });
});

/** Two $0 subscription candidates in the standard tier with quota shadow prices: a on anthropic, b on openai. */
function subscriptions(quota = "", tokenBudget = 8000) {
  return adaptive(parseConfig(`
providers:
  anthropic: { type: anthropic, auth: account-login }
  openai: { type: openai, auth: account-login }
tiers:
  cheap: [ { provider: anthropic, model: a } ]
  premium: [ { provider: anthropic, model: a } ]
  standard:
    - { provider: anthropic, model: a }
    - { provider: openai, model: b }
workers: { tokenBudget: ${tokenBudget} }
pricing:
  - { provider: anthropic, model: a, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: openai, model: b, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
${quota}`));
}

const weights = (a: number, b: number, extra = "") => `
quota:
  models:
    - { provider: anthropic, model: a, perMillionTokensUsd: ${a} }
    - { provider: openai, model: b, perMillionTokensUsd: ${b} }
${extra}`;

function ledgerRow(provider: string, model: string, when: string, tokens: number | null, actualUsd: number | null = 0): CostRecord {
  return {
    id: `${provider}-${when}`, at: when, taskId: "t", phase: "IMPLEMENTING", provider, model, tier: "standard", requests: 1,
    inputTokens: tokens, outputTokens: tokens === null ? null : 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    actualUsd, usageKnown: actualUsd !== null, outcome: "success", retries: 0, reason: "test",
  };
}

describe("subscription quota shadow prices", () => {
  it("without weights two $0 candidates split on sampled success alone", () => {
    const picks = { a: 0, b: 0 };
    for (let seed = 1; seed <= 200; seed++) picks[run(subscriptions(), cells([10, 10], [10, 10]), {}, seed).candidate!.model as "a" | "b"] += 1;
    expect(picks.a).toBeGreaterThan(60);
    expect(picks.b).toBeGreaterThan(60);
  });

  it("prefers the quota-cheap candidate when success odds are similar", () => {
    // a is the scarce model (10/M), b is quota-cheap (1/M); same history.
    const config = subscriptions(weights(10, 1));
    const picks = { a: 0, b: 0 };
    for (let seed = 1; seed <= 200; seed++) picks[run(config, cells([19, 1], [19, 1]), {}, seed).candidate!.model as "a" | "b"] += 1;
    expect(picks.b).toBeGreaterThan(195);
    const result = run(config, cells([19, 1], [19, 1]), {}, 3);
    expect(result.reason).toMatch(/\$0\.0080 quota/);
    // 8000 tokens at $1/M = $0.008 shadow; the real price stays 0.
    const b = result.considered.find((item) => item.model === "b")!;
    expect(b.quotaUsd).toBeCloseTo(0.008, 10);
    expect(b.score).toBeGreaterThan(0);
  });

  it("still pays for the scarce model when the cheap one keeps failing", () => {
    const config = subscriptions(weights(4, 1));
    // b fails almost always: a at 0.032 / ~0.95 per success beats b at 0.008 / ~0.05.
    const picks = { a: 0, b: 0 };
    for (let seed = 1; seed <= 200; seed++) picks[run(config, cells([38, 2], [1, 39]), {}, seed).candidate!.model as "a" | "b"] += 1;
    expect(picks.a).toBeGreaterThan(190);
  });

  it("never counts the shadow price against the budget", () => {
    // Shadow cost of a is 8000 * 10/M = $0.08, far above the remaining budget; its real price is 0.
    const result = run(subscriptions(weights(10, 10)), {}, { budgetRemainingUsd: 0.000001 });
    expect(result.candidate).toBeDefined();
    expect(result.considered.every((item) => item.excludedReason === undefined)).toBe(true);
    // and with nothing left a known-zero real price still passes, shadow or not
    expect(run(subscriptions(weights(10, 10)), {}, { budgetRemainingUsd: 0 }).blocked).toBeUndefined();
  });

  it("never reaches the ledger's actualUsd or budget status", () => {
    const config = subscriptions(weights(10, 10));
    const entry = buildCostRecord(
      { provider: "anthropic", model: "a", phase: "IMPLEMENTING", taskId: "t", tier: "standard", usage: { input: 900_000, output: 100_000, cacheRead: 0, cacheWrite: 0, requests: 1 }, outcome: "success", retries: 0, reason: "test" },
      config.pricing,
      at,
      "id-1",
    );
    expect(entry.actualUsd).toBe(0);
    const summary = summarize([entry], { pricing: config.pricing });
    expect(summary.knownUsd).toBe(0);
    expect(budgetStatusFor(summary, 0.01, 0.8)).toBe("ok");
  });

  it("raises a provider's shadow price once it is over a soft cap, which flips the choice", () => {
    // a is cheaper on quota (1 vs 2) until anthropic is over its daily cap: 1 x 4 = 4 > 2.
    const config = subscriptions(weights(1, 2, "  providers:\n    anthropic: { dailyTokens: 1000, weeklyTokens: 100000 }\n  overCapMultiplier: 4\n"));
    const table = cells([19, 1], [19, 1]);
    const under = quotaUsage([ledgerRow("anthropic", "a", "2026-10-14T08:00:00.000Z", 999)], config, at);
    expect(under.anthropic).toMatchObject({ dailyTokens: 999, overCap: false, multiplier: 1 });
    const over = quotaUsage([ledgerRow("anthropic", "a", "2026-10-14T08:00:00.000Z", 1000)], config, at);
    expect(over.anthropic).toMatchObject({ dailyTokens: 1000, overCap: true, multiplier: 4 });
    const picks = (quota: typeof under) => {
      const out = { a: 0, b: 0 };
      for (let seed = 1; seed <= 100; seed++) out[run(config, table, { quota }, seed).candidate!.model as "a" | "b"] += 1;
      return out;
    };
    expect(picks(under).a).toBeGreaterThan(90);
    expect(picks(over).b).toBeGreaterThan(90);
    const flipped = run(config, table, { quota: over }, 4);
    expect(flipped.considered.find((item) => item.model === "a")?.quotaUsd).toBeCloseTo(0.032, 10);
    // the over-cap provider's model is flagged when it still wins
    const lone = selectCandidate({ tier: "cheap", taskType: "general", config, table: {}, at, quota: over, rng: seededRng(1) });
    expect(lone.candidate?.model).toBe("a");
    expect(lone.reason).toMatch(/anthropic over quota cap/);
  });

  it("counts tokens per provider for the budget day and the rolling week", () => {
    const config = subscriptions(weights(1, 1, "  providers:\n    openai: { weeklyTokens: 500 }\n"));
    const records = [
      ledgerRow("anthropic", "a", "2026-10-14T01:00:00.000Z", 100),
      ledgerRow("anthropic", "a", "2026-10-13T23:00:00.000Z", 40), // yesterday: weekly only
      ledgerRow("anthropic", "a", "2026-10-06T11:00:00.000Z", 1000), // more than 7 days ago
      ledgerRow("anthropic", "a", "2026-10-14T13:00:00.000Z", 7), // after `at`
      ledgerRow("anthropic", "a", "2026-10-14T02:00:00.000Z", null, null), // unknown tokens add nothing
      ledgerRow("openai", "b", "2026-10-10T00:00:00.000Z", 600),
      ledgerRow("foundry", "grok", "2026-10-14T01:00:00.000Z", 5000), // not a quota provider
    ];
    const usage = quotaUsage(records, config, at);
    expect(Object.keys(usage).sort()).toEqual(["anthropic", "openai"]);
    expect(usage.anthropic).toMatchObject({ dailyTokens: 100, weeklyTokens: 140, overCap: false });
    expect(usage.openai).toMatchObject({ dailyTokens: 0, weeklyTokens: 600, weeklyCap: 500, overCap: true, multiplier: 4 });
    const lines = quotaLines(usage);
    expect(lines[0]).toBe("anthropic: 100 tokens today, 140 this week");
    expect(lines[1]).toBe("openai: 0 tokens today, 600 this week / 500 cap (over cap: shadow prices x4)");
    expect(quotaUsage(records, subscriptions(), at)).toEqual({});
  });

  it("sends work to the quota-cheap tier member", () => {
    const yaml = `
quota:
  models:
    - { provider: openai, model: gpt-6-luna, perMillionTokensUsd: 0.4 }
    - { provider: anthropic, model: claude-haiku-5-5, perMillionTokensUsd: 1 }
`;
    const config = tieredConfig(yaml);
    const easy = { task_type: "general", complexity: "low" as const, risk: "low" as const, required_capabilities: [], reason_codes: [], source: "keywords" as const };
    const proven = { general: { [modelMetricKey("cheap", "openai", "gpt-6-luna")]: { success: 19, failure: 1 }, [modelMetricKey("cheap", "anthropic", "claude-haiku-5-5")]: { success: 19, failure: 1 } } };
    let luna = 0;
    for (let seed = 1; seed <= 100; seed++) if (decideRoute(easy, config, proven, { purpose: "implement", ticketTier: "cheap", at, rng: seededRng(seed) }).model === "gpt-6-luna") luna += 1;
    expect(luna).toBeGreaterThan(80);
  });

  it("validates the quota block", () => {
    expect(() => subscriptions(weights(-1, 1))).toThrow(/perMillionTokensUsd/);
    expect(() => subscriptions("quota:\n  models:\n    - { provider: openai, model: b }\n")).toThrow(/perMillionTokensUsd/);
    expect(() => subscriptions(weights(1, 1, "  providers:\n    nobody: { dailyTokens: 5 }\n"))).toThrow(/known provider/);
    expect(() => subscriptions(weights(1, 1, "  providers:\n    openai: { dailyTokens: 0 }\n"))).toThrow(/dailyTokens/);
    expect(() => subscriptions(weights(1, 1, "  overCapMultiplier: 0.5\n"))).toThrow(/overCapMultiplier/);
    expect(subscriptions().quota).toEqual({ models: [], providers: {}, overCapMultiplier: 4 });
  });

  it("layers project quota over the user's by model and by provider", () => {
    const merged = layerConfigs(
      { quota: { models: [{ provider: "openai", model: "b", perMillionTokensUsd: 1 }, { provider: "anthropic", model: "a", perMillionTokensUsd: 9 }], providers: { anthropic: { dailyTokens: 10, weeklyTokens: 50 } }, overCapMultiplier: 3 } },
      { quota: { models: [{ provider: "anthropic", model: "a", perMillionTokensUsd: 5 }], providers: { anthropic: { dailyTokens: 20 } } } },
    );
    expect(merged.quota).toEqual({
      models: [{ provider: "openai", model: "b", perMillionTokensUsd: 1 }, { provider: "anthropic", model: "a", perMillionTokensUsd: 5 }],
      providers: { anthropic: { dailyTokens: 20, weeklyTokens: 50 } },
      overCapMultiplier: 3,
    });
  });

  it("/cost shows quota use per provider, apart from billed spend", async () => {
    const config = tieredConfig("quota:\n  models:\n    - { provider: anthropic, model: claude-opus-5-5, perMillionTokensUsd: 10 }\n  providers:\n    anthropic: { dailyTokens: 1000 }\n");
    config.pricing = config.pricing.map((row) => (row.provider === "anthropic" ? { ...row, inputPerMillionUsd: 0, outputPerMillionUsd: 0 } : row));
    const app = workflow(await tempRepo(), { config });
    app.store.appendLedger(ledgerRow("anthropic", "claude-opus-5-5", app.now().toISOString(), 1500));
    const report = await app.cost();
    expect(report.text).toContain("Known spend $0.0000");
    expect(report.text).toContain("Subscription quota (ranks models; never billed or budgeted)");
    expect(report.text).toContain("- anthropic: 1,500 tokens today / 1,000 cap, 1,500 this week (over cap: shadow prices x4)");
    // The JSON export is a file in the workspace's reports folder.
    const { file } = (await app.cost("json")).data as { file: string };
    const json = JSON.parse(readFileSync(file, "utf8")) as { quota: Record<string, { dailyTokens: number; overCap: boolean }> };
    expect(json.quota.anthropic).toMatchObject({ dailyTokens: 1500, overCap: true });
  });
});

describe("per-attempt overhead (ranking only)", () => {
  /** a is a $0 subscription model; b costs real money. */
  function freeVersusPriced(overhead?: number) {
    const config = subscriptions();
    const b = config.pricing.find((row) => row.model === "b")!;
    b.inputPerMillionUsd = 1;
    b.outputPerMillionUsd = 4;
    if (overhead !== undefined) config.routing.attemptOverheadUsd = overhead;
    return config;
  }

  it("defaults to 0.02 and rejects a negative value", () => {
    expect(subscriptions().routing.attemptOverheadUsd).toBe(0.02);
    expect(() => parseConfig("routing: { attemptOverheadUsd: -1 }")).toThrow(/attemptOverheadUsd/);
  });

  it("a $0 model with a poor record loses to a priced model with a good record", () => {
    const table = cells([2, 38], [38, 2]);
    for (let seed = 1; seed <= 50; seed++) expect(run(freeVersusPriced(), table, {}, seed).candidate?.model).toBe("b");
    // Without the overhead the $0 model would win every time, which is the bug.
    for (let seed = 1; seed <= 50; seed++) expect(run(freeVersusPriced(0), table, {}, seed).candidate?.model).toBe("a");
  });

  it("keeps the old ordering when records are equal", () => {
    // A constant rng gives both candidates the same sampled p, so only price decides, with or without the overhead.
    const table = cells([19, 1], [19, 1]);
    const flat = { rng: () => 0.5 };
    for (const [onConfig, offConfig] of [[freeVersusPriced(), freeVersusPriced(0)], [pair(), pair("routing: { attemptOverheadUsd: 0 }\n")]] as const) {
      const on = run(onConfig, table, flat);
      expect(on.candidate?.model).toBe(run(offConfig, table, flat).candidate?.model);
    }
    expect(run(pair(), table, flat).candidate?.model).toBe("b");
    expect(run(freeVersusPriced(), table, flat).candidate?.model).toBe("a");
  });

  it("names the overhead in the reason", () => {
    const result = run(freeVersusPriced(), cells([19, 1], [1, 19]), {}, 3);
    expect(result.reason).toMatch(/incl\. \$0\.0200 overhead, sampled p=/);
  });

  it("never reaches the ledger, the budget, or the over-budget filter", () => {
    const config = freeVersusPriced(5);
    // The over-budget filter looks at the real price only: a $0 model passes with nothing left.
    expect(run(config, {}, { budgetRemainingUsd: 0 }).considered.find((item) => item.model === "a")?.excludedReason).toBeUndefined();
    const entry = buildCostRecord(
      { provider: "anthropic", model: "a", phase: "IMPLEMENTING", taskId: "t", tier: "standard", usage: { input: 900_000, output: 100_000, cacheRead: 0, cacheWrite: 0, requests: 1 }, outcome: "success", retries: 0, reason: "test" },
      config.pricing,
      at,
      "id-1",
    );
    expect(entry.actualUsd).toBe(0);
    const summary = summarize([entry], { pricing: config.pricing });
    expect(summary.knownUsd).toBe(0);
    expect(budgetStatusFor(summary, 0.01, 0.8)).toBe("ok");
  });
});

describe("review outcomes are keyed apart from implementation", () => {
  it("a failing review record does not change implement selection", () => {
    const classification = { task_type: "general", complexity: "medium" as const, risk: "medium" as const, required_capabilities: [], reason_codes: [], source: "keywords" as const };
    const key = modelMetricKey("standard", "anthropic", "a");
    const implement: SuccessTable = { general: { [key]: { success: 19, failure: 1 } } };
    const withReviewFailures: SuccessTable = { ...implement, [reviewMetricType("general")]: { [key]: { success: 0, failure: 30 } } };
    const config = pair();
    config.routing.reviewTier = "standard";
    for (let seed = 1; seed <= 30; seed++) {
      const a = decideRoute(classification, config, implement, { purpose: "implement", ticketTier: "ticketMedium", at, rng: seededRng(seed) });
      const b = decideRoute(classification, config, withReviewFailures, { purpose: "implement", ticketTier: "ticketMedium", at, rng: seededRng(seed) });
      expect(b.model).toBe(a.model);
      expect(b.reason).toEqual(a.reason);
    }
    // Review picks read the review record: a's 30 review failures open its circuit there.
    const review = decideRoute(classification, config, withReviewFailures, { purpose: "review", at, rng: seededRng(1) });
    expect(review.model).toBe("b");
  });
});

describe("ordered selection (the default)", () => {
  const ordered = () => {
    const config = pair();
    config.routing.selection = "ordered";
    return config;
  };
  it("is the default", () => {
    expect(parseConfig("branchPrefix: chef").routing.selection).toBe("ordered");
    expect(() => parseConfig("routing: { selection: random }")).toThrow(/routing.selection/);
  });
  it("takes the first usable candidate in the tier's order, whatever the price or the record", () => {
    // b is cheaper and has the better record; ordered still picks a, the first entry.
    for (const seed of [1, 2, 3, 4, 5]) {
      const picked = run(ordered(), cells([1, 5], [9, 0]), {}, seed);
      expect(picked.candidate?.model).toBe("a");
      expect(picked.reason).toContain("first in the tier's order");
    }
  });
  it("falls back to the next entry and says why", () => {
    const picked = run(ordered(), {}, { availability: { anthropic: { ok: false, detail: "not signed in" } }, strictAvailability: true });
    expect(picked.candidate?.model).toBe("b");
    expect(picked.reason).toMatch(/fallback 1 in the tier's order \(anthropic\/a not signed in\)/);
  });
});
