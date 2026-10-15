import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindWorkflow, registerWorkflow } from "../src/extension.js";
import { renderSpec } from "../src/orchestrator/interview.js";
import { ticketPrompt } from "../src/orchestrator/prompts.js";
import type { PlanReviewRequest } from "../src/orchestrator/types.js";
import { parseTicketsMarkdown, renderTicketsMarkdown, validateTickets } from "../src/orchestrator/tickets.js";
import { createPlanQuestionsTool } from "../src/tools/plan-questions.js";
import { createPlanSpecTool, createPlanTicketsTool } from "../src/tools/plan-flow.js";
import { planReviewDialog, reviewPlan } from "../src/tools/plan-review.js";
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

/** A workflow with a drafted ticket plan waiting for /approve-plan. */
async function drafted(extras: Parameters<typeof workflow>[1] = {}) {
  const cwd = await tempRepo();
  const turns: string[] = [];
  const app = workflow(cwd, { startTurn: (text) => void turns.push(text), ...extras });
  await app.startPlan("Add retry to the ingest parser");
  await call(createPlanSpecTool(() => app), specParams, headless);
  await call(createPlanTicketsTool(() => app), { tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })] }, headless);
  return { cwd, app, turns };
}

const fakeTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

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

describe("/approve-plan review", () => {
  it("shows the full plan and approves only on an explicit approve", async () => {
    const { app } = await drafted();
    const seen: PlanReviewRequest[] = [];
    app.bind({ review: async (request) => (seen.push(request), { value: "cancel" }) });
    const declined = await app.approvePlan();
    expect(declined).toMatchObject({ ok: false, code: "NOT_APPROVED" });
    expect(app.store.load(app.activeTaskId()!)!.approvedVersion).toBeUndefined();
    expect(seen[0]!.markdown).toContain("## Approach");
    expect(seen[0]!.markdown).toContain("### 02: Ticket 02");
    expect(seen[0]!.markdown).toContain("## Execution order\n\n1. 01\n2. 02");
    expect(seen[0]!.actions.map((action) => action.value)).toEqual(["approve", "revise", "cancel"]);
    app.bind({ review: async () => ({ value: "approve" }) });
    const approved = await app.approvePlan();
    expect(approved.ok, approved.text).toBe(true);
    expect(app.store.load(app.activeTaskId()!)!.approvedVersion).toBe(1);
  });

  it("sends the plan back for changes and drafts it again without new interview questions", async () => {
    const { app, turns } = await drafted();
    app.bind({ startTurn: (text) => void turns.push(text), review: async () => ({ value: "revise", text: "Merge the two tickets" }) });
    const sent = await app.approvePlan();
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

  it("records approval even when the session handoff fails", async () => {
    const { app } = await drafted({ session: { reset: async () => Promise.reject(new Error("stale ctx")) } });
    const result = await app.approvePlan();
    expect(result.ok).toBe(false);
    expect(app.store.load(app.activeTaskId()!)!.approvedVersion).toBe(1);
  });

  it("shows the plan on demand", async () => {
    const { app } = await drafted();
    const headlessResult = await app.showPlan();
    expect(headlessResult.text).toContain("# Plan v1");
    const shown: string[] = [];
    app.bind({ show: (markdown) => void shown.push(markdown) });
    const result = await app.showPlan();
    expect(result.text).toContain("waiting for /approve-plan");
    expect(shown[0]).toBe(readFileSync(path.join(app.store.taskDir(app.activeTaskId()!), "plan.md"), "utf8"));
  });
});

describe("plan review dialog", () => {
  const request: PlanReviewRequest = {
    title: "Approve plan v1?",
    markdown: Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"),
    actions: [{ value: "approve", label: "Approve" }, { value: "cancel", label: "Not yet" }],
  };

  it("scrolls the plan and picks an action", () => {
    let result: string | undefined = "unset";
    const tui = { requestRender() {}, terminal: { rows: 30 } };
    const dialog = planReviewDialog(request, tui, fakeTheme, (value) => void (result = value));
    let lines = dialog.render(60);
    expect(lines.join("\n")).toContain("line 1");
    expect(lines.join("\n")).not.toContain("line 40");
    expect(lines.join("\n")).toContain("↓ more below");
    dialog.handleInput("\x1b[6~"); // PgDn
    lines = dialog.render(60);
    expect(lines.join("\n")).not.toContain(" line 1\n");
    expect(lines.join("\n")).toContain("line 30");
    dialog.handleInput("\x1b[C"); // right
    dialog.handleInput("\r");
    expect(result).toBe("cancel");
  });

  it("asks for text for an input action and returns to the plan when it is empty", async () => {
    const results: unknown[] = ["revise", "revise"];
    const edits = ["  ", "Split 02"];
    const ctx = { ui: { custom: async () => results.shift(), editor: async () => edits.shift() } };
    const choice = await reviewPlan(ctx as never, { ...request, actions: [{ value: "revise", label: "Request changes", input: "What?" }] });
    expect(choice).toEqual({ value: "revise", text: "Split 02" });
  });
});

describe("command handler after a session replacement", () => {
  it("reports through the new session's ctx and never touches the stale ctx or pi", async () => {
    const { app, cwd } = await drafted();
    let stale = false;
    const guard = <T extends (...args: never[]) => unknown>(fn: T) => ((...args: never[]) => {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      return fn(...args);
    }) as T;
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(name, options),
      on: () => () => undefined,
      appendEntry: guard(() => undefined),
      registerVirtualModel() {},
      getActiveTools: guard(() => [] as string[]),
      setActiveTools: guard(() => undefined),
      sendUserMessage: guard(() => undefined),
    };
    registerWorkflow(pi as unknown as ExtensionAPI);
    bindWorkflow(app);
    const notices: string[] = [];
    const sent: unknown[] = [];
    const next = {
      cwd,
      hasUI: true,
      ui: { notify: (message: string) => void notices.push(message), setStatus() {}, confirm: async () => true, custom: async () => "approve" },
      newSession: async () => ({ cancelled: false }),
      compact() {},
      sendMessage: async (message: unknown) => void sent.push(message),
      sendUserMessage: async () => undefined,
    };
    const old = {
      cwd,
      hasUI: true,
      ui: { notify: guard(() => undefined), setStatus: guard(() => undefined), confirm: guard(async () => true), custom: guard(async () => "approve") },
      newSession: async (options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
        stale = true;
        await options?.withSession?.(next);
        return { cancelled: false };
      },
      compact() {},
    };
    await expect(commands.get("approve-plan")!.handler("", old)).resolves.toBeUndefined();
    expect(notices.join("\n")).toContain("Approved plan v1");
    expect(sent).toMatchObject([{ customType: "cost-handoff" }]);
    expect(app.store.load(app.activeTaskId()!)!.approvedVersion).toBe(1);
    bindWorkflow(undefined);
  });
});

describe("/implement git preflight", () => {
  it("refuses a folder that is not a repository, or a repository with no commit", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const { GitWorkspace } = await import("../src/git/worktrees.js");
    const plain = mkdtempSync(path.join(tmpdir(), "pi-cost-nogit-"));
    const git = new GitWorkspace(plain);
    expect(await git.preflight()).toMatch(/is not a git repository/);
    execFileSync("git", ["init", "-q"], { cwd: plain });
    expect(await git.preflight()).toMatch(/has no commits yet/);
    expect(await new GitWorkspace(await tempRepo()).preflight()).toBeUndefined();
  });

  it("stops /implement with a clear message and leaves the task approved", async () => {
    const { app } = await drafted();
    expect((await app.approvePlan()).ok).toBe(true);
    (app.git as { preflight: () => Promise<string | undefined> }).preflight = async () => "not a git repository";
    const result = await app.implement();
    expect(result).toMatchObject({ ok: false, code: "GIT_NOT_READY" });
    const task = app.store.load(app.activeTaskId()!)!;
    expect(task.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect(task.approvedVersion).toBe(1);
  });
});

describe("model after a handoff", () => {
  function sessionPi() {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const selected: unknown[] = [];
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(name, options),
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => (handlers.set(event, handler), () => undefined),
      appendEntry() {},
      registerVirtualModel() {},
      setModel: async (model: unknown) => (selected.push(model), true),
    };
    registerWorkflow(pi as unknown as ExtensionAPI);
    return { commands, handlers, selected };
  }

  it("puts cost-opt/auto back when the new session starts on another model", async () => {
    const { app, cwd } = await drafted();
    const { commands, handlers, selected } = sessionPi();
    bindWorkflow(app);
    const auto = { provider: "cost-opt", id: "auto" };
    const ui = { notify() {}, setStatus() {}, confirm: async () => true, custom: async () => "approve" };
    const next = { cwd, hasUI: true, ui, model: { provider: "openai", id: "gpt-5.4" }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) }, sessionManager: { getEntries: () => [] }, sendMessage: async () => undefined };
    const old = {
      cwd,
      hasUI: true,
      ui,
      model: auto,
      compact() {},
      newSession: async (options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
        // Pi fires session_start for the new session before withSession runs.
        handlers.get("session_start")!({ type: "session_start", reason: "new" }, next);
        await options?.withSession?.(next);
        return { cancelled: false };
      },
    };
    await commands.get("approve-plan")!.handler("", old);
    expect(selected).toEqual([auto]);
    // The hint is used once: a later session start leaves the model alone.
    handlers.get("session_start")!({ type: "session_start", reason: "new" }, next);
    expect(selected).toHaveLength(1);
    bindWorkflow(undefined);
  });
});
