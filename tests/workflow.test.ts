import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewReport } from "../src/domain.js";
import { Workflow } from "../src/orchestrator/service.js";
import { runBuild } from "../src/orchestrator/build.js";
import { builtWorkflow, checkRunner, readyAuth, sampleSpec, sampleTicket, singleTaskRequest, tasksRequest, tempRepo, testConfig, tieredConfig, ticketWorkflow, workflow, writingDriver } from "./helpers.js";

const exec = promisify(execFile);

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
    const restarted = new Workflow({ cwd, config: testConfig(), auth: readyAuth(), now: () => new Date("2026-10-14T12:00:00.000Z"), confirm: async () => true, runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })) });
    const status = await restarted.status();
    expect(status.text).toContain("| Task | ");
    expect(status.text).toMatch(/\| Task \| \S+ \(task-\d{14}-[^)]+\) \|/);
    expect(status.text).toMatch(/\| Plan \| v1 approved \d\d:\d\d \|/);
    expect(status.text).toContain("## Status · Approved v1 · run /build");
  });

  it("keeps secrets out of artifacts", async () => {
    const cwd = await tempRepo();
    const secret = "sk-live-SECRETVALUE123456";
    const app = workflow(cwd);
    await app.plan(`Rotate the ${secret} in the ingest parser`);
    const root = path.join(cwd, ".pi-workflows");
    const blob = walk(root).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(blob).not.toContain(secret);
    expect(blob).toContain("[REDACTED]");
  });

  it("reviews a failing check, then passes, without moving the phase or committing", async () => {
    const cwd = await tempRepo();
    const flags = { checksPass: true };
    const { app } = await ticketWorkflow([sampleTicket("01")], {
      config: testConfig(),
      runner: checkRunner(async () => (flags.checksPass ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "FAIL injected test" })),
    }, { cwd });
    expect((await runBuild(() => app, writingDriver(cwd))).ok).toBe(true);
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout;

    flags.checksPass = false;
    const review = await app.review();
    expect(review.ok).toBe(false);
    expect(review.code).toBe("REVIEW_BLOCKING");
    expect(JSON.stringify(review.data)).toContain("FAIL injected");
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("IMPLEMENTING");

    flags.checksPass = true;
    const passed = await app.review();
    expect(passed.ok, passed.text).toBe(true);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("IMPLEMENTING");
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout).toBe(head);
  });

  it("pauses a security-sensitive plan until a person confirms", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), rng: () => 0.5, startTurn: () => undefined, confirm: async () => false });
    await app.startPlan("change auth and permissions for the ingest parser production secrets");
    await app.savePlanSpec(sampleSpec);
    await app.commitTickets([sampleTicket("01")]);
    await app.approveDraft();
    const result = await app.startBuild();
    expect(result.code).toBe("SECURITY_PAUSE");
    expect((await app.status()).text).toContain("## Status · Paused · ");
  });
});

