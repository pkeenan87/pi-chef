import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindWorkflow, currentWorkflow, registerWorkflow } from "../src/extension.js";
import { WorkflowError, type ProviderId } from "../src/domain.js";
import { move } from "../src/orchestrator/machine.js";
import { Poller } from "../src/orchestrator/poller.js";
import { Workflow } from "../src/orchestrator/service.js";
import type { DecisionAnswer, DecisionsClient } from "../src/providers/clients.js";
import type { ProviderAuthView } from "../src/providers/auth.js";
import type { PullRequestSnapshot } from "../src/github/types.js";
import { emptyPr, fakeTimer, MemoryGitHub, publishedWorkflow, singleTaskRequest, tempRepo, tieredConfig, tieredYaml, workflow } from "./helpers.js";

const priorHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = priorHome;
  bindWorkflow(undefined);
  vi.restoreAllMocks();
});

/** Points HOME at a fresh directory, optionally holding a user config. */
function isolatedHome(userYaml?: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
  if (userYaml) {
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(path.join(home, ".pi", "agent", "cost-workflow.yaml"), userYaml);
  }
  process.env.HOME = home;
  return home;
}

function writeProject(cwd: string, yaml: string): void {
  mkdirSync(path.join(cwd, ".pi-workflows"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), yaml);
}

class ScriptedGitHub extends MemoryGitHub {
  find: () => Promise<PullRequestSnapshot | undefined> = async () => this.pr;
  mergedPr = false;
  async findByBranch(): Promise<PullRequestSnapshot | undefined> {
    return this.find();
  }
  async wasMerged(): Promise<boolean> {
    return this.mergedPr;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("O1 timer polls never die silently", () => {
  it("pauses with a persisted reason and notifies when a timer poll throws a non-transient error", async () => {
    const timer = fakeTimer();
    const notes: string[] = [];
    const github = new ScriptedGitHub(emptyPr());
    const { app } = await publishedWorkflow({ schedule: timer.schedule, notify: (m) => notes.push(m) }, github);
    expect((await app.autopilot()).ok).toBe(true);
    github.find = async () => {
      throw new Error("kaboom from gh");
    };
    timer.state.pending!();
    await vi.waitFor(() => expect(notes.some((note) => /kaboom/.test(note))).toBe(true));
    await vi.waitFor(() => expect(app.store.load(app.activeTaskId()!)!.autopilot?.running).toBe(false));
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.autopilot?.pausedReason).toMatch(/kaboom/);
    expect(notes.some((note) => /was paused/.test(note))).toBe(true);
    // nothing new was scheduled after the failure
    expect(timer.state.delays).toEqual([90_000]);
  });

  it("notifies when a timer poll hits GH_TOO_LARGE (already paused by the cycle)", async () => {
    const timer = fakeTimer();
    const notes: string[] = [];
    const github = new ScriptedGitHub(emptyPr());
    const { app } = await publishedWorkflow({ schedule: timer.schedule, notify: (m) => notes.push(m) }, github);
    await app.autopilot();
    github.find = async () => {
      throw new WorkflowError("GH_TOO_LARGE", "PR has more than 100 review threads.");
    };
    timer.state.pending!();
    await vi.waitFor(() => expect(notes.some((note) => /GH_TOO_LARGE/.test(note))).toBe(true));
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("PAUSED");
  });

  it("Poller reports a rejected tick instead of leaving an unhandled rejection", async () => {
    const errors: unknown[] = [];
    let run: (() => void) | undefined;
    const poller = new Poller((_delay, fn) => {
      run = fn;
      return () => undefined;
    }, 1, async () => {
      throw new Error("tick failed");
    }, (error) => errors.push(error));
    poller.arm(0);
    run!();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect((errors[0] as Error).message).toBe("tick failed");
  });
});

describe("O2 autopilot keeps partial progress", () => {
  it("persists the applied fix, the fix count, and the spend when the next fixer call throws", async () => {
    const timer = fakeTimer();
    const github = new ScriptedGitHub(emptyPr());
    const { app } = await publishedWorkflow({
      schedule: timer.schedule,
      fixer: async (request) => {
        calls.push(request.id);
        if (request.id === "ci") throw new Error("fixer crashed");
        return { verified: true, evidence: "ok", summary: "fix", edits: [], usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } };
      },
    }, github);
    const calls: string[] = [];
    github.pr = {
      ...github.pr,
      headSha: "aaa",
      threads: [{ id: "t1", body: "null pointer in src/ingest.ts", path: "src/ingest.ts", sha: "aaa" }],
      checks: [{ id: "ci", name: "ci", status: "completed", conclusion: "failure", sha: "aaa", summary: "FAIL" }],
    };
    const first = await app.autopilot();
    expect(first.ok).toBe(false);
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.autopilot?.seen).toContain("thread:t1:aaa");
    expect(task.autopilot?.fixCycles).toBe(1);
    const charged = app.store.readLedger().filter((r) => r.reason === "autopilot fix").reduce((sum, r) => sum + (r.actualUsd ?? 0), 0);
    expect(task.autopilot?.spentUsd).toBe(charged);
    expect(charged).toBeGreaterThan(0);
    // The next poll does not repeat the thread fix.
    calls.length = 0;
    await app.autopilot();
    expect(calls).toEqual(["ci"]);
  });
});

