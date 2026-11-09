import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { agentCommand } from "../src/agents.js";
import { runBuild, type BuildDriver } from "../src/orchestrator/build.js";
import { ticketHost } from "../src/runner/host.js";
import { AGENT_TICKET_RULE, summaryRule } from "../src/runner/agent-ticket.js";
import { ticketFileName } from "../src/orchestrator/tickets.js";
import { claudeProjectSlug } from "../src/runner/agent-usage.js";
import { tabName } from "../src/runner/tab.js";
import { runTicket } from "../src/runner/ticket.js";
import type { Workflow } from "../src/orchestrator/service.js";
import { fakeHerdrClient, type FakeHerdrClientOptions, type FakeTab } from "./herdr-fake.js";
import { checkRunner, sampleTicket, tieredConfig, ticketWorkflow } from "./helpers.js";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const child = (dir: string, provider: string, model: string) => {
  const sm = SessionManager.create("/work", dir);
  sm.appendMessage({ role: "user", content: "t", timestamp: Date.now() } as never);
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done.\n- [x] retry works" }], api: "x", provider, model, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost }, stopReason: "stop", timestamp: Date.now() } as never);
};
/** The path the prompt asks the agent to write its summary to. */
const summaryFileOf = (prompt: string) => /to (\S+\.summary\.md) \(that file/.exec(prompt)![1]!;
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A /build driver over a real Workflow that runs every ticket through `runTicket` on a fake herdr client. */
async function herdrBuild(options: { models?: string; check?: { ok: boolean }; fake?: FakeHerdrClientOptions; home?: string } = {}) {
  const config = tieredConfig(options.models ? `models:\n${options.models}\n` : "");
  const check = options.check ?? { ok: true };
  const progress: string[] = [];
  const extras = { config, progress: (text: string) => void progress.push(text), runner: checkRunner(async () => (check.ok ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "AssertionError: expected 1" })) };
  const { app, cwd } = await ticketWorkflow([sampleTicket("01", { difficulty: "low" })], extras);
  const fake = fakeHerdrClient({
    onSend: (tab) => {
      writeFileSync(path.join(tab.options.cwd!, "f1.txt"), `x${tab.sends.length}\n`);
      if (tab.sessionDir) {
        const [provider, ...rest] = tab.model.replace(/:.*$/, "").split("/");
        child(tab.sessionDir, provider!, rest.join("/"));
      }
    },
    ...options.fake,
  });
  const driver: BuildDriver = {
    async fresh(model, run, ticketId, limits, attempt) {
      return runTicket(
        { client: fake.client, host: ticketHost(() => app as Workflow), space: "sp1", cwd: app.cwd, ticketId, attempt: attempt ?? 1, model, limits, config: app.config, ticketModePath: "/pi-chef/src/ticket-mode.ts", home: options.home, sleep: async () => undefined },
        run,
      );
    },
  };
  const result = await runBuild(() => app, driver);
  const state = () => app.store.load(app.activeTaskId()!)!;
  return { app, cwd, fake, progress, result, state, check, rerun: () => runBuild(() => app, driver) };
}

