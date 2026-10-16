import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanConsultTool, createPlanSpecTool, createPlanTicketsTool } from "../src/tools/plan-flow.js";
import { record } from "../src/orchestrator/budget.js";
import { contextOf, fakeChat, tempRepo, tieredConfig, withAdvisors, workflow, type FakeCall } from "./helpers.js";

type Exec = (id: string, params: never, signal: undefined, onUpdate: undefined, ctx: never) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
const call = (tool: { execute: unknown }, params: unknown, ctx: unknown) => (tool.execute as Exec)("1", params as never, undefined, undefined, ctx as never);
const textOf = (result: { content: { text: string }[] }) => result.content.map((item) => item.text).join("\n");
const headless = { hasUI: false, ui: {} };

const ticket = (id: string, extra: Record<string, unknown> = {}) => ({ id, slug: `t${id}`, title: `Ticket ${id}`, whatToBuild: "Users can retry a failed ingest end to end.", acceptanceCriteria: ["retry works"], blockedBy: [] as string[], estimatedContextTokens: 40000, ...extra });
const specParams = { summary: "Retry failed ingests.", context: "src/ingest.ts parses and drops failures.", approach: "Wrap parse() in retryParse() with a fixed backoff.", changes: [{ path: "src/ingest.ts", change: "add retryParse(input, attempts)" }], reuse: [], verification: ["npm test"], decisions: [], assumptions: [], outOfScope: [], risks: [] };
const questions = ["Is the backoff bounded?", "Could retries duplicate events?"];

const opinion = (verdict: string, concerns: object[] = []) => JSON.stringify({ answers: [{ question: "Is the backoff bounded?", answer: "Fixed, so yes." }], concerns, verdict });

async function setup(options: { answer?: (call: FakeCall) => string; advisors?: boolean; mutate?: (config: ReturnType<typeof tieredConfig>) => void; chat?: boolean } = {}) {
  const config = withAdvisors(tieredConfig());
  if (options.advisors === false) config.tiers.advisor = [];
  options.mutate?.(config);
  const fake = fakeChat(options.answer ?? ((c) => (c.provider === "openai" ? opinion("disagree", [{ severity: "high", file: "src/ingest.ts", issue: "duplicate events" }]) : opinion("agree"))));
  const app = workflow(await tempRepo(), { config, chat: options.chat === false ? undefined : fake.chat, startTurn: () => undefined });
  expect((await app.startPlan("Add retry to the Neo ingest parser", { noQuestions: true })).ok).toBe(true);
  await call(createPlanSpecTool(() => app), specParams, headless);
  return { app, calls: fake.calls, consult: createPlanConsultTool(() => app), tickets: createPlanTicketsTool(() => app) };
}

const fakeTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

/** A UI whose plan dialog renders the markdown it was given and answers from `script`. */
function dialog(script: unknown[]) {
  const rendered: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      custom: async (factory: (...args: never[]) => { render(width: number): string[] }) => {
        const component = (factory as unknown as (...args: unknown[]) => { render(width: number): string[] })({ terminal: { rows: 400 }, requestRender() {} }, fakeTheme, {}, () => undefined);
        rendered.push(component.render(160).join("\n"));
        return script.shift();
      },
      notify: () => undefined,
      editor: async () => undefined,
    },
  };
  return { ctx, rendered };
}

const planDir = (app: { store: { taskDir(id: string): string }; activeTaskId(): string | undefined }) => app.store.taskDir(app.activeTaskId()!);

