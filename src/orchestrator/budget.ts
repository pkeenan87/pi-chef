import { fromMicroUsd, toMicroUsd } from "../config.js";
import type { CommandResult, CostRecord, Phase, TaskState, TokenUsage } from "../domain.js";
import { budgetStatusFor, buildCostRecord, recordsForDay, summarize, type SpendSummary } from "../cost/ledger.js";
import { quotaUsage, type QuotaUsage } from "../cost/quota.js";
import type { ClassifierUsage } from "../router/classify.js";
import { active, fail, type WorkflowContext } from "./context.js";
import type { InFlightRun } from "./inflight.js";

/** Pseudo task id for interactive turns that happen with no active task. */
export const SESSION_TASK_ID = "session";

export type BudgetStatus = "ok" | "soft" | "hard";

export interface BudgetState {
  status: BudgetStatus;
  daily: SpendSummary;
  task: SpendSummary;
}

export function budgetState(ctx: WorkflowContext, taskId?: string, records = ctx.store.readLedger()): BudgetState {
  const pricing = ctx.config.pricing;
  const { dailyUsd, taskUsd, softWarningRatio } = ctx.config.budgets;
  const daily = summarize(recordsForDay(records, ctx.now()), { pricing });
  const task = summarize(taskId ? records.filter((record) => record.taskId === taskId) : [], { pricing });
  const statuses = [budgetStatusFor(daily, dailyUsd, softWarningRatio), budgetStatusFor(task, taskUsd, softWarningRatio)];
  return { status: statuses.includes("hard") ? "hard" : statuses.includes("soft") ? "soft" : "ok", daily, task };
}

/**
 * Adds one model call's cost (USD) to a running child's in-flight spend and stops every child that would push the task or
 * the day over its limit: the ledger plus all in-flight spend must stay within the limit. Returns the stop reason, if any.
 * The overshoot is at most the cost of the call that crossed the line.
 */
export function chargeInFlight(ctx: WorkflowContext, run: InFlightRun, usd: number): string | undefined {
  if (!Number.isFinite(usd) || usd <= 0) return run.tripped;
  run.micro += toMicroUsd(usd);
  const { task, daily } = budgetState(ctx, run.taskId);
  const taskSpent = toMicroUsd(task.knownUsd + task.estimatedUnknownUsd) + ctx.inflight.taskMicro(run.taskId);
  const dailySpent = toMicroUsd(daily.knownUsd + daily.estimatedUnknownUsd) + ctx.inflight.totalMicro();
  if (taskSpent > toMicroUsd(ctx.config.budgets.taskUsd)) ctx.inflight.tripAll(`The task budget ($${ctx.config.budgets.taskUsd}) would be exceeded mid-run.`, run.taskId);
  if (dailySpent > toMicroUsd(ctx.config.budgets.dailyUsd)) ctx.inflight.tripAll(`The daily budget ($${ctx.config.budgets.dailyUsd}) would be exceeded mid-run.`);
  return run.tripped;
}

export function statusFor(ctx: WorkflowContext, summary: SpendSummary, limit: number): BudgetStatus {
  return budgetStatusFor(summary, limit, ctx.config.budgets.softWarningRatio);
}

/** Smaller of the task and daily budget left (USD). Estimated unknown spend counts, as in budgetState. */
export function budgetRemainingUsd(ctx: WorkflowContext, taskId?: string): number {
  const { task, daily } = budgetState(ctx, taskId);
  const taskLeft = taskId ? ctx.config.budgets.taskUsd - task.knownUsd - task.estimatedUnknownUsd : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(taskLeft, ctx.config.budgets.dailyUsd - daily.knownUsd - daily.estimatedUnknownUsd));
}

/** Subscription quota use per provider. Ranking only: it never feeds budgetState or the ledger. */
export function quotaState(ctx: WorkflowContext, records = ctx.store.readLedger()): QuotaUsage {
  return quotaUsage(records, ctx.config, ctx.now());
}

export function warnSoft(ctx: WorkflowContext, key: string): void {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  ctx.notify("Budget warning: spend is near the task or daily limit. Run /cost for details.");
}

/** Returns a refusal when the budget is exhausted, and warns (once per task) when it is nearly spent. */
export function gateBudget(ctx: WorkflowContext, taskId: string): CommandResult | undefined {
  const { status } = budgetState(ctx, taskId);
  if (status === "hard") return fail("BUDGET", "Task or daily budget is exhausted. Unknown charges were not treated as zero.");
  if (status === "soft") warnSoft(ctx, taskId);
  return undefined;
}

/** Budget state for callers outside the workflow (for example the virtual model route). Warns once on "soft". */
export function checkBudget(ctx: WorkflowContext, taskId?: string): BudgetStatus {
  const { status } = budgetState(ctx, taskId);
  if (status === "soft") warnSoft(ctx, taskId ?? "daily");
  return status;
}

