import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workflow } from "../src/orchestrator/service.js";
import { runBuild } from "../src/orchestrator/build.js";
import { checkRunner, emptyPr, MemoryGitHub, publishedWorkflow, readyAuth, sampleSpec, sampleTicket, singleTaskRequest, tasksRequest, tempRepo, testConfig, tieredConfig, ticketWorkflow, workflow, writingDriver } from "./helpers.js";
import type { PullRequestSnapshot } from "../src/github/types.js";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (!entry.name.endsWith(".lock")) out.push(full);
  }
  return out;
}

describe("workflow", () => {
  it("refuses a build before approval, freezes the approved plan once, and rebuilds state from the event log after a restart", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    const planned = await app.plan(tasksRequest);
    expect(planned.ok).toBe(true);
    const refused = await app.startBuild();
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("APPROVAL_REQUIRED");
    const approved = await app.approveDraft();
    expect(approved.ok).toBe(true);
    expect(approved.text).toContain("Run /build");
    const frozen = path.join(cwd, ".pi-workflows", "tasks");
    const taskDir = readdirSync(frozen)[0]!;
    const approvedFile = path.join(frozen, taskDir, "plan.v1.approved.json");
    const first = readFileSync(approvedFile, "utf8");
    expect((await app.approveDraft()).text).toMatch(/already approved/);
    expect(readFileSync(approvedFile, "utf8")).toBe(first);

    rmSync(path.join(frozen, taskDir, "state.json"));
    const restarted = new Workflow({ cwd, config: testConfig(), auth: readyAuth(), now: () => new Date("2026-10-14T12:00:00.000Z"), confirm: async () => true, runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })), push: async () => undefined });
    const status = await restarted.status();
    expect(status.text).toContain("AWAITING_PLAN_APPROVAL");
    expect(status.text).toContain("Approved plan v1");
  });

  it("keeps secrets out of artifacts", async () => {
    const cwd = await tempRepo();
    const secret = "sk-live-SECRETVALUE123456";
    const app = workflow(cwd);
    await app.plan(`Rotate the ${secret} in Neo`);
    const root = path.join(cwd, ".pi-workflows");
    const blob = walk(root).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(blob).not.toContain(secret);
    expect(blob).toContain("[REDACTED]");
  });

  it("reviews a failing check, gates the push on a confirmation, and publishes once everything passes", async () => {
    const cwd = await tempRepo();
    const flags = { checksPass: true, confirm: true };
    const github = new MemoryGitHub({
      number: 0,
      url: "",
      branch: "",
      base: "main",
      headSha: "pending",
      baseSha: "base",
      mergeable: true,
      approved: false,
      protectionSatisfied: false,
      threads: [],
      checks: [],
    } satisfies PullRequestSnapshot);
    const pushed: string[] = [];
    const { app: publisher } = await ticketWorkflow([sampleTicket("01")], {
      config: testConfig(),
      runner: checkRunner(async () => (flags.checksPass ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "FAIL injected test" })),
      github,
      confirm: async () => flags.confirm,
      push: async (branch) => void pushed.push(branch),
    }, { cwd });
    expect((await runBuild(() => publisher, writingDriver(cwd))).ok).toBe(true);

    flags.checksPass = false;
    const review = await publisher.ship();
    expect(review.ok).toBe(false);
    expect(review.code).toBe("REVIEW_BLOCKING");
    expect(review.text).toMatch(/blocking/);
    expect(JSON.stringify(review.data)).toContain("FAIL injected");
    expect(pushed).toEqual([]);
    expect(publisher.store.load(publisher.activeTaskId()!)!.phase).toBe("IMPLEMENTING");

    flags.checksPass = true;
    flags.confirm = false;
    expect((await publisher.ship()).code).toBe("NOT_SHIPPED");
    expect(pushed).toEqual([]);

    flags.confirm = true;
    const published = await publisher.ship();
    expect(published.ok).toBe(true);
    expect(github.pr.number).toBe(7);
    expect(pushed).toHaveLength(1);
    expect(publisher.store.load(publisher.activeTaskId()!)!.phase).toBe("PUBLISHED");
  });

  it("pauses a security-sensitive plan until a person confirms", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), rng: () => 0.5, startTurn: () => undefined, confirm: async () => false });
    await app.startPlan("change auth and permissions for Neo production secrets");
    await app.savePlanSpec(sampleSpec);
    await app.commitTickets([sampleTicket("01")]);
    await app.approveDraft();
    const result = await app.startBuild();
    expect(result.code).toBe("SECURITY_PAUSE");
    expect((await app.status()).text).toContain("PAUSED");
  });
});