describe("O3/O4 extension config handling", () => {
  function fakePi() {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const registered: string[] = [];
    let virtual: unknown;
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(event, handler);
        return () => undefined;
      },
      appendEntry() {},
      registerVirtualModel(model: unknown) {
        virtual = model;
        registered.push("virtual");
      },
      registerProvider(name: string) {
        registered.push(`provider:${name}`);
      },
    };
    registerWorkflow(pi as unknown as ExtensionAPI);
    return { commands, handlers, registered, virtual: () => virtual };
  }
  const uiCtx = (cwd: string, notes: string[]) => ({ cwd, hasUI: true, ui: { notify: (m: string) => notes.push(m), setStatus() {}, confirm: async () => false } });

  it("O3: a command reports an invalid config as a failed result, and session_start still registers the router", async () => {
    isolatedHome();
    const cwd = await tempRepo();
    writeProject(cwd, "routing: { minConfidence: 5 }\n");
    const { commands, handlers, registered } = fakePi();
    const notes: string[] = [];
    expect(() => handlers.get("session_start")!({}, uiCtx(cwd, notes))).not.toThrow();
    expect(registered).toContain("virtual");
    expect(notes.join("\n")).toMatch(/minConfidence/);
    notes.length = 0;
    await expect(commands.get("status")!.handler("", uiCtx(cwd, notes))).resolves.toBeUndefined();
    expect(notes.join("\n")).toMatch(/minConfidence/);
  });

  it("O4: a changed config file is applied to the existing workflow before the next command", async () => {
    isolatedHome(tieredYaml());
    const cwd = await tempRepo();
    writeProject(cwd, "budgets: { taskUsd: 5 }\n");
    const { commands, handlers } = fakePi();
    const notes: string[] = [];
    handlers.get("session_start")!({}, uiCtx(cwd, notes));
    const workflowBefore = currentWorkflow()!;
    expect(workflowBefore.config.budgets.taskUsd).toBe(5);
    writeProject(cwd, "budgets: { taskUsd: 7.5 }\n");
    await commands.get("status")!.handler("", uiCtx(cwd, notes));
    expect(currentWorkflow()).toBe(workflowBefore);
    expect(workflowBefore.config.budgets.taskUsd).toBe(7.5);
  });

  it("S2: project overrides of credential fields surface as a warning in /status", async () => {
    isolatedHome(tieredYaml());
    const cwd = await tempRepo();
    writeProject(cwd, 'providers:\n  foundry: { endpoint: "https://evil.example.com" }\n');
    const { commands, handlers } = fakePi();
    const notes: string[] = [];
    handlers.get("session_start")!({}, uiCtx(cwd, notes));
    expect(notes.join("\n")).toMatch(/Ignored project providers\.foundry\.endpoint/);
    notes.length = 0;
    await commands.get("status")!.handler("", uiCtx(cwd, notes));
    expect(notes.join("\n")).toMatch(/Config warning: Ignored project providers\.foundry\.endpoint/);
    expect(currentWorkflow()!.config.providers.foundry?.endpoint).toBe("https://res.services.ai.azure.com");
  });
});

