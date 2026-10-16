import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Workflow } from "../orchestrator/service.js";
import { parseTicketsMarkdown, renderTicketsMarkdown } from "../orchestrator/tickets.js";
import { DIFFICULTIES, TIERS, type Ticket } from "../domain.js";
import type { PlanReviewAction } from "../orchestrator/types.js";
import { consultResultText } from "../orchestrator/plan-consult.js";
import { reviewPlan } from "./plan-review.js";

const text = (value: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: value }], details });

export const PlanSpecParams = Type.Object({
  summary: Type.String({ description: "What will be built and why, in a short paragraph" }),
  context: Type.String({ description: "What the code does today in the area that changes, naming the files and functions you read" }),
  approach: Type.String({
    description: "The technical design: components and how they connect, data flow, new types and function signatures, error handling, config. Markdown lists and ### headings are fine.",
  }),
  changes: Type.Array(
    Type.Object({
      path: Type.String({ description: "Repo-relative file path" }),
      change: Type.String({ description: "The concrete change: functions, types, fields, or exports added or modified (or 'new file: ...')" }),
    }),
    { description: "Every file to create or modify" },
  ),
  reuse: Type.Array(Type.String(), { description: "Existing functions, types, and utilities to build on, with their paths" }),
  decisions: Type.Array(
    Type.Object({ question: Type.String(), answer: Type.String(), rationale: Type.String() }),
    { description: "One entry per decision settled in the interview" },
  ),
  assumptions: Type.Array(Type.String(), { description: "Decisions made without asking (the choice and why)" }),
  outOfScope: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  verification: Type.Array(Type.String(), { description: "Tests to add and commands to run to prove the change works end to end" }),
});

export function createPlanSpecTool(getWorkflow: () => Workflow | undefined) {
  return defineTool({
    name: "plan_spec",
    label: "Plan Spec",
    description:
      "Save the technical plan for the task being planned: summary, current context, approach (design, types, signatures), the files to change, what to reuse, decisions, assumptions, out of scope, risks, and verification. Call after the interview (again during ticket review to revise it). Only usable while /plan is running.",
    promptSnippet: "plan_spec: save the planning spec",
    parameters: PlanSpecParams,
    async execute(_id, params) {
      const workflow = getWorkflow();
      if (!workflow) throw new Error("The cost workflow is not available.");
      const saved = await workflow.savePlanSpec(params);
      return text(`Spec saved to ${saved.file}. Now draft the tickets, call plan_consult with 2-3 specific questions about the riskiest parts, resolve the answers, then call plan_tickets.`, { file: saved.file });
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
      implementation: Type.String({
        description: "The technical steps: files to create or change, functions/types/signatures to add (by name), how they wire into existing code, and the tests to write. Use lists or ### headings, never # or ##.",
      }),
      acceptanceCriteria: Type.Array(Type.String(), { description: "At least one checkable criterion" }),
      blockedBy: Type.Array(Type.String(), { description: "Ids of tickets that must finish first" }),
      difficulty: Type.Optional(Type.String({ description: `One of: ${DIFFICULTIES.join(", ")}. Picks the model: low is mechanical or small and well specified; medium is typical feature work; high is cross-cutting, tricky logic, concurrency, security, or a large blast radius.` })),
      suggestedTier: Type.Optional(Type.String({ description: `Old plans only; use difficulty. One of: ${TIERS.join(", ")}` })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Files this ticket touches (ownership hints; overlapping tickets run one after another)" })),
      estimatedContextTokens: Type.Number({ description: "Your estimate of the tokens one fresh context needs for this ticket" }),
      checks: Type.Optional(Type.Array(Type.String(), { description: "Shell command lines the parent runs after the ticket, one command per entry (for example \"npm test\"); destructive commands are refused. Not prose: verification steps that are not a command go in implementation." })),
    }),
  ),
  advisorResolution: Type.Optional(
    Type.String({ description: "After plan_consult: what you accepted from the advisors, what you rejected, and why. Required whenever advisors were consulted." }),
  ),
});

export const PlanConsultParams = Type.Object({
  tickets: PlanTicketsParams.properties.tickets,
  questions: Type.Array(Type.String(), { description: "2-3 specific questions about the riskiest parts of the draft, for the advisors" }),
});

