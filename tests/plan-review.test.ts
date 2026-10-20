import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderSpec } from "../src/orchestrator/interview.js";
import { ticketDifficulty, type Difficulty, type Tier } from "../src/domain.js";
import { ticketPrompt, TICKET_RULES } from "../src/orchestrator/prompts.js";
import type { PlanReviewRequest } from "../src/orchestrator/types.js";
import { parseTicketsMarkdown, renderTicketsMarkdown, validateTickets } from "../src/orchestrator/tickets.js";
import { createPlanQuestionsTool } from "../src/tools/plan-questions.js";
import { createPlanSpecTool, createPlanTicketsTool } from "../src/tools/plan-flow.js";
import { presentForDecision } from "../src/tools/plan-review.js";
import { tempRepo, workflow } from "./helpers.js";

type Exec = (id: string, params: never, signal: undefined, onUpdate: undefined, ctx: never) => Promise<{ content: { type: string; text: string }[] }>;
const call = (tool: { execute: unknown }, params: unknown, ctx: unknown) => (tool.execute as Exec)("1", params as never, undefined, undefined, ctx as never);
const headless = { hasUI: false, ui: {} };

const specParams = {
  summary: "Retry failed ingests.",
  context: "src/ingest.ts parses events and drops failures.",
  approach: "Wrap parse() in retryParse(input, attempts) with a fixed backoff.",
  changes: [{ path: "src/ingest.ts", change: "add retryParse(input, attempts)" }],
  reuse: ["sleep() in src/util.ts"],
  decisions: [{ question: "Backoff?", answer: "Fixed", rationale: "simple" }],
  assumptions: [],
  outOfScope: [],
  risks: [],
  verification: ["npm test"],
};

function ticket(id: string, extra: Record<string, unknown> = {}) {
  return { id, slug: `t${id}`, title: `Ticket ${id}`, whatToBuild: "Users can retry a failed ingest.", implementation: "Add retryParse() in src/ingest.ts and call it from ingest().", acceptanceCriteria: ["retry works"], blockedBy: [] as string[], estimatedContextTokens: 40000, ...extra };
}

/** A workflow with a drafted ticket plan waiting for approval. */
async function drafted(extras: Parameters<typeof workflow>[1] = {}) {
  const cwd = await tempRepo();
  const turns: string[] = [];
  const app = workflow(cwd, { startTurn: (text) => void turns.push(text), ...extras });
  await app.startPlan("Add retry to the ingest parser");
  await call(createPlanSpecTool(() => app), specParams, headless);
  await call(createPlanTicketsTool(() => app), { tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })] }, headless);
  return { cwd, app, turns };
}

describe("technical spec", () => {
  it("requires an approach, file changes, and verification", async () => {
    const app = workflow(await tempRepo(), { startTurn: () => undefined });
    await app.startPlan("Add retry");
    const spec = createPlanSpecTool(() => app);
    await expect(call(spec, { summary: "x", decisions: [], assumptions: [], outOfScope: [], risks: [] }, headless)).rejects.toThrow(/approach is required[\s\S]*changes needs at least one file[\s\S]*verification needs/);
    await expect(call(spec, { ...specParams, changes: [{ path: "src/a.ts", change: "" }] }, headless)).rejects.toThrow(/path and a description/);
  });

  it("renders context, approach, files, reuse, and verification", () => {
    const text = renderSpec({ ...specParams, assumptions: ["Node 20"], outOfScope: [], risks: [] });
    for (const heading of ["## Context", "## Approach", "## Files to change", "## Reuse", "## Decisions", "## Verification"]) expect(text).toContain(heading);
    expect(text).toContain("- `src/ingest.ts`: add retryParse(input, attempts)");
  });
});

describe("ticket implementation notes", () => {
  it("round-trips through the ticket file and reaches the worker prompt", () => {
    const checked = validateTickets([ticket("01")], { target: 150000, fileSize: () => undefined });
    expect(checked.errors).toEqual([]);
    const markdown = renderTicketsMarkdown(checked.tickets);
    expect(markdown).toContain("## Implementation\n\nAdd retryParse()");
    expect(parseTicketsMarkdown(markdown)[0]).toMatchObject({ implementation: "Add retryParse() in src/ingest.ts and call it from ingest()." });
    expect(ticketPrompt({ ticket: checked.tickets[0]!, blockers: [] })).toContain("## Implementation\n\nAdd retryParse()");
  });

  it("rejects implementation text that would corrupt the ticket file", () => {
    const checked = validateTickets([ticket("01", { implementation: "## Steps\n- a" })], { target: 150000, fileSize: () => undefined });
    expect(checked.errors.join("\n")).toMatch(/implementation has a line starting with/);
  });
});

