import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanDocument, ReviewReport, RoutingDecision } from "../src/domain.js";
import type { WorkflowContext } from "../src/orchestrator/context.js";
import { reviewCandidates } from "../src/orchestrator/review.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import { modelReviewLines, parseModelFindings, runModelReview, type ModelReviewCall } from "../src/review/model-review.js";
import { tempRepo, tieredConfig, workflow } from "./helpers.js";

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 };
const STREAM_ERROR = "OpenAI Responses stream ended before a terminal response event";
const plan: PlanDocument = { version: 1, createdAt: "2026-10-15T00:00:00.000Z", summary: "Add retry.", risks: [], acceptance: ["retry works"], estimatedUsd: null, groups: [], overlap: [], securitySensitive: false };
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
    return { text: JSON.stringify([{ severity: "low", category: "tests", message: `from ${candidate.provider}` }]), usage, provider: candidate.provider, model: candidate.model };
  };
  return { chat, calls };
}

describe("model review retries", () => {
  it("retries a failed part on the next candidate and keeps going with the parts after it", async () => {
    const { chat, calls } = fakeChat((provider) => provider === "xai");
    const recorded: ModelReviewCall[] = [];
    const review = await runModelReview(chat, [grok, sonnet], { plan, diff, maxDiffChars: 700, onCall: (call) => void recorded.push(call) });
    // Part 1 failed on grok and was retried on sonnet; later parts start on the candidate that has not failed.
    expect(calls.map((call) => `${call.part}:${call.provider}`)).toEqual(["1:xai", "1:anthropic", "2:anthropic", "3:anthropic"]);
    expect(recorded.map((call) => [call.candidate.provider, call.part, call.retry, call.outcome])).toEqual([
      ["xai", 1, 0, "failure"],
      ["anthropic", 1, 1, "success"],
      ["anthropic", 2, 0, "success"],
      ["anthropic", 3, 0, "success"],
    ]);
    // The failed call's usage is unknown, never zero.
    expect(recorded[0]!.usage).toMatchObject({ input: null, output: null });
    expect(review.findings).toHaveLength(3);
    expect(review.error).toBeUndefined();
    expect(review.parts!.map((part) => part.reviewedBy)).toEqual(["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5"]);
    const lines = modelReviewLines(review);
    expect(lines[0]).toMatch(/^Model review \(anthropic\/claude-sonnet-5-5; 3 parts\): 3 finding\(s\)\.$/);
    expect(lines).toContain(`- part 1 of 3: anthropic/claude-sonnet-5-5, 1 finding(s) (after xai/grok-4.7: ${STREAM_ERROR})`);
    expect(lines).toContain("- part 2 of 3: anthropic/claude-sonnet-5-5, 1 finding(s)");
  });

  it("lists a part that failed on every candidate and still reviews the others", async () => {
    const { chat, calls } = fakeChat((_provider, user) => user.includes("part 2 of 3"));
    const review = await runModelReview(chat, [grok, sonnet], { plan, diff, maxDiffChars: 700 });
    expect(calls.map((call) => call.part)).toEqual(["1", "2", "2", "3"]);
    expect(review.findings).toHaveLength(2);
    expect(review.error).toBe("part(s) 2 of 3 were not reviewed");
    const lines = modelReviewLines(review);
    // Both candidates failed once, so part 3 went back to the routed one.
    expect(review.parts!.map((part) => part.reviewedBy)).toEqual(["xai/grok-4.7", undefined, "xai/grok-4.7"]);
    expect(lines[0]).toBe("Model review (xai/grok-4.7; 3 parts): 2 finding(s).");
    expect(lines).toContain(`- part 2 of 3: NOT reviewed — xai/grok-4.7: ${STREAM_ERROR}; anthropic/claude-sonnet-5-5: ${STREAM_ERROR}`);
    expect(lines.at(-1)).toBe("- note: part(s) 2 of 3 were not reviewed");
  });

  it("retries an answer that is not a findings list on the next candidate, and stops when told to", async () => {
    let n = 0;
    const chat: ChatFn = async (candidate) => ({ text: n++ === 0 ? "I could not review this." : "[]", usage, provider: candidate.provider, model: candidate.model });
    const review = await runModelReview(chat, [grok, sonnet], { plan, diff, maxDiffChars: 700, stop: () => (n >= 2 ? "the task or daily budget is exhausted" : undefined) });
    expect(n).toBe(2);
    expect(review.parts!.map((part) => [part.reviewedBy, part.failures])).toEqual([
      ["anthropic/claude-sonnet-5-5", ["xai/grok-4.7: the answer was not a JSON list of findings: I could not review this."]],
      [undefined, ["not attempted: the task or daily budget is exhausted"]],
      [undefined, ["not attempted: the task or daily budget is exhausted"]],
    ]);
  });

  it("reviews a part on the next candidate after garbage, names both, ledgers the garbage call as a failure, and redacts the excerpt", async () => {
    const answers = new Map([["xai", "Sorry, token=abcdef123456 is all I can say."], ["anthropic", JSON.stringify([{ severity: "low", category: "tests", message: "from anthropic" }])]]);
    const chat: ChatFn = async (candidate) => ({ text: answers.get(candidate.provider)!, usage, provider: candidate.provider, model: candidate.model });
    const recorded: ModelReviewCall[] = [];
    const review = await runModelReview(chat, [grok, sonnet], { plan, diff: diff.slice(0, 600), maxDiffChars: 700, onCall: (call) => void recorded.push(call) });
    expect(recorded.map((call) => [call.candidate.provider, call.retry, call.outcome])).toEqual([["xai", 0, "failure"], ["anthropic", 1, "success"]]);
    expect(review.error).toBeUndefined();
    expect(review.findings).toHaveLength(1);
    expect(review.parts![0]).toMatchObject({ reviewedBy: "anthropic/claude-sonnet-5-5" });
    const failure = review.parts![0]!.failures[0]!;
    expect(failure).toContain("xai/grok-4.7: the answer was not a JSON list of findings");
    expect(failure).toContain("[REDACTED]");
    expect(failure).not.toContain("abcdef123456");
    const line = modelReviewLines(review).find((item) => item.startsWith("- part 1"))!;
    expect(line).toContain("anthropic/claude-sonnet-5-5");
    expect(line).toContain("after xai/grok-4.7");
  });

  it("marks the part not reviewed when every candidate answers with garbage", async () => {
    const chat: ChatFn = async (candidate) => ({ text: "no list here", usage, provider: candidate.provider, model: candidate.model });
    const review = await runModelReview(chat, [grok, sonnet], { plan, diff: diff.slice(0, 600), maxDiffChars: 700 });
    expect(review.parts![0]!.failures).toHaveLength(2);
    expect(review.error).toContain("the call failed");
  });

  it("parses fenced JSON, a list inside prose, and an object with findings", () => {
    const one = '[{"severity":"high","message":"bad"}]';
    expect(parseModelFindings("```json\n" + one + "\n```")).toHaveLength(1);
    expect(parseModelFindings("Here is my review (see [1] below):\n" + one + "\nHope that helps.")).toEqual([{ severity: "high", category: "general", message: "bad" }]);
    expect(parseModelFindings('{"findings": ' + one + "}")).toHaveLength(1);
    expect(parseModelFindings('Result: {"findings": ' + one + "} done")).toHaveLength(1);
    expect(parseModelFindings('[{"message":"has ] and [ inside"}] trailing')).toEqual([{ severity: "medium", category: "general", message: "has ] and [ inside" }]);
    expect(parseModelFindings("see [1] and [2]")).toBeUndefined();
    expect(parseModelFindings("no list")).toBeUndefined();
  });

  it("orders the review tier: routed candidate, then another provider, then by score; excluded ones are left out", () => {
    const config = tieredConfig();
    config.tiers.standard = [
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      { provider: "anthropic", model: "claude-haiku-5-5" },
      { provider: "foundry", model: "grok-4-7" },
      { provider: "openai", model: "gpt-6-luna" },
    ];
    const decision = {
      tier: "standard",
      candidate: { provider: "anthropic", model: "claude-sonnet-5-5" },
      considered: [
        { provider: "anthropic", model: "claude-sonnet-5-5", score: 0.01 },
        { provider: "anthropic", model: "claude-haiku-5-5", score: 0.001 },
        { provider: "foundry", model: "grok-4-7", score: 0.02 },
        { provider: "openai", model: "gpt-6-luna", excludedReason: "circuit_open" },
      ],
    } as unknown as RoutingDecision;
    const order = reviewCandidates({ config } as WorkflowContext, decision).map((item) => `${item.provider}/${item.model}`);
    expect(order).toEqual(["anthropic/claude-sonnet-5-5", "foundry/grok-4-7", "anthropic/claude-haiku-5-5"]);
  });
});

