import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { COMMANDS } from "../src/commands.js";
import extension, { bindHerdrClient, bindWorkflow, currentWorkflow, registerExtensionTools, registerWorkflow } from "../src/extension.js";
import { isDeniedCommand } from "../src/sandbox.js";
import { fakeHerdrClient } from "./herdr-fake.js";
import { builtWorkflow, sampleTicket, tempRepo, ticketWorkflow } from "./helpers.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("pi extension surface", () => {
  it("registers the spec commands with completions", async () => {
    const commands = new Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => { value: string }[] | null; handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options);
      },
      on() { return () => undefined; },
      appendEntry() {},
      setModel: async () => false,
    };
    registerWorkflow(pi as unknown as ExtensionAPI);
    for (const spec of COMMANDS) {
      expect(commands.get(spec.name)?.description).toBeTruthy();
    }
    expect(COMMANDS.map((spec) => spec.name)).toEqual(["plan", "show-plan", "plans", "build", "review", "cost"]);
    expect([...commands.keys()].sort()).toEqual([...COMMANDS.map((spec) => spec.name)].sort());
    const completions = await commands.get("cost")?.getArgumentCompletions?.("j");
    expect(completions?.map((item) => item.value)).toEqual(["json"]);
  });

  function fakePi() {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(event, handler);
        return () => undefined;
      },
      appendEntry() {},
    };
    registerWorkflow(pi as unknown as ExtensionAPI);
    return { commands, handlers };
  }

  it("keeps one workflow across commands", async () => {
    const { app, cwd } = await builtWorkflow();
    const { commands } = fakePi();
    bindWorkflow(app);
    const ctx = {
      cwd,
      hasUI: true,
      ui: { notify() {}, setStatus() {}, confirm: async () => true },
      compact() {},
    };
    await commands.get("plans")!.handler("", ctx);
    expect(currentWorkflow()).toBe(app);
    await commands.get("cost")!.handler("", ctx);
    expect(currentWorkflow()).toBe(app);
    bindWorkflow(undefined);
  });

  it("does not start a ticket when Pi does not know the routed model or has no login for it", async () => {
    bindHerdrClient(() => fakeHerdrClient().client);
    for (const registry of [{ find: () => undefined }, { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => false }]) {
      const { cwd, app } = await ticketWorkflow([sampleTicket("01")]);
      const { commands } = fakePi();
      bindWorkflow(app);
      const notices: string[] = [];
      await commands.get("build")!.handler("", {
        cwd,
        hasUI: true,
        model: { provider: "openai", id: "gpt-user" },
        modelRegistry: registry,
        ui: { notify: (message: string) => notices.push(message), setStatus() {}, confirm: async () => true },
        compact() {},
      });
      // Routing applies the preflight's test to the model it picked, so a model Pi cannot open is a stop that names it and why.
      const text = notices.join("\n");
      expect(text).toContain("Ticket 01 cannot start on anthropic/claude-sonnet-5-5");
      expect(text).toContain(registry.hasConfiguredAuth ? "provider anthropic has no login or key in Pi (run /login anthropic)" : "model claude-sonnet-5-5 is not among the anthropic provider's registered models");
      expect(text).toContain("Fix models.medium or sign in");
      const state = app.store.load(app.activeTaskId()!)!;
      expect(state.ticketRuns?.["01"]).toBeUndefined();
      expect(state.build!.currentTicket).toBeUndefined();
      bindWorkflow(undefined);
    }
    bindHerdrClient(undefined);
  });

  it("the preflight uses the same test and names the reason when Pi changes after routing chose the model", async () => {
    // Pass 1 counts the registry lookups routing and the preflight make before a ticket starts; pass 2 loses the model at the last one.
    let lookups = 0;
    let loseAt = Number.POSITIVE_INFINITY;
    const notices: string[] = [];
    for (const pass of [1, 2]) {
      const { cwd, app } = await ticketWorkflow([sampleTicket("01")]);
      const { commands } = fakePi();
      bindWorkflow(app);
      lookups = 0;
      let seen = 0;
      // The runner's herdr check comes right after the preflight (the second `self()` call; the first is /build's own check
      // before it starts), so `seen` is the lookups routing and the preflight made. It then refuses, so no ticket runs.
      const registry = {
        find: (provider: string, id: string) => (++lookups >= loseAt ? undefined : { provider, id }),
        hasConfiguredAuth: () => true,
      };
      const base = fakeHerdrClient().client;
      let selfCalls = 0;
      bindHerdrClient(() => ({
        ...base,
        self: async () => {
          if (++selfCalls === 1) return { terminal: "t0", space: "sp1" };
          seen = lookups;
          return { problem: "stop here" };
        },
      }));
      await commands.get("build")!.handler("", {
        cwd,
        hasUI: true,
        model: { provider: "openai", id: "gpt-user" },
        modelRegistry: registry,
        ui: { notify: (message: string) => notices.push(message), setStatus() {}, confirm: async () => true },
        compact() {},
      });
      if (pass === 1) loseAt = seen;
      bindWorkflow(undefined);
    }
    bindHerdrClient(undefined);
    expect(Number.isFinite(loseAt)).toBe(true);
    expect(notices.join("\n")).toContain("Ticket 01 cannot start on anthropic/claude-sonnet-5-5: model claude-sonnet-5-5 is not among the anthropic provider's registered models. Fix the models config or sign in, then /build again.");
  });

  it("registers a config change with the live session's pi, not the replaced one the /build module holds", async () => {
    const cwd = await tempRepo();
    // `local` is read from the user config only.
    const priorHome = process.env.HOME;
    const home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    process.env.HOME = home;
    const configFile = path.join(home, ".pi", "agent", "chef.yaml");
    mkdirSync(path.dirname(configFile), { recursive: true });
    const write = (model: string) => writeFileSync(configFile, `local:\n  baseUrl: http://127.0.0.1:11434/v1\n  models:\n    - { id: "${model}", contextWindow: 65536 }\n`);
    write("qwen3.5:9b");
    const registered: { pi: string; models: string[] }[] = [];
    const piFor = (name: string) => {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
      return {
        handlers,
        commands,
        pi: {
          registerCommand: (command: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(command, options),
          on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => (handlers.set(event, handler), () => undefined),
          appendEntry() {},
          setModel: async () => true,
          registerProvider: (provider: string, config: { models?: { id: string }[] }) => void registered.push({ pi: name, models: (config.models ?? []).map((model) => `${provider}/${model.id}`) }),
        },
      };
    };
    const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined, getEntries: () => [] }, ui: { notify() {}, setStatus() {} } };
    bindWorkflow(undefined);
    const first = piFor("first");
    registerWorkflow(first.pi as unknown as ExtensionAPI);
    first.handlers.get("session_start")!({}, ctx);
    expect(registered.at(-1)).toEqual({ pi: "first", models: ["local/qwen3.5:9b"] });
    // A ticket session loads its own copy of the module, whose session_start points registration at its pi.
    const second = piFor("second");
    (globalThis as Record<symbol, unknown>)[Symbol.for("pi-chef.providers")] = { register: second.pi.registerProvider };
    write("Qwen3.8-27B");
    await first.commands.get("cost")!.handler("", ctx);
    expect(registered.at(-1)).toEqual({ pi: "second", models: ["local/Qwen3.8-27B"] });
    bindWorkflow(undefined);
    process.env.HOME = priorHome;
  });

  it("blocks destructive shell commands", () => {
    expect(isDeniedCommand("rm -rf /")).toBe(true);
    expect(isDeniedCommand("git push --force origin main")).toBe(true);
    expect(isDeniedCommand("npm test")).toBe(false);
  });
});

