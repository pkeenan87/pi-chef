import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { abortAllChildren, CHILD_ENV, CHILD_ROOT_ENV, CHILD_TASK_ENV, liveChildCount, runTicketInChild, TICKET_TOOLS, type ChildLike, type SpawnFn, type TicketRunInput } from "../src/agents/pi-runner.js";
import { childBashBlock, registerChildMode } from "../src/child-mode.js";
import { configPaths } from "../src/config.js";
import type { Ticket } from "../src/domain.js";
import extension from "../src/extension.js";
import { parseCriteriaMet, setTicketStatus, tickCriteria } from "../src/orchestrator/tickets.js";
import type { Workflow } from "../src/orchestrator/service.js";
import { checkRunner, tempRepo, tieredConfig, tieredYaml, workflow } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---- fake child process -----------------------------------------------------------------------------------------

interface Script {
  /** Chunks written to stdout, in order (they may split a JSON line). */
  stdout?: string[];
  stderr?: string;
  code?: number;
  /** Runs when the process "starts", with its cwd (a fake child may edit the worktree). */
  start?: () => void;
  /** Never exits on its own; ignores SIGTERM when `stubborn`. */
  hang?: boolean;
  stubborn?: boolean;
  /** Milliseconds before a non-hanging process exits (so concurrent fakes overlap even though the runner awaits git first). */
  delayMs?: number;
  /** Writes each stdout chunk this many ms after the previous one, like a live model, and stops writing once the process is closed. */
  gapMs?: number;
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signals: string[];
  /** The ticket prompt file's text, read while the process "ran". */
  prompt: string;
  system: string;
}

function fakeSpawn(script: (call: SpawnCall, index: number) => Script, log: SpawnCall[] = [], events: string[] = []): SpawnFn {
  return (command, args, options) => {
    const emitter = new EventEmitter() as EventEmitter & ChildLike;
    const out = new PassThrough();
    const err = new PassThrough();
    Object.assign(emitter, { stdout: out });
    Object.assign(emitter, { stderr: err });
    const at = args.indexOf("--append-system-prompt");
    const promptArg = args.find((item) => item.startsWith("@"));
    const call: SpawnCall = {
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      signals: [],
      prompt: promptArg && existsSync(promptArg.slice(1)) ? readFileSync(promptArg.slice(1), "utf8") : "",
      system: at >= 0 && existsSync(args[at + 1]!) ? readFileSync(args[at + 1]!, "utf8") : "",
    };
    const index = log.push(call) - 1;
    const plan = script(call, index);
    const tag = path.basename(options.cwd);
    events.push(`start:${tag}`);
    let closed = false;
    const close = (code: number) => {
      if (closed) return;
      closed = true;
      events.push(`close:${tag}`);
      out.end();
      err.end();
      emitter.emit("close", code, null);
    };
    (emitter as { kill: ChildLike["kill"] }).kill = (signal) => {
      call.signals.push(String(signal));
      if (plan.hang && (!plan.stubborn || signal === "SIGKILL")) setImmediate(() => close(143));
      return true;
    };
    setImmediate(() => {
      plan.start?.();
      if (plan.gapMs !== undefined) {
        const chunks = [...(plan.stdout ?? [])];
        const pump = () => {
          if (closed) return;
          const next = chunks.shift();
          if (next !== undefined) {
            out.write(next);
            setTimeout(pump, plan.gapMs);
          } else if (!plan.hang) close(plan.code ?? 0);
        };
        pump();
        return;
      }
      for (const chunk of plan.stdout ?? []) out.write(chunk);
      if (plan.stderr) err.write(plan.stderr);
      if (!plan.hang) setTimeout(() => close(plan.code ?? 0), plan.delayMs ?? 0);
    });
    return emitter;
  };
}

const assistant = (text: string, total: number, extra: Record<string, unknown> = {}, cost = 0.01) =>
  `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: total - 50, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { total: cost } }, stopReason: "stop", ...extra } })}\n`;

const ticketRef = { id: "01", slug: "retry", title: "Retry" };
const invocation = { command: "pi", args: [] as string[] };

function runInput(over: Partial<TicketRunInput> & { spawn: SpawnFn }): TicketRunInput {
  return {
    ticket: ticketRef,
    prompt: "# Ticket 01\nDo the thing.",
    worktreePath: "/work/tree-01",
    model: { provider: "anthropic", id: "claude-sonnet-5-5" },
    tools: TICKET_TOOLS,
    systemPromptAppend: "SYSTEM RULES",
    env: { [CHILD_TASK_ENV]: "task-1" },
    invocation,
    extensionPath: "/pkg/src/extension.ts",
    baseEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-api03-secretsecret", OPENAI_API_KEY: "sk-secretsecretsecret", HOME: "/home/u" },
    ...over,
  };
}

// ---- the runner -------------------------------------------------------------------------------------------------

