import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIERS, loadConfig, parseConfig, tierCandidates } from "../src/config.js";
import type { AcceptedClassification } from "../src/domain.js";
import { decideRoute } from "../src/router/policy.js";

const classification = (): AcceptedClassification => ({
  task_type: "feature", complexity: "medium", risk: "medium", required_capabilities: [], recommended_tier: "standard", reason_codes: [], source: "planner", ...{},
});
const rng = () => 0.5;

describe("built-in tiers", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    project = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });
  const writeUser = (yaml: string) => {
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(path.join(home, ".pi", "agent", "chef.yaml"), yaml);
  };

  it("a user config with no tiers and no project config routes every tier to a real model id", () => {
    writeUser("providers:\n  anthropic:\n    apiKeyFallback: true\ncommandAllowlist:\n  - npm test\n");
    const config = loadConfig(project);
    for (const tier of Object.keys(DEFAULT_TIERS) as (keyof typeof DEFAULT_TIERS)[]) {
      const candidates = tierCandidates(config, tier);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((item) => item.model !== "")).toBe(true);
    }
    const decision = decideRoute(classification(), config, {}, { purpose: "implement", ticketTier: "ticketHigh", rng });
    expect(decision).toMatchObject({ tier: "ticketHigh", provider: "openai", model: "gpt-6.1-sol" });
    expect(tierCandidates(config, "premium")).toEqual([{ provider: "anthropic", model: "claude-opus-5-5" }]);
  });

  it("warns once that the built-in models have no pricing rows", () => {
    writeUser("providers:\n  anthropic:\n    apiKeyFallback: true\n");
    const warning = loadConfig(project).warnings?.filter((text) => text.startsWith("No pricing rows for")) ?? [];
    expect(warning).toHaveLength(1);
    expect(warning[0]).toContain("openai/gpt-6.1-sol");
    expect(warning[0]).toMatch(/: their cost is unknown\. Copy the sample \.pi-workflows\/config\.yaml \(or run the init command\) to price them\.$/);
  });

  it("does not warn for models that have a pricing row", () => {
    writeUser(`tiers:
  cheap: [{ provider: openai, model: gpt-x }]
  batch: [{ provider: openai, model: gpt-x }]
  standard: [{ provider: openai, model: gpt-x }]
  premium: [{ provider: openai, model: gpt-x }]
  ticketLow: [{ provider: openai, model: gpt-x }]
  ticketMedium: [{ provider: openai, model: gpt-x }]
  ticketHigh: [{ provider: openai, model: gpt-x }]
  advisor: [{ provider: openai, model: gpt-x }]
  deterministic: [{ provider: openai, model: gpt-x }]
providers:
  openai: { type: openai, auth: account-login }
pricing:
  - { provider: openai, model: gpt-x, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
`);
    expect(loadConfig(project).warnings?.join("\n") ?? "").not.toMatch(/No pricing rows/);
  });

  it("a config's tiers replace the built-in list per tier only", () => {
    const config = parseConfig("tiers:\n  ticketHigh: [{ provider: openai, model: mine }]\n".replace("tiers:", "providers:\n  openai: { type: openai, auth: account-login, model: m }\ntiers:"));
    expect(tierCandidates(config, "ticketHigh").map((item) => item.model)).toEqual(["mine"]);
    expect(tierCandidates(config, "ticketMedium").map((item) => item.model)).toEqual(["claude-sonnet-5-5"]);
  });

  it("a config with no tiers uses the built-in list for every tier", () => {
    const config = parseConfig("branchPrefix: cost\n");
    expect(config.tiers).toEqual({});
    expect(tierCandidates(config, "premium")).toEqual(DEFAULT_TIERS.premium);
  });

  it("blocks the route with a clear message when nothing is usable", () => {
    const config = parseConfig("branchPrefix: cost\n");
    config.tiers.premium = [{ provider: "openai", model: "" }];
    config.tiers.ticketHigh = [{ provider: "openai", model: "" }];
    const decision = decideRoute(classification(), config, {}, { purpose: "implement", ticketTier: "ticketHigh", rng, strictAvailability: true, availability: {} });
    expect(decision.blocked).toBe("No model configured for tier ticketHigh; add tiers.ticketHigh to your config.");
  });
});
