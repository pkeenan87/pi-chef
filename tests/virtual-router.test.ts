import { describe, expect, it, vi } from "vitest";
import type { AcceptedClassification, Tier } from "../src/domain.js";
import { INTERVIEW_RULES, NO_QUESTIONS_RULES, REVISION_RULES, TICKET_RULES } from "../src/orchestrator/prompts.js";
import { BUILD_CHUNK_RULES } from "../src/orchestrator/build.js";
import { fallbackClassification } from "../src/router/classify.js";
import { routeVirtual, type ModelLike, type RouterRequest, type RouterSnapshot, type VirtualDeps } from "../src/router/virtual.js";
import { seededRng, tieredConfig } from "./helpers.js";

interface FakeModel extends ModelLike {
  contextWindow: number;
}

const WINDOWS: Record<string, number> = { "grok-4-7": 100_000, "claude-sonnet-5-5": 200_000, "claude-opus-5-5": 1_000_000, "gpt-6.1-sol": 400_000 };
const model = (provider: string, id: string): FakeModel => ({ provider, id, contextWindow: WINDOWS[id] ?? 128_000 });

function classification(tier: Tier, extra: Partial<AcceptedClassification> = {}): AcceptedClassification {
  return { task_type: "feature", complexity: "medium", risk: "medium", required_capabilities: [], recommended_tier: tier, confidence: 0.9, reason_codes: [], source: "model", ...extra };
}

function setup(options: { tier?: Tier; extra?: Partial<AcceptedClassification>; missing?: string[]; budget?: RouterSnapshot["budget"]; table?: RouterSnapshot["table"] } = {}) {
  const config = tieredConfig();
  const missing = new Set(options.missing ?? []);
  const registry = {
    find: (provider: string, id: string) => model(provider, id),
    getAvailable: () => [] as FakeModel[],
    isUsingOAuth: () => true,
  };
  registry.getAvailable = () => config_models().filter((item) => !missing.has(item.id));
  function config_models(): FakeModel[] {
    return Object.keys(WINDOWS).concat(["gpt-6-luna", "claude-haiku-5-5"]).map((id) => {
      const provider = id.startsWith("gpt") ? "openai" : id.startsWith("claude") ? "anthropic" : "foundry";
      return model(provider, id);
    });
  }
  const classify = vi.fn(async () => classification(options.tier ?? "standard", options.extra));
  const recordFailure = vi.fn();
  const onRoute = vi.fn();
  const snapshot: RouterSnapshot = { config, table: options.table ?? {}, budget: options.budget ?? "ok" };
  const deps: VirtualDeps<FakeModel> = {
    registry,
    snapshot: async () => snapshot,
    classify,
    now: () => new Date("2026-03-01T00:00:00Z"),
    rng: () => 0.5,
    recordFailure,
    onRoute,
  };
  const request = (extra: Partial<RouterRequest<FakeModel>> = {}): RouterRequest<FakeModel> => ({
    reason: "user",
    thinkingLevel: "medium",
    messages: [{ role: "user", content: "add a retry counter" }],
    ...extra,
  });
  return { deps, classify, recordFailure, onRoute, request, snapshot };
}

const edited = [
  { role: "user", content: "do it" },
  { role: "assistant", content: [] },
  { role: "toolResult", toolName: "edit", isError: false, content: [] },
];