describe("runTicketInChild", () => {
  it("spawns pi with the canonical argv, a restricted extension, and no API keys", async () => {
    const calls: SpawnCall[] = [];
    const result = await runTicketInChild(runInput({ spawn: fakeSpawn(() => ({ stdout: [assistant("done", 1000)] }), calls), thinking: "medium" }));
    expect(result.ok).toBe(true);
    const call = calls[0]!;
    expect(call.command).toBe("pi");
    expect(call.cwd).toBe("/work/tree-01");
    const { args } = call;
    expect(args.slice(0, 7)).toEqual(["--mode", "json", "-p", "--no-session", "--no-approve", "--model", "anthropic/claude-sonnet-5-5"]);
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls,web_search,web_fetch");
    expect(args.indexOf("--no-extensions")).toBeGreaterThan(-1);
    expect(args[args.indexOf("-e") + 1]).toBe("/pkg/src/extension.ts");
    expect(args.indexOf("--no-extensions")).toBeLessThan(args.indexOf("-e"));
    expect(args.at(-1)).toMatch(/^Task: /);
    expect(args.some((item) => item.startsWith("@") && item.endsWith("ticket-01.md"))).toBe(true);
    expect(call.system).toBe("SYSTEM RULES");
    expect(call.prompt).toContain("Do the thing.");
    expect(call.env[CHILD_ENV]).toBe("1");
    expect(call.env[CHILD_TASK_ENV]).toBe("task-1");
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.OPENAI_API_KEY).toBeUndefined();
    expect(call.env.PATH).toBe("/bin");
    expect(args.join(" ")).not.toContain("secret");
  });

  it("gives the child an empty stdin, so `pi -p` (which reads piped stdin to the end) does not wait forever", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "pi-cost-stdin-"));
    const script = path.join(dir, "fake-pi.mjs");
    // Mirrors pi's readPipedStdin: when stdin is not a TTY it reads until "end" before doing anything else.
    writeFileSync(
      script,
      [
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', () => {});",
        "process.stdin.on('end', () => {",
        `  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }));`,
        "  process.exit(0);",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    const result = await runTicketInChild({
      ...runInput({ spawn: undefined as never }),
      spawn: undefined,
      worktreePath: dir,
      invocation: { command: process.execPath, args: [script] },
      baseEnv: { PATH: process.env.PATH ?? "" },
      deadlineMs: 10_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe("done");
  });

  it("spawns with stdin ignored and stdout/stderr piped", async () => {
    let stdio: unknown;
    const inner = fakeSpawn(() => ({ stdout: [assistant("done", 1000)] }));
    await runTicketInChild(runInput({ spawn: (command, args, options) => ((stdio = options.stdio), inner(command, args, options)) }));
    expect(stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("deletes its scratch files after the run", async () => {
    const calls: SpawnCall[] = [];
    await runTicketInChild(runInput({ spawn: fakeSpawn(() => ({}), calls) }));
    const files = calls[0]!.args.filter((item, i) => item.startsWith("@") || calls[0]!.args[i - 1] === "--append-system-prompt");
    expect(files).toHaveLength(2);
    for (const file of files) expect(existsSync(file.replace(/^@/, ""))).toBe(false);
  });

  it("parses JSON lines split across chunks, skips noise, sums usage, and counts compactions", async () => {
    const turn1 = assistant("working", 60_000, {}, 0.02);
    const turn2 = assistant("- [x] retry works\nFiles changed: a.ts", 90_000, {}, 0.03);
    const compaction = `${JSON.stringify({ type: "compaction_end", reason: "threshold", result: { summary: "s", tokensBefore: 90000 } })}\n`;
    const aborted = `${JSON.stringify({ type: "compaction_end", reason: "threshold", aborted: true })}\n`;
    const half = Math.floor(turn1.length / 2);
    const events: string[] = [];
    const result = await runTicketInChild(
      runInput({
        contextTarget: 80_000,
        onEvent: (event) => void events.push(event.kind),
        spawn: fakeSpawn(() => ({
          stdout: ["Pi banner, not json\n", turn1.slice(0, half), turn1.slice(half), "\r\n{not json}\n", "[1,2]\n", compaction, aborted, turn2.replace(/\n$/, "\r\n"), '{"type":"message_end"'],
        })),
      }),
    );
    expect(result.usage).toEqual({ input: 150_000 - 100, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 0.05, turns: 2 });
    expect(result.maxContextTokens).toBe(90_000);
    expect(result.crossedTarget).toBe(true);
    expect(result.compactions).toBe(1);
    expect(result.finalText).toContain("- [x] retry works");
    expect(result.ok).toBe(true);
    expect(events.filter((kind) => kind === "crossed-target")).toHaveLength(1);
    expect(events).toContain("compaction");
  });

  it("reports unknown cost as null and does not cross a target it stays under", async () => {
    const noCost = `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "hi", usage: { input: 10, output: 5, totalTokens: 15 }, stopReason: "stop" } })}\n`;
    const result = await runTicketInChild(runInput({ contextTarget: 150_000, spawn: fakeSpawn(() => ({ stdout: [noCost] })) }));
    expect(result.usage.costUsd).toBeNull();
    expect(result.crossedTarget).toBe(false);
    expect(result.finalText).toBe("hi");
  });

  it("fails on a non-zero exit and redacts the stderr tail", async () => {
    const result = await runTicketInChild(runInput({ spawn: fakeSpawn(() => ({ code: 2, stderr: "boom with sk-ant-api03-abcdefghijklmnop leaked" })) }));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderrTail).toContain("boom");
    expect(result.stderrTail).not.toContain("abcdefghijklmnop");
  });

  it("fails when the model run ended in error even with exit code 0", async () => {
    const result = await runTicketInChild(runInput({ spawn: fakeSpawn(() => ({ stdout: [assistant("", 100, { stopReason: "error", errorMessage: "rate limited" })] })) }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rate limited");
  });

  it("kills the child with SIGTERM then SIGKILL when aborted", async () => {
    const calls: SpawnCall[] = [];
    const controller = new AbortController();
    const running = runTicketInChild(runInput({ signal: controller.signal, killGraceMs: 10, spawn: fakeSpawn(() => ({ hang: true, stubborn: true }), calls) }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await running;
    expect(calls[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toMatchObject({ ok: false, aborted: true });
  });

  it("kills the child at the deadline", async () => {
    const calls: SpawnCall[] = [];
    const result = await runTicketInChild(runInput({ deadlineMs: 20, killGraceMs: 10, spawn: fakeSpawn(() => ({ hang: true }), calls) }));
    expect(calls[0]!.signals[0]).toBe("SIGTERM");
    expect(result).toMatchObject({ ok: false, timedOut: true });
  });

  it("does not start when already aborted, and reports a spawn error without throwing", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: SpawnCall[] = [];
    const early = await runTicketInChild(runInput({ signal: controller.signal, spawn: fakeSpawn(() => ({ hang: true }), calls) }));
    expect(early.aborted).toBe(true);
    const broken = await runTicketInChild(runInput({ spawn: () => { throw new Error("ENOENT pi"); } }));
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain("ENOENT");
  });
});

describe("ticket markdown helpers", () => {
  const md = "# 01: T\n\n## Acceptance criteria\n\n- [ ] retry works\n- [ ] logs a warning\n\n## Status: ready-for-agent\n";
  it("reads criteria from a closing summary", () => {
    const text = "Summary\n- [x] retry works\n- [ ] logs a warning (not met)\nFiles changed: a.ts";
    expect(parseCriteriaMet(text, ["retry works", "logs a warning", "absent one"])).toEqual([true, false, false]);
    expect(parseCriteriaMet("retry works: met\nlogs a warning: not met", ["retry works", "logs a warning"])).toEqual([true, false]);
  });
  it("sets status and ticks only met criteria", () => {
    expect(setTicketStatus(tickCriteria(md, [true, false]), "done")).toContain("- [x] retry works\n- [ ] logs a warning");
    expect(setTicketStatus(md, "in-progress")).toContain("## Status: in-progress");
  });
});

// ---- the ticket pipeline through /implement ---------------------------------------------------------------------

function ticket(id: string, extra: Partial<Ticket> = {}): Ticket {
  return { id, slug: `t${id}`, title: `Ticket ${id}`, whatToBuild: `Build part ${id}.`, acceptanceCriteria: ["retry works"], blockedBy: [], estimatedContextTokens: 40_000, ...extra };
}

const specParams = { summary: "Retry failed ingests.", context: "src/ingest.ts parses and drops failures.", approach: "Wrap parse() in retryParse() with a fixed backoff.", changes: [{ path: "src/ingest.ts", change: "add retryParse(input, attempts)" }], reuse: ["sleep() in src/util.ts"], verification: ["npm test"], decisions: [{ question: "Backoff?", answer: "Fixed", rationale: "simple" }], assumptions: [], outOfScope: [], risks: [] };

/** A file the fake child writes into its worktree, named after the worktree directory. */
const marker = (cwd: string) => `feature-${path.basename(cwd).slice(0, 2)}.txt`;

async function ticketTask(options: { tickets: Ticket[]; script?: (call: SpawnCall, index: number) => Script; runner?: ReturnType<typeof checkRunner>; mutate?: (config: ReturnType<typeof tieredConfig>) => void; auth?: Parameters<typeof workflow>[1] extends infer E ? (E extends { auth?: infer A } ? A : never) : never }) {
  const cwd = await tempRepo();
  const calls: SpawnCall[] = [];
  const events: string[] = [];
  const statuses: string[] = [];
  const notices: string[] = [];
  const progress: string[] = [];
  const reports: string[] = [];
  const config = tieredConfig();
  options.mutate?.(config);
  const script =
    options.script ??
    ((call): Script => ({
      start: () => writeFileSync(path.join(call.cwd, marker(call.cwd)), "x\n"),
      stdout: [assistant("working", 40_000), assistant(`Summary for ${path.basename(call.cwd)}\n- [x] retry works\nFiles changed: ${marker(call.cwd)}`, 41_000)],
    }));
  const spawn = fakeSpawn(script, calls, events);
  const app = workflow(cwd, {
    config,
    startTurn: () => undefined,
    rng: () => 0.5,
    ...(options.auth ? { auth: options.auth } : {}),
    status: (text) => void (text && statuses.push(text)),
    notify: (message) => void notices.push(message),
    progress: (message) => void progress.push(message),
    report: (markdown) => void reports.push(markdown),
    ...(options.runner ? { runner: options.runner } : {}),
    ticketRunner: (input) => runTicketInChild({ ...input, spawn, invocation, extensionPath: "/pkg/src/extension.ts", baseEnv: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: "sk-ant-api03-secretsecret", OPENAI_API_KEY: "sk-secretsecretsecret" } }),
  });
  expect((await app.startPlan("Add retry to the Neo ingest parser")).ok).toBe(true);
  await app.savePlanSpec(specParams);
  await app.commitTickets(options.tickets);
  expect((await app.approveDraft()).ok).toBe(true);
  const taskId = app.activeTaskId()!;
  const ticketFile = (item: Ticket) => readFileSync(path.join(app.store.taskDir(taskId), "tickets", `${item.id}-${item.slug}.md`), "utf8");
  return { cwd, app, calls, events, statuses, notices, progress, reports, taskId, ticketFile, peak: () => {
      let running = 0;
      let high = 0;
      for (const item of events) {
        running += item.startsWith("start:") ? 1 : -1;
        high = Math.max(high, running);
      }
      return high;
    }, config };
}

const ticketLedger = (app: Workflow) => app.store.readLedger().filter((entry) => entry.reason.startsWith("ticket "));

describe("/implement with tickets", () => {
  it("runs tickets in child pi processes in dependency order, ledgering each ticket once", async () => {
    const one = ticket("01", { suggestedTier: "cheap" });
    const two = ticket("02", { blockedBy: ["01"], acceptanceCriteria: ["retry works"] });
    const t = await ticketTask({ tickets: [one, two] });
    writeFileSync(path.join(t.cwd, "AGENTS.md"), "Rule: tests live in tests/.\n");
    const result = await t.app.implement();
    expect(result.ok, result.text).toBe(true);
    expect(t.calls).toHaveLength(2);
    // 02 only starts after 01 exited, and sees 01's committed work and summary.
    expect(t.events.map((item) => item.split(":")[0])).toEqual(["start", "close", "start", "close"]);
    expect(path.basename(t.calls[0]!.cwd)).toBe("01-t01");
    expect(path.basename(t.calls[1]!.cwd)).toBe("02-t02");
    expect(t.calls[1]!.prompt).toContain("Completed blocking tickets");
    expect(t.calls[1]!.prompt).toContain("Summary for 01-t01");
    expect(t.calls[0]!.prompt).toContain("## Acceptance criteria");
    expect(t.calls[0]!.prompt).toContain("Retry failed ingests.");
    expect(t.calls[0]!.prompt).toContain("Rule: tests live in tests/.");
    // argv, env, and the model map to a configured candidate.
    for (const call of t.calls) {
      expect(call.args.slice(0, 6)).toEqual(["--mode", "json", "-p", "--no-session", "--no-approve", "--model"]);
      expect(call.args[6]).toMatch(/^(openai\/gpt-6-luna|anthropic\/claude-haiku-5-5)$/);
      expect(call.env[CHILD_ENV]).toBe("1");
      expect(call.env[CHILD_TASK_ENV]).toBe(t.taskId);
      expect(call.env[CHILD_ROOT_ENV]).toBe(t.cwd);
      expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.env.OPENAI_API_KEY).toBeUndefined();
    }
    // Branched from the blocker: 02's worktree contains 01's file.
    expect(existsSync(path.join(t.calls[1]!.cwd, "feature-01.txt"))).toBe(true);
    // One ledger record per ticket, priced from config (a $0 subscription model, as the router ranked it); the child's own
    // list price (two turns at $0.01) is kept for information only.
    const records = ticketLedger(t.app);
    expect(records).toHaveLength(2);
    expect(records.map((item) => item.reason)).toEqual(["ticket 01", "ticket 02"]);
    expect(records[0]).toMatchObject({ inputTokens: 81_000 - 100, outputTokens: 100, actualUsd: 0, listPriceUsd: 0.02, usageKnown: true, outcome: "success", requests: 2 });
    // The pipeline adds no second record for the same model usage.
    expect(t.app.store.readLedger().filter((item) => item.phase === "IMPLEMENTING" && item.tier !== "classifier").every((item) => item.reason.startsWith("ticket ") || item.reason.startsWith("web_search"))).toBe(true);
    // Status line, route events, ticket files, per-ticket state, /status.
    expect(t.statuses.some((text) => /^ticket 01 → (openai\/gpt-6-luna|anthropic\/claude-haiku-5-5)$/.test(text))).toBe(true);
    expect(t.statuses).toContain("ticket 01 · turn 1 · ~40k ctx · 0.0s");
    expect(readFileSync(path.join(t.app.store.taskDir(t.taskId), "events.jsonl"), "utf8")).toContain('"purpose":"implement"');
    expect(t.ticketFile(one)).toContain("## Status: done");
    expect(t.ticketFile(one)).toContain("- [x] retry works");
    const state = t.app.store.load(t.taskId)!;
    expect(state.ticketRuns!["01"]).toMatchObject({ status: "done", turns: 2, tokens: 81_000, costUsd: 0, attempts: 1, crossedTarget: false });
    expect(state.integration?.sha).toBeTruthy();
    const status = await t.app.status();
    expect(status.text).toMatch(/Ticket 01: done · \S+\/\S+ · 81000 tokens over 2 turn\(s\) · \$0\.0000/);
    expect(status.text).toContain("Ticket 02: done");
    const metrics = JSON.stringify(t.app.store.readMetrics());
    expect(metrics).toContain('"success"');
  });

  it("runs independent tickets together up to workers.concurrency and later waves after them", async () => {
    const tickets = [ticket("01"), ticket("02"), ticket("03", { blockedBy: ["01", "02"] })];
    const t = await ticketTask({
      tickets,
      script: (call) => ({ delayMs: 150, start: () => writeFileSync(path.join(call.cwd, marker(call.cwd)), "x\n"), stdout: [assistant("- [x] retry works", 5000)] }),
    });
    const result = await t.app.implement();
    expect(result.ok, result.text).toBe(true);
    expect(t.peak()).toBe(2);
    const third = t.events.indexOf("start:03-t03");
    expect(t.events.indexOf("close:01-t01")).toBeLessThan(third);
    expect(t.events.indexOf("close:02-t02")).toBeLessThan(third);
    expect(existsSync(path.join(t.calls.find((call) => call.cwd.endsWith("03-t03"))!.cwd, "feature-02.txt"))).toBe(true);
  });

  it("does not gate a ticket plan on the task-level tier's sign-in: each ticket routes itself", async () => {
    // Only OpenAI is signed in, so the task-level (standard) choice has no ready provider, but a cheap ticket does.
    const auth = { async inspect(provider: string) { const ready = provider === "openai" || provider === "local"; return { provider, status: ready ? "ready" : "missing", method: "oauth", detail: ready ? "ready" : "not signed in" } as never; } };
    const t = await ticketTask({ tickets: [ticket("01", { suggestedTier: "cheap" })], auth });
    const result = await t.app.implement();
    expect(result.ok, result.text).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.args.join(" ")).toContain("openai/gpt-6-luna");
  });

  it("warns, and records it in the ticket file, when a child crosses the soft context target", async () => {
    const t = await ticketTask({
      tickets: [ticket("01")],
      mutate: (config) => void (config.workers.ticketContextTokens = 20_000),
      script: () => ({ stdout: [assistant("big", 30_000), assistant("- [x] retry works", 31_000)] }),
    });
    const result = await t.app.implement();
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("Warnings:");
    expect(result.text).toMatch(/Ticket 01 .*soft 20000-token/);
    expect(t.notices.some((item) => /passed the soft 20000-token context target/.test(item))).toBe(true);
    expect(t.ticketFile(ticket("01"))).toContain("> Warning: exceeded the soft 20000-token context target");
    expect(t.app.store.load(t.taskId)!.ticketRuns!["01"]!.crossedTarget).toBe(true);
  });

  it("fails a ticket whose checks fail and re-runs it in a fresh child at the next tier on the same worktree", async () => {
    let checks = 0;
    const t = await ticketTask({
      tickets: [ticket("01", { suggestedTier: "cheap", checks: ["npm run typecheck"] })],
      runner: checkRunner(async () => (++checks === 1 ? { code: 1, stdout: "", stderr: "1 failing" } : { code: 0, stdout: "ok", stderr: "" })),
    });
    const result = await t.app.implement();
    expect(result.ok, result.text).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.cwd).toBe(t.calls[0]!.cwd);
    expect(t.calls[0]!.args[6]).toMatch(/gpt-6-luna|claude-haiku-5-5/);
    expect(t.calls[1]!.args[6]).toMatch(/claude-sonnet-5-5|grok-4-7/);
    expect(t.calls[1]!.prompt).toContain("Previous attempt failed");
    expect(t.calls[1]!.prompt).toContain("Checks failed");
    const records = ticketLedger(t.app);
    expect(records.map((item) => item.outcome)).toEqual(["failure", "success"]);
    expect(records.map((item) => item.retries)).toEqual([0, 1]);
    expect(t.app.store.load(t.taskId)!.ticketRuns!["01"]).toMatchObject({ status: "done", attempts: 2 });
    expect(t.ticketFile(ticket("01"))).toContain("## Status: done");
  });

  it("marks a ticket failed when the child exits non-zero, and parks the task BLOCKED with an advisor hint once escalation runs out", async () => {
    const t = await ticketTask({ tickets: [ticket("01")], script: () => ({ code: 1, stderr: "crash", stdout: [assistant("oops", 1000)] }) });
    const result = await t.app.implement();
    expect(result).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(t.calls.length).toBe(3); // initial attempt plus maxEscalations (2)
    expect(t.app.store.load(t.taskId)!.phase).toBe("BLOCKED");
    expect(t.app.store.load(t.taskId)!.ticketRuns!["01"]).toMatchObject({ status: "failed", attempts: 3 });
    expect(t.ticketFile(ticket("01"))).toContain("## Status: failed");
    expect(t.notices.some((item) => item.includes("/advisor"))).toBe(true);
    expect(ticketLedger(t.app).every((item) => item.outcome === "failure")).toBe(true);
  });

  it("reports a child that died while Pi was loading by its error line, with no charge and no strike against the model", async () => {
    const stderr = [
      "Cloning into '/w/.pi/git/origin.example.com/pkg'...",
      "fatal: could not read Username for 'https://origin.example.com': terminal prompts disabled",
      "Error: git clone https://origin.example.com/pkg /w/.pi/git/origin.example.com/pkg failed with code 128",
      "    at ChildProcess.<anonymous> (file:///pi/chunk.js:497:12870)",
      "    at ChildProcess._handle.onexit (node:internal/child_process:294:12)",
      "",
      "Node.js v24.14.0",
    ].join("\n");
    const t = await ticketTask({ tickets: [ticket("01")], script: () => ({ code: 1, stderr, stdout: [] }) });
    const result = await t.app.implement();
    expect(result.ok).toBe(false);
    const run = t.app.store.load(t.taskId)!.ticketRuns!["01"]!;
    expect(run.error).toContain("before calling the model");
    expect(run.error).toContain("fatal: could not read Username");
    expect(run.error).toContain("git clone");
    expect(run.error).not.toContain("onexit");
    const ledger = ticketLedger(t.app);
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((item) => item.actualUsd === 0)).toBe(true);
    expect(JSON.stringify(t.app.store.readMetrics())).not.toContain('"failure"');
  });

  it("stops scheduling new tickets once the budget is hard", async () => {
    // A per-token model (foundry grok-4-7, $1/$4 per million): ticket 01's two turns cost about $0.08 by config price.
    const t = await ticketTask({
      tickets: [ticket("01", { suggestedTier: "standard" }), ticket("02", { blockedBy: ["01"], suggestedTier: "standard" })],
      mutate: (config) => {
        // Exactly ticket 01's config price: the running charge never exceeds it, the ledger then reaches it.
        config.budgets.taskUsd = 0.0813;
        config.tiers.standard = (config.tiers.standard ?? []).filter((item) => item.model === "grok-4-7");
      },
    });
    const result = await t.app.implement();
    expect(result).toMatchObject({ ok: false, code: "BUDGET" });
    expect(t.calls).toHaveLength(1);
    const runs = t.app.store.load(t.taskId)!.ticketRuns!;
    expect(runs["01"]!.status).toBe("done");
    expect(runs["02"]?.status).not.toBe("done");
    expect(t.app.store.load(t.taskId)!.phase).toBe("BLOCKED");
  });

  it("skips tickets that are already done when /implement resumes", async () => {
    let allow = false;
    const t = await ticketTask({
      tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })],
      script: (call) => (!allow && call.cwd.endsWith("02-t02") ? { code: 1, stdout: [assistant("no", 100)] } : { stdout: [assistant("- [x] retry works", 5000)] }),
    });
    expect((await t.app.implement()).ok).toBe(false);
    const before = t.calls.length;
    allow = true;
    const again = await t.app.implement();
    expect(again.ok, again.text).toBe(true);
    const after = t.calls.slice(before);
    expect(after.every((call) => call.cwd.endsWith("02-t02"))).toBe(true);
  });

  it("stops a ticket without escalation or a strike when a plan check is destructive", async () => {
    const t = await ticketTask({ tickets: [ticket("01", { checks: ["rm -rf /"] })] });
    const result = await t.app.implement();
    expect(result).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(result.text).toContain("could not run");
    expect(result.text).toContain("rm -rf /");
    // One child only: a pricier model cannot fix the plan.
    expect(t.calls).toHaveLength(1);
    const run = t.app.store.load(t.taskId)!.ticketRuns!["01"]!;
    expect(run).toMatchObject({ status: "failed", attempts: 1 });
    expect(run.error).toMatch(/refused as destructive/);
    expect(t.ticketFile(ticket("01"))).toContain("## Status: failed");
    expect(JSON.stringify(t.app.store.readMetrics())).not.toContain('"failure"');
  });

  it("shows the next attempt what the failing check printed", async () => {
    let checks = 0;
    const t = await ticketTask({
      tickets: [ticket("01", { suggestedTier: "cheap", checks: ["npm run typecheck"] })],
      runner: checkRunner(async (command, args) => (args[0] === "run" && ++checks === 1 ? { code: 2, stdout: "", stderr: "src/a.ts(3,1): error TS2322: boom" } : { code: 0, stdout: "ok", stderr: "" })),
    });
    const result = await t.app.implement();
    expect(result.ok, result.text).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.prompt).toContain("### npm run typecheck (exit 2)");
    expect(t.calls[1]!.prompt).toContain("error TS2322: boom");
  });

  it("does not re-run a model that already failed this ticket when escalation has nowhere else to go", async () => {
    const t = await ticketTask({
      tickets: [ticket("01", { suggestedTier: "premium" })],
      mutate: (config) => void (config.tiers.premium = (config.tiers.premium ?? []).filter((item) => item.model === "claude-opus-5-5")),
      script: () => ({ code: 1, stderr: "crash", stdout: [assistant("oops", 1000)] }),
    });
    const result = await t.app.implement();
    expect(result).toMatchObject({ ok: false, code: "BLOCKED" });
    expect(t.calls).toHaveLength(1);
    expect(result.text).toContain("already ran this ticket");
  });

  it("fails a ticket whose child met no acceptance criterion when no check ran, and escalates", async () => {
    const t = await ticketTask({
      tickets: [ticket("01")],
      mutate: (config) => void (config.checks = []),
      script: () => ({ stdout: [assistant("I could not finish the retry work.", 2000)] }),
    });
    const result = await t.app.implement();
    expect(result.ok).toBe(false);
    expect(t.calls.length).toBeGreaterThan(1);
    const run = t.app.store.load(t.taskId)!.ticketRuns!["01"]!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/no acceptance criterion/);
  });

  it("posts progress lines for waves and ticket attempts", async () => {
    const t = await ticketTask({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })] });
    expect((await t.app.implement()).ok).toBe(true);
    expect(t.progress[0]).toBe("Wave 1 of 2: 01-t01");
    expect(t.progress.some((line) => /^Ticket 01 \(Ticket 01\) → \S+\/\S+$/.test(line))).toBe(true);
    expect(t.progress.some((line) => /^Ticket 01 done on \S+\/\S+: 2 turn\(s\), 0\.0s, \$0\.0000\.$/.test(line))).toBe(true);
    expect(t.progress).toContain("Ticket 01 check unit: passed (0.0s)");
    expect(t.progress).toContain("Wave 2 of 2: 02-t02");
    // Every attempt leaves a block in the chat, and the run ends with a summary of all tickets.
    expect(t.reports.some((block) => block.startsWith("### Ticket 01 done · Ticket 01") && block.includes("- Time: 0.0s this attempt") && block.includes("- Checks:") && block.includes("- [x] retry works"))).toBe(true);
    const summary = t.reports.find((block) => block.startsWith("## Implementation done in"));
    expect(summary).toBeDefined();
    expect(summary).toMatch(/- 01 ✓ Ticket 01: 2 turn\(s\), 81k tokens, \$0\.0000, 0\.0s \[\S+\/\S+ ✓ 0\.0s\]/);
    expect(summary).toContain("- Total: 2 of 2 ticket(s) done");
    expect(summary).toContain("- Integration: cost/");
    const run = t.app.store.load(t.taskId)!.ticketRuns!["01"]!;
    expect(run.attemptLog).toHaveLength(1);
    expect(run.attemptLog![0]).toMatchObject({ attempt: 1, outcome: "success", turns: 2, elapsedMs: 0 });
    expect(typeof run.startedAt).toBe("string");
    expect((await t.app.status()).text).toMatch(/Ticket 01: done .* · 0\.0s · peak/);
  });

  it("posts a heartbeat every few turns with the tools used, and a failed attempt's block names the next step", async () => {
    const turns = Array.from({ length: 7 }, (_, index) => assistant(`step ${index + 1}`, 10_000 + index * 1000));
    const tool = (name: string) => `${JSON.stringify({ type: "tool_execution_start", toolName: name })}\n`;
    const t = await ticketTask({
      tickets: [ticket("01")],
      script: () => ({ code: 1, stderr: "crash", stdout: [tool("read"), tool("bash"), tool("bash"), ...turns] }),
    });
    expect((await t.app.implement()).ok).toBe(false);
    const beats = t.progress.filter((line) => /^Ticket 01 · turn \d+ ·/.test(line));
    expect(beats[0]).toMatch(/^Ticket 01 · turn 5 · ~14k ctx · 0\.0s · \$0\.0000 so far · tools since last: read×1, bash×2$/);
    const block = t.reports.find((item) => item.startsWith("### Ticket 01 failed"))!;
    expect(block).toContain("attempt 1 of 3");
    expect(block).toContain("- Failure: pi exited with code 1");
    expect(block).toContain("- Next: a fresh child at the next tier continues on this worktree");
    const last = t.reports.filter((item) => item.startsWith("### Ticket 01 failed")).at(-1)!;
    expect(last).toContain("- Next: escalation stopped; the ticket stays failed");
    expect(t.reports.find((item) => item.startsWith("## Implementation failed in"))).toContain("- 01 ✗ Ticket 01");
  });

  it("re-runs a ticket whose text changed in a new plan version, telling the child about the earlier work", async () => {
    const t = await ticketTask({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })] });
    expect((await t.app.implement()).ok).toBe(true);
    expect(t.calls).toHaveLength(2);
    // Revise ticket 02 only; 01 is unchanged and stays done.
    expect((await t.app.startPlan("Add retry to the Neo ingest parser")).ok).toBe(true);
    await t.app.savePlanSpec(specParams);
    await t.app.commitTickets([ticket("01"), ticket("02", { blockedBy: ["01"], whatToBuild: "Build part 02 with a backoff cap." })]);
    expect((await t.app.approveDraft()).ok).toBe(true);
    const again = await t.app.implement();
    expect(again.ok, again.text).toBe(true);
    expect(t.calls).toHaveLength(3);
    expect(path.basename(t.calls[2]!.cwd)).toBe("02-t02");
    expect(t.calls[2]!.prompt).toContain("Earlier work in this worktree");
    expect(t.calls[2]!.prompt).toContain("backoff cap");
    const runs = t.app.store.load(t.taskId)!.ticketRuns!;
    expect(runs["01"]).toMatchObject({ status: "done", attempts: 1 });
    expect(runs["02"]).toMatchObject({ status: "done", attempts: 1 });
  });

  it("is refused clearly when no runner is available", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), startTurn: () => undefined });
    await app.startPlan("Add retry to the Neo ingest parser");
    await app.savePlanSpec(specParams);
    await app.commitTickets([ticket("01")]);
    await app.approveDraft();
    expect(await app.implement()).toMatchObject({ ok: false, code: "TICKET_RUNNER_MISSING" });
  });
});

