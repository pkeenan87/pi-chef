import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMMANDS } from "../src/commands.js";
import { parseConfig } from "../src/config.js";
import extension, { bindWorkflow, registerWorkflow } from "../src/extension.js";
import type { InterviewAnswer, InterviewQuestion } from "../src/orchestrator/interview.js";
import { readInterview } from "../src/orchestrator/interview.js";
import { parseTicketsMarkdown, renderTicket, renderTicketsMarkdown } from "../src/orchestrator/tickets.js";
import { createPlanSpecTool, createPlanTicketsTool } from "../src/tools/plan-flow.js";
import { createPlanQuestionsTool, questionsDialog } from "../src/tools/plan-questions.js";
import { isReadOnlyCommand } from "../src/tools/readonly-bash.js";
import { testConfig, tempRepo, workflow } from "./helpers.js";

type Exec = (id: string, params: never, signal: undefined, onUpdate: undefined, ctx: never) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
const call = (tool: { execute: unknown }, params: unknown, ctx: unknown) => (tool.execute as Exec)("1", params as never, undefined, undefined, ctx as never);
const textOf = (result: { content: { text: string }[] }) => result.content.map((item) => item.text).join("\n");

function question(id: string, extra: Partial<InterviewQuestion> = {}): InterviewQuestion {
  return {
    id,
    title: id,
    prompt: `Which ${id}?`,
    options: [{ value: "a", label: "Option A" }, { value: "b", label: "Option B", description: "second" }],
    recommended: "a",
    reason: "simplest",
    ...extra,
  };
}

function ticket(id: string, extra: Record<string, unknown> = {}) {
  return { id, slug: `t${id}`, title: `Ticket ${id}`, whatToBuild: "Users can retry a failed ingest end to end.", acceptanceCriteria: ["retry works"], blockedBy: [] as string[], estimatedContextTokens: 40000, ...extra };
}

/** A fake ctx whose picker returns scripted labels. `custom` (a popup) must never be used; `selects` records each picker. */
function fakeCtx(script: { custom?: unknown[]; select?: (string | undefined)[]; editor?: (string | undefined)[] } = {}) {
  const log = { custom: 0, notices: [] as string[], selects: [] as { title: string; labels: string[] }[] };
  return {
    log,
    ctx: {
      hasUI: true,
      ui: {
        custom: async () => {
          log.custom += 1;
          return script.custom?.shift();
        },
        select: async (title: string, labels: string[]) => (log.selects.push({ title, labels }), script.select?.shift()),
        editor: async () => script.editor?.shift(),
        notify: (message: string) => void log.notices.push(message),
      },
    },
  };
}
const headless = { hasUI: false, ui: {} };
const accepted = (qs: InterviewQuestion[]) => ({ cancelled: false, answers: qs.map((q): InterviewAnswer => ({ id: q.id, value: q.recommended, label: "x", wasCustom: false, acceptedRecommendation: true })) });

async function planning(extras: { noQuestions?: boolean; request?: string } = {}) {
  const cwd = await tempRepo();
  const turns: string[] = [];
  const status: (string | undefined)[] = [];
  const app = workflow(cwd, { startTurn: (text) => void turns.push(text), planStatus: (text) => void status.push(text) });
  const started = await app.startPlan(extras.request ?? "Add retry to the ingest parser", { noQuestions: extras.noQuestions });
  expect(started.ok, started.text).toBe(true);
  const questions = createPlanQuestionsTool(() => app);
  const spec = createPlanSpecTool(() => app);
  const tickets = createPlanTicketsTool(() => app);
  return { cwd, app, turns, status, questions, spec, tickets };
}

const specParams = { summary: "Retry failed ingests.", context: "src/ingest.ts parses and drops failures.", approach: "Wrap parse() in retryParse() with a fixed backoff.", changes: [{ path: "src/ingest.ts", change: "add retryParse(input, attempts)" }], reuse: ["sleep() in src/util.ts"], verification: ["npm test"], decisions: [{ question: "Backoff?", answer: "Fixed", rationale: "simple" }], assumptions: ["Node 20"], outOfScope: ["Metrics"], risks: ["Duplicate events"] };