describe("a Pi model ticket in a herdr tab", () => {
  it("launches pi with the ticket-mode extension on the routed model, ledgers the child's session, commits, and closes the tab", async () => {
    const { fake, app, state, result, cwd } = await herdrBuild();
    expect(result.ok, result.text).toBe(true);
    const tab = fake.tabs[0]!;
    expect(fake.tabs).toHaveLength(1);
    expect(tab.options.argv.slice(0, 1)).toEqual(["env"]);
    expect(tab.options.argv).toContain("-ne");
    expect(tab.options.argv).toContain("/pi-chef/src/ticket-mode.ts");
    expect(tab.model).toBe("xai/grok-4.7");
    expect(tab.options.cwd).toBe(cwd);
    expect(tab.options.name).toMatch(/^chef-.*-01-1-[a-z0-9]{4}$/);
    expect(tab.options.labels).toMatchObject({ "herdr.space": "sp1", "pi-chef.ticket": "01" });
    expect(tab.killed).toBe(true);
    expect(state().ticketRuns!["01"]).toMatchObject({ status: "done", provider: "xai", model: "grok-4.7" });
    const rows = app.store.readLedger().filter((row) => row.reason.endsWith("ticket 01") && row.model === "grok-4.7");
    expect(rows).toHaveLength(1);
  });

  it("passes the turn limit to the child through the ticket-mode environment", async () => {
    const { fake } = await herdrBuild();
    expect(fake.tabs[0]!.maxTurns).toBe("100");
    expect(fake.tabs[0]!.statusFile).toMatch(/\.status\.json$/);
  });

  it("keeps the session dir and status file in the workspace dir, which commits leave out", async () => {
    const { fake, cwd } = await herdrBuild();
    const tab = fake.tabs[0]!;
    for (const file of [tab.sessionDir, tab.statusFile!]) expect(file.startsWith(path.join(cwd, ".pi-workflows"))).toBe(true);
  });

  it("leaves the tab open when the ticket fails, so the person can read it", async () => {
    const { fake, state, result } = await herdrBuild({ check: { ok: false } });
    expect(result.ok).toBe(false);
    expect(state().ticketRuns!["01"]!.status).toBe("failed");
    // The check retry goes into the same tab; the failed ticket's tab is not killed.
    expect(fake.tabs[0]!.sends).toHaveLength(2);
    expect(fake.tabs[0]!.killed).toBe(false);
  });

  it("names tabs within hc's 32 characters, with a clock suffix so a tab left open never shares a name", () => {
    const at = 1_800_000_000_000;
    const suffix = Math.floor(at / 1000).toString(36).slice(-4);
    expect(tabName("retry-ingest", "01", 1, at)).toBe(`chef-retry-ingest-01-1-${suffix}`);
    const long = tabName("a-very-long-task-name-that-keeps-going", "12", 3, at);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith(`-12-3-${suffix}`)).toBe(true);
    expect(tabName("Odd Name!", "01", 2, at)).toBe(`chef-odd-name--01-2-${suffix}`);
    expect(tabName("retry-ingest", "01", 1, at + 1000)).not.toBe(tabName("retry-ingest", "01", 1, at));
    for (const name of [long, tabName("Odd Name!", "01", 2, at)]) expect(name).toMatch(/^[a-z0-9_-]+$/);
  });

  it("a retry goes into a tab that reads done: the first turn finished while nobody looked", async () => {
    const { fake, result } = await herdrBuild({ check: { ok: false } });
    expect(result.ok).toBe(false);
    const tab = fake.tabs[0]!;
    expect(tab.sends).toHaveLength(2);
    expect(tab.status).toBe("done");
    // ready wait, then for each send: wait for a quiet tab, send --wait; the end of a turn comes from the send's own wait.
    expect(tab.events).toEqual(["wait", "wait", "send", "wait", "send"]);
  });

  it("follows a send that checks in while the tab is still working with hc wait, and sends the retry only after", async () => {
    const t = await herdrBuild({ check: { ok: false }, fake: { turn: (_tab, send) => (send === 1 ? ["working", "done"] : ["done"]) } });
    // The first send checked in while working; hc wait carried it to done before the retry was typed.
    expect(t.fake.tabs[0]!.events).toEqual(["wait", "wait", "send", "wait", "wait", "send"]);
    expect(t.fake.tabs[0]!.sends).toHaveLength(2);
  });
});

