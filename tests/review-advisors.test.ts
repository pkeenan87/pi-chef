import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ReviewReport, Ticket } from "../src/domain.js";
import type { PlanReviewRequest } from "../src/orchestrator/types.js";
import { mergeQuestions } from "../src/review/model-review.js";
import { reviewAdvisorsFor, type AdvisorCandidate } from "../src/review/advisors.js";
import { attribution, parseResolution } from "../src/review/review-resolution.js";
import { checkRunner, fakeChat, sampleTicket, tempRepo, tieredConfig, ticketWorkflow, withAdvisors, type FakeCall } from "./helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

const astra: AdvisorCandidate = { provider: "openai", model: "gpt-6-astra" };
const fable: AdvisorCandidate = { provider: "anthropic", model: "claude-fable-5-1" };
const both = [astra, fable];
const rule = (extra: Partial<Parameters<typeof reviewAdvisorsFor>[0]>) => reviewAdvisorsFor({ changedLines: 10, adHocMinLines: 400, reviewerProvider: "anthropic", candidates: both, ...extra });

describe("reviewAdvisorsFor", () => {
  it("high ticket: both advisors", () => {
    expect(rule({ maxDifficulty: "high" })).toEqual({ advisors: [astra, fable], reason: "branch has a high ticket" });
  });
  it("medium ticket: one advisor from a different vendor than the reviewer", () => {
    expect(rule({ maxDifficulty: "medium" }).advisors).toEqual([astra]);
    expect(rule({ maxDifficulty: "medium", reviewerProvider: "openai" }).advisors).toEqual([fable]);
    const none = rule({ maxDifficulty: "medium", candidates: [fable] });
    expect(none.advisors).toEqual([]);
    expect(none.reason).toContain("no advisor is available");
  });
  it("only low tickets: none", () => {
    expect(rule({ maxDifficulty: "low", changedLines: 5000 })).toEqual({ advisors: [], reason: "only low tickets" });
  });
  it("ad hoc: Astra above adHocMinLines changed lines, none at or below", () => {
    expect(rule({ changedLines: 401 }).advisors).toEqual([astra]);
    expect(rule({ changedLines: 400 }).advisors).toEqual([]);
    expect(rule({ changedLines: 150, adHocMinLines: 100 }).advisors).toEqual([astra]);
  });
});

