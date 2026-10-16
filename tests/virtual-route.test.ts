import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMMANDS } from "../src/commands.js";
import { bindWorkflow, registerWorkflow } from "../src/extension.js";
import { createRegistryChat } from "../src/providers/pi-chat.js";
import { permissiveRegistry, builtWorkflow, seededRng, singleTaskRequest, tempRepo, tieredConfig, tieredYaml, workflow } from "./helpers.js";

const priorHome = process.env.HOME;

/** Credential and endpoint settings are read from the user config only, so these tests write it there. */
function writeUserConfig(yaml: string): void {
  const home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(path.join(home, ".pi", "agent", "cost-workflow.yaml"), yaml);
  process.env.HOME = home;
}

afterEach(() => {
  process.env.HOME = priorHome;
  bindWorkflow(undefined);
  vi.restoreAllMocks();
});

function fakePi() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const providers: Record<string, unknown> = {};
  let virtual: { route: (request: unknown, ctx: unknown) => Promise<{ model: { provider: string; id: string }; state?: unknown }> } | undefined;
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
      return () => undefined;
    },
    appendEntry() {},
    registerVirtualModel(model: typeof virtual) {
      virtual = model;
    },
    registerProvider(name: string, config: unknown) {
      providers[name] = config;
    },
  };
  registerWorkflow(pi as unknown as ExtensionAPI);
  return { commands, handlers, providers, route: () => virtual! };
}

const registry = permissiveRegistry();
const user = (content: string) => ({ role: "user", content });

describe("virtual model route with tiers", () => {
  it("picks via the selector, returns the registry model, stores state, and logs a route event without a status line", async () => {
    const { app, cwd } = await builtWorkflow();
    writeUserConfig(tieredYaml());
    bindWorkflow(app);
    const { handlers, route, providers } = fakePi();
    handlers.get("session_start")!({}, { cwd });
    const statuses: [string, string | undefined][] = [];
    const ctx = { modelRegistry: registry, ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) } };
    // equal sampled success odds, so the cheaper Foundry Grok wins on cost per success
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const picked = await route().route({ reason: "user", messages: [user("add a retry counter to the parser")] }, ctx);
    expect(picked.model).toEqual({ provider: "foundry", id: "grok-4-7" });
    // the Pi footer shows the routed model; chat turns set no status line of their own
    expect(statuses).toHaveLength(0);
    expect((picked as { state?: { tier: string; model: string } }).state).toMatchObject({ v: 1, tier: "standard", model: "grok-4-7", phase: "plan", switches: 0 });
    const events = readFileSync(path.join(app.store.root, "tasks", app.activeTaskId()!, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "route").at(-1).route).toMatchObject({ purpose: "user", tier: "standard", provider: "foundry", model: "grok-4-7" });
    // chat models were registered with Pi at session start, with command-based credentials
    expect(Object.keys(providers).sort()).toEqual(["foundry", "local"]);
    expect((providers.foundry as { apiKey: string }).apiKey).toMatch(/^!az account get-access-token --resource 'https:\/\/ai\.azure\.com'/);
  });

  it("serves a security-sensitive turn from the premium tier and reports it", async () => {
    const { app, cwd } = await builtWorkflow();
    mkdirSync(path.join(cwd, ".pi-workflows"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), tieredYaml());
    bindWorkflow(app);
    const { handlers, route } = fakePi();
    handlers.get("session_start")!({}, { cwd });
    const ctx = { modelRegistry: registry };
    const picked = await route().route({ reason: "user", messages: [user("change auth and permissions for production secrets")] }, ctx);
    expect(["anthropic", "openai"]).toContain(picked.model.provider);
    expect(app.store.readActive()).toBeTruthy();
  });

  it("still works when the context has no UI", async () => {
    const { app, cwd } = await builtWorkflow();
    bindWorkflow(app);
    const { handlers, route } = fakePi();
    handlers.get("session_start")!({}, { cwd });
    const picked = await route().route({ reason: "user", messages: [user("add a retry counter to the parser")] }, { modelRegistry: registry });
    expect(picked.model.provider).toBeTruthy();
  });
});

describe("/advisor command", () => {
  it("is listed, dispatches to the workflow, and shows the answer without changing the phase", async () => {
    expect(COMMANDS.map((c) => c.name)).toContain("advisor");
    const { app, cwd } = await builtWorkflow();
    bindWorkflow(app);
    const { commands } = fakePi();
    const notes: string[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      // no advisor models in the legacy test config, so the command explains that instead of calling anything
      ui: { notify: (text: string) => notes.push(text), setStatus() {}, confirm: async () => true },
      modelRegistry: { find: () => undefined, complete: async () => { throw new Error("must not be called"); } },
      newSession: async () => ({ cancelled: false }),
      compact() {},
    };
    const phase = app.store.load(app.activeTaskId()!)!.phase;
    await commands.get("advisor")!.handler("is this safe?", ctx);
    expect(notes.at(-1)).toMatch(/No advisor models are configured/);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe(phase);
  });

  it("calls the advisor through Pi's model registry, ledgers it, and prints the answer", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), rng: seededRng(9) });
    await app.plan(singleTaskRequest);
    bindWorkflow(app);
    const { commands } = fakePi();
    const notes: string[] = [];
    const calls: { model: unknown; system?: string }[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      ui: { notify: (text: string) => notes.push(text), setStatus() {}, confirm: async () => true },
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id }),
        isUsingOAuth: () => true,
        complete: async (model: unknown, context: { systemPrompt?: string }) => {
          calls.push({ model, system: context.systemPrompt });
          return { content: [{ type: "text", text: "Ship it behind a flag." }], usage: { input: 321, output: 12, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" };
        },
      },
      newSession: async () => ({ cancelled: false }),
      compact() {},
    };
    const phase = app.store.load(app.activeTaskId()!)!.phase;
    await commands.get("advisor")!.handler("should we ship?", ctx);
    expect(notes.at(-1)).toContain("Ship it behind a flag.");
    expect(calls).toHaveLength(1);
    expect(["claude-fable-5-1", "gpt-6-astra"]).toContain((calls[0]!.model as { id: string }).id);
    expect(app.store.readLedger().find((r) => r.tier === "advisor")).toMatchObject({ inputTokens: 321, outputTokens: 12 });
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe(phase);
  });
});

describe("registry chat", () => {
  const reply = { content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, stopReason: "stop" };

  it("refuses openai and anthropic unless Pi is using an account login for the model", async () => {
    const chat = createRegistryChat({ find: (provider, id) => ({ provider, id }), isUsingOAuth: () => false, complete: async () => reply });
    await expect(chat({ provider: "anthropic", model: "claude-fable-5-1" }, { messages: [{ role: "user", content: "q" }] })).rejects.toMatchObject({ code: "API_KEY_REJECTED" });
    const foundry = await chat({ provider: "foundry", model: "gpt-6-astra" }, { messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }] });
    expect(foundry).toMatchObject({ text: "ok", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, requests: 1 }, provider: "foundry" });
  });

  it("surfaces provider errors and unregistered models", async () => {
    const failing = createRegistryChat({ find: (provider, id) => ({ provider, id }), complete: async () => ({ ...reply, stopReason: "error", errorMessage: "boom" }) });
    await expect(failing({ provider: "local", model: "m" }, { messages: [{ role: "user", content: "q" }] })).rejects.toThrow("boom");
    const missing = createRegistryChat({ find: () => undefined, complete: async () => reply });
    await expect(missing({ provider: "local", model: "m" }, { messages: [{ role: "user", content: "q" }] })).rejects.toThrow(/not registered/);
  });
});