describe("ticket difficulty", () => {
  it("plan_tickets accepts difficulty, rejects an unknown one, and the markdown editor round trip keeps it", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd, { startTurn: () => undefined });
    await app.startPlan("Add retry to the ingest parser");
    await call(createPlanSpecTool(() => app), specParams, headless);
    const tool = createPlanTicketsTool(() => app);
    await expect(call(tool, { tickets: [ticket("01", { difficulty: "extreme" })] }, headless)).rejects.toThrow(/difficulty "extreme" must be one of low, medium, high/);
    await call(tool, { tickets: [ticket("01", { difficulty: "low" }), ticket("02", { difficulty: "high", blockedBy: ["01"] })] }, headless);
    const tickets = app.store.load(app.activeTaskId()!)!.plan!.tickets!;
    expect(tickets.map((item) => item.difficulty)).toEqual(["low", "high"]);
    const markdown = renderTicketsMarkdown(tickets);
    expect(markdown).toContain("difficulty: high");
    const again = validateTickets(parseTicketsMarkdown(markdown), { target: 150000, fileSize: () => undefined });
    expect(again.errors).toEqual([]);
    expect(again.tickets.map((item) => item.difficulty)).toEqual(["low", "high"]);
    expect(TICKET_RULES(150000)).toMatch(/low = mechanical or small and well specified; medium = typical feature work; high = cross-cutting/);
  });

  it("maps a suggestedTier-only ticket to a difficulty and lets difficulty win", () => {
    const of = (item: { difficulty?: Difficulty; suggestedTier?: string }) => ticketDifficulty(item);
    expect(of({ suggestedTier: "deterministic" })).toBe("low");
    expect(of({ suggestedTier: "cheap" })).toBe("low");
    expect(of({ suggestedTier: "standard" })).toBe("medium");
    expect(of({ suggestedTier: "premium" })).toBe("high");
    expect(of({})).toBe("medium");
    expect(of({ suggestedTier: "premium", difficulty: "low" })).toBe("low");
  });
});

describe("/show-plan on a draft", () => {
  it("shows the full plan and approves only on an explicit approve", async () => {
    const { app } = await drafted();
    const seen: PlanReviewRequest[] = [];
    app.bind({ review: async (request) => (seen.push(request), { value: "close" }) });
    const closed = await app.showPlan();
    expect(closed.ok).toBe(true);
    expect(closed.text).toContain("/show-plan to approve later");
    expect(app.store.load(app.activeTaskId()!)!.approvedVersion).toBeUndefined();
    expect(seen[0]!.markdown).toContain("## Approach");
    expect(seen[0]!.markdown).toContain("### 02 · medium · Ticket 02");
    expect(seen[0]!.markdown).toContain("## Execution order\n\n1. 01\n2. 02");
    expect(seen[0]!.actions.map((action) => action.value)).toEqual(["approve", "revise", "close"]);
    app.bind({ review: async () => ({ value: "approve" }) });
    const approved = await app.showPlan();
    expect(approved.ok, approved.text).toBe(true);
    expect(approved.text).toBe("Approved plan v1. Run /build.");
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.approvedVersion).toBe(1);
    expect(existsSync(path.join(app.store.taskDir(task.taskId), "plan.v1.approved.json"))).toBe(true);
  });

  it("posts the draft once inline, then picks: Approve approves, Esc leaves the draft", async () => {
    const { app } = await drafted();
    for (const [label, approved] of [[undefined, false], ["Approve plan v1", true]] as const) {
      const posted: string[] = [];
      const picks: string[][] = [];
      const ui = { select: async (_title: string, labels: string[]) => (picks.push(labels), label), editor: async () => undefined, custom: () => { throw new Error("no popups"); } };
      app.bind({ review: (request) => presentForDecision({ ui } as never, request, (text) => void posted.push(text)) });
      const result = await app.showPlan();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("## Approach");
      expect(picks).toEqual([["Approve plan v1", "Request changes", "Close"]]);
      expect(result.text).toContain(approved ? "Approved plan v1" : "still a draft");
      expect(app.store.load(app.activeTaskId()!)!.approvedVersion).toBe(approved ? 1 : undefined);
    }
  });

  it("does not open the review for an approved plan", async () => {
    const { app } = await drafted();
    expect((await app.approveDraft()).ok).toBe(true);
    let opened = false;
    app.bind({ review: async () => ((opened = true), { value: "close" }), show: () => undefined });
    expect((await app.showPlan()).text).toContain("approved");
    expect(opened).toBe(false);
  });

  it("sends the plan back for changes and drafts it again without new interview questions", async () => {
    const { app, turns } = await drafted();
    app.bind({ startTurn: (text) => void turns.push(text), review: async () => ({ value: "revise", text: "Merge the two tickets" }) });
    const sent = await app.showPlan();
    expect(sent.ok, sent.text).toBe(true);
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.phase).toBe("PLANNING");
    expect(task.planning).toMatchObject({ stage: "interview", revision: "Merge the two tickets" });
    expect(turns.at(-1)).toContain("Merge the two tickets");
    expect(app.planningPrompt()).toContain("[PLAN REVISION]");
    expect(app.planningPrompt()).toContain("Previous tickets:");
    await expect(call(createPlanQuestionsTool(() => app), { round: 1, questions: [] }, headless)).rejects.toThrow(/revision/);
    await call(createPlanSpecTool(() => app), specParams, headless);
    expect(app.planningPrompt()).toContain("Merge the two tickets");
    await call(createPlanTicketsTool(() => app), { tickets: [ticket("01")] }, headless);
    const redrafted = app.store.load(app.activeTaskId()!)!;
    expect(redrafted.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect(redrafted.plan!.tickets).toHaveLength(1);
  });

  it("approveDraft refuses when there is no draft", async () => {
    const app = workflow(await tempRepo(), { startTurn: () => undefined });
    expect((await app.approveDraft()).ok).toBe(false);
  });

  it("prints the plan without a UI", async () => {
    const { app } = await drafted();
    const headlessResult = await app.showPlan();
    expect(headlessResult.text).toContain("# Plan v1");
    expect(headlessResult.text.startsWith("**Task retry-ingest-parser** · Draft v1 · waiting for approval (/show-plan)\n\n")).toBe(true);
    const shown: string[] = [];
    app.bind({ show: (markdown) => void shown.push(markdown) });
    const result = await app.showPlan();
    expect(result.text).toContain("is shown above");
    expect(shown[0]).toBe(`**Task retry-ingest-parser** · Draft v1 · waiting for approval (/show-plan)\n\n${readFileSync(path.join(app.store.taskDir(app.activeTaskId()!), "plan.md"), "utf8")}`);
  });
});

