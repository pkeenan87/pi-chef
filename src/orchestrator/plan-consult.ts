import { WorkflowError, ticketDifficulty, type PlanAdvisorReview, type PlanConsult, type Ticket } from "../domain.js";
import { redact } from "../redact.js";
import { advisorsFor, availableAdvisors, consultAdvisors, type AdvisorCandidate } from "../review/advisors.js";
import { iso, type WorkflowContext } from "./context.js";
import { activePlanning, SPEC_FILE } from "./interview.js";
import { TICKET_PROMPT_LIMITS } from "./prompts.js";
import { checkTickets, draftVersion, requireTicketStage } from "./ticket-plan.js";

/**
 * The advisor consult of /plan. After the spec is saved and the tickets are drafted, the planning model puts a few
 * specific questions about the riskiest parts to every available advisor (one per provider), in parallel, then
 * resolves any disagreement itself and calls plan_tickets with its resolution. Advisors advise; they never gate, and
 * the user still approves the plan. The packet is the saved spec, the draft tickets and the questions: never the
 * session transcript.
 */

const label = (item: { provider: string; model: string }) => `${item.provider}/${item.model}`;

/** Every advisor that can be called now, one per provider; empty when the plan consult is off or there is no model connection. */
export async function planAdvisors(ctx: WorkflowContext): Promise<AdvisorCandidate[]> {
  if (!ctx.config.advisors.plan || !ctx.chat) return [];
  const found = await availableAdvisors(ctx);
  return advisorsFor({ difficulty: "high", implementerProvider: "", candidates: found.candidates });
}

