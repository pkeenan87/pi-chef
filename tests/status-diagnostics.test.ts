import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands.js";
import { parseConfig } from "../src/config.js";
import type { ProviderId } from "../src/domain.js";
import { resourceFromEndpoint } from "../src/orchestrator/status-foundry.js";
import type { ProviderAuthView } from "../src/providers/auth.js";
import { tempRepo, workflow } from "./helpers.js";

const probe = (status: Partial<Record<ProviderId, ProviderAuthView["status"]>>) => ({
  async inspect(provider: ProviderId): Promise<ProviderAuthView> {
    const state = status[provider] ?? "missing";
    return { provider, status: state, method: provider === "foundry" ? "azure-cli" : "oauth", detail: state === "ready" ? "ok" : "none" };
  },
});

const CONFIG = (extra = "") => `providers:
  openai: { type: openai, auth: account-login }
  foundry:
    endpoint: "https://res.services.ai.azure.com"
    ${extra}
    deployments: { "gpt-6.1-sol": my-sol }
tiers:
  ticketHigh:
    - { provider: openai, model: gpt-6.1-sol }
    - { provider: foundry, model: gpt-6.1-sol }
  ticketLow:
    - { provider: foundry, model: grok-4-7 }
`;

const DEPLOYMENTS = JSON.stringify([
  { name: "gpt-4o-prod", properties: { model: { name: "gpt-4o", version: "2025-01-01", format: "OpenAI" }, secretField: "do-not-print" } },
  { name: "grok-4-7", properties: { model: { name: "grok-4-7", version: "1" } } },
]);

type Result = { code: number; stdout: string; stderr: string };
function fakeAz(handler: (args: string[]) => Result) {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => (calls.push(args), handler(args)) };
}
const ok = (stdout: string): Result => ({ code: 0, stdout, stderr: "" });

async function statusOf(config: string, az: ReturnType<typeof fakeAz>, arg = "", auth = probe({ openai: "missing", foundry: "ready", anthropic: "ready" })) {
  const cwd = await tempRepo();
  const app = workflow(cwd, { config: parseConfig(config), auth, azure: az.run, rng: () => 0.5 });
  const result = await app.status(arg);
  expect(result.ok).toBe(true);
  return result.text;
}

describe("/status Routing check", () => {
  it("shows, per tier, the candidate that will run and each skipped one with its reason", async () => {
    const text = await statusOf(CONFIG(), fakeAz(() => ok("[]")));
    expect(text).toContain("Routing check:");
    expect(text).toContain("  ticketHigh → foundry/gpt-6.1-sol → my-sol");
    expect(text).toContain("    skipped openai/gpt-6.1-sol: provider openai has no login (run /login openai)");
    expect(text).toContain("  ticketLow → foundry/grok-4-7");
    expect(text).toContain("  deterministic → nothing usable");
    expect(text).toContain("    skipped local/qwen2.5-coder:7b: provider local is not registered (no providers.local in ~/.pi/agent/chef.yaml)");
  });

  it("never runs az without being asked", async () => {
    const az = fakeAz(() => ok("[]"));
    await statusOf(CONFIG(), az);
    expect(az.calls).toEqual([]);
  });

  it("offers foundry as a completion", () => {
    const status = COMMANDS.find((item) => item.name === "status")!;
    expect(status.complete("f").map((item) => item.value)).toEqual(["foundry"]);
    expect(status.complete("").map((item) => item.value)).toEqual(["foundry"]);
  });
});

describe("/status foundry", () => {
  it("lists deployments with their models and versions and flags tier entries that have none", async () => {
    const az = fakeAz(() => ok(DEPLOYMENTS));
    const text = await statusOf(CONFIG("resourceGroup: rg-ai"), az, "foundry");
    expect(az.calls).toEqual([["cognitiveservices", "account", "deployment", "list", "-g", "rg-ai", "-n", "res", "-o", "json"]]);
    expect(text).toContain("Foundry deployments: 2 on res (resource group rg-ai)");
    expect(text).toContain("  gpt-4o-prod: gpt-4o 2025-01-01");
    expect(text).toContain("  grok-4-7: grok-4-7 1");
    expect(text).not.toContain("do-not-print");
    // grok-4-7 exists; gpt-6.1-sol maps to my-sol, which does not.
    expect(text).toContain('Missing: foundry/gpt-6.1-sol → my-sol (used by standard, ticketHigh)');
    expect(text).toContain('providers.foundry.deployments: { "gpt-6.1-sol": "gpt-4o-prod" }');
    expect(text).not.toMatch(/Missing: foundry\/grok-4-7/);
  });

  it("finds the resource group by name when providers.foundry.resourceGroup is not set", async () => {
    const az = fakeAz((args) => (args[1] === "account" && args[2] === "list" ? ok("rg-found\n") : ok(DEPLOYMENTS)));
    const text = await statusOf(CONFIG(), az, "foundry");
    expect(az.calls[0]).toEqual(["cognitiveservices", "account", "list", "--query", "[?name=='res'].resourceGroup", "-o", "tsv"]);
    expect(az.calls[1]).toContain("rg-found");
    expect(text).toContain("resource group rg-found");
  });

  it("says when az is not installed or not logged in, and when the resource is not found", async () => {
    const missing = await statusOf(CONFIG("resourceGroup: rg-ai"), fakeAz(() => ({ code: 127, stdout: "", stderr: "az is not on PATH" })), "foundry");
    expect(missing).toContain("Foundry deployments: az is not on PATH");
    const loggedOut = await statusOf(CONFIG("resourceGroup: rg-ai"), fakeAz(() => ({ code: 1, stdout: "", stderr: "ERROR: Please run 'az login' to setup account." })), "foundry");
    expect(loggedOut).toContain("Foundry deployments: az is not logged in; run az login.");
    const none = await statusOf(CONFIG(), fakeAz(() => ok("\n")), "foundry");
    expect(none).toContain("no resource named res was found");
  });

  it("reports an unconfigured provider or an endpoint whose host is not an Azure resource without calling az", async () => {
    const az = fakeAz(() => ok("[]"));
    expect(await statusOf("branchPrefix: x\n", az, "foundry")).toContain("provider foundry is not registered (no providers.foundry in ~/.pi/agent/chef.yaml)");
    expect(await statusOf('providers:\n  foundry: { endpoint: "https://example.com" }\n', az, "foundry")).toContain("cannot derive the resource name");
    expect(az.calls).toEqual([]);
  });

  it("derives the resource name from either Azure host", () => {
    expect(resourceFromEndpoint("https://res.services.ai.azure.com/")).toBe("res");
    expect(resourceFromEndpoint("https://my-res.openai.azure.com")).toBe("my-res");
    expect(resourceFromEndpoint("https://evil.example.com")).toBeUndefined();
  });

  it("rejects other arguments", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: parseConfig("branchPrefix: x\n") });
    expect((await app.status("bogus")).ok).toBe(false);
  });

  it("takes resourceGroup from the user config only", () => {
    const config = parseConfig("providers:\n  foundry: { endpoint: \"https://res.services.ai.azure.com\", resourceGroup: rg-ai }\n");
    expect(config.providers.foundry?.resourceGroup).toBe("rg-ai");
    expect(() => parseConfig("providers:\n  foundry: { resourceGroup: 'a b;c' }\n")).toThrow(/resourceGroup/);
  });
});
