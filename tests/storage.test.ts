import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    publishApproved: false,
    worktrees: [],
    attempts: [],
    contextResets: [],
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
});
