import { localProfile } from "../config.js";
import { WorkflowError, type PlanAdvisorReview, type PlanDocument, type TaskState, type Ticket } from "../domain.js";
import { needsConfirmation } from "../router/policy.js";
import { active, iso, type WorkflowContext } from "./context.js";
import { activePlanning, planningStatusText, SPEC_FILE } from "./interview.js";
import { move } from "./machine.js";
import { applyOverlap, assertGraph, forNewPlan, PLAN_FILE, renderPlanReview, ticketsTableLines } from "./plan.js";
import { suggestAdvisor } from "./routing.js";
import { projectFileSize, renderTicket, ticketFileName, ticketsToGroups, validateTickets, type TicketCheck } from "./tickets.js";

/** Validates model- or person-written tickets against the config's context target and the files on disk. */
export function checkTickets(ctx: WorkflowContext, input: unknown): TicketCheck {
  // The stored task (no git: plan tools run mid-turn). A local-mode task gets the local target and rules; a hybrid one
  // (localMode.difficulties) only for the tickets the local model builds.
  const task = active(ctx);
  const local = task?.localMode === true ? localProfile(ctx.config) : undefined;
  const only = local ? task?.localDifficulties : undefined;
  return validateTickets(input, {
    target: local && !only ? local.targetTokens : ctx.config.workers.ticketContextTokens,
    fileSize: (file) => projectFileSize(ctx.cwd, file),
    ...(local ? { local: { label: local.label, difficulties: only ?? local.difficulties, maxFiles: local.maxFiles, needChecks: ctx.config.checks.length === 0, ...(only ? { only, targetTokens: local.targetTokens } : {}) } } : {}),
  });
}

/** Throws unless a task is at the ticket stage (spec saved). */
export function requireTicketStage(ctx: WorkflowContext): void {
  const found = activePlanning(ctx);
  if (!found) throw new WorkflowError("NO_INTERVIEW", "No /plan is running. Start one with /plan <request>.");
  if (found.task.planning!.stage !== "tickets") throw new WorkflowError("WRONG_STAGE", "Write the spec first with plan_spec, then call plan_tickets.");
}

function specSummary(ctx: WorkflowContext, taskId: string, fallback: string): string {
  const spec = ctx.store.readText(taskId, SPEC_FILE);
  const match = spec?.match(/^# Spec\s+([\s\S]*?)(?=\n## |$)/);
  return (match?.[1]?.trim() || fallback).slice(0, 400);
}

/** The plan version the draft being written will have. */
export function draftVersion(task: TaskState): number {
  return task.approvedVersion ? task.approvedVersion + 1 : task.plan?.version ?? 1;
}

/** The draft plan document for these tickets, built from the active planning task without saving anything. */
function draftFor(ctx: WorkflowContext, task: TaskState, tickets: Ticket[], at: string, advisorReview?: PlanAdvisorReview): PlanDocument {
  const parsed = applyOverlap(ticketsToGroups(tickets));
  assertGraph(parsed.groups);
  const classification = task.classification;
  const ticketCriteria = tickets.flatMap((ticket) => ticket.acceptanceCriteria.map((item) => `${ticket.id}: ${item}`));
  return {
    version: draftVersion(task),
    createdAt: at,
    summary: specSummary(ctx, task.taskId, task.request),
    risks: classification?.risk === "high" ? ["Security-sensitive change. Human approval stays required."] : ["Ordinary change. Plan approval stays required."],
    acceptance: [...new Set([...ticketCriteria, "Configured checks pass with recorded exit codes", "Review reports no blocking findings"])],
    groups: parsed.groups,
    overlap: parsed.overlap,
    securitySensitive: classification ? needsConfirmation(classification, ctx.config) : false,
    tickets,
    ...(task.localMode ? { localMode: true } : {}),
    ...(task.localMode && task.localDifficulties ? { localDifficulties: task.localDifficulties } : {}),
    ...(advisorReview ? { advisorReview } : {}),
  };
}

/**
 * Writes the ticket files, maps tickets to plan groups, and moves the task to AWAITING_PLAN_APPROVAL.
 * Plan approval is still required before /build.
 */
export async function commitTickets(ctx: WorkflowContext, tickets: Ticket[], advisorReview?: PlanAdvisorReview, options: { present?: boolean } = {}): Promise<{ plan: PlanDocument; files: string[]; markdown: string; table: string }> {
  requireTicketStage(ctx);
  const { task } = activePlanning(ctx)!;
  const at = iso(ctx);
  const draft = draftFor(ctx, task, tickets, at, advisorReview);
  await ctx.store.update(task.taskId, "tickets drafted", (current) =>
    move({ ...current, ...forNewPlan(current, draft), plan: draft, planning: undefined, presentPlan: options.present ? { version: draft.version } : undefined, approvedVersion: undefined }, "AWAITING_PLAN_APPROVAL", at),
  );
  const files = ctx.store.replaceTextDir(task.taskId, "tickets", Object.fromEntries(tickets.map((ticket) => [ticketFileName(ticket), renderTicket(ticket)])));
  const markdown = renderPlanReview(draft, ctx.store.readText(task.taskId, SPEC_FILE), ctx.config);
  ctx.store.writeText(task.taskId, "plan.json", JSON.stringify(draft, null, 2));
  ctx.store.writeText(task.taskId, PLAN_FILE, markdown);
  if (draft.securitySensitive) suggestAdvisor(ctx, task.taskId, "security-sensitive plan");
  ctx.planStatus?.(planningStatusText(ctx) ?? `plan · ${tickets.length} tickets ready for review (/show-plan)`);
  return { plan: draft, files, markdown, table: ticketsTableLines(tickets, ctx.config, task).join("\n") };
}

/**
 * Replaces the tickets of the draft that is waiting for approval with edited ones (Edit tickets after the plan was
 * shown), rewrites the ticket files and plan.md.
 */
export async function redraftTickets(ctx: WorkflowContext, tickets: Ticket[]): Promise<PlanDocument> {
  const task = active(ctx);
  if (!task?.plan || task.phase !== "AWAITING_PLAN_APPROVAL") throw new WorkflowError("NO_DRAFT", "There is no draft waiting for approval.");
  const draft = draftFor(ctx, task, tickets, iso(ctx), task.plan.advisorReview);
  await ctx.store.update(task.taskId, "tickets edited", (current) => ({ ...current, ...forNewPlan(current, draft), plan: draft }));
  ctx.store.replaceTextDir(task.taskId, "tickets", Object.fromEntries(tickets.map((ticket) => [ticketFileName(ticket), renderTicket(ticket)])));
  ctx.store.writeText(task.taskId, "plan.json", JSON.stringify(draft, null, 2));
  ctx.store.writeText(task.taskId, PLAN_FILE, renderPlanReview(draft, ctx.store.readText(task.taskId, SPEC_FILE), ctx.config));
  return draft;
}
