import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setBillingResolver } from "../src/config.js";
import { summarize, unpricedModels } from "../src/cost/ledger.js";
import { type CostRecord, type PlanDocument, type ReviewReport, type TaskState, type Ticket } from "../src/domain.js";
import { forNewPlan, sameTicket } from "../src/orchestrator/plan.js";
import { ticketPrompt } from "../src/orchestrator/prompts.js";
import { modelReviewPrompt, parseModelFindings } from "../src/review/model-review.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import { formatDuration, formatTokens } from "../src/orchestrator/format.js";
import { splitDiff } from "../src/review/model-review.js";
import { blank } from "../src/orchestrator/planning.js";
import { TICKET_RULES } from "../src/orchestrator/prompts.js";
import { validateTickets } from "../src/orchestrator/tickets.js";
import type { DecisionsClient } from "../src/providers/clients.js";
import type { Workflow } from "../src/orchestrator/service.js";
import { checkRunner, readyAuth, tempRepo, tieredConfig, workflow } from "./helpers.js";

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 };
function fakeChat(reply: () => string) {
  const calls: { provider: string; model: string; user: string; system: string }[] = [];
  const chat: ChatFn = async (candidate, request) => {
    calls.push({ provider: candidate.provider, model: candidate.model, user: request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"), system: request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") });
    return { text: reply(), usage, provider: candidate.provider, model: candidate.model };
  };
  return { chat, calls };
}

/** An uncommitted new file in the checkout: what /review finds with no task and no commits. */
async function adHocChange(cwd: string, body = "export const ingest = 1;\n", more: Record<string, string> = {}): Promise<void> {
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "ingest.ts"), body);
  for (const [name, text] of Object.entries(more)) writeFileSync(path.join(cwd, name), text);
}

function reportDir(app: Workflow): string {
  return path.join(app.store.root, "reports");
}

/** The markdown of the newest session /review report. */
function reportText(app: Workflow): string {
  const file = readdirSync(reportDir(app)).filter((name) => name.endsWith(".md")).sort().at(-1)!;
  return readFileSync(path.join(reportDir(app), file), "utf8");
}

function savedReport(app: Workflow): ReviewReport {
  const file = readdirSync(reportDir(app)).filter((name) => name.endsWith(".json")).sort().at(-1)!;
  return JSON.parse(readFileSync(path.join(reportDir(app), file), "utf8")) as ReviewReport;
}

const ticket = (id: string, slug: string, extra: Partial<Ticket> = {}): Ticket => ({ id, slug, title: `T${id}`, whatToBuild: "x", acceptanceCriteria: ["works"], blockedBy: [], estimatedContextTokens: 30_000, ...extra });

describe("ticket checks at plan time", () => {
  const options = { target: 150_000, fileSize: () => undefined };

  it("rejects a destructive check and says what to do instead", () => {
    const result = validateTickets([ticket("01", "a", { checks: ["rm -rf /"] })], options);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Ticket 01: check "rm -rf /" cannot run');
    expect(result.errors[0]).toContain("implementation instead");
  });

  it("accepts any non-destructive command", () => {
    expect(validateTickets([ticket("01", "a", { checks: ["npm test", "make test", "npm ci"] })], options).errors).toEqual([]);
  });

  it("rejects prose whose first word is not a command on PATH", () => {
    const result = validateTickets([ticket("01", "a", { checks: ["Run the smoke test by hand."] })], options);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"Run" is not a command on PATH; describe manual steps in implementation, not checks');
  });

  it("accepts paths, and uses the injected lookup", () => {
    expect(validateTickets([ticket("01", "a", { checks: ["./scripts/check.sh"] })], options).errors).toEqual([]);
    const only = { ...options, commandExists: (command: string) => command === "mytool" };
    expect(validateTickets([ticket("01", "a", { checks: ["mytool --x"] })], only).errors).toEqual([]);
    expect(validateTickets([ticket("01", "a", { checks: ["npm test"] })], only).errors).toHaveLength(1);
  });

  it("tells the planner what checks are", () => {
    const rules = TICKET_RULES(150_000);
    expect(rules).toContain("shell command lines");
    expect(rules).toContain("Destructive commands are refused");
    expect(rules).not.toContain("allowlist");
  });

  it("rejects destructive checks through the workflow", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig() });
    const check = app.checkTickets([ticket("01", "a", { checks: ["git push --force"] })]);
    expect(check.errors[0]).toContain("cannot run");
    expect(app.checkTickets([ticket("01", "a", { checks: ["npm test"] })]).errors).toEqual([]);
  });
});

