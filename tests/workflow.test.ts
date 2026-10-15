import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Workflow, type GroupExecutor } from "../src/orchestrator/service.js";
import { GitWorkspace } from "../src/git/worktrees.js";
import { WorkflowError } from "../src/domain.js";
import { runBuild } from "../src/orchestrator/build.js";
import { checkRunner, emptyPr, fakeTimer, MemoryGitHub, publishedWorkflow, readyAuth, sampleTicket, singleTaskRequest, tasksRequest, tempRepo, testConfig, ticketWorkflow, workflow, writingDriver } from "./helpers.js";
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
  it("refuses implementation before approval, then runs two worktrees and survives a restart", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    const planned = await app.plan(tasksRequest);
    expect(planned.ok).toBe(true);
    const refused = await app.implement();
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("APPROVAL_REQUIRED");
    expect(refused.text).toMatch(/draft/);
    const approved = await app.approveDraft();
    expect(approved.ok).toBe(true);
    expect(approved.text).toContain("Run /build");
    const frozen = path.join(cwd, ".pi-workflows", "tasks");
    const taskDir = readdirSync(frozen)[0]!;
    const approvedFile = path.join(frozen, taskDir, "plan.v1.approved.json");
    const first = readFileSync(approvedFile, "utf8");
    expect((await app.approveDraft()).text).toMatch(/already approved/);
    expect(readFileSync(approvedFile, "utf8")).toBe(first);

    const implemented = await app.implement();
    expect(implemented.ok).toBe(true);
    expect(implemented.text).toContain("2 worktree");
    rmSync(path.join(frozen, taskDir, "state.json"));
    const restarted = new Workflow({ cwd, config: testConfig(), auth: readyAuth(), now: () => new Date("2026-10-14T12:00:00.000Z"), confirm: async () => true, runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })), push: async () => undefined });
    const status = await restarted.status();
    expect(status.text).toContain("IMPLEMENTING");
    expect(status.text).toMatch(/ingest@[0-9a-f]{7}/);
    expect(status.text).toMatch(/alert@[0-9a-f]{7}/);
  });

  it("keeps secrets out of artifacts and pauses when account login is expired", async () => {
    const cwd = await tempRepo();
    const secret = "sk-live-SECRETVALUE123456";
    const app = workflow(cwd);
    await app.plan(`Rotate the ${secret} in Neo`);
    const root = path.join(cwd, ".pi-workflows");
    const blob = walk(root).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(blob).not.toContain(secret);
    expect(blob).toContain("[REDACTED]");

    const expired = workflow(cwd, {
      auth: { async inspect(provider) { return { provider, status: "expired", method: "oauth", detail: "Account session expired." }; } },
    });
    await expired.plan("Add a retry counter to the Neo ingest parser");
    await expired.approveDraft();
    const result = await expired.implement();
    expect(result.code).toBe("AUTH_EXPIRED");
    const status = await expired.status();
    expect(status.text).toContain("PAUSED");
  });

  it("reviews a failing check, gates the push, and stops autopilot at merge-ready", async () => {
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
    const polls: number[] = [];
    let cancelled = 0;
    const pushed: string[] = [];
    const { app: publisher } = await ticketWorkflow([sampleTicket("01")], {
      config: testConfig(),
      runner: checkRunner(async () => (flags.checksPass ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "FAIL injected test" })),
      github,
      confirm: async () => flags.confirm,
      push: async (branch) => void pushed.push(branch),
      fixer: async () => ({ verified: true, evidence: "npm test exit 0", summary: "fix comment", edits: [] }),
      schedule: (delayMs) => {
        polls.push(delayMs);
        return () => {
          cancelled += 1;
        };
      },
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
    github.pr = {
      ...github.pr,
      headSha: github.pr.headSha || "aaa",
      threads: [{ id: "t1", body: "null pointer in src/ingest.ts", path: "src/ingest.ts", sha: github.pr.headSha }],
      checks: [{ id: "ci", name: "ci", status: "completed", conclusion: "failure", sha: github.pr.headSha, summary: "FAIL injected" }],
    };
    const watched = await publisher.autopilot();
    expect(watched.ok).toBe(true);
    expect(github.replies).toHaveLength(1);
    expect(polls).toEqual([30_000]);
    const again = await publisher.autopilot();
    expect(github.replies).toHaveLength(1);
    expect(polls).toEqual([30_000, 90_000]);
    github.pr = {
      ...github.pr,
      approved: true,
      protectionSatisfied: true,
      mergeable: true,
      threads: [],
      checks: [{ id: "ci2", name: "ci", status: "completed", conclusion: "success", sha: github.pr.headSha }],
    };
    const ready = await publisher.autopilot();
    expect(ready.ok).toBe(true);
    expect(ready.text).toContain("Not merged");
    expect(github.merged).toBe(false);
    const status = await publisher.status();
    expect(status.text).toContain("MERGE_READY");
    // MERGE_READY keeps a slow poll (10x the 90s interval) to notice the merge.
    expect(polls).toEqual([30_000, 90_000, 900_000]);
    expect(cancelled).toBe(2);
  });

  it("escalates a failed check with a tier-aware executor and records an unknown charge as null", async () => {
    const cwd = await tempRepo();
    let attempts = 0;
    const tiers: string[] = [];
    const executor: GroupExecutor = async ({ tier, write }) => {
      tiers.push(tier);
      write("README.md", "base\nfixed\n");
      return {};
    };
    const app = workflow(cwd, {
      executors: { deterministic: executor, classifier: executor, cheap: executor, standard: executor, premium: executor },
      runner: checkRunner(async () => {
        attempts += 1;
        return attempts === 1 ? { code: 1, stdout: "", stderr: "fail once" } : { code: 0, stdout: "ok", stderr: "" };
      }),
    });
    await app.plan(readmePlan);
    await app.approveDraft();
    const result = await app.implement();
    expect(result.ok).toBe(true);
    expect(attempts).toBeGreaterThan(1);
    expect(new Set(tiers).size).toBeGreaterThan(1);
    const cost = await app.cost("json");
    const records = (cost.data as { records: { actualUsd: number | null; usageKnown: boolean; retries: number }[] }).records;
    expect(records.some((record) => record.usageKnown === false && record.actualUsd === null)).toBe(true);
  });

  it("does not escalate when the next tier would repeat the same literal edits", async () => {
    const cwd = await tempRepo();
    let attempts = 0;
    const app = workflow(cwd, {
      runner: checkRunner(async () => {
        attempts += 1;
        return { code: 1, stdout: "", stderr: "always fails" };
      }),
    });
    await app.plan(readmePlan);
    await app.approveDraft();
    const result = await app.implement();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("FAILED");
    expect(result.text).toMatch(/identical deterministic work/);
    expect(attempts).toBe(1);
    expect((await app.status()).text).toContain("FAILED");
    const records = ((await app.cost("json")).data as { records: { actualUsd: number | null; usageKnown: boolean }[] }).records;
    expect(records.filter((record) => record.actualUsd === 0 && record.usageKnown).length).toBeGreaterThan(0);
  });

  it("pauses a security-sensitive plan until a person confirms", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { confirm: async () => false });
    await app.plan("change auth and permissions for Neo production secrets");
    await app.approveDraft();
    const result = await app.implement();
    expect(result.code).toBe("SECURITY_PAUSE");
    expect((await app.status()).text).toContain("PAUSED");
  });
});

