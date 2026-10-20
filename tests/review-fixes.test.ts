import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindWorkflow, currentWorkflow, registerWorkflow } from "../src/extension.js";
import { type ProviderId } from "../src/domain.js";
import { move } from "../src/orchestrator/machine.js";
import { Workflow } from "../src/orchestrator/service.js";
import type { ProviderAuthView } from "../src/providers/auth.js";
import { tempRepo, tieredConfig, tieredYaml, workflow } from "./helpers.js";

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
    writeFileSync(path.join(home, ".pi", "agent", "chef.yaml"), userYaml);
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
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(event, handler);
        return () => undefined;
      },
      appendEntry() {},
      registerProvider(name: string) {
        registered.push(`provider:${name}`);
      },
    };
    registerWorkflow(pi as unknown as ExtensionAPI);
    return { commands, handlers, registered };
  }
  const uiCtx = (cwd: string, notes: string[]) => ({ cwd, hasUI: true, ui: { notify: (m: string) => notes.push(m), setStatus() {}, confirm: async () => false } });

  it("O3: a command reports an invalid config as a failed result, and session_start still registers the providers", async () => {
    isolatedHome();
    const cwd = await tempRepo();
    writeProject(cwd, "routing: { maxEscalations: -1 }\n");
    const { commands, handlers, registered } = fakePi();
    const notes: string[] = [];
    expect(() => handlers.get("session_start")!({}, uiCtx(cwd, notes))).not.toThrow();
    expect(notes.join("\n")).toMatch(/maxEscalations/);
    notes.length = 0;
    await expect(commands.get("status")!.handler("", uiCtx(cwd, notes))).resolves.toBeUndefined();
    expect(notes.join("\n")).toMatch(/maxEscalations/);
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
    const sent: string[] = [];
    await commands.get("status")!.handler("", { ...uiCtx(cwd, notes), sendMessage: async (message: { content: string }) => void sent.push(message.content) });
    expect(sent.join("\n")).toMatch(/### Warnings\n\n- Config: Ignored project providers\.foundry\.endpoint/);
    expect(currentWorkflow()!.config.providers.foundry?.endpoint).toBe("https://res.services.ai.azure.com");
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
});
