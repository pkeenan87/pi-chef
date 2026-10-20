import type { CommandResult, CostRecord, Phase, TaskState, TokenUsage } from "../domain.js";
import { budgetStatusFor, buildCostRecord, recordsForDay, summarize, type SpendSummary } from "../cost/ledger.js";
import { quotaUsage, type QuotaUsage } from "../cost/quota.js";
import { active, fail, type WorkflowContext } from "./context.js";

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
  const { dailyUsd, taskUsd, softWarningRatio, unknownCallUsd } = ctx.config.budgets;
  const daily = summarize(recordsForDay(records, ctx.now()), { pricing, unknownCallUsd });
  const task = summarize(taskId ? records.filter((record) => record.taskId === taskId) : [], { pricing, unknownCallUsd });
  const statuses = [budgetStatusFor(daily, dailyUsd, softWarningRatio), budgetStatusFor(task, taskUsd, softWarningRatio)];
  return { status: statuses.includes("hard") ? "hard" : statuses.includes("soft") ? "soft" : "ok", daily, task };
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

/** Budget state for callers outside the workflow (for example web_search). Warns once on "soft". */
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
  /** A fixed id and time, for a call recorded after the fact (Pi's own calls, read from the session file). */
  when: { id?: string; at?: Date } = {},
): CostRecord {
  // Any call while a /build ticket runs (compaction, web_search, a batch summary) counts toward that ticket's cost.
  const running = ctx.store.load(taskId)?.build?.currentTicket;
  if (running && !/ ticket \S+$/.test(reason)) reason = `${reason} · ticket ${running}`;
  const entry = buildCostRecord({ provider, model, phase, taskId, tier, usage, outcome, retries, reason }, ctx.config.pricing, when.at ?? ctx.now(), when.id ?? ctx.id());
  // Model-free work (a failure before any request) reports zero tokens: that is a known zero charge, not an unknown one.
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
  return record(ctx, state.taskId, phase, tier, provider, model, usage, outcome, retries, reason);
}

export function observeUsage(ctx: WorkflowContext, input: { provider: string; model: string; usage: TokenUsage }): CostRecord | undefined {
  const state = active(ctx);
  const known = input.usage.input !== null && input.usage.output !== null;
  const base = known ? "observed assistant usage" : "observed assistant usage missing tokens";
  // No task: still ledger the turn so it counts toward the daily limit.
  if (!state) return record(ctx, SESSION_TASK_ID, "IDLE", "interactive", input.provider, input.model, input.usage, "unknown", 0, base);
  // While /build runs a ticket, the turn is that ticket's spend (/cost and the build report read it back).
  const reason = state.build?.currentTicket ? `${base} · ticket ${state.build.currentTicket}` : base;
  return remember(ctx, state, state.phase, "interactive", input.provider, input.model, input.usage, "unknown", 0, reason);
}

/** A session-file entry as `sessionManager.getEntries()` returns it; only the fields the ledger reads. */
interface PiEntry {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  kind?: unknown;
  provider?: unknown;
  model?: unknown;
  fromHook?: unknown;
  usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } };
}

/**
 * Ledgers the model calls Pi makes on its own, which never reach `message_end`: cache-warming refreshes (`usage`
 * entries), and the compaction and branch summaries Pi wrote itself (a hook's own summary is ledgered where it ran).
 * Each entry is recorded once, under the id `pi-<session>-<entry>`, at the entry's time, on the active task; entries
 * older than `since` (when this extension began watching the session) are left alone.
 * `model` is the session's model, the one Pi summarizes with; a usage entry names its own.
 */
export function recordPiUsage(ctx: WorkflowContext, input: { sessionId: string; entries: readonly unknown[]; model?: { provider: string; id: string }; since?: Date }): CostRecord[] {
  const seen = (ctx.piLedgered ??= new Set(ctx.store.readLedger().map((entry) => entry.id).filter((id) => id.startsWith("pi-"))));
  const state = active(ctx);
  const out: CostRecord[] = [];
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  for (const raw of input.entries) {
    const entry = raw as PiEntry;
    if (typeof entry?.id !== "string" || !entry.usage) continue;
    const job =
      entry.type === "usage" ? `Pi ${String(entry.kind ?? "usage").replace(/_/g, " ").replace(/^cache warm$/, "cache warming")}`
      : entry.type === "compaction" && entry.fromHook !== true ? "Pi compaction"
      : entry.type === "branch_summary" && entry.fromHook !== true ? "Pi branch summary"
      : undefined;
    if (!job) continue;
    const id = `pi-${input.sessionId}-${entry.id}`;
    const at = typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp)) ? new Date(entry.timestamp) : ctx.now();
    // A resumed session's history belongs to whatever ran then, not to the task active now.
    if (seen.has(id) || (input.since && at < input.since)) continue;
    seen.add(id);
    const provider = typeof entry.provider === "string" ? entry.provider : input.model?.provider ?? "pi";
    const model = typeof entry.model === "string" ? entry.model : input.model?.id ?? "unknown";
    const listed = count(entry.usage.cost?.total);
    const usage: TokenUsage = { input: count(entry.usage.input), output: count(entry.usage.output), cacheRead: count(entry.usage.cacheRead), cacheWrite: count(entry.usage.cacheWrite), requests: 1, ...(listed !== null ? { listPriceUsd: listed } : {}) };
    out.push(record(ctx, state?.taskId ?? SESSION_TASK_ID, state?.phase ?? "IDLE", "pi", provider, model, usage, "success", 0, job, { id, at }));
  }
  return out;
}

/**
 * Ledgers one web_search call (Anthropic subscription, Haiku). The query text is deliberately not stored.
 * Per-search fees are not priced: only token cost from `pricing` rows is computed.
 */
export function recordWebSearch(ctx: WorkflowContext, input: { provider: string; model: string; inputTokens: number; outputTokens: number; webSearchRequests: number; taskId?: string }): CostRecord {
  const state = input.taskId ? ctx.store.load(input.taskId) : active(ctx);
  const usage: TokenUsage = { input: input.inputTokens, output: input.outputTokens, cacheRead: 0, cacheWrite: 0, requests: 1 };
  return record(ctx, state?.taskId ?? "web_search", state?.phase ?? "IDLE", "web_search", input.provider, input.model, usage, "success", 0, `web_search (${input.webSearchRequests} search request(s))`);
}
