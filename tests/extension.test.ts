import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { COMMANDS } from "../src/commands.js";
import extension, { bindWorkflow, currentWorkflow, registerExtensionTools, registerWorkflow } from "../src/extension.js";
import { isDeniedCommand } from "../src/sandbox.js";
import { builtWorkflow, sampleTicket, tempRepo, ticketWorkflow } from "./helpers.js";
import { writeFileSync } from "node:fs";
import path from "node:path";

describe("pi extension surface", () => {
  it("registers the spec commands with completions", async () => {
    const cwd = await tempRepo();
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
    expect(COMMANDS.map((spec) => spec.name)).toEqual(["plan", "show-plan", "plans", "build", "review", "advisor", "cost", "status", "auth"]);
    expect([...commands.keys()].sort()).toEqual([...COMMANDS.map((spec) => spec.name), "chef"].sort());
    const auth = commands.get("auth");
    const completions = await auth?.getArgumentCompletions?.("login an");
    expect(completions?.map((item) => item.value)).toContain("anthropic");
  });

  function fakePi() {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const setModelCalls: { provider: string; id: string }[] = [];
    const onSetModel: { run?: (model: { provider: string; id: string }) => void } = {};
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(event, handler);
        return () => undefined;
      },
      appendEntry() {},
      async setModel(model: { provider: string; id: string }) {
        setModelCalls.push(model);
        onSetModel.run?.(model);
        return true;
      },
    };
    registerWorkflow(pi as unknown as ExtensionAPI);
    return { commands, handlers, setModelCalls, onSetModel };
  }

  it("keeps one workflow across commands", async () => {
    const { app, cwd } = await builtWorkflow();
    const { commands } = fakePi();
    bindWorkflow(app);
    const ctx = {
      cwd,
      hasUI: true,
      ui: { notify() {}, setStatus() {}, confirm: async () => true },
      newSession: async () => ({ cancelled: false }),
      compact() {},
    };
    await commands.get("status")!.handler("", ctx);
    expect(currentWorkflow()).toBe(app);
    await commands.get("cost")!.handler("", ctx);
    expect(currentWorkflow()).toBe(app);
    bindWorkflow(undefined);
  });

  it("drives /build through fresh sessions: model slot, newSession on the live ctx, last text, and the user's model put back", async () => {
    const { cwd, app } = await ticketWorkflow([sampleTicket("01", { suggestedTier: "standard" }), sampleTicket("02", { suggestedTier: "standard", blockedBy: ["01"] })]);
    const { commands, handlers, setModelCalls, onSetModel } = fakePi();
    bindWorkflow(app);
    const slot = Symbol.for("pi-chef.restore-model");
    const original = { provider: "openai", id: "gpt-user" };
    const registryFor = { find: (provider: string, id: string) => ({ provider, id }), isUsingOAuth: () => true, getAvailable: () => [] };
    const log: string[] = [];
    const notices: string[] = [];
    const statuses: string[] = [];
    const bashHook = (command: string) => handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "t", input: { command } }, {});
    let sessions = 0;
    let current: Record<string, unknown> | undefined;
    const sessionCtx = (opener: string): Record<string, unknown> => {
      const ctx: Record<string, unknown> = {
        cwd,
        hasUI: true,
        model: { provider: "default", id: "model" },
        modelRegistry: registryFor,
        ui: { notify: (message: string) => notices.push(message), setStatus: (key: string, text?: string) => void statuses.push(`${key}=${text ?? ""}`), confirm: async () => true },
        async sendMessage() {},
        async sendUserMessage(text: string) {
          const ticket = text.match(/^# Ticket (\d+):/m)![1]!;
          log.push(`send ${ticket} on ${(ctx.model as { id: string }).id} via ${opener}`);
          // The hook sees the running ticket and refuses a push or a branch move, but not ordinary commands.
          expect(await bashHook("git push origin HEAD")).toMatchObject({ block: true, reason: expect.stringContaining("/build commits each ticket") });
          expect(await bashHook("git switch main")).toMatchObject({ block: true });
          expect(await bashHook("npm test")).toBeUndefined();
          writeFileSync(path.join(cwd, `f${ticket}.txt`), "x\n");
          handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: `Done ${ticket}.\n- [x] retry works` }], provider: "anthropic", model: "claude-sonnet-5-5", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } }, {});
        },
        async waitForIdle() {
          log.push("idle");
          handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, {});
        },
        async newSession(options?: { withSession?: (next: unknown) => Promise<void> }) {
          sessions += 1;
          const next = sessionCtx(`session ${sessions}`);
          // Pi starts the session on its default model; session_start puts the routed one back.
          onSetModel.run = (model) => {
            next.model = model;
          };
          expect((globalThis as Record<symbol, unknown>)[slot]).toMatchObject({ provider: "anthropic", id: "claude-sonnet-5-5" });
          handlers.get("session_start")!({}, next);
          current = next;
          await options?.withSession?.(next);
          return { cancelled: false };
        },
        compact() {},
      };
      return ctx;
    };
    const first = sessionCtx("command");
    first.model = original;
    await commands.get("build")!.handler("", first);
    expect(log).toEqual(["send 01 on claude-sonnet-5-5 via session 1", "idle", "send 02 on claude-sonnet-5-5 via session 2", "idle"]);
    expect(sessions).toBe(2);
    // Pinning is on by default: finish() puts the session on session.model, not on the model the command started on.
    expect(setModelCalls.map((model) => model.id)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(current!.model).toEqual({ provider: "anthropic", id: "claude-opus-5-5" });
    expect((globalThis as Record<symbol, unknown>)[slot]).toBeUndefined();
    const state = app.store.load(app.activeTaskId()!)!;
    expect(Object.values(state.ticketRuns!).map((run) => run.status)).toEqual(["done", "done"]);
    expect(state.ticketRuns!["01"]!.summary).toContain("Done 01.");
    expect(app.store.readLedger().filter((item) => item.reason.endsWith(" · ticket 02"))).toHaveLength(1);
    // Outside a chunk the branch hook is quiet again.
    expect(await bashHook("git switch main")).toBeUndefined();
    expect(notices.some((text) => text.includes("Built 2 ticket(s)"))).toBe(true);
    // One status line: each ticket's session shows the ticket and its model, and the end shows the next step.
    expect(new Set(statuses.map((item) => item.split("=")[0]))).toEqual(new Set(["chef"]));
    expect(statuses.some((item) => /^chef=chef · .+ · Building · ticket 02 of 2 · anthropic\/claude-sonnet-5-5 · \$\d+\.\d{2}/.test(item))).toBe(true);
    expect(statuses.at(-1)).toMatch(/^chef=chef · .+ · Built · 2 of 2 tickets done · run \/review · \$/);
    bindWorkflow(undefined);
  });

  it("stops /build with a clear message when Pi cancels the new session", async () => {
    const { cwd, app } = await ticketWorkflow([sampleTicket("01")]);
    const { commands } = fakePi();
    bindWorkflow(app);
    const notices: string[] = [];
    await commands.get("build")!.handler("", {
      cwd,
      hasUI: true,
      model: { provider: "openai", id: "gpt-user" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      ui: { notify: (message: string) => notices.push(message), setStatus() {}, confirm: async () => true },
      newSession: async () => ({ cancelled: true }),
      compact() {},
    });
    expect(notices.join("\n")).toContain("did not open a new session");
    expect(app.store.load(app.activeTaskId()!)!.build!.currentTicket).toBeUndefined();
    bindWorkflow(undefined);
  });

  it("does not open a session when Pi does not know the routed model or has no login for it", async () => {
    for (const registry of [{ find: () => undefined }, { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => false }]) {
      const { cwd, app } = await ticketWorkflow([sampleTicket("01")]);
      const { commands } = fakePi();
      bindWorkflow(app);
      const notices: string[] = [];
      let opened = 0;
      await commands.get("build")!.handler("", {
        cwd,
        hasUI: true,
        model: { provider: "openai", id: "gpt-user" },
        modelRegistry: registry,
        ui: { notify: (message: string) => notices.push(message), setStatus() {}, confirm: async () => true },
        newSession: async () => (opened++, { cancelled: false }),
        compact() {},
      });
      expect(opened).toBe(0);
      // Routing applies the preflight's test to every candidate, so nothing usable means a stop that names each one and why.
      const text = notices.join("\n");
      expect(text).toContain("No ticketMedium model is usable: anthropic/claude-sonnet-5-5");
      expect(text).toContain(registry.hasConfiguredAuth ? "provider anthropic has no login (run /login anthropic)" : "model claude-sonnet-5-5 is not among the anthropic provider's registered models");
      const state = app.store.load(app.activeTaskId()!)!;
      expect(state.ticketRuns?.["01"]).toBeUndefined();
      expect(state.build!.currentTicket).toBeUndefined();
      bindWorkflow(undefined);
    }
  });

  it("the preflight uses the same test and names the reason when Pi changes after routing chose the model", async () => {
    // Pass 1 counts the registry lookups routing and the preflight make before a session opens; pass 2 loses the model at the last one.
    let lookups = 0;
    let loseAt = Number.POSITIVE_INFINITY;
    const notices: string[] = [];
    for (const pass of [1, 2]) {
      const { cwd, app } = await ticketWorkflow([sampleTicket("01")]);
      const { commands } = fakePi();
      bindWorkflow(app);
      lookups = 0;
      let seen = 0;
      const registry = { find: (provider: string, id: string) => (++lookups >= loseAt ? undefined : { provider, id }), hasConfiguredAuth: () => true };
      await commands.get("build")!.handler("", {
        cwd,
        hasUI: true,
        model: { provider: "openai", id: "gpt-user" },
        modelRegistry: registry,
        ui: { notify: (message: string) => notices.push(message), setStatus() {}, confirm: async () => true },
        newSession: async () => ((seen = lookups), { cancelled: true }),
        compact() {},
      });
      if (pass === 1) loseAt = seen;
      bindWorkflow(undefined);
    }
    expect(Number.isFinite(loseAt)).toBe(true);
    expect(notices.join("\n")).toContain("Ticket 01 cannot start on anthropic/claude-sonnet-5-5: model claude-sonnet-5-5 is not among the anthropic provider's registered models. Fix the tier config or sign in, then /build again.");
  });

  it("never prints an empty model id when the model to restore is empty or unknown", async () => {
    const { handlers } = fakePi();
    const slot = Symbol.for("pi-chef.restore-model");
    for (const id of ["", "ghost"]) {
      const notices: string[] = [];
      (globalThis as Record<symbol, unknown>)[slot] = { provider: "openai", id };
      handlers.get("session_start")!({}, { cwd: "/", hasUI: true, model: { provider: "default", id: "model" }, modelRegistry: { find: () => undefined, getAvailable: () => [] }, ui: { notify: (message: string) => notices.push(message), setStatus() {} } });
      const text = notices.join("\n");
      expect(text).toContain("Pi does not know");
      expect(text).not.toMatch(/\/model openai\/(\s|\.|$)/);
      expect(text).toContain(id ? "openai/ghost" : "(no model id)");
    }
    delete (globalThis as Record<symbol, unknown>)[slot];
  });

  it("never throws inside withSession: a model mismatch becomes a failed result after newSession returns", async () => {
    const { cwd, app } = await ticketWorkflow([sampleTicket("01")]);
    const { commands } = fakePi();
    bindWorkflow(app);
    const notices: string[] = [];
    let threwInside = false;
    // Like Pi: an error from withSession would escape newSession and kill the app.
    const make = (): Record<string, unknown> => ({
      cwd,
      hasUI: true,
      model: { provider: "anthropic", id: "claude-opus-5-5" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      ui: { notify: (message: string) => notices.push(message), setStatus() {}, confirm: async () => true },
      async sendMessage() {},
      async sendUserMessage() {},
      async newSession(options?: { withSession?: (next: unknown) => Promise<void> }) {
        try {
          await options?.withSession?.(make());
        } catch {
          threwInside = true;
          throw new Error("Failed to create session");
        }
        return { cancelled: false };
      },
      compact() {},
    });
    await expect(commands.get("build")!.handler("", { ...make(), model: undefined })).resolves.toBeUndefined();
    expect(threwInside).toBe(false);
    expect(notices.join("\n")).toContain("so the ticket was not started");
    const state = app.store.load(app.activeTaskId()!)!;
    expect(state.ticketRuns?.["01"]).toBeUndefined();
    expect(state.build!.currentTicket).toBeUndefined();
    bindWorkflow(undefined);
  });

  it("treats an aborted run as a stop and leaves the ticket in progress", async () => {
    const { cwd, app } = await ticketWorkflow([sampleTicket("01"), sampleTicket("02", { blockedBy: ["01"] })]);
    const { commands, handlers } = fakePi();
    bindWorkflow(app);
    const make = (): Record<string, unknown> => ({
      cwd,
      hasUI: true,
      model: { provider: "anthropic", id: "claude-sonnet-5-5" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      ui: { notify() {}, setStatus() {}, confirm: async () => true },
      async sendMessage() {},
      async sendUserMessage() {},
      async waitForIdle() {
        handlers.get("agent_settled")!({ type: "agent_settled", aborted: true }, {});
      },
      async newSession(options?: { withSession?: (next: unknown) => Promise<void> }) {
        await options?.withSession?.(make());
        return { cancelled: false };
      },
      compact() {},
    });
    await commands.get("build")!.handler("", { ...make(), model: undefined });
    const state = app.store.load(app.activeTaskId()!)!;
    expect(state.ticketRuns!["01"]!.status).toBe("in-progress");
    expect(state.ticketRuns!["02"]).toBeUndefined();
    bindWorkflow(undefined);
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
    expect([...registered.keys()].sort()).toEqual(["plan_consult", "plan_questions", "plan_spec", "plan_tickets", "web_fetch", "web_search"]);
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