describe("an agent ticket in a herdr tab", () => {
  const AGENT = " low: agent:gemini";

  it("runs the agent's argv in the repo, sends the ticket prompt plus the no-commit rule, commits, and closes the tab", async () => {
    const { fake, state, result, app, cwd } = await herdrBuild({ models: AGENT });
    expect(result.ok, result.text).toBe(true);
    const tab = fake.tabs[0]!;
    expect(tab.options.argv).toEqual(agentCommand({ kind: "agent", name: "gemini" }, app.config));
    expect(tab.options.cwd).toBe(cwd);
    expect(tab.options.name).toMatch(/^chef-.*-01-1-[a-z0-9]{4}$/);
    expect(tab.sends).toHaveLength(1);
    expect(tab.sends[0]).toContain("[BUILD CHUNK]");
    expect(tab.sends[0]).toContain("# Ticket 01:");
    expect(tab.sends[0]).toContain(AGENT_TICKET_RULE);
    expect(tab.sends[0]!.endsWith(summaryRule(summaryFileOf(tab.sends[0]!)))).toBe(true);
    expect(tab.killed).toBe(true);
    expect(state().ticketRuns!["01"]).toMatchObject({ status: "done", provider: "agent", model: "gemini", tier: "low", notMetered: true });
  });

  it("ledgers one 'not metered' row for an agent with no reader, which is not an unknown call", async () => {
    const { app, state } = await herdrBuild({ models: AGENT });
    const rows = app.store.readLedger().filter((row) => row.provider === "agent");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "gemini", meter: "not-metered", actualUsd: 0, usageKnown: true });
    expect(rows[0]!.reason).toBe("agent gemini · ticket 01");
    expect(state().ticketRuns!["01"]!.costUsd).toBe(0);
  });

  it("waits on a blocked agent and says once that the ticket is waiting for the person", async () => {
    const { result, progress, fake } = await herdrBuild({ models: AGENT, fake: { turn: () => ["blocked", "blocked", "done"] } });
    expect(result.ok, result.text).toBe(true);
    const tab = fake.tabs[0]!;
    expect(progress.filter((line) => line === `Ticket 01 is waiting for you in tab ${tab.options.name}`)).toHaveLength(1);
    expect(tab.events).toEqual(["wait", "wait", "send", "wait", "wait"]);
  });

  it("a tab that is blocked when the retry is due is waited for, not typed into", async () => {
    // The first turn ends done, then the agent blocks (an approval); the person answers, and only then is the retry sent.
    const { result, fake, progress } = await herdrBuild({ models: AGENT, check: { ok: false }, fake: { turn: (_tab, send) => (send === 1 ? ["done", "blocked", "done"] : ["done"]) } });
    expect(result.ok).toBe(false);
    expect(fake.tabs[0]!.sends).toHaveLength(2);
    expect(fake.tabs[0]!.events).toEqual(["wait", "wait", "send", "wait", "wait", "send"]);
    expect(progress.filter((line) => line.includes("is waiting for you in tab"))).toHaveLength(1);
  });

  it("a send cannot end a turn early on an idle status read just before it started: the turn is the send's own wait", async () => {
    const { result, fake } = await herdrBuild({ models: AGENT, fake: { turn: () => ["working", "working", "done"] } });
    expect(result.ok, result.text).toBe(true);
    const tab = fake.tabs[0]!;
    // The tab read idle at the ready wait and at the wait before the send; neither is read again until the send checked in working.
    expect(tab.events).toEqual(["wait", "wait", "send", "wait", "wait"]);
    expect(tab.sends).toHaveLength(1);
  });

  it("undoes a commit the agent made anyway with git reset --soft, then commits itself", async () => {
    let base = "";
    const { result, progress, cwd, app } = await herdrBuild({
      models: AGENT,
      fake: {
        onRun: (tab) => void (base = gitIn(tab.options.cwd!, "rev-parse", "HEAD")),
        onSend: (tab) => {
          writeFileSync(path.join(tab.options.cwd!, "f1.txt"), "x\n");
          gitIn(tab.options.cwd!, "add", "-A");
          gitIn(tab.options.cwd!, "-c", "core.hooksPath=/dev/null", "commit", "-m", "agent commit");
        },
      },
    });
    expect(result.ok, result.text).toBe(true);
    expect(progress.some((line) => line.includes("the agent committed anyway") && line.includes("git reset --soft"))).toBe(true);
    // The agent's commit is gone; the branch has pi-chef's own commit for the ticket on top of the base.
    expect(gitIn(cwd, "log", "--format=%s", `${base}..HEAD`)).toBe("01: Ticket 01");
    expect(app.store.load(app.activeTaskId()!)!.ticketRuns!["01"]!.status).toBe("done");
  });

  it("sends a failed check back into the same tab, and leaves the tab open when the ticket still fails", async () => {
    const { fake, result, state } = await herdrBuild({ models: AGENT, check: { ok: false } });
    expect(result.ok).toBe(false);
    const tab = fake.tabs[0]!;
    expect(fake.tabs).toHaveLength(1);
    expect(tab.sends).toHaveLength(2);
    expect(tab.sends[1]).toContain("The checks failed");
    expect(tab.sends[1]).not.toContain(AGENT_TICKET_RULE);
    expect(tab.killed).toBe(false);
    expect(state().ticketRuns!["01"]!.status).toBe("failed");
  });

  it("uses the agent's summary file, not its screen (which echoes the prompt's unticked criteria), as the ticket summary", async () => {
    const t = await herdrBuild({
      models: AGENT,
      fake: {
        onSend: (tab, text) => {
          writeFileSync(path.join(tab.options.cwd!, "f1.txt"), "x\n");
          writeFileSync(summaryFileOf(text), "Retried ingests.\n- [x] retry works\nFiles changed: f1.txt\n");
        },
        read: () => "# Ticket 01\n## Acceptance criteria\n- [ ] retry works\n(the agent is working)",
      },
    });
    expect(t.result.ok, t.result.text).toBe(true);
    const run = t.state().ticketRuns!["01"]!;
    expect(run.summary).toBe("Retried ingests.\n- [x] retry works\nFiles changed: f1.txt");
    const ticket = t.state().plan!.tickets![0]!;
    expect(t.app.store.readText(t.app.activeTaskId()!, `tickets/${ticketFileName(ticket)}`)).toContain("- [x] retry works");
  });

  it("asks for the summary file under the task's sessions dir, and a file left by an earlier turn does not count for the retry", async () => {
    let writes = 0;
    const t = await herdrBuild({
      models: AGENT,
      check: { ok: false },
      fake: {
        onSend: (tab, text) => {
          writeFileSync(path.join(tab.options.cwd!, "f1.txt"), `x${tab.sends.length}\n`);
          // Only the first turn writes the file; the retry turn does not.
          if (writes++ === 0) writeFileSync(summaryFileOf(text), "first turn summary");
        },
        read: () => "screen tail of the retry",
      },
    });
    const [first, retry] = t.fake.tabs[0]!.sends;
    const file = summaryFileOf(first!);
    expect(path.isAbsolute(file)).toBe(true);
    expect(file.startsWith(path.join(t.cwd, ".pi-workflows"))).toBe(true);
    expect(retry).toContain(summaryRule(file));
    expect(retry).not.toContain(AGENT_TICKET_RULE);
    expect(t.state().ticketRuns!["01"]!.summary).toBe("screen tail of the retry");
  });

  it("falls back to the redacted tail of the screen when the agent wrote no summary file", async () => {
    const { state } = await herdrBuild({ models: AGENT, fake: { read: () => `${"noise\n".repeat(1000)}token=sk-abcdefgh12345678\nDone.\n- [x] retry works` } });
    const summary = state().ticketRuns!["01"]!.summary!;
    expect(summary).toContain("- [x] retry works");
    expect(summary).not.toContain("sk-abcdefgh12345678");
    expect(summary.length).toBeLessThanOrEqual(2000);
  });

  it("stops the ticket, leaving HEAD alone, when the agent switched the checkout to another branch", async () => {
    let base = "";
    const t = await herdrBuild({
      models: AGENT,
      fake: {
        onRun: (tab) => void (base = gitIn(tab.options.cwd!, "rev-parse", "HEAD")),
        onSend: (tab) => {
          writeFileSync(path.join(tab.options.cwd!, "f1.txt"), "x\n");
          gitIn(tab.options.cwd!, "switch", "-c", "elsewhere");
          gitIn(tab.options.cwd!, "add", "-A");
          gitIn(tab.options.cwd!, "-c", "core.hooksPath=/dev/null", "commit", "-m", "agent commit");
        },
      },
    });
    expect(t.result.ok).toBe(false);
    expect(t.result.text).toContain("left the build branch");
    expect(t.result.text).toContain("elsewhere");
    expect(t.result.text).toContain("git switch");
    // Nothing was reset onto the wrong branch: the agent's commit is still there, and the ticket stays in progress.
    expect(gitIn(t.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("elsewhere");
    expect(gitIn(t.cwd, "log", "--format=%s", `${base}..HEAD`)).toBe("agent commit");
    expect(t.state().ticketRuns!["01"]!.status).toBe("in-progress");
    expect(t.fake.tabs[0]!.killed).toBe(false);
  });

  it("stops the ticket when the tab ends during the turn, and keeps it in progress", async () => {
    const { result, state } = await herdrBuild({ models: AGENT, fake: { turn: () => [{ status: "ended", exitCode: 1 }] } });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("ended (exit 1)");
    expect(state().ticketRuns!["01"]!.status).toBe("in-progress");
  });

  it("meters Claude Code from its own log under the ticket, priced from the pricing rows", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    const { app, state, cwd } = await herdrBuild({
      models: AGENT.replace("gemini", "claude/claude-sonnet-5-5"),
      home,
      fake: {
        onSend: (tab) => {
          writeFileSync(path.join(tab.options.cwd!, "f1.txt"), "x\n");
          const dir = path.join(home, ".claude", "projects", claudeProjectSlug(tab.options.cwd!));
          mkdirSync(dir, { recursive: true });
          const line = (id: string) => JSON.stringify({ type: "assistant", message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 } } });
          writeFileSync(path.join(dir, "s.jsonl"), `${line("m1")}\n${line("m1")}\n${line("m2")}\n`);
        },
      },
    });
    expect(cwd).toBeTruthy();
    const rows = app.store.readLedger().filter((row) => row.meter);
    expect(rows).toHaveLength(1);
    // Two messages (m1 counted once): 2000 input and 1000 output at $3 / $15 per million.
    expect(rows[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", meter: "agent-log", inputTokens: 2000, outputTokens: 1000, reason: "agent claude · ticket 01" });
    expect(rows[0]!.actualUsd).toBeCloseTo(0.021, 6);
    expect(state().ticketRuns!["01"]).toMatchObject({ status: "done", model: "claude/claude-sonnet-5-5" });
    expect(state().ticketRuns!["01"]!.notMetered).toBeUndefined();
  });
});