describe("plan interview start", () => {
  it("creates a PLANNING task, persists interview.json, records a route event, and starts a model turn", async () => {
    const { app, turns, status } = await planning();
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.phase).toBe("PLANNING");
    expect(task.planning).toEqual({ stage: "interview", noQuestions: false });
    expect(readInterview((app as never as { ctx: never })["ctx"], task.taskId)).toMatchObject({ request: "Add retry to the ingest parser", noQuestions: false, rounds: [] });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("Add retry to the ingest parser");
    expect(status.at(-1)).toBe("plan · interview round 1 (0/7 questions)");
    const events = readFileSync(path.join(app.store.taskDir(task.taskId), "events.jsonl"), "utf8");
    expect(events).toContain('"purpose":"interview"');
    expect(app.planningPrompt()).toContain("Never more than 7");
  });

  it("drafts directly for a literal tasks block or when the host cannot start a turn", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    expect((await app.startPlan("Rename a variable")).ok).toBe(true);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("AWAITING_PLAN_APPROVAL");
  });

  it("parses --no-questions from the /plan command", async () => {
    const cwd = await tempRepo();
    const turns: string[] = [];
    const app = workflow(cwd, { startTurn: (text) => void turns.push(text) });
    const spec = COMMANDS.find((item) => item.name === "plan")!;
    const result = await spec.run(app, "--no-questions Add retry to ingest", async () => true);
    expect(result.ok).toBe(true);
    expect(turns[0]).toContain("(no questions)");
    expect(turns[0]).not.toContain("--no-questions");
    expect(app.store.load(app.activeTaskId()!)!.planning?.noQuestions).toBe(true);
    expect(app.planningPrompt()).toContain("--no-questions");
  });
});

describe("plan_questions", () => {
  it("rejects a round over the 7-question cap and tells the model to finalize", async () => {
    const { questions } = await planning();
    const eight = Array.from({ length: 8 }, (_, i) => question(`q${i}`));
    await expect(call(questions, { round: 1, questions: eight }, headless)).rejects.toThrow(/exceed the 7-question cap[\s\S]*plan_spec/);
  });

  it("counts questions across rounds", async () => {
    const { questions, status } = await planning();
    await call(questions, { round: 1, questions: ["a", "b", "c", "d", "e"].map((id) => question(id)) }, headless);
    expect(status.at(-1)).toBe("plan · interview round 2 (5/7 questions)");
    await expect(call(questions, { round: 2, questions: ["f", "g", "h"].map((id) => question(id)) }, headless)).rejects.toThrow(/At most 2 more/);
    const last = await call(questions, { round: 2, questions: ["f", "g"].map((id) => question(id)) }, headless);
    expect(textOf(last)).toContain("The cap is reached. Call plan_spec now.");
    await expect(call(questions, { round: 3, questions: [question("z")] }, headless)).rejects.toThrow(/cap/);
  });

  it("enforces dependsOn ordering", async () => {
    const { questions } = await planning();
    await expect(call(questions, { round: 1, questions: [question("a"), question("b", { dependsOn: ["a"] })] }, headless)).rejects.toThrow(/same round/);
    await expect(call(questions, { round: 1, questions: [question("b", { dependsOn: ["ghost"] })] }, headless)).rejects.toThrow(/not been answered/);
    await call(questions, { round: 1, questions: [question("a")] }, headless);
    const second = await call(questions, { round: 2, questions: [question("b", { dependsOn: ["a"] })] }, headless);
    expect(textOf(second)).toContain("[b]");
  });

  it("validates option counts, recommendation, reason and round number", async () => {
    const { questions } = await planning();
    const one = question("a", { options: [{ value: "a", label: "A" }] });
    await expect(call(questions, { round: 1, questions: [one] }, headless)).rejects.toThrow(/2 to 4 options/);
    await expect(call(questions, { round: 1, questions: [question("a", { recommended: "zzz" })] }, headless)).rejects.toThrow(/recommended must be one of/);
    await expect(call(questions, { round: 1, questions: [question("a", { reason: " " })] }, headless)).rejects.toThrow(/reason/);
    await expect(call(questions, { round: 2, questions: [question("a")] }, headless)).rejects.toThrow(/round 1/);
  });

  it("falls back to the recommendations without a UI and says so", async () => {
    const { questions, app } = await planning();
    const result = await call(questions, { round: 1, questions: [question("a"), question("b", { recommended: "b" })] }, headless);
    expect(textOf(result)).toContain("No UI was available");
    expect((result.details as { answers: InterviewAnswer[] }).answers).toEqual([
      { id: "a", value: "a", label: "Option A", wasCustom: false, acceptedRecommendation: true },
      { id: "b", value: "b", label: "Option B", wasCustom: false, acceptedRecommendation: true },
    ]);
    expect(readInterview((app as never as { ctx: never })["ctx"], app.activeTaskId()!)!.rounds[0]!.headless).toBe(true);
  });

  it("records scripted UI answers, one decision event each, and survives a restart", async () => {
    const { questions, app, cwd } = await planning();
    const qs = [question("a"), question("b")];
    const { ctx, log } = fakeCtx({
      custom: [{ cancelled: false, answers: [{ id: "a", value: "b", label: "Option B", wasCustom: false, acceptedRecommendation: false }, { id: "b", value: "my own", label: "my own", wasCustom: true, acceptedRecommendation: false }] }],
    });
    const result = await call(questions, { round: 1, questions: qs }, ctx);
    expect(log.custom).toBe(1);
    const answers = (result.details as { answers: InterviewAnswer[] }).answers;
    expect(answers.map((item) => [item.id, item.value, item.wasCustom, item.acceptedRecommendation])).toEqual([["a", "b", false, false], ["b", "my own", true, false]]);
    const events = readFileSync(path.join(app.store.taskDir(app.activeTaskId()!), "events.jsonl"), "utf8").split("\n").filter((line) => line.includes('"type":"decision"'));
    expect(events).toHaveLength(2);
    // A new process (a fresh Workflow on the same folder) resumes from interview.json.
    const turns: string[] = [];
    const again = workflow(cwd, { startTurn: (text) => void turns.push(text) });
    const resumed = await again.startPlan("Add retry to the ingest parser");
    expect(resumed.ok).toBe(true);
    expect(resumed.text).toContain("Resuming");
    expect(resumed.text).toContain("round 2 (2/7 questions)");
    expect(turns[0]).toContain("Resume planning");
    const prompt = again.planningPrompt()!;
    expect(prompt).toContain("Questions asked so far: 2/7");
    expect(prompt).toContain("[b] b: my own (user wrote)");
  });

  it("re-asks a round that was shown but never answered after a restart", async () => {
    const { app, cwd, questions } = await planning();
    const { ctx } = fakeCtx({ custom: [new Promise(() => undefined) as never] });
    void call(questions, { round: 1, questions: [question("a")] }, ctx).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = workflow(cwd, { startTurn: () => undefined });
    await again.startPlan("");
    expect(again.planningPrompt()).toContain("was shown but not answered");
    expect(app.planningStage()).toBe("interview");
  });

  it("treats a dismissed dialog as no answer and does not consume the round", async () => {
    const { questions, app } = await planning();
    const { ctx } = fakeCtx({ custom: [{ cancelled: true, answers: [] }, accepted([question("a")])] });
    const dismissed = await call(questions, { round: 1, questions: [question("a")] }, ctx);
    expect(textOf(dismissed)).toContain("dismissed");
    expect(readInterview((app as never as { ctx: never })["ctx"], app.activeTaskId()!)!.rounds).toHaveLength(0);
    const retry = await call(questions, { round: 1, questions: [question("a")] }, ctx);
    expect(textOf(retry)).toContain("1/7");
  });

  it("skips the interview with --no-questions", async () => {
    const { questions, spec, app } = await planning({ noQuestions: true });
    await expect(call(questions, { round: 1, questions: [question("a")] }, headless)).rejects.toThrow(/--no-questions/);
    await call(spec, { ...specParams, decisions: [] }, headless);
    expect(app.store.load(app.activeTaskId()!)!.planning?.stage).toBe("tickets");
  });

  it("is unusable when no /plan is running", async () => {
    const app = workflow(await tempRepo());
    await expect(call(createPlanQuestionsTool(() => app), { round: 1, questions: [question("a")] }, headless)).rejects.toThrow(/No \/plan is running/);
  });
});