describe("installed Pi providers", () => {
  it("ships account login for OpenAI and Anthropic and not for Azure", () => {
    const openai = openaiProvider();
    const anthropic = anthropicProvider();
    const codex = openaiCodexProvider();
    const azure = azureProvider();
    expect(openai.auth.oauth?.name).toMatch(/ChatGPT/);
    expect(openai.auth.oauth?.isSubscription).toBe(true);
    expect(openai.auth.apiKey).toBeTruthy();
    expect(anthropic.auth.oauth?.name).toMatch(/Claude Pro\/Max/);
    expect(anthropic.auth.oauth?.isSubscription).toBe(true);
    expect(codex.auth.oauth?.isSubscription).toBe(true);
    expect(codex.auth.apiKey).toBeUndefined();
    expect(azure.auth.oauth).toBeUndefined();
    expect(azure.auth.apiKey?.name).toMatch(/API key/);
  });
});

describe("web tools", () => {
  type Tool = { name: string; execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: { text: string }[] }> };
  const searchBody = {
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 2 } },
    content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.example/1", title: "A" }] }],
  };
  const deps = {
    getAuth: async () => ({ accessToken: "sk-ant-oat01-test" }),
    searchTransport: async () => ({ status: 200, body: searchBody }),
  };
  function tools(overrides = deps) {
    const registered = new Map<string, Tool>();
    registerExtensionTools({ registerTool: (tool: unknown) => void registered.set((tool as Tool).name, tool as Tool) } as unknown as ExtensionAPI, overrides);
    return registered;
  }

  it("registers the web and plan tools from the extension factory", () => {
    const registered = new Map<string, unknown>();
    const pi = { registerCommand() {}, on() { return () => undefined; }, appendEntry() {}, registerTool: (tool: { name: string }) => void registered.set(tool.name, tool) };
    extension(pi as unknown as ExtensionAPI);
    expect([...registered.keys()].sort()).toEqual(["plan_questions", "plan_spec", "plan_tickets", "web_fetch", "web_search"]);
  });

  it("ledgers search usage without the query text and shows the route status", async () => {
    const { app } = await builtWorkflow();
    const statuses: string[] = [];
    app.bind({ status: (text) => text && statuses.push(text) });
    bindWorkflow(app);
    const before = app.store.readLedger().length;
    await tools().get("web_search")!.execute("1", { query: "secret-topic-xyz" }, undefined, undefined, {});
    const added = app.store.readLedger().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5", tier: "web_search", taskId: app.activeTaskId(), inputTokens: 100, outputTokens: 50, requests: 1 });
    expect(JSON.stringify(added[0])).not.toContain("secret-topic-xyz");
    expect(statuses).toContain("anthropic/claude-haiku-5-5 · web_search");
    bindWorkflow(undefined);
  });

  it("denies web_search when the budget is hard-exhausted", async () => {
    const { app } = await builtWorkflow();
    bindWorkflow(app);
    app.store.appendLedger({
      id: "big", at: new Date().toISOString(), taskId: app.activeTaskId()!, phase: "IMPLEMENTING", provider: "openai", model: "gpt-5.4", tier: "premium",
      requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, actualUsd: 9999, usageKnown: true, outcome: "success", retries: 0, reason: "test",
    });
    let called = false;
    const registered = tools({ ...deps, searchTransport: async () => ((called = true), { status: 200, body: searchBody }) });
    await expect(registered.get("web_search")!.execute("1", { query: "q" }, undefined, undefined, {})).rejects.toThrow(/budget/i);
    expect(called).toBe(false);
    bindWorkflow(undefined);
  });
});