describe("routeVirtual", () => {
  it("classifies once on the first user turn and stores state", async () => {
    const t = setup();
    const result = await routeVirtual(t.request(), t.deps);
    expect(t.classify).toHaveBeenCalledTimes(1);
    expect(result.model).toMatchObject({ provider: "foundry", id: "grok-4-7" });
    expect(result.thinkingLevel).toBe("medium");
    expect(result.state).toMatchObject({ v: 1, tier: "standard", provider: "foundry", model: "grok-4-7", switches: 0 });
    expect(result.state!.classification).toMatchObject({ taskType: "feature", securitySensitive: false, source: "model" });
    expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
    expect(t.onRoute).toHaveBeenCalledTimes(1);
  });

  it("keeps a model the session already uses when it is a candidate of the chosen tier", async () => {
    const t = setup();
    const sonnet = model("anthropic", "claude-sonnet-5-5");
    const result = await routeVirtual(t.request({ previous: { model: sonnet } }), t.deps);
    expect(result.model).toMatchObject({ id: "claude-sonnet-5-5" });
  });

  it("does not reclassify a second user turn and returns the same state object", async () => {
    const t = setup();
    const first = await routeVirtual(t.request(), t.deps);
    const second = await routeVirtual(t.request({ state: first.state }), t.deps);
    expect(t.classify).toHaveBeenCalledTimes(1);
    expect(second.model).toMatchObject({ id: "grok-4-7" });
    expect(second.state).toBe(first.state);
  });

  it("returns the previous model for a continuation and does not need a snapshot", async () => {
    const t = setup();
    const snapshot = vi.fn(t.deps.snapshot);
    const previous = model("anthropic", "claude-opus-5-5");
    const result = await routeVirtual(t.request({ reason: "continuation", previous: { model: previous } }), { ...t.deps, snapshot });
    expect(result.model).toBe(previous);
    expect(result.state).toBeUndefined();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("reclassifies a long message and escalates, never downgrades", async () => {
    const t = setup({ tier: "cheap" });
    const first = await routeVirtual(t.request(), t.deps);
    expect(first.state!.tier).toBe("cheap");
    t.classify.mockResolvedValueOnce(classification("premium", { complexity: "high" }));
    const long = await routeVirtual(t.request({ state: first.state, messages: [{ role: "user", content: "x".repeat(2500) }] }), t.deps);
    expect(t.classify).toHaveBeenCalledTimes(2);
    expect(long.state).toMatchObject({ tier: "premium", switches: 1 });
    t.classify.mockResolvedValueOnce(classification("cheap"));
    const again = await routeVirtual(t.request({ state: long.state, messages: [{ role: "user", content: "y".repeat(2500) }] }), t.deps);
    expect(again.state!.tier).toBe("premium");
    expect(again.model).toMatchObject({ id: long.model.id });
  });

  it("escalates one tier on an explicit cue", async () => {
    const t = setup({ tier: "standard" });
    const first = await routeVirtual(t.request(), t.deps);
    const cue = await routeVirtual(t.request({ state: first.state, messages: [{ role: "user", content: "this is hard, think harder" }] }), t.deps);
    expect(cue.state!.tier).toBe("premium");
  });

  it("stays on its routed tier after a successful edit (no handoff to cheap)", async () => {
    for (const tier of ["standard", "premium"] as const) {
      const t = setup({ tier });
      const first = await routeVirtual(t.request(), t.deps);
      expect(first.state).not.toHaveProperty("phase");
      const after = await routeVirtual(t.request({ reason: "continuation", state: first.state, messages: edited, previous: { model: first.model } }), t.deps);
      expect(after.model).toMatchObject({ id: first.state!.model });
      expect(after.state).toBeUndefined();
      expect(t.onRoute).toHaveBeenCalledTimes(1);
    }
  });

  it("loads state stored with the old phase field and keeps the tier on a fix after review findings", async () => {
    const t = setup({ tier: "premium" });
    const first = await routeVirtual(t.request(), t.deps);
    const old = { ...first.state!, phase: "plan" as const };
    const fix = await routeVirtual(t.request({ reason: "continuation", state: old, messages: edited, previous: { model: first.model } }), t.deps);
    expect(fix.model).toMatchObject({ id: first.state!.model });
    expect(fix.state).toBeUndefined();
    const later = await routeVirtual(t.request({ state: old, messages: [{ role: "user", content: "fix the HIGH findings" }] }), t.deps);
    expect(later.model).toMatchObject({ id: first.state!.model });
    expect(later.state).toBe(old);
  });

  it("retries on another model of the same tier after an overload and records a failure", async () => {
    const t = setup({ tier: "standard" });
    const first = await routeVirtual(t.request(), t.deps);
    const failed = { model: first.model, message: { stopReason: "error", errorMessage: "overloaded_error: 529" } };
    const result = await routeVirtual(t.request({ reason: "retry", state: first.state, failed }), t.deps);
    expect(result.model).toMatchObject({ id: "claude-sonnet-5-5" });
    expect(result.state).toMatchObject({ tier: "standard", model: "claude-sonnet-5-5", switches: 1 });
    expect(t.recordFailure).toHaveBeenCalledWith({ taskType: "feature", tier: "standard", provider: "foundry", model: "grok-4-7" });
  });

  it("retries the same model for other errors", async () => {
    const t = setup({ tier: "standard" });
    const first = await routeVirtual(t.request(), t.deps);
    const result = await routeVirtual(t.request({ reason: "retry", state: first.state, failed: { model: first.model, message: { stopReason: "error", errorMessage: "weird" } } }), t.deps);
    expect(result.model).toEqual(first.model);
    expect(result.state).toBeUndefined();
    expect(t.recordFailure).not.toHaveBeenCalled();
  });

  it("picks a larger context window after an overflow", async () => {
    const t = setup({ tier: "standard" });
    const first = await routeVirtual(t.request(), t.deps);
    const failed = { model: first.model, message: { stopReason: "error", errorMessage: "prompt is too long: 150000 tokens" } };
    const result = await routeVirtual(t.request({ reason: "retry", state: first.state, failed }), t.deps);
    expect(result.model).toMatchObject({ id: "claude-sonnet-5-5" });
    expect(result.model.contextWindow).toBeGreaterThan(first.model.contextWindow);
    expect(t.recordFailure).not.toHaveBeenCalled();
    // sonnet overflows too: the next tier has the larger window
    const up = await routeVirtual(t.request({ reason: "retry", state: result.state, failed: { model: result.model, message: failed.message } }), t.deps);
    expect(up.state!.tier).toBe("premium");
    expect(up.model.contextWindow).toBeGreaterThan(200_000);
  });

  it("routes direct requests to the cheap tier and ignores state", async () => {
    const t = setup({ tier: "premium" });
    const first = await routeVirtual(t.request(), t.deps);
    const direct = await routeVirtual(t.request({ reason: "direct", state: first.state }), t.deps);
    expect(["gpt-6-luna", "claude-haiku-5-5"]).toContain(direct.model.id);
    expect(direct.state).toBeUndefined();
  });

  it("applies thinking level floors and the low discount", async () => {
    const tierOf = async (level: string, tier: Tier, extra: Partial<AcceptedClassification> = {}) => (await routeVirtual(setup({ tier, extra }).request({ thinkingLevel: level }), setup({ tier, extra }).deps)).state!.tier;
    expect(await tierOf("medium", "cheap")).toBe("cheap");
    expect(await tierOf("high", "cheap")).toBe("standard");
    expect(await tierOf("high", "premium")).toBe("premium");
    expect(await tierOf("xhigh", "cheap")).toBe("premium");
    expect(await tierOf("low", "premium")).toBe("standard");
    expect(await tierOf("low", "standard")).toBe("cheap");
    expect(await tierOf("low", "cheap")).toBe("cheap");
    expect(await tierOf("low", "premium", { risk: "high" })).toBe("premium");
  });

  it("raises the tier when the thinking level rises on a later turn", async () => {
    const t = setup({ tier: "cheap" });
    const first = await routeVirtual(t.request(), t.deps);
    const up = await routeVirtual(t.request({ state: first.state, thinkingLevel: "xhigh" }), t.deps);
    expect(up.state).toMatchObject({ tier: "premium", switches: 1 });
    expect(t.classify).toHaveBeenCalledTimes(1);
  });

  it("prefers the cheaper candidate under a soft budget and never escalates", async () => {
    const table: RouterSnapshot["table"] = { feature: { "model:standard:foundry/grok-4-7": { success: 1, failure: 50 } } };
    const normal = setup({ tier: "standard", table });
    expect((await routeVirtual(normal.request(), { ...normal.deps, rng: seededRng(3) })).model.id).toBe("claude-sonnet-5-5");
    const soft = setup({ tier: "standard", table, budget: "soft" });
    const first = await routeVirtual(soft.request(), { ...soft.deps, rng: seededRng(3) });
    expect(first.model.id).toBe("grok-4-7");
    const high = await routeVirtual(soft.request({ state: first.state, thinkingLevel: "xhigh", messages: [{ role: "user", content: "this is hard ".repeat(300) }] }), soft.deps);
    expect(high.state!.tier).toBe("standard");
  });

  it("under a soft budget breaks a real-price tie by quota shadow price, never trading real money for quota", async () => {
    const t = setup({ tier: "cheap", budget: "soft" });
    // luna and haiku are both $0; haiku is quota-cheaper.
    t.snapshot.config.quota = { models: [{ provider: "openai", model: "gpt-6-luna", perMillionTokensUsd: 5 }, { provider: "anthropic", model: "claude-haiku-5-5", perMillionTokensUsd: 1 }], providers: {}, overCapMultiplier: 4 };
    expect((await routeVirtual(t.request(), { ...t.deps, rng: seededRng(1) })).model.id).toBe("claude-haiku-5-5");
    // Sonnet ($3/$15) vs Grok ($1/$4): a huge Grok shadow price does not make the soft budget pick the dearer Sonnet.
    const s = setup({ tier: "standard", budget: "soft" });
    s.snapshot.config.quota = { models: [{ provider: "foundry", model: "grok-4-7", perMillionTokensUsd: 1000 }], providers: {}, overCapMultiplier: 4 };
    expect((await routeVirtual(s.request(), { ...s.deps, rng: seededRng(1) })).model.id).toBe("grok-4-7");
  });

  it("throws on a hard budget", async () => {
    const t = setup({ budget: "hard" });
    await expect(routeVirtual(t.request(), t.deps)).rejects.toThrow(/budget is exhausted/);
  });

  it("skips models that are not registered with credentials and says so when none remain", async () => {
    const skipped = setup({ tier: "standard", missing: ["grok-4-7"] });
    expect((await routeVirtual(skipped.request(), skipped.deps)).model.id).toBe("claude-sonnet-5-5");
    const none = setup({ tier: "standard", missing: ["grok-4-7", "claude-sonnet-5-5", "claude-opus-5-5", "gpt-6.1-sol"] });
    await expect(routeVirtual(none.request(), none.deps)).rejects.toThrow(/No usable/);
  });

  it("picks another model in the tier when the state model lost its credentials", async () => {
    const t = setup({ tier: "standard" });
    const first = await routeVirtual(t.request(), t.deps);
    const gone = setup({ tier: "standard", missing: ["grok-4-7"] });
    const next = await routeVirtual(gone.request({ state: first.state }), gone.deps);
    expect(next.model.id).toBe("claude-sonnet-5-5");
    expect(next.state).not.toBe(first.state);
  });
});

describe("routeVirtual while /plan runs", () => {
  it("classifies the user's text, not the hidden plan-interview context after it", async () => {
    const t = setup();
    await routeVirtual(
      t.request({ messages: [{ role: "user", content: "Plan this request: add a retry counter" }, { role: "user", content: [{ type: "text", text: `${INTERVIEW_RULES}\n\nRequest: x` }] }] }),
      t.deps,
    );
    expect(t.classify).toHaveBeenCalledWith("Plan this request: add a retry counter", undefined);
  });

  it("keeps the chat model at least standard, and premium for high complexity or sensitive work", async () => {
    const cheap = setup({ tier: "cheap" });
    const first = await routeVirtual(cheap.request(), cheap.deps);
    expect(first.state!.tier).toBe("cheap");
    const planning = { ...cheap.deps, planning: () => true };
    const lifted = await routeVirtual(cheap.request({ state: first.state, reason: "continuation" }), planning);
    expect(lifted.state).toMatchObject({ tier: "standard", switches: 1 });
    // A first plan turn classified mechanical/low is routed to standard too.
    const mechanical = setup({ tier: "cheap", extra: { task_type: "mechanical", complexity: "low", risk: "low" } });
    const initial = await routeVirtual(mechanical.request(), { ...mechanical.deps, planning: () => true });
    expect(initial.state!.tier).toBe("standard");
    // High complexity and sensitive work get premium.
    for (const extra of [{ complexity: "high" as const }, { risk: "high" as const }]) {
      const hard = setup({ tier: "cheap", extra });
      const result = await routeVirtual(hard.request(), { ...hard.deps, planning: () => true });
      expect(result.state!.tier).toBe("premium");
    }
    // Outside planning nothing changes.
    const after = await routeVirtual(cheap.request({ state: first.state, reason: "continuation" }), cheap.deps);
    expect(after.state).toBeUndefined();
  });
});

describe("our own prompts never trip the keyword classifier", () => {
  const prompts = { INTERVIEW_RULES, NO_QUESTIONS_RULES, REVISION_RULES, TICKET_RULES: TICKET_RULES(150000), BUILD_CHUNK_RULES };
  for (const [name, text] of Object.entries(prompts)) {
    it(`${name} does not classify as mechanical`, () => {
      expect(fallbackClassification(text).task_type).not.toBe("mechanical");
    });
  }
});