describe("questions dialog", () => {
  const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
  const tui = { requestRender() {} };
  const down = "\u001b[B";
  const enter = "\r";

  function open(qs: InterviewQuestion[], allowOther = true) {
    let result: { cancelled: boolean; answers: InterviewAnswer[] } | undefined;
    const component = questionsDialog(qs, { allowOther }, tui, theme, (value) => void (result = value));
    return { component, result: () => result };
  }

  it("marks and preselects the recommendation, and always offers Other", () => {
    const { component } = open([question("a", { recommended: "b" })]);
    const lines = component.render(100).join("\n");
    expect(lines).toContain("★ Recommended — simplest");
    expect(lines).toContain("Option B  ★ Recommended");
    expect(lines).toContain("Other (type answer)");
    expect(lines).toMatch(/> 2\. Option B/);
  });

  it("Enter on the preselected option accepts the recommendation", () => {
    const { component, result } = open([question("a", { recommended: "b" })]);
    component.handleInput(enter);
    expect(result()).toEqual({ cancelled: false, answers: [{ id: "a", value: "b", label: "Option B", wasCustom: false, acceptedRecommendation: true }] });
  });

  it("accept-all submits every recommendation, discarding earlier picks", () => {
    const { component, result } = open([question("a"), question("b", { recommended: "b" })]);
    component.handleInput(down);
    component.handleInput(enter); // picks B for a, moves to tab b
    component.handleInput("a");
    expect(result()!.answers.map((item) => [item.id, item.value, item.acceptedRecommendation])).toEqual([["a", "a", true], ["b", "b", true]]);
  });

  it("records a picked non-recommended option and a typed answer", () => {
    const { component, result } = open([question("a"), question("b")]);
    component.handleInput(down);
    component.handleInput(enter); // a -> B
    component.handleInput(down);
    component.handleInput(down); // b: Other
    component.handleInput(enter);
    for (const ch of "mine") component.handleInput(ch);
    component.handleInput(enter); // submit typed answer, advance to Submit tab
    component.handleInput(enter);
    expect(result()!.answers).toEqual([
      { id: "a", value: "b", label: "Option B", wasCustom: false, acceptedRecommendation: false },
      { id: "b", value: "mine", label: "mine", wasCustom: true, acceptedRecommendation: false },
    ]);
  });

  it("Esc cancels", () => {
    const { component, result } = open([question("a")]);
    component.handleInput("\u001b");
    expect(result()).toEqual({ cancelled: true, answers: [] });
  });
});

