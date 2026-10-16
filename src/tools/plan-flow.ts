import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Workflow } from "../orchestrator/service.js";
import { DIFFICULTIES, TIERS, type Ticket } from "../domain.js";
import { consultResultText } from "../orchestrator/plan-consult.js";
import { isSecuritySensitive } from "../router/classify.js";

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
  complexity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "How hard the whole task is" }),
  risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "How much it could break production behavior" }),
  securitySensitive: Type.Boolean({ description: "True when it touches authentication, authorization, secrets, credentials, permissions or production deployment. A keyword scan of the request and spec can raise this, never lower it." }),
  classificationReason: Type.String({ description: "One short sentence on why you rated it this way" }),
});

export function createPlanSpecTool(getWorkflow: () => Workflow | undefined) {
  return defineTool({
    name: "plan_spec",
    label: "Plan Spec",
    description:
      "Save the technical plan for the task being planned: summary, current context, approach (design, types, signatures), the files to change, what to reuse, decisions, assumptions, out of scope, risks, verification, and your rating of the task (complexity, risk, securitySensitive, classificationReason). Call after the interview (again during ticket review to revise it). Only usable while /plan is running.",
    promptSnippet: "plan_spec: save the planning spec",
    parameters: PlanSpecParams,
    async execute(_id, params) {
      const workflow = getWorkflow();
      if (!workflow) throw new Error("The cost workflow is not available.");
      const saved = await workflow.savePlanSpec(params);
      const rated = saved.classification;
      const rating = `Rated ${rated.complexity} complexity, ${rated.risk} risk${isSecuritySensitive(rated) ? ", security-sensitive" : ""}${saved.keywordRaised ? " (the keyword scan marked it security-sensitive; you cannot lower that)" : ""}.`;
      return text(`Spec saved to ${saved.file}. ${rating} Now draft the tickets, call plan_consult with 2-3 specific questions about the riskiest parts, resolve the answers, then call plan_tickets.`, { file: saved.file, classification: rated });
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
      suggestedTier: Type.Optional(Type.String({ description: `Old plans only; use difficulty. One of: ${TIERS.filter((tier) => tier !== "batch").join(", ")}` })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Files this ticket touches (ownership hints; overlapping tickets run one after another)" })),
      estimatedContextTokens: Type.Number({ description: "Your estimate of the tokens one fresh context needs for this ticket" }),
      checks: Type.Optional(Type.Array(Type.String(), { description: "Shell command lines the parent runs after the ticket, one command per entry (for example \"npm test\"); destructive commands are refused. Not prose: verification steps that are not a command go in implementation." })),
    }),
  ),
  advisorResolution: Type.Optional(
    Type.String({ description: "After plan_consult: what you accepted from the advisors, what you rejected, and why. Required whenever advisors were consulted." }),
  ),
  reconsultWaived: Type.Optional(
    Type.Boolean({ description: "Set true only when the tickets changed after plan_consult and the change needs no new advice; say why in advisorResolution." }),
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
      "Put the draft tickets and 2-3 specific questions about the riskiest parts of the plan to the advisors (every available one, in parallel). Returns their answers and concerns. Call once per draft (a changed draft may consult again, at most twice), after plan_spec and before plan_tickets. Only usable while /plan is running.",
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

export function createPlanTicketsTool(getWorkflow: () => Workflow | undefined) {
  return defineTool({
    name: "plan_tickets",
    label: "Plan Tickets",
    description:
      "Submit the tickets (vertical, independently testable slices, each within one context window, each with technical implementation steps) for the saved spec. The tool validates them, writes the ticket files, and saves the plan as a draft. When the turn ends the user sees the full plan and chooses Approve, Request changes, Edit tickets or Save as draft. Only usable after plan_spec.",
    promptSnippet: "plan_tickets: submit the vertical-slice tickets for the spec",
    parameters: PlanTicketsParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const workflow = getWorkflow();
      if (!workflow) throw new Error("The cost workflow is not available.");
      workflow.requireTicketStage();
      const check = workflow.checkTickets(params.tickets);
      if (check.errors.length) throw new Error(`Tickets rejected. Fix these and call plan_tickets again:\n- ${check.errors.join("\n- ")}`);
      // Advisors were consulted (or could not be): refuses until plan_consult ran and the resolution is written.
      const advisorReview = await workflow.adviceForTickets(params.advisorResolution, check.tickets, params.reconsultWaived);
      // With a UI the plan is shown once this turn has settled (see presentPendingPlan), as markdown, then the person decides.
      const inline = ctx.hasUI && typeof ctx.ui.select === "function";
      const tickets: Ticket[] = check.tickets;
      const { plan, files, markdown, table } = await workflow.commitTickets(tickets, advisorReview, { present: inline });
      if (inline) {
        return text(
          `${tickets.length} tickets written (${files.length} files). The plan is saved as a draft and will be shown to the user for approval when this turn ends. End your turn now with a one-line summary; do not repeat the plan.\n\n${table}`,
          { tickets, files, version: plan.version, approved: false },
        );
      }
      // No UI: the plan is posted in the chat when this turn ends, and approved later with /show-plan.
      workflow.showMarkdown(markdown);
      const ending = "End your turn with a two-line summary; do not repeat the plan and do not implement anything.";
      const summary = `${tickets.length} tickets written (${files.length} files). Plan v${plan.version} is a draft and was shown to the user in full. Draft saved; the user can /show-plan to approve it later.\n\n${table}\n\nMention in your summary how many tickets are low, medium and high and who builds them. ${ending}`;
      return text(summary, { tickets, files, version: plan.version, approved: false });
    },
  });
}