describe("state carried into a new plan version", () => {
  const draft = (tickets: Ticket[]): PlanDocument => ({
    version: 2,
    createdAt: "2026-10-15T00:00:00.000Z",
    summary: "s",
    risks: [],
    acceptance: [],
    estimatedUsd: null,
    groups: tickets.map((item) => ({ id: `${item.id}-${item.slug}`, summary: item.title, files: [], dependsOn: [], edits: [] })),
    overlap: [],
    securitySensitive: false,
    tickets,
  });
  it("drops the runs of tickets the new plan no longer has, keeps the rest, and restarts attempts", () => {
    const task: TaskState = {
      ...blank("t", "req", "2026-10-15T00:00:00.000Z"),
      plan: draft([ticket("01", "old-slug"), ticket("02", "same")]),
      ticketRuns: { "01": { status: "done", attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false }, "02": { status: "done", attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false } },
      attempts: [{ tier: "cheap", provider: "openai", model: "m", outcome: "failure", at: "2026-10-15T00:00:00.000Z" }],
    };
    const next = forNewPlan(task, draft([ticket("01", "new-slug"), ticket("02", "same")]));
    expect(next.attempts).toEqual([]);
    // The stale "done" for ticket 01 is gone, so the new 01 runs; 02 stays done.
    expect(Object.keys(next.ticketRuns ?? {})).toEqual(["02"]);
  });

  it("drops the run of a ticket whose text changed, so it runs again", () => {
    const before = ticket("01", "a", { whatToBuild: "old" });
    const task: TaskState = { ...blank("t", "req", "2026-10-15T00:00:00.000Z"), plan: draft([before]), ticketRuns: { "01": { status: "done", attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false } } };
    expect(forNewPlan(task, draft([ticket("01", "a", { whatToBuild: "old" })])).ticketRuns).toBeDefined();
    const next = forNewPlan(task, draft([ticket("01", "a", { whatToBuild: "new" })]));
    expect(next.ticketRuns).toBeUndefined();
    expect(sameTicket(before, ticket("01", "a", { whatToBuild: "old", checks: ["npm test"] }))).toBe(false);
  });

  it("tells the model about earlier work on the branch", () => {
    const prompt = ticketPrompt({ ticket: { id: "01", title: "T", whatToBuild: "x", acceptanceCriteria: ["a"] }, blockers: [], priorWork: true });
    expect(prompt).toContain("## Earlier work on this branch");
    expect(ticketPrompt({ ticket: { id: "01", title: "T", whatToBuild: "x", acceptanceCriteria: ["a"] }, blockers: [], priorWork: true, previousFailure: "boom" })).not.toContain("Earlier work");
  });
});

describe("phantom spend", () => {
  afterEach(() => setBillingResolver(undefined));
  const pricing = [
    { provider: "anthropic", model: "cheap", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
    { provider: "anthropic", model: "cheap", billing: "api-key" as const, effectiveFrom: "2026-01-01", inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  ];
  const unknown: CostRecord = { id: "1", at: "2026-10-15T10:00:00.000Z", taskId: "t", phase: "IDLE", provider: "anthropic", model: "other", tier: "interactive", requests: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd: null, usageKnown: false, outcome: "unknown", retries: 0, reason: "observed assistant usage" };

  it("estimates an unpriced subscription model from subscription rows only, and api-key rows while on a key", () => {
    expect(summarize([unknown], { pricing }).estimatedUnknownUsd).toBe(0);
    setBillingResolver(() => "api-key");
    expect(summarize([unknown], { pricing }).estimatedUnknownUsd).toBe(10);
  });

  it("names the models in the ledger that have no pricing row", () => {
    const priced: CostRecord = { ...unknown, id: "2", model: "cheap" };
    expect(unpricedModels([priced, unknown, unknown], pricing)).toEqual(["anthropic/other"]);
  });

  it("never sends a classifier call to a provider that is not signed in", async () => {
    const log: string[] = [];
    const client = (id: "foundry" | "vercel"): DecisionsClient => ({
      id,
      async decide(request) {
        log.push(`${id}:${request.model}`);
        throw new Error("az account show failed");
      },
    });
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: readyAuth("missing"), deciders: { foundry: client("foundry"), vercel: client("vercel") } });
    const result = await app.route("add a feature");
    expect(result.ok).toBe(true);
    expect(log).toEqual([]);
    expect(app.store.readLedger().filter((item) => item.tier === "classifier")).toEqual([]);
    expect(app.store.readMetrics().classification).toBeUndefined();
  });
});