class FlakyGitHub extends MemoryGitHub {
  mergedPr = false;
  mergeChecks = 0;
  async wasMerged(): Promise<boolean> {
    this.mergeChecks += 1;
    return this.mergedPr;
  }
}

describe("a new /plan closes the published task", () => {
  const request = "Add a retry counter to the Neo ingest parser";

  it("closes a task whose PR is merged without asking, and goes on to plan", async () => {
    const github = new FlakyGitHub(emptyPr());
    const lines: string[] = [];
    let asked = 0;
    const { app } = await publishedWorkflow({ progress: (line) => void lines.push(line), confirm: async () => (asked += 1, true) }, github);
    const firstId = app.activeTaskId()!;
    github.mergedPr = true;
    asked = 0;
    const result = await app.startPlan(request);
    expect(result.ok, result.text).toBe(true);
    expect(asked).toBe(0);
    expect(lines).toContain(`Closed ${firstId}: PR #7 is merged.`);
    expect(app.store.load(firstId)!.phase).toBe("COMPLETE");
    expect(app.activeTaskId()).not.toBe(firstId);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("PLANNING");
  });

  it("asks when the PR is not merged, and closes the task on a yes", async () => {
    const github = new FlakyGitHub(emptyPr());
    const asks: { title: string; message: string }[] = [];
    const { app } = await publishedWorkflow({ confirm: async (title, message) => (asks.push({ title, message }), true) }, github);
    const firstId = app.activeTaskId()!;
    const result = await app.startPlan(request);
    expect(result.ok, result.text).toBe(true);
    const ask = asks.find((item) => item.title === "Start a new task?");
    expect(ask?.message).toBe(`PR #7 for ${firstId} is not merged. Close that task and start a new one?`);
    expect(app.store.load(firstId)!.phase).toBe("COMPLETE");
    expect(app.activeTaskId()).not.toBe(firstId);
  });

  it("keeps the task when the person says no, or when there is no UI to ask", async () => {
    const github = new FlakyGitHub(emptyPr());
    const { app, cwd } = await publishedWorkflow({}, github);
    const firstId = app.activeTaskId()!;
    const denied = workflow(cwd, { startTurn: () => undefined, github, confirm: async () => false });
    const result = await denied.startPlan(request);
    expect(result).toMatchObject({ ok: false, code: "TASK_ACTIVE" });
    expect(result.text).toContain("not merged");
    expect(denied.activeTaskId()).toBe(firstId);
    expect(denied.store.load(firstId)!.phase).toBe("PUBLISHED");
    // The literal ```tasks entry point behaves the same.
    expect((await denied.plan(request)).code).toBe("TASK_ACTIVE");
    // A workflow with no confirm hook (no UI) answers no.
    const headless = new Workflow({ cwd, config: testConfig(), auth: readyAuth(), github, startTurn: () => undefined });
    expect((await headless.startPlan(request)).code).toBe("TASK_ACTIVE");
    expect(headless.store.load(firstId)!.phase).toBe("PUBLISHED");
  });

  it("also closes a task an older version left in AUTOPILOT or MERGE_READY", async () => {
    for (const phase of ["AUTOPILOT", "MERGE_READY"] as const) {
      const github = new FlakyGitHub(emptyPr());
      const { app } = await publishedWorkflow({}, github);
      const firstId = app.activeTaskId()!;
      await app.store.update(firstId, "old file", (task) => ({ ...task, phase }));
      github.mergedPr = true;
      expect((await app.startPlan(request)).ok).toBe(true);
      expect(app.store.load(firstId)!.phase).toBe("COMPLETE");
    }
  });
});