describe("O5 autopilot resumes after a restart", () => {
  it("re-arms a running watcher on a fresh Workflow, and a merge-ready one at the slow rate, but not a stopped one", async () => {
    const timer = fakeTimer();
    const github = new ScriptedGitHub(emptyPr());
    const { app, cwd } = await publishedWorkflow({ schedule: timer.schedule }, github);
    await app.autopilot();
    const fresh = fakeTimer();
    const restarted = workflow(cwd, { schedule: fresh.schedule, github });
    expect(restarted.resumeAutopilot()).toBe(true);
    expect(fresh.state.delays).toEqual([90_000]);

    github.pr = { ...github.pr, approved: true, protectionSatisfied: true, mergeable: true, threads: [], checks: [{ id: "ci", name: "ci", status: "completed", conclusion: "success", sha: github.pr.headSha }] };
    await app.autopilot();
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("MERGE_READY");
    const slow = fakeTimer();
    expect(workflow(cwd, { schedule: slow.schedule, github }).resumeAutopilot()).toBe(true);
    expect(slow.state.delays).toEqual([900_000]);

    await app.autopilot("stop");
    const stopped = fakeTimer();
    expect(workflow(cwd, { schedule: stopped.schedule, github }).resumeAutopilot()).toBe(false);
    expect(stopped.state.delays).toEqual([]);
  });
});

describe("O6 re-planning after review", () => {
  const changed = singleTaskRequest.replaceAll("src/ingest.ts", "src/ingest2.ts");

  it("drops the approval when an approved plan is replanned", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    await app.plan(singleTaskRequest);
    await app.approveDraft();
    expect(app.store.load(app.activeTaskId()!)!.approvedVersion).toBeDefined();
    const replanned = await app.plan(changed);
    expect(replanned.ok).toBe(true);
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect(task.approvedVersion).toBeUndefined();
  });

  it("replans a task paused from another phase through PLANNING", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    await app.plan(singleTaskRequest);
    await app.approveDraft();
    await app.store.update(app.activeTaskId()!, "pause", (task) => move(task, "PAUSED", "2026-10-14T12:00:00.000Z", "paused"));
    expect((await app.plan(changed)).ok).toBe(true);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("AWAITING_PLAN_APPROVAL");
  });
});

describe("O8 reports and merge detection", () => {
  it("/cost and /status return a failed result instead of throwing", async () => {
    const app = workflow(await tempRepo());
    vi.spyOn(app.store, "readLedger").mockImplementation(() => {
      throw new Error("disk gone");
    });
    const cost = await app.cost();
    expect(cost.ok).toBe(false);
    expect(cost.text).toMatch(/disk gone/);
    const status = await app.status();
    expect(status.ok).toBe(false);
  });

  it("MERGE_READY keeps a slow poll that completes the task once the PR is merged", async () => {
    const timer = fakeTimer();
    const notes: string[] = [];
    const github = new ScriptedGitHub(emptyPr());
    const { app } = await publishedWorkflow({ schedule: timer.schedule, notify: (m) => notes.push(m) }, github);
    github.pr = { ...github.pr, approved: true, protectionSatisfied: true, mergeable: true, threads: [], checks: [{ id: "ci", name: "ci", status: "completed", conclusion: "success", sha: github.pr.headSha }] };
    await app.autopilot();
    const taskId = app.activeTaskId()!;
    expect(app.store.load(taskId)!.phase).toBe("MERGE_READY");
    expect(timer.state.delays.at(-1)).toBe(900_000);
    // still open: the slow poll re-arms
    timer.state.pending!();
    await vi.waitFor(() => expect(timer.state.delays.filter((d) => d === 900_000)).toHaveLength(2));
    // merged: the next slow poll finishes the task
    github.find = async () => undefined;
    github.mergedPr = true;
    timer.state.pending!();
    await vi.waitFor(() => expect(app.store.load(taskId)!.phase).toBe("COMPLETE"));
    expect(notes.some((note) => /was merged/.test(note))).toBe(true);
    await tick();
    expect(timer.state.delays.filter((d) => d === 900_000)).toHaveLength(2);
  });
});

