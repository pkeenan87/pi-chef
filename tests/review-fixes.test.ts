import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindWorkflow, currentWorkflow, registerWorkflow } from "../src/extension.js";
import { type ProviderId } from "../src/domain.js";
import { move } from "../src/orchestrator/machine.js";
import { Workflow } from "../src/orchestrator/service.js";
import type { DecisionAnswer, DecisionsClient } from "../src/providers/clients.js";
import type { ProviderAuthView } from "../src/providers/auth.js";
import { singleTaskRequest, tempRepo, tieredConfig, tieredYaml, workflow } from "./helpers.js";

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

describe("O8 reports", () => {
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

  it("records why a Decisions classifier call failed, redacted and on one line", async () => {
    const lines: string[] = [];
    const w = workflow(await tempRepo(), {
      config: tieredConfig(),
      auth: { async inspect(provider: ProviderId): Promise<ProviderAuthView> { return { provider, status: provider === "vercel" ? "missing" : "ready", method: "oauth", detail: "" }; } },
      deciders: {
        foundry: {
          id: "foundry",
          decide: async () => {
            throw new Error("HTTP 404 /decisions\nAuthorization: Bearer abc.def.ghi-secret");
          },
        },
      },
      progress: (line) => lines.push(line),
    });
    await w.route("add a feature");
    // A task is active once planning starts; a classifier failure then also lands in its event log.
    await w.plan("add a feature");
    await w.classifyChat("add another feature");
    const line = lines.find((item) => item.startsWith("Classifier foundry/Microsoft-Decision-1 failed"));
    expect(line).toMatch(/HTTP 404 \/decisions/);
    expect(line).not.toMatch(/\n|abc\.def|ghi-secret/);
    const events = readFileSync(path.join(w.store.taskDir(w.activeTaskId()!), "events.jsonl"), "utf8");
    expect(events).toMatch(/classify_failed/);
    expect(events).toMatch(/HTTP 404/);
    expect(events).not.toMatch(/ghi-secret/);
  });
});
