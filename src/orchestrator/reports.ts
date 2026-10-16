import { modelLabel, tierCandidates } from "../config.js";
import { selectCandidate } from "../router/select.js";
import { foundryLines } from "./status-foundry.js";
import { PROVIDERS, TIER_KEYS, type AcceptedClassification, type CommandResult, type CostRecord, type RoutingDecision, type TaskState } from "../domain.js";
import { summarize, toCsv, unpricedModels } from "../cost/ledger.js";
import { quotaLines } from "../cost/quota.js";
import { availability, candidateCheck, routingSummary } from "./routing.js";
import { budgetState, quotaState, statusFor } from "./budget.js";
import { active, done, fail, guard, type WorkflowContext } from "./context.js";
import { isSecuritySensitive } from "../router/classify.js";
import { reviewLabel } from "./build.js";
import { formatDuration } from "./format.js";

/** Per-model lines: spend from the ledger and success/failure counts learned by the router. */
function modelBreakdown(ctx: WorkflowContext, records: CostRecord[] = ctx.store.readLedger()): string[] {
  const metrics = ctx.store.readMetrics();
  const rows = new Map<string, { calls: number; usd: number; unknown: number; wins: number; losses: number }>();
  const row = (key: string) => {
    const found = rows.get(key) ?? { calls: 0, usd: 0, unknown: 0, wins: 0, losses: 0 };
    rows.set(key, found);
    return found;
  };
  for (const entry of records) {
    if (!entry.model) continue;
    const found = row(`${entry.provider}/${entry.model}`);
    found.calls += entry.requests;
    if (entry.actualUsd === null) found.unknown += 1;
    else found.usd += entry.actualUsd;
  }
  for (const types of Object.values(metrics)) {
    for (const [key, cell] of Object.entries(types ?? {})) {
      const match = key.match(/^model:[^:]+:(.+)$/);
      if (!match) continue;
      const found = row(match[1]!);
      found.wins += cell.success;
      found.losses += cell.failure;
    }
  }
  return [...rows.entries()].map(
    ([key, v]) => `${key}: ${v.calls} call(s), $${v.usd.toFixed(4)} known${v.unknown ? ` (+${v.unknown} unknown)` : ""}, ${v.wins} success / ${v.losses} failure`,
  );
}

function routingLines(ctx: WorkflowContext): string[] {
  const summary = routingSummary(ctx);
  const list = (models: string[]) => models.join(" | ") || "none";
  return [
    `Routing: session ${summary.session} · compaction ${summary.compaction} · ${summary.batch} · review ${summary.review}`,
    `Ticket models: low ${list(summary.tickets.low)} · medium ${list(summary.tickets.medium)} · high ${list(summary.tickets.high)} · then ${list(summary.tickets.then)} (up to ${ctx.config.routing.maxEscalations} escalation(s))`,
  ];
}

/** How the task is rated and by whom: the planner's rating once plan_spec ran, else the keyword scan of the request. */
function classificationLine(classification: AcceptedClassification): string {
  const security = isSecuritySensitive(classification) ? ", security-sensitive" : "";
  const reason = classification.reason_codes.find((code) => code.startsWith("reason: "));
  return classification.source === "planner"
    ? `Rating (planner): ${classification.complexity} complexity, ${classification.risk} risk${security}${reason ? ` · ${reason.slice(8)}` : ""}`
    : `Rating (keyword scan; the planner rates it during /plan): ${classification.complexity} complexity, ${classification.risk} risk${security}`;
}

function routeLine(ctx: WorkflowContext, routing: RoutingDecision): string {
  const target = routing.provider === "none" ? "literal edits" : modelLabel(ctx.config, routing.provider, routing.model);
  return `${routing.tier} → ${target}${routing.selectionReason ? ` · ${routing.selectionReason}` : ""}`;
}

const fmt = (value: number | null) => (value === null ? "unknown" : `$${value.toFixed(4)}`);

