import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanDocument, ReviewReport } from "../src/domain.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import { MODEL_REVIEW_SYSTEM, parseModelFindings, runModelReview, type ModelReviewCall } from "../src/review/model-review.js";
import { tempRepo, tieredConfig, workflow } from "./helpers.js";

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 };
const STREAM_ERROR = "OpenAI Responses stream ended before a terminal response event";
const plan: PlanDocument = { version: 1, createdAt: "2026-10-15T00:00:00.000Z", summary: "Add retry.", risks: [], acceptance: ["retry works"], groups: [], overlap: [], securitySensitive: false };
const grok = { provider: "xai" as const, model: "grok-4.7" };
const sonnet = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };

/** A diff of three files that splits into three parts at maxDiffChars 700. */
const diff = ["a", "b", "c"].map((name) => `diff --git a/${name}.ts b/${name}.ts\n${"+x\n".repeat(200)}`).join("");

/** Fails the calls `fails` picks with the live stream error; any other call answers with one finding. */
function fakeChat(fails: (provider: string, user: string) => boolean) {
  const calls: { provider: string; part: string }[] = [];
  const chat: ChatFn = async (candidate, request) => {
    const user = request.messages.find((message) => message.role === "user")!.content;
    calls.push({ provider: candidate.provider, part: /part (\d+) of/.exec(user)?.[1] ?? "1" });
    if (fails(candidate.provider, user)) throw new Error(STREAM_ERROR);
    return { text: JSON.stringify([{ likelihood: 2, severity: 3, category: "tests", message: `from ${candidate.provider} in part ${/part (\d+) of/.exec(user)?.[1] ?? "1"}` }]), usage, provider: candidate.provider, model: candidate.model };
  };
  return { chat, calls };
}

describe("model review retries", () => {
  it("retries a failed part on the same model and keeps going with the parts after it", async () => {
    let first = true;
    const { chat, calls } = fakeChat(() => first && !(first = false));
    const recorded: ModelReviewCall[] = [];
    const review = await runModelReview(chat, sonnet, { plan, diff, maxDiffChars: 700, onCall: (call) => void recorded.push(call) });
    expect(calls.map((call) => `${call.part}:${call.provider}`)).toEqual(["1:anthropic", "1:anthropic", "2:anthropic", "3:anthropic"]);
    expect(recorded.map((call) => [call.candidate.provider, call.part, call.retry, call.outcome])).toEqual([
      ["anthropic", 1, 0, "failure"],
      ["anthropic", 1, 1, "success"],
      ["anthropic", 2, 0, "success"],
      ["anthropic", 3, 0, "success"],
    ]);
    // The failed call's usage is unknown, never zero.
    expect(recorded[0]!.usage).toMatchObject({ input: null, output: null });
    expect(review.findings).toHaveLength(3);
    expect(review.error).toBeUndefined();
    expect(review.chunks).toBe(3);
    expect(review.parts!.map((part) => part.reviewedBy)).toEqual(["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5"]);
    expect(review.parts![0]!.failures).toEqual([`anthropic/claude-sonnet-5-5: ${STREAM_ERROR}`]);
  });

  it("lists a part that failed twice and still reviews the others", async () => {
    const { chat, calls } = fakeChat((_provider, user) => user.includes("part 2 of 3"));
    const review = await runModelReview(chat, grok, { plan, diff, maxDiffChars: 700 });
    expect(calls.map((call) => call.part)).toEqual(["1", "2", "2", "3"]);
    expect(review.findings).toHaveLength(2);
    expect(review.error).toBe("part(s) 2 of 3 were not reviewed");
    expect(review.parts!.map((part) => part.reviewedBy)).toEqual(["xai/grok-4.7", undefined, "xai/grok-4.7"]);
    expect(review.parts![1]!.failures).toEqual([`xai/grok-4.7: ${STREAM_ERROR}`, `xai/grok-4.7: ${STREAM_ERROR}`]);
  });

  it("retries an answer that is not a findings list, and stops when told to", async () => {
    let n = 0;
    const chat: ChatFn = async (candidate) => ({ text: n++ === 0 ? "I could not review this." : "[]", usage, provider: candidate.provider, model: candidate.model });
    const review = await runModelReview(chat, sonnet, { plan, diff, maxDiffChars: 700, stop: () => (n >= 2 ? "the task or daily budget is exhausted" : undefined) });
    expect(n).toBe(2);
    expect(review.parts!.map((part) => [part.reviewedBy, part.failures])).toEqual([
      ["anthropic/claude-sonnet-5-5", ["anthropic/claude-sonnet-5-5: the answer was not a JSON list of findings: I could not review this."]],
      [undefined, ["not attempted: the task or daily budget is exhausted"]],
      [undefined, ["not attempted: the task or daily budget is exhausted"]],
    ]);
  });

  it("ledgers an answer that is no list as a failure, retries it, and redacts the excerpt", async () => {
    const answers = ["Sorry, token=abcdef123456 is all I can say.", JSON.stringify([{ likelihood: 2, severity: 3, category: "tests", message: "from the retry" }])];
    let n = 0;
    const chat: ChatFn = async (candidate) => ({ text: answers[n++]!, usage, provider: candidate.provider, model: candidate.model });
    const recorded: ModelReviewCall[] = [];
    const review = await runModelReview(chat, sonnet, { plan, diff: diff.slice(0, 600), maxDiffChars: 700, onCall: (call) => void recorded.push(call) });
    expect(recorded.map((call) => [call.candidate.provider, call.retry, call.outcome])).toEqual([["anthropic", 0, "failure"], ["anthropic", 1, "success"]]);
    expect(review.error).toBeUndefined();
    expect(review.findings).toHaveLength(1);
    expect(review.parts![0]).toMatchObject({ reviewedBy: "anthropic/claude-sonnet-5-5" });
    const failure = review.parts![0]!.failures[0]!;
    expect(failure).toContain("anthropic/claude-sonnet-5-5: the answer was not a JSON list of findings");
    expect(failure).toContain("[REDACTED]");
    expect(failure).not.toContain("abcdef123456");
  });

  it("marks the part not reviewed when both tries answer with garbage", async () => {
    const chat: ChatFn = async (candidate) => ({ text: "no list here", usage, provider: candidate.provider, model: candidate.model });
    const review = await runModelReview(chat, sonnet, { plan, diff: diff.slice(0, 600), maxDiffChars: 700 });
    expect(review.parts![0]!.failures).toHaveLength(2);
    expect(review.error).toContain("the call failed");
  });

  it("parses fenced JSON, a list inside prose, and an object with findings", () => {
    const one = '[{"likelihood":8,"severity":9,"message":"bad"}]';
    expect(parseModelFindings("```json\n" + one + "\n```")).toHaveLength(1);
    expect(parseModelFindings("Here is my review (see [1] below):\n" + one + "\nHope that helps.")).toEqual([{ likelihood: 8, severity: 9, category: "general", message: "bad" }]);
    expect(parseModelFindings('{"findings": ' + one + "}")).toHaveLength(1);
    expect(parseModelFindings('Result: {"findings": ' + one + "} done")).toHaveLength(1);
    expect(parseModelFindings('[{"message":"has ] and [ inside"}] trailing')).toEqual([{ category: "general", message: "has ] and [ inside" }]);
    expect(parseModelFindings("see [1] and [2]")).toBeUndefined();
    expect(parseModelFindings("no list")).toBeUndefined();
  });
});

