import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../src/config.js";
import { bindWorkflow, registerWorkflow } from "../src/extension.js";
import type { Workflow } from "../src/orchestrator/service.js";
import { contextOf, readyAuth, sampleTicket, tempRepo, ticketWorkflow, tieredYaml, workflow } from "./helpers.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ModelRef = { provider: string; id: string };

const RESTORE_MODEL = Symbol.for("pi-chef.restore-model");
const RESTORE_DONE = Symbol.for("pi-chef.restore-done");
const slots = globalThis as { [RESTORE_MODEL]?: ModelRef; [RESTORE_DONE]?: Promise<void> };

const priorHome = process.env.HOME;
beforeEach(() => {
  // No user config from the machine running the tests.
  process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-home-"));
  delete slots[RESTORE_MODEL];
  delete slots[RESTORE_DONE];
});
afterEach(() => {
  process.env.HOME = priorHome;
  bindWorkflow(undefined);
  delete slots[RESTORE_MODEL];
  delete slots[RESTORE_DONE];
});

function fakePi(setModelResult: boolean | "throw" = true) {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, Handler>();
  const setModelCalls: ModelRef[] = [];
  const onSetModel: { run?: (model: ModelRef) => void } = {};
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => undefined;
    },
    appendEntry() {},
    async setModel(model: ModelRef) {
      setModelCalls.push(model);
      if (setModelResult === "throw") throw new Error("no key");
      if (setModelResult) onSetModel.run?.(model);
      return setModelResult;
    },
  };
  registerWorkflow(pi as unknown as ExtensionAPI);
  return { commands, handlers, setModelCalls, onSetModel };
}

function writeProject(cwd: string, yaml: string): void {
  mkdirSync(path.join(cwd, ".pi-workflows"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), yaml);
}

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };

describe("session_start pins the session model", () => {
  async function start(options: { model?: ModelRef; yaml?: string; userYaml?: string; setModel?: boolean | "throw"; find?: boolean; pending?: ModelRef }) {
    const cwd = await tempRepo();
    if (options.yaml) writeProject(cwd, options.yaml);
    if (options.userYaml) {
      mkdirSync(path.join(process.env.HOME!, ".pi", "agent"), { recursive: true });
      writeFileSync(path.join(process.env.HOME!, ".pi", "agent", "chef.yaml"), options.userYaml);
    }
    const pi = fakePi(options.setModel);
    const notices: string[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      model: options.model,
      modelRegistry: { find: (provider: string, id: string) => (options.find === false ? undefined : { provider, id }) },
      ui: { notify: (message: string) => notices.push(message), setStatus() {} },
    };
    if (options.pending) slots[RESTORE_MODEL] = options.pending;
    pi.handlers.get("session_start")!({}, ctx);
    await slots[RESTORE_DONE];
    return { ...pi, notices };
  }

  it("sets session.model when the session started on another model", async () => {
    const { setModelCalls, notices } = await start({ model: { provider: "openai", id: "gpt-x" } });
    expect(setModelCalls).toEqual([OPUS]);
    expect(notices.filter((text) => text.includes("Could not switch"))).toEqual([]);
  });

  it("sets it when Pi has no current model yet, and leaves a session already on it alone", async () => {
    expect((await start({ model: undefined })).setModelCalls).toEqual([OPUS]);
    expect((await start({ model: OPUS })).setModelCalls).toEqual([]);
  });

  it("reads session.model from the config", async () => {
    const { setModelCalls } = await start({ model: OPUS, userYaml: "session: { model: openai/gpt-6.1-sol }\n" });
    expect(setModelCalls).toEqual([{ provider: "openai", id: "gpt-6.1-sol" }]);
  });

  it("ignores a project session.model: only the user config picks the session model", async () => {
    const { setModelCalls } = await start({ model: OPUS, yaml: "session: { model: openai/gpt-6.1-sol }\n" });
    expect(setModelCalls).toEqual([]);
  });

  it("leaves a /build model alone: the pending slot wins", async () => {
    const { setModelCalls } = await start({ model: { provider: "openai", id: "gpt-x" }, pending: { provider: "xai", id: "grok-4.7" } });
    expect(setModelCalls).toEqual([{ provider: "xai", id: "grok-4.7" }]);
  });

  it("leaves the user's model alone when session.pin is false", async () => {
    const { setModelCalls, notices } = await start({ model: { provider: "openai", id: "gpt-x" }, yaml: "session: { pin: false }\n" });
    expect(setModelCalls).toEqual([]);
    expect(notices.filter((text) => text.includes("Could not switch"))).toEqual([]);
  });

  it("warns once when Pi refuses the switch, throws, or the model is unknown", async () => {
    for (const options of [{ setModel: false }, { setModel: "throw" as const }, { find: false }]) {
      const { notices } = await start({ model: { provider: "openai", id: "gpt-x" }, ...options });
      expect(notices.filter((text) => text.includes("Could not switch to anthropic/claude-opus-5-5"))).toHaveLength(1);
    }
  });
});

