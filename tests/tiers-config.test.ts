import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, tierCandidates } from "../src/config.js";
import { tieredConfig, testConfig } from "./helpers.js";

describe("tiers config", () => {
  it("parses candidate lists, including advisor and decisions models", () => {
    const config = tieredConfig();
    expect(tierCandidates(config, "classifier").map((item) => `${item.provider}:${item.api}`)).toEqual(["foundry:decisions", "vercel:decisions"]);
    expect(tierCandidates(config, "cheap").map((item) => item.model)).toEqual(["gpt-6-luna", "claude-haiku-5-5"]);
    expect(tierCandidates(config, "advisor")).toHaveLength(2);
    expect(tierCandidates(config, "deterministic")[0]).toMatchObject({ provider: "local", api: "chat" });
  });

  it("turns the legacy models map into single-candidate tiers", () => {
    const config = testConfig();
    expect(tierCandidates(config, "standard")).toEqual([{ provider: "anthropic", model: "claude-sonnet", api: "chat" }]);
    expect(tierCandidates(config, "cheap")).toEqual([{ provider: "foundry", model: "classifier", api: "chat" }]);
    expect(tierCandidates(config, "advisor")).toEqual([]);
    expect(tierCandidates(config, "deterministic")).toEqual([]);
  });

  it("mixes: an explicit tier overrides models for that tier only", () => {
    const config = parseConfig(`
providers:
  openai: { type: openai, auth: account-login, model: gpt-x }
  anthropic: { type: anthropic, auth: account-login, model: claude-x }
  foundry: { type: azure-foundry, auth: azure-cli, deployments: { classifier: c, reasoning: r, cheap: c } }
  local: { type: openai-compatible, baseUrl: "http://127.0.0.1:1/v1", model: m }
models: { classifier: local, cheap: foundry, standard: anthropic, premium: openai }
tiers:
  standard:
    - { provider: openai, model: gpt-y }
`);
    expect(tierCandidates(config, "standard").map((item) => item.model)).toEqual(["gpt-y"]);
    expect(tierCandidates(config, "premium").map((item) => item.model)).toEqual(["gpt-x"]);
  });

  it("rejects bad tiers with CONFIG_INVALID", () => {
    const base = `providers:\n  openai: { type: openai, auth: account-login }\n`;
    const bad = (tiers: string, pattern: RegExp) => expect(() => parseConfig(`${base}tiers:\n${tiers}`)).toThrow(pattern);
    bad("  nope:\n    - { provider: openai, model: m }\n", /tiers\.nope/);
    bad("  cheap: []\n", /non-empty list/);
    bad("  cheap:\n    - { provider: bogus, model: m }\n", /tiers\.cheap\[0\]\.provider/);
    bad("  cheap:\n    - { provider: openai }\n", /model/);
    bad("  cheap:\n    - { provider: openai, model: m, api: decisions }\n", /classifier tier/);
    bad("  cheap:\n    - { provider: openai, model: m, api: weird }\n", /api/);
    expect(() => parseConfig(`${base}tiers:\n  cheap:\n    - { provider: anthropic, model: m }\n`)).toThrow(/not defined under providers/);
    try {
      parseConfig(`${base}tiers:\n  cheap: []\n`);
    } catch (error) {
      expect((error as { code: string }).code).toBe("CONFIG_INVALID");
    }
  });

  it("validates the new provider fields", () => {
    const p = (body: string) => () => parseConfig(`providers:\n  vercel: { type: vercel-ai-gateway, ${body} }\n`);
    expect(p("auth: api-key")).toThrow(/vercel-cli/);
    expect(p("auth: vercel-cli, envFile: ../x")).toThrow(/envFile/);
    expect(p("auth: vercel-cli, decisionsPath: decisions")).toThrow(/decisionsPath/);
    expect(p("auth: vercel-cli, routeStyle: v2")).toThrow(/routeStyle/);
    expect(p("auth: vercel-cli, projectDir: .")).not.toThrow();
  });

  it("keeps the shipped sample config valid, secret-free, and on v1", () => {
    const text = readFileSync(path.join(__dirname, "..", ".pi-workflows", "config.yaml"), "utf8");
    const config = parseConfig(text);
    expect(config.providers.foundry).toMatchObject({ routeStyle: "v1", audience: "https://ai.azure.com" });
    expect(tierCandidates(config, "advisor").map((item) => item.model)).toEqual(["gpt-6-astra", "claude-fable-5-1", "gpt-6-astra"]);
    const ids = (tier: Parameters<typeof tierCandidates>[1]) => tierCandidates(config, tier).map((item) => `${item.provider}/${item.model}`);
    expect(ids("cheap")).toEqual(["anthropic/claude-haiku-5-5", "openai/gpt-6-luna"]);
    expect(ids("standard")).toEqual(["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol"]);
    expect(ids("premium")).toEqual(["anthropic/claude-opus-5-5"]);
    expect(ids("ticketLow")).toEqual(["xai/grok-4.7"]);
    expect(ids("ticketMedium")).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(ids("ticketHigh")).toEqual(["openai/gpt-6.1-sol"]);
    expect(config.routing).toMatchObject({ sessionTier: "premium", directTier: "cheap", reviewTier: "premium", maxEscalations: 3 });
    expect(config.warnings ?? []).toEqual([]);
    // every listed chat model has a quota weight
    for (const tier of ["cheap", "standard", "premium", "ticketLow", "ticketMedium", "ticketHigh", "advisor"] as const) {
      for (const item of tierCandidates(config, tier)) {
        if (item.provider === "foundry") continue;
        expect(config.quota.models.some((row) => row.provider === item.provider && row.model === item.model), `quota ${item.provider}/${item.model}`).toBe(true);
      }
    }
    expect(config.pricing.some((row) => row.model === "claude-opus-4-8" && row.billing === "api-key" && row.inputPerMillionUsd === 5 && row.outputPerMillionUsd === 25)).toBe(true);
    expect(tierCandidates(config, "classifier").every((item) => item.api === "decisions")).toBe(true);
    // every candidate has an explicit pricing row
    for (const tier of ["deterministic", "classifier", "cheap", "standard", "premium", "ticketLow", "ticketMedium", "ticketHigh", "advisor"] as const) {
      for (const item of tierCandidates(config, tier)) {
        expect(config.pricing.some((row) => row.provider === item.provider && row.model === item.model), `${item.provider}/${item.model}`).toBe(true);
      }
    }
  });
});