/** One line per ticket that has run: state, model, tokens, cost, and peak context. */
function ticketLines(ctx: WorkflowContext, state: TaskState | undefined): string[] {
  const runs = Object.entries(state?.ticketRuns ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return runs.map(([id, run]) => {
    const model = run.provider && run.model ? modelLabel(ctx.config, run.provider, run.model) : "no model yet";
    const spend = run.costUsd === null ? "cost unknown" : `$${run.costUsd.toFixed(4)}`;
    const split = run.reviews?.length && run.costSplit ? ` (impl ${fmt(run.costSplit.implementer)} · review ${fmt(run.costSplit.review)} · advisors ${fmt(run.costSplit.advisors)})` : "";
    const trail = (run.attemptLog ?? []).map((item) => `${modelLabel(ctx.config, item.provider, item.model)} ${item.outcome === "success" ? "ok" : "failed"} in ${formatDuration(item.elapsedMs)}`).join(", ");
    const review = run.reviews?.length ? ` · review ${reviewLabel(run)}` : "";
    return `Ticket ${id}: ${run.status}${run.difficulty ? ` · ${run.difficulty}` : ""} · ${model}${review} · ${run.tokens} tokens over ${run.turns} turn(s) · ${spend}${split} · ${formatDuration(run.elapsedMs ?? 0)} · peak ~${run.maxContextTokens} ctx${run.crossedTarget ? " (over soft target)" : ""}${run.attempts > 1 ? ` · ${run.attempts} attempts` : ""}${trail ? ` · [${trail}]` : ""}${run.error && run.status !== "done" ? ` · ${run.error.slice(0, 120)}` : ""}`;
  });
}

/** The /build branch, its base, and how many tickets are done. */
function buildLines(state: TaskState | undefined): string[] {
  if (!state?.build) return [];
  const total = state.plan?.tickets?.length ?? 0;
  const finished = Object.values(state.ticketRuns ?? {}).filter((run) => run.status === "done").length;
  return [`Build: ${state.build.branch} (base ${state.build.base}) · tickets ${finished}/${total} done`];
}

export function cost(ctx: WorkflowContext, format = ""): Promise<CommandResult> {
  return guard(() => costReport(ctx, format));
}

async function costReport(ctx: WorkflowContext, format: string): Promise<CommandResult> {
  const records = ctx.store.readLedger();
  const task = active(ctx);
  const summary = summarize(records, { pricing: ctx.config.pricing, unknownCallUsd: ctx.config.budgets.unknownCallUsd });
  const budget = budgetState(ctx, task?.taskId, records);
  const quota = quotaState(ctx, records);
  const quotaText = quotaLines(quota);
  const lines = [
    `Known spend $${summary.knownUsd.toFixed(4)} across ${records.length} record(s). Unknown usage records: ${summary.unknownRecords}, shown as unknown and never as zero (budgets count them at an estimate, $${summary.estimatedUnknownUsd.toFixed(4)} in all).`,
    ...(unpricedModels(records, ctx.config.pricing).length ? [`Models with no pricing row (their spend is unknown and estimated at the provider's dearest rate): ${unpricedModels(records, ctx.config.pricing).join(", ")}. Add a pricing row for each.`] : []),
    `Task budget: ${budget.task.knownUsd.toFixed(4)} / ${ctx.config.budgets.taskUsd} (${statusFor(ctx, budget.task, ctx.config.budgets.taskUsd)}).`,
    `Daily budget: ${budget.daily.knownUsd.toFixed(4)} / ${ctx.config.budgets.dailyUsd} (${statusFor(ctx, budget.daily, ctx.config.budgets.dailyUsd)}).`,
    `By phase: ${JSON.stringify(summary.byPhase)}`,
    `By provider: ${JSON.stringify(summary.byProvider)}`,
    `By model: ${JSON.stringify(summary.byModel)}`,
    ...modelBreakdown(ctx, records).map((line) => `  ${line}`),
    quotaText.length > 0 ? "Subscription quota (ranking only; not billed, not counted toward budgets):" : "",
    ...quotaText.map((line) => `  ${line}`),
    task?.routing ? `Last route: ${routeLine(ctx, task.routing)}` : "",
  ].filter(Boolean);
  if (format.trim() === "csv") return done(toCsv(records), records);
  if (format.trim() === "json") return done(JSON.stringify({ summary, quota, records }, null, 2), { summary, quota, records });
  return done(lines.join("\n"), summary);
}

export function status(ctx: WorkflowContext, arg = ""): Promise<CommandResult> {
  return guard(() => statusReport(ctx, arg.trim()));
}

/**
 * The "Routing check" section: for each tier the candidate that would run now, and every skipped candidate with its
 * reason (the same reasons route events and stop messages use). Nothing is called and nothing is recorded.
 */
export async function routingCheckLines(ctx: WorkflowContext): Promise<string[]> {
  const seen = await availability(ctx);
  const check = candidateCheck(ctx);
  const table = ctx.store.readMetrics();
  const lines = ["Routing check:"];
  for (const tier of TIER_KEYS) {
    const selection = selectCandidate({ tier, taskType: "general", config: ctx.config, table, availability: seen, candidateCheck: check, strictAvailability: true, rng: () => 0.5, at: ctx.now() });
    const label = (item: { provider: string; model: string }) => modelLabel(ctx.config, item.provider, item.model);
    const usable = selection.considered.filter((item) => !item.excludedReason);
    const others = usable.filter((item) => item.provider !== selection.candidate?.provider || item.model !== selection.candidate?.model).map(label);
    lines.push(
      selection.candidate
        ? `  ${tier} → ${label(selection.candidate)}${others.length > 0 ? ` (also usable: ${others.join(", ")})` : ""}`
        : `  ${tier} → nothing usable${tierCandidates(ctx.config, tier).length === 0 ? " (no model configured)" : ""}`,
    );
    for (const item of selection.considered) if (item.excludedReason) lines.push(`    skipped ${label(item)}: ${item.excludedReason}`);
  }
  return lines;
}

async function statusReport(ctx: WorkflowContext, arg: string): Promise<CommandResult> {
  if (arg !== "" && arg !== "foundry") return fail("USAGE", "Use /status or /status foundry.");
  const state = active(ctx);
  const auth = await Promise.all(PROVIDERS.map((provider) => ctx.authProbe.inspect(provider)));
  const budget = budgetState(ctx, state?.taskId).status;
  const corrupt = state ? ctx.store.corruptEventLines(state.taskId) : 0;
  const text = [
    state ? `Task ${state.taskId} phase ${state.phase}` : "No active task.",
    state?.approvedVersion ? `Approved plan v${state.approvedVersion}` : "No approved plan.",
    state?.blockedReason ? `Note: ${state.blockedReason}` : "",
    corrupt > 0 ? `Warning: ${corrupt} corrupt line(s) in the task event log. state.json is the source of truth; inspect events.jsonl.` : "",
    ...buildLines(state),
    ...ticketLines(ctx, state),
    `Budget: ${budget}`,
    ...routingLines(ctx),
    ...(ctx.config.warnings ?? []).map((warning) => `Config warning: ${warning}`),
    state?.classification ? classificationLine(state.classification) : "",
    state?.routing ? `Model: ${routeLine(ctx, state.routing)}` : "",
    ...modelBreakdown(ctx).map((line) => `Model stats: ${line}`),
    ...auth.map((view) => `${view.provider}: ${view.status} (${view.method}) ${view.detail}`),
    ...(await routingCheckLines(ctx)),
    ...(arg === "foundry" ? await foundryLines(ctx) : []),
  ].filter(Boolean);
  return done(text.join("\n"), { state, auth, budget, corruptEventLines: corrupt });
}

export function auth(ctx: WorkflowContext, arg = ""): Promise<CommandResult> {
  return guard(() => authReport(ctx, arg));
}

async function authReport(ctx: WorkflowContext, arg: string): Promise<CommandResult> {
  const [command, provider] = arg.trim().split(/\s+/, 2);
  if (command === "login") {
    if (provider === "foundry") return done("Foundry uses Azure CLI (token audience https://ai.azure.com). Run `az login`, then /auth status. This extension does not collect an API key.");
    if (provider === "vercel") {
      return done("Vercel AI Gateway uses the Vercel CLI. Run `vercel login && vercel link` in the project named by providers.vercel.projectDir. The token (VERCEL_OIDC_TOKEN, valid about 12 hours) is refreshed with `vercel env pull .env.local --yes`. This extension never stores it.");
    }
    if (provider === "local") return done("Local inference uses the configured baseUrl. Start the server yourself, then /auth status. No key is written into the repo.");
    if (provider === "openai") {
      return done("OpenAI account login is Pi's `/login openai`. Choose Sign in with ChatGPT, not the API key prompt. This extension rejects OPENAI_API_KEY.");
    }
    if (provider === "anthropic") {
      return done("Anthropic account login is Pi's `/login anthropic` (Claude Pro/Max). A key saved with `/login anthropic` is used only when the user config sets providers.anthropic.apiKeyFallback: true; it is billed per token, so add `billing: api-key` pricing rows. ANTHROPIC_API_KEY is never read.");
    }
    if (provider === "xai") {
      return done("xAI account login is Pi's `/login xai`. Choose Sign in with SuperGrok or X Premium. XAI_API_KEY is never read.");
    }
    return fail("USAGE", "Use /auth login openai|anthropic|xai|foundry|vercel|local.");
  }
  const views = await Promise.all(PROVIDERS.map((item) => ctx.authProbe.inspect(item)));
  return done(views.map((view) => `${view.provider}\t${view.status}\t${view.method}\t${view.detail}`).join("\n"), views);
}