const readmePlan = "rename a typo in README.md\n```tasks\n[{\"id\":\"docs\",\"files\":[\"README.md\"],\"edits\":[{\"path\":\"README.md\",\"content\":\"base\\nfixed\\n\"}]}]\n```";

class FlakyGitHub extends MemoryGitHub {
  calls = 0;
  failures = 0;
  tooLarge = false;
  gone = false;
  mergedPr = false;
  gate?: Promise<void>;
  async findByBranch(): Promise<PullRequestSnapshot | undefined> {
    this.calls += 1;
    await this.gate;
    if (this.tooLarge) throw new WorkflowError("GH_TOO_LARGE", "PR has more than 100 review threads.");
    if (this.failures > 0) {
      this.failures -= 1;
      throw new WorkflowError("GH_TRANSIENT", "gh is down");
    }
    return this.gone ? undefined : this.pr;
  }
  async wasMerged(): Promise<boolean> {
    return this.mergedPr;
  }
}

describe("autopilot watcher lifecycle", () => {
  it("stop cancels the timer and a late timer callback does nothing", async () => {
    const timer = fakeTimer();
    const github = new FlakyGitHub(emptyPr());
    const { app } = await publishedWorkflow({ schedule: timer.schedule }, github);
    expect((await app.autopilot()).ok).toBe(true);
    expect(timer.state.delays).toEqual([90_000]);
    const late = timer.state.pending!;
    const callsBefore = github.calls;
    expect((await app.autopilot("stop")).ok).toBe(true);
    expect(timer.state.cancelled).toBe(1);
    late();
    await new Promise((resolve) => setImmediate(resolve));
    expect(github.calls).toBe(callsBefore);
    expect(timer.state.delays).toEqual([90_000]);
    expect((await app.autopilot("status")).text).toContain('"running": false');
  });

  it("a poll that fires re-arms, and refuses to overlap a manual run", async () => {
    const timer = fakeTimer();
    const github = new FlakyGitHub(emptyPr());
    const { app } = await publishedWorkflow({ schedule: timer.schedule }, github);
    await app.autopilot();
    timer.state.pending!();
    await vi.waitFor(() => expect(timer.state.delays).toHaveLength(2));
    let release!: () => void;
    github.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = app.autopilot();
    const second = await app.autopilot();
    expect(second.code).toBe("BUSY");
    release();
    expect((await first).ok).toBe(true);
  });

  it("re-arms with backoff after a transient gh failure and clears the counter on success", async () => {
    const timer = fakeTimer();
    const github = new FlakyGitHub(emptyPr());
    const { app } = await publishedWorkflow({ schedule: timer.schedule }, github);
    github.failures = 2;
    const first = await app.autopilot();
    expect(first.code).toBe("GH_TRANSIENT");
    expect(timer.state.delays).toEqual([30_000]);
    timer.state.pending!();
    await vi.waitFor(() => expect(timer.state.delays).toEqual([30_000, 60_000]));
    const mid = (await app.status()).data as { state: { autopilot: { attempts: Record<string, number>; running: boolean } } };
    expect(mid.state.autopilot.running).toBe(true);
    expect(mid.state.autopilot.attempts["gh:transient"]).toBe(2);
    timer.state.pending!();
    await vi.waitFor(() => expect(timer.state.delays).toHaveLength(3));
    const after = (await app.status()).data as { state: { autopilot: { attempts: Record<string, number> } } };
    expect(after.state.autopilot.attempts["gh:transient"]).toBeUndefined();
  });

  it("pauses (does not die silently) when the PR is too large", async () => {
    const timer = fakeTimer();
    const github = new FlakyGitHub(emptyPr());
    const { app } = await publishedWorkflow({ schedule: timer.schedule }, github);
    github.tooLarge = true;
    const result = await app.autopilot();
    expect(result.code).toBe("GH_TOO_LARGE");
    expect(timer.state.delays).toEqual([]);
    expect((await app.status()).text).toContain("PAUSED");
  });

  it("completes the task when the PR was merged, and a new task can start", async () => {
    const github = new FlakyGitHub(emptyPr());
    const { app } = await publishedWorkflow({ schedule: fakeTimer().schedule }, github);
    const firstId = app.activeTaskId();
    github.gone = true;
    github.mergedPr = true;
    const merged = await app.autopilot();
    expect(merged.ok).toBe(true);
    expect((await app.status()).text).toContain("COMPLETE");
    const next = await app.plan("Add a retry counter to the Neo ingest parser");
    expect(next.ok).toBe(true);
    expect(app.activeTaskId()).not.toBe(firstId);
  });

  it("/complete finishes a published task, and plan replaces one only with confirmation", async () => {
    const { app, cwd } = await publishedWorkflow();
    const firstId = app.activeTaskId();
    const denied = workflow(cwd, { confirm: async () => false });
    expect((await denied.plan("Add a retry counter to the Neo ingest parser")).code).toBe("TASK_ACTIVE");
    expect(denied.activeTaskId()).toBe(firstId);
    const replaced = await app.plan("Add a retry counter to the Neo ingest parser");
    expect(replaced.ok).toBe(true);
    expect(app.activeTaskId()).not.toBe(firstId);
    const stale = await app.complete();
    expect(stale.code).toBe("ILLEGAL_TRANSITION");

    const second = await publishedWorkflow();
    const completed = await second.app.complete();
    expect(completed.ok).toBe(true);
    expect((await second.app.status()).text).toContain("COMPLETE");
    expect((await second.app.plan("Another change to Neo")).ok).toBe(true);
  });
});

