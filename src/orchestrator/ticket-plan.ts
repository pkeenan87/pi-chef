import { WorkflowError, type PlanDocument, type Ticket } from "../domain.js";
import { remember } from "./budget.js";
import { iso, knownZero, type WorkflowContext } from "./context.js";
import { activePlanning, planningStatusText, SPEC_FILE } from "./interview.js";
import { move } from "./machine.js";
import { applyOverlap, assertGraph, renderPlan } from "./plan.js";
import { suggestAdvisor, announce } from "./routing.js";
import { projectFileSize, renderTicket, ticketFileName, ticketsToGroups, validateTickets, type TicketCheck } from "./tickets.js";

/** Validates model- or person-written tickets against the config's context target and the files on disk. */
export function checkTickets(ctx: WorkflowContext, input: unknown): TicketCheck {
  return validateTickets(input, { target: ctx.config.workers.ticketContextTokens, fileSize: (file) => projectFileSize(ctx.cwd, file) });
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

/**
 * Writes the ticket files, maps tickets to plan groups, and moves the task to AWAITING_PLAN_APPROVAL.
 * Plan approval is still required before /implement.
 */
export async function commitTickets(ctx: WorkflowContext, tickets: Ticket[]): Promise<{ plan: PlanDocument; files: string[] }> {
  requireTicketStage(ctx);
  const { task } = activePlanning(ctx)!;
  const at = iso(ctx);
  const parsed = applyOverlap(ticketsToGroups(tickets));
  assertGraph(parsed.groups);
  const classification = task.classification;
  const routing = task.routing;
  const ticketCriteria = tickets.flatMap((ticket) => ticket.acceptanceCriteria.map((item) => `${ticket.id}: ${item}`));
  const draft: PlanDocument = {
    version: task.approvedVersion ? task.approvedVersion + 1 : task.plan?.version ?? 1,
    createdAt: at,
    summary: specSummary(ctx, task.taskId, task.request),
    risks: classification?.risk === "high" ? ["Security-sensitive change. Human approval stays required."] : ["Ordinary change. Policy still gates publish."],
    acceptance: [...new Set([...ticketCriteria, "Configured checks pass with recorded exit codes", "Review reports no blocking findings"])],
    estimatedUsd: routing?.expectedUsd ?? null,
    groups: parsed.groups,
    overlap: parsed.overlap,
    securitySensitive: routing?.requireHumanApproval ?? false,
    tickets,
  };
  const state = await ctx.store.update(task.taskId, "tickets drafted", (current) =>
    move({ ...current, plan: draft, planning: undefined, approvedVersion: undefined, publishApproved: false }, "AWAITING_PLAN_APPROVAL", at),
  );
  const files = ctx.store.replaceTextDir(task.taskId, "tickets", Object.fromEntries(tickets.map((ticket) => [ticketFileName(ticket), renderTicket(ticket)])));
  ctx.store.writeText(task.taskId, "plan.json", JSON.stringify(draft, null, 2));
  ctx.store.writeText(task.taskId, "plan.md", renderPlan(draft));
  if (routing) {
    remember(ctx, state, state.phase, routing.tier, routing.provider, routing.model, knownZero(), "success", 0, "tickets");
    await announce(ctx, task.taskId, "plan", routing);
  }
  if (draft.securitySensitive) suggestAdvisor(ctx, task.taskId, "security-sensitive plan");
  ctx.planStatus?.(planningStatusText(ctx) ?? `plan · ${tickets.length} tickets ready for /approve-plan`);
  return { plan: draft, files };
}
