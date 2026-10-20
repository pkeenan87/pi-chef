import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskStore, withLock } from "../src/storage/store.js";
import type { TaskState } from "../src/domain.js";

function blank(id: string): TaskState {
  const at = "2026-10-14T00:00:00.000Z";
  return {
    taskId: id,
    phase: "PLANNING",
    createdAt: at,
    updatedAt: at,
    phaseEnteredAt: at,
    request: "ship it sk-live-SECRETVALUE123456",
  };
}

describe("task store", () => {
  it("rebuilds from the event log when the snapshot is gone", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-store-"));
    const store = new TaskStore(root);
    await store.create(blank("task-1"));
    await store.update("task-1", "advance", (state) => ({ ...state, phase: "AWAITING_PLAN_APPROVAL", updatedAt: state.updatedAt }));
    rmSync(path.join(root, "tasks", "task-1", "state.json"));
    const events = path.join(root, "tasks", "task-1", "events.jsonl");
    writeFileSync(events, `${readFileSync(events, "utf8")}{"seq":99\n`);
    const reloaded = new TaskStore(root).load("task-1");
    expect(reloaded?.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect(JSON.stringify(reloaded)).not.toContain("SECRETVALUE");
    expect(reloaded?.request).toContain("[REDACTED]");
  });

  it("serializes writers and refuses to overwrite a frozen plan", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-lock-"));
    const store = new TaskStore(root);
    let value = 0;
    await Promise.all([
      withLock(path.join(root, "lock"), async () => {
        const seen = value;
        await new Promise((resolve) => setTimeout(resolve, 20));
        value = seen + 1;
      }),
      withLock(path.join(root, "lock"), async () => {
        const seen = value;
        await new Promise((resolve) => setTimeout(resolve, 20));
        value = seen + 1;
      }),
    ]);
    expect(value).toBe(2);
    store.writeOnceText("task-1", "plan.v1.approved.json", "{}\n");
    expect(() => store.writeOnceText("task-1", "plan.v1.approved.json", "{}\n")).toThrow(/frozen/);
  });

  it("releases the chain when the file lock times out", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-timeout-"));
    const lock = path.join(root, "lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "other", at: Date.now() }));
    await expect(withLock(lock, () => 1, { timeoutMs: 50 })).rejects.toThrow(/Could not acquire/);
    rmSync(lock);
    await expect(withLock(lock, () => "ok", { timeoutMs: 500 })).resolves.toBe("ok");
  });

  it("recovers a stale lock held by a dead pid", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-stale-"));
    const lock = path.join(root, "lock");
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: "dead", at: Date.now() - 60_000 }));
    await expect(withLock(lock, () => "ok")).resolves.toBe("ok");
    expect(existsSync(lock)).toBe(false);
  });

  it("repairs a torn tail before appending and keeps seq monotonic past corrupt lines", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-torn-"));
    const store = new TaskStore(root);
    await store.create(blank("t"));
    const events = path.join(root, "tasks", "t", "events.jsonl");
    appendFileSync(events, '{"seq":2,"at":"x"');
    await store.update("t", "a", (s) => ({ ...s, phase: "AWAITING_PLAN_APPROVAL" }));
    await store.update("t", "b", (s) => ({ ...s, request: "changed" }));
    const lines = readFileSync(events, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    const seqs = lines.slice(2).map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(store.corruptEventLines("t")).toBe(1);
    rmSync(path.join(root, "tasks", "t", "state.json"));
    const replayed = new TaskStore(root).load("t");
    expect(replayed?.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect(replayed?.request).toBe("changed");
  });

  it("stores compact events and refuses to re-create an existing task", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-create-"));
    const store = new TaskStore(root);
    await store.create(blank("t"));
    await expect(store.create(blank("t"))).rejects.toThrow(/already exists/);
    await store.update("t", "a", (s) => ({ ...s, phase: "AWAITING_PLAN_APPROVAL" }));
    const lines = readFileSync(path.join(root, "tasks", "t", "events.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const second = JSON.parse(lines[1]) as { state?: unknown; changed: string[] };
    expect(second.state).toBeUndefined();
    expect(second.changed).toContain("phase");
  });

  it("loads from state.json and falls back to replay when it is corrupt", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-load-"));
    const store = new TaskStore(root);
    await store.create(blank("t"));
    const snap = path.join(root, "tasks", "t", "state.json");
    writeFileSync(snap, JSON.stringify({ ...blank("t"), request: "from-snapshot" }));
    expect(store.load("t")?.request).toBe("from-snapshot");
    writeFileSync(snap, "{not json");
    expect(store.load("t")?.request).toContain("[REDACTED]");
  });

  it("invalidates the ledger cache on append and bumps metrics under lock", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-ledger-"));
    const store = new TaskStore(root);
    expect(store.readLedger()).toHaveLength(0);
    const rec = { at: "2026-10-14T00:00:00.000Z", taskId: "t" } as never;
    store.appendLedger(rec);
    expect(store.readLedger()).toHaveLength(1);
    store.appendLedger(rec);
    expect(store.readLedger()).toHaveLength(2);
    mkdirSync(path.join(root, "metrics"), { recursive: true });
    await Promise.all([store.bumpMetric("bug", "cheap", true), store.bumpMetric("bug", "cheap", false), store.bumpMetric("bug", "cheap", true)]);
    const cell = store.readMetrics().bug.cheap;
    expect(cell).toMatchObject({ success: 2, failure: 1 });
    expect(cell.recent).toHaveLength(3);
    expect(cell.recent?.every((item) => typeof item.at === "string")).toBe(true);
  });
});