/** The draft tickets in a compact form: what is needed to judge the design, not every field. */
export function compactTickets(tickets: Ticket[]): string {
  return tickets
    .map((ticket) =>
      [
        `### ${ticket.id}: ${ticket.title} (difficulty ${ticketDifficulty(ticket)}; blocked by ${ticket.blockedBy.join(", ") || "none"})`,
        ticket.whatToBuild,
        ...(ticket.implementation ? [`Implementation: ${ticket.implementation.slice(0, 1200)}`] : []),
        ...(ticket.files?.length ? [`Files: ${ticket.files.join(", ")}`] : []),
        `Acceptance: ${ticket.acceptanceCriteria.join("; ")}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/** The consult packet: the saved spec (clipped), then the draft tickets. Never a transcript. */
export function planPacket(spec: string, tickets: Ticket[]): string {
  const clipped = spec.length > TICKET_PROMPT_LIMITS.spec ? `${spec.slice(0, TICKET_PROMPT_LIMITS.spec)}\n[truncated]` : spec;
  return redact(["# Spec (the plan being reviewed)", "", clipped, "", "# Draft tickets", "", compactTickets(tickets)].join("\n"));
}

export interface ConsultOutcome {
  consult: PlanConsult;
  /** True when this draft was already consulted and the stored answers are returned without a model call. */
  repeat: boolean;
}

/** plan_consult: validates the draft tickets, consults every available advisor once per draft, and stores the answers on the task. */
export async function consultPlan(ctx: WorkflowContext, input: { tickets: unknown; questions: unknown }): Promise<ConsultOutcome> {
  requireTicketStage(ctx);
  const found = activePlanning(ctx)!;
  const check = checkTickets(ctx, input.tickets);
  if (check.errors.length) throw new WorkflowError("TICKETS_INVALID", `Tickets rejected. Fix these and call plan_consult again:\n- ${check.errors.join("\n- ")}`);
  const version = draftVersion(found.task);
  const stored = found.task.planning!.consult;
  if (stored && stored.version === version) return { consult: stored, repeat: true };
  const questions = (Array.isArray(input.questions) ? input.questions : []).filter((item): item is string => typeof item === "string").map((item) => redact(item.trim()).slice(0, 400)).filter(Boolean);
  if (questions.length < 2 || questions.length > 3) throw new WorkflowError("QUESTIONS_INVALID", "Ask 2 or 3 specific questions about the riskiest parts of the plan.");
  const spec = ctx.store.readText(found.task.taskId, SPEC_FILE) ?? "";
  const asked = await consultAdvisors(ctx, { purpose: "plan", packet: planPacket(spec, check.tickets), questions, candidates: await planAdvisors(ctx), taskId: found.task.taskId });
  const consult: PlanConsult = { version, questions, results: asked.results, ...(asked.skipped ? { skipped: asked.skipped } : {}), at: iso(ctx) };
  await ctx.store.update(found.task.taskId, "plan consult", (task) => (task.planning ? { ...task, planning: { ...task.planning, consult } } : task));
  return { consult, repeat: false };
}

/** Drops the stored consult: the draft was sent back for changes, so the revised draft may consult again. */
export async function clearConsult(ctx: WorkflowContext): Promise<void> {
  const found = activePlanning(ctx);
  if (!found?.task.planning?.consult) return;
  await ctx.store.update(found.task.taskId, "plan consult cleared", (task) => {
    if (!task.planning) return task;
    const { consult: _dropped, ...rest } = task.planning;
    return { ...task, planning: rest };
  });
}

/**
 * What plan_tickets needs before it shows the plan. With advisors available it refuses, deterministically, until a
 * consult exists for this draft and the model has written its resolution. With none available, or when the budget
 * skipped them, nothing is required and the plan carries a note instead. Off (`advisors.plan: false`): no section.
 */
export async function adviceForTickets(ctx: WorkflowContext, resolution: string | undefined): Promise<PlanAdvisorReview | undefined> {
  if (!ctx.config.advisors.plan) return undefined;
  const found = activePlanning(ctx)!;
  const consult = found.task.planning!.consult?.version === draftVersion(found.task) ? found.task.planning!.consult : undefined;
  const text = redact((resolution ?? "").trim()).slice(0, 3000);
  if (!consult) {
    if ((await planAdvisors(ctx)).length === 0) return { note: "Advisors were not consulted: none is available." };
    throw new WorkflowError("CONSULT_REQUIRED", "Call plan_consult first: put 2-3 specific questions about the riskiest parts of the draft to the advisors, resolve their answers, then call plan_tickets with advisorResolution.");
  }
  if (consult.skipped) return { consult, note: `Advisors were not consulted: ${consult.skipped}.`, ...(text ? { resolution: text } : {}) };
  if (!text) throw new WorkflowError("RESOLUTION_REQUIRED", "advisorResolution is required: say which advisor points you accepted, which you rejected, and why. Then call plan_tickets again.");
  return { consult, resolution: text };
}

/** The tool result for Opus: the answers and concerns, then the instruction to resolve. */
export function consultResultText(outcome: ConsultOutcome): string {
  const { consult } = outcome;
  const body: string[] = [];
  if (consult.skipped) body.push(`No advisor was consulted: ${consult.skipped}.`);
  for (const opinion of consult.results) {
    if (opinion.error) {
      body.push(`## ${label(opinion)}\nDid not answer: ${opinion.error}`);
      continue;
    }
    body.push(
      [
        `## ${label(opinion)} (verdict: ${opinion.verdict ?? "unsure"})`,
        ...opinion.answers.map((item) => `Q: ${item.question}\nA: ${item.answer}`),
        ...(opinion.concerns.length ? ["Concerns:", ...opinion.concerns.map((item) => `- ${item.severity.toUpperCase()} ${item.file ? `${item.file}: ` : ""}${item.issue}${item.suggestion ? ` (suggestion: ${item.suggestion})` : ""}`)] : ["No concerns raised."]),
      ].join("\n"),
    );
  }
  return [
    outcome.repeat ? "This draft was already consulted; these are the stored answers (no new model calls were made)." : `Advisors answered ${consult.questions.length} question(s).`,
    "",
    ...body,
    "",
    "Resolve any disagreement yourself. Then call plan_tickets with the final tickets and `advisorResolution`: what you accepted, what you rejected, and why.",
  ].join("\n");
}