describe("resolution parsing", () => {
  it("maps names to the reviewer and the advisor models, and tags the attribution", () => {
    const text = JSON.stringify({
      findings: [
        { severity: "high", file: "a.ts", message: "m1", status: "accepted", rationale: "r", source: "opus", agreedBy: ["Astra", "gpt-6-astra", "claude-fable-5-1"] },
        { severity: "low", message: "m2", status: "rejected", rationale: "nope", source: "claude-fable-5-1", agreedBy: [] },
        { severity: "medium", message: "m3", source: "Astra", agreedBy: ["opus"] },
      ],
      rationale: "ok",
    });
    const parsed = parseResolution(text, { reviewerModel: "claude-opus-5-5", advisorModels: ["gpt-6-astra", "claude-fable-5-1"] })!;
    expect(parsed.findings.map((item) => [item.source, item.agreedBy, item.status])).toEqual([
      ["opus", ["gpt-6-astra", "claude-fable-5-1"], "accepted"],
      ["gpt-6-astra", ["opus"], "accepted"],
      ["claude-fable-5-1", [], "rejected"],
    ]);
    expect(attribution(parsed.findings[0]!, "claude-opus-5-5")).toBe("[Opus · Astra agrees · Fable agrees]");
    expect(attribution(parsed.findings[1]!, "claude-opus-5-5")).toBe("[Astra · Opus accepts · Opus agrees]");
    expect(attribution(parsed.findings[2]!, "claude-opus-5-5")).toBe("[Fable]");
    expect(parseResolution("nope", { reviewerModel: "x", advisorModels: [] })).toBeUndefined();
  });

  it("keeps at most three questions, one per part first", () => {
    expect(mergeQuestions([["a1", "a2", "a3"], ["b1", "b2"], ["c1"]])).toEqual(["a1", "b1", "c1"]);
    expect(mergeQuestions([["a1", "a2"], ["A1", "b2"]])).toEqual(["a1", "a2", "b2"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const OPUS = "claude-opus-5-5";
const opusFindings = [
  { severity: "high", category: "correctness", file: "src/retry.ts", message: "retry never backs off." },
  { severity: "low", category: "style", file: "src/retry.ts", message: "naming nit." },
];
const questionsOut = ["Is the backoff bounded?", "Is the retry idempotent?"];
const advisorOut = (verdict: string, concerns: object[]) => JSON.stringify({ answers: [{ question: "Is the backoff bounded?", answer: "No." }], concerns, verdict });
const resolutionOut = JSON.stringify({
  findings: [
    { severity: "high", file: "src/retry.ts", message: "retry never backs off.", status: "accepted", rationale: "real", source: "opus", agreedBy: ["gpt-6-astra"] },
    { severity: "medium", file: "src/retry.ts", message: "no jitter.", status: "accepted", rationale: "fair", source: "claude-fable-5-1", agreedBy: [] },
    { severity: "low", file: "src/retry.ts", message: "rename retry to attempts.", status: "rejected", rationale: "style only", source: "gpt-6-astra", agreedBy: [] },
  ],
  rationale: "Kept the backoff points; dropped the rename.",
});

interface Handlers {
  pass?: (call: FakeCall) => string;
  advisor?: (call: FakeCall) => string;
  resolve?: (call: FakeCall) => string;
}

function roles(handlers: Handlers) {
  return (call: FakeCall): string => {
    if (call.system.includes("engineering advisor")) return (handlers.advisor ?? (() => advisorOut(call.provider === "openai" ? "disagree" : "agree", [{ severity: "medium", file: "src/retry.ts", issue: call.provider === "openai" ? "rename retry to attempts." : "no jitter." }])))(call);
    if (call.system.includes("final word on a branch")) return (handlers.resolve ?? (() => resolutionOut))(call);
    return (handlers.pass ?? ((c) => (c.system.includes("Independent advisors will be asked") ? JSON.stringify({ findings: opusFindings, questions: questionsOut }) : JSON.stringify(opusFindings))))(call);
  };
}

async function setup(options: { tickets?: Ticket[]; handlers?: Handlers; checkCode?: number; lines?: number; choice?: { value: string; text?: string } } = {}) {
  const cwd = await tempRepo();
  const config = withAdvisors(tieredConfig());
  config.tiers.premium = [{ provider: "anthropic", model: OPUS, api: "chat" }];
  const fake = fakeChat(roles(options.handlers ?? {}));
  const reports: string[] = [];
  const turns: string[] = [];
  const dialogs: PlanReviewRequest[] = [];
  const code = options.checkCode ?? 0;
  const extras = {
    config,
    chat: fake.chat,
    report: (markdown: string) => void reports.push(markdown),
    startTurn: (text: string) => void turns.push(text),
    runner: checkRunner(async () => (code === 0 ? { code: 0, stdout: "ok", stderr: "" } : { code, stdout: "", stderr: "FAIL injected" })),
  };
  const planned = options.tickets ? await ticketWorkflow(options.tickets, extras, { cwd }) : undefined;
  const app = planned?.app ?? (await ticketWorkflow([sampleTicket("01")], extras, { cwd })).app;
  if (!planned) {
    // An ad-hoc branch: no active task.
    await app.store.update(app.activeTaskId()!, "test: close", (task) => ({ ...task, phase: "COMPLETE" as const }));
  }
  app.bind({ review: async (request: PlanReviewRequest) => (dialogs.push(request), options.choice ?? { value: "close" }) });
  await git(cwd, "switch", "-c", "feature/retry");
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "retry.ts"), Array.from({ length: options.lines ?? 3 }, (_, i) => `export const retry${i} = ${i};`).join("\n") + "\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "Add retry");
  turns.length = 0; // the /plan fixture started a turn
  return { cwd, app, calls: fake.calls, reports, turns, dialogs };
}

const advisorCalls = (t: { calls: FakeCall[] }) => t.calls.filter((call) => call.system.includes("engineering advisor"));
const passCalls = (t: { calls: FakeCall[] }) => t.calls.filter((call) => call.model === OPUS && !call.system.includes("final word on a branch"));
const reportOf = (result: { data?: unknown }) => result.data as ReviewReport;

describe("/review advisors", () => {
  it("a high ticket consults both advisors with Opus's questions, and the resolve output drives the dialog", async () => {
    const t = await setup({ tickets: [sampleTicket("01", { difficulty: "high" }), sampleTicket("02", { difficulty: "low" })] });
    const result = await t.app.review();
    expect(result.ok, result.text).toBe(true);
    expect(advisorCalls(t).map((call) => call.model).sort()).toEqual(["claude-fable-5-1", "gpt-6-astra"]);
    for (const call of advisorCalls(t)) {
      expect(call.user).toContain("1. Is the backoff bounded?");
      expect(call.user).toContain("2. Is the retry idempotent?");
      expect(call.user).toContain("## Changed files");
      expect(call.user).toMatch(/- src\/retry\.ts \(\+3\/-0\)/);
      expect(call.user).toContain("retry never backs off.");
      expect(call.user).toContain("+export const retry0 = 0;");
    }
    expect(passCalls(t)[0]!.system).toContain("Independent advisors will be asked");
    const review = reportOf(result).modelReview!;
    expect(review.questions).toEqual(questionsOut);
    expect(review.advisors).toHaveLength(2);
    expect(review.resolution!.findings.map((item) => item.status)).toEqual(["accepted", "accepted", "rejected"]);
    expect(review.advisorRule).toEqual({ reason: "branch has a high ticket", planned: ["gpt-6-astra", "claude-fable-5-1"] });
    expect(t.reports.at(-1)).toContain("Advisors: Astra, Fable (branch has a high ticket)");

    const dialog = t.dialogs[0]!;
    expect(dialog.title).toBe("Review · 2 finding(s)");
    expect(dialog.markdown).toContain("Advisors: Astra, Fable (branch has a high ticket)");
    expect(dialog.markdown).toContain("1. HIGH src/retry.ts: retry never backs off. [Opus · Astra agrees]");
    expect(dialog.markdown).toContain("2. MEDIUM src/retry.ts: no jitter. [Fable · Opus accepts]");
    expect(dialog.markdown).toContain("> LOW src/retry.ts: rename retry to attempts. [Astra] — Opus rejects: style only");
    expect(dialog.markdown).not.toMatch(/3\. .*rename/);
  });

  it("Fix all sends only the accepted findings; Fix… may still reference the rejected one by text", async () => {
    const all = await setup({ tickets: [sampleTicket("01", { difficulty: "high" })], choice: { value: "fix-all" } });
    await all.app.review();
    expect(all.turns).toHaveLength(1);
    expect(all.turns[0]).toContain("Fix all 2 finding(s)");
    expect(all.turns[0]).toContain("retry never backs off. [Opus · Astra agrees]");
    expect(all.turns[0]).toContain("no jitter. [Fable · Opus accepts]");
    expect(all.turns[0]).not.toContain("rename retry to attempts");
    const some = await setup({ tickets: [sampleTicket("01", { difficulty: "high" })], choice: { value: "fix-some", text: "do the rename too" } });
    await some.app.review();
    expect(some.turns[0]).toContain("rename retry to attempts.");
    expect(some.turns[0]).toContain("Not numbered");
  });

  it("falls back to Opus's findings plus the advisor concerns, labelled unresolved, when the resolve call fails", async () => {
    const t = await setup({ tickets: [sampleTicket("01", { difficulty: "high" })], handlers: { resolve: () => "no json here" }, choice: { value: "fix-all" } });
    const result = await t.app.review();
    const review = reportOf(result).modelReview!;
    expect(review.resolution).toBeUndefined();
    expect(review.resolutionError).toContain("not the JSON asked for");
    expect(review.advisors).toHaveLength(2);
    const dialog = t.dialogs[0]!;
    expect(dialog.title).toBe("Review · 2 finding(s)");
    expect(dialog.markdown).toContain("1. HIGH src/retry.ts: retry never backs off.");
    expect(dialog.markdown).toContain("> unresolved advisor concern (Fable): MEDIUM src/retry.ts: no jitter.");
    expect(dialog.markdown).toContain("> unresolved advisor concern (Astra)");
    expect(t.turns[0]).not.toContain("unresolved advisor concern");
    expect(t.reports.at(-1)).toContain("could not weigh the advisors' answers");
  });

  it("never changes passed: advisors disagreeing does not fail a passing review, and a failing check still fails", async () => {
    const ok = await setup({ tickets: [sampleTicket("01", { difficulty: "high" })] });
    expect(reportOf(await ok.app.review()).passed).toBe(true);
    const failing = await setup({ tickets: [sampleTicket("01", { difficulty: "high" })], checkCode: 1 });
    const result = await failing.app.review();
    expect(reportOf(result).passed).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("a medium ticket consults one advisor from another vendor, a low ticket none", async () => {
    const medium = await setup({ tickets: [sampleTicket("01", { difficulty: "medium" })] });
    await medium.app.review();
    expect(advisorCalls(medium).map((call) => call.model)).toEqual(["gpt-6-astra"]);
    expect(medium.reports.at(-1)).toContain("Advisors: Astra (highest ticket is medium)");
    const low = await setup({ tickets: [sampleTicket("01", { difficulty: "low" })] });
    const result = await low.app.review();
    expect(advisorCalls(low)).toHaveLength(0);
    expect(passCalls(low)[0]!.system).not.toContain("Independent advisors will be asked");
    expect(low.reports.at(-1)).toContain("Advisors: none (only low tickets)");
    expect(reportOf(result).modelReview!.resolution).toBeUndefined();
    // Without advisors the numbered findings are Opus's own.
    expect(low.dialogs[0]!.markdown).toContain("1. HIGH src/retry.ts: retry never backs off.");
  });

  it("an ad-hoc branch gets Astra above 400 changed lines and nobody below", async () => {
    const big = await setup({ lines: 500 });
    await big.app.review();
    expect(advisorCalls(big).map((call) => call.model)).toEqual(["gpt-6-astra"]);
    expect(big.reports.at(-1)).toContain("Advisors: Astra (ad-hoc branch with 500 changed lines, over 400)");
    const small = await setup({ lines: 50 });
    await small.app.review();
    expect(advisorCalls(small)).toHaveLength(0);
    expect(small.reports.at(-1)).toContain("Advisors: none (ad-hoc branch with 50 changed lines, 400 or fewer)");
  });

  it("skips the advisors and says so when the model pass produced nothing", async () => {
    const t = await setup({ tickets: [sampleTicket("01", { difficulty: "high" })], handlers: { pass: () => "not json" } });
    const result = await t.app.review();
    expect(advisorCalls(t)).toHaveLength(0);
    expect(reportOf(result).modelReview!.advisorsSkipped).toBe("the model pass produced no result");
  });
});
