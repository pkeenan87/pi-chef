import { describe, expect, it } from "vitest";
import { PLAN_FILE, renderPlanReview } from "../src/orchestrator/plan.js";
import { renderTicket } from "../src/orchestrator/tickets.js";
import { createPlanSpecTool, createPlanTicketsTool } from "../src/tools/plan-flow.js";
import { sampleSpec, sampleTicket, ticketWorkflow, tieredConfig, tempRepo, workflow } from "./helpers.js";

type Exec = (id: string, params: never, signal: undefined, onUpdate: undefined, ctx: never) => Promise<{ content: { type: string; text: string }[] }>;
const call = (tool: { execute: unknown }, params: unknown, ctx: unknown) => (tool.execute as Exec)("1", params as never, undefined, undefined, ctx as never);
const headless = { hasUI: false, ui: {} };

const tickets = [
  sampleTicket("01", { difficulty: "low", title: "Scaffold the project" }),
  sampleTicket("02", { difficulty: "medium", title: "Add the parser", blockedBy: ["01"] }),
  sampleTicket("03", { difficulty: "high", title: "Harden auth", blockedBy: ["02"] }),
];

describe("difficulty in the plan", () => {
  it("shows a Tickets table with the implementer and advisors, and the difficulty in each heading", async () => {
    const { app, taskId } = await ticketWorkflow(tickets);
    const markdown = app.store.readText(taskId, PLAN_FILE)!;
    const section = markdown.slice(markdown.indexOf("## Tickets"));
    expect(section.split("\n").slice(0, 7)).toEqual([
      "## Tickets",
      "",
      "| # | Ticket | Difficulty | Implementer | Advisors | Blocked by |",
      "| --- | --- | --- | --- | --- | --- |",
      "| 01 | Scaffold the project | low | xai/grok-4.7 | — | none |",
      // advisors.fromDifficulty defaults to high: a medium ticket gets no advisor.
      "| 02 | Add the parser | medium | anthropic/claude-sonnet-5-5 | — | 01 |",
      "| 03 | Harden auth | high | openai/gpt-6.1-sol | both | 02 |",
    ]);
    expect(markdown).toContain("### 01 · low · Scaffold the project");
    expect(markdown).toContain("### 03 · high · Harden auth");
    expect(markdown).not.toContain("difficulty: high");
    // The table comes right after the advisor review when there is one, and before the first ticket.
    expect(markdown.indexOf("| # |")).toBeLessThan(markdown.indexOf("### 01"));
  });

  it("puts the table in the plan_tickets result the model sees", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig(), startTurn: () => undefined });
    await app.startPlan("Add retry to the ingest parser");
    await call(createPlanSpecTool(() => app), sampleSpec, headless);
    const params = tickets.map((item) => ({ ...item, implementation: "Do it in src/ingest.ts." }));
    const result = await call(createPlanTicketsTool(() => app), { tickets: params }, headless);
    const text = result.content[0]!.text;
    expect(text).toContain("| 03 | Harden auth | high | openai/gpt-6.1-sol | both | 02 |");
    expect(text).toContain("| # | Ticket | Difficulty | Implementer | Advisors | Blocked by |");
  });

  it("renders the difficulty in a ticket file and omits the table without a config", async () => {
    expect(renderTicket(tickets[2]!)).toContain("**Difficulty: high**");
    const { app, taskId } = await ticketWorkflow(tickets);
    expect(renderPlanReview(app.store.load(taskId)!.plan!, undefined)).not.toContain("| # |");
  });
});
