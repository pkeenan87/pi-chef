import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { TaskState } from "../src/domain.js";
import type { PlanReviewRequest } from "../src/orchestrator/service.js";
import { activeTask } from "../src/orchestrator/tasks.js";
import { addTask, contextOf, sampleSpec, sampleTicket, SpyGit, tempRepo, tieredConfig, workflow } from "./helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

async function setup(extras: Parameters<typeof workflow>[1] = {}) {
  const cwd = await tempRepo();
  const spy = new SpyGit(cwd);
  const reports: string[] = [];
  const app = workflow(cwd, { git: spy, report: (markdown) => void reports.push(markdown), startTurn: () => undefined, ...extras });
  const main = await git(cwd, "branch", "--show-current");
  await git(cwd, "branch", "chef/alpha");
  const a = await addTask(app, "alpha", { branch: "chef/alpha", phase: "IMPLEMENTING", at: "2026-10-01T09:00:00.000Z" });
  const b = await addTask(app, "beta", { phase: "PLANNING", at: "2026-10-14T11:00:00.000Z" });
  const c = await addTask(app, "gamma", { phase: "COMPLETE", at: "2026-10-10T11:00:00.000Z" });
  contextOf(app).store.setActive(b.taskId);
  await activeTask(contextOf(app));
  return { cwd, app, spy, reports, main, a, b, c, ctx: contextOf(app) };
}

describe("/plans", () => {
  it("lists open tasks newest first with the active one marked, and returns one plain line", async () => {
    const t = await setup();
    const result = await t.app.plans("");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("2 open task(s) (1 closed; /plans --all). Active: beta. /plans <name> switches.");
    const table = t.reports[0]!;
    expect(table).toContain("|  | Name | State | Tickets | Branch | Updated |");
    const rows = table.split("\n").filter((line) => /^\| (●)? ?\| (alpha|beta|gamma) /.test(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^\| ● \| beta \| Planning · interview \| 0\/0 \| - \| \d\d:\d\d \|$/);
    expect(rows[1]).toMatch(/^\|  \| alpha \| .* \| 0\/0 \| chef\/alpha \| \d{4}-\d\d-\d\d \|$/);
    expect(table).not.toContain("gamma");
  });

  it("--all includes closed tasks", async () => {
    const t = await setup();
    const result = await t.app.plans("--all");
    expect(result.text).toContain("2 open task(s) and 1 closed");
    expect(t.reports[0]).toContain("| gamma | Complete |");
  });

  it("returns the table itself when there is no chat to post it in", async () => {
    const t = await setup({ report: undefined });
    expect((await t.app.plans("")).text).toContain("| ● | beta |");
  });

  it("says so when there is nothing open", async () => {
    const app = workflow(await tempRepo());
    expect((await app.plans("")).text).toBe("No open tasks. /plan <request> starts one.");
  });

  it("lists and switches a task from before names existed, by id or by the name derived from its request", async () => {
    const t = await setup();
    const old = await addTask(t.app, "old", { named: false, request: "Fix the parser bug", at: "2026-10-05T10:00:00.000Z" });
    t.ctx.store.setActive(t.b.taskId);
    await t.app.plans("");
    expect(t.reports[0]).toContain("| fix-parser-bug |");
    const byId = await t.app.plans(old.taskId);
    expect(byId.ok, byId.text).toBe(true);
    expect(t.app.activeTaskId()).toBe(old.taskId);
    t.ctx.store.setActive(t.b.taskId);
    expect((await t.app.plans("fix-par")).ok).toBe(true);
    expect(t.app.activeTaskId()).toBe(old.taskId);
  });

  it("switches by a unique prefix, and refuses an unknown, an ambiguous or a closed task", async () => {
    const t = await setup();
    expect((await t.app.plans("alp")).ok).toBe(true);
    expect(t.app.activeTaskId()).toBe(t.a.taskId);
    expect((await t.app.plans("nope")).code).toBe("NO_TASK");
    await addTask(t.app, "alpine", { at: "2026-10-12T10:00:00.000Z" });
    expect((await t.app.plans("alp")).text).toMatch(/matches 2 tasks/);
    expect((await t.app.plans("gamma")).code).toBe("CLOSED");
  });

  it("checks out the task's branch when the tree is clean", async () => {
    const t = await setup();
    const result = await t.app.plans("alpha");
    expect(result.text).toContain("Switched to branch chef/alpha.");
    expect(await git(t.cwd, "branch", "--show-current")).toBe("chef/alpha");
    expect(t.app.activeTaskId()).toBe(t.a.taskId);
  });

  it("switches the task but not the branch when the tree is dirty, and says what /build needs", async () => {
    const t = await setup();
    writeFileSync(path.join(t.cwd, "wip.txt"), "wip\n");
    const result = await t.app.plans("alpha");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("The branch was not changed");
    expect(result.text).toContain("/build needs a clean tree to switch to chef/alpha");
    expect(await git(t.cwd, "branch", "--show-current")).toBe(t.main);
    expect(t.app.activeTaskId()).toBe(t.a.taskId);
  });

  it("posts the plan of a draft with the approve picker", async () => {
    const seen: PlanReviewRequest[] = [];
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), rng: () => 0.5, startTurn: () => undefined });
    await app.startPlan("Add retry to the ingest parser");
    await app.savePlanSpec(sampleSpec);
    await app.commitTickets([sampleTicket("01")]);
    const draft = app.activeTaskId()!;
    await app.startPlan("Something else entirely");
    expect(app.activeTaskId()).not.toBe(draft);
    // bind() resets the hooks it is given; review is set per bind, as the extension does for each command.
    app.bind({ review: async (request: PlanReviewRequest) => (seen.push(request), { value: "approve" }) });
    const result = await app.plans("retry-ingest-parser");
    expect(result.ok, result.text).toBe(true);
    expect(app.activeTaskId()).toBe(draft);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.title).toBe("retry-ingest-parser · Plan v1 (draft)");
    expect(seen[0]!.markdown.startsWith("**Task retry-ingest-parser** · Draft v1")).toBe(true);
    expect(seen[0]!.actions.map((action) => action.value)).toEqual(["approve", "revise", "close"]);
    expect(app.store.load(draft)!.approvedVersion).toBe(1);
    expect(result.text).toContain("Approved plan v1");
  });
});

