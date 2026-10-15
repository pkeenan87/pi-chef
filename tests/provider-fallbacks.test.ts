import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { layerConfigs, parseConfig, priceFor, setBillingResolver } from "../src/config.js";
import type { AcceptedClassification } from "../src/domain.js";
import { FileAuthProbe } from "../src/providers/auth.js";
import { createRegistryChat } from "../src/providers/pi-chat.js";
import { decideRoute } from "../src/router/policy.js";

function authFile(contents: Record<string, { type: string }>): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "pi-cost-auth-")), "auth.json");
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

afterEach(() => setBillingResolver(undefined));

describe("Anthropic API-key fallback", () => {
  const file = authFile({ anthropic: { type: "api_key" }, xai: { type: "oauth" }, openai: { type: "oauth" } });

  it("stays refused unless the user allows it, with a hint on how", async () => {
    const view = await new FileAuthProbe({ authFile: file }).inspect("anthropic");
    expect(view).toMatchObject({ status: "blocked", method: "api-key" });
    expect(view.detail).toContain("apiKeyFallback");
  });

  it("is ready and billed per token when allowed", async () => {
    const probe = new FileAuthProbe({ authFile: file, apiKeyFallback: (provider) => provider === "anthropic" });
    expect(await probe.inspect("anthropic")).toMatchObject({ status: "ready", method: "api-key" });
    expect(probe.billing("anthropic")).toBe("api-key");
    expect(probe.billing("openai")).toBe("subscription");
  });

  it("reads the xAI subscription login", async () => {
    expect(await new FileAuthProbe({ authFile: file }).inspect("xai")).toMatchObject({ status: "ready", method: "oauth" });
  });

  it("can only be turned on by the user config", () => {
    const warnings: string[] = [];
    const project = { providers: { anthropic: { type: "anthropic", auth: "account-login", apiKeyFallback: true } } };
    const merged = layerConfigs(undefined, project, warnings) as { providers: { anthropic: Record<string, unknown> } };
    expect(merged.providers.anthropic.apiKeyFallback).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/only the user config/);
    const user = { providers: { anthropic: { type: "anthropic", auth: "account-login", apiKeyFallback: true } } };
    const kept = layerConfigs(user, project, []) as { providers: { anthropic: Record<string, unknown> } };
    expect(kept.providers.anthropic.apiKeyFallback).toBe(true);
  });

  it("rejects apiKeyFallback on providers that do not sign in with an account", () => {
    expect(() => parseConfig("providers:\n  foundry: { type: azure-foundry, auth: azure-cli, endpointEnv: X, apiKeyFallback: true }\n")).toThrow(/openai, anthropic, and xai/);
    expect(() => parseConfig("providers:\n  anthropic: { type: anthropic, auth: account-login, apiKeyFallback: yes-please }\n")).toThrow(/true or false/);
  });

  it("lets the registry chat use an allowed API key and refuses one that is not allowed", async () => {
    const registry = {
      find: (provider: string, id: string) => ({ provider, id }),
      isUsingOAuth: () => false,
      complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
    };
    const refused = createRegistryChat(registry as never);
    await expect(refused({ provider: "anthropic", model: "claude-sonnet-5-5" }, { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/apiKeyFallback/);
    const allowed = createRegistryChat(registry as never, (provider) => provider === "anthropic");
    await expect(allowed({ provider: "anthropic", model: "claude-sonnet-5-5" }, { messages: [{ role: "user", content: "hi" }] })).resolves.toBeDefined();
  });
});

describe("pricing by billing", () => {
  const pricing = parseConfig(`pricing:
  - { provider: anthropic, model: claude-sonnet-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: anthropic, model: claude-sonnet-5-5, billing: api-key, effectiveFrom: "2026-01-01", inputPerMillionUsd: 2, outputPerMillionUsd: 10 }
`).pricing;
  const at = new Date("2026-10-15T00:00:00Z");

  it("uses subscription rows by default and API-key rows while the provider is on a key", () => {
    expect(priceFor(pricing, "anthropic", "claude-sonnet-5-5", at)?.inputPerMillionUsd).toBe(0);
    setBillingResolver((provider) => (provider === "anthropic" ? "api-key" : "subscription"));
    expect(priceFor(pricing, "anthropic", "claude-sonnet-5-5", at)?.inputPerMillionUsd).toBe(2);
  });

  it("treats a model with no API-key row as unknown cost, never as the subscription's $0", () => {
    setBillingResolver(() => "api-key");
    expect(priceFor(pricing, "anthropic", "claude-haiku-5-5", at)).toBeUndefined();
    const subscriptionOnly = parseConfig(`pricing:\n  - { provider: anthropic, model: claude-opus-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }\n`).pricing;
    expect(priceFor(subscriptionOnly, "anthropic", "claude-opus-5-5", at)).toBeUndefined();
  });
});

describe("unattended routing", () => {
  const config = parseConfig(`
providers:
  openai: { type: openai, auth: account-login, model: gpt-6.1-sol }
  anthropic: { type: anthropic, auth: account-login, model: claude-sonnet-5-5 }
  xai: { type: xai, auth: account-login }
  foundry: { type: azure-foundry, auth: azure-cli, endpointEnv: AZURE_AI_ENDPOINT }
models: { classifier: openai, cheap: openai, standard: anthropic, premium: openai }
tiers:
  standard:
    - { provider: anthropic, model: claude-sonnet-5-5 }
    - { provider: foundry, model: grok-4-7 }
  premium:
    - { provider: openai, model: gpt-6.1-sol }
pricing:
  - { provider: anthropic, model: claude-sonnet-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: foundry, model: grok-4-7, effectiveFrom: "2026-01-01", inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
  - { provider: openai, model: gpt-6.1-sol, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
`);
  const classification: AcceptedClassification = {
    task_type: "feature",
    complexity: "medium",
    risk: "low",
    recommended_tier: "standard",
    required_capabilities: [],
    confidence: 0.9,
    reason_codes: [],
    source: "model",
  } as never;
  const availability = { anthropic: { ok: false, detail: "blocked: API key" }, foundry: { ok: false, detail: "missing: az login" }, openai: { ok: true } };

  it("skips a tier with no signed-in provider and moves up", () => {
    const decision = decideRoute(classification, config, {}, { purpose: "implement", tierHint: "standard", availability, strictAvailability: true, rng: () => 0.5 });
    expect(decision).toMatchObject({ tier: "premium", provider: "openai", model: "gpt-6.1-sol" });
    expect(decision.reason.join(" ")).toContain("escalated_from_standard_unavailable");
  });

  it("still falls back to an unavailable provider for interactive routing", () => {
    const decision = decideRoute(classification, config, {}, { purpose: "implement", tierHint: "standard", availability, rng: () => 0.5 });
    expect(decision.tier).toBe("standard");
  });

  it("uses a provider the user allowed once it is signed in", () => {
    const decision = decideRoute(classification, config, {}, { purpose: "implement", tierHint: "standard", availability: { ...availability, anthropic: { ok: true } }, strictAvailability: true, rng: () => 0.5 });
    expect(decision).toMatchObject({ tier: "standard", provider: "anthropic" });
  });
});
