import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Ticket } from "../src/domain.js";
import { BUILD_CHUNK_RULES, runBuild, type BuildDriver, type ModelRef } from "../src/orchestrator/build.js";
import { checkRunner, sampleTicket, tempRepo, tieredConfig, ticketWorkflow, workflow } from "./helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

const ticket = sampleTicket;

interface Send {
  ticket: string;
  model: ModelRef;
  text: string;
  /** 0 for the chunk's prompt, 1 for the retry message. */
  turn: number;
}

interface Reply {
  lastText?: string;
  aborted?: boolean;
}

/** A driver whose "sessions" run a script: it may write files into the checkout, like a model would. */
function fakeDriver(cwd: string, script: (send: Send) => Reply | void | Promise<Reply | void>) {
  const sends: Send[] = [];
  const state = { fresh: 0, finished: 0 };
  const driver: BuildDriver = {
    async fresh(model, run) {
      state.fresh += 1;
      let current = "";
      let turn = 0;
      await run({
        async send(text) {
          current = text.match(/^# Ticket (\d+):/m)?.[1] ?? current;
          const send: Send = { ticket: current, model, text, turn: turn++ };
          sends.push(send);
          const reply = (await script(send)) ?? {};
          return { lastText: reply.lastText ?? "Done.\n- [x] retry works\nFiles changed: x", aborted: reply.aborted ?? false };
        },
      });
    },
    async finish() {
      state.finished += 1;
    },
  };
  const write = (name: string, body = "x\n") => writeFileSync(path.join(cwd, name), body);
  return { driver, sends, state, write };
}

async function buildTask(options: { tickets?: Ticket[]; runner?: ReturnType<typeof checkRunner>; mutate?: (config: ReturnType<typeof tieredConfig>) => void; approve?: boolean; branch?: string } = {}) {
  const cwd = await tempRepo();
  if (options.branch) await git(cwd, "switch", "-c", options.branch);
  const progress: string[] = [];
  const reports: string[] = [];
  const notices: string[] = [];
  const config = tieredConfig();
  options.mutate?.(config);
  const passing = { ok: true };
  const { app, taskId } = await ticketWorkflow(
    options.tickets ?? [ticket("01"), ticket("02", { blockedBy: ["01"] })],
    {
      config,
      progress: (message) => void progress.push(message),
      report: (markdown) => void reports.push(markdown),
      notify: (message) => void notices.push(message),
      runner: options.runner ?? checkRunner(async () => (passing.ok ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "AssertionError: expected 1" })),
    },
    { approve: options.approve, cwd },
  );
  const load = () => app.store.load(taskId)!;
  return { cwd, app, taskId, load, progress, reports, notices, passing, run: (driver: BuildDriver) => runBuild(() => app, driver) };
}

describe("/build order and routing", () => {
  it("builds in blockedBy order, not list order", async () => {
    const t = await buildTask({ tickets: [ticket("02", { blockedBy: ["01"] }), ticket("01")] });
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    const result = await t.run(d.driver);
    expect(result.ok, result.text).toBe(true);
    expect(d.sends.map((item) => item.ticket)).toEqual(["01", "02"]);
  });

  it("routes each ticket by its tier hint and puts the rules, spec, and blocker summary in the prompt", async () => {
    const t = await buildTask({ tickets: [ticket("01", { suggestedTier: "cheap" }), ticket("02", { suggestedTier: "standard", blockedBy: ["01"] })] });
    const d = fakeDriver(t.cwd, (send) => {
      d.write(`f${send.ticket}.txt`);
      return { lastText: `Added the retry loop in ticket ${send.ticket}.\n- [x] retry works\nFiles changed: f${send.ticket}.txt` };
    });
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(d.sends.map((item) => `${item.model.provider}/${item.model.id}`)).toEqual(["openai/gpt-6-luna", "foundry/grok-4-7"]);
    expect(d.sends[0]!.text.startsWith(BUILD_CHUNK_RULES)).toBe(true);
    expect(d.sends[0]!.text).toContain("Retry failed ingests.");
    expect(d.sends[0]!.text).toContain("Do not commit, push, merge, or switch branches");
    expect(d.sends[1]!.text).toContain("### 01: Ticket 01");
    expect(d.sends[1]!.text).toContain("Added the retry loop in ticket 01.");
    expect(t.load().ticketRuns!["02"]).toMatchObject({ status: "done", tier: "standard", provider: "foundry", model: "grok-4-7", attempts: 1 });
  });
});