describe("/plans close", () => {
  it("asks first when the task has unfinished tickets, and keeps it open when declined", async () => {
    const asked: string[] = [];
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), rng: () => 0.5, startTurn: () => undefined });
    await app.startPlan("Add retry to the ingest parser");
    await app.savePlanSpec(sampleSpec);
    await app.commitTickets([sampleTicket("01"), sampleTicket("02")]);
    const id = app.activeTaskId()!;
    app.bind({ confirm: async (title, message) => (asked.push(`${title}: ${message}`), false) });
    const declined = await app.plans("close retry-ingest-parser");
    expect(declined.code).toBe("DECLINED");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("2 ticket(s) not built");
    expect(app.store.load(id)!.phase).not.toBe("COMPLETE");
    app.bind({ confirm: async () => true });
    const closed = await app.plans("close retry-ingest-parser");
    expect(closed.ok, closed.text).toBe(true);
    expect(app.store.load(id)!.phase).toBe("COMPLETE");
  });

  it("closes without a question when nothing is unfinished, keeps files and the branch, and makes no git call", async () => {
    const t = await setup({ confirm: async () => { throw new Error("must not ask"); } });
    t.spy.calls.length = 0;
    // beta is only planning (no tickets, no build): nothing to lose.
    const result = await t.app.plans("close beta");
    expect(result.ok, result.text).toBe(true);
    expect(t.spy.calls).toEqual([]);
    const closed = t.ctx.store.load(t.b.taskId)!;
    expect(closed).toMatchObject({ phase: "COMPLETE", closedReason: "closed by user" });
    expect(closed.closedAt).toBeTruthy();
    expect(existsSync(path.join(t.ctx.store.taskDir(t.b.taskId), "events.jsonl"))).toBe(true);
    expect(existsSync(path.join(t.ctx.store.taskDir(t.b.taskId), "state.json"))).toBe(true);
  });

  it("falls back to the most recently updated unfinished task when the active one is closed, and to none", async () => {
    const t = await setup({ confirm: async () => true });
    await addTask(t.app, "delta", { at: "2026-10-12T08:00:00.000Z" });
    t.ctx.store.setActive(t.b.taskId);
    const first = await t.app.plans("close beta");
    expect(first.text).toContain("Active task: delta.");
    expect(t.app.activeTaskId()).toBeDefined();
    expect(t.ctx.store.load(t.app.activeTaskId()!)!.name).toBe("delta");
    await t.app.plans("close delta");
    expect(t.ctx.store.load(t.app.activeTaskId()!)!.name).toBe("alpha");
    const last = await t.app.plans("close alpha");
    expect(last.text).toContain("No active task.");
    expect(t.app.activeTaskId()).toBeUndefined();
    // The branch of a closed task survives, and is not followed.
    expect(await git(t.cwd, "branch", "--list", "chef/alpha")).toContain("chef/alpha");
  });

  it("keeps the stored task when another task is closed, and refuses without a name", async () => {
    const t = await setup({ confirm: async () => true });
    await t.app.plans("close alpha");
    expect(t.app.activeTaskId()).toBe(t.b.taskId);
    expect((await t.app.plans("close")).code).toBe("USAGE");
    expect((await t.app.plans("close gamma")).text).toContain("already closed");
  });
});

describe("/status with several tasks", () => {
  it("shows name (id) and an Also open line only when other unfinished tasks exist", async () => {
    const t = await setup();
    const text = (await t.app.status()).text;
    expect(text).toBeDefined();
    const markdown = t.reports.at(-1)!;
    expect(markdown).toContain(`| Task | beta (${t.b.taskId}) |`);
    expect(markdown).toContain("\n\nAlso open: 1 task(s) — /plans\n");
    await t.app.plans("close alpha");
    await t.app.status();
    expect(t.reports.at(-1)).not.toContain("Also open");
  });

  it("returns the state line without markdown escapes, and escapes only inside table cells", async () => {
    const t = await setup();
    await t.ctx.store.update(t.b.taskId, "test", (task: TaskState) => ({ ...task, phase: "BLOCKED", blockedReason: "waiting on a | b" }));
    const result = await t.app.status();
    expect(result.text).toBe("Blocked · waiting on a | b");
    expect(result.text).not.toContain("\\");
    expect(t.reports.at(-1)).toContain("waiting on a \\| b");
    const plans = await t.app.plans("");
    expect(plans.text).not.toContain("\\");
    expect(t.reports.at(-1)).toContain("Blocked · waiting on a \\| b");
  });

  it("follows the checked-out branch", async () => {
    const t = await setup();
    await git(t.cwd, "switch", "chef/alpha");
    await t.app.status();
    expect(t.reports.at(-1)).toContain(`| Task | alpha (${t.a.taskId}) |`);
  });
});