describe("implementation robustness", () => {
  it("lets a BLOCKED task retry after the cause is fixed", async () => {
    const cwd = await tempRepo();
    const blocked = workflow(cwd, { auth: readyAuth("missing") });
    await blocked.plan(singleTaskRequest);
    await blocked.approveDraft();
    const first = await blocked.implement();
    expect(first.code).toBe("AUTH_MISSING");
    expect((await blocked.status()).text).toContain("BLOCKED");
    const second = await workflow(cwd).implement();
    expect(second.ok).toBe(true);
  });

  it("moves the task to FAILED when implementation throws", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    git.createWorktree = async () => {
      throw new Error("disk exploded");
    };
    const app = workflow(cwd, { git });
    await app.plan(singleTaskRequest);
    await app.approveDraft();
    const result = await app.implement();
    expect(result.ok).toBe(false);
    expect(result.text).toContain("disk exploded");
    const status = await app.status();
    expect(status.text).toContain("FAILED");
    expect(status.text).toContain("disk exploded");
  });

  it("stops escalating when the budget runs out mid-loop", async () => {
    const cwd = await tempRepo();
    let calls = 0;
    let app!: Workflow;
    const executor: GroupExecutor = async ({ write }) => {
      calls += 1;
      write("README.md", "base\nfixed\n");
      app.store.appendLedger({
        id: "spend", at: "2026-10-14T12:00:00.000Z", taskId: app.activeTaskId()!, phase: "IMPLEMENTING", provider: "openai", model: "gpt-5.4", tier: "premium",
        requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd: 999, usageKnown: true, outcome: "success", retries: 0, reason: "test",
      });
      return { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } };
    };
    app = workflow(cwd, {
      executors: { deterministic: executor, classifier: executor, cheap: executor, standard: executor, premium: executor },
      runner: checkRunner(async () => ({ code: 1, stdout: "", stderr: "nope" })),
    });
    await app.plan(readmePlan);
    await app.approveDraft();
    const result = await app.implement();
    expect(result.code).toBe("BUDGET");
    expect(calls).toBe(1);
    expect((await app.status()).text).toContain("BLOCKED");
  });

  it("warns on a soft budget and refuses a hard one before the security prompt", async () => {
    const cwd = await tempRepo();
    const messages: string[] = [];
    let prompts = 0;
    const config = testConfig();
    config.budgets.taskUsd = 1;
    const app = workflow(cwd, { config, notify: (message) => messages.push(message), confirm: async () => (prompts += 1, true) });
    await app.plan("change auth and permissions for Neo production secrets");
    await app.approveDraft();
    const id = app.activeTaskId()!;
    const spend = (actualUsd: number) =>
      app.store.appendLedger({
        id: `s${actualUsd}`, at: "2026-10-14T12:00:00.000Z", taskId: id, phase: "IMPLEMENTING", provider: "openai", model: "gpt-5.4", tier: "premium",
        requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd, usageKnown: true, outcome: "success", retries: 0, reason: "test",
      });
    spend(0.9);
    await app.implement();
    expect(messages.some((message) => /Budget warning/.test(message))).toBe(true);
    spend(0.5);
    prompts = 0;
    const hard = await app.implement();
    expect(hard.code).toBe("BUDGET");
    expect(prompts).toBe(0);
  });

  it("keeps a worktree in state when git cannot remove it", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    git.removeWorktree = async () => ({ ok: false, worktreeRemoved: false, branchDeleted: false, error: "worktree is locked" });
    const app = workflow(cwd, { git });
    await app.plan(singleTaskRequest);
    await app.approveDraft();
    expect((await app.implement()).ok).toBe(true);
    const result = await app.worktrees("cleanup", true);
    expect(result.code).toBe("CLEANUP_FAILED");
    expect(result.text).toContain("worktree is locked");
    const state = (await app.status()).data as { state: { worktrees: unknown[] } };
    expect(state.state.worktrees).toHaveLength(1);
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

  it("merges every dependency of a group and rejects cycles at plan time", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    const edit = (file: string) => `{"path":"${file}","content":"export const x = 1;\\n"}`;
    const request = `Join\n\`\`\`tasks\n[
      {"id":"a","files":["src/a.ts"],"edits":[${edit("src/a.ts")}]},
      {"id":"b","files":["src/b.ts"],"edits":[${edit("src/b.ts")}]},
      {"id":"c","files":["src/c.ts"],"dependsOn":["a","b"],"edits":[${edit("src/c.ts")}]}
    ]\n\`\`\``;
    expect((await app.plan(request)).ok).toBe(true);
    await app.approveDraft();
    expect((await app.implement()).ok).toBe(true);
    const state = (await app.status()).data as { state: { worktrees: { groupId: string; path: string }[] } };
    const c = state.state.worktrees.find((item) => item.groupId === "c")!;
    expect(existsSync(path.join(c.path, "src", "a.ts"))).toBe(true);
    expect(existsSync(path.join(c.path, "src", "b.ts"))).toBe(true);

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