describe("/review model review after a failed call", () => {
  it("retries on another provider, ledgers each call against its own model, and leaves `passed` alone", async () => {
    // Whichever candidate the router picks first fails like the live xai stream did; the retry succeeds.
    let first: string | undefined;
    const { chat, calls } = fakeChat((provider) => (first ??= provider) === provider);
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: tieredConfig(), chat });
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    writeFileSync(path.join(cwd, "src", "ingest.ts"), "export const ingest = 1;\n");
    const result = await app.review();
    expect(result.ok, result.text).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.provider).not.toBe(calls[0]!.provider);

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
    expect(ledger.map((entry) => [entry.provider, entry.outcome, entry.retries])).toEqual([
      [calls[0]!.provider, "failure", 0],
      [calls[1]!.provider, "success", 1],
    ]);
    expect(ledger[0]!.actualUsd).toBeNull();
    expect(ledger[1]!.actualUsd).not.toBeNull();

    // Each candidate's metrics cell got only its own outcome.
    const cells = Object.values(app.store.readMetrics()).flatMap((row) => Object.entries(row)).filter(([key]) => key.startsWith("model:"));
    const byProvider = (provider: string) => cells.find(([key]) => key.includes(`:${provider}/`))![1];
    expect(byProvider(calls[0]!.provider)).toMatchObject({ success: 0, failure: 1 });
    expect(byProvider(calls[1]!.provider)).toMatchObject({ success: 1, failure: 0 });
  });
});

