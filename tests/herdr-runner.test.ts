import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { foundryModelOf, modelLabel } from "../src/config.js";
import { runBuild, type BuildDriver } from "../src/orchestrator/build.js";
import { Workflow } from "../src/orchestrator/service.js";
import { runInHerdr, tabName } from "../src/subagent/herdr-runner.js";
import { fakeHerdrClient } from "./herdr-fake.js";
import { checkRunner, readyAuth, sampleTicket, tieredConfig, ticketWorkflow } from "./helpers.js";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const child = (dir: string, provider: string, model: string) => {
  const sm = SessionManager.create("/work", dir);
  sm.appendMessage({ role: "user", content: "t", timestamp: Date.now() } as never);
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done.\n- [x] retry works" }], api: "x", provider, model, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost }, stopReason: "stop", timestamp: Date.now() } as never);
};

/** A herdr driver over a real Workflow, like buildHost's: `enter` moves into the worktree by resolving a Workflow there. */
async function herdrBuild(options: { worktree: boolean; foundry?: boolean }) {
  const config = tieredConfig();
  config.isolation = { ...config.isolation, worktree: options.worktree, runner: "herdr" };
  if (options.foundry) {
    config.tiers.ticketLow = [{ provider: "foundry", model: "grok-4-7" }];
    config.providers.foundry!.deployments = { "grok-4-7": "grok-4-6" };
  }
  const extras = { config, runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })), auth: readyAuth() };
  const { app, cwd } = await ticketWorkflow([sampleTicket("01", { difficulty: "low" })], extras);
  const state = { workflow: app as Workflow };
  const fake = fakeHerdrClient({
    onSend: (tab) => {
      writeFileSync(path.join(tab.options.cwd!, "f1.txt"), "x\n");
      const [provider, ...rest] = tab.model.replace(/:.*$/, "").split("/");
      child(tab.sessionDir, provider!, rest.join("/"));
    },
  });
  const labels: string[] = [];
  const driver: BuildDriver = {
    async fresh(model, run, ticketId, limits) {
      const wf = state.workflow;
      return runInHerdr(
        {
          client: fake.client,
          space: "sp1",
          cwd: wf.cwd,
          ticketId,
          model,
          modelLabel: modelLabel(wf.config, model.provider, model.provider === "foundry" ? foundryModelOf(wf.config, model.id) : model.id),
          limits,
          ticketModePath: "/pi-chef/src/ticket-mode.ts",
          host: {
            sessionsRoot: () => state.workflow.ticketSessionsRoot(),
            taskName: () => state.workflow.ticketSessionsName(),
            ledger: (files, id, launched) => void state.workflow.ledgerChildSession(files, { ticketId: id, model: launched }),
            sweep: (id, launched) => void state.workflow.sweepTicketSessions(id, { model: launched }),
            progress: (text) => void labels.push(text),
            activity: (action, text) => void (action === "start" && labels.push(`activity: ${text}`)),
          },
        },
        run,
      );
    },
    async finish() {},
  };
  if (options.worktree) driver.enter = async (dir) => void (state.workflow = new Workflow({ cwd: dir, ...extras }));
  const result = await runBuild(() => state.workflow, driver);
  return { app, cwd, fake, labels, result };
}

describe("runInHerdr", () => {
  it("launches a mapped Foundry model on its deployment id and labels it with the mapping", async () => {
    const { fake, labels, app } = await herdrBuild({ worktree: false, foundry: true });
    expect(fake.tabs[0]!.model).toBe("foundry/grok-4-6");
    expect(labels.some((line) => line.includes("foundry/grok-4-7 → grok-4-6") && line.startsWith("Ticket 01"))).toBe(true);
    expect(labels.some((line) => line.startsWith("activity: Build · ticket 01 · foundry/grok-4-7 → grok-4-6"))).toBe(true);
    expect(app.store.load(app.activeTaskId()!)!.ticketRuns!["01"]!.status).toBe("done");
  });

  it("keeps the session dir and status file in the main checkout's workspace, outside a worktree", async () => {
    const { fake, cwd, app } = await herdrBuild({ worktree: true });
    const worktree = app.store.load(app.activeTaskId()!)!.build!.worktree!;
    const tab = fake.tabs[0]!;
    expect(tab.options.cwd).toBe(worktree);
    expect(worktree).not.toBe(cwd);
    for (const file of [tab.sessionDir, tab.statusFile!]) {
      expect(file.startsWith(path.join(cwd, ".pi-workflows"))).toBe(true);
      expect(path.relative(worktree, file).startsWith("..")).toBe(true);
    }
    expect(app.store.load(app.activeTaskId()!)!.ticketRuns!["01"]!.status).toBe("done");
  });

  it("names tabs within hc's 32 characters", () => {
    expect(tabName("retry-ingest-parser", "01", 1)).toBe("chef-retry-ingest-parser-01-1");
    const long = tabName("a-very-long-task-name-that-keeps-going", "12", 3);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith("-12-3")).toBe(true);
    expect(tabName("Odd Name!", "01", 2)).toBe("chef-odd-name--01-2");
  });
});