describe("plan_consult", () => {
  it("asks every advisor in parallel with the spec, the draft tickets and the questions, and never a transcript", async () => {
    const { app, calls, consult } = await setup();
    const result = await call(consult, { tickets: [ticket("01", { implementation: "Add retryParse()." })], questions }, headless);
    const advisors = calls.filter((item) => item.system.includes("engineering advisor"));
    expect(advisors.map((item) => `${item.provider}/${item.model}`).sort()).toEqual(["anthropic/claude-fable-5-1", "openai/gpt-6-astra"]);
    for (const item of advisors) {
      expect(item.user).toContain("Retry failed ingests.");
      expect(item.user).toContain("Wrap parse() in retryParse()");
      expect(item.user).toContain("### 01: Ticket 01");
      expect(item.user).toContain("Add retryParse().");
      expect(item.user).toContain("1. Is the backoff bounded?");
      expect(item.user).toContain("2. Could retries duplicate events?");
      expect(item.system).not.toContain("Add retry to the Neo ingest parser");
    }
    const text = textOf(result);
    expect(text).toContain("duplicate events");
    expect(text).toContain("Resolve any disagreement yourself. Then call plan_tickets with the final tickets and `advisorResolution`: what you accepted, what you rejected, and why.");
    const stored = app.store.load(app.activeTaskId()!)!.planning!.consult!;
    expect(stored).toMatchObject({ version: 1, questions });
    expect(stored.results).toHaveLength(2);
    expect(typeof stored.at).toBe("string");
  });

  it("runs once per draft: the second call returns the stored results with no model calls", async () => {
    const { calls, consult } = await setup();
    await call(consult, { tickets: [ticket("01")], questions }, headless);
    const before = calls.length;
    const again = await call(consult, { tickets: [ticket("01")], questions: ["Something else?", "And this?"] }, headless);
    expect(calls.length).toBe(before);
    expect(textOf(again)).toContain("already consulted");
    expect(textOf(again)).toContain("duplicate events");
  });

  it("never calls an advisor the org allowlist excludes", async () => {
    const { calls, consult } = await setup({ mutate: (config) => { config.proprietaryCode = true; config.orgProviderAllowlist = ["anthropic"]; } });
    await call(consult, { tickets: [ticket("01")], questions }, headless);
    expect(calls.map((item) => item.model)).toEqual(["claude-fable-5-1"]);
  });

  it("a changed draft consults again (at most maxPlanConsults times); the same draft never does", async () => {
    const { app, calls, consult } = await setup();
    await call(consult, { tickets: [ticket("01")], questions }, headless);
    const first = calls.length;
    const changed = await call(consult, { tickets: [ticket("01", { whatToBuild: "Users retry a failed ingest, with a cap." })], questions }, headless);
    expect(calls.length).toBe(first * 2);
    expect(textOf(changed)).not.toContain("already consulted");
    expect(app.store.load(app.activeTaskId()!)!.planning!.consult!.consults).toBe(2);
    const third = await call(consult, { tickets: [ticket("01", { whatToBuild: "A third, different draft." })], questions }, headless);
    expect(calls.length).toBe(first * 2);
    expect(textOf(third)).toContain("most times allowed");
  });

  it("two parallel calls pay once", async () => {
    const { calls, consult } = await setup();
    const [a, b] = await Promise.all([call(consult, { tickets: [ticket("01")], questions }, headless), call(consult, { tickets: [ticket("01")], questions }, headless)]);
    expect(calls).toHaveLength(2);
    expect(textOf(a)).toBe(textOf(b));
  });

  it("validates the tickets and the number of questions, and only works after plan_spec", async () => {
    const { consult } = await setup();
    await expect(call(consult, { tickets: [ticket("01", { acceptanceCriteria: [] })], questions }, headless)).rejects.toThrow(/acceptance criterion/);
    await expect(call(consult, { tickets: [ticket("01")], questions: ["only one"] }, headless)).rejects.toThrow(/2 or 3/);
    const cwd = await tempRepo();
    const app = workflow(cwd, { config: withAdvisors(tieredConfig()), chat: fakeChat(() => opinion("agree")).chat, startTurn: () => undefined });
    await app.startPlan("Add retry to the Neo ingest parser", { noQuestions: true });
    await expect(call(createPlanConsultTool(() => app), { tickets: [ticket("01")], questions }, headless)).rejects.toThrow(/plan_spec/);
  });
});

