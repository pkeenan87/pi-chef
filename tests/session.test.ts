import type { TaskState } from "../src/domain.js";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../src/config.js";
import { bindHerdrClient, bindWorkflow, currentWorkflow, registerWorkflow } from "../src/extension.js";
import type { Workflow } from "../src/orchestrator/service.js";
import { fakeHerdrClient } from "./herdr-fake.js";
import { sampleTicket, tempRepo, ticketWorkflow, tieredYaml } from "./helpers.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ModelRef = { provider: string; id: string };

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };

const priorHome = process.env.HOME;
beforeEach(() => {
  // No user config from the machine running the tests.
  process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-home-"));
});
afterEach(() => {
  process.env.HOME = priorHome;
  bindWorkflow(undefined);
});

function fakePi() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, Handler>();
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => undefined;
    },
    appendEntry() {},
  };
  registerWorkflow(pi as unknown as ExtensionAPI);
  return { commands, handlers };
}

function writeProject(cwd: string, yaml: string): void {
  mkdirSync(path.join(cwd, ".pi-workflows"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), yaml);
}

describe("/build in herdr tabs", () => {
  // The driver runs every ticket in its own herdr tab; a fake `hc` client plays the tab, and the user's session is never replaced.
  async function build(options: { self?: { terminal: string; space: string } | { problem: string }; unbound?: boolean } = {}) {
    const { cwd, app } = await ticketWorkflow([sampleTicket("01", { difficulty: "medium" })]);
    const { commands, handlers } = fakePi();
    bindWorkflow(app);
    const fake = fakeHerdrClient({
      ...(options.self ? { self: options.self } : {}),
      onSend: (tab) => {
        writeFileSync(path.join(tab.options.cwd!, "f1.txt"), "x\n");
        const sm = SessionManager.create("/work", tab.sessionDir);
        sm.appendMessage({ role: "user", content: "t", timestamp: Date.now() } as never);
        sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done.\n- [x] retry works" }], api: "x", provider: "anthropic", model: "claude-sonnet-5-5", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never);
      },
    });
    bindHerdrClient(options.unbound ? undefined : () => fake.client);
    let replaced = 0;
    const notices: string[] = [];
    const ctx: Record<string, unknown> = {
      cwd,
      hasUI: true,
      model: { provider: "anthropic", id: "claude-opus-5-5" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
      ui: { notify: (message: string) => notices.push(message), setStatus() {}, setWidget() {}, confirm: async () => true },
      sessionManager: { getSessionFile: () => undefined, getSessionId: () => "main", getEntries: () => [] },
      async sendMessage() {},
      async newSession() {
        replaced += 1;
        return { cancelled: true };
      },
    };
    handlers.get("session_start")!({}, ctx);
    await commands.get("build")!.handler("", ctx);
    return { app, fake, replaced: () => replaced, notices, cwd };
  }

  afterEach(() => bindHerdrClient(undefined));

  it("runs the ticket in a tab without replacing the session, ledgers the child's turn, commits, and closes the tab", async () => {
    const { app, fake, replaced, cwd } = await build();
    const state = app.store.load(app.activeTaskId()!)!;
    expect(state.ticketRuns!["01"]).toMatchObject({ status: "done", provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(replaced()).toBe(0);
    expect(fake.tabs).toHaveLength(1);
    expect(fake.tabs[0]!.model).toBe("anthropic/claude-sonnet-5-5");
    expect(fake.tabs[0]!.options.argv).toContain(fileURLToPath(new URL("../src/ticket-mode.ts", import.meta.url)));
    expect(fake.tabs[0]!.killed).toBe(true);
    expect(readFileSync(path.join(cwd, "f1.txt"), "utf8")).toBe("x\n");
    const ticketRows = app.store.readLedger().filter((row) => row.reason.includes("ticket 01") && row.model === "claude-sonnet-5-5");
    expect(ticketRows).toHaveLength(1);
  });

  it("stops before any ticket, branch or commit when pi-chef is not inside herdr, with one clear message", async () => {
    const { app, fake, notices, cwd } = await build({ self: { problem: "HC_TERMINAL_ID is not set; pi-chef is not running inside a herdr terminal" } });
    expect(notices.join("\n")).toContain("/build runs each ticket in a herdr tab; start Pi inside herdr and run /build again.");
    expect(fake.tabs).toEqual([]);
    const state = app.store.load(app.activeTaskId()!)!;
    expect(state.ticketRuns?.["01"]).toBeUndefined();
    expect(state.build).toBeUndefined();
    expect(execFileSync("git", ["branch", "--list", "chef/*"], { cwd, encoding: "utf8" })).toBe("");
  });

  it("fails closed with the real client when the shell is not a herdr terminal (no HC_TERMINAL_ID): nothing is spawned", async () => {
    expect(process.env.HC_TERMINAL_ID).toBeUndefined();
    const { app, notices } = await build({ unbound: true });
    expect(notices.join("\n")).toContain("start Pi inside herdr");
    expect(app.store.load(app.activeTaskId()!)!.ticketRuns?.["01"]).toBeUndefined();
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
