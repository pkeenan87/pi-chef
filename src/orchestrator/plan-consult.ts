import { createHash } from "node:crypto";
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

/** Every advisor that can be called now, one per provider, and why the others were skipped; empty when the plan consult is off or there is no model connection. */
export async function planAdvisors(ctx: WorkflowContext, taskId?: string): Promise<{ candidates: AdvisorCandidate[]; notes: string[] }> {
  if (!ctx.config.advisors.plan || !ctx.chat) return { candidates: [], notes: [] };
  const found = await availableAdvisors(ctx, taskId);
  return { candidates: advisorsFor({ difficulty: "high", implementerProvider: "", candidates: found.candidates }), notes: found.notes };
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([key, item]) => [key, canonical(item)]))
      : value;

/** sha256 of the spec and the canonical ticket JSON: what the advisors were (or would be) shown. */
export function consultHash(spec: string, tickets: Ticket[]): string {
  return createHash("sha256").update(spec).update("\0").update(JSON.stringify(canonical(tickets))).digest("hex");
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
  /** True when the draft changed but the limit of consults per draft version was reached, so the latest answers are returned. */
  capped?: boolean;
}

/** One consult at a time per task: a parallel second call gets the first one's result instead of paying again. */
const inflight = new Map<string, Promise<ConsultOutcome>>();

/**
 * plan_consult: validates the draft tickets and consults every available advisor. A repeat for the same spec and
 * tickets returns the stored answers; a changed draft consults again (a deliberate paid call), at most
 * `advisors.maxPlanConsults` times per draft version.
 */
export async function consultPlan(ctx: WorkflowContext, input: { tickets: unknown; questions: unknown }): Promise<ConsultOutcome> {
  requireTicketStage(ctx);
  const taskId = activePlanning(ctx)!.task.taskId;
  const running = inflight.get(taskId);
  if (running) return running;
  const started = runConsult(ctx, input).finally(() => inflight.delete(taskId));
  inflight.set(taskId, started);
  return started;
}

async function runConsult(ctx: WorkflowContext, input: { tickets: unknown; questions: unknown }): Promise<ConsultOutcome> {
  const found = activePlanning(ctx)!;
  const check = checkTickets(ctx, input.tickets);
  if (check.errors.length) throw new WorkflowError("TICKETS_INVALID", `Tickets rejected. Fix these and call plan_consult again:\n- ${check.errors.join("\n- ")}`);
  const version = draftVersion(found.task);
  const spec = ctx.store.readText(found.task.taskId, SPEC_FILE) ?? "";
  const hash = consultHash(spec, check.tickets);
  const stored = found.task.planning!.consult;
  const same = stored && stored.version === version ? stored : undefined;
  if (same && (same.hash === undefined || same.hash === hash)) return { consult: same, repeat: true };
  if (same && (same.consults ?? 1) >= ctx.config.advisors.maxPlanConsults) return { consult: same, repeat: true, capped: true };
  const questions = (Array.isArray(input.questions) ? input.questions : []).filter((item): item is string => typeof item === "string").map((item) => redact(item.trim()).slice(0, 400)).filter(Boolean);
  if (questions.length < 2 || questions.length > 3) throw new WorkflowError("QUESTIONS_INVALID", "Ask 2 or 3 specific questions about the riskiest parts of the plan.");
  const available = await planAdvisors(ctx, found.task.taskId);
  const asked = await consultAdvisors(ctx, { purpose: "plan", packet: planPacket(spec, check.tickets), questions, candidates: available.candidates, taskId: found.task.taskId });
  const skipped = asked.skipped ? [asked.skipped, ...available.notes].join("; ") : undefined;
  const consult: PlanConsult = { version, questions, results: asked.results, ...(skipped ? { skipped } : {}), at: iso(ctx), hash, consults: (same?.consults ?? (same ? 1 : 0)) + 1 };
  await ctx.store.update(found.task.taskId, "plan consult", (task) => (task.planning ? { ...task, planning: { ...task.planning, consult } } : task));
  return { consult, repeat: false };
}

/**
 * What plan_tickets needs before it shows the plan. With advisors available it refuses, deterministically, until a
 * consult exists for this draft and the model has written its resolution. With none available, or when the budget
 * skipped them, nothing is required and the plan carries a note instead. Off (`advisors.plan: false`): no section.
 */
export async function adviceForTickets(ctx: WorkflowContext, resolution: string | undefined, tickets: Ticket[], reconsultWaived = false): Promise<PlanAdvisorReview | undefined> {
  if (!ctx.config.advisors.plan) return undefined;
  const found = activePlanning(ctx)!;
  const consult = found.task.planning!.consult?.version === draftVersion(found.task) ? found.task.planning!.consult : undefined;
  const text = redact((resolution ?? "").trim()).slice(0, 3000);
  if (!consult) {
    if ((await planAdvisors(ctx, found.task.taskId)).candidates.length === 0) return { note: "Advisors were not consulted: none is available." };
    throw new WorkflowError("CONSULT_REQUIRED", "Call plan_consult first: put 2-3 specific questions about the riskiest parts of the draft to the advisors, resolve their answers, then call plan_tickets with advisorResolution.");
  }
  if (consult.skipped) return { consult, note: `Advisors were not consulted: ${consult.skipped}.`, ...(text ? { resolution: text } : {}) };
  if (!text) throw new WorkflowError("RESOLUTION_REQUIRED", "advisorResolution is required: say which advisor points you accepted, which you rejected, and why. Then call plan_tickets again.");
  // The advisors judged a specific spec and ticket list; changed tickets need new advice or a stated reason they do not.
  const changed = consult.hash !== undefined && consult.hash !== consultHash(ctx.store.readText(found.task.taskId, SPEC_FILE) ?? "", tickets);
  if (changed && !reconsultWaived) {
    throw new WorkflowError("RECONSULT_REQUIRED", "The tickets changed since plan_consult; call plan_consult again for this draft (or explain in advisorResolution why the change needs no new advice and set `reconsultWaived: true`).");
  }
  return { consult, resolution: text, ...(changed ? { reconsultWaived: true } : {}) };
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
    outcome.capped ? "This draft was already consulted the most times allowed; these are the latest stored answers for an earlier version of the tickets (no new model calls were made). Resolve them, and if the tickets changed since, set `reconsultWaived: true` in plan_tickets and say why in advisorResolution." : outcome.repeat ? "This draft was already consulted; these are the stored answers (no new model calls were made)." : `Advisors answered ${consult.questions.length} question(s).`,
    "",
    ...body,
    "",
    "Resolve any disagreement yourself. Then call plan_tickets with the final tickets and `advisorResolution`: what you accepted, what you rejected, and why.",
  ].join("\n");
}