describe("a ticket that crosses runners", () => {
  it("opens the Pi attempt's tab under a new name, since the failed agent attempt's tab is still open", async () => {
    const names = new Set<string>();
    const t = await herdrBuild({
      // The ticket starts on the agent rung (low) and climbs to a Pi model (medium); the checks fail throughout.
      models: " low: agent:gemini\n medium: anthropic/claude-sonnet-5-5",
      check: { ok: false },
      // hc refuses a name that a live tab already has.
      fake: { failRun: (run) => (names.has(run.name!) ? "duplicate terminal name" : void names.add(run.name!)) },
    });
    expect(t.fake.tabs.map((tab) => tab.options.name!.replace(/-[a-z0-9]{4}$/, "").slice(-5))).toEqual(["-01-1"]);
    expect(t.state().ticketRuns!["01"]).toMatchObject({ status: "failed", provider: "agent", attempts: 1 });
    await t.rerun();
    expect(t.state().ticketRuns!["01"]).toMatchObject({ provider: "anthropic", tier: "medium", attempts: 2 });
    expect(t.fake.tabs.map((tab) => tab.options.name!.replace(/-[a-z0-9]{4}$/, "").slice(-5))).toEqual(["-01-1", "-01-2"]);
    expect(t.fake.tabs[0]!.killed).toBe(false);
  });

  it("opens a new tab under a free name when an unstarted attempt's tab is still open and the same attempt is made again", async () => {
    const names = new Set<string>();
    const clock = 1_800_000_000_000;
    const { runTicket } = await import("../src/runner/ticket.js");
    const { app } = await ticketWorkflow([sampleTicket("01", { difficulty: "low" })], { config: tieredConfig() });
    const fake = fakeHerdrClient({ failRun: (run) => (names.has(run.name!) ? "duplicate terminal name" : void names.add(run.name!)) });
    const base = { client: fake.client, host: ticketHost(() => app as Workflow), space: "sp1", cwd: app.cwd, ticketId: "01", attempt: 1, model: { provider: "xai", id: "grok-4.7" }, config: app.config, ticketModePath: "/pi-chef/src/ticket-mode.ts", sleep: async () => undefined };
    // Attempt 1 never sent a turn (it was rolled back), but its tab is still open; the same attempt number runs again a minute later.
    for (const at of [clock, clock + 60_000]) {
      const out = await runTicket({ ...base, now: () => at }, async () => undefined);
      expect(out).toBeUndefined();
    }
    expect(fake.tabs).toHaveLength(2);
    expect(new Set(fake.tabs.map((tab) => tab.options.name)).size).toBe(2);
  });
});

describe("outside herdr", () => {
  it("runTicket's host check reports why: no tab is opened", async () => {
    const fake = fakeHerdrClient({ self: { problem: "HC_TERMINAL_ID is not set; pi-chef is not running inside a herdr terminal" } });
    const { herdrSpace } = await import("../src/runner/ticket.js");
    expect(await herdrSpace(fake.client)).toEqual({ problem: expect.stringContaining("HC_TERMINAL_ID") });
    expect(await herdrSpace(undefined)).toEqual({ problem: "no herdr client" });
    expect(fake.tabs).toEqual([]);
  });
});
