import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function buildTask(options: { tickets?: Ticket[]; runner?: ReturnType<typeof checkRunner>; mutate?: (config: ReturnType<typeof tieredConfig>) => void; approve?: boolean; branch?: string; confirm?: (title: string, message: string) => Promise<boolean> } = {}) {
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
      ...(options.confirm ? { confirm: options.confirm } : {}),
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

  it("routes each ticket by its difficulty and puts the rules, spec, and blocker summary in the prompt", async () => {
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "low" }), ticket("02", { difficulty: "medium", blockedBy: ["01"] })] });
    const d = fakeDriver(t.cwd, (send) => {
      d.write(`f${send.ticket}.txt`);
      return { lastText: `Added the retry loop in ticket ${send.ticket}.\n- [x] retry works\nFiles changed: f${send.ticket}.txt` };
    });
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(d.sends.map((item) => `${item.model.provider}/${item.model.id}`)).toEqual(["xai/grok-4.7", "anthropic/claude-sonnet-5-5"]);
    expect(d.sends[0]!.text.startsWith(BUILD_CHUNK_RULES)).toBe(true);
    expect(d.sends[0]!.text).toContain("Retry failed ingests.");
    expect(d.sends[0]!.text).toContain("Do not commit, push, merge, or switch branches");
    expect(d.sends[1]!.text).toContain("### 01: Ticket 01");
    expect(d.sends[1]!.text).toContain("Added the retry loop in ticket 01.");
    expect(t.load().ticketRuns!["02"]).toMatchObject({ status: "done", tier: "ticketMedium", provider: "anthropic", model: "claude-sonnet-5-5", attempts: 1 });
  });
});