// ---- child mode -------------------------------------------------------------------------------------------------

describe("child mode extension", () => {
  function recordingPi() {
    const seen = { providers: [] as string[], tools: [] as string[], events: [] as string[], other: [] as string[] };
    const pi = new Proxy(
      {
        registerProvider: (name: string) => void seen.providers.push(name),
        registerTool: (tool: { name: string }) => void seen.tools.push(tool.name),
        on: (name: string) => void seen.events.push(name),
      } as Record<string, unknown>,
      {
        get(target, key) {
          if (key in target) return target[key as string];
          seen.other.push(String(key));
          return () => undefined;
        },
      },
    );
    return { pi: pi as unknown as ExtensionAPI, seen };
  }

  async function childRoot() {
    const root = await tempRepo();
    const { projectPath } = configPaths(root);
    mkdirSync(path.dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, tieredYaml());
    return root;
  }

  it("registers providers and the web tools and nothing else when PI_COST_ROUTER_CHILD=1", async () => {
    const root = await childRoot();
    vi.stubEnv(CHILD_ENV, "1");
    vi.stubEnv(CHILD_ROOT_ENV, root);
    vi.stubEnv(CHILD_TASK_ENV, "task-x");
    const { pi, seen } = recordingPi();
    extension(pi);
    expect(seen.tools).toEqual(["web_search", "web_fetch"]);
    expect(seen.providers).toContain("local");
    expect(seen.events).toEqual(["tool_call"]); // only the bash deny hook: no message_end ledgering
    expect(seen.other).toEqual([]); // no commands or virtual model
  });

  it("registers the full surface when the variable is absent", () => {
    vi.stubEnv(CHILD_ENV, "");
    const { pi, seen } = recordingPi();
    extension(pi);
    expect(seen.other).toContain("registerCommand");
    expect(seen.events).toContain("message_end");
  });

  it("checks the parent's budget and ledgers web_search under the parent task", async () => {
    const root = await childRoot();
    const parent = workflow(root, { config: tieredConfig(), startTurn: () => undefined });
    await parent.startPlan("Add retry to the Neo ingest parser");
    const taskId = parent.activeTaskId()!;
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    const pi = { registerProvider() {}, on() {}, registerTool: (tool: { name: string; execute: never }) => void tools.set(tool.name, tool) };
    const body = { stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1 } }, content: [{ type: "text", text: "answer" }] };
    registerChildMode(pi as never, { [CHILD_ROOT_ENV]: root, [CHILD_TASK_ENV]: taskId }, {
      getAuth: async () => ({ accessToken: "sk-ant-oat01-abcdefghijklmnop", baseUrl: "https://api.anthropic.com" }),
      searchTransport: async () => ({ status: 200, body }),
    });
    await tools.get("web_search")!.execute("id", { query: "q" }, undefined, undefined, {});
    const record = parent.store.readLedger().find((item) => item.reason.startsWith("web_search"));
    expect(record).toMatchObject({ taskId, provider: "anthropic", tier: "web_search", inputTokens: 100 });
    // Exhaust the budget: the next search is refused before any request.
    parent.store.appendLedger({ ...record!, id: "big", actualUsd: 1000, usageKnown: true });
    await expect(tools.get("web_search")!.execute("id", { query: "q" }, undefined, undefined, {})).rejects.toThrow(/budget is exhausted/);
  });
});