describe("build and ship robustness", () => {
  it("warns on a soft budget and refuses a hard one before the security prompt", async () => {
    const cwd = await tempRepo();
    const messages: string[] = [];
    let prompts = 0;
    const config = tieredConfig();
    config.budgets.taskUsd = 1;
    const app = workflow(cwd, { config, rng: () => 0.5, startTurn: () => undefined, notify: (message) => messages.push(message), confirm: async () => (prompts += 1, false) });
    await app.startPlan("change auth and permissions for Neo production secrets");
    await app.savePlanSpec(sampleSpec);
    await app.commitTickets([sampleTicket("01")]);
    await app.approveDraft();
    const id = app.activeTaskId()!;
    const spend = (actualUsd: number) =>
      app.store.appendLedger({
        id: `s${actualUsd}`, at: "2026-10-14T12:00:00.000Z", taskId: id, phase: "IMPLEMENTING", provider: "openai", model: "gpt-5.4", tier: "premium",
        requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd, usageKnown: true, outcome: "success", retries: 0, reason: "test",
      });
    spend(0.9);
    expect((await app.startBuild()).code).toBe("SECURITY_PAUSE");
    expect(messages.some((message) => /Budget warning/.test(message))).toBe(true);
    spend(0.5);
    prompts = 0;
    const hard = await app.startBuild();
    expect(hard.code).toBe("BUDGET");
    expect(prompts).toBe(0);
  });

  it("reports corrupt event lines in status", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    await app.plan(singleTaskRequest);
    await app.approveDraft();
    const dir = path.join(cwd, ".pi-workflows", "tasks", app.activeTaskId()!);
    const events = path.join(dir, "events.jsonl");
    writeFileSync(events, `${readFileSync(events, "utf8").replace(/\n$/, "")}\nnot json\n{"seq":99}\n`);
    expect((await app.status()).text).toMatch(/corrupt line/);
  });

  it("rejects a dependency cycle at plan time", async () => {
    const cyclic = `Loop\n\`\`\`tasks\n[{"id":"a","files":["x.ts"],"dependsOn":["b"]},{"id":"b","files":["y.ts"],"dependsOn":["a"]}]\n\`\`\``;
    const rejected = await workflow(await tempRepo()).plan(cyclic);
    expect(rejected.code).toBe("PLAN_CYCLE");
  });

  it("skips the /ship re-run of a check that already passed on the same tree", async () => {
    const cwd = await tempRepo();
    let runs = 0;
    const github = new MemoryGitHub(emptyPr());
    const { app } = await ticketWorkflow([sampleTicket("01")], { config: testConfig(), github, runner: checkRunner(async () => (runs += 1, { code: 0, stdout: "ok", stderr: "" })) }, { cwd });
    expect((await runBuild(() => app, writingDriver(cwd))).ok).toBe(true);
    expect(runs).toBe(1);
    // The build ran its check on a dirty tree; /ship runs it once on the committed tree, and a second /ship reuses that pass.
    expect((await app.ship()).ok).toBe(true);
    const afterShip = runs;
    expect(afterShip).toBe(2);
    expect((await app.ship()).ok).toBe(true);
    expect(runs).toBe(afterShip);
  });
});

describe("task files written by an older version", () => {
  it("loads with the removed fields ignored, shows status, and can still be re-planned", async () => {
    const { app, cwd, taskId } = await ticketWorkflow([sampleTicket("01")], { config: testConfig() });
    const file = path.join(cwd, ".pi-workflows", "tasks", taskId, "state.json");
    const old = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    Object.assign(old, {
      phase: "MERGE_READY",
      mergeReadyAt: "2026-10-14T12:00:00.000Z",
      worktrees: [{ groupId: "01-t01", branch: `cost/${taskId}/01-t01`, path: "/gone/01", baseSha: "a", headSha: "b", abandoned: true }],
      integration: { branch: `cost/${taskId}/integration`, sha: "c", path: "/gone/integration" },
      contextResets: [{ boundary: "post-approval", at: "2026-10-14T12:00:00.000Z", mode: "new-session", cancelled: false, handoffFile: "handoffs/post-approval.md" }],
      autopilot: { running: false, attempts: {}, seen: [], fixCycles: 0, spentUsd: 0 },
    });
    writeFileSync(file, JSON.stringify(old));
    const loaded = app.store.load(taskId)!;
    expect(loaded.phase).toBe("MERGE_READY");
    const status = await app.status();
    expect(status.ok, status.text).toBe(true);
    expect(status.text).toContain("MERGE_READY");
    expect(status.text).not.toMatch(/Worktrees|Integration/);
    // The retired phase is not a dead end: a new /plan closes it (the PR is not merged, and the person says yes).
    const result = await app.startPlan("Add a retry counter to the Neo ingest parser");
    expect(result.ok, result.text).toBe(true);
    expect(app.store.load(taskId)!.phase).toBe("COMPLETE");
  });
});

describe("classifier usage", () => {
  const verdict = JSON.stringify({ task_type: "feature", complexity: "low", risk: "low", required_capabilities: [], recommended_tier: "cheap", confidence: 0.95, reason_codes: ["ok"] });

  it("ledgers classifier usage and reclassifies only when the plan text changes", async () => {
    const cwd = await tempRepo();
    let calls = 0;
    const classifier = {
      async complete() {
        calls += 1;
        return { text: verdict, provider: "local", model: "local-coder", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 } };
      },
    };
    const app = workflow(cwd, { classifier });
    await app.plan(singleTaskRequest);
    expect(calls).toBe(1);
    await app.plan(singleTaskRequest);
    expect(calls).toBe(1);
    await app.plan(`${singleTaskRequest}\nAC: it works`);
    expect(calls).toBe(2);
    const records = app.store.readLedger().filter((record) => record.tier === "classifier");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ provider: "local", model: "local-coder", inputTokens: 100, outputTokens: 20, reason: "classify" });
  });
});