describe("/build commits", () => {
  it("runs the checks, commits each ticket on a new branch, and moves on", async () => {
    const t = await buildTask();
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    const result = await t.run(d.driver);
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("/review");
    const branch = await git(t.cwd, "branch", "--show-current");
    expect(branch).toBe(`chef/${t.app.store.load(t.taskId)!.name}`);
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
    expect(t.app.store.readMetrics().general?.ticketMedium ?? t.app.store.readMetrics().general?.ticketLow).toBeDefined();
    expect(d.state.finished).toBe(1);
  });

  it("posts a progress line per ticket and a final table", async () => {
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "medium" })] });
    const d = fakeDriver(t.cwd, (send) => {
      d.write("f.txt");
      // The main-session turn is ledgered as that ticket's spend.
      t.app.observeUsage({ provider: "anthropic", model: "claude-sonnet-5-5", usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, requests: 1 } });
      expect(send.ticket).toBe("01");
    });
    expect((await t.run(d.driver)).ok).toBe(true);
    const sha = (await git(t.cwd, "rev-parse", "--short=7", "HEAD")).slice(0, 7);
    expect(t.progress.find((line) => line.startsWith("Ticket 01 ·"))).toMatch(new RegExp(`^Ticket 01 · medium · anthropic/claude-sonnet-5-5 · \\d+\\.\\ds · \\$0\\.0180 · checks passed · committed ${sha}$`));
    const ledger = t.app.store.readLedger().filter((item) => item.reason.includes("observed assistant usage"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reason).toBe("observed assistant usage · ticket 01");
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toContain("| 01 | Ticket 01 | medium | anthropic/claude-sonnet-5-5 |");
    expect(t.reports[0]).toContain(`done ${sha}`);
    expect(t.reports[0]).toContain("Next: /review");
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
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "low" }), ticket("02", { blockedBy: ["01"] })] });
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
    expect(t.app.store.readMetrics().general?.ticketLow).toMatchObject({ failure: 1 });
    expect(await git(t.cwd, "log", "--format=%s")).toBe("base");
    expect(d.state.finished).toBe(1);
    expect(t.reports[0]).toContain("| 01 | Ticket 01 | low | xai/grok-4.7 |");
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
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "low" })] });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    await t.run(first.driver);
    expect(first.sends[0]!.model).toEqual({ provider: "xai", id: "grok-4.7" });
    const second = fakeDriver(t.cwd, () => {
      t.passing.ok = true;
    });
    const result = await t.run(second.driver);
    // The checks still fail on the tree as it is, so the ticket goes to a model again, one tier up.
    expect(second.sends[0]!.model).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
    expect(second.sends[0]!.text).toContain("AssertionError: expected 1");
    expect(result.ok, result.text).toBe(true);
    expect(t.load().ticketRuns!["01"]).toMatchObject({ status: "done", attempts: 2, tier: "ticketMedium" });
  });

  it("starts low, medium and high tickets on grok, sonnet and sol", async () => {
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "low" }), ticket("02", { difficulty: "medium" }), ticket("03", { difficulty: "high" })] });
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(d.sends.map((item) => `${item.model.provider}/${item.model.id}`)).toEqual(["xai/grok-4.7", "anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol"]);
    expect(["01", "02", "03"].map((id) => t.load().ticketRuns![id]!.tier)).toEqual(["ticketLow", "ticketMedium", "ticketHigh"]);
  });

  it("maps old suggestedTier-only tickets and prefers difficulty when both are set", async () => {
    const t = await buildTask({ tickets: [ticket("01", { suggestedTier: "deterministic" }), ticket("02", { suggestedTier: "standard" }), ticket("03", { suggestedTier: "premium" }), ticket("04", { suggestedTier: "premium", difficulty: "low" }), ticket("05")] });
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(d.sends.map((item) => item.model.id)).toEqual(["grok-4.7", "claude-sonnet-5-5", "gpt-6.1-sol", "grok-4.7", "claude-sonnet-5-5"]);
  });

  it("escalates grok, sonnet, sol, opus on repeated failures", async () => {
    // As in the sample config, premium lists Opus alone.
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "low" })], mutate: (config) => void (config.tiers.premium = [{ provider: "anthropic", model: "claude-opus-5-5" }]) });
    t.passing.ok = false;
    const used: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const d = fakeDriver(t.cwd, () => d.write(`f${attempt}.txt`));
      await t.run(d.driver);
      used.push(d.sends[0]!.model.id);
    }
    expect(used).toEqual(["grok-4.7", "claude-sonnet-5-5", "gpt-6.1-sol", "claude-opus-5-5"]);
    expect(t.load().ticketRuns!["01"]!.tier).toBe("premium");
  });

  it("stops a ticket still failing on premium instead of re-running premium on every /build", async () => {
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "high" })], mutate: (config) => void (config.tiers.premium = [{ provider: "anthropic", model: "claude-opus-5-5" }]) });
    t.passing.ok = false;
    const used: string[] = [];
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      const d = fakeDriver(t.cwd, () => d.write(`f${attempt}.txt`));
      last = await t.run(d.driver);
      used.push(d.sends[0]?.model.id ?? "none");
    }
    expect(used).toEqual(["gpt-6.1-sol", "claude-opus-5-5", "none"]);
    expect(last!.code).toBe("MAX_ESCALATIONS");
    expect(last!.text).toContain("top of the ladder");
  });

  it("starts a security-sensitive plan's tickets on their own difficulty tier", async () => {
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "low" })], approve: true });
    await t.app.store.update(t.taskId, "test", (state) => ({ ...state, plan: { ...state.plan!, securitySensitive: true } }));
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(d.sends[0]!.model.id).toBe("grok-4.7");
  });

  it("does not strike the model when a check cannot run", async () => {
    const t = await buildTask({
      tickets: [ticket("01", { difficulty: "low" })],
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
    expect(t.app.store.readMetrics().general?.ticketLow).toBeUndefined();
  });

  it("keeps a ticket whose check could not run on its tier once the check is fixed", async () => {
    const t = await buildTask({
      tickets: [ticket("01", { difficulty: "low" })],
      mutate: (config) => {
        config.checks = [{ name: "wipe", command: "rm", args: ["-rf", "/"] }];
      },
    });
    const first = fakeDriver(t.cwd, () => first.write("f.txt"));
    const stopped = await t.run(first.driver);
    expect(stopped.text).toContain("stays on ticketLow");
    t.app.config.checks = [{ name: "unit", command: "npm", args: ["test"] }];
    rmSync(path.join(t.cwd, "f.txt"));
    const second = fakeDriver(t.cwd, () => second.write("f.txt"));
    expect((await t.run(second.driver)).ok).toBe(true);
    expect(second.sends[0]!.model.id).toBe("grok-4.7");
    expect(t.load().ticketRuns!["01"]!.tier).toBe("ticketLow");
  });

  it("shows one ticket's attempts and reviews with /status <ticket>", async () => {
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "low" })] });
    t.passing.ok = false;
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    await t.run(d.driver);
    const result = await t.app.status("1");
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toMatch(/^Ticket 01 · failed: Checks failed after a retry: ### unit \(exit 1\)/);
    expect(result.text).not.toContain("\n");
    const markdown = t.reports.at(-1)!;
    expect(markdown).toContain("## Ticket 01 · ");
    expect(markdown).toMatch(/\| 1 \| ticketLow \| xai\/grok-4\.7 \| .+ \| failed \(checks\)/);
    expect((await t.app.status("09")).text).toContain("/status <ticket id> (01)");
    expect((await t.app.status("")).text).toContain("/status 01 shows its attempts");
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
    expect(t.load().ticketRuns!["01"]!.unverified).toBe("no checks");
    expect(t.reports.at(-1)).toMatch(/\| unverified [0-9a-f]{7} \(no checks\) \|/);
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
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "low" }), ticket("02", { blockedBy: ["01"] })] });
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
    expect(again.sends[0]!.model).toEqual({ provider: "xai", id: "grok-4.7" });
    expect(again.sends[0]!.text).toContain("interrupted");
  });

  it("does not auto-commit an interrupted ticket's leftovers: it goes to a model again on the same tier", async () => {
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "low" })] });
    const first = fakeDriver(t.cwd, () => {
      first.write("partial.txt");
      return { aborted: true };
    });
    await t.run(first.driver);
    const again = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(again.driver);
    expect(result.ok, result.text).toBe(true);
    expect(again.sends).toHaveLength(1);
    expect(again.sends[0]!.model).toEqual({ provider: "xai", id: "grok-4.7" });
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
    // The session never took a turn, so the ticket is back to not started.
    expect(t.load().ticketRuns!["01"]).toBeUndefined();
  });

  it("rolls a ticket back to not started when the driver stops before the first turn, and counts no metric", async () => {
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "high" })] });
    const driver: BuildDriver = {
      async fresh() {
        return { stopped: "The new session is on anthropic/claude-opus-5-5, not the routed openai/gpt-6.1-sol." };
      },
      async finish() {},
    };
    const result = await t.run(driver);
    expect(result).toMatchObject({ ok: false, code: "BUILD_STOPPED" });
    expect(result.text).toContain("not the routed");
    const state = t.load();
    expect(state.ticketRuns?.["01"]).toBeUndefined();
    expect(state.build!.currentTicket).toBeUndefined();
    expect(t.app.store.readMetrics()).toEqual({});
    // The next /build starts it fresh on its own tier, as attempt 1.
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(t.load().ticketRuns!["01"]).toMatchObject({ status: "done", tier: "ticketHigh", attempts: 1 });
  });

  it("records a ticket committed just before /build stopped as done, without building it again", async () => {
    const t = await buildTask({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })] });
    const parent = (await git(t.cwd, "rev-parse", "HEAD")).trim();
    const first = fakeDriver(t.cwd, (send) => first.write(`f${send.ticket}.txt`));
    expect((await t.run(first.driver)).ok).toBe(true);
    const sha = t.load().ticketRuns!["02"]!.commit!;
    // As if the process died after ticket 02's commit and before its run was saved.
    const before = (await git(t.cwd, "rev-parse", `${sha}~1`)).trim();
    expect(before).not.toBe(parent);
    await t.app.store.update(t.taskId, "crash", (state) => ({
      ...state,
      ticketRuns: { ...state.ticketRuns, "02": { ...state.ticketRuns!["02"]!, status: "in-progress", commit: undefined, attemptStart: { at: "2026-01-01T00:00:00.000Z", head: before } } },
    }));
    const second = fakeDriver(t.cwd, () => undefined);
    expect((await t.run(second.driver)).ok).toBe(true);
    expect(second.sends).toEqual([]);
    expect(t.load().ticketRuns!["02"]).toMatchObject({ status: "done", commit: sha });
    expect(t.progress.some((line) => line.includes(`Ticket 02 was committed (${sha.slice(0, 7)}) before /build stopped`))).toBe(true);
  });

  it("does not count an older commit with the same subject as this attempt's", async () => {
    const t = await buildTask({ tickets: [ticket("01")] });
    const first = fakeDriver(t.cwd, (send) => first.write(`f${send.ticket}.txt`));
    expect((await t.run(first.driver)).ok).toBe(true);
    const head = (await git(t.cwd, "rev-parse", "HEAD")).trim();
    await t.app.store.update(t.taskId, "revised", (state) => ({
      ...state,
      ticketRuns: { ...state.ticketRuns, "01": { ...state.ticketRuns!["01"]!, status: "in-progress", commit: undefined, turns: 1, attemptStart: { at: "2026-01-01T00:00:00.000Z", head } } },
    }));
    const second = fakeDriver(t.cwd, (send) => second.write(`g${send.ticket}.txt`));
    await t.run(second.driver);
    expect(second.sends.map((send) => send.ticket)).toEqual(["01"]);
  });

  it("restores a failed ticket's earlier run when the retry session never opens", async () => {
    const t = await buildTask({ tickets: [ticket("01")] });
    t.passing.ok = false;
    const first = fakeDriver(t.cwd, (send) => first.write(`f${send.ticket}.txt`));
    await t.run(first.driver);
    const failed = t.load().ticketRuns!["01"]!;
    expect(failed.status).toBe("failed");
    const driver: BuildDriver = { async fresh() { return { stopped: "nope" }; }, async finish() {} };
    await t.run(driver);
    // The run is as it was, except that the re-run checks on the tree left their fresh output as the error.
    const { error, ...rest } = t.load().ticketRuns!["01"]!;
    expect(rest).toEqual({ ...failed, error: undefined });
    expect(error).toContain("### unit (exit 1)");
    expect(t.load().build!.currentTicket).toBeUndefined();
  });

  it("keeps a ticket in progress when the driver stops after the first turn was sent", async () => {
    const t = await buildTask({ tickets: [ticket("01")] });
    const driver: BuildDriver = {
      async fresh(_model, run) {
        await run({ send: async () => ({ lastText: "", aborted: true }) });
        return { stopped: "the session closed" };
      },
      async finish() {},
    };
    await t.run(driver);
    expect(t.load().ticketRuns!["01"]).toMatchObject({ status: "in-progress", attempts: 1 });
  });

  it("treats an in-progress attempt with no turn, usage or time as not started, so the next /build routes it fresh", async () => {
    const t = await buildTask({ tickets: [ticket("01", { difficulty: "medium" })] });
    const stuck = { status: "in-progress" as const, tier: "ticketHigh" as const, provider: "openai", model: "", attempts: 1, turns: 0, tokens: 0, costUsd: 0, maxContextTokens: 0, crossedTarget: false };
    await t.app.store.update(t.taskId, "stuck", (task) => ({ ...task, ticketRuns: { "01": stuck } }));
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    expect((await t.run(d.driver)).ok).toBe(true);
    expect(d.sends[0]!.model).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
    expect(t.load().ticketRuns!["01"]).toMatchObject({ status: "done", tier: "ticketMedium", attempts: 1 });
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
    expect(await git(t.cwd, "branch", "--list", "chef/*")).toBe("");
    const build = t.load().build!;
    expect(build.branch).toBe("feature/mine");
    expect(build.base).toBe(await t.app.git.defaultBranch());
    expect(build.baseSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses to resume on a different branch with uncommitted changes, naming the branch", async () => {
    const t = await buildTask();
    t.passing.ok = false;
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    await t.run(d.driver);
    const branch = t.load().build!.branch;
    await git(t.cwd, "switch", "-c", "elsewhere");
    const again = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(again.driver);
    expect(result.code).toBe("DIRTY_TREE");
    expect(result.text).toContain(branch);
    expect(await git(t.cwd, "branch", "--show-current")).toBe("elsewhere");
    expect(again.state.fresh).toBe(0);
  });

  it("switches to the build's branch when the tree is clean, and says so", async () => {
    const t = await buildTask();
    t.passing.ok = false;
    const d = fakeDriver(t.cwd, (send) => d.write(`f${send.ticket}.txt`));
    await t.run(d.driver);
    const branch = t.load().build!.branch;
    await git(t.cwd, "add", "-A");
    await git(t.cwd, "commit", "-q", "-m", "wip");
    await git(t.cwd, "switch", "-c", "elsewhere");
    expect(await git(t.cwd, "branch", "--show-current")).toBe("elsewhere");
    t.passing.ok = true;
    const again = fakeDriver(t.cwd, (send) => again.write(`g${send.ticket}.txt`));
    const result = await t.run(again.driver);
    expect(result.ok, result.text).toBe(true);
    expect(t.progress.some((line) => line.includes(`Switched from elsewhere to ${branch}`))).toBe(true);
    expect(await git(t.cwd, "branch", "--show-current")).toBe(branch);
  });

  it("refuses to start a fresh build on a dirty tree the user will not commit, but not a resumed one", async () => {
    const t = await buildTask({ tickets: [ticket("01")], confirm: async () => false });
    writeFileSync(path.join(t.cwd, "mine.txt"), "wip\n");
    const d = fakeDriver(t.cwd, () => undefined);
    const result = await t.run(d.driver);
    expect(result.code).toBe("DIRTY_TREE");
    expect(result.text).toContain("Commit or stash them first, or answer yes when /build asks");
    expect(d.state.fresh).toBe(0);
    expect(await git(t.cwd, "log", "--format=%s")).toBe("base");
    expect(await git(t.cwd, "branch", "--show-current")).not.toContain("chef/");
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

  it("asks, then commits dirty changes separately on the feature branch before ticket 01", async () => {
    const asked: Array<[string, string]> = [];
    const t = await buildTask({ tickets: [ticket("01")], confirm: async (title, message) => (asked.push([title, message]), true) });
    const base = await git(t.cwd, "branch", "--show-current");
    writeFileSync(path.join(t.cwd, "mine.txt"), "wip\n");
    writeFileSync(path.join(t.cwd, "other.txt"), "wip\n");
    // The workspace dir is not swept into the pre-build commit, even when untracked and not ignored.
    writeFileSync(path.join(t.app.store.root, "stray.json"), "{}\n");
    const d = fakeDriver(t.cwd, () => d.write("f.txt"));
    const result = await t.run(d.driver);
    expect(result.ok, result.text).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]![0]).toBe("Uncommitted changes");
    expect(asked[0]![1]).toContain("mine.txt");
    expect(asked[0]![1]).toContain('Commit them as a separate "Changes before /build" commit');
    const branch = t.load().build!.branch;
    expect(branch).not.toBe(base);
    const subjects = (await git(t.cwd, "log", "--format=%s", branch)).split("\n");
    expect(subjects.slice(1)).toEqual(["Changes before /build", "base"]);
    expect(await git(t.cwd, "log", "--format=%s", base)).toBe("base");
    expect(await git(t.cwd, "show", "--name-only", "--format=", "HEAD~1")).toBe("mine.txt\nother.txt");
    // Ticket 01's commit holds its own file, not the earlier changes.
    expect(await git(t.cwd, "show", "--name-only", "--format=", "HEAD")).not.toMatch(/mine\.txt|other\.txt/);
    expect(await git(t.cwd, "show", "--name-only", "--format=", "HEAD")).toContain("f.txt");
    // Workflow state stays out of ticket commits too.
    expect(await git(t.cwd, "show", "--name-only", "--format=", "HEAD")).not.toContain("stray.json");
    expect(t.progress.some((line) => /^Committed changes before \/build: [0-9a-f]{7}$/.test(line))).toBe(true);
  });

  it("lists at most 8 dirty paths and says how many more", async () => {
    let message = "";
    const t = await buildTask({ tickets: [ticket("01")], confirm: async (_title, text) => ((message = text), false) });
    for (let i = 0; i < 11; i++) writeFileSync(path.join(t.cwd, `d${String(i).padStart(2, "0")}.txt`), "x\n");
    await t.run(fakeDriver(t.cwd, () => undefined).driver);
    expect(message).toContain("d07.txt");
    expect(message).not.toContain("d08.txt");
    expect(message).toContain("and 3 more");
  });

  it("does not ask about changes under the workspace dir only, or on a resumed build", async () => {
    let asked = 0;
    const t = await buildTask({ tickets: [ticket("01")], confirm: async () => (asked++, true) });
    writeFileSync(path.join(t.app.store.root, "stray.json"), "{}\n");
    const d = fakeDriver(t.cwd, () => ({ aborted: true }));
    await t.run(d.driver);
    expect(asked).toBe(0);
    writeFileSync(path.join(t.cwd, "partial.txt"), "x\n");
    await t.run(fakeDriver(t.cwd, () => undefined).driver);
    expect(asked).toBe(0);
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
    await app.plan("Maintain the ingest parser.\n```tasks\n[{\"id\":\"a\",\"summary\":\"x\",\"files\":[\"a.ts\"],\"edits\":[{\"path\":\"a.ts\",\"content\":\"x\\n\"}]}]\n```");
    expect((await app.approveDraft()).ok).toBe(true);
    const d = fakeDriver(cwd, () => undefined);
    const result = await runBuild(() => app, d.driver);
    expect(result.code).toBe("NO_TICKETS");
    expect(result.text).toContain("Re-plan");
  });
});
