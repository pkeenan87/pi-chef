import { describe, expect, it } from "vitest";
import { record } from "../src/orchestrator/budget.js";
import { ADVISOR_REASONING_HEADROOM, advisorRequestLimit, advisorsFor, availableAdvisors, consultAdvisors, parseAdvisorAnswer, type AdvisorCandidate } from "../src/review/advisors.js";
import { contextOf, fakeChat, sampleTicket, tempRepo, tieredConfig, ticketWorkflow, withAdvisors } from "./helpers.js";

const astra: AdvisorCandidate = { provider: "openai", model: "gpt-6-astra" };
const fable: AdvisorCandidate = { provider: "anthropic", model: "claude-fable-5-1" };
const foundryAstra: AdvisorCandidate = { provider: "foundry", model: "gpt-6-astra" };
const all = [astra, fable, foundryAstra];

describe("advisorsFor", () => {
  it("consults nobody for a low ticket", () => {
    expect(advisorsFor({ difficulty: "low", implementerProvider: "xai", candidates: all })).toEqual([]);
  });

  it("picks exactly one advisor from another provider for a medium ticket", () => {
    const pick = (implementerProvider: string) => advisorsFor({ difficulty: "medium", implementerProvider, candidates: all });
    expect(pick("anthropic")).toEqual([astra]);
    expect(pick("openai")).toEqual([fable]);
    expect(pick("xai")).toEqual([astra]);
    expect(pick("local")).toEqual([astra]);
    // No advisor from another provider: none, never the implementer's own provider.
    expect(advisorsFor({ difficulty: "medium", implementerProvider: "anthropic", candidates: [fable] })).toEqual([]);
  });

  it("takes every advisor, one per provider, for a high ticket", () => {
    expect(advisorsFor({ difficulty: "high", implementerProvider: "openai", candidates: all })).toEqual([astra, fable]);
    expect(advisorsFor({ difficulty: "high", implementerProvider: "openai", candidates: [astra, { provider: "openai", model: "other" }, fable] })).toEqual([astra, fable]);
  });

  it("uses the Foundry deployment when the OpenAI one is not available", () => {
    expect(advisorsFor({ difficulty: "high", implementerProvider: "xai", candidates: [fable, foundryAstra] })).toEqual([fable, foundryAstra]);
  });
});