describe("/review model pass routing", () => {
  const opusOnly = () => {
    const config = tieredConfig();
    config.tiers.premium = [{ provider: "anthropic", model: "claude-opus-5-5" }];
    return config;
  };
  const chatFor = (fail: (model: string) => boolean) => {
    const models: string[] = [];
    const chat: ChatFn = async (candidate) => {
      models.push(candidate.model);
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

  it("routes to Opus and records the outcome under review:<type>", async () => {
    const { chat, models } = chatFor(() => false);
    const app = await changed(opusOnly(), chat);
    expect((await app.review()).ok).toBe(true);
    expect(models).toEqual(["claude-opus-5-5"]);
    const metrics = app.store.readMetrics();
    expect(Object.keys(metrics).length).toBeGreaterThan(0);
    expect(Object.keys(metrics).every((type) => type.startsWith("review:"))).toBe(true);
    expect(Object.values(metrics).flatMap((row) => Object.keys(row))).toContain("premium");
  });

  it("falls back to the standard tier when Opus fails", async () => {
    const { chat, models } = chatFor((model) => model === "claude-opus-5-5");
    const app = await changed(opusOnly(), chat);
    expect((await app.review()).ok).toBe(true);
    // The first standard candidate on another provider than Opus (the test config lists Sonnet, then Foundry Grok).
    expect(models).toEqual(["claude-opus-5-5", "grok-4-7"]);
  });
});