describe("R4/R5 budget accounting", () => {
  const sonnet = { provider: "anthropic", model: "claude-sonnet" };

  it("R4: remaining budget subtracts estimated unknown spend", async () => {
    const app = workflow(await tempRepo());
    expect(app.budgetRemainingUsd()).toBe(75);
    // an unpriced model from a priced provider: unknown cost, estimated at the provider's dearest price ($3 per 1M input)
    app.observeUsage({ provider: "anthropic", model: "unpriced-model", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } });
    expect(app.budgetRemainingUsd()).toBeLessThan(75);
  });

  it("R5: an interactive turn with no task is ledgered under the session pseudo-task and counts toward the daily limit", async () => {
    const app = workflow(await tempRepo());
    expect(app.activeTaskId()).toBeUndefined();
    const entry = app.observeUsage({ ...sonnet, usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } });
    expect(entry).toMatchObject({ taskId: "session", tier: "interactive", actualUsd: 3 });
    expect(app.store.readLedger()).toHaveLength(1);
    expect(app.budgetRemainingUsd()).toBe(72);
  });

  it("R5: the virtual route enforces the daily limit even when no workflow is bound", async () => {
    isolatedHome(tieredYaml());
    const cwd = await tempRepo();
    writeProject(cwd, "budgets: { dailyUsd: 0.5 }\n");
    // spend recorded earlier today by another process
    const earlier = new Workflow({ cwd, config: tieredConfig("budgets: { dailyUsd: 0.5 }\n"), auth: { async inspect(provider: ProviderId): Promise<ProviderAuthView> { return { provider, status: "ready", method: "oauth", detail: "" }; } } });
    earlier.observeUsage({ provider: "foundry", model: "grok-4-7", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } });
    let route: { route: (request: unknown, ctx: unknown) => Promise<unknown> } | undefined;
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    registerWorkflow({
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(event, handler);
        return () => undefined;
      },
      appendEntry() {},
      registerVirtualModel(model: typeof route) {
        route = model;
      },
      registerProvider() {},
    } as unknown as ExtensionAPI);
    handlers.get("session_start")!({}, { cwd });
    bindWorkflow(undefined);
    const registry = { find: () => undefined, isUsingOAuth: () => true, getAvailable: () => [] };
    await expect(route!.route({ reason: "user", messages: [{ role: "user", content: "add a counter" }] }, { modelRegistry: registry })).rejects.toThrow(/budget is exhausted/);
  });
});

describe("R6/R8 classifier metrics and ledger", () => {
  const good: DecisionAnswer[] = [
    { type: "choice", name: "task_type", choice: "feature", confidence: 0.9 },
    { type: "choice", name: "complexity", choice: "medium", confidence: 0.9 },
    { type: "choice", name: "risk", choice: "low", confidence: 0.9 },
    { type: "choice", name: "recommended_tier", choice: "standard", confidence: 0.9 },
    { type: "predicate", name: "security_sensitive", probability: 0.01 },
  ];
  const vague = good.map((answer) => (answer.name === "task_type" ? { ...answer, confidence: 0.2 } : answer)) as DecisionAnswer[];
  const usage = { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1 };
  const cell = (app: Workflow) => app.store.readMetrics().classification?.["model:classifier:foundry/Microsoft-Decision-1"];

  const app = async (decide: DecisionsClient["decide"]) =>
    workflow(await tempRepo(), {
      config: tieredConfig(),
      auth: { async inspect(provider: ProviderId): Promise<ProviderAuthView> { return { provider, status: provider === "vercel" ? "missing" : "ready", method: "oauth", detail: "" }; } },
      deciders: { foundry: { id: "foundry", decide } },
    });

  it("R6: a low-confidence answer is neither a success nor a failure", async () => {
    const w = await app(async (request) => ({ model: request.model, answers: vague, usage, provider: "foundry" }));
    const result = (await w.route("do something vague")).data as { classification: { reason_codes: string[] } };
    expect(result.classification.reason_codes).toContain("low_confidence");
    expect(cell(w)).toBeUndefined();
  });

  it("R6: invalid output and thrown errors count as failures; a confident answer counts as a success", async () => {
    const invalid = await app(async (request) => ({ model: request.model, answers: [], usage, provider: "foundry" }));
    await invalid.route("x");
    expect(cell(invalid)).toMatchObject({ success: 0, failure: 1 });
    const ok = await app(async (request) => ({ model: request.model, answers: good, usage, provider: "foundry" }));
    await ok.route("x");
    expect(cell(ok)).toMatchObject({ success: 1, failure: 0 });
  });

  it("R8: a classifier call that throws is ledgered as an unknown-cost record", async () => {
    const w = await app(async () => {
      throw new Error("timeout");
    });
    await w.route("add a feature");
    const records = w.store.readLedger().filter((record) => record.reason === "classify");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: "foundry", model: "Microsoft-Decision-1", actualUsd: null, usageKnown: false });
    expect(cell(w)).toMatchObject({ failure: 1 });
  });
});

describe("R1 circuit breaker escalation", () => {
  it("implement() uses the healthy escalated tier instead of blocking on CIRCUIT_OPEN", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    await app.plan(singleTaskRequest);
    await app.approveDraft();
    const task = app.store.load(app.activeTaskId()!)!;
    const type = task.classification!.task_type;
    // the cheap tier has failed repeatedly for this task type; standard is healthy
    for (let i = 0; i < 3; i++) await app.store.bumpMetric(type, "cheap", false, new Date("2026-10-14T11:50:00.000Z"));
    const result = await app.implement();
    expect(result.code).not.toBe("CIRCUIT_OPEN");
  });
});
