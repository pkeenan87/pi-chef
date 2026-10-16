import { describe, expect, it } from "vitest";
import type { AcceptedClassification } from "../src/domain.js";
import { decideRoute, nextTier, TICKET_LADDER } from "../src/router/policy.js";
import { modelMetricKey } from "../src/domain.js";
import { tempRepo, tieredConfig, workflow } from "./helpers.js";

const classification = (extra: Partial<AcceptedClassification> = {}): AcceptedClassification => ({
  task_type: "feature", complexity: "medium", risk: "medium", required_capabilities: [], recommended_tier: "standard", reason_codes: [], source: "planner", ...extra,
});
const rng = () => 0.5;
const opusOnly = () => {
  const config = tieredConfig();
  config.tiers.premium = [{ provider: "anthropic", model: "claude-opus-5-5" }];
  return config;
};

describe("ticket tiers in decideRoute", () => {
  it("routes the first attempt to the difficulty tier", () => {
    const config = opusOnly();
    const pick = (ticketTier: "ticketLow" | "ticketMedium" | "ticketHigh") => decideRoute(classification(), config, {}, { purpose: "implement", ticketTier, rng, strictAvailability: true });
    expect([pick("ticketLow").model, pick("ticketMedium").model, pick("ticketHigh").model]).toEqual(["grok-4.7", "claude-sonnet-5-5", "gpt-6.1-sol"]);
  });

  it("escalates one step up the ladder after each failure: grok, sonnet, sol, opus", () => {
    const config = opusOnly();
    const models: string[] = [];
    let failedTier: "ticketLow" | "ticketMedium" | "ticketHigh" | "premium" | undefined;
    for (let i = 0; i < 4; i++) {
      const decision = decideRoute(classification(), config, {}, { purpose: "implement", ticketTier: "ticketLow", failedTier, escalations: i, rng, strictAvailability: true });
      models.push(decision.model);
      failedTier = decision.tier as typeof failedTier;
    }
    expect(models).toEqual(["grok-4.7", "claude-sonnet-5-5", "gpt-6.1-sol", "claude-opus-5-5"]);
    // Opus is the top: a failure there stays on it.
    expect(decideRoute(classification(), config, {}, { purpose: "implement", failedTier: "premium", rng }).tier).toBe("premium");
    expect(TICKET_LADDER).toEqual(["ticketLow", "ticketMedium", "ticketHigh", "premium"]);
    expect(nextTier("ticketHigh", "premium")).toBe("premium");
    expect(nextTier("ticketHigh", "standard")).toBeUndefined();
  });

  it("does not raise security-sensitive work above its ticket's difficulty tier, but still asks for approval", () => {
    const config = opusOnly();
    const decision = decideRoute(classification({ required_capabilities: ["auth"] }), config, {}, { purpose: "implement", ticketTier: "ticketLow", rng, strictAvailability: true });
    expect(decision).toMatchObject({ tier: "ticketLow", model: "grok-4.7", requireHumanApproval: true });
    expect(decision.reason).not.toContain("ticket_sensitive_floor");
  });

  it("does not let a proven lower tier route a ticket below its difficulty", () => {
    const config = opusOnly();
    const proven = { feature: { cheap: { success: 20, failure: 0 }, ticketLow: { success: 20, failure: 0 } } };
    const decision = decideRoute(classification(), config, proven, { purpose: "implement", ticketTier: "ticketHigh", rng, strictAvailability: true });
    expect(decision.tier).toBe("ticketHigh");
  });

  it("moves an unavailable ticket tier up the same ladder", () => {
    const config = opusOnly();
    const decision = decideRoute(classification(), config, {}, { purpose: "implement", ticketTier: "ticketLow", rng, strictAvailability: true, availability: { xai: { ok: false, detail: "not signed in" } } });
    expect(decision).toMatchObject({ tier: "ticketMedium", model: "claude-sonnet-5-5" });
  });

  it("skips an open circuit on a model's tier", () => {
    const config = opusOnly();
    const at = new Date("2026-03-01T00:00:00Z");
    const recent = [0, 1, 2].map((i) => ({ at: new Date(at.getTime() - i * 1000).toISOString(), ok: false }));
    const table = { feature: { ticketLow: { success: 0, failure: 3, recent }, [modelMetricKey("ticketLow", "xai", "grok-4.7")]: { success: 0, failure: 3, recent } } };
    const decision = decideRoute(classification(), config, table, { purpose: "implement", ticketTier: "ticketLow", rng, at, strictAvailability: true });
    expect(decision.tier).toBe("ticketMedium");
  });

  it("review picks route to routing.reviewTier and read the review:<type> record", () => {
    const config = opusOnly();
    const decision = decideRoute(classification(), config, {}, { purpose: "review", rng });
    expect(decision).toMatchObject({ tier: "premium", model: "claude-opus-5-5" });
    const failing = { "review:feature": { [modelMetricKey("premium", "anthropic", "claude-opus-5-5")]: { success: 0, failure: 30 } } };
    expect(decideRoute(classification(), config, failing, { purpose: "review", rng }).circuitOpen).toBe(true);
    // The same record does not touch implementation work.
    expect(decideRoute(classification(), config, failing, { purpose: "implement", ticketTier: "ticketHigh", rng }).circuitOpen).toBe(false);
  });
});

describe("/status and /route show who does what", () => {
  it("/status lists the session, compaction, review and ticket models", async () => {
    const app = workflow(await tempRepo(), { config: opusOnly() });
    const text = (await app.status()).text;
    expect(text).toContain("Routing: session anthropic/claude-opus-5-5 · compaction cheap: openai/gpt-6-luna, anthropic/claude-haiku-5-5 · batch: openai/gpt-6-luna · review premium: anthropic/claude-opus-5-5");
    expect(text).toContain("Ticket models: low xai/grok-4.7 · medium anthropic/claude-sonnet-5-5 · high openai/gpt-6.1-sol · then anthropic/claude-opus-5-5 (up to 3 escalation(s))");
  });

  it("/route returns the routing summary", async () => {
    const app = workflow(await tempRepo(), { config: opusOnly() });
    const result = await app.route("add a retry counter to the parser");
    expect(result.ok, result.text).toBe(true);
    expect(JSON.parse(result.text).routing).toMatchObject({ session: "anthropic/claude-opus-5-5", tickets: { low: ["xai/grok-4.7"], high: ["openai/gpt-6.1-sol"] } });
  });
});