describe("plan_tickets", () => {
  async function atTicketStage() {
    const base = await planning();
    await call(base.spec, specParams, headless);
    return base;
  }

  it("requires the spec first", async () => {
    const { tickets } = await planning();
    await expect(call(tickets, { tickets: [ticket("01")] }, headless)).rejects.toThrow(/plan_spec/);
  });

  it("writes spec.md", async () => {
    const { app } = await atTicketStage();
    const spec = readFileSync(path.join(app.store.taskDir(app.activeTaskId()!), "spec.md"), "utf8");
    expect(spec).toContain("Retry failed ingests.");
    expect(spec).toContain("### Backoff?");
    expect(spec).toContain("- Metrics");
  });

  describe("the planner's rating", () => {
    const rating = { complexity: "low", risk: "low", securitySensitive: false, classificationReason: "one parser wrapper" };

    it("starts with the keyword classification and replaces it with the planner's rating from plan_spec", async () => {
      const { app, spec } = await planning();
      const before = app.store.load(app.activeTaskId()!)!.classification!;
      expect(before).toMatchObject({ source: "keywords", complexity: "medium", task_type: "general" });
      const result = await call(spec, { ...specParams, ...rating }, headless);
      expect(textOf(result)).toContain("Rated low complexity, low risk.");
      const after = app.store.load(app.activeTaskId()!)!;
      expect(after.classification).toMatchObject({ source: "planner", complexity: "low", risk: "low", task_type: "general", recommended_tier: "cheap", required_capabilities: [] });
      expect(after.classification!.reason_codes).toContain("reason: one parser wrapper");
      expect(after.routing?.tier).toBe("cheap");
      const status = (await app.status()).text;
      expect(status).toContain("| Rating | planner: low complexity, low risk · one parser wrapper |");
    });

    it("raises risk and the flag when the planner says security-sensitive", async () => {
      const { app, spec } = await planning();
      await call(spec, { ...specParams, ...rating, securitySensitive: true, risk: "medium" }, headless);
      const task = app.store.load(app.activeTaskId()!)!;
      expect(task.classification).toMatchObject({ task_type: "security", risk: "high", recommended_tier: "premium", source: "planner" });
      expect(task.classification!.required_capabilities).toContain("security-sensitive");
      expect(task.routing?.requireHumanApproval).toBe(true);
    });

    it("does not let the planner lower a keyword hit in the request", async () => {
      const { app, spec } = await planning({ request: "Rotate the oauth credentials the ingest job uses" });
      expect(app.store.load(app.activeTaskId()!)!.classification).toMatchObject({ task_type: "security", risk: "high", source: "keywords" });
      const result = await call(spec, { ...specParams, ...rating }, headless);
      expect(textOf(result)).toContain("security-sensitive (the keyword scan marked it security-sensitive; you cannot lower that)");
      const task = app.store.load(app.activeTaskId()!)!;
      expect(task.classification).toMatchObject({ task_type: "security", risk: "high", complexity: "low", source: "planner" });
      expect(task.classification!.reason_codes).toContain("security_keyword_override");
    });

    it("also scans the spec: a plain request whose spec changes authentication is security-sensitive", async () => {
      const { app, spec } = await planning();
      await call(spec, { ...specParams, ...rating, changes: [{ path: "src/auth.ts", change: "check the password hash before parsing" }] }, headless);
      expect(app.store.load(app.activeTaskId()!)!.classification).toMatchObject({ task_type: "security", risk: "high" });
    });

    it("keeps the classification it has when the spec carries no rating, and rejects a malformed one", async () => {
      const { app, spec } = await planning();
      await call(spec, specParams, headless);
      expect(app.store.load(app.activeTaskId()!)!.classification).toMatchObject({ source: "keywords" });
      await expect(call(spec, { ...specParams, complexity: "huge" }, headless)).rejects.toThrow(/complexity must be one of low, medium, high/);
      await expect(call(spec, { ...specParams, securitySensitive: "yes" }, headless)).rejects.toThrow(/securitySensitive must be true or false/);
    });

    it("keeps an earlier security flag when a revised spec leaves the field out", async () => {
      const { app, spec } = await planning();
      await call(spec, { ...specParams, ...rating, securitySensitive: true }, headless);
      await call(spec, { ...specParams, complexity: "medium" }, headless);
      expect(app.store.load(app.activeTaskId()!)!.classification).toMatchObject({ task_type: "security", complexity: "medium", risk: "high" });
    });
  });

  it("rejects cycles, missing blockers, duplicates, and tickets with no criterion", async () => {
    const { tickets } = await atTicketStage();
    await expect(call(tickets, { tickets: [ticket("01", { blockedBy: ["02"] }), ticket("02", { blockedBy: ["01"] })] }, headless)).rejects.toThrow(/cycle/i);
    await expect(call(tickets, { tickets: [ticket("01", { blockedBy: ["09"] })] }, headless)).rejects.toThrow(/blockedBy 09 does not exist/);
    await expect(call(tickets, { tickets: [ticket("01"), ticket("01", { slug: "other" })] }, headless)).rejects.toThrow(/duplicate id/);
    await expect(call(tickets, { tickets: [ticket("01", { acceptanceCriteria: [] })] }, headless)).rejects.toThrow(/acceptance criterion/);
  });

  it("asks for a split when the model estimate exceeds the target", async () => {
    const { tickets, app } = await atTicketStage();
    await expect(call(tickets, { tickets: [ticket("01", { estimatedContextTokens: 150001 })] }, headless)).rejects.toThrow(/Split it/);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("PLANNING");
  });

  it("adds the sizes of listed files to the code-side estimate", async () => {
    const { tickets, cwd, app } = await atTicketStage();
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    writeFileSync(path.join(cwd, "src", "big.ts"), "x".repeat(600_000)); // 150K tokens alone
    writeFileSync(path.join(cwd, "src", "small.ts"), "export {};\n");
    await expect(call(tickets, { tickets: [ticket("01", { estimatedContextTokens: 1000, files: ["src/big.ts", "src/gone.ts"] })] }, headless)).rejects.toThrow(/170\d\d\d tokens \(model 1000, code-side 170\d\d\d\)/);
    const ok = await call(tickets, { tickets: [ticket("01", { estimatedContextTokens: 1000, files: ["src/small.ts", "src/missing.ts"] })] }, headless);
    expect(textOf(ok)).toContain("1 tickets written");
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("AWAITING_PLAN_APPROVAL");
  });

  it("honours workers.ticketContextTokens", async () => {
    const cwd = await tempRepo();
    const config = parseConfig(`${testYaml()}\nworkers: { tokenBudget: 8000, ticketContextTokens: 30000 }\n`);
    expect(config.workers.ticketContextTokens).toBe(30000);
    const app = workflow(cwd, { config, startTurn: () => undefined });
    await app.startPlan("Add retry to ingest");
    await call(createPlanSpecTool(() => app), specParams, headless);
    await expect(call(createPlanTicketsTool(() => app), { tickets: [ticket("01", { estimatedContextTokens: 40000 })] }, headless)).rejects.toThrow(/above the 30000 target/);
  });

  it("defaults the target to 150000 tokens", () => {
    expect(testConfig().workers.ticketContextTokens).toBe(150000);
  });

  it("writes ticket files in the to-tickets format, stores tickets in the plan, and maps them to groups", async () => {
    const { tickets, app } = await atTicketStage();
    const input = [
      ticket("01", { suggestedTier: "cheap", files: ["src/ingest.ts"] }),
      ticket("02", { blockedBy: ["01"], title: "Second", acceptanceCriteria: ["a", "b"], checks: ["npm test"] }),
    ];
    const result = await call(tickets, { tickets: input }, headless);
    expect(textOf(result)).toContain("/show-plan");
    const dir = path.join(app.store.taskDir(app.activeTaskId()!), "tickets");
    expect(readdirSync(dir).sort()).toEqual(["01-t01.md", "02-t02.md"]);
    const first = readFileSync(path.join(dir, "01-t01.md"), "utf8");
    expect(first).toMatch(/^---\nid: 01\nslug: t01\nsuggestedTier: cheap\nestimatedContextTokens: 40000\nfiles: \["src\/ingest.ts"\]\n---/);
    expect(first).toContain("# 01: Ticket 01");
    expect(first).toContain("## What to build\n\nUsers can retry a failed ingest end to end.");
    expect(first).toContain("## Acceptance criteria\n\n- [ ] retry works");
    expect(first).toContain("## Blocked by\n\nNone");
    expect(first).toContain("## Status: ready-for-agent");
    const second = readFileSync(path.join(dir, "02-t02.md"), "utf8");
    expect(second).toContain("## Blocked by\n\n- 01");
    expect(second).toContain("- [ ] a\n- [ ] b");
    const state = app.store.load(app.activeTaskId()!)!;
    expect(state.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect(state.planning).toBeUndefined();
    expect(state.plan!.tickets!.map((item) => item.id)).toEqual(["01", "02"]);
    expect(state.plan!.groups).toMatchObject([
      { id: "01-t01", dependsOn: [], files: ["src/ingest.ts"], edits: [] },
      { id: "02-t02", dependsOn: ["01-t01"], files: [], edits: [] },
    ]);
    expect(state.plan!.groups[1]!.summary).toContain("Second");
    expect(state.plan!.groups[1]!.summary).toContain("- b");
    expect(state.plan!.summary).toBe("Retry failed ingests.");
  });

  it("still requires plan approval before /build", async () => {
    const { tickets, app } = await atTicketStage();
    await call(tickets, { tickets: [ticket("01")] }, headless);
    const early = await app.startBuild();
    expect(early).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect((await app.approveDraft()).ok).toBe(true);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("AWAITING_PLAN_APPROVAL");
  });

  describe("plan shown when the planning turn settles", () => {
    /** A fake pi whose agent_settled handler is driven by hand, and a live ctx with a scripted picker. */
    function settled(app: { cwd: string }, script: { select?: (string | undefined)[]; editor?: (string | undefined)[] } = {}) {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const pi = { registerCommand() {}, on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => (handlers.set(event, handler), () => undefined), appendEntry() {}, setModel: async () => false };
      registerWorkflow(pi as unknown as ExtensionAPI);
      bindWorkflow(app as never);
      const log = { messages: [] as { customType: string; content: string; display: boolean }[], selects: [] as { title: string; labels: string[] }[], notes: [] as string[], users: [] as string[], order: [] as string[] };
      const ctx = {
        cwd: app.cwd,
        hasUI: true,
        sendMessage: (message: { customType: string; content: string; display: boolean }) => void (log.messages.push(message), log.order.push("post")),
        sendUserMessage: (text: string) => void log.users.push(text),
        ui: {
          custom: () => {
            throw new Error("no popups");
          },
          select: async (title: string, labels: string[]) => (log.selects.push({ title, labels }), log.order.push("select"), script.select?.shift()),
          editor: async () => script.editor?.shift(),
          notify: (message: string) => void log.notes.push(message),
          setStatus() {},
          confirm: async () => false,
        },
      };
      return { log, run: (aborted = false) => handlers.get("agent_settled")!({ type: "agent_settled", aborted }, ctx) as Promise<void> };
    }
    const uiCtx = { hasUI: true, ui: { select: async () => { throw new Error("plan_tickets must not ask"); }, notify() {}, editor: async () => undefined } };

    async function drafted() {
      const base = await atTicketStage();
      const result = await call(base.tickets, { tickets: [ticket("01", { implementation: "Add retryParse() to src/ingest.ts." }), ticket("02", { blockedBy: ["01"] })] }, uiCtx);
      return { ...base, result };
    }

    it("plan_tickets with a UI saves the draft, sets the flag, tells the model, and asks nothing", async () => {
      const { app, result } = await drafted();
      expect(textOf(result)).toContain("will be shown to the user for approval when this turn ends. End your turn now with a one-line summary; do not repeat the plan.");
      const task = app.store.load(app.activeTaskId()!)!;
      expect(task.phase).toBe("AWAITING_PLAN_APPROVAL");
      expect(task.presentPlan).toEqual({ version: 1 });
      expect(task.approvedVersion).toBeUndefined();
    });

    it("posts the plan once as markdown, then picks among the four actions; Esc keeps the draft", async () => {
      const { app } = await drafted();
      const { log, run } = settled(app, { select: [undefined] });
      await run();
      expect(log.messages).toHaveLength(1);
      expect(log.messages[0]).toMatchObject({ customType: "chef-report", display: true });
      expect(log.messages[0]!.content).toContain("## Approach");
      expect(log.messages[0]!.content).toContain("**Implementation**\n\nAdd retryParse() to src/ingest.ts.");
      expect(log.order).toEqual(["post", "select"]);
      expect(log.selects).toEqual([{ title: "Review the plan · 2 tickets", labels: ["Approve plan", "Request changes", "Edit tickets", "Save as draft"] }]);
      expect(log.notes.join("\n")).toContain("/show-plan to approve later");
      const task = app.store.load(app.activeTaskId()!)!;
      expect(task.phase).toBe("AWAITING_PLAN_APPROVAL");
      expect(task.approvedVersion).toBeUndefined();
      expect(task.presentPlan).toBeUndefined();
      // The plan is presented once: a second settle does nothing.
      await run();
      expect(log.messages).toHaveLength(1);
      expect(readFileSync(path.join(app.store.taskDir(task.taskId), "plan.md"), "utf8")).toBe(log.messages[0]!.content);
    });

    it("Approve plan approves and freezes the plan", async () => {
      const { app } = await drafted();
      const { log, run } = settled(app, { select: ["Approve plan"] });
      await run();
      const task = app.store.load(app.activeTaskId()!)!;
      expect(task.approvedVersion).toBe(1);
      expect(existsSync(path.join(app.store.taskDir(task.taskId), "plan.v1.approved.json"))).toBe(true);
      expect(log.notes.join("\n")).toContain("Approved plan v1. Run /build.");
    });

    it("Request changes asks for text and starts the revision turn", async () => {
      const { app } = await drafted();
      const { log, run } = settled(app, { select: ["Request changes", "Request changes"], editor: ["  ", "Merge 01 and 02"] });
      await run();
      // An empty editor returns to the picker without posting the plan again.
      expect(log.selects).toHaveLength(2);
      expect(log.messages).toHaveLength(1);
      expect(log.users).toHaveLength(1);
      expect(log.users[0]).toContain("Merge 01 and 02");
      expect(app.store.load(app.activeTaskId()!)!.phase).toBe("PLANNING");
    });

    it("Edit tickets re-validates, saves, posts the updated plan, and asks again", async () => {
      const { app } = await drafted();
      const plan = app.store.load(app.activeTaskId()!)!.plan!;
      const edited = renderTicketsMarkdown(plan.tickets!).replace("# 01: Ticket 01", "# 01: Edited ticket");
      const broken = renderTicketsMarkdown(plan.tickets!).replace("- 01", "- 99");
      const { log, run } = settled(app, { select: ["Edit tickets", "Edit tickets", "Save as draft"], editor: [broken, edited] });
      await run();
      expect(log.notes.join("\n")).toContain("blockedBy 99 does not exist");
      expect(log.selects).toHaveLength(3);
      expect(log.messages).toHaveLength(2);
      expect(log.messages[1]!.content).toContain("Edited ticket");
      expect(log.order).toEqual(["post", "select", "select", "post", "select"]);
      expect(app.store.load(app.activeTaskId()!)!.plan!.tickets![0]!.title).toBe("Edited ticket");
      expect(readFileSync(path.join(app.store.taskDir(app.activeTaskId()!), "tickets", "01-t01.md"), "utf8")).toContain("Edited ticket");
    });

    it("keeps the flag after an aborted turn, and /show-plan still offers the draft", async () => {
      const { app } = await drafted();
      const { log, run } = settled(app, { select: ["Save as draft"] });
      await run(true);
      expect(log.messages).toEqual([]);
      expect(log.selects).toEqual([]);
      expect(app.store.load(app.activeTaskId()!)!.presentPlan).toEqual({ version: 1 });
      await run(false);
      expect(log.selects).toHaveLength(1);
    });

    it("does nothing without a UI", async () => {
      const { tickets, app } = await atTicketStage();
      const result = await call(tickets, { tickets: [ticket("01")] }, headless);
      expect(textOf(result)).toContain("/show-plan");
      expect(app.store.load(app.activeTaskId()!)!.presentPlan).toBeUndefined();
    });
  });

  it("round-trips ticket markdown", () => {
    const input = [{ ...ticket("01", { suggestedTier: "premium", files: ["a.ts"], checks: ["x"] }), blockedBy: [] }, ticket("02", { blockedBy: ["01"] })] as never as Parameters<typeof renderTicket>[0][];
    expect(parseTicketsMarkdown(renderTicketsMarkdown(input))).toMatchObject([
      { id: "01", slug: "t01", title: "Ticket 01", suggestedTier: "premium", files: ["a.ts"], checks: ["x"], blockedBy: [], acceptanceCriteria: ["retry works"] },
      { id: "02", blockedBy: ["01"] },
    ]);
  });
});

function testYaml(): string {
  return `
providers:
  openai: { type: openai, auth: account-login, model: gpt-5.4 }
models: { cheap: openai, standard: openai, premium: openai }
`;
}

describe("extension wiring", () => {
  function fakePi(active: string[]) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const calls: string[][] = [];
    const pi = {
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(event, handler);
        return () => undefined;
      },
      appendEntry() {},
      registerTool() {},
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
        calls.push(names);
      },
      sendUserMessage() {},
    };
    return { pi: pi as unknown as ExtensionAPI, handlers, calls, active: () => active };
  }

  it("restricts tools, injects the interview prompt, and blocks unsafe bash while planning, then restores", async () => {
    const { app } = await planning();
    bindWorkflow(app);
    const fake = fakePi(["read", "bash", "edit", "write", "plan_questions"]);
    extension(fake.pi);
    const before = fake.handlers.get("before_agent_start")!;
    const injected = before({ type: "before_agent_start", messageType: "user" }, {}) as { message: { customType: string; content: string } };
    expect(injected.message.customType).toBe("plan-interview-context");
    expect(injected.message.content).toContain("[PLAN INTERVIEW]");
    expect(fake.active()).not.toContain("edit");
    expect(fake.active()).not.toContain("write");
    for (const tool of ["read", "grep", "find", "ls", "bash", "web_search", "web_fetch", "plan_questions", "plan_spec", "plan_tickets"]) expect(fake.active()).toContain(tool);
    const toolCall = fake.handlers.get("tool_call")!;
    expect(toolCall({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "rm -rf x" } }, {})).toMatchObject({ block: true });
    expect(toolCall({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "git log --oneline | head -5" } }, {})).toBeUndefined();
    // Finish planning, then the next agent start restores the original tools without the plan tools.
    await call(createPlanSpecTool(() => app), specParams, headless);
    await call(createPlanTicketsTool(() => app), { tickets: [ticket("01")] }, headless);
    fake.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, {});
    expect(fake.active()).toEqual(["read", "bash", "edit", "write"]);
    expect(before({ type: "before_agent_start", messageType: "user" }, {})).toBeUndefined();
    bindWorkflow(undefined);
  });
});

