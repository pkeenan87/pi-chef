import { modelLabel, tierCandidates } from "../config.js";
import { PROVIDERS, type AcceptedClassification, type RoutingDecision, type Tier, type TicketTier } from "../domain.js";
import { decideRoute } from "../router/policy.js";
import type { Availability } from "../router/select.js";
import { redact } from "../redact.js";
import { budgetRemainingUsd, quotaState } from "./budget.js";
import { iso, type WorkflowContext } from "./context.js";

/** Which providers can be called right now. Providers absent from the config are left out (treated as available). */
export async function availability(ctx: WorkflowContext): Promise<Availability> {
  const out: Availability = {};
  await Promise.all(
    PROVIDERS.filter((provider) => ctx.config.providers[provider]).map(async (provider) => {
      try {
        const view = await ctx.authProbe.inspect(provider);
        out[provider] = { ok: view.status === "ready", detail: view.status === "ready" ? undefined : `${view.status}: ${view.detail}` };
      } catch (error) {
        out[provider] = { ok: false, detail: redact((error as Error).message) };
      }
    }),
  );
  return out;
}

/** decideRoute with live availability, remaining budget, and learned per-model metrics. Does not announce. */
export async function decide(
  ctx: WorkflowContext,
  classification: AcceptedClassification,
  purpose: "plan" | "implement" | "review" | "preview",
  extra: { failedTier?: Tier; escalations?: number; taskId?: string; ticketTier?: Tier; strictAvailability?: boolean } = {},
): Promise<RoutingDecision> {
  return decideRoute(classification, ctx.config, ctx.store.readMetrics(), {
    purpose,
    at: ctx.now(),
    failedTier: extra.failedTier,
    escalations: extra.escalations,
    ticketTier: extra.ticketTier,
    strictAvailability: extra.strictAvailability,
    availability: await availability(ctx),
    budgetRemainingUsd: budgetRemainingUsd(ctx, extra.taskId),
    quota: quotaState(ctx),
    rng: ctx.rng,
  });
}

/** Shows the chosen model in the status line and records a `route` event in the task log. */
export async function announce(
  ctx: WorkflowContext,
  taskId: string | undefined,
  purpose: string,
  decision: { tier: string; provider: string; model: string; selectionReason?: string; considered?: RoutingDecision["considered"]; blocked?: string },
  setStatus: (text: string) => void = (text) => ctx.status?.(text),
): Promise<void> {
  const why = (decision.blocked ?? decision.selectionReason ?? "").split(";")[0]!.slice(0, 80);
  const target = decision.provider === "none" ? "literal edits" : modelLabel(ctx.config, decision.provider, decision.model);
  setStatus(`${decision.tier} → ${target}${why ? ` · ${why}` : ""}`);
  if (!taskId) return;
  const considered = (decision.considered ?? []).map(
    (item) => `${modelLabel(ctx.config, item.provider, item.model)}: ${item.excludedReason ? `excluded (${item.excludedReason})` : item.score !== undefined ? `$${item.score.toFixed(4)}/success${item.quotaUsd ? ` (incl. $${item.quotaUsd.toFixed(4)} quota shadow)` : ""}` : "price unknown"}`,
  );
  await ctx.store.appendRoute(taskId, { purpose, tier: decision.tier, provider: decision.provider, model: decision.model, reason: why, considered }, iso(ctx));
}

/** Who does what under the current config: the session model, compaction, review, and tickets, with their chat models. */
export function routingSummary(ctx: WorkflowContext): { session: string; compaction: string; batch: string; review: string; tickets: { low: string[]; medium: string[]; high: string[]; then: string[] } } {
  const models = (tier: Tier): string[] => tierCandidates(ctx.config, tier).map((item) => modelLabel(ctx.config, item.provider, item.model));
  const { reviewTier } = ctx.config.routing;
  const { model, pin, compactionTier } = ctx.config.session;
  return {
    session: pin ? model : "your own model (session.pin is off)",
    compaction: `${compactionTier}: ${models(compactionTier).join(", ")}`,
    batch: `batch: ${models("batch").join(", ")}`,
    review: `${reviewTier}: ${models(reviewTier).join(", ")}`,
    tickets: { low: models("ticketLow"), medium: models("ticketMedium"), high: models("ticketHigh"), then: models("premium") },
  };
}

/** Tells the user the advisor exists, once per reason per task. Never calls it. */
export function suggestAdvisor(ctx: WorkflowContext, taskId: string, reason: string): void {
  if (tierCandidates(ctx.config, "advisor").length === 0) return;
  const key = `advisor:${taskId}:${reason}`;
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  ctx.notify(`Consider /advisor <question> for a second opinion (${reason}). It runs only when you ask.`);
}