describe("/build commits", () => {
  it("runs the checks, commits each ticket on a new branch, and moves on", async () => {
    const t = await buildTask();
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    const result = await t.run(d.driver);
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("/ship");
    const branch = await git(t.cwd, "branch", "--show-current");
    expect(branch).toBe(`cost/${t.taskId}`);
    expect(await git(t.cwd, "log", "--format=%s", "-3")).toBe("02: Ticket 02\n01: Ticket 01\nbase");
    expect(await git(t.cwd, "show", "--name-only", "--format=", "HEAD~1")).toBe("f01.txt");
    expect(await git(t.cwd, "status", "--porcelain")).toBe("");
    const state = t.load();
    expect(state.phase).toBe("IMPLEMENTING");
    expect(state.build!.branch).toBe(branch);
    expect(state.build!.currentTicket).toBeUndefined();
    expect(state.ticketRuns!["01"]).toMatchObject({ status: "done", commit: await git(t.cwd, "rev-parse", "HEAD~1") });
    const file = readFileSync(path.join(t.app.store.taskDir(t.taskId), "tickets", "01-t01.md"), "utf8");
    expect(file).toContain("## Status: done");
    expect(file).toContain("- [x] retry works");
    expect(t.app.store.readMetrics().general?.standard ?? t.app.store.readMetrics().general?.cheap).toBeDefined();
    expect(d.state.finished).toBe(1);
  });

  it("posts a progress line per ticket and a final table", async () => {
    const t = await buildTask({ tickets: [ticket("01", { suggestedTier: "standard" })] });
    const d = fakeDriver(t.cwd, (send) => {
      d.write("f.txt");
      // The main-session turn is ledgered as that ticket's spend.
      t.app.observeUsage({ provider: "foundry", model: "grok-4-7", usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, requests: 1 } });
      expect(send.ticket).toBe("01");
    });
    expect((await t.run(d.driver)).ok).toBe(true);
    const sha = (await git(t.cwd, "rev-parse", "--short=7", "HEAD")).slice(0, 7);
    expect(t.progress.find((line) => line.startsWith("Ticket 01 ·"))).toMatch(new RegExp(`^Ticket 01 · foundry/grok-4-7 · \\d+\\.\\ds · \\$0\\.0050 · checks passed · committed ${sha}$`));
    const ledger = t.app.store.readLedger().filter((item) => item.reason.includes("observed assistant usage"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reason).toBe("observed assistant usage · ticket 01");
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toContain("| 01 | Ticket 01 | foundry/grok-4-7 |");
    expect(t.reports[0]).toContain(`done ${sha}`);
    expect(t.reports[0]).toContain("Next: /ship");
  });

  it("clears the running ticket while no chunk runs, so branch rules lift", async () => {
    const t = await buildTask({ tickets: [ticket("01")] });
    const d = fakeDriver(t.cwd, () => {
      expect(t.app.buildingTicket()).toBe("01");
      d.write("f.txt");
    });
    await t.run(d.driver);
    expect(t.app.buildingTicket()).toBeUndefined();
  });
});