describe("plan_tickets with advisors", () => {
  it("refuses without a consult, then without a resolution", async () => {
    const { consult, tickets } = await setup();
    await expect(call(tickets, { tickets: [ticket("01")] }, headless)).rejects.toThrow(/Call plan_consult first/);
    await call(consult, { tickets: [ticket("01")], questions }, headless);
    await expect(call(tickets, { tickets: [ticket("01")] }, headless)).rejects.toThrow(/advisorResolution is required/);
    await expect(call(tickets, { tickets: [ticket("01")], advisorResolution: "   " }, headless)).rejects.toThrow(/advisorResolution is required/);
  });

  it("refuses tickets that changed since the consult, unless the change is waived with a reason", async () => {
    const { app, consult, tickets } = await setup();
    await call(consult, { tickets: [ticket("01")], questions }, headless);
    const edited = [ticket("01", { acceptanceCriteria: ["retry works", "retry is capped"] })];
    await expect(call(tickets, { tickets: edited, advisorResolution: "fine" }, headless)).rejects.toThrow(/The tickets changed since plan_consult; call plan_consult again for this draft/);
    await expect(call(tickets, { tickets: edited, reconsultWaived: true }, headless)).rejects.toThrow(/advisorResolution is required/);
    await call(tickets, { tickets: edited, advisorResolution: "Only added a criterion; no design change.", reconsultWaived: true }, headless);
    expect(app.store.load(app.activeTaskId()!)!.plan!.advisorReview!.reconsultWaived).toBe(true);
    expect(readFileSync(path.join(planDir(app), "plan.md"), "utf8")).toContain("waived a new consult");
  });

  it("accepts the consulted tickets unchanged without a waiver", async () => {
    const { app, consult, tickets } = await setup();
    await call(consult, { tickets: [ticket("01")], questions }, headless);
    await call(tickets, { tickets: [ticket("01")], advisorResolution: "ok" }, headless);
    expect(app.store.load(app.activeTaskId()!)!.plan!.advisorReview!.reconsultWaived).toBeUndefined();
  });

  it("does not require them when no advisor is available, or when advisors.plan is off", async () => {
    const none = await setup({ advisors: false });
    const done = await call(none.tickets, { tickets: [ticket("01")] }, headless);
    expect(textOf(done)).toContain("1 tickets written");
    expect(readFileSync(path.join(planDir(none.app), "plan.md"), "utf8")).toContain("Advisors were not consulted: none is available.");
    const off = await setup({ mutate: (config) => void (config.advisors.plan = false) });
    expect(textOf(await call(off.tickets, { tickets: [ticket("01")] }, headless))).toContain("1 tickets written");
    expect(off.calls).toHaveLength(0);
    expect(readFileSync(path.join(planDir(off.app), "plan.md"), "utf8")).not.toContain("Advisor review");
  });

  it("does not require a resolution when the budget skipped the advisors", async () => {
    const { app, consult, tickets, calls } = await setup({ mutate: (config) => void (config.budgets.taskUsd = 0.0001) });
    const ctx = contextOf(app);
    // Spend past the soft limit on the task so the consult is skipped.
    record(ctx, app.activeTaskId()!, "PLANNING", "standard", "anthropic", "claude-sonnet-5-5", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, requests: 1 }, "success", 0, "test");
    const result = await call(consult, { tickets: [ticket("01")], questions }, headless);
    expect(textOf(result)).toContain("No advisor was consulted");
    expect(calls).toHaveLength(0);
    expect(textOf(await call(tickets, { tickets: [ticket("01")] }, headless))).toContain("1 tickets written");
    expect(readFileSync(path.join(planDir(app), "plan.md"), "utf8")).toContain("Advisors were not consulted");
  });

  it("shows the advisor review and the resolution at the top of the dialog and in plan.md", async () => {
    const { app, consult, tickets } = await setup();
    await call(consult, { tickets: [ticket("01")], questions }, headless);
    const resolution = "Accepted the duplicate-events point (added an idempotency check); rejected nothing else.";
    const ui = dialog([{ value: "save" }]);
    const done = await call(tickets, { tickets: [ticket("01")], advisorResolution: resolution }, ui.ctx);
    expect(textOf(done)).toContain("1 tickets written");
    const shown = ui.rendered[0]!;
    expect(shown).toContain("Advisor review");
    expect(shown).toContain("openai/gpt-6-astra: disagree");
    expect(shown).toContain(`Opus resolution: ${resolution}`);
    expect(shown.indexOf("Advisor review")).toBeLessThan(shown.indexOf("Summary"));
    const planMd = readFileSync(path.join(planDir(app), "plan.md"), "utf8");
    expect(planMd.indexOf("## Advisor review")).toBeGreaterThan(-1);
    expect(planMd.indexOf("## Advisor review")).toBeLessThan(planMd.indexOf("## Summary"));
    expect(planMd).toContain("- openai/gpt-6-astra: disagree");
    expect(planMd).toContain("HIGH src/ingest.ts: duplicate events");
    expect(planMd).toContain("- anthropic/claude-fable-5-1: agree");
    expect(planMd).toContain(`Opus resolution: ${resolution}`);
    expect(planMd).toContain("Advisors advise; approval is yours.");
    expect(app.store.load(app.activeTaskId()!)!.plan!.advisorReview!.resolution).toBe(resolution);
  });

  it("lists an advisor error in the review", async () => {
    const { app, consult, tickets } = await setup({ answer: (c) => { if (c.provider === "openai") throw new Error("boom"); return opinion("agree"); } });
    await call(consult, { tickets: [ticket("01")], questions }, headless);
    await call(tickets, { tickets: [ticket("01")], advisorResolution: "Fable agrees; Astra failed." }, headless);
    expect(readFileSync(path.join(planDir(app), "plan.md"), "utf8")).toContain("- openai/gpt-6-astra: did not answer (boom)");
  });

  it("a revision after Request changes is a new draft and may consult again", async () => {
    const { app, calls, consult, tickets } = await setup();
    await call(consult, { tickets: [ticket("01")], questions }, headless);
    const ui = dialog([{ value: "revise", text: "split it" }]);
    const sent = await call(tickets, { tickets: [ticket("01")], advisorResolution: "kept as is" }, ui.ctx);
    expect(textOf(sent)).toContain("split it");
    expect(textOf(sent)).toContain("plan_consult again");
    expect(app.store.load(app.activeTaskId()!)!.planning!.consult).toBeUndefined();
    await expect(call(tickets, { tickets: [ticket("01"), ticket("02")], advisorResolution: "x" }, headless)).rejects.toThrow(/Call plan_consult first/);
    const before = calls.length;
    await call(consult, { tickets: [ticket("01"), ticket("02")], questions }, headless);
    expect(calls.length).toBeGreaterThan(before);
  });
});

describe("planning rules", () => {
  it("tell the model to consult, resolve and then submit", async () => {
    const { INTERVIEW_RULES, NO_QUESTIONS_RULES, REVISION_RULES, TICKET_RULES } = await import("../src/orchestrator/prompts.js");
    for (const rules of [INTERVIEW_RULES, NO_QUESTIONS_RULES, REVISION_RULES, TICKET_RULES(150000)]) {
      expect(rules).toContain("plan_consult");
      expect(rules).toContain("advisorResolution");
    }
    expect(INTERVIEW_RULES.startsWith("[PLAN INTERVIEW]")).toBe(true);
    expect(TICKET_RULES(150000).startsWith("[PLAN TICKETS]")).toBe(true);
  });
});
