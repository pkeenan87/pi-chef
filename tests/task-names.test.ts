import { describe, expect, it } from "vitest";
import { tempRepo, workflow } from "./helpers.js";
import { displayName, findTask, slugName, uniqueName } from "../src/orchestrator/tasks.js";
import type { TaskState } from "../src/domain.js";

describe("task names", () => {
  it("makes a short lowercase ascii slug from the first meaningful words", () => {
    expect(slugName("Please add a retry counter to the ingest parser")).toBe("retry-counter-ingest-parser");
  });

  it("drops stop-words, accents and punctuation, and keeps at most five words", () => {
    expect(slugName("Fix the Café login redirect!! for users on mobile devices")).toBe("fix-cafe-login-redirect-users");
    expect(slugName("Refactor    the   (auth)   module")).toBe("refactor-auth-module");
  });

  it("stays within 32 characters, cutting at a word", () => {
    const name = slugName("Internationalization infrastructure modernization everywhere");
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toBe("internationalization");
    expect(slugName("x".repeat(80))).toHaveLength(32);
  });

  it("uses the first line of a request, ignoring a fenced block", () => {
    expect(slugName("```tasks\n[]\n```\nWire the cache")).toBe("wire-cache");
  });

  it("is empty when there is nothing to use", () => {
    expect(slugName("!!! ???")).toBe("");
  });

  it("adds -2, -3 against existing names and keeps the cap", () => {
    expect(uniqueName("wire-cache", new Set())).toBe("wire-cache");
    expect(uniqueName("wire-cache", new Set(["wire-cache"]))).toBe("wire-cache-2");
    expect(uniqueName("wire-cache", new Set(["wire-cache", "wire-cache-2"]))).toBe("wire-cache-3");
    const long = "a".repeat(32);
    expect(uniqueName(long, new Set([long]))).toHaveLength(32);
    expect(uniqueName("", new Set())).toBe("task");
  });

  it("names new tasks uniquely, and a task without a name shows one from its request or its id", async () => {
    const app = workflow(await tempRepo(), { startTurn: () => undefined });
    await app.startPlan("Wire the cache layer");
    const first = app.store.load(app.activeTaskId()!)!;
    await app.startPlan("Wire the cache layer!");
    const second = app.store.load(app.activeTaskId()!)!;
    expect(first.name).toBe("wire-cache-layer");
    expect(second.name).toBe("wire-cache-layer-2");
    expect(first.taskId).toMatch(/^task-\d{14}-/);
    const old = { taskId: "task-1", request: "Fix the parser bug" } as TaskState;
    expect(displayName(old)).toBe("fix-parser-bug");
    expect(displayName({ taskId: "task-2", request: "???" } as TaskState)).toBe("task-2");
  });

  it("finds a task by id, name or a unique prefix, and says when it is ambiguous", () => {
    const tasks = [
      { taskId: "task-20261001-aaa", name: "wire-cache", request: "x", phase: "PLANNING" },
      { taskId: "task-20261002-bbb", name: "wire-queue", request: "x", phase: "PLANNING" },
      { taskId: "task-20261003-ccc", request: "Fix the parser bug", phase: "PLANNING" },
    ] as TaskState[];
    expect(findTask(tasks, "wire-cache")).toEqual({ task: tasks[0] });
    expect(findTask(tasks, "task-20261002-bbb")).toEqual({ task: tasks[1] });
    expect(findTask(tasks, "wire-q")).toEqual({ task: tasks[1] });
    expect(findTask(tasks, "fix-par")).toEqual({ task: tasks[2] });
    expect(findTask(tasks, "task-20261003")).toEqual({ task: tasks[2] });
    expect(findTask(tasks, "wire")).toMatchObject({ error: expect.stringMatching(/matches 2 tasks/) });
    expect(findTask(tasks, "nope")).toMatchObject({ error: expect.stringMatching(/No task matches/) });
  });
});