describe("/build failures", () => {
  it("sends the failing output once, then stops and marks the ticket failed with a metric strike", async () => {
    const t = await buildTask({ tickets: [ticket("01", { suggestedTier: "cheap" }), ticket("02", { blockedBy: ["01"] })] });
    t.passing.ok = false;
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    const result = await t.run(d.driver);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CHECKS_FAILED");
    expect(d.sends.map((item) => [item.ticket, item.turn])).toEqual([["01", 0], ["01", 1]]);
    expect(d.sends[1]!.text).toContain("AssertionError: expected 1");
    expect(d.sends[1]!.text).toContain("Fix it; do not commit.");
    expect(t.load().ticketRuns!["01"]).toMatchObject({ status: "failed" });
    expect(t.load().ticketRuns!["02"]).toBeUndefined();
    expect(t.load().build!.currentTicket).toBeUndefined();
    expect(t.app.store.readMetrics().general?.cheap).toMatchObject({ failure: 1 });
    expect(await git(t.cwd, "log", "--format=%s")).toBe("base");
    expect(d.state.finished).toBe(1);
    expect(t.reports[0]).toContain("| 01 | Ticket 01 | openai/gpt-6-luna |");
    expect(t.reports[0]).toContain("failed");
  });

  it("lets the retry fix it in the same session", async () => {
    const t = await buildTask({ tickets: [ticket("01")] });
    t.passing.ok = false;
    const d = fakeDriver(t.cwd, (send) => {
      d.write("f.txt");
      if (send.turn === 1) t.passing.ok = true;
    });
    const result = await t.run(d.driver);
    expect(result.ok, result.text).toBe(true);
    expect(d.sends).toHaveLength(2);
    expect(d.state.fresh).toBe(1);
    expect(await git(t.cwd, "log", "--format=%s", "-1")).toBe("01: Ticket 01");
  });

  it("commits a fix made by hand on the next /build without a model turn", async () => {
    const t = await buildTask({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })] });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, (send) => first.write(`f${send.ticket}.txt`));
    expect((await t.run(first.driver)).ok).toBe(false);
    // The person fixes it in the chat; the checks pass now.
    t.passing.ok = true;
    writeFileSync(path.join(t.cwd, "hand-fix.txt"), "fixed\n");
    const second = fakeDriver(t.cwd, (send) => second.write(`f${send.ticket}.txt`));
    const result = await t.run(second.driver);
    expect(result.ok, result.text).toBe(true);
    expect(second.sends.map((item) => item.ticket)).toEqual(["02"]);
    expect(await git(t.cwd, "show", "--name-only", "--format=%s", "HEAD~1")).toBe("01: Ticket 01\n\nf01.txt\nhand-fix.txt");
    expect(t.progress.some((line) => line.includes("Ticket 01 · checks passed on your changes"))).toBe(true);
    expect(t.load().ticketRuns!["01"]).toMatchObject({ status: "done" });
    // No credit to the model for a fix it did not make.
    expect(t.app.store.readMetrics().general?.standard?.success ?? 0).toBe(0);
  });

  it("sends a ticket that is still failing to the next tier up", async () => {
    const t = await buildTask({ tickets: [ticket("01", { suggestedTier: "cheap" })] });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    await t.run(first.driver);
    expect(first.sends[0]!.model).toEqual({ provider: "openai", id: "gpt-6-luna" });
    const second = fakeDriver(t.cwd, () => {
      t.passing.ok = true;
    });
    const result = await t.run(second.driver);
    // The checks still fail on the tree as it is, so the ticket goes to a model again, one tier up.
    expect(second.sends[0]!.model).toEqual({ provider: "foundry", id: "grok-4-7" });
    expect(second.sends[0]!.text).toContain("AssertionError: expected 1");
    expect(result.ok, result.text).toBe(true);
    expect(t.load().ticketRuns!["01"]).toMatchObject({ status: "done", attempts: 2, tier: "standard" });
  });

  it("does not strike the model when a check cannot run", async () => {
    const t = await buildTask({
      tickets: [ticket("01", { suggestedTier: "cheap" })],
      mutate: (config) => {
        config.checks = [{ name: "wipe", command: "rm", args: ["-rf", "/"] }];
      },
    });
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    const result = await t.run(d.driver);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CHECKS_UNRUNNABLE");
    expect(d.sends).toHaveLength(1);
    expect(t.load().ticketRuns!["01"]!.status).toBe("failed");
    expect(t.app.store.readMetrics().general?.cheap).toBeUndefined();
  });

  it("passes with a warning when no checks exist at all", async () => {
    const t = await buildTask({
      tickets: [ticket("01")],
      mutate: (config) => {
        config.checks = [];
      },
    });
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(t.progress.some((line) => line.includes("nothing verified it"))).toBe(true);
  });

  it("uses the ticket's own checks instead of the configured ones, and runs setup once", async () => {
    const ran: string[] = [];
    const t = await buildTask({
      tickets: [ticket("01", { checks: ["npx vitest run a"] }), ticket("02", { blockedBy: ["01"] })],
      runner: checkRunner(async (command, args) => (ran.push([command, ...args].join(" ")), { code: 0, stdout: "ok", stderr: "" })),
      mutate: (config) => {
        config.setup = [{ name: "install", command: "npm", args: ["ci"] }];
      },
    });
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(ran).toEqual(["npm ci", "npx vitest run a", "npm test"]);
  });
});