describe("parseAdvisorAnswer", () => {
  const body = { answers: [{ question: "q", answer: "a" }], concerns: [{ severity: "HIGH", file: "a.ts", issue: "bad", suggestion: "fix" }, { issue: "meh" }, { severity: "low" }], verdict: "Disagree" };
  it("reads plain, fenced and embedded JSON", () => {
    const expected = { answers: [{ question: "q", answer: "a" }], concerns: [{ severity: "high", file: "a.ts", issue: "bad", suggestion: "fix" }, { severity: "medium", issue: "meh" }], verdict: "disagree" };
    expect(parseAdvisorAnswer(JSON.stringify(body))).toEqual(expected);
    expect(parseAdvisorAnswer(`Sure:\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``)).toEqual(expected);
    expect(parseAdvisorAnswer(`My view: ${JSON.stringify(body)} done`)).toEqual(expected);
  });
  it("is undefined for prose or an unrelated object", () => {
    expect(parseAdvisorAnswer("looks fine to me")).toBeUndefined();
    expect(parseAdvisorAnswer('{"foo": 1}')).toBeUndefined();
    expect(parseAdvisorAnswer("[]")).toBeUndefined();
  });
});

const OPINION = JSON.stringify({ answers: [{ question: "Is it safe?", answer: "Yes." }], concerns: [{ severity: "low", issue: "naming" }], verdict: "agree" });

async function setup(mutate: (config: ReturnType<typeof tieredConfig>) => void = () => undefined) {
  const config = withAdvisors(tieredConfig());
  mutate(config);
  const { app, taskId } = await ticketWorkflow([sampleTicket("01")], { config }, { approve: false, cwd: await tempRepo() });
  return { ctx: contextOf(app), app, taskId };
}

describe("consultAdvisors", () => {
  it("calls the advisors in parallel: both requests start before either resolves", async () => {
    const t = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const { chat, calls } = fakeChat(async () => {
      started += 1;
      await gate;
      return OPINION;
    });
    t.ctx.chat = chat;
    const pending = consultAdvisors(t.ctx, { purpose: "ticket review", packet: "P", questions: ["Q1"], candidates: [astra, fable], taskId: t.taskId, ticketId: "01" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(2);
    expect(calls.map((call) => call.model).sort()).toEqual(["claude-fable-5-1", "gpt-6-astra"]);
    release();
    const result = await pending;
    expect(result.results.map((item) => item.verdict)).toEqual(["agree", "agree"]);
  });

  it("sends the packet and the questions only, with the output cap", async () => {
    const t = await setup((config) => void (config.advisors.maxOutputTokens = 1200));
    const { chat, calls } = fakeChat(() => OPINION);
    t.ctx.chat = chat;
    await consultAdvisors(t.ctx, { purpose: "ticket review", packet: "# Ticket\nSecret token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here", questions: ["Q one?", "Q two?"], candidates: [astra], taskId: t.taskId });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain("# Questions\n1. Q one?\n2. Q two?");
    expect(calls[0]!.user).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(calls[0]!.system).toContain("at most ~1200 tokens");
    expect(calls[0]!.maxTokens).toBe(1200 + ADVISOR_REASONING_HEADROOM);
    expect(advisorRequestLimit(1500)).toBe(3548);
  });

  it("ledgers each call under the task's phase with the purpose, ticket and real price", async () => {
    const t = await setup();
    const { chat } = fakeChat(() => ({ text: OPINION, usage: { input: 1_000_000, output: 100_000 } }));
    t.ctx.chat = chat;
    const result = await consultAdvisors(t.ctx, { purpose: "ticket review", packet: "P", questions: ["Q"], candidates: [astra, fable], taskId: t.taskId, ticketId: "01" });
    const rows = t.ctx.store.readLedger().filter((row) => row.reason.startsWith("advisor"));
    expect(rows.map((row) => row.reason)).toEqual(["advisor ticket review ticket 01", "advisor ticket review ticket 01"]);
    const phase = t.ctx.store.load(t.taskId)!.phase;
    expect(rows.every((row) => row.phase === phase && row.taskId === t.taskId)).toBe(true);
    const byModel = Object.fromEntries(rows.map((row) => [row.model, row.actualUsd]));
    // Astra is a $0 subscription; Fable is billed per token: 1M in at $20 plus 0.1M out at $100.
    expect(byModel).toEqual({ "gpt-6-astra": 0, "claude-fable-5-1": 30 });
    expect(result.costUsd).toBe(30);
  });

  it("records a failed or unparseable advisor as an error and counts the others", async () => {
    const t = await setup();
    const { chat } = fakeChat((call) => {
      if (call.provider === "openai") throw new Error("boom");
      return "I think it is fine.";
    });
    t.ctx.chat = chat;
    const first = await consultAdvisors(t.ctx, { purpose: "ticket review", packet: "P", questions: ["Q"], candidates: [astra, fable], taskId: t.taskId });
    expect(first.results[0]).toMatchObject({ provider: "openai", model: "gpt-6-astra", error: "boom", costUsd: null });
    expect(first.results[1]!.error).toContain("not the JSON shape");
    expect(first.costUsd).toBeNull();
    const mixed = fakeChat((call) => {
      if (call.provider === "openai") throw new Error("boom");
      return OPINION;
    });
    t.ctx.chat = mixed.chat;
    const second = await consultAdvisors(t.ctx, { purpose: "ticket review", packet: "P", questions: ["Q"], candidates: [astra, fable], taskId: t.taskId });
    expect(second.results.map((item) => item.error ?? item.verdict)).toEqual(["boom", "agree"]);
    const failed = t.ctx.store.readLedger().filter((row) => row.reason.startsWith("advisor") && row.outcome === "failure");
    expect(failed.some((row) => row.actualUsd === null)).toBe(true);
  });

  it("times out a slow advisor", async () => {
    const t = await setup((config) => void (config.advisors.timeoutMs = 1000));
    const { chat } = fakeChat(
      (call) =>
        new Promise((resolve, reject) => {
          if (call.provider === "openai") call.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          else resolve(OPINION);
        }),
    );
    t.ctx.chat = chat;
    const result = await consultAdvisors(t.ctx, { purpose: "ticket review", packet: "P", questions: ["Q"], candidates: [astra, fable], taskId: t.taskId });
    expect(result.results[0]!.error).toContain("timed out after 1.0s");
    expect(result.results[1]!.verdict).toBe("agree");
  });

  it("skips every advisor when the budget is soft or hard, and says why", async () => {
    for (const [tokens, why] of [[3_000_000, "nearly spent"], [4_000_000, "exhausted"]] as const) {
      const t = await setup((config) => void (config.budgets.taskUsd = 10));
      const { chat, calls } = fakeChat(() => OPINION);
      t.ctx.chat = chat;
      record(t.ctx, t.taskId, "PLANNING", "standard", "anthropic", "claude-sonnet-5-5", { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 }, "success", 0, "setup");
      const result = await consultAdvisors(t.ctx, { purpose: "ticket review", packet: "P", questions: ["Q"], candidates: [astra, fable], taskId: t.taskId });
      expect(result.results).toEqual([]);
      expect(result.skipped).toContain(why);
      expect(calls).toHaveLength(0);
    }
  });

  it("skips with a reason when there is no connection or no candidate", async () => {
    const t = await setup();
    expect((await consultAdvisors(t.ctx, { purpose: "x", packet: "P", questions: [], candidates: [astra], taskId: t.taskId })).skipped).toContain("no model connection");
    t.ctx.chat = fakeChat(() => OPINION).chat;
    expect((await consultAdvisors(t.ctx, { purpose: "x", packet: "P", questions: [], candidates: [], taskId: t.taskId })).skipped).toContain("no advisor");
  });
});

describe("availableAdvisors", () => {
  it("skips advisors whose provider is not signed in and notes it", async () => {
    const t = await setup();
    t.ctx.authProbe = { inspect: async (provider) => ({ provider, status: provider === "openai" ? "missing" : "ready", method: "oauth", detail: provider === "openai" ? "not signed in" : "ready" }) };
    const found = await availableAdvisors(t.ctx);
    expect(found.candidates.map((item) => `${item.provider}/${item.model}`)).toEqual(["anthropic/claude-fable-5-1", "foundry/gpt-6-astra"]);
    expect(found.notes[0]).toContain("openai/gpt-6-astra skipped");
  });
});