describe("model review", () => {
  const plan: PlanDocument = { version: 1, createdAt: "2026-10-15T00:00:00.000Z", summary: "Add retry.", risks: [], acceptance: ["retry works"], estimatedUsd: null, groups: [], overlap: [], securitySensitive: false, tickets: [ticket("01", "retry", { acceptanceCriteria: ["retry works"] })] };

  it("parses a JSON list out of chatty output, fills defaults, and sorts by severity", () => {
    const text = 'Here you go:\n[{"severity":"LOW","category":"tests","message":"No test for the empty case.","file":"src/a.ts"},{"severity":"high","message":"retry() loops forever when attempts is 0.","evidence":"while (true)"},{"message":""},"junk"]';
    const findings = parseModelFindings(text)!;
    expect(findings.map((item) => item.severity)).toEqual(["low", "high"]);
    expect(findings[1]).toMatchObject({ category: "general", evidence: "while (true)" });
    expect(parseModelFindings("I found nothing.")).toBeUndefined();
    expect(parseModelFindings("[]")).toEqual([]);
  });

  it("puts the plan before the diff and truncates the diff at the limit", () => {
    const prompt = modelReviewPrompt(plan, "x".repeat(2000), 1000);
    expect(prompt.truncated).toBe(true);
    expect(prompt.text.indexOf("# Plan")).toBeLessThan(prompt.text.indexOf("# Diff"));
    expect(prompt.text).toContain("- 01 T01: retry works");
    expect(prompt.text).toContain("1000 more not shown");
    expect(modelReviewPrompt(plan, "short", 1000).truncated).toBe(false);
  });

  it("lists the review model's findings in /review, ledgers the call, and keeps the pass deterministic", async () => {
    const { chat, calls } = fakeChat(() => JSON.stringify([{ severity: "high", category: "correctness", file: "src/ingest.ts", message: "ingest() throws on empty input but the plan asks for a skip.", evidence: 'throw new Error("empty")' }]));
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), chat });
    await adHocChange(cwd);
    const review = await app.review();
    expect(review.ok, review.text).toBe(true);
    const text = reportText(app);
    expect(text).toMatch(/Model review \(\S+\/\S+; 0\.0s, \$0\.\d{4}\): 1 finding\(s\)\./);
    expect(text).toContain("- HIGH   src/ingest.ts — ingest() throws on empty input");
    expect(text).toContain("## Review passed");
    expect(text).toContain("### Checks (1 of 1 passed)");
    expect(text).toContain("- ✓ unit");
    expect(text).toContain("### Next");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain("JSON array");
    expect(calls[0]!.user).toContain("# Diff");
    expect(calls[0]!.user).toContain("src/ingest.ts");
    const entry = app.store.readLedger().find((item) => item.reason === "model review");
    expect(entry).toMatchObject({ taskId: "session", phase: "REVIEWING", inputTokens: 100, outcome: "success" });
    expect(readdirSync(path.join(cwd, ".pi-workflows", "reports")).some((name) => name.endsWith(".md"))).toBe(true);
  });

  it("skips the model pass when review.model is off, and reports a failed call as an unknown charge", async () => {
    const off = fakeChat(() => "[]");
    const quietCwd = await tempRepo();
    const quiet = workflow(quietCwd, { config: tieredConfig("review: { model: false }"), chat: off.chat });
    await adHocChange(quietCwd);
    const silent = await quiet.review();
    expect(silent.ok).toBe(true);
    expect(reportText(quiet)).toContain("### Model review\n- did not run");
    expect(off.calls).toHaveLength(0);

    const broken: ChatFn = async () => {
      throw new Error("rate limited");
    };
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), chat: broken });
    await adHocChange(cwd);
    const review = await app.review();
    expect(review.ok).toBe(true);
    // Both review candidates were tried; each failed call is an unknown charge, never zero.
    expect(reportText(app)).toMatch(/produced no findings: the call failed: \S+\/\S+: rate limited; \S+\/\S+: rate limited/);
    const calls = app.store.readLedger().filter((item) => item.reason === "model review");
    expect(calls).toHaveLength(2);
    for (const entry of calls) expect(entry).toMatchObject({ actualUsd: null, outcome: "failure" });
  });

  it("runs setup commands in the repo root before the checks, and hints at setup when tooling is missing", async () => {
    const ran: string[] = [];
    const cwd = await tempRepo();
    const app = workflow(cwd, {
      config: tieredConfig("setup:\n  - { name: install, command: npm, args: [ci] }"),
      runner: checkRunner(async (command, args, where) => (ran.push(`${[command, ...args].join(" ")} @ ${where === app.git.repoRoot ? "root" : where}`), { code: 0, stdout: "ok", stderr: "" })),
    });
    await adHocChange(cwd);
    const review = await app.review();
    expect(review.ok, review.text).toBe(true);
    expect(ran).toEqual(["npm ci @ root", "npm test @ root"]);
    expect(savedReport(app).checks.map((check) => check.name)).toEqual(["setup: install", "unit"]);

    const brokenCwd = await tempRepo();
    const brokenInstall = workflow(brokenCwd, {
      config: tieredConfig("setup:\n  - { name: install, command: npm, args: [ci] }"),
      runner: checkRunner(async (_command, args) => (args[0] === "ci" ? { code: 1, stdout: "", stderr: "ERESOLVE" } : { code: 0, stdout: "ok", stderr: "" })),
    });
    await adHocChange(brokenCwd);
    const noInstall = await brokenInstall.review();
    expect(noInstall.ok).toBe(false);
    expect(noInstall.text).toContain("setup: install failed.");
    expect(savedReport(brokenInstall).checks.map((check) => [check.name, check.ran])).toEqual([["setup: install", true], ["unit", false]]);

    const bareCwd = await tempRepo();
    const bare = workflow(bareCwd, {
      config: tieredConfig(),
      runner: checkRunner(async () => ({ code: 127, stdout: "", stderr: "sh: tsc: command not found" })),
    });
    await adHocChange(bareCwd);
    const failed = await bare.review();
    expect(failed.ok).toBe(false);
    expect(reportText(bare)).toContain("a tool or package is missing");
    expect(reportText(bare)).toContain("`setup:`");
  });
});

