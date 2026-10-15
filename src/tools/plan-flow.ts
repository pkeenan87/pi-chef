import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { InterviewQuestion } from "../orchestrator/interview.js";
import type { Workflow } from "../orchestrator/service.js";
import { parseTicketsMarkdown, renderTicketsMarkdown } from "../orchestrator/tickets.js";
import { TIERS, type Ticket } from "../domain.js";
import { askQuestions } from "./plan-questions.js";

const text = (value: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: value }], details });

export const PlanSpecParams = Type.Object({
  summary: Type.String({ description: "What will be built and why, in a short paragraph" }),
  decisions: Type.Array(
    Type.Object({ question: Type.String(), answer: Type.String(), rationale: Type.String() }),
    { description: "One entry per decision settled in the interview" },
  ),
  assumptions: Type.Array(Type.String(), { description: "Decisions made without asking (the choice and why)" }),
  outOfScope: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
});

export function createPlanSpecTool(getWorkflow: () => Workflow | undefined) {
  return defineTool({
    name: "plan_spec",
    label: "Plan Spec",
    description: "Save the spec for the task being planned (summary, decisions, assumptions, out of scope, risks). Call once, after the interview. Only usable while /plan is running.",
    promptSnippet: "plan_spec: save the planning spec",
    parameters: PlanSpecParams,
    async execute(_id, params) {
      const workflow = getWorkflow();
      if (!workflow) throw new Error("The cost workflow is not available.");
      const saved = await workflow.savePlanSpec(params);
      return text(`Spec saved to ${saved.file}. Now call plan_tickets.`, { file: saved.file });
    },
  });
}

export const PlanTicketsParams = Type.Object({
  tickets: Type.Array(
    Type.Object({
      id: Type.String({ description: 'Two-digit ordinal, for example "01"' }),
      slug: Type.String({ description: "lowercase-kebab-case, used in the file name" }),
      title: Type.String(),
      whatToBuild: Type.String({ description: "The end-to-end behavior to deliver, not a layer-by-layer task list" }),
      acceptanceCriteria: Type.Array(Type.String(), { description: "At least one checkable criterion" }),
      blockedBy: Type.Array(Type.String(), { description: "Ids of tickets that must finish first" }),
      suggestedTier: Type.Optional(Type.String({ description: `One of: ${TIERS.join(", ")}` })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Optional ownership hints" })),
      estimatedContextTokens: Type.Number({ description: "Your estimate of the tokens one fresh context needs for this ticket" }),
      checks: Type.Optional(Type.Array(Type.String(), { description: "Extra checks to run for this ticket" })),
    }),
  ),
});

const GRANULARITY: InterviewQuestion = {
  id: "granularity",
  title: "Tickets",
  prompt: "Do these tickets look like the right size?",
  options: [
    { value: "approve", label: "Approve tickets" },
    { value: "merge", label: "Merge small tickets" },
    { value: "split", label: "Split a ticket" },
    { value: "edit", label: "Edit dependencies" },
  ],
  recommended: "approve",
  reason: "each ticket is a vertical slice within the context target",
};

export function createPlanTicketsTool(getWorkflow: () => Workflow | undefined) {
  return defineTool({
    name: "plan_tickets",
    label: "Plan Tickets",
    description:
      "Submit the tickets (vertical, independently testable slices, each within one context window) for the saved spec. The tool validates them, asks the user a short granularity question, writes the ticket files, and drafts the plan for /approve-plan. Only usable after plan_spec.",
    promptSnippet: "plan_tickets: submit the vertical-slice tickets for the spec",
    parameters: PlanTicketsParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const workflow = getWorkflow();
      if (!workflow) throw new Error("The cost workflow is not available.");
      workflow.requireTicketStage();
      let check = workflow.checkTickets(params.tickets);
      if (check.errors.length) throw new Error(`Tickets rejected. Fix these and call plan_tickets again:\n- ${check.errors.join("\n- ")}`);
      let tickets: Ticket[] = check.tickets;
      let edited = false;
      if (ctx.hasUI) {
        // Granularity check. It is not part of the interview, so it does not count toward the question cap.
        for (;;) {
          const result = await askQuestions(ctx, [GRANULARITY], { allowOther: false, heading: `${tickets.length} tickets` });
          const choice = result.cancelled ? undefined : result.answers[0]?.value;
          if (choice === undefined) return text("The user dismissed the granularity check. The tickets were not saved. Ask how they want to proceed.");
          if (choice === "approve") break;
          if (choice === "merge") return text("The user asked to merge small tickets. Merge neighbours that are too small to be worth a fresh context (keep each within the context target), then call plan_tickets again. Nothing was saved.");
          if (choice === "split") {
            const picked = await ctx.ui.select("Split which ticket?", tickets.map((ticket) => `${ticket.id}: ${ticket.title}`));
            if (picked === undefined) continue;
            return text(`The user asked to split ticket ${picked}. Split it into smaller vertical slices, then call plan_tickets again. Nothing was saved.`);
          }
          const changed = await ctx.ui.editor("Edit the tickets (titles, criteria, Blocked by)", renderTicketsMarkdown(tickets));
          if (changed === undefined) continue;
          check = workflow.checkTickets(parseTicketsMarkdown(changed));
          if (check.errors.length) {
            ctx.ui.notify(`Edited tickets are invalid, keeping the previous version:\n- ${check.errors.join("\n- ")}`, "warning");
            continue;
          }
          tickets = check.tickets;
          edited = true;
        }
      }
      const { plan, files } = await workflow.commitTickets(tickets);
      const summary = `${tickets.length} tickets written (${files.length} files). Plan v${plan.version} is a draft: the user must run /approve-plan before /implement.${edited ? " The user edited the tickets before approving." : ""} Stop here and do not implement anything.`;
      return text(summary, { tickets, files, version: plan.version });
    },
  });
}
