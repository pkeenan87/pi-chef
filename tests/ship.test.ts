import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ReviewReport } from "../src/domain.js";
import type { PullRequestSnapshot } from "../src/github/types.js";
import { runBuild } from "../src/orchestrator/build.js";
import type { Workflow } from "../src/orchestrator/service.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import { checkRunner, emptyPr, MemoryGitHub, sampleTicket, tempRepo, tieredConfig, ticketWorkflow, workflow, writingDriver } from "./helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

type Upsert = { branch: string; base: string; title: string; body: string };

class RecordingGitHub extends MemoryGitHub {
  upserts: Upsert[] = [];
  override async upsert(input: Upsert): Promise<PullRequestSnapshot> {
    this.upserts.push(input);
    return super.upsert(input);
  }
}

/** A repo on branch `base` whose `origin` is a local bare repository that already has `base`. */
async function repoWithOrigin(base = "main") {
  const cwd = await tempRepo();
  await git(cwd, "branch", "-m", base);
  const remote = mkdtempSync(path.join(tmpdir(), "pi-cost-remote-"));
  await git(remote, "init", "--bare");
  await git(cwd, "remote", "add", "origin", remote);
  await git(cwd, "push", "-u", "origin", base);
  await git(cwd, "remote", "set-head", "origin", base);
  return { cwd, remote };
}

async function setup(options: { base?: string; checks?: { code: number }; chat?: ChatFn; approve?: boolean; yaml?: string } = {}) {
  const { cwd, remote } = await repoWithOrigin(options.base);
  const github = new RecordingGitHub(emptyPr());
  const pushes: string[] = [];
  const asked: string[] = [];
  const progress: string[] = [];
  const reports: string[] = [];
  const flags = { confirm: options.approve ?? true, code: options.checks?.code ?? 0 };
  const app = workflow(cwd, {
    config: tieredConfig(options.yaml),
    github,
    chat: options.chat,
    runner: checkRunner(async () => (flags.code === 0 ? { code: 0, stdout: "ok", stderr: "" } : { code: flags.code, stdout: "", stderr: "FAIL injected" })),
    confirm: async (title, message) => (asked.push(`${title}: ${message}`), flags.confirm),
    push: async (branch) => {
      pushes.push(branch);
      await exec("git", ["push", "origin", branch], { cwd });
    },
    progress: (line) => void progress.push(line),
    report: (markdown) => void reports.push(markdown),
  });
  return { cwd, remote, github, pushes, asked, progress, reports, flags, app };
}

function write(cwd: string, name: string, body: string) {
  mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  writeFileSync(path.join(cwd, name), body);
}