describe("a new /plan closes a finished task", () => {
  const request = "Add a retry counter to the ingest parser";

  it("parks a task that is built but not reviewed", async () => {
    const lines: string[] = [];
    const { app } = await builtWorkflow({ progress: (line) => void lines.push(line), startTurn: () => undefined });
    const firstId = app.activeTaskId()!;
    expect((await app.startPlan(request)).ok).toBe(true);
    expect(app.store.load(firstId)!.phase).toBe("IMPLEMENTING");
    expect(lines.some((line) => line.startsWith(`Parked ${app.store.load(firstId)!.name} (Built · `))).toBe(true);
  });

  it("closes a task whose tickets are all built and whose review passed, and goes on to plan", async () => {
    const lines: string[] = [];
    const { app } = await builtWorkflow({ progress: (line) => void lines.push(line), startTurn: () => undefined });
    const firstId = app.activeTaskId()!;
    await app.store.update(firstId, "reviewed", (task) => ({ ...task, review: { passed: true } as ReviewReport }));
    expect(app.store.load(firstId)!.phase).toBe("IMPLEMENTING");
    const result = await app.startPlan(request);
    expect(result.ok, result.text).toBe(true);
    const closed = app.store.load(firstId)!;
    expect(lines).toContain(`Closed ${closed.name}.`);
    expect(closed.phase).toBe("COMPLETE");
    expect(closed.closedReason).toBe("closed by a new plan");
    expect(app.activeTaskId()).not.toBe(firstId);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("PLANNING");
  });

  it("closes a task an older version left in PUBLISHED, AUTOPILOT, or MERGE_READY, via either entry point", async () => {
    for (const phase of ["PUBLISHED", "AUTOPILOT", "MERGE_READY"] as const) {
      const lines: string[] = [];
      const { app } = await builtWorkflow({ progress: (line) => void lines.push(line), startTurn: () => undefined });
      const firstId = app.activeTaskId()!;
      await app.store.update(firstId, "old file", (task) => ({ ...task, phase }));
      expect((await app.startPlan(request)).ok).toBe(true);
      expect(app.store.load(firstId)!.phase).toBe("COMPLETE");
      expect(lines).toContain(`Closed ${app.store.load(firstId)!.name}.`);
    }
    const { app } = await builtWorkflow();
    const id = app.activeTaskId()!;
    await app.store.update(id, "old file", (task) => ({ ...task, phase: "PUBLISHED" }));
    expect((await app.plan(singleTaskRequest)).ok).toBe(true);
    expect(app.store.load(id)!.phase).toBe("COMPLETE");
    expect(app.activeTaskId()).not.toBe(id);
  });

  it("parks, rather than closes or revises, a task that still has unfinished tickets", async () => {
    const cwd = await tempRepo();
    const lines: string[] = [];
    const { app } = await ticketWorkflow([sampleTicket("01"), sampleTicket("02")], { config: testConfig(), startTurn: () => undefined, progress: (line) => void lines.push(line) }, { cwd });
    const id = app.activeTaskId()!;
    await app.store.update(id, "mid-build", (task) => ({ ...task, phase: "IMPLEMENTING" }));
    const before = app.store.load(id)!;
    expect((await app.startPlan(request)).ok).toBe(true);
    // The new task is active and the old one is exactly as it was.
    expect(app.activeTaskId()).not.toBe(id);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("PLANNING");
    expect(app.store.load(app.activeTaskId()!)!.request).toBe(request);
    expect(app.store.load(id)).toEqual(before);
    const parked = lines.find((line) => line.startsWith("Parked "))!;
    expect(parked).toBe(`Parked ${before.name} (Approved v1 · run /build). /plans ${before.name} switches back.`);
  });

  it("never replans another task: the same request twice makes two tasks, a literal plan too", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { startTurn: () => undefined });
    expect((await app.plan(singleTaskRequest)).ok).toBe(true);
    const first = app.activeTaskId()!;
    expect((await app.plan(singleTaskRequest)).ok).toBe(true);
    const second = app.activeTaskId()!;
    expect(second).not.toBe(first);
    expect(app.store.load(first)!.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect(app.store.load(first)!.name).not.toBe(app.store.load(second)!.name);
  });
});

describe("build and review robustness", () => {
  it("warns on a soft budget and refuses a hard one before the security prompt", async () => {
    const cwd = await tempRepo();
    const messages: string[] = [];
    let prompts = 0;
    const config = tieredConfig();
    config.budgets.taskUsd = 1;
    const app = workflow(cwd, { config, rng: () => 0.5, startTurn: () => undefined, notify: (message) => messages.push(message), confirm: async () => (prompts += 1, false) });
    await app.startPlan("change auth and permissions for the ingest parser production secrets");
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
    expect((await app.status()).text).toMatch(/### Warnings\n\n- 1 corrupt line|### Warnings[\s\S]*corrupt line/);
  });

  it("rejects a dependency cycle at plan time", async () => {
    const cyclic = `Loop\n\`\`\`tasks\n[{"id":"a","files":["x.ts"],"dependsOn":["b"]},{"id":"b","files":["y.ts"],"dependsOn":["a"]}]\n\`\`\``;
    const rejected = await workflow(await tempRepo()).plan(cyclic);
    expect(rejected.code).toBe("PLAN_CYCLE");
  });

  it("skips the /review re-run of a check that already passed on the same tree", async () => {
    const cwd = await tempRepo();
    let runs = 0;
    const { app } = await ticketWorkflow([sampleTicket("01")], { config: testConfig(), runner: checkRunner(async () => (runs += 1, { code: 0, stdout: "ok", stderr: "" })) }, { cwd });
    expect((await runBuild(() => app, writingDriver(cwd))).ok).toBe(true);
    expect(runs).toBe(1);
    // The build ran its check on a dirty tree; /review runs it once on the committed tree, and a second /review reuses that pass.
    expect((await app.review()).ok).toBe(true);
    const afterReview = runs;
    expect(afterReview).toBe(2);
    expect((await app.review()).ok).toBe(true);
    expect(runs).toBe(afterReview);
  });
});
