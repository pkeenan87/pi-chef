import type { TaskState } from "../src/domain.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../src/config.js";
import { bindHerdrClient, bindWorkflow, currentWorkflow, registerWorkflow } from "../src/extension.js";
import type { Workflow } from "../src/orchestrator/service.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fakeHerdrClient, reviewerWrites, VERDICT, type FakeHerdrClientOptions, type FakeTab } from "./herdr-fake.js";
import { addTask, checkRunner, contextOf, readyAuth, sampleTicket, tempRepo, ticketWorkflow, tieredYaml, workflow } from "./helpers.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ModelRef = { provider: string; id: string; thinking?: string };

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
  bindHerdrClient(undefined);
  bindWorkflow(undefined);
  delete slots[RESTORE_MODEL];
  delete slots[RESTORE_DONE];
});

function fakePi(setModelResult: boolean | "throw" = true) {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, Handler>();
  const setModelCalls: ModelRef[] = [];
  const thinkingCalls: string[] = [];
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
    setThinkingLevel(level: string) {
      thinkingCalls.push(level);
    },
  };
  registerWorkflow(pi as unknown as ExtensionAPI);
  return { commands, handlers, setModelCalls, thinkingCalls, onSetModel };
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

  it("sets a /build ticket's thinking level after its model, and also when the session is already on the model", async () => {
    const switched = await start({ model: { provider: "openai", id: "gpt-x" }, pending: { provider: "xai", id: "grok-4.7", thinking: "high" } });
    expect(switched.setModelCalls).toEqual([{ provider: "xai", id: "grok-4.7" }]);
    expect(switched.thinkingCalls).toEqual(["high"]);
    const same = await start({ model: { provider: "xai", id: "grok-4.7" }, pending: { provider: "xai", id: "grok-4.7", thinking: "low" } });
    expect(same.setModelCalls).toEqual([]);
    expect(same.thinkingCalls).toEqual(["low"]);
  });

  it("leaves the thinking level alone without a tier thinking, or when the model switch failed", async () => {
    expect((await start({ model: { provider: "openai", id: "gpt-x" }, pending: { provider: "xai", id: "grok-4.7" } })).thinkingCalls).toEqual([]);
    expect((await start({ model: { provider: "openai", id: "gpt-x" }, setModel: false, pending: { provider: "xai", id: "grok-4.7", thinking: "high" } })).thinkingCalls).toEqual([]);
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

describe("/build in a ticket subagent", () => {
  // A real Pi ModelRegistry over a runtime with pi-ai's faux provider standing in for Anthropic: the ticket runs in a
  // session pi-chef opens with Pi's SDK, and the user's session is never replaced.
  async function build(runner: "subagent" | "session" = "subagent") {
    const { cwd, app } = await ticketWorkflow([sampleTicket("01", { suggestedTier: "standard" })]);
    app.reconfigure({ ...app.config, isolation: { ...app.config.isolation, worktree: false, runner } });
    const { commands, handlers, setModelCalls } = fakePi();
    bindWorkflow(app);
    const runtime = await ModelRuntime.create({ authPath: path.join(process.env.HOME!, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" }] });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "f1.txt", content: "x\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.\n- [x] retry works")),
    ]);
    const registry = new ModelRegistry(runtime);
    let replaced = 0;
    const ctx: Record<string, unknown> = {
      cwd,
      hasUI: true,
      model: { provider: "anthropic", id: "claude-opus-5-5" },
      modelRegistry: registry,
      ui: { notify() {}, setStatus() {}, setWidget() {}, confirm: async () => true },
      sessionManager: { getSessionFile: () => undefined, getSessionId: () => "main", getEntries: () => [] },
      async sendMessage() {},
      async newSession() {
        replaced += 1;
        return { cancelled: true };
      },
    };
    handlers.get("session_start")!({}, ctx);
    await commands.get("build")!.handler("", ctx);
    return { app, faux, replaced: () => replaced, setModelCalls, cwd };
  }

  it("builds and commits the ticket without replacing the session, and ledgers its turns", async () => {
    const { app, faux, replaced, cwd } = await build();
    const state = app.store.load(app.activeTaskId()!)!;
    expect(state.ticketRuns!["01"]).toMatchObject({ status: "done", provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(replaced()).toBe(0);
    expect(faux.state.callCount).toBe(2);
    expect(readFileSync(path.join(cwd, "f1.txt"), "utf8")).toBe("x\n");
    const ticketRows = app.store.readLedger().filter((row) => row.reason.includes("ticket 01") && row.model === "claude-sonnet-5-5");
    expect(ticketRows).toHaveLength(2);
  });

  it("replaces the session per ticket with isolation.runner: session", async () => {
    const { replaced, faux } = await build("session");
    expect(replaced()).toBe(1);
    expect(faux.state.callCount).toBe(0);
  });
});

describe("/build in a herdr tab", () => {
  const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const reply = (text: string, model = "claude-sonnet-5-5") => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], api: "anthropic-messages", provider: "anthropic", model, usage, stopReason: "stop" as const, timestamp: Date.now() });

  /** The child's session file as Pi's real SessionManager writes it. */
  function childWrites(dir: string, text: string, model?: string): SessionManager {
    const sm = SessionManager.create("/work", dir);
    sm.appendMessage({ role: "user", content: "ticket", timestamp: Date.now() } as never);
    sm.appendMessage(reply(text, model) as never);
    return sm;
  }

  async function build(options: { client?: FakeHerdrClientOptions; checksFail?: boolean; accountKey?: boolean; runner?: "herdr" | "subagent"; before?: (ctx: { cwd: string; sessions: string }) => void; herdrCommand?: string } = {}) {
    let failing = options.checksFail ?? false;
    const { cwd, app } = await ticketWorkflow([sampleTicket("01", { suggestedTier: "standard" })], { runner: checkRunner(async () => (failing ? { code: 1, stdout: "", stderr: "FAIL injected" } : { code: 0, stdout: "ok", stderr: "" })) });
    app.reconfigure({
      ...app.config,
      // The test registry holds no account login; the review's chat path (like every chat path) refuses an account provider without one unless the key is allowed.
      ...(options.accountKey ? { providers: { ...app.config.providers, anthropic: { ...app.config.providers.anthropic, apiKeyFallback: true } as never } } : {}),
      isolation: { ...app.config.isolation, worktree: false, runner: options.runner ?? "herdr", ...(options.herdrCommand ? { herdrCommand: options.herdrCommand } : {}) },
    });
    const sessions = path.join(contextOf(app).store.taskDir(app.activeTaskId()!), "sessions");
    options.before?.({ cwd, sessions });
    const fake = fakeHerdrClient({
      onSend: (tab, text) => {
        writeFileSync(path.join(tab.options.cwd!, "f1.txt"), "x\n");
        childWrites(tab.sessionDir, "Done.\n- [x] retry works");
        void text;
      },
      ...options.client,
    });
    const commandsSeen: string[] = [];
    bindHerdrClient((command) => (commandsSeen.push(command), fake.client));
    const { commands, handlers } = fakePi();
    bindWorkflow(app);
    const runtime = await ModelRuntime.create({ authPath: path.join(process.env.HOME!, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" }] });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "f1.txt", content: "x\n" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Done.\n- [x] retry works"))]);
    const notices: string[] = [];
    let replaced = 0;
    const ctx: Record<string, unknown> = {
      cwd,
      hasUI: true,
      model: { provider: "anthropic", id: "claude-opus-5-5" },
      modelRegistry: new ModelRegistry(runtime),
      ui: { notify: (m: string) => notices.push(m), setStatus() {}, setWidget() {}, confirm: async () => true },
      sessionManager: { getSessionFile: () => undefined, getSessionId: () => "main", getEntries: () => [] },
      async sendMessage() {},
      async newSession() {
        replaced += 1;
        return { cancelled: true };
      },
    };
    handlers.get("session_start")!({}, ctx);
    const run = () => commands.get("build")!.handler("", ctx);
    await run();
    return { app, fake, faux, cwd, sessions, notices, commandsSeen, replaced: () => replaced, run, setChecks: (fail: boolean) => void (failing = fail) };
  }

  const ticketRows = (app: Awaited<ReturnType<typeof build>>["app"]) => app.store.readLedger().filter((row) => row.reason.includes("ticket 01"));

  it("runs the ticket in a tab, ledgers the child's turns, commits it and closes the tab", async () => {
    const { app, fake, faux, replaced, cwd } = await build();
    const state = app.store.load(app.activeTaskId()!)!;
    expect(state.ticketRuns!["01"]).toMatchObject({ status: "done" });
    expect(replaced()).toBe(0);
    expect(faux.state.callCount).toBe(0);
    expect(fake.tabs).toHaveLength(1);
    const tab = fake.tabs[0]!;
    expect(tab.killed).toBe(true);
    expect(tab.sends).toHaveLength(1);
    expect(readFileSync(path.join(cwd, "f1.txt"), "utf8")).toBe("x\n");
    // argv: the env wrapper (no env option in hc run), the ticket-mode extension, the model, a session dir in the workspace.
    const argv = tab.options.argv;
    expect(argv.slice(0, 4)).toEqual(["env", "PI_CHEF_TICKET=01", expect.stringMatching(/^PI_CHEF_STATUS=.*01-1\.status\.json$/), expect.stringMatching(/^PI_CHEF_MAX_TURNS=\d+$/)]);
    expect(argv.slice(4, 8)).toEqual(["pi", "-ne", "-e", expect.stringMatching(/src\/ticket-mode\.ts$/)]);
    expect(path.isAbsolute(argv[7]!)).toBe(true);
    expect(tab.model).toBe("anthropic/claude-sonnet-5-5");
    expect(tab.sessionDir).toContain(path.join("sessions", "01-1"));
    expect(tab.sessionDir.startsWith(cwd)).toBe(true);
    expect(tab.statusFile!.startsWith(cwd)).toBe(true);
    expect(tab.options).toMatchObject({ cwd, labels: { "herdr.space": "sp1", "pi-chef.ticket": "01" } });
    expect(tab.options.labels!["herdr.tab"]).toBeTruthy();
    expect(tab.options.notify).toBeFalsy();
    expect(tab.options.outliveParent).toBeFalsy();
    const rows = ticketRows(app).filter((row) => row.model === "claude-sonnet-5-5" && row.provider === "anthropic");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.id).toMatch(/^pi-/);
  });

  it("leaves a failed ticket's tab open and reuses it for the retry; the next /build opens a new tab and sweeps the old dir", async () => {
    const { app, fake, run, setChecks, sessions, cwd } = await build({ checksFail: true });
    expect(app.store.load(app.activeTaskId()!)!.ticketRuns!["01"]!.status).not.toBe("done");
    // First turn plus one check retry, both on the same tab; the tab stays for the person to read.
    expect(fake.tabs).toHaveLength(1);
    expect(fake.tabs[0]!.sends).toHaveLength(2);
    expect(fake.tabs[0]!.killed).toBe(false);
    const before = ticketRows(app).length;
    expect(before).toBeGreaterThan(0);
    // A crash left an entry no read ledgered: the next attempt's sweep finds it.
    const late = childWrites(path.join(sessions, "01-1"), "late reply");
    setChecks(false);
    // The failed attempt's change is dropped, or /build would treat the dirty tree as a hand fix and commit it with no model.
    rmSync(path.join(cwd, "f1.txt"));
    await run();
    expect(fake.tabs.length).toBeGreaterThanOrEqual(2);
    expect(fake.tabs[0]!.killed).toBe(false);
    expect(fake.tabs[fake.tabs.length - 1]!.sessionDir).toMatch(/01-[2-9]$/);
    expect(fake.tabs[fake.tabs.length - 1]!.killed).toBe(true);
    expect(ticketRows(app).length).toBeGreaterThan(before);
    expect(app.store.readLedger().some((row) => row.id.startsWith(`pi-${late.getSessionId()}-`) && row.reason.includes("ticket 01"))).toBe(true);
    // Never double counted: every ledger id is unique.
    const ids = app.store.readLedger().map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("passes isolation.herdrCommand to the client, expanding a leading ~/", async () => {
    // One client for the ticket runner and one for the review tab, both made from the configured command.
    const seen = async (options?: Parameters<typeof build>[0]) => [...new Set((await build(options)).commandsSeen)];
    expect(await seen()).toEqual(["hc"]);
    expect(await seen({ herdrCommand: "~/bin/hc" })).toEqual([path.join(homedir(), "bin/hc")]);
    expect(await seen({ herdrCommand: "/opt/herdr/hc" })).toEqual(["/opt/herdr/hc"]);
  });

  it("rejects a bad isolation.herdrCommand or runner with a message that names the key", () => {
    expect(() => parseConfig("isolation:\n  herdrCommand: \"hc --evil\"\n")).toThrow(/isolation\.herdrCommand.*command name or path without spaces/);
    expect(() => parseConfig("isolation:\n  herdrCommand: 5\n")).toThrow(/isolation\.herdrCommand/);
    expect(() => parseConfig("isolation:\n  runner: tabs\n")).toThrow(/isolation\.runner.*subagent, session or herdr/);
    expect(parseConfig("isolation:\n  runner: herdr\n  herdrCommand: ~/bin/hc\n").isolation).toMatchObject({ runner: "herdr", herdrCommand: "~/bin/hc" });
  });

  it("names the tab chef-<task name>-<ticket>-<n>", async () => {
    const { fake, app } = await build();
    const name = fake.tabs[0]!.options.name!;
    expect(name).toMatch(/^chef-[a-z0-9_-]+-01-1$/);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toContain(app.store.load(app.activeTaskId()!)!.name!.slice(0, 8));
    expect(fake.tabs[0]!.options.labels!["herdr.tab"]).toBe(name);
  });

  it("sends the per-ticket review through the one review tab, and the ledger rows are the caller's alone", async () => {
    const { app, fake, faux, cwd } = await build({
      accountKey: true,
      client: {
        onSend: (tab) => {
          if (tab.options.labels?.["pi-chef.role"] === "review") return void reviewerWrites(tab.sessionDir, VERDICT);
          writeFileSync(path.join(tab.options.cwd!, "f1.txt"), "x\n");
          childWrites(tab.sessionDir, "Done.\n- [x] retry works");
        },
      },
    });
    const state = app.store.load(app.activeTaskId()!)!;
    expect(state.ticketRuns!["01"]).toMatchObject({ status: "done" });
    const review = fake.tabs.filter((tab) => tab.options.labels?.["pi-chef.role"] === "review");
    expect(review).toHaveLength(1);
    expect(review[0]!.commands).toEqual(["/new"]);
    expect(review[0]!.sends[0]).toMatch(/^Review request .+: read .+\.md and answer exactly as it asks\.$/);
    expect(review[0]!.options).toMatchObject({ name: "chef-review", outliveParent: true, cwd });
    expect(review[0]!.killed).toBe(false); // it outlives the ticket
    expect(state.ticketRuns!["01"]!.reviews?.[0]?.verdict).toBe("pass");
    expect(faux.state.callCount).toBe(0); // the plain chat made no review call
    const rows = app.store.readLedger();
    const reviewRows = rows.filter((row) => row.reason.includes("ticket review") || row.reason.includes("review"));
    expect(reviewRows.some((row) => row.model === "claude-opus-5-5" && !row.id.startsWith("pi-"))).toBe(true);
    // The reviewer's assistant messages are not ledgered a second time from the session files.
    expect(rows.filter((row) => row.id.startsWith("pi-") && row.model === "claude-opus-5-5")).toEqual([]);
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not bind reviewChat for the other runners", async () => {
    const { app, fake } = await build({ runner: "subagent" });
    expect(contextOf(app).reviewChat).toBeUndefined();
    expect(fake.tabs).toHaveLength(0);
  });

  it("ends the ticket unstarted with hc's message when the tab cannot be started (duplicate name)", async () => {
    const { app, fake, notices } = await build({ client: { failRun: () => "name 'chef-x-01-1' is already in use" } });
    expect(fake.tabs).toHaveLength(0);
    expect(notices.some((n) => n.startsWith("Ticket 01 stopped: run --bg failed: name 'chef-x-01-1' is already in use"))).toBe(true);
    const run = app.store.load(app.activeTaskId()!)!.ticketRuns?.["01"];
    expect(run?.status === "done").toBe(false);
    expect(run?.attempts ?? 0).toBe(0);
  });

  it("falls back to the subagent with a notice when pi-chef is not in herdr", async () => {
    const { app, fake, faux, notices } = await build({ client: { self: { problem: "HC_TERMINAL_ID is not set; pi-chef is not running inside a herdr terminal" } } });
    expect(fake.tabs).toHaveLength(0);
    expect(faux.state.callCount).toBe(2);
    expect(app.store.load(app.activeTaskId()!)!.ticketRuns!["01"]).toMatchObject({ status: "done" });
    expect(notices.some((n) => n.includes("herdr not available: HC_TERMINAL_ID is not set") && n.includes("running the ticket in a subagent"))).toBe(true);
  });

  it("turns a turnLimit status into TURN_LIMIT and leaves the tab open", async () => {
    const { app, fake } = await build({
      client: {
        onSend: (tab) => {
          writeFileSync(path.join(tab.options.cwd!, "f1.txt"), "x\n");
          childWrites(tab.sessionDir, "I ran out of turns");
          writeFileSync(tab.statusFile!, JSON.stringify({ turns: 105, turnLimit: true, aborted: true }));
        },
      },
    });
    const run = app.store.load(app.activeTaskId()!)!.ticketRuns!["01"]!;
    expect(run.status).not.toBe("done");
    expect(run.failedBy).toBe("turns");
    expect(fake.tabs[0]!.killed).toBe(false);
  });

  it("stops cleanly on a status error, before the ticket starts when the child failed at startup", async () => {
    const startup = await build({
      client: {
        onRun: (tab: FakeTab) => {
          mkdirSync(path.dirname(tab.statusFile!), { recursive: true });
          writeFileSync(tab.statusFile!, JSON.stringify({ error: "providers.foundry: bad endpoint" }));
        },
      },
    });
    expect(startup.fake.tabs[0]!.sends).toEqual([]);
    expect(startup.fake.tabs[0]!.killed).toBe(false);
    expect(startup.app.store.load(startup.app.activeTaskId()!)!.ticketRuns?.["01"]?.status ?? "pending").not.toBe("done");
    expect(startup.notices.some((n) => n.includes("bad endpoint"))).toBe(true);

    // An error reported during a turn stops the build; the child's spend is still ledgered.
    const mid = await build({
      client: {
        onSend: (tab) => {
          childWrites(tab.sessionDir, "partial");
          writeFileSync(tab.statusFile!, JSON.stringify({ error: "model call failed" }));
        },
      },
    });
    expect(mid.app.store.load(mid.app.activeTaskId()!)!.ticketRuns!["01"]!.status).not.toBe("done");
    expect(mid.fake.tabs[0]!.killed).toBe(false);
    expect(ticketRows(mid.app).length).toBeGreaterThan(0);
  });

  it("stops when the tab dies mid-send and keeps what it spent", async () => {
    const { app, fake } = await build({
      client: {
        onSend: (tab) => void childWrites(tab.sessionDir, "half done"),
        waitIdle: (_tab, wait) => (wait === 1 ? { status: "idle", exitCode: null, timedOut: false } : { status: "ended", exitCode: 1, timedOut: false }),
      },
    });
    expect(app.store.load(app.activeTaskId()!)!.ticketRuns!["01"]!.status).not.toBe("done");
    expect(fake.tabs[0]!.killed).toBe(false);
    expect(ticketRows(app).length).toBeGreaterThan(0);
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

  it("leaves a local ticket's compaction to Pi (the local model), so its transcript never reaches the cloud tier", async () => {
    const { app, calls, run } = await setup();
    const id = (await addTask(app, "local")).taskId;
    app.store.setActive(id);
    const running = (tier: string) => (state: TaskState): TaskState => ({ ...state, localMode: true, build: { branch: "b", base: "main", baseSha: "a", currentTicket: "01" }, ticketRuns: { "01": { status: "in-progress", tier, attempts: 1 } } }) as never;
    await app.store.update(id, "local ticket", running("local"));
    expect(await run()).toBeUndefined();
    expect(calls).toEqual([]);
    // A cloud ticket of a hybrid plan (or Opus finishing a local one) compacts on the cheap tier as usual.
    await app.store.update(id, "cloud ticket", running("ticketMedium"));
    await run();
    expect(calls.length).toBeGreaterThan(0);
  });

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
      requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, actualUsd: 9999, usageKnown: true, outcome: "success", retries: 0, reason: "test",
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
      requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, actualUsd: usd, usageKnown: true, outcome: "success", retries: 0, reason: "test",
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

describe("the chef footer keeps up with spend", () => {
  it("redraws after each model turn, settled run and compaction, not only after a command", async () => {
    const cwd = await tempRepo();
    writeProject(cwd, tieredYaml());
    const { handlers } = fakePi();
    const statuses: string[] = [];
    const ctx = { cwd, hasUI: true, model: OPUS, modelRegistry: { find: () => undefined }, ui: { notify() {}, setStatus: (key: string, text?: string) => void statuses.push(`${key}=${text ?? ""}`) }, sessionManager: { getSessionId: () => "sess", getEntries: () => [] } };
    handlers.get("session_start")!({}, ctx);
    statuses.length = 0;
    handlers.get("message_end")!({ message: { role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } }, ctx);
    // No task is open: the line shows what the turn added to today's spend.
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatch(/^chef=chef · today (≈)?\$\d+\.\d{2} of \$\d+$/);
    await handlers.get("agent_settled")!({ aborted: false }, ctx);
    handlers.get("session_compact")!({}, ctx);
    expect(statuses).toHaveLength(3);
    expect(new Set(statuses.map((item) => item.split("=")[0]))).toEqual(new Set(["chef"]));
  });
});

describe("Pi's own calls and prices reach the ledger through the extension", () => {
  it("sweeps cache warming and Pi's compaction from the session file, and keeps Pi's price on each message", async () => {
    const cwd = await tempRepo();
    writeProject(cwd, tieredYaml());
    const { handlers } = fakePi();
    const entries: unknown[] = [];
    const ctx = { cwd, hasUI: false, model: OPUS, modelRegistry: { find: () => undefined }, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "sess", getEntries: () => entries } };
    handlers.get("session_start")!({}, ctx);
    const workflow = currentWorkflow()!;
    const later = new Date(Date.now() + 60_000).toISOString();
    entries.push({ type: "usage", id: "w1", timestamp: later, kind: "cache_warm", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 0, output: 1, cacheRead: 90_000, cacheWrite: 0, cost: { total: 0.045 } } });
    entries.push({ type: "compaction", id: "c1", timestamp: later, usage: { input: 50_000, output: 3_000, cacheRead: 0, cacheWrite: 0 } });
    await handlers.get("agent_settled")!({ aborted: false }, ctx);
    handlers.get("session_compact")!({}, ctx);
    handlers.get("message_end")!({ message: { role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0004 } }, stopReason: "stop" } }, ctx);
    const ledger = workflow.store.readLedger();
    expect(ledger.filter((row) => row.id.startsWith("pi-sess-")).map((row) => row.reason)).toEqual(["Pi cache warming", "Pi compaction"]);
    expect(ledger.find((row) => row.reason === "observed assistant usage")?.listPriceUsd).toBe(0.0004);
  });
});
