import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_TIERS, parseConfig, tierCandidates } from "../src/config.js";
import { TIER_KEYS, type TierKey } from "../src/domain.js";
import { advisorsFor, vendorOf } from "../src/review/advisors.js";
import { selectCandidate, type Availability } from "../src/router/select.js";

const sample = () => parseConfig(readFileSync(".pi-workflows/config.yaml", "utf8"));
const AT = new Date("2026-10-16T12:00:00Z");
const pick = (config: ReturnType<typeof sample>, tier: TierKey, availability: Availability) =>
  selectCandidate({ tier, taskType: "general", config, table: {}, availability, strictAvailability: true, rng: () => 0.5, at: AT }).candidate;
const label = (candidate: { provider: string; model: string } | undefined) => (candidate ? `${candidate.provider}/${candidate.model}` : "none");

describe("Foundry fallbacks in the tiers", () => {
  const up = { ok: true };
  const down = { ok: false, detail: "not available" };

  it("lists the Foundry deployment after each OpenAI or xAI entry, in the built-in tiers and the sample config", () => {
    const expected: Record<string, string[]> = {
      ticketLow: ["xai/grok-4.7", "foundry/grok-4-7"],
      ticketHigh: ["openai/gpt-6.1-sol", "foundry/gpt-6.1-sol"],
      standard: ["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol", "foundry/gpt-6.1-sol"],
      batch: ["openai/gpt-6-luna", "foundry/gpt-6-luna"],
      advisor: ["openai/gpt-6-astra", "anthropic/claude-fable-5-1", "foundry/gpt-6-astra"],
    };
    const config = sample();
    for (const [tier, list] of Object.entries(expected)) {
      expect(DEFAULT_TIERS[tier as TierKey].map(label), `built-in ${tier}`).toEqual(list);
      expect(tierCandidates(config, tier as TierKey).map(label), `sample ${tier}`).toEqual(list);
    }
    // Sol is only usable with tools through the Responses API.
    for (const tier of ["ticketHigh", "standard"] as const) {
      expect(DEFAULT_TIERS[tier].find((item) => item.provider === "foundry")?.api).toBe("openai-responses");
      expect(tierCandidates(config, tier).find((item) => item.provider === "foundry")?.api).toBe("openai-responses");
    }
  });

  it("changes nothing when Foundry is unavailable: the routes equal those of tiers without the Foundry entries", () => {
    const withFoundry = sample();
    const without = sample();
    for (const tier of TIER_KEYS) without.tiers[tier] = tierCandidates(without, tier).filter((item) => item.provider !== "foundry");
    const availability: Availability = { openai: up, anthropic: up, xai: up, local: up, vercel: down, foundry: down };
    for (const tier of TIER_KEYS) expect(label(pick(withFoundry, tier, availability)), tier).toBe(label(pick(without, tier, availability)));
    expect(label(pick(withFoundry, "ticketLow", availability))).toBe("xai/grok-4.7");
    expect(label(pick(withFoundry, "ticketHigh", availability))).toBe("openai/gpt-6.1-sol");
  });

  it("falls back to Foundry when OpenAI and xAI are unavailable", () => {
    const config = sample();
    const availability: Availability = { openai: down, xai: down, anthropic: up, foundry: up };
    expect(label(pick(config, "ticketLow", availability))).toBe("foundry/grok-4-7");
    expect(label(pick(config, "ticketHigh", availability))).toBe("foundry/gpt-6.1-sol");
    expect(label(pick(config, "batch", availability))).toBe("foundry/gpt-6-luna");
    const advisors = tierCandidates(config, "advisor").filter((item) => availability[item.provider]?.ok);
    expect(advisors.map(label)).toEqual(["anthropic/claude-fable-5-1", "foundry/gpt-6-astra"]);
  });
});

describe("vendorOf and the cross-vendor advisor rule", () => {
  it("names the vendor by model, else by provider", () => {
    expect(vendorOf({ provider: "foundry", model: "gpt-6-astra" })).toBe("openai");
    expect(vendorOf({ provider: "foundry", model: "grok-4-7" })).toBe("xai");
    expect(vendorOf({ provider: "vercel", model: "claude-sonnet-5-5" })).toBe("anthropic");
    expect(vendorOf({ provider: "openai", model: "gpt-6.1-sol" })).toBe("openai");
    expect(vendorOf({ provider: "local", model: "qwen2.5-coder:7b" })).toBe("local");
    expect(vendorOf({ provider: "foundry", model: "my-deployment" })).toBe("foundry");
    expect(vendorOf({ provider: "xai" })).toBe("xai");
  });

  const fable = { provider: "anthropic" as const, model: "claude-fable-5-1" };
  const foundryAstra = { provider: "foundry" as const, model: "gpt-6-astra" };

  it("gives a medium Sonnet ticket Foundry Astra when OpenAI is unavailable", () => {
    expect(advisorsFor({ difficulty: "medium", implementerProvider: "anthropic", implementerModel: "claude-sonnet-5-5", candidates: [fable, foundryAstra] })).toEqual([foundryAstra]);
  });

  it("does not pick Foundry Astra for an implementer that is OpenAI's model on Foundry", () => {
    expect(advisorsFor({ difficulty: "medium", implementerProvider: "foundry", implementerModel: "gpt-6.1-sol", candidates: [foundryAstra, fable] })).toEqual([fable]);
    expect(advisorsFor({ difficulty: "medium", implementerProvider: "foundry", implementerModel: "gpt-6.1-sol", candidates: [foundryAstra] })).toEqual([]);
  });
});