describe("model review risk filter", () => {
  const one = (diffText: string) => ({ plan, diff: diffText, maxDiffChars: 700 });
  const answering = (...answers: unknown[][]): ChatFn => {
    let n = 0;
    return async (candidate) => ({ text: JSON.stringify(answers[Math.min(n++, answers.length - 1)]), usage, provider: candidate.provider, model: candidate.model });
  };

  it("asks for both scores and tells the model what to omit", () => {
    expect(MODEL_REVIEW_SYSTEM).toContain('{"likelihood": 1-10, "severity": 1-10,');
    expect(MODEL_REVIEW_SYSTEM).toContain("likelihood × severity");
    expect(MODEL_REVIEW_SYSTEM).toMatch(/below 5 combined/);
  });

  it("drops a 2x2 finding and one with a missing score, and says how many", async () => {
    const chat = answering([
      { likelihood: 2, severity: 2, category: "style", message: "trivial" },
      { severity: 9, category: "bug", message: "no likelihood given" },
      { likelihood: "4", severity: 5, category: "bug", file: "a.ts", message: "kept, scores as strings" },
    ]);
    const progress: string[] = [];
    const review = await runModelReview(chat, sonnet, { ...one(diff.slice(0, 600)), onProgress: (line) => void progress.push(line) });
    expect(review.findings.map((finding) => finding.message)).toEqual(["kept, scores as strings"]);
    expect(review.findings[0]).toMatchObject({ likelihood: 4, severity: 5 });
    expect(review.dropped).toBe(2);
    expect(progress).toContain("part 1: 1 finding(s) from anthropic/claude-sonnet-5-5 (2 below the risk threshold dropped)");
  });

  it("says nothing about dropping when nothing was dropped", async () => {
    const review = await runModelReview(answering([{ likelihood: 5, severity: 1, category: "x", message: "edge" }]), sonnet, one(diff.slice(0, 600)));
    expect(review.findings).toHaveLength(1);
    expect(review.dropped).toBeUndefined();
  });

  it("dedupes across parts keeping the higher risk, filters once after merging, sorts by risk then severity, and caps", async () => {
    const chat = answering(
      [{ likelihood: 3, severity: 4, category: "bug", file: "a.ts", message: "Loop never ends." }, { likelihood: 2, severity: 2, category: "x", message: "weak" }],
      [{ likelihood: 9, severity: 5, category: "bug", file: "a.ts", message: "loop never ends" }, { likelihood: 5, severity: 6, category: "bug", file: "b.ts", message: "same risk, more severe" }],
      [{ likelihood: 6, severity: 5, category: "bug", file: "c.ts", message: "same risk, less severe" }, { likelihood: 2, severity: 2, category: "x", message: "WEAK!" }],
    );
    const review = await runModelReview(chat, sonnet, one(diff));
    expect(review.findings.map((finding) => [finding.file ?? "-", finding.likelihood * finding.severity, finding.severity])).toEqual([["a.ts", 45, 5], ["b.ts", 30, 6], ["c.ts", 30, 5]]);
    // The two "weak" findings differ only in case and punctuation: one finding, dropped once.
    expect(review.dropped).toBe(1);
  });
});