export function record(
  ctx: WorkflowContext,
  taskId: string,
  phase: Phase,
  tier: string,
  provider: string,
  model: string,
  usage: TokenUsage,
  outcome: CostRecord["outcome"],
  retries: number,
  reason: string,
  estimatedUsd: number | null = null,
): CostRecord {
  const entry = buildCostRecord({ provider, model, phase, taskId, tier, usage, outcome, retries, reason, estimatedUsd }, ctx.config.pricing, ctx.now(), ctx.id());
  // Literal edits and other model-free work report zero tokens: that is a known zero charge, not an unknown one.
  if (usage.input === 0 && usage.output === 0 && entry.actualUsd === null) {
    entry.actualUsd = 0;
    entry.usageKnown = true;
  }
  ctx.store.appendLedger(entry);
  return entry;
}

/** Ledger entry for a task, carrying the task's estimated cost. */
export function remember(
  ctx: WorkflowContext,
  state: TaskState,
  phase: TaskState["phase"],
  tier: string,
  provider: string,
  model: string,
  usage: TokenUsage,
  outcome: CostRecord["outcome"],
  retries: number,
  reason: string,
): CostRecord {
  return record(ctx, state.taskId, phase, tier, provider, model, usage, outcome, retries, reason, state.routing?.estimatedUsd ?? null);
}

export function recordClassifier(ctx: WorkflowContext, taskId: string, phase: Phase, usage: ClassifierUsage | undefined): void {
  if (!usage) return;
  record(ctx, taskId, phase, "classifier", usage.provider, usage.model, usage.usage, "success", 0, "classify");
}

export function observeUsage(ctx: WorkflowContext, input: { provider: string; model: string; usage: TokenUsage }): CostRecord | undefined {
  const state = active(ctx);
  const known = input.usage.input !== null && input.usage.output !== null;
  const reason = known ? "observed assistant usage" : "observed assistant usage missing tokens";
  // No task: still ledger the turn so it counts toward the daily limit.
  if (!state) return record(ctx, SESSION_TASK_ID, "IDLE", "interactive", input.provider, input.model, input.usage, "unknown", 0, reason);
  return remember(ctx, state, state.phase, "interactive", input.provider, input.model, input.usage, "unknown", 0, reason);
}

/**
 * Ledgers one web_search call (Anthropic subscription, Haiku). The query text is deliberately not stored.
 * Per-search fees are not priced: only token cost from `pricing` rows is computed.
 */
export function recordWebSearch(ctx: WorkflowContext, input: { provider: string; model: string; inputTokens: number; outputTokens: number; webSearchRequests: number; /** Charge this task instead of the active one (ticket child processes). */ taskId?: string }): CostRecord {
  const state = input.taskId ? ctx.store.load(input.taskId) : active(ctx);
  const usage: TokenUsage = { input: input.inputTokens, output: input.outputTokens, cacheRead: 0, cacheWrite: 0, requests: 1 };
  return record(ctx, state?.taskId ?? "web_search", state?.phase ?? "IDLE", "web_search", input.provider, input.model, usage, "success", 0, `web_search (${input.webSearchRequests} search request(s))`);
}

/**
 * Ledgers one ticket attempt from the child's JSON events (the child itself ledgers nothing).
 * Cost is Pi's own `cost.total` when it is positive, otherwise priced from config, otherwise unknown (null).
 * A child that reported no usage at all is an unknown charge, never zero.
 */
export function recordTicketUsage(
  ctx: WorkflowContext,
  state: TaskState,
  input: { tier: string; provider: string; model: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null; turns: number }; outcome: CostRecord["outcome"]; retries: number; reason: string },
): CostRecord {
  const reported = input.usage.turns > 0;
  const usage: TokenUsage = reported
    ? { input: input.usage.input, output: input.usage.output, cacheRead: input.usage.cacheRead, cacheWrite: input.usage.cacheWrite, requests: input.usage.turns }
    : { input: null, output: null, cacheRead: null, cacheWrite: null, requests: 0 };
  const entry = buildCostRecord({ provider: input.provider, model: input.model, phase: state.phase, taskId: state.taskId, tier: input.tier, usage, outcome: input.outcome, retries: input.retries, reason: input.reason, estimatedUsd: state.routing?.estimatedUsd ?? null }, ctx.config.pricing, ctx.now(), ctx.id());
  if (reported && input.usage.costUsd !== null && input.usage.costUsd > 0) {
    entry.actualUsd = fromMicroUsd(toMicroUsd(input.usage.costUsd));
    entry.usageKnown = true;
  }
  ctx.store.appendLedger(entry);
  return entry;
}