describe("/build with pinning", () => {
  async function build(pin: boolean) {
    const { cwd, app } = await ticketWorkflow([sampleTicket("01", { suggestedTier: "standard" })]);
    app.reconfigure({ ...app.config, session: { ...app.config.session, pin } });
    const { commands, handlers, setModelCalls, onSetModel } = fakePi();
    bindWorkflow(app);
    const user: ModelRef = { provider: "openai", id: "gpt-user" };
    const registry = { find: (provider: string, id: string) => ({ provider, id }), isUsingOAuth: () => true, getAvailable: () => [] };
    let current: Record<string, unknown> | undefined;
    const sessionCtx = (): Record<string, unknown> => {
      const ctx: Record<string, unknown> = {
        cwd,
        hasUI: true,
        model: { provider: "default", id: "model" },
        modelRegistry: registry,
        ui: { notify() {}, setStatus() {}, confirm: async () => true },
        async sendMessage() {},
        async sendUserMessage() {
          writeFileSync(path.join(cwd, "f1.txt"), "x\n");
          handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "Done.\n- [x] retry works" }], provider: "anthropic", model: "claude-sonnet-5-5", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } }, {});
        },
        async waitForIdle() {
          handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, {});
        },
        async newSession(options?: { withSession?: (next: unknown) => Promise<void> }) {
          const next = sessionCtx();
          onSetModel.run = (model) => {
            next.model = model;
          };
          handlers.get("session_start")!({}, next);
          current = next;
          await options?.withSession?.(next);
          return { cancelled: false };
        },
      };
      return ctx;
    };
    const first = sessionCtx();
    first.model = user;
    await commands.get("build")!.handler("", first);
    return { setModelCalls, current: current!, app };
  }

  it("puts the session back on session.model when pinning is on", async () => {
    const { setModelCalls, current, app } = await build(true);
    expect(setModelCalls.map((model) => model.id)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(current.model).toEqual(OPUS);
    expect(Object.values(app.store.load(app.activeTaskId()!)!.ticketRuns!).map((run) => run.status)).toEqual(["done"]);
  });

  it("puts the user's own model back when pinning is off", async () => {
    const { setModelCalls, current } = await build(false);
    expect(setModelCalls.map((model) => model.id)).toEqual(["claude-sonnet-5-5", "gpt-user"]);
    expect(current.model).toEqual({ provider: "openai", id: "gpt-user" });
  });
});

