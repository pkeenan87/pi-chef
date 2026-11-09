import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { lastAssistantText, ledgerChildSession, readChildSession, sweepTicketSessions } from "../src/herdr/session-file.js";
import { addTask, contextOf, tempRepo, workflow } from "./helpers.js";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function assistant(text: string, extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-5.4",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost, ...usage },
    stopReason: "stop" as const,
    timestamp: Date.now(),
    ...extra,
  };
}

/** Writes a session with Pi's real SessionManager: a user turn and the given assistant messages. */
function session(dir: string, messages: ReturnType<typeof assistant>[]): SessionManager {
  const sm = SessionManager.create("/work", dir);
  sm.appendMessage({ role: "user", content: "do it", timestamp: Date.now() } as never);
  for (const message of messages) sm.appendMessage(message as never);
  return sm;
}

async function setup() {
  const cwd = await tempRepo();
  const app = workflow(cwd);
  const task = await addTask(app, "herdr");
  const ctx = contextOf(app);
  const dir = path.join(ctx.store.taskDir(task.taskId), "sessions", "01-1");
  mkdirSync(dir, { recursive: true });
  return { cwd, app, ctx, task, dir };
}

describe("readChildSession", () => {
  it("reads the header id and the entries of every file, oldest first", async () => {
    const { dir } = await setup();
    const a = session(dir, [assistant("one")]);
    const files = readChildSession(dir);
    expect(files).toHaveLength(1);
    expect(files[0]!.sessionId).toBe(a.getSessionId());
    expect(files[0]!.entries.map((e) => e.type)).toEqual(["message", "message"]);
  });

  it("reads several files (a /new in the child) and a missing dir as none", async () => {
    const { dir } = await setup();
    const first = session(dir, [assistant("a")]);
    const second = session(dir, [assistant("b")]);
    const files = readChildSession(dir);
    expect(files.map((f) => f.sessionId).sort()).toEqual([first.getSessionId(), second.getSessionId()].sort());
    expect(readChildSession(path.join(dir, "nope"))).toEqual([]);
  });

  it("skips a partly written last line and reads it once complete", async () => {
    const { dir } = await setup();
    const sm = session(dir, [assistant("first")]);
    const file = sm.getSessionFile()!;
    appendFileSync(file, '{"type":"message","id":"zz","message":{"role":"assis');
    expect(readChildSession(dir)[0]!.entries).toHaveLength(2);
    writeFileSync(file, readFileSync(file, "utf8").replace(/\{"type":"message","id":"zz".*$/, ""));
    sm.appendMessage(assistant("second") as never);
    expect(lastAssistantText(readChildSession(dir))).toBe("second");
  });
});

describe("ledgerChildSession", () => {
  it("ledgers each assistant message once, tagged with the ticket, across re-reads", async () => {
    const { dir, ctx } = await setup();
    session(dir, [assistant("a"), assistant("b", {}, { input: 7, output: 3 })]);
    const first = ledgerChildSession(ctx, readChildSession(dir), { ticketId: "01" });
    expect(first).toHaveLength(2);
    expect(ledgerChildSession(ctx, readChildSession(dir), { ticketId: "01" })).toEqual([]);
    const rows = ctx.store.readLedger();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => / · ticket 01$/.test(row.reason))).toBe(true);
    expect(rows.map((row) => [row.inputTokens, row.outputTokens]).sort()).toEqual([[100, 50], [7, 3]]);
  });

  it("does not double-count in a new process (a new Workflow on the same store)", async () => {
    const { cwd, dir, ctx } = await setup();
    session(dir, [assistant("a")]);
    ledgerChildSession(ctx, readChildSession(dir), { ticketId: "01" });
    const again = contextOf(workflow(cwd));
    expect(ledgerChildSession(again, readChildSession(dir), { ticketId: "01" })).toEqual([]);
    expect(again.store.readLedger()).toHaveLength(1);
  });

  it("keeps an unknown cost null, never zero", async () => {
    const { dir, ctx } = await setup();
    session(dir, [assistant("a", { provider: "nowhere", model: "mystery" }, { input: undefined, output: undefined })]);
    const [row] = ledgerChildSession(ctx, readChildSession(dir), { ticketId: "01" });
    expect(row?.actualUsd).toBeNull();
  });

  it("tags rows with the running ticket when state.build.currentTicket is set, and with the given id otherwise", async () => {
    const { dir, ctx, task } = await setup();
    await ctx.store.update(task.taskId, "running", (state) => ({ ...state, build: { branch: "b", base: "main", baseSha: "0".repeat(40), currentTicket: "01" } }));
    session(dir, [assistant("a")]);
    const [row] = ledgerChildSession(ctx, readChildSession(dir), { ticketId: "01" });
    expect(row!.taskId).toBe(task.taskId);
    expect(row!.reason).toMatch(/ticket 01$/);
    expect(row!.reason.match(/ticket/g)).toHaveLength(1);
  });

  it("ledgers Pi's own entries (usage, compaction) once, tagged, and skips older entries with since", async () => {
    const { dir, ctx } = await setup();
    const sm = session(dir, [assistant("a")]);
    const usage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost };
    sm.appendUsage("cache_warm", "openai", "gpt-5.4", usage as never);
    const kept = sm.getEntries()[0]!.id;
    sm.appendCompaction("sum", kept, 100, undefined, false, usage as never);
    const added = ledgerChildSession(ctx, readChildSession(dir), { ticketId: "01" });
    expect(added.map((row) => row.reason).sort()).toEqual(["Pi cache warming · ticket 01", "Pi compaction · ticket 01", "observed assistant usage · ticket 01"]);
    // The compaction entry names no model: it takes the preceding assistant message's, and is priced, not unknown.
    const compaction = added.find((row) => row.reason.startsWith("Pi compaction"))!;
    expect([compaction.provider, compaction.model]).toEqual(["openai", "gpt-5.4"]);
    expect(compaction.actualUsd).not.toBeNull();
    expect(ledgerChildSession(ctx, readChildSession(dir), { ticketId: "01" })).toEqual([]);
  });

  it("takes the runner's model for a compaction entry over the preceding message's", async () => {
    const { dir, ctx } = await setup();
    const sm = session(dir, [assistant("a")]);
    sm.appendCompaction("sum", sm.getEntries()[0]!.id, 100, undefined, false, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost } as never);
    const rows = ledgerChildSession(ctx, readChildSession(dir), { ticketId: "01", model: { provider: "anthropic", id: "claude-sonnet" } });
    const compaction = rows.find((row) => row.reason.startsWith("Pi compaction"))!;
    expect([compaction.provider, compaction.model]).toEqual(["anthropic", "claude-sonnet"]);
  });
});

