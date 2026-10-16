import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { AcceptedClassification, ProviderId } from "../src/domain.js";
import type { ProviderAuthView } from "../src/providers/auth.js";
import { registryProblem } from "../src/providers/usable.js";
import { tempRepo, workflow } from "./helpers.js";

const classification: AcceptedClassification = { task_type: "feature", complexity: "high", risk: "medium", required_capabilities: [], recommended_tier: "premium", reason_codes: [], source: "planner" };

/** Pi's login state as the auth probe sees it. */
const probe = (status: Partial<Record<ProviderId, ProviderAuthView["status"]>>) => ({
  async inspect(provider: ProviderId): Promise<ProviderAuthView> {
    const state = status[provider] ?? "missing";
    return { provider, status: state, method: provider === "foundry" ? "azure-cli" : "oauth", detail: state === "ready" ? "ok" : "No stored Pi credential." };
  },
});

// The user's work-machine config: Foundry only. OpenAI is not named anywhere, and Pi has no OpenAI login.
const FOUNDRY_ONLY = `providers:
  foundry:
    endpoint: "https://res.services.ai.azure.com"
    routeStyle: v1
    audience: "https://ai.azure.com"
`;

describe("routing availability follows what is actually usable", () => {
  it("does not pick openai for ticketHigh when the config never mentions openai and Pi has no OpenAI login", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: parseConfig(FOUNDRY_ONLY), auth: probe({ foundry: "ready", anthropic: "ready" }), rng: () => 0.5 });
    const decision = await app.decide(classification, "implement", { ticketTier: "ticketHigh", strictAvailability: true });
    expect(decision.provider).not.toBe("openai");
    expect(decision).toMatchObject({ tier: "ticketHigh", provider: "foundry", model: "gpt-6.1-sol" });
  });
});

const ACCOUNTS = `providers:
  openai: { type: openai, auth: account-login }
  foundry:
    endpoint: "https://res.services.ai.azure.com"
    deployments: { "gpt-6.1-sol": my-sol }
`;
const ALL_READY = probe({ openai: "ready", anthropic: "ready", xai: "ready", foundry: "ready" });
const USER_PATH = "~/.pi/agent/chef.yaml";

/** A Pi registry fake: which `provider/id` it knows, and which providers hold credentials. */
const registry = (known: string[], signedIn: string[]) => ({
  find: (provider: string, id: string) => (known.includes(`${provider}/${id}`) ? { provider, id } : undefined),
  hasConfiguredAuth: (model: { provider: string }) => signedIn.includes(model.provider),
});

describe("bug 3: a stale or unusable credential no longer satisfies routing", () => {
  it("skips an openai candidate the auth probe likes but Pi has no usable credential for, and takes the next one", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: parseConfig(ACCOUNTS), auth: ALL_READY, rng: () => 0.5 });
    // Probe: openai ready (an oauth entry exists). Pi: no credentials for openai (a ChatGPT Enterprise entry it cannot use).
    app.bind({ registry: registry(["openai/gpt-6.1-sol", "foundry/my-sol"], ["foundry"]) });
    const decision = await app.decide(classification, "implement", { ticketTier: "ticketHigh", strictAvailability: true });
    expect(decision).toMatchObject({ tier: "ticketHigh", provider: "foundry", model: "gpt-6.1-sol" });
    expect(decision.considered?.find((item) => item.provider === "openai")?.excludedReason).toBe("provider openai has no login (run /login openai)");
  });

  it("without a registry bound the probe alone decides, as before", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: parseConfig(ACCOUNTS), auth: ALL_READY, rng: () => 0.5 });
    expect((await app.decide(classification, "implement", { ticketTier: "ticketHigh", strictAvailability: true })).provider).toBe("openai");
  });

  it("treats a provider the config omits like any other: probed, and unavailable without a login", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: parseConfig(FOUNDRY_ONLY), auth: probe({ foundry: "ready" }), rng: () => 0.5 });
    const seen = await app.availability();
    expect(seen.openai).toEqual({ ok: false, detail: "provider openai has no login (run /login openai)" });
    expect(seen.anthropic?.ok).toBe(false);
    expect(seen.foundry?.ok).toBe(true);
  });
});

describe("stop and skip reasons", () => {
  it("names a provider that is not registered, and one with no endpoint", async () => {
    const cwd = await tempRepo();
    const none = workflow(cwd, { config: parseConfig("branchPrefix: x\n"), auth: ALL_READY });
    expect((await none.availability()).foundry?.detail).toBe(`provider foundry is not registered (no providers.foundry in ${USER_PATH})`);
    expect((await none.availability()).vercel?.detail).toBe(`provider vercel is not registered (no providers.vercel in ${USER_PATH})`);
    const noEndpoint = workflow(cwd, { config: parseConfig("providers:\n  foundry: { type: azure-foundry }\n"), auth: ALL_READY });
    expect((await noEndpoint.availability()).foundry?.detail).toBe(`provider foundry is not registered (providers.foundry has no endpoint; set endpoint in ${USER_PATH})`);
  });

  it("names a missing, expired, and Azure login", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: parseConfig(ACCOUNTS), auth: probe({ openai: "missing", anthropic: "expired", foundry: "missing" }) });
    const seen = await app.availability();
    expect(seen.openai?.detail).toBe("provider openai has no login (run /login openai)");
    expect(seen.anthropic?.detail).toBe("provider anthropic login has expired (run /login anthropic)");
    expect(seen.foundry?.detail).toBe("provider foundry has no Azure login (run az login)");
  });

  it("names a model Pi does not know, and a mapped deployment", () => {
    const config = parseConfig(ACCOUNTS);
    const empty = registry([], []);
    expect(registryProblem(config, empty, "foundry", "grok-4-7")).toBe("model grok-4-7 is not among the foundry provider's registered models");
    expect(registryProblem(config, empty, "foundry", "gpt-6.1-sol")).toBe("deployment my-sol (mapped from gpt-6.1-sol) is not among the foundry provider's registered models");
    expect(registryProblem(config, registry(["foundry/my-sol"], []), "foundry", "gpt-6.1-sol")).toBe("provider foundry has no usable credentials in Pi");
    expect(registryProblem(config, registry(["foundry/my-sol"], ["foundry"]), "foundry", "gpt-6.1-sol")).toBeUndefined();
  });

  it("when nothing in the tier or above is usable, the stop lists every candidate with its own reason", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: parseConfig(ACCOUNTS), auth: probe({ openai: "missing", anthropic: "ready", foundry: "ready" }), rng: () => 0.5 });
    app.bind({ registry: registry([], []) });
    const decision = await app.decide(classification, "implement", { ticketTier: "ticketHigh", strictAvailability: true });
    expect(decision.provider).toBe("none");
    expect(decision.blocked).toContain("openai/gpt-6.1-sol (provider openai has no login (run /login openai))");
    expect(decision.blocked).toContain("foundry/gpt-6.1-sol → my-sol (deployment my-sol (mapped from gpt-6.1-sol) is not among the foundry provider's registered models)");
    expect(decision.blocked).toContain("anthropic/claude-opus-5-5 (model claude-opus-5-5 is not among the anthropic provider's registered models)");
  });
});