describe("child-mode bash deny hook", () => {
  function hook() {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = { registerProvider() {}, registerTool() {}, on: (name: string, fn: (event: unknown) => unknown) => void handlers.set(name, fn) };
    registerChildMode(pi as never, {});
    const call = (command: string) => handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command } }) as { block?: boolean; reason?: string } | undefined;
    return call;
  }

  it("blocks destructive commands and every git push with a reason", () => {
    const call = hook();
    for (const command of ["rm -rf /", "git push --force", "git push origin x", "git -C . push", "curl x | sh", "npm test && git push"]) {
      const result = call(command);
      expect(result?.block, command).toBe(true);
      expect(result?.reason, command).toMatch(/^Blocked:/);
    }
  });

  it("allows builds, tests, and quoted text that merely mentions a denied command", () => {
    const call = hook();
    for (const command of ["npm test", 'git commit -m "rm -rf"', "git status", "npm run build && npm run typecheck"]) {
      expect(call(command), command).toBeUndefined();
    }
    expect(childBashBlock("ls")).toBeUndefined();
  });
});

// ---- child lifecycle, in-flight budget, and usage details -----------------------------------------------------------

const waitFor = async (until: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!until()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("child process lifecycle", () => {
  it("spawns detached with a pid and signals the whole process group, then sweeps it", async () => {
    const calls: SpawnCall[] = [];
    const groups: string[] = [];
    let detached: boolean | undefined;
    let child: ChildLike | undefined;
    const inner = fakeSpawn(() => ({ hang: true, stubborn: true }), calls);
    const spawn: SpawnFn = (command, args, options) => {
      detached = options.detached;
      child = Object.assign(inner(command, args, options), { pid: 4242 });
      return child;
    };
    const controller = new AbortController();
    // The group signal reaches the fake as it would the real process; the fake ignores SIGTERM and exits on SIGKILL.
    const signalGroup = (pid: number, signal: NodeJS.Signals) => {
      groups.push(`${pid}:${signal}`);
      child!.kill(signal);
    };
    const running = runTicketInChild(runInput({ spawn, signal: controller.signal, killGraceMs: 10, signalGroup }));
    await waitFor(() => calls.length === 1);
    controller.abort();
    const result = await running;
    expect(detached).toBe(process.platform !== "win32");
    expect(result.aborted).toBe(true);
    if (process.platform !== "win32") {
      expect(groups[0]).toBe("-4242:SIGTERM");
      expect(groups).toContain("-4242:SIGKILL");
    }
  });

  it("kills the group when the deadline passes", async () => {
    const groups: string[] = [];
    const calls: SpawnCall[] = [];
    let child: ChildLike | undefined;
    const inner = fakeSpawn(() => ({ hang: true }), calls);
    const spawn: SpawnFn = (command, args, options) => (child = Object.assign(inner(command, args, options), { pid: 77 }));
    const result = await runTicketInChild(runInput({ spawn, deadlineMs: 20, killGraceMs: 10, signalGroup: (pid, signal) => void (groups.push(`${pid}:${signal}`), child!.kill(signal)) }));
    expect(result.timedOut).toBe(true);
    if (process.platform !== "win32") expect(groups[0]).toBe("-77:SIGTERM");
  });

  it("tracks live children and abortAllChildren stops them", async () => {
    const calls: SpawnCall[] = [];
    const running = runTicketInChild(runInput({ spawn: fakeSpawn(() => ({ hang: true }), calls), killGraceMs: 10 }));
    await waitFor(() => calls.length === 1);
    expect(liveChildCount()).toBe(1);
    abortAllChildren();
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(calls[0]!.signals[0]).toBe("SIGTERM");
    expect(liveChildCount()).toBe(0);
  });

  it("Workflow.dispose aborts every in-flight ticket child", async () => {
    const t = await ticketTask({ tickets: [ticket("01"), ticket("02")], script: () => ({ hang: true }) });
    const running = t.app.implement();
    await waitFor(() => t.calls.length === 2);
    t.app.dispose();
    const result = await running;
    expect(result.ok).toBe(false);
    for (const call of t.calls) expect(call.signals[0]).toBe("SIGTERM");
    await waitFor(() => liveChildCount() === 0);
  });
});

describe("in-flight budget", () => {
  it("aborts concurrent children when ledger plus in-flight spend passes the task limit, overshooting by at most one message", async () => {
    // Charged at the config price of foundry grok-4-7 ($1/$4 per million), not the child's list price: the dearest message
    // here (12,000 tokens) costs $0.01215.
    const cost = 0.01215;
    const t = await ticketTask({
      tickets: [ticket("01", { suggestedTier: "standard" }), ticket("02", { suggestedTier: "standard" })],
      mutate: (config) => {
        config.budgets.taskUsd = 0.015;
        config.tiers.standard = (config.tiers.standard ?? []).filter((item) => item.model === "grok-4-7");
      },
      script: () => ({ hang: true, gapMs: 40, stdout: [assistant("one", 10_000), assistant("two", 11_000), assistant("three", 12_000)] }),
    });
    const result = await t.app.implement();
    expect(result).toMatchObject({ ok: false, code: "BUDGET" });
    expect(t.calls).toHaveLength(2);
    for (const call of t.calls) expect(call.signals[0]).toBe("SIGTERM");
    const runs = t.app.store.load(t.taskId)!.ticketRuns!;
    expect(runs["01"]!.status).toBe("failed");
    expect(runs["02"]!.status).toBe("failed");
    expect(runs["01"]!.error).toMatch(/budget/i);
    // Partial usage was ledgered, and the total is within one message of the limit.
    const records = ticketLedger(t.app);
    expect(records).toHaveLength(2);
    const spent = records.reduce((sum, item) => sum + (item.actualUsd ?? 0), 0);
    expect(spent).toBeGreaterThan(0.015);
    expect(spent).toBeLessThanOrEqual(0.015 + cost + 1e-9);
    expect(records.every((item) => item.outcome === "failure")).toBe(true);
  });

  it("stops on the daily limit and prices a call from config when the event has no cost", async () => {
    const noCost = (text: string, total: number) => `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: total - 50, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: total }, stopReason: "stop" } })}\n`;
    const t = await ticketTask({
      tickets: [ticket("01", { suggestedTier: "standard" })],
      mutate: (config) => void (config.budgets.dailyUsd = 0.5),
      script: () => ({ hang: true, gapMs: 40, stdout: [noCost("one", 2_000_000), noCost("two", 2_000_000)] }),
    });
    const result = await t.app.implement();
    expect(result).toMatchObject({ ok: false, code: "BUDGET" });
    expect(t.calls[0]!.signals[0]).toBe("SIGTERM");
    expect(t.app.store.load(t.taskId)!.ticketRuns!["01"]!.error).toMatch(/daily budget/);
  });
});

describe("child isolation wiring", () => {
  it("gives a ticket child an allowlisted env and git config that disables pushing", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAxxxx");
    const t = await ticketTask({ tickets: [ticket("01")] });
    expect((await t.app.implement()).ok).toBe(true);
    const env = t.calls[0]!.env;
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(Number(env.GIT_CONFIG_COUNT)).toBeGreaterThanOrEqual(3);
    const keys = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
    expect(keys).toEqual(expect.arrayContaining(["credential.helper", "core.hooksPath"]));
  });
});