async function branchWithCommit(cwd: string, branch = "fix/retry", file = "src/retry.ts") {
  await git(cwd, "switch", "-c", branch);
  write(cwd, file, "export const retry = 3;\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "Add retry");
}

function sessionReport(app: Workflow): ReviewReport {
  const dir = path.join(app.store.root, "reports");
  const file = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().at(-1)!;
  return JSON.parse(readFileSync(path.join(dir, file), "utf8")) as ReviewReport;
}

const ahead = async (cwd: string, base = "main") => Number(await git(cwd, "rev-list", "--count", `${base}..HEAD`));

describe("/ship with no task", () => {
  it("ships an ad-hoc branch: pushes it and opens a PR against the default branch", async () => {
    const t = await setup();
    await branchWithCommit(t.cwd);
    expect(t.app.activeTaskId()).toBeUndefined();
    const result = await t.app.ship();
    expect(result.ok, result.text).toBe(true);
    expect(t.asked).toEqual(["Ship: Push fix/retry and open or update the pull request against main?"]);
    expect(t.pushes).toEqual(["fix/retry"]);
    expect(await git(t.remote, "branch", "--list", "fix/retry")).toContain("fix/retry");
    expect(t.github.upserts).toHaveLength(1);
    expect(t.github.upserts[0]).toMatchObject({ branch: "fix/retry", base: "main", title: "Add retry" });
    expect(t.github.upserts[0]!.body).toContain("Not merged; merge stays manual.");
    expect(t.github.upserts[0]!.body).toContain("unit (npm test): pass");
    // No task: the report is a session report, and the ledger charges "session".
    expect(sessionReport(t.app).passed).toBe(true);
    expect(t.reports.at(-1)).toContain("## Review passed");
    expect(t.progress.some((line) => /^Review: started · fix\/retry against main/.test(line))).toBe(true);
    expect(t.progress.some((line) => /^Review: unit: passed in 0\.0s$/.test(line))).toBe(true);
  });

  it("puts uncommitted edits and untracked files in the diff, and commits them after a pass", async () => {
    const t = await setup();
    await branchWithCommit(t.cwd);
    write(t.cwd, "README.md", "base\nedited\n");
    write(t.cwd, "src/new-file.ts", "export const fresh = true;\n");
    // Workflow state that is neither tracked nor ignored stays out of the ship commit.
    write(t.cwd, ".pi-workflows/stray.json", "{}\n");
    const result = await t.app.ship();
    expect(result.ok, result.text).toBe(true);
    const diff = sessionReport(t.app).diff!;
    expect(diff).toContain("+edited");
    expect(diff).toContain("src/new-file.ts");
    expect(diff).toContain("+export const fresh = true;");
    expect(diff).toContain("src/retry.ts");
    expect(await git(t.cwd, "status", "--porcelain", "--", ".", ":(exclude).pi-workflows")).toBe("");
    expect(await git(t.cwd, "log", "--format=%s", "-1")).toBe("Ship: changes");
    expect(await git(t.cwd, "log", "--format=%B", "-1")).not.toContain("Co-Authored");
    expect(await git(t.cwd, "show", "--name-only", "--format=", "HEAD")).toBe("README.md\nsrc/new-file.ts");
    expect(await git(t.remote, "rev-parse", "fix/retry")).toBe(await git(t.cwd, "rev-parse", "HEAD"));
    // The title comes from the first commit on the branch.
    expect(t.github.upserts[0]!.title).toBe("Add retry");
  });

  it("creates a branch when only uncommitted changes sit on the base branch", async () => {
    const t = await setup();
    write(t.cwd, "src/quick-fix.ts", "export const fix = 1;\n");
    const result = await t.app.ship();
    expect(result.ok, result.text).toBe(true);
    expect(await git(t.cwd, "branch", "--show-current")).toBe("cost/ship-20261014-120000");
    expect(t.pushes).toEqual(["cost/ship-20261014-120000"]);
    expect(t.github.upserts[0]).toMatchObject({ branch: "cost/ship-20261014-120000", base: "main", title: "Ship: changes" });
    expect(await git(t.cwd, "rev-parse", "main")).toBe(await git(t.cwd, "rev-parse", "origin/main"));
  });

  it("refuses commits ahead on the base branch and says how to move them", async () => {
    const t = await setup();
    write(t.cwd, "src/oops.ts", "export const oops = 1;\n");
    await git(t.cwd, "add", ".");
    await git(t.cwd, "commit", "-m", "Committed on main");
    const result = await t.app.ship();
    expect(result).toMatchObject({ ok: false, code: "ON_BASE_BRANCH" });
    expect(result.text).toContain("git switch -c <name>");
    expect(result.text).toContain("git branch -f main origin/main");
    expect(t.pushes).toEqual([]);
    expect(await git(t.cwd, "branch", "--show-current")).toBe("main");
  });

  it("has nothing to ship on a clean base branch, or a branch with no changes", async () => {
    const t = await setup();
    expect(await t.app.ship()).toMatchObject({ ok: false, code: "NOTHING_TO_SHIP" });
    await git(t.cwd, "switch", "-c", "empty-branch");
    expect(await t.app.ship()).toMatchObject({ ok: false, code: "NOTHING_TO_SHIP" });
    expect(t.pushes).toEqual([]);
  });

  it("refuses a detached HEAD", async () => {
    const t = await setup();
    await git(t.cwd, "checkout", "--detach");
    expect(await t.app.ship()).toMatchObject({ ok: false, code: "GIT_NOT_READY" });
  });

  it("commits and pushes nothing when a check fails", async () => {
    const t = await setup({ checks: { code: 1 } });
    await branchWithCommit(t.cwd);
    write(t.cwd, "src/wip.ts", "export const wip = 1;\n");
    const head = await git(t.cwd, "rev-parse", "HEAD");
    const result = await t.app.ship();
    expect(result).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
    expect(result.text).toContain("Fix in chat, then /ship again.");
    expect(t.reports.at(-1)).toContain("## Review did not pass");
    expect(t.asked).toEqual([]);
    expect(t.pushes).toEqual([]);
    expect(t.github.upserts).toEqual([]);
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(await git(t.cwd, "status", "--porcelain")).toContain("src/wip.ts");
  });

  it("does not push when the confirmation is declined", async () => {
    const t = await setup({ approve: false });
    await branchWithCommit(t.cwd);
    write(t.cwd, "src/wip.ts", "export const wip = 1;\n");
    const result = await t.app.ship();
    expect(result).toMatchObject({ ok: false, code: "NOT_SHIPPED" });
    expect(t.pushes).toEqual([]);
    expect(t.github.upserts).toEqual([]);
    expect(await git(t.cwd, "status", "--porcelain")).toContain("src/wip.ts");
  });

  it("lists the model review's findings but never lets them change the verdict", async () => {
    const findings = JSON.stringify([{ severity: "high", category: "correctness", file: "src/retry.ts", message: "retry never backs off." }]);
    const chat: ChatFn = async (candidate) => ({ text: findings, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 }, provider: candidate.provider, model: candidate.model });
    const t = await setup({ chat });
    await branchWithCommit(t.cwd);
    const result = await t.app.ship();
    expect(result.ok, result.text).toBe(true);
    const report = sessionReport(t.app);
    expect(report.passed).toBe(true);
    expect(report.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(report.modelReview?.findings).toHaveLength(1);
    expect(t.reports.at(-1)).toContain("- HIGH   src/retry.ts — retry never backs off.");
    expect(t.github.upserts[0]!.body).toContain("Model review findings: 1 (advisory)");
    expect(t.app.store.readLedger().find((entry) => entry.reason === "model review")).toMatchObject({ taskId: "session", phase: "REVIEWING" });
  });

  it("opens one PR and updates it on the next /ship", async () => {
    const t = await setup();
    await branchWithCommit(t.cwd);
    expect((await t.app.ship()).ok).toBe(true);
    write(t.cwd, "src/more.ts", "export const more = 1;\n");
    const second = await t.app.ship();
    expect(second.ok, second.text).toBe(true);
    expect(t.github.upserts.map((item) => [item.branch, item.base])).toEqual([["fix/retry", "main"], ["fix/retry", "main"]]);
    expect(t.github.pr.number).toBe(7);
    expect(await git(t.remote, "rev-parse", "fix/retry")).toBe(await git(t.cwd, "rev-parse", "HEAD"));
  });
});

describe("/ship after /build", () => {
  async function built(options: { base?: string; yaml?: string; mutate?: (config: ReturnType<typeof tieredConfig>) => void; tickets?: ReturnType<typeof sampleTicket>[] } = {}) {
    const { cwd, remote } = await repoWithOrigin(options.base ?? "trunk");
    const github = new RecordingGitHub(emptyPr());
    const pushes: string[] = [];
    const config = tieredConfig(options.yaml);
    options.mutate?.(config);
    const { app, taskId } = await ticketWorkflow(options.tickets ?? [sampleTicket("01"), sampleTicket("02", { blockedBy: ["01"] })], {
      config,
      github,
      push: async (branch) => {
        pushes.push(branch);
        await exec("git", ["push", "origin", branch], { cwd });
      },
    }, { cwd });
    const built = await runBuild(() => app, writingDriver(cwd));
    expect(built.ok, built.text).toBe(true);
    return { cwd, remote, github, pushes, app, taskId };
  }

  it("uses the build's base for the PR, stores the PR, and moves the task to PUBLISHED", async () => {
    const t = await built();
    const state = t.app.store.load(t.taskId)!;
    expect(state.build!.base).toBe("trunk");
    expect(state.phase).toBe("IMPLEMENTING");
    const result = await t.app.ship();
    expect(result.ok, result.text).toBe(true);
    expect(t.github.upserts).toHaveLength(1);
    expect(t.github.upserts[0]).toMatchObject({ branch: `cost/${t.taskId}`, base: "trunk", title: "Retry failed ingests." });
    const body = t.github.upserts[0]!.body;
    expect(body).toContain("## Tickets");
    expect(body).toContain("- 01 Ticket 01: done");
    expect(body).toContain("- 02 Ticket 02: done");
    const after = t.app.store.load(t.taskId)!;
    expect(after.phase).toBe("PUBLISHED");
    expect(after.pullRequest).toMatchObject({ number: 7, branch: `cost/${t.taskId}`, base: "trunk" });
    expect(after.review?.passed).toBe(true);
    const dir = t.app.store.taskDir(t.taskId);
    expect(existsSync(path.join(dir, "reports", "ship.json"))).toBe(true);
    expect(readFileSync(path.join(dir, "reports", "ship.md"), "utf8")).toContain("## Review passed");
  });

  it("re-reviews and updates the same PR from PUBLISHED, and /build can continue from there", async () => {
    const t = await built();
    expect((await t.app.ship()).ok).toBe(true);
    write(t.cwd, "src/hotfix.ts", "export const hotfix = 1;\n");
    const again = await t.app.ship();
    expect(again.ok, again.text).toBe(true);
    expect(t.github.upserts.map((item) => item.branch)).toEqual([`cost/${t.taskId}`, `cost/${t.taskId}`]);
    const state = t.app.store.load(t.taskId)!;
    expect(state.phase).toBe("PUBLISHED");
    expect(state.pullRequest!.number).toBe(7);
    expect(await git(t.cwd, "status", "--porcelain")).toBe("");
    // More tickets on the same PR: PUBLISHED is a valid start for /build.
    expect((await t.app.startBuild()).ok).toBe(true);
    expect(t.app.store.load(t.taskId)!.phase).toBe("IMPLEMENTING");
  });

  it("falls back to the tickets' checks when the config has none, and cannot pass with no checks at all", async () => {
    const withChecks = await built({
      mutate: (config) => void (config.checks = []),
      tickets: [sampleTicket("01", { checks: ["npm run typecheck"] }), sampleTicket("02", { blockedBy: ["01"], checks: ["npm run typecheck", "npm test"] })],
    });
    const result = await withChecks.app.ship();
    expect(result.ok, result.text).toBe(true);
    const report = withChecks.app.store.load(withChecks.taskId)!.review!;
    expect(report.checks.map((check) => check.name).sort()).toEqual(["npm run typecheck", "npm test"]);
    expect(report.summary).toContain("Review passed with 2 check(s)");

    const bare = await built({ mutate: (config) => void (config.checks = []) });
    const failed = await bare.app.ship();
    expect(failed).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
    expect(failed.text).toContain("no checks ran");
    expect(bare.pushes).toEqual([]);
    expect(bare.app.store.load(bare.taskId)!.phase).toBe("IMPLEMENTING");
  });
});
