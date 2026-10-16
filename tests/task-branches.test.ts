import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { activeTask, closeTask } from "../src/orchestrator/tasks.js";
import { addTask, contextOf, SpyGit, tempRepo, workflow } from "./helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

async function twoTasks() {
  const cwd = await tempRepo();
  const spy = new SpyGit(cwd);
  const app = workflow(cwd, { git: spy });
  const main = await git(cwd, "branch", "--show-current");
  await git(cwd, "branch", "chef/alpha");
  await git(cwd, "branch", "chef/beta");
  const a = await addTask(app, "alpha", { branch: "chef/alpha", phase: "IMPLEMENTING", at: "2026-10-14T10:00:00.000Z" });
  const b = await addTask(app, "beta", { branch: "chef/beta", phase: "IMPLEMENTING", at: "2026-10-14T11:00:00.000Z" });
  // A first command records the branch, as every real session has had.
  await activeTask(contextOf(app));
  return { cwd, app, spy, main, a, b, ctx: contextOf(app) };
}

describe("the active task follows the git branch", () => {
  it("makes the task whose build branch is checked out the active one, and records it", async () => {
    const t = await twoTasks();
    expect(t.app.activeTaskId()).toBe(t.b.taskId);
    await git(t.cwd, "switch", "chef/alpha");
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
    // active-task.json now agrees, so readers that do not ask git see the same task.
    expect(JSON.parse(readFileSync(path.join(t.cwd, ".pi-workflows", "active-task.json"), "utf8")).taskId).toBe(t.a.taskId);
    expect(t.app.activeTaskId()).toBe(t.a.taskId);
  });

  it("keeps the stored task on the default branch, on a branch no task owns, and when detached", async () => {
    const t = await twoTasks();
    t.ctx.store.setActive(t.a.taskId);
    await git(t.cwd, "switch", t.main);
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
    await git(t.cwd, "switch", "-c", "scratch");
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
    await git(t.cwd, "switch", "--detach", "chef/beta");
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
    expect(t.app.activeTaskId()).toBe(t.a.taskId);
  });

  it("keeps the stored task when git fails (not a repository)", async () => {
    const t = await twoTasks();
    t.spy.git = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    t.ctx.store.setActive(t.a.taskId);
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
  });

  it("ignores the branch of a closed task", async () => {
    const t = await twoTasks();
    await closeTask(t.ctx, t.a.taskId, "test");
    t.ctx.store.setActive(t.b.taskId);
    await git(t.cwd, "switch", "chef/alpha");
    expect((await activeTask(t.ctx))?.taskId).toBe(t.b.taskId);
  });

  it("makes one git call per resolution, and none when ledgering usage", async () => {
    const t = await twoTasks();
    t.spy.calls.length = 0;
    await activeTask(t.ctx);
    expect(t.spy.calls).toHaveLength(1);
    t.spy.calls.length = 0;
    const record = t.app.observeUsage({ provider: "anthropic", model: "claude-sonnet", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1 } });
    expect(record?.taskId).toBe(t.b.taskId);
    expect(t.spy.calls).toEqual([]);
  });

  it("reacts to a branch change, not to the branch state: /plan on A's branch keeps the new task active", async () => {
    const t = await twoTasks();
    await git(t.cwd, "switch", "chef/alpha");
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
    const started = await workflow(t.cwd, { git: t.spy, startTurn: () => undefined }).startPlan("Wire the cache layer");
    expect(started.ok, started.text).toBe(true);
    const fresh = t.app.activeTaskId()!;
    expect(fresh).not.toBe(t.a.taskId);
    // Commands after /plan, still on A's branch, keep the new task.
    expect((await activeTask(t.ctx))?.taskId).toBe(fresh);
    expect((await t.app.status()).ok).toBe(true);
    expect(t.app.activeTaskId()).toBe(fresh);
    // Checking out A's branch again after leaving it makes A active.
    await git(t.cwd, "switch", t.main);
    expect((await activeTask(t.ctx))?.taskId).toBe(fresh);
    await git(t.cwd, "switch", "chef/alpha");
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
    // Main has no task, so A stays; B's branch from main makes B active.
    await git(t.cwd, "switch", t.main);
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
    await git(t.cwd, "switch", "chef/beta");
    expect((await activeTask(t.ctx))?.taskId).toBe(t.b.taskId);
  });

  it("keeps /plans <name> active on a dirty tree, and /plans close's fallback", async () => {
    const t = await twoTasks();
    await git(t.cwd, "switch", "chef/beta");
    await activeTask(t.ctx);
    writeFileSync(path.join(t.cwd, "wip.txt"), "wip\n");
    expect((await t.app.plans("alpha")).ok).toBe(true);
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
  });

  it("works with an active-task.json that has no recorded branch, and starts recording it", async () => {
    const t = await twoTasks();
    const file = path.join(t.cwd, ".pi-workflows", "active-task.json");
    writeFileSync(file, JSON.stringify({ taskId: t.a.taskId }));
    await git(t.cwd, "switch", "chef/beta");
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ taskId: t.a.taskId, seenBranch: "chef/beta" });
    await git(t.cwd, "switch", t.main);
    expect((await activeTask(t.ctx))?.taskId).toBe(t.a.taskId);
    await git(t.cwd, "switch", "chef/beta");
    expect((await activeTask(t.ctx))?.taskId).toBe(t.b.taskId);
  });
});