describe("/review model review after a failed call", () => {
  it("retries on the same model, ledgers each call against it, and leaves `passed` alone", async () => {
    // models.review is the only candidate: the first call fails like the live stream did, the retry succeeds.
    let n = 0;
    const { chat, calls } = fakeChat(() => n++ === 0);
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), chat });
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    writeFileSync(path.join(cwd, "src", "ingest.ts"), "export const ingest = 1;\n");
    const result = await app.review();
    expect(result.ok, result.text).toBe(true);
    expect(calls.map((call) => call.provider)).toEqual(["anthropic", "anthropic"]);

    const dir = path.join(app.store.root, "reports");
    const newest = (ext: string) => readFileSync(path.join(dir, readdirSync(dir).filter((name) => name.endsWith(ext)).sort().at(-1)!), "utf8");
    const report = JSON.parse(newest(".json")) as ReviewReport;
    expect(report.passed).toBe(true);
    expect(report.findings.some((finding) => finding.message.includes("from"))).toBe(false);
    expect(report.modelReview!.findings).toHaveLength(1);
    expect(report.modelReview!.parts![0]!.failures).toEqual([expect.stringContaining(STREAM_ERROR)]);
    // One call has an unknown cost, so the pass's cost is unknown, not the other call's price.
    expect(report.modelReview!.costUsd).toBeNull();
    expect(newest(".md")).toMatch(/\| Model review \| \S+\/\S+ · 1 finding · part 1 retried \(after \S+\/\S+: OpenAI Responses stream ended/);

    const ledger = app.store.readLedger().filter((entry) => entry.reason === "model review");
    expect(ledger.map((entry) => [entry.provider, entry.model, entry.outcome, entry.retries, entry.tier])).toEqual([
      ["anthropic", "claude-opus-5-5", "failure", 0, "review"],
      ["anthropic", "claude-opus-5-5", "success", 1, "review"],
    ]);
    expect(ledger[0]!.actualUsd).toBeNull();
    expect(ledger[1]!.actualUsd).not.toBeNull();
  });
});

describe("/review model pass routing", () => {
  const chatFor = (fail: (model: string) => boolean) => {
    const models: string[] = [];
    const chat: ChatFn = async (candidate) => {
      models.push(`${candidate.provider}/${candidate.model}`);
      if (fail(candidate.model)) throw new Error("boom");
      return { text: "[]", usage, provider: candidate.provider, model: candidate.model };
    };
    return { chat, models };
  };
  const changed = async (config: ReturnType<typeof tieredConfig>, chat: ChatFn) => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { config, chat });
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    writeFileSync(path.join(cwd, "src", "ingest.ts"), "export const ingest = 1;\n");
    return app;
  };

  it("uses models.review, one call, and a route event", async () => {
    const { chat, models } = chatFor(() => false);
    const app = await changed(tieredConfig(), chat);
    expect((await app.review()).ok).toBe(true);
    expect(models).toEqual(["anthropic/claude-opus-5-5"]);
  });

  it("uses another Pi model when models.review names one", async () => {
    const { chat, models } = chatFor(() => false);
    const app = await changed(tieredConfig("models: { review: openai/gpt-6.1-sol:high }\n"), chat);
    expect((await app.review()).ok).toBe(true);
    expect(models).toEqual(["openai/gpt-6.1-sol"]);
  });

  it("retries once on the same model when it fails, and reports the error without failing the review", async () => {
    const { chat, models } = chatFor(() => true);
    const app = await changed(tieredConfig(), chat);
    const result = await app.review();
    expect(result.ok).toBe(true);
    expect(models).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"]);
  });

  it("makes no one-shot call when models.review is an agent: with no herdr client the model stage is unavailable, saying why", async () => {
    const { chat, models } = chatFor(() => false);
    const reports: string[] = [];
    const app = await changed(tieredConfig("models: { review: 'agent:claude/opus' }\n"), chat);
    (app as unknown as { ctx: { report?: (markdown: string) => void } }).ctx.report = (markdown) => void reports.push(markdown);
    const result = await app.review();
    expect(result.ok).toBe(true);
    expect(models).toEqual([]);
    expect(reports.join("\n")).toContain("agent:claude/opus reviews in a herdr tab; start Pi inside herdr");
  });
});
