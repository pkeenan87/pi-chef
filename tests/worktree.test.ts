import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { mainCheckoutOf } from "../src/git/workspace.js";
import { runBuild, type BuildDriver } from "../src/orchestrator/build.js";
import { Workflow } from "../src/orchestrator/service.js";
import type { WorkflowOptions } from "../src/orchestrator/types.js";
import { checkRunner, readyAuth, sampleTicket, tieredConfig, ticketWorkflow } from "./helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

/**
 * A task ready to build, and a fake Pi host: `enter` moves "Pi" into the worktree the way the extension does after
 * switchSession, by resolving a new Workflow for that directory; tickets then write their files there.
 */
async function worktreeTask(options: { enter?: boolean; tickets?: number; isolation?: { worktree: boolean; dir: string }; setup?: boolean } = {}) {
  const progress: string[] = [];
  const config = tieredConfig();
  if (options.isolation) config.isolation = options.isolation;
  if (options.setup) config.setup = [{ name: "install", command: "npm", args: ["ci"] }];
  const ran: string[] = [];
  const runner = checkRunner(async (command, args, cwd) => (ran.push(`${[command, ...args].join(" ")} in ${cwd}`), { code: 0, stdout: "ok", stderr: "" }));
  const extras = { config, runner, auth: readyAuth(), progress: (message: string) => void progress.push(message) } satisfies Partial<WorkflowOptions>;
  const tickets = Array.from({ length: options.tickets ?? 2 }, (_, i) => sampleTicket(`0${i + 1}`, i ? { blockedBy: [`0${i}`] } : {}));
  const { app, taskId, cwd } = await ticketWorkflow(tickets, extras);
  const host = { workflow: app as Workflow, entered: [] as string[], sends: [] as string[] };
  const driver: BuildDriver = {
    async fresh(_model, run) {
      await run({
        async send(text) {
          const id = text.match(/^# Ticket (\d+):/m)?.[1] ?? "?";
          host.sends.push(`${id} in ${host.workflow.cwd}`);
          writeFileSync(path.join(host.workflow.cwd, `f${id}.txt`), "x\n");
          return { lastText: "Done.\n- [x] retry works", aborted: false };
        },
      });
    },
    async finish() {},
  };
  if (options.enter !== false) {
    driver.enter = async (dir) => {
      host.entered.push(dir);
      host.workflow = new Workflow({ cwd: dir, ...extras });
    };
  }
  const run = () => runBuild(() => host.workflow, driver);
  return { app, taskId, cwd, host, driver, run, progress, ran, load: () => app.store.load(taskId)! };
}

describe("/build in a worktree", () => {
  it("builds each task in its own worktree on its own branch and leaves the main checkout alone", async () => {
    const t = await worktreeTask();
    const before = await git(t.cwd, "branch", "--show-current");
    writeFileSync(path.join(t.cwd, "mine.txt"), "uncommitted\n");
    const result = await t.run();
    expect(result.ok, result.text).toBe(true);
    const build = t.load().build!;
    expect(build.branch).toBe(`chef/${t.load().name}`);
    expect(build.worktree).toBe(path.join(path.dirname(t.cwd), `${path.basename(t.cwd)}.worktrees`, t.load().name!));
    expect(t.host.entered).toEqual([build.worktree]);
    expect(t.host.sends).toEqual([`01 in ${build.worktree}`, `02 in ${build.worktree}`]);
    // The main checkout keeps its branch and its uncommitted file; the commits are on the task's branch only.
    expect(await git(t.cwd, "branch", "--show-current")).toBe(before);
    expect(readFileSync(path.join(t.cwd, "mine.txt"), "utf8")).toBe("uncommitted\n");
    expect(existsSync(path.join(t.cwd, "f01.txt"))).toBe(false);
    expect(await git(build.worktree!, "branch", "--show-current")).toBe(build.branch);
    expect((await git(t.cwd, "log", "--format=%s", build.branch)).split("\n")).toHaveLength(3);
    expect(await git(t.cwd, "log", "--format=%s", before)).toBe("base");
    expect(t.progress.some((line) => line.startsWith(`Created worktree ${build.worktree} on ${build.branch}`) && line.includes("Uncommitted changes"))).toBe(true);
  });

  it("shares the main checkout's state from the worktree, with a pointer of its own", async () => {
    const t = await worktreeTask();
    expect((await t.run()).ok).toBe(true);
    const dir = t.load().build!.worktree!;
    expect(mainCheckoutOf(dir)).toBe(t.cwd);
    expect(mainCheckoutOf(t.cwd)).toBe(t.cwd);
    expect(t.host.workflow.store.root).toBe(t.app.store.root);
    expect(t.host.workflow.git.repoRoot).toBe(dir);
    // Each checkout points at its own active task, so a second Pi elsewhere does not move this one.
    expect(t.host.workflow.store.readActive()).toBe(t.taskId);
    expect(t.app.store.readActive()).toBe(t.taskId);
    t.app.store.clearActive();
    expect(t.host.workflow.store.readActive()).toBe(t.taskId);
    // The claim is released when the build ends.
    expect(existsSync(path.join(t.app.store.taskDir(t.taskId), "build.claim"))).toBe(false);
  });

  it("recreates a removed worktree on its branch when the build resumes, and runs setup again there", async () => {
    const t = await worktreeTask({ setup: true });
    const first = await t.run();
    expect(first.ok, first.text).toBe(true);
    const dir = t.load().build!.worktree!;
    expect(t.ran.filter((line) => line === `npm ci in ${dir}`)).toHaveLength(1);
    // Ticket 02 is marked failed, so the resumed build has work left.
    await t.app.store.update(t.taskId, "test", (task) => ({ ...task, ticketRuns: { ...task.ticketRuns, "02": { ...task.ticketRuns!["02"]!, status: "failed", failedBy: "checks" } } }));
    rmSync(dir, { recursive: true, force: true });
    // Resume from the main checkout, as after a restart.
    t.host.workflow = t.app;
    const again = await t.run();
    expect(again.ok, again.text).toBe(true);
    expect(await git(dir, "branch", "--show-current")).toBe(t.load().build!.branch);
    expect(t.progress.some((line) => line === `Recreated worktree ${dir} on ${t.load().build!.branch}.`)).toBe(true);
    expect(t.ran.filter((line) => line === `npm ci in ${dir}`)).toHaveLength(2);
  });

  it("skips to -3 when -2 is taken too, and says where a worktree task's branch lives on /plans", async () => {
    const t = await worktreeTask({ tickets: 1 });
    const stem = `chef/${t.load().name}`;
    await git(t.cwd, "branch", stem);
    await git(t.cwd, "branch", `${stem}-2`);
    expect((await t.run()).ok).toBe(true);
    expect(t.load().build!.branch).toBe(`${stem}-3`);
    const switched = await t.app.plans(t.load().name!);
    expect(switched.text).toContain(`Its branch ${stem}-3 is checked out in ${t.load().build!.worktree}`);
  });

  it("copies the untracked .pi project folder into the worktree and keeps it out of the commits", async () => {
    const t = await worktreeTask();
    mkdirSync(path.join(t.cwd, ".pi", "git"), { recursive: true });
    writeFileSync(path.join(t.cwd, ".pi", "settings.json"), '{ "packages": ["git:github.com/pkeenan87/pi-chef"] }\n');
    writeFileSync(path.join(t.cwd, ".pi", "git", "pkg.txt"), "installed\n");
    const result = await t.run();
    expect(result.ok, result.text).toBe(true);
    const build = t.load().build!;
    expect(build.copied).toEqual([".pi"]);
    expect(readFileSync(path.join(build.worktree!, ".pi", "settings.json"), "utf8")).toContain("pi-chef");
    expect(existsSync(path.join(build.worktree!, ".pi", "git", "pkg.txt"))).toBe(true);
    expect(t.progress.some((line) => line.startsWith(`Copied ${path.join(t.cwd, ".pi")} into the worktree`))).toBe(true);
    // The tickets' commits hold their own files, never the copy.
    expect(await git(t.cwd, "log", "--name-only", "--format=", build.branch)).not.toContain(".pi/");
    expect(await git(build.worktree!, "status", "--short")).toBe("?? .pi/");
  });

  it("copies .pi into a worktree that lacks it when the build resumes, and never a tracked .pi", async () => {
    const t = await worktreeTask();
    t.driver.fresh = async () => ({ stopped: "gone" });
    await t.run();
    const dir = t.load().build!.worktree!;
    expect(existsSync(path.join(dir, ".pi"))).toBe(false);
    mkdirSync(path.join(t.cwd, ".pi"));
    writeFileSync(path.join(t.cwd, ".pi", "settings.json"), "{}\n");
    t.host.workflow = t.app;
    await t.run();
    expect(existsSync(path.join(dir, ".pi", "settings.json"))).toBe(true);
    expect(t.load().build!.copied).toEqual([".pi"]);

    const tracked = await worktreeTask({ tickets: 1 });
    mkdirSync(path.join(tracked.cwd, ".pi"));
    writeFileSync(path.join(tracked.cwd, ".pi", "settings.json"), "{}\n");
    await git(tracked.cwd, "add", ".pi");
    await git(tracked.cwd, "commit", "-q", "-m", "pi settings");
    writeFileSync(path.join(tracked.cwd, ".pi", "local.json"), "{}\n");
    expect((await tracked.run()).ok).toBe(true);
    expect(tracked.load().build!.copied).toBeUndefined();
    expect(existsSync(path.join(tracked.load().build!.worktree!, ".pi", "local.json"))).toBe(false);
  });

  it("refuses a second /build of a task another live Pi process is building", async () => {
    const t = await worktreeTask();
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      writeFileSync(path.join(t.app.store.taskDir(t.taskId), "build.claim"), JSON.stringify({ pid: other.pid, checkout: "/elsewhere", at: "now" }));
      const result = await t.run();
      expect(result.code).toBe("BUILD_RUNNING");
      expect(result.text).toContain(`pid ${other.pid}, in /elsewhere`);
      expect(t.load().build).toBeUndefined();
      expect(t.host.sends).toEqual([]);
    } finally {
      other.kill();
    }
  });

  it("takes over a claim whose process is gone", async () => {
    const t = await worktreeTask({ tickets: 1 });
    writeFileSync(path.join(t.app.store.taskDir(t.taskId), "build.claim"), JSON.stringify({ pid: 2 ** 22 + 7, checkout: "/gone", at: "then" }));
    const result = await t.run();
    expect(result.ok, result.text).toBe(true);
  });

  it("works in the main checkout on a new branch when Pi cannot move into a worktree", async () => {
    const t = await worktreeTask({ enter: false, tickets: 1 });
    const result = await t.run();
    expect(result.ok, result.text).toBe(true);
    expect(t.load().build!.worktree).toBeUndefined();
    expect(await git(t.cwd, "branch", "--show-current")).toBe(t.load().build!.branch);
    expect(t.progress).toContain("This Pi session cannot move into a worktree, so /build works in this checkout on a new branch.");
  });

  it("will not resume a worktree build from a Pi that cannot move there", async () => {
    const t = await worktreeTask();
    // The first ticket's session dies before any turn, so the build stops with ticket 01 not started.
    const real = t.driver.fresh;
    t.driver.fresh = async () => ({ stopped: "gone" });
    await t.run();
    t.driver.fresh = real;
    const dir = t.load().build!.worktree!;
    t.host.workflow = t.app;
    delete t.driver.enter;
    const result = await t.run();
    expect(result.code).toBe("WORKTREE");
    expect(result.text).toContain(`Start pi in ${dir} and run /build.`);
  });

  it("uses isolation.dir for the worktrees, and works in the checkout when isolation.worktree is off", async () => {
    const t = await worktreeTask({ tickets: 1, isolation: { worktree: true, dir: ".chef-trees" } });
    expect((await t.run()).ok).toBe(true);
    expect(t.load().build!.worktree).toBe(path.join(t.cwd, ".chef-trees", t.load().name!));

    const off = await worktreeTask({ tickets: 1, isolation: { worktree: false, dir: "" } });
    expect((await off.run()).ok).toBe(true);
    expect(off.load().build!.worktree).toBeUndefined();
    expect(off.host.entered).toEqual([]);
  });
});