describe("/build stops", () => {
  it("leaves an aborted ticket in progress and starts nothing else", async () => {
    const t = await buildTask({ tickets: [ticket("01", { suggestedTier: "cheap" }), ticket("02", { blockedBy: ["01"] })] });
    const d = fakeDriver(t.cwd, () => ({ aborted: true }));
    const result = await t.run(d.driver);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ABORTED");
    expect(d.sends).toHaveLength(1);
    expect(t.load().ticketRuns!["01"]!.status).toBe("in-progress");
    expect(t.load().build!.currentTicket).toBeUndefined();
    expect(await git(t.cwd, "log", "--format=%s")).toBe("base");
    expect(d.state.finished).toBe(1);
    expect(t.app.store.readMetrics().general).toBeUndefined();
    // An interruption is not a failure: the resumed ticket stays on the same tier.
    const again = fakeDriver(t.cwd, (send) => again.write(`f${send.ticket}.txt`));
    expect((await t.run(again.driver)).ok).toBe(true);
    expect(again.sends[0]!.model).toEqual({ provider: "openai", id: "gpt-6-luna" });
    expect(again.sends[0]!.text).toContain("interrupted");
  });

  it("does not auto-commit an interrupted ticket's leftovers: it goes to a model again on the same tier", async () => {
    const t = await buildTask({ tickets: [ticket("01", { suggestedTier: "cheap" })] });
    const first = fakeDriver(t.cwd, () => {
      first.write("partial.txt");
      return { aborted: true };
    });
    await t.run(first.driver);
    const again = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(again.driver);
    expect(result.ok, result.text).toBe(true);
    expect(again.sends).toHaveLength(1);
    expect(again.sends[0]!.model).toEqual({ provider: "openai", id: "gpt-6-luna" });
    expect(again.sends[0]!.text).toContain("Uncommitted changes from an interrupted attempt are in the working tree");
    expect(t.progress.some((line) => line.includes("on your changes"))).toBe(false);
  });

  it("starts nothing at the hard budget", async () => {
    const t = await buildTask();
    t.app.store.appendLedger({
      id: "big", at: new Date("2026-10-14T12:00:00.000Z").toISOString(), taskId: t.taskId, phase: "IMPLEMENTING", provider: "openai", model: "gpt-5.4", tier: "premium",
      requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd: 9999, usageKnown: true, outcome: "success", retries: 0, reason: "test",
    });
    const d = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(d.driver);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("BUDGET");
    expect(d.state.fresh).toBe(0);
  });

  it("stops before the next ticket when the budget runs out mid-build", async () => {
    const t = await buildTask({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })] });
    const d = fakeDriver(t.cwd, (send) => {
      d.write(`f${send.ticket}.txt`);
      t.app.store.appendLedger({
        id: "big", at: new Date("2026-10-14T12:00:00.000Z").toISOString(), taskId: t.taskId, phase: "IMPLEMENTING", provider: "openai", model: "gpt-5.4", tier: "premium",
        requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd: 9999, usageKnown: true, outcome: "success", retries: 0, reason: "test",
      });
    });
    const result = await t.run(d.driver);
    expect(result.code).toBe("BUDGET");
    expect(d.sends.map((item) => item.ticket)).toEqual(["01"]);
    expect(t.load().ticketRuns!["01"]!.status).toBe("done");
  });

  it("always restores the model, even when the session cannot be opened", async () => {
    const t = await buildTask({ tickets: [ticket("01")] });
    const state = { finished: 0 };
    const driver: BuildDriver = {
      async fresh() {
        throw new Error("Pi did not open a new session (cancelled).");
      },
      async finish() {
        state.finished += 1;
      },
    };
    const result = await t.run(driver);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("did not open a new session");
    expect(state.finished).toBe(1);
    expect(t.load().build!.currentTicket).toBeUndefined();
    expect(t.load().ticketRuns!["01"]!.status).toBe("in-progress");
  });

  it("re-resolves the workflow on every step", async () => {
    const t = await buildTask({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })] });
    let resolved = 0;
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    const result = await runBuild(() => (resolved++, t.app), d.driver);
    expect(result.ok).toBe(true);
    expect(resolved).toBeGreaterThan(6);
  });
});

