import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ReviewReport } from "../src/domain.js";
import { runBuild } from "../src/orchestrator/build.js";
import type { PlanReviewRequest } from "../src/orchestrator/types.js";
import type { Workflow } from "../src/orchestrator/service.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import { checkRunner, sampleTicket, tempRepo, tieredConfig, ticketWorkflow, workflow, writingDriver } from "./helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

/** A repo on branch `base` whose `origin` is a local bare repository that already has `base`. */
async function repoWithOrigin(base = "main") {
  const cwd = await tempRepo();
  await git(cwd, "branch", "-m", base);
  const remote = mkdtempSync(path.join(tmpdir(), "pi-chef-remote-"));
  await git(remote, "init", "--bare");
  await git(cwd, "remote", "add", "origin", remote);
  await git(cwd, "push", "-u", "origin", base);
  await git(cwd, "remote", "set-head", "origin", base);
  return { cwd, remote };
}

type Choice = { value: string; text?: string } | undefined;

async function setup(options: { base?: string; checks?: { code: number }; chat?: ChatFn; ui?: boolean; choice?: Choice; yaml?: string } = {}) {
  const { cwd, remote } = await repoWithOrigin(options.base);
  const progress: string[] = [];
  const reports: string[] = [];
  const turns: string[] = [];
  const dialogs: PlanReviewRequest[] = [];
  const code = options.checks?.code ?? 0;
  const app = workflow(cwd, {
    config: tieredConfig(options.yaml),
    chat: options.chat,
    runner: checkRunner(async () => (code === 0 ? { code: 0, stdout: "ok", stderr: "" } : { code, stdout: "", stderr: "FAIL injected" })),
    progress: (line) => void progress.push(line),
    report: (markdown) => void reports.push(markdown),
    startTurn: (text) => void turns.push(text),
  });
  if (options.ui !== false) app.bind({ review: async (request: PlanReviewRequest) => (dialogs.push(request), options.choice ?? { value: "close" }) });
  return { cwd, remote, progress, reports, turns, dialogs, app };
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

const modelChat = (findings: unknown[]): ChatFn => async (candidate) => ({
  text: JSON.stringify(findings),
  usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 },
  provider: candidate.provider,
  model: candidate.model,
});

