import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workflow } from "../src/orchestrator/service.js";
import { checkRunner, MemoryGitHub, readyAuth, tasksRequest, tempRepo, testConfig, workflow } from "./helpers.js";
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
    const approved = await app.approvePlan();
    expect(approved.ok).toBe(true);
    expect(approved.text).toContain("new-session");
    const frozen = path.join(cwd, ".pi-workflows", "tasks");
    const taskDir = readdirSync(frozen)[0]!;
    const approvedFile = path.join(frozen, taskDir, "plan.v1.approved.json");
    const first = readFileSync(approvedFile, "utf8");
    expect((await app.approvePlan()).text).toMatch(/already approved/);
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
    await expired.approvePlan();
    const result = await expired.implement();
    expect(result.code).toBe("AUTH_EXPIRED");
    const status = await expired.status();
    expect(status.text).toContain("PAUSED");
  });

  it("reviews a failing integration check, gates push, and stops autopilot at merge-ready", async () => {
    const cwd = await tempRepo();
    const calls: string[] = [];
    const app = workflow(cwd, {
      runner: checkRunner(async (_command, _args, worktree) => {
        calls.push(worktree);
        if (worktree.endsWith(`${path.sep}integration`)) return { code: 1, stdout: "", stderr: "FAIL injected test" };
        return { code: 0, stdout: "ok", stderr: "" };
      }),
    });
    await app.plan(tasksRequest);
    await app.approvePlan();
    expect((await app.implement()).ok).toBe(true);
    const review = await app.review();
    expect(review.ok).toBe(false);
    expect(review.text).toMatch(/blocking/);
    expect(JSON.stringify(review.data)).toContain("FAIL injected");
    const pushed = await app.push();
    expect(pushed.ok).toBe(false);

    const passing = workflow(cwd, {
      runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })),
      confirm: async () => false,
    });
    expect((await passing.implement()).ok).toBe(true);
    expect((await passing.review()).ok).toBe(true);
    const denied = await passing.push();
    expect(denied.code).toBe("APPROVAL_REQUIRED");

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
    const publisher = workflow(cwd, {
      runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })),
      github,
      confirm: async () => true,
      fixer: async () => ({ verified: true, evidence: "npm test exit 0", summary: "fix comment", edits: [] }),
      schedule: (delayMs) => {
        polls.push(delayMs);
        return () => {
          cancelled += 1;
        };
      },
    });
    const published = await publisher.push();
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
    expect(polls).toEqual([30_000, 90_000]);
    expect(cancelled).toBe(2);
  });

  it("escalates a failed check and records an unknown charge as null", async () => {
    const cwd = await tempRepo();
    let attempts = 0;
    const app = workflow(cwd, {
      runner: checkRunner(async () => {
        attempts += 1;
        return attempts === 1 ? { code: 1, stdout: "", stderr: "fail once" } : { code: 0, stdout: "ok", stderr: "" };
      }),
    });
    await app.plan("rename a typo in README.md\n```tasks\n[{\"id\":\"docs\",\"files\":[\"README.md\"],\"edits\":[{\"path\":\"README.md\",\"content\":\"base\\nfixed\\n\"}]}]\n```");
    await app.approvePlan();
    const result = await app.implement();
    expect(result.ok).toBe(true);
    expect(attempts).toBeGreaterThan(1);
    const cost = await app.cost("json");
    const records = (cost.data as { records: { actualUsd: number | null; usageKnown: boolean; retries: number }[] }).records;
    expect(records.some((record) => record.usageKnown === false && record.actualUsd === null)).toBe(true);
  });

  it("pauses a security-sensitive plan until a person confirms", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { confirm: async () => false });
    await app.plan("change auth and permissions for Neo production secrets");
    await app.approvePlan();
    const result = await app.implement();
    expect(result.code).toBe("SECURITY_PAUSE");
    expect((await app.status()).text).toContain("PAUSED");
  });
});