describe("pi-runner usage details", () => {
  it("adds compaction usage and cost to the totals", async () => {
    const compaction = `${JSON.stringify({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: { summary: "s", tokensBefore: 9, usage: { input: 1000, output: 200, cacheRead: 5, cacheWrite: 6, cost: { total: 0.004 } } } })}\n`;
    const events: unknown[] = [];
    const result = await runTicketInChild(runInput({ onEvent: (event) => void events.push(event), spawn: fakeSpawn(() => ({ stdout: [assistant("a", 1000, {}, 0.01), compaction, assistant("b", 1000, {}, 0.01)] })) }));
    expect(result.compactions).toBe(1);
    expect(result.usage).toMatchObject({ input: 950 + 1000 + 950, output: 50 + 200 + 50, cacheRead: 5, cacheWrite: 6, turns: 2 });
    expect(result.usage.costUsd).toBeCloseTo(0.024, 9);
    expect(events).toContainEqual(expect.objectContaining({ kind: "compaction", count: 1, spend: expect.objectContaining({ costUsd: 0.004 }) }));
  });

  it("treats a final stopReason of length as a truncated failure", async () => {
    const result = await runTicketInChild(runInput({ spawn: fakeSpawn(() => ({ stdout: [assistant("cut off mid-", 100, { stopReason: "length" })] })) }));
    expect(result.ok).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.error).toMatch(/truncated/);
  });
});