describe("session_before_compact", () => {
  const HAIKU_ONLY = tieredYaml().replace("    - { provider: openai, model: gpt-6-luna }\n    - { provider: anthropic, model: claude-haiku-5-5 }", "    - { provider: anthropic, model: claude-haiku-5-5 }");
  const now = () => new Date("2026-10-14T12:00:00.000Z");

  async function setup(options: { reply?: () => Promise<unknown>; signedIn?: boolean; unpriced?: boolean } = {}) {
    const cwd = await tempRepo();
    const config = parseConfig(HAIKU_ONLY);
    if (options.unpriced) config.pricing = config.pricing.filter((row) => row.model !== "claude-haiku-5-5");
    const app = workflow(cwd, { config, now, auth: readyAuth(options.signedIn === false ? "missing" : "ready") });
    const pi = fakePi();
    bindWorkflow(app);
    const calls: { model: ModelRef; context: { systemPrompt?: string; messages: { content: string }[] }; options?: { maxTokens?: number } }[] = [];
    const modelRegistry = {
      find: (provider: string, id: string) => ({ provider, id }),
      isUsingOAuth: () => true,
      getAvailable: () => [],
      complete: async (model: ModelRef, context: (typeof calls)[number]["context"], callOptions?: { maxTokens?: number }) => {
        calls.push({ model, context, options: callOptions });
        return (
          (await options.reply?.()) ?? { content: [{ type: "text", text: "Goal: fix src/a.ts. Open: tests." }], usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" }
        );
      },
    };
    const run = (extra: Record<string, unknown> = {}) =>
      pi.handlers.get("session_before_compact")!(
        {
          type: "session_before_compact",
          preparation: {
            messagesToSummarize: [
              { role: "user", content: "fix the bug in src/a.ts", timestamp: 1 },
              { role: "assistant", content: [{ type: "text", text: "Edited src/a.ts; npm test fails with E_PARSE." }], timestamp: 2 },
            ],
            turnPrefixMessages: [],
            isSplitTurn: false,
            firstKeptEntryId: "entry-7",
            tokensBefore: 90_000,
          },
          branchEntries: [],
          reason: "threshold",
          willRetry: false,
          signal: new AbortController().signal,
          ...extra,
        },
        { cwd, hasUI: true, modelRegistry, ui: { notify() {}, setStatus() {} } },
      ) as Promise<{ compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage: { input: number; output: number } } } | undefined>;
    return { app, calls, run };
  }

  it("summarizes the discarded messages with the compaction tier (Haiku) and returns Pi's compaction shape", async () => {
    const { app, calls, run } = await setup();
    const result = await run();
    expect(result?.compaction).toMatchObject({ summary: "Goal: fix src/a.ts. Open: tests.", firstKeptEntryId: "entry-7", tokensBefore: 90_000, usage: { input: 1000, output: 200 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toEqual({ provider: "anthropic", id: "claude-haiku-5-5" });
    expect(calls[0]!.context.systemPrompt).toMatch(/file path/);
    expect(calls[0]!.context.systemPrompt).toMatch(/Open tasks/);
    expect(calls[0]!.context.systemPrompt).toMatch(/Errors/);
    expect(calls[0]!.context.messages[0]!.content).toContain("[User]: fix the bug in src/a.ts");
    expect(calls[0]!.context.messages[0]!.content).toContain("npm test fails with E_PARSE");
    const entries = app.store.readLedger().filter((item) => item.reason === "compaction");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5", tier: "cheap", inputTokens: 1000, outputTokens: 200, outcome: "success" });
  });

  it("honours custom instructions and folds in the previous summary", async () => {
    const { calls, run } = await setup();
    const base = {
      messagesToSummarize: [{ role: "user", content: "next step", timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      firstKeptEntryId: "e1",
      tokensBefore: 10,
      previousSummary: "Earlier: set up the repo.",
    };
    await run({ customInstructions: "focus on the migration plan", preparation: base });
    const prompt = calls[0]!.context.messages[0]!.content;
    expect(prompt).toContain("focus on the migration plan");
    expect(prompt).toContain("Earlier: set up the repo.");
  });

  it("returns undefined when the call fails, and ledgers the failure with unknown cost", async () => {
    const { app, run } = await setup({
      reply: async () => {
        throw new Error("overloaded");
      },
    });
    await expect(run()).resolves.toBeUndefined();
    const entries = app.store.readLedger().filter((item) => item.reason === "compaction");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "failure", actualUsd: null });
  });

  it("omits usage when the price is unknown instead of reporting $0, and ledgers it once with null", async () => {
    const { app, run } = await setup({ unpriced: true });
    const result = await run();
    expect(result?.compaction?.summary).toBe("Goal: fix src/a.ts. Open: tests.");
    expect(result?.compaction).not.toHaveProperty("usage");
    const entries = app.store.readLedger().filter((item) => item.reason === "compaction");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actualUsd).toBeNull();
  });

  it("does not call a model or ledger anything when the workflow is shutting down", async () => {
    const { app, calls, run } = await setup();
    contextOf(app).shutdown.abort();
    await expect(run()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(app.store.readLedger().filter((item) => item.reason === "compaction")).toHaveLength(0);
  });

  it("returns undefined for an empty summary and for an aborted or malformed event, never throwing", async () => {
    const empty = await setup({ reply: async () => ({ content: [{ type: "text", text: "  " }], usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" }) });
    await expect(empty.run()).resolves.toBeUndefined();
    const ok = await setup();
    const aborted = new AbortController();
    aborted.abort();
    await expect(ok.run({ signal: aborted.signal })).resolves.toBeUndefined();
    await expect(ok.run({ preparation: undefined })).resolves.toBeUndefined();
    expect(ok.calls).toHaveLength(0);
  });

  it("falls back to Pi's own compaction on a hard budget, without calling a model", async () => {
    const { app, calls, run } = await setup();
    app.store.appendLedger({
      id: "big", at: "2026-10-14T10:00:00.000Z", taskId: "session", phase: "IDLE", provider: "anthropic", model: "claude-sonnet-5-5", tier: "interactive",
      requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd: 9999, usageKnown: true, outcome: "success", retries: 0, reason: "test",
    });
    await expect(run()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("falls back when the compaction tier has no usable model (not signed in)", async () => {
    const { calls, run } = await setup({ signedIn: false });
    await expect(run()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("input budget gate", () => {
  const now = () => new Date("2026-10-14T12:00:00.000Z");
  const spend = (app: Workflow, usd: number) =>
    app.store.appendLedger({
      id: `spend-${usd}`, at: "2026-10-14T10:00:00.000Z", taskId: "session", phase: "IDLE", provider: "anthropic", model: "claude-sonnet-5-5", tier: "interactive",
      requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd: usd, usageKnown: true, outcome: "success", retries: 0, reason: "test",
    });

  async function setup() {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: parseConfig(tieredYaml()), now });
    const { handlers } = fakePi();
    bindWorkflow(app);
    const notices: string[] = [];
    const ctx = { cwd, hasUI: true, ui: { notify: (message: string, level?: string) => notices.push(`${level}: ${message}`), setStatus() {} } };
    const input = (text: string, source = "interactive") => handlers.get("input")!({ type: "input", text, source }, ctx) as { action: string };
    return { app, input, notices, handlers, ctx };
  }

  it("lets everything through under budget", async () => {
    const { input, notices } = await setup();
    expect(input("add a retry counter")).toEqual({ action: "continue" });
    expect(notices).toEqual([]);
  });

  it("blocks a prompt on a hard budget but lets commands and extension-sent input through", async () => {
    const { app, input, notices } = await setup();
    spend(app, 9999);
    expect(input("add a retry counter")).toEqual({ action: "handled" });
    expect(notices).toEqual(["warning: Task or daily budget is exhausted. Run /cost for details."]);
    for (const text of ["/cost", "/status", "  /plan fix it", "/skill:review x"]) expect(input(text)).toEqual({ action: "continue" });
    // A path at the start of a prompt is not a command.
    expect(input("/tmp/app.log shows an error, why?")).toEqual({ action: "handled" });
    expect(input("# Ticket 01: build", "extension")).toEqual({ action: "continue" });
    expect(notices).toHaveLength(2);
  });

  it("notifies once per session on a soft budget and always continues", async () => {
    const { app, input, notices, handlers, ctx } = await setup();
    spend(app, 65);
    expect(input("first prompt")).toEqual({ action: "continue" });
    expect(input("second prompt")).toEqual({ action: "continue" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^warning: Budget warning/);
    // A new session shows it again.
    handlers.get("session_start")!({}, { ...ctx, model: { provider: "anthropic", id: "claude-opus-5-5" }, modelRegistry: { find: () => undefined } });
    expect(input("third prompt")).toEqual({ action: "continue" });
    expect(notices.filter((text) => text.includes("Budget warning"))).toHaveLength(2);
  });
});