describe("verbose output", () => {
  it("formats durations and token counts", () => {
    expect([formatDuration(800), formatDuration(12_340), formatDuration(261_000), formatDuration(3_720_000)]).toEqual(["0.8s", "12.3s", "4m21s", "1h02m"]);
    expect([formatTokens(512), formatTokens(81_000), formatTokens(1_654_094)]).toEqual(["512", "81k", "1.7M"]);
  });

  it("splits a large diff at file boundaries and cuts only an oversized file", () => {
    const file = (name: string, size: number) => `diff --git a/${name} b/${name}\n${"+x".repeat(size / 2)}\n`;
    const parts = splitDiff(file("a", 600) + file("b", 600) + file("c", 600), 1300);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("a/a b/a");
    expect(parts[0]).toContain("a/b b/b");
    expect(parts[1]).toContain("a/c b/c");
    const big = splitDiff(file("a", 200) + file("huge", 5000), 1000);
    expect(big).toHaveLength(2);
    expect(big[1]).toContain("was cut at 1000 characters");
    expect(splitDiff("small", 1000)).toEqual(["small"]);
  });

  it("reviews a large diff in parts, reports progress per part, and says when parts were left out", async () => {
    let call = 0;
    const { chat, calls } = fakeChat(() => JSON.stringify([{ severity: call++ === 0 ? "low" : "high", category: "tests", message: `finding from part ${call}` }]));
    const progress: string[] = [];
    const config = tieredConfig("review: { maxDiffChars: 2000, maxChunks: 2 }");
    const cwd = await tempRepo();
    const app = workflow(cwd, { config, chat, progress: (line) => void progress.push(line) });
    await adHocChange(cwd, `${"// padding line that makes this file's diff long\n".repeat(80)}export const ingest = 1;\n`, { "src/alert.ts": "export const alert = 1;\n".repeat(120) });
    const review = await app.review();
    expect(review.ok, review.text).toBe(true);
    const text = reportText(app);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.user).toContain("# Diff (part 1 of");
    expect(calls[0]!.system).toContain("You have no tools");
    expect(progress.some((line) => /^Review: started · \S+ against \S+ · 0 setup step\(s\), 1 check\(s\) · model \S+\/\S+$/.test(line))).toBe(true);
    expect(progress.some((line) => /^Review: running unit \(npm test\)$/.test(line))).toBe(true);
    expect(progress.some((line) => /^Review: unit: passed in 0\.0s$/.test(line))).toBe(true);
    expect(progress.some((line) => /^Review: asking \S+\/\S+ to review part 1 of \d+ \(\d+k chars\)$/.test(line))).toBe(true);
    expect(progress.some((line) => /^Review: model pass done: \d+ finding\(s\) in 0\.0s, \$0\.\d{4}$/.test(line))).toBe(true);
    // Severity order across parts, and the top line says how the pass ran.
    expect(text).toMatch(/Model review \(\S+\/\S+; 2 parts, 0\.0s, \$0\.\d{4}\)/);
    expect(text.indexOf("- HIGH")).toBeLessThan(text.indexOf("- LOW"));
    const data = savedReport(app) as unknown as { modelReview: { chunks: number; truncated: boolean; error?: string } };
    expect(data.modelReview.chunks).toBe(2);
    // The padded file is larger than one part, so it was cut: the header says so.
    expect(data.modelReview.truncated).toBe(true);
    expect(text).toContain("(part of the diff was not reviewed)");
  });

  it("stops a model review call at review.timeoutMs", async () => {
    const chat: ChatFn = (_candidate, request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
      });
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig("review: { timeoutMs: 1000 }"), chat });
    await adHocChange(cwd);
    const review = await app.review();
    expect(review.ok).toBe(true);
    expect(reportText(app)).toMatch(/produced no findings: the call failed: \S+\/\S+: timed out after 1\.0s; \S+\/\S+: timed out after 1\.0s/);
  }, 15_000);
});
