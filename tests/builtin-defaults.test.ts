import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIERS, loadConfig, parseConfig, tierCandidates, validateResolvedConfig } from "../src/config.js";
import { TIER_KEYS } from "../src/domain.js";
import { registerChatProviders } from "../src/providers/runtime.js";

const FOUNDRY = `providers:
  foundry:
    type: azure-foundry
    auth: azure-cli
    endpoint: "https://res.services.ai.azure.com"
    routeStyle: v1
    audience: "https://ai.azure.com"
`;

describe("built-in defaults never fail validation", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    project = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    process.env.HOME = home;
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });
  const writeUser = (yaml: string) => writeFileSync(path.join(home, ".pi", "agent", "chef.yaml"), yaml);

  it("the defaults alone validate and cover every tier", () => {
    const config = loadConfig(project);
    expect(() => validateResolvedConfig(config)).not.toThrow();
    expect(config.tiers).toEqual({});
    for (const tier of TIER_KEYS) expect(tierCandidates(config, tier)).toEqual(DEFAULT_TIERS[tier]);
    expect("models" in config).toBe(false);
  });

  it("a user config with only providers.foundry plus tiers.ticketHigh loads without errors and registers Foundry", () => {
    writeUser(`${FOUNDRY}tiers:\n  ticketHigh:\n    - { provider: foundry, model: gpt-6.1-sol }\n`);
    const config = loadConfig(project);
    expect(tierCandidates(config, "ticketHigh").map((item) => item.model)).toEqual(["gpt-6.1-sol"]);
    const calls: string[] = [];
    const registered = registerChatProviders({ registerProvider: (name) => void calls.push(name) }, config, {}, {});
    expect(registered).toContain("foundry");
    expect(calls).toContain("foundry");
  });

  it.each(["foundry", "local", "vercel", "anthropic"])("adding the %s provider alone never invalidates the file", (name) => {
    const body: Record<string, string> = {
      foundry: FOUNDRY,
      local: 'providers:\n  local: { type: openai-compatible, baseUrl: "http://127.0.0.1:1/v1", model: m }\n',
      vercel: "providers:\n  vercel: { type: vercel-ai-gateway, auth: vercel-cli }\n",
      anthropic: "providers:\n  anthropic: { type: anthropic, auth: account-login }\n",
    };
    writeUser(body[name]);
    expect(() => loadConfig(project)).not.toThrow();
    expect(() => parseConfig(body[name])).not.toThrow();
  });

  it("the old foundry deployments error for an untouched models map is gone", () => {
    expect(() => parseConfig(`${FOUNDRY.replace("routeStyle: v1", "deployments: {}")}`)).not.toThrow();
  });
});

describe("a provider block without type", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    project = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    process.env.HOME = home;
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });

  it("still defines foundry, vercel, and local (only account providers need a type to count)", () => {
    writeFileSync(path.join(home, ".pi", "agent", "chef.yaml"), 'providers:\n  foundry: { endpoint: "https://res.services.ai.azure.com", routeStyle: v1, audience: "https://ai.azure.com" }\n  anthropic: { apiKeyFallback: true }\n');
    const config = loadConfig(project);
    expect(config.providers.foundry?.endpoint).toBe("https://res.services.ai.azure.com");
    expect(config.providers.foundry?.type).toBe("azure-foundry");
    // An account provider with no type is only an adjustment and is not a provider of its own.
    expect(config.providers.anthropic).toBeUndefined();
    const calls: string[] = [];
    expect(registerChatProviders({ registerProvider: (name) => void calls.push(name) }, config, {}, {})).toContain("foundry");
  });
});