describe("lastAssistantText", () => {
  it("returns the whole text of the last assistant message of a multi-turn session, prose around JSON included", async () => {
    const { dir } = await setup();
    const sm = SessionManager.create("/work", dir);
    sm.appendMessage({ role: "user", content: "review", timestamp: 1 } as never);
    sm.appendMessage(assistant("Looking at the diff first.") as never);
    sm.appendMessage({ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 2 } as never);
    const final = { ...assistant("Here is my verdict:\n"), content: [{ type: "text", text: "Here is my verdict:\n" }, { type: "thinking", thinking: "hmm" }, { type: "text", text: '{"verdict":"pass","findings":[]}\nThanks.' }] };
    sm.appendMessage(final as never);
    expect(lastAssistantText(readChildSession(dir))).toBe('Here is my verdict:\n{"verdict":"pass","findings":[]}\nThanks.');
    expect(lastAssistantText([])).toBeUndefined();
  });

  it("looks only at the newest file, and is undefined for a last message with no text", async () => {
    const { dir } = await setup();
    session(dir, [assistant("old answer")]);
    expect(lastAssistantText(readChildSession(dir))).toBe("old answer");
    const second = SessionManager.create("/work", dir);
    second.appendMessage({ role: "user", content: "next", timestamp: 1 } as never);
    // After a /new with no reply, the previous session's answer is not this one's.
    expect(lastAssistantText(readChildSession(dir))).toBeUndefined();
    second.appendMessage({ ...assistant(""), content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }] } as never);
    expect(lastAssistantText(readChildSession(dir))).toBeUndefined();
    second.appendMessage(assistant("new answer") as never);
    expect(lastAssistantText(readChildSession(dir))).toBe("new answer");
  });
});

describe("sweepTicketSessions", () => {
  it("ledgers every attempt dir of the ticket and no other ticket's, once", async () => {
    const { ctx, task } = await setup();
    const root = path.join(ctx.store.taskDir(task.taskId), "sessions");
    session(path.join(root, "01-2"), [assistant("b")]);
    session(path.join(root, "010-1"), [assistant("other")]);
    session(path.join(root, "01-1"), [assistant("a")]);
    expect(readdirSync(root).sort()).toEqual(["01-1", "01-2", "010-1"]);
    expect(sweepTicketSessions(ctx, "01")).toHaveLength(2);
    expect(sweepTicketSessions(ctx, "01")).toEqual([]);
    expect(ctx.store.readLedger()).toHaveLength(2);
  });

  it("is a quiet no-op with no task or no sessions dir", async () => {
    const cwd = await tempRepo();
    expect(sweepTicketSessions(contextOf(workflow(cwd)), "01")).toEqual([]);
    const { ctx } = await setup();
    expect(sweepTicketSessions(ctx, "99")).toEqual([]);
  });
});