describe("presentForDecision", () => {
  const request: PlanReviewRequest = {
    title: "Approve plan v1?",
    markdown: "# Plan v1\n\nline",
    actions: [{ value: "approve", label: "Approve" }, { value: "revise", label: "Request changes", input: "What?" }, { value: "cancel", label: "Not yet" }],
  };
  const ui = (labels: (string | undefined)[], edits: (string | undefined)[] = []) => {
    const seen: { title: string; options: string[] }[] = [];
    return { seen, ctx: { ui: { select: async (title: string, options: string[]) => (seen.push({ title, options }), labels.shift()), editor: async () => edits.shift() } } };
  };

  it("posts the markdown once, then offers the action labels and maps the label back", async () => {
    const { ctx, seen } = ui(["Not yet"]);
    const posted: string[] = [];
    expect(await presentForDecision(ctx as never, request, (text) => void posted.push(text))).toEqual({ value: "cancel" });
    expect(posted).toEqual([request.markdown]);
    expect(seen).toEqual([{ title: "Approve plan v1?", options: ["Approve", "Request changes", "Not yet"] }]);
  });

  it("does not post markdown that is already in the transcript", async () => {
    const posted: string[] = [];
    await presentForDecision(ui(["Approve"]).ctx as never, { ...request, alreadyShown: true }, (text) => void posted.push(text));
    expect(posted).toEqual([]);
  });

  it("resolves undefined on Esc", async () => {
    expect(await presentForDecision(ui([undefined]).ctx as never, request, () => undefined)).toBeUndefined();
  });

  it("asks for text for an input action and returns to the choice when it is empty", async () => {
    const { ctx, seen } = ui(["Request changes", "Request changes"], ["  ", "Split 02"]);
    const posted: string[] = [];
    expect(await presentForDecision(ctx as never, request, (text) => void posted.push(text))).toEqual({ value: "revise", text: "Split 02" });
    expect(seen).toHaveLength(2);
    expect(posted).toHaveLength(1);
  });
});

describe("/implement git preflight", () => {
  it("refuses a folder that is not a repository, or a repository with no commit", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const { GitWorkspace } = await import("../src/git/workspace.js");
    const plain = mkdtempSync(path.join(tmpdir(), "pi-chef-nogit-"));
    const git = new GitWorkspace(plain);
    expect(await git.preflight()).toMatch(/is not a git repository/);
    execFileSync("git", ["init", "-q"], { cwd: plain });
    expect(await git.preflight()).toMatch(/has no commits yet/);
    expect(await new GitWorkspace(await tempRepo()).preflight()).toBeUndefined();
  });

  it("stops /build with a clear message and leaves the task approved", async () => {
    const { app } = await drafted();
    expect((await app.approveDraft()).ok).toBe(true);
    (app.git as { preflight: () => Promise<string | undefined> }).preflight = async () => "not a git repository";
    const result = await app.startBuild();
    expect(result).toMatchObject({ ok: false, code: "GIT_NOT_READY" });
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect(task.approvedVersion).toBe(1);
  });
});