export function createPlanConsultTool(getWorkflow: () => Workflow | undefined) {
  return defineTool({
    name: "plan_consult",
    label: "Plan Consult",
    description:
      "Put the draft tickets and 2-3 specific questions about the riskiest parts of the plan to the advisors (every available one, in parallel). Returns their answers and concerns. Call once per draft, after plan_spec and before plan_tickets. Only usable while /plan is running.",
    promptSnippet: "plan_consult: ask the advisors about the draft tickets",
    parameters: PlanConsultParams,
    async execute(_id, params) {
      const workflow = getWorkflow();
      if (!workflow) throw new Error("The cost workflow is not available.");
      const outcome = await workflow.consultPlan(params);
      return text(consultResultText(outcome), { version: outcome.consult.version, repeat: outcome.repeat, advisors: outcome.consult.results.map((item) => ({ provider: item.provider, model: item.model, verdict: item.verdict, error: item.error })) });
    },
  });
}

const REVIEW_ACTIONS: PlanReviewAction[] = [
  { value: "approve", label: "Approve plan" },
  { value: "revise", label: "Request changes", input: "What should change in the plan? (spec or tickets)" },
  { value: "edit", label: "Edit tickets" },
  { value: "save", label: "Save as draft" },
];

export function createPlanTicketsTool(getWorkflow: () => Workflow | undefined) {
  return defineTool({
    name: "plan_tickets",
    label: "Plan Tickets",
    description:
      "Submit the tickets (vertical, independently testable slices, each within one context window, each with technical implementation steps) for the saved spec. The tool validates them, shows the user the full plan for review, writes the ticket files, and saves the plan as a draft, or approves it when the user chooses Approve. Only usable after plan_spec.",
    promptSnippet: "plan_tickets: submit the vertical-slice tickets for the spec",
    parameters: PlanTicketsParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const workflow = getWorkflow();
      if (!workflow) throw new Error("The cost workflow is not available.");
      workflow.requireTicketStage();
      let check = workflow.checkTickets(params.tickets);
      if (check.errors.length) throw new Error(`Tickets rejected. Fix these and call plan_tickets again:\n- ${check.errors.join("\n- ")}`);
      // Advisors were consulted (or could not be): refuses until plan_consult ran and the resolution is written.
      const advisorReview = await workflow.adviceForTickets(params.advisorResolution);
      let tickets: Ticket[] = check.tickets;
      let edited = false;
      let approve = false;
      if (ctx.hasUI) {
        // The person sees the whole plan (spec and tickets) before anything is saved.
        for (;;) {
          const choice = await reviewPlan(ctx, { title: `Review the plan · ${tickets.length} tickets`, markdown: workflow.previewPlan(tickets, advisorReview), actions: REVIEW_ACTIONS });
          // Closing the review (Esc) keeps the work: it saves the draft like "Save as draft".
          if (!choice || choice.value === "save") break;
          if (choice.value === "approve") {
            approve = true;
            break;
          }
          if (choice.value === "revise") {
            // The revised draft is a new draft: it may consult the advisors again.
            await workflow.clearConsult();
            return text(
              `The user reviewed the plan and asked for these changes. Nothing was saved.\n\n${choice.text ?? ""}\n\nApply them: call plan_spec again if the spec changes, then call plan_consult again for the revised draft and plan_tickets with the full revised ticket list and your advisorResolution.`,
            );
          }
          const changed = await ctx.ui.editor("Edit the tickets (titles, implementation, criteria, Blocked by)", renderTicketsMarkdown(tickets));
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
      const { plan, files, markdown } = await workflow.commitTickets(tickets, advisorReview);
      // Also kept in the transcript (posted when this turn ends), so the plan stays visible.
      workflow.showMarkdown(markdown);
      const editNote = edited ? " The user edited the tickets before saving." : "";
      const ending = "End your turn with a two-line summary; do not repeat the plan and do not implement anything.";
      if (approve) {
        const approved = await workflow.approveDraft();
        if (!approved.ok) throw new Error(`The tickets were saved but approval failed: ${approved.text}`);
        return text(`${tickets.length} tickets written (${files.length} files). The user approved plan v${plan.version}; they run /build next.${editNote} ${ending}`, { tickets, files, version: plan.version, approved: true });
      }
      const summary = `${tickets.length} tickets written (${files.length} files). Plan v${plan.version} is a draft and was shown to the user in full. Draft saved; the user can /show-plan to approve it later.${editNote} ${ending}`;
      return text(summary, { tickets, files, version: plan.version, approved: false });
    },
  });
}