describe("/build branch and approval", () => {
  it("reuses the branch it is on and records the default branch as the base", async () => {
    const t = await buildTask({ branch: "feature/mine" });
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(await git(t.cwd, "branch", "--show-current")).toBe("feature/mine");
    expect(await git(t.cwd, "branch", "--list", "cost/*")).toBe("");
    const build = t.load().build!;
    expect(build.branch).toBe("feature/mine");
    expect(build.base).toBe(await t.app.git.defaultBranch());
    expect(build.baseSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses to resume on a different branch", async () => {
    const t = await buildTask();
    t.passing.ok = false;
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    await t.run(d.driver);
    const branch = t.load().build!.branch;
    await git(t.cwd, "switch", "-c", "elsewhere");
    const again = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(again.driver);
    expect(result.code).toBe("WRONG_BRANCH");
    expect(result.text).toContain(`git switch ${branch}`);
    expect(again.state.fresh).toBe(0);
  });

  it("refuses to start a fresh build on a dirty tree, but not a resumed one", async () => {
    const t = await buildTask({ tickets: [ticket("01")] });
    writeFileSync(path.join(t.cwd, "mine.txt"), "wip\n");
    const d = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(d.driver);
    expect(result.code).toBe("DIRTY_TREE");
    expect(result.text).toContain("Commit or stash them first");
    expect(d.state.fresh).toBe(0);
    expect(t.load().build).toBeUndefined();
    // Once a build exists, a dirty tree is the ticket's own work.
    await git(t.cwd, "add", "mine.txt");
    await git(t.cwd, "commit", "-m", "mine");
    const first = fakeDriver(t.cwd, () => ({ aborted: true }));
    await t.run(first.driver);
    writeFileSync(path.join(t.cwd, "partial.txt"), "x\n");
    const resumed = fakeDriver(t.cwd, () => undefined);
    expect((await t.run(resumed.driver)).code).not.toBe("DIRTY_TREE");
    expect(resumed.sends).toHaveLength(1);
  });

  it("ignores the workspace directory when judging a dirty tree", async () => {
    const t = await buildTask({ tickets: [ticket("01")] });
    writeFileSync(path.join(t.app.store.root, "stray.json"), "{}\n");
    await git(t.cwd, "status", "--porcelain");
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    expect((await t.run(d.driver)).code).not.toBe("DIRTY_TREE");
  });

  it("refuses a draft plan", async () => {
    const t = await buildTask({ approve: false });
    const d = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(d.driver);
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(d.state.fresh).toBe(0);
  });

  it("asks for a re-plan when the plan has no tickets", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig() });
    await app.plan("Maintain Neo.\n```tasks\n[{\"id\":\"a\",\"summary\":\"x\",\"files\":[\"a.ts\"],\"edits\":[{\"path\":\"a.ts\",\"content\":\"x\\n\"}]}]\n```");
    expect((await app.approveDraft()).ok).toBe(true);
    const d = fakeDriver(cwd, () => undefined);
    const result = await runBuild(() => app, d.driver);
    expect(result.code).toBe("NO_TICKETS");
    expect(result.text).toContain("Re-plan");
  });
});