describe("/review with no task", () => {
  it("reviews an ad-hoc branch against the default branch and saves a session report", async () => {
    const t = await setup();
    await branchWithCommit(t.cwd);
    expect(t.app.activeTaskId()).toBeUndefined();
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toBe("Review passed: 1 check(s), no findings.");
    expect(sessionReport(t.app).passed).toBe(true);
    expect(t.reports.at(-1)).toContain("## Review passed");
    expect(t.reports.at(-1)).toContain(".pi-workflows/reports/review-");
    expect(t.progress.some((line) => /^Review: started · fix\/retry against main/.test(line))).toBe(true);
    expect(t.progress.some((line) => /^Review: unit: passed in 0\.0s$/.test(line))).toBe(true);
    expect(t.dialogs).toEqual([]);
  });

  it("puts uncommitted edits and untracked files in the diff, and commits nothing", async () => {
    const t = await setup();
    await branchWithCommit(t.cwd);
    write(t.cwd, "README.md", "base\nedited\n");
    write(t.cwd, "src/new-file.ts", "export const fresh = true;\n");
    const head = await git(t.cwd, "rev-parse", "HEAD");
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    const diff = sessionReport(t.app).diff!;
    expect(diff).toContain("+edited");
    expect(diff).toContain("src/new-file.ts");
    expect(diff).toContain("+export const fresh = true;");
    expect(diff).toContain("src/retry.ts");
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(await git(t.cwd, "branch", "--show-current")).toBe("fix/retry");
    expect(await git(t.cwd, "status", "--porcelain")).toContain("src/new-file.ts");
  });

  it("reviews only the uncommitted changes on the base branch, without creating a branch", async () => {
    const t = await setup();
    write(t.cwd, "src/quick-fix.ts", "export const fix = 1;\n");
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    expect(await git(t.cwd, "branch", "--show-current")).toBe("main");
    expect(sessionReport(t.app).diff).toContain("src/quick-fix.ts");
  });

  it("on the base branch also reviews local commits origin does not have", async () => {
    const t = await setup();
    write(t.cwd, "src/oops.ts", "export const oops = 1;\n");
    await git(t.cwd, "add", ".");
    await git(t.cwd, "commit", "-m", "Committed on main");
    write(t.cwd, "src/wip.ts", "export const wip = 1;\n");
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    const diff = sessionReport(t.app).diff!;
    expect(diff).toContain("src/oops.ts");
    expect(diff).toContain("src/wip.ts");
  });

  it("has nothing to review on a clean base branch or a branch with no changes", async () => {
    const t = await setup();
    expect(await t.app.review()).toMatchObject({ ok: true, text: "Nothing to review: no changes against main." });
    await git(t.cwd, "switch", "-c", "empty-branch");
    expect((await t.app.review()).text).toBe("Nothing to review: no changes against main.");
    expect(t.reports).toEqual([]);
    expect(existsSync(path.join(t.app.store.root, "reports"))).toBe(false);
  });

  it("fails a check with a numbered finding that names the command, and leaves the tree alone", async () => {
    const t = await setup({ checks: { code: 1 } });
    await branchWithCommit(t.cwd);
    write(t.cwd, "src/wip.ts", "export const wip = 1;\n");
    const head = await git(t.cwd, "rev-parse", "HEAD");
    const result = await t.app.review();
    expect(result).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
    expect(result.text).toContain("/review again");
    expect(sessionReport(t.app).passed).toBe(false);
    expect(t.reports.at(-1)).toContain("## Review did not pass");
    expect(t.dialogs).toHaveLength(1);
    expect(t.dialogs[0]!.markdown).toContain("| 1 | BLOCKING | npm test | unit failed with exit 1: FAIL injected | Check | — |");
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(await git(t.cwd, "status", "--porcelain")).toContain("src/wip.ts");
  });

  it("lists the model review's findings but never lets them change the verdict", async () => {
    const t = await setup({ chat: modelChat([{ severity: "high", category: "correctness", file: "src/retry.ts", message: "retry never backs off.", evidence: "const retry = 3" }]) });
    await branchWithCommit(t.cwd);
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    const report = sessionReport(t.app);
    expect(report.passed).toBe(true);
    expect(report.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(report.modelReview?.findings).toHaveLength(1);
    expect(t.reports.at(-1)).toMatch(/\| 1 \| HIGH \| src\/retry\.ts \| retry never backs off\. \|/);
    expect(t.dialogs[0]!.markdown).toMatch(/\| 1 \| HIGH \| src\/retry\.ts \| retry never backs off\. \|/);
    expect(t.app.store.readLedger().find((entry) => entry.reason === "model review")).toMatchObject({ taskId: "session", phase: "REVIEWING" });
  });
});

describe("/review findings dialog", () => {
  const findings = [{ severity: "medium", category: "correctness", file: "src/retry.ts", message: "no jitter." }];

  async function failing(choice: Choice, extra: { ui?: boolean } = {}) {
    // An eval in the diff (static), a failing check, and a model finding: numbered in that order.
    const t = await setup({ checks: { code: 1 }, chat: modelChat(findings), choice, ...extra });
    await branchWithCommit(t.cwd);
    write(t.cwd, "src/run.ts", "export const run = (s: string) => eval(s);\n");
    return t;
  }

  it("shows every finding numbered, static first, then checks, then model, with three actions", async () => {
    const t = await failing({ value: "close" });
    const result = await t.app.review();
    expect(result.ok).toBe(false);
    expect(t.dialogs).toHaveLength(1);
    const [dialog] = t.dialogs;
    expect(dialog!.title).toBe("Review · 3 finding(s)");
    expect(dialog!.actions).toEqual([
      { value: "fix-all", label: "Fix all" },
      { value: "fix-some", label: "Fix…", input: "What should be fixed? (finding numbers like 1, 3, and/or your own instructions)" },
      { value: "close", label: "Close" },
    ]);
    const lines = dialog!.markdown.split("\n").filter((line) => /^\| \d+ \|/.test(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\| 1 \| BLOCKING \| security \|/);
    expect(lines[1]).toMatch(/^\| 2 \| BLOCKING \| npm test \|/);
    expect(lines[2]).toMatch(/^\| 3 \| MEDIUM \| src\/retry\.ts \| no jitter\./);
  });

  it("Fix all starts a turn with every finding, the check commands, and the rules; nothing is committed", async () => {
    const t = await failing({ value: "fix-all" });
    const head = await git(t.cwd, "rev-parse", "HEAD");
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toBe("Sent 3 finding(s) to the model to fix.");
    expect(t.turns).toHaveLength(1);
    const message = t.turns[0]!;
    expect(message).toContain("Fix all 3 finding(s)");
    expect(message).toMatch(/1\. BLOCKING security:/);
    expect(message).toContain("2. Check failed: unit");
    expect(message).toContain("3. MEDIUM src/retry.ts: no jitter.");
    expect(message).toContain("- `npm test`");
    expect(message).toContain("Do not commit, push, or switch branches.");
    expect(message).toContain("one line per finding addressed");
    expect(message).toContain("Run /review again when done.");
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(head);
  });

  it("Fix… sends the typed text plus the full numbered list as reference", async () => {
    const t = await failing({ value: "fix-some", text: "1 and rename foo" });
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    expect(t.turns).toHaveLength(1);
    const message = t.turns[0]!;
    expect(message).toContain("1 and rename foo");
    expect(message).toContain("for reference");
    expect(message).toMatch(/1\. BLOCKING security:/);
    expect(message).toContain("3. MEDIUM src/retry.ts: no jitter.");
    expect(message).toContain("- `npm test`");
    expect(message).toContain("Run /review again when done.");
  });

  it("redacts secrets in the message", async () => {
    const t = await failing({ value: "fix-some", text: "use key sk-abcdefghijklmnopqrstuvwxyz" });
    await t.app.review();
    expect(t.turns[0]).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("Close, a dismissed dialog, or an empty Fix… start no turn", async () => {
    for (const choice of [{ value: "close" }, undefined, { value: "fix-some", text: "  " }] as Choice[]) {
      const t = await failing(choice);
      const result = await t.app.review();
      expect(result).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
      expect(t.turns).toEqual([]);
    }
  });

  it("shows only the report and its text without a UI", async () => {
    const t = await failing({ value: "fix-all" }, { ui: false });
    const result = await t.app.review();
    expect(result).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
    expect(t.dialogs).toEqual([]);
    expect(t.turns).toEqual([]);
    expect(t.reports.at(-1)).toContain("## Review did not pass");
  });

  it("opens no dialog when there are no findings and the review passed", async () => {
    const t = await setup({ choice: { value: "fix-all" } });
    await branchWithCommit(t.cwd);
    const result = await t.app.review();
    expect(result.text).toBe("Review passed: 1 check(s), no findings.");
    expect(t.dialogs).toEqual([]);
    expect(t.turns).toEqual([]);
  });
});

describe("/review after /build", () => {
  async function built(options: { base?: string; mutate?: (config: ReturnType<typeof tieredConfig>) => void; tickets?: ReturnType<typeof sampleTicket>[] } = {}) {
    const { cwd } = await repoWithOrigin(options.base ?? "trunk");
    const config = tieredConfig();
    options.mutate?.(config);
    const { app, taskId } = await ticketWorkflow(options.tickets ?? [sampleTicket("01"), sampleTicket("02", { blockedBy: ["01"] })], { config }, { cwd });
    const result = await runBuild(() => app, writingDriver(cwd));
    expect(result.ok, result.text).toBe(true);
    return { cwd, app, taskId };
  }

  it("uses the build's base, stores state.review and the report files, and does not change the phase", async () => {
    const t = await built();
    const before = t.app.store.load(t.taskId)!;
    expect(before.build!.base).toBe("trunk");
    expect(before.phase).toBe("IMPLEMENTING");
    const head = await git(t.cwd, "rev-parse", "HEAD");
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    const after = t.app.store.load(t.taskId)!;
    expect(after.phase).toBe("IMPLEMENTING");
    expect(after.review?.passed).toBe(true);
    expect(after.pullRequest).toBeUndefined();
    const dir = t.app.store.taskDir(t.taskId);
    expect(existsSync(path.join(dir, "reports", "review.json"))).toBe(true);
    expect(readFileSync(path.join(dir, "reports", "review.md"), "utf8")).toContain("## Review passed");
    expect(await git(t.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(await git(t.cwd, "branch", "--show-current")).toBe(`chef/${t.taskId}`);
  });

  it("falls back to the tickets' checks when the config has none, and cannot pass with no checks at all", async () => {
    const withChecks = await built({
      mutate: (config) => void (config.checks = []),
      tickets: [sampleTicket("01", { checks: ["npm run typecheck"] }), sampleTicket("02", { blockedBy: ["01"], checks: ["npm run typecheck", "npm test"] })],
    });
    const result = await withChecks.app.review();
    expect(result.ok, result.text).toBe(true);
    const report = withChecks.app.store.load(withChecks.taskId)!.review!;
    expect(report.checks.map((check) => check.name).sort()).toEqual(["npm run typecheck", "npm test"]);
    expect(report.summary).toContain("Review passed with 2 check(s)");

    const bare = await built({ mutate: (config) => void (config.checks = []) });
    const failed = await bare.app.review();
    expect(failed).toMatchObject({ ok: false, code: "REVIEW_BLOCKING" });
    expect(failed.text).toContain("no checks ran");
    expect(bare.app.store.load(bare.taskId)!.phase).toBe("IMPLEMENTING");
  });
});