describe("read-only bash allowlist", () => {
  it("allows plain reads and pipes between them", () => {
    for (const command of ["ls -la src", "grep -rn foo src | head -20", "git status", "cat package.json", "find . -name '*.ts'"]) expect(isReadOnlyCommand(command), command).toBe(true);
  });
  it("blocks writes, redirects, chaining, substitution, and mutating git or find", () => {
    for (const command of ["rm -rf x", "echo hi > file", "ls; rm x", "ls && rm x", "cat $(whoami)", "git commit -m x", "find . -delete", "npm install", "sed -i s/a/b/ f", "ls | xargs rm"]) expect(isReadOnlyCommand(command), command).toBe(false);
  });

  it("allows the exact az reads of deployed resources, and nothing that prints a secret or token", () => {
    const allowed = [
      "az account show",
      "az account list --all -o table",
      "az group list --output json",
      "az resource list -g rg-app --resource-type Microsoft.Web/sites --query \"[].{name:name,type:type}\" -o table",
      "az resource show --ids /subscriptions/1/resourceGroups/rg/providers/Microsoft.Web/sites/a /subscriptions/1/resourceGroups/rg/providers/Microsoft.Web/sites/b",
      "az resource list --subscription prod | head -50",
    ];
    for (const command of allowed) expect(isReadOnlyCommand(command), command).toBe(true);
    const blocked = [
      "az account get-access-token",
      "az keyvault secret show --vault-name v --name s",
      "az storage account keys list -n s",
      "az webapp config appsettings list -g rg -n app",
      "az ad sp credential list --id x",
      "az resource list --debug",
      "az resource show --name @secrets.txt",
      "az resource show --name=@secrets.txt",
      "az resource delete --ids x",
      "az rest --url https://management.azure.com/",
      "az login",
      "az group list extra",
    ];
    for (const command of blocked) expect(isReadOnlyCommand(command), command).toBe(false);
  });

  it("allows gh searches and reads of other repositories' files, and nothing that writes or prints the token", () => {
    const allowed = [
      "gh search code azurerm_container_app --owner contoso --language hcl --limit 20",
      "gh search repos terraform azure --owner contoso",
      "gh repo view contoso/infra",
      "gh repo list contoso --topic terraform --json name,description",
      "gh api repos/contoso/infra/contents/modules/app",
      "gh api -H \"Accept: application/vnd.github.raw+json\" repos/contoso/infra/contents/main.tf?ref=main",
      "gh api repos/contoso/infra/git/trees/main?recursive=1 --paginate",
    ];
    for (const command of allowed) expect(isReadOnlyCommand(command), command).toBe(true);
    const blocked = [
      "gh auth status --show-token",
      "gh auth token",
      "gh repo view contoso/infra --web",
      "gh repo view contoso/infra --json name --jq env",
      "gh repo clone contoso/infra",
      "gh repo view a/b c/d",
      "gh api user",
      "gh api graphql -f query=x",
      "gh api -X POST repos/contoso/infra/contents/x",
      "gh api repos/contoso/infra/contents/x -f message=x",
      "gh api --input body.json repos/contoso/infra/contents/x",
      "gh api -H \"X-Other: 1\" repos/contoso/infra/contents/x",
      "gh api --header=X-Other:1 repos/contoso/infra/contents/x",
      "gh api repos/contoso/infra/contents/x repos/contoso/infra/contents/y",
      "gh api repos/contoso/infra/issues",
      "gh pr create --fill",
      "gh secret list",
    ];
    for (const command of blocked) expect(isReadOnlyCommand(command), command).toBe(false);
  });
});
