import { modelLabel, tierCandidates } from "../config.js";
import { selectCandidate } from "../router/select.js";
import { foundrySection } from "./status-foundry.js";
import { PROVIDERS, TIER_KEYS, ticketDifficulty, type AcceptedClassification, type CommandResult, type CostRecord, type ReviewReport, type RoutingDecision, type TaskState } from "../domain.js";
import type { ProviderAuthView } from "../providers/auth.js";
import { summarize, toCsv, unpricedModels } from "../cost/ledger.js";
import { quotaLines } from "../cost/quota.js";
import { availability, candidateCheck, routingSummary } from "./routing.js";
import { clock, reviewOutOfDate, taskState, type GitFacts } from "./state-label.js";
import { reviewRows } from "./review-report.js";
import { budgetState, quotaState, statusFor } from "./budget.js";
import { active, done, fail, guard, type WorkflowContext } from "./context.js";
import { isSecuritySensitive } from "../router/classify.js";
import { costLabel, reviewLabel } from "./build.js";
import { cell, formatUsdShort } from "./format.js";

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

/** One row of the Routing table: the tier, what would run now, and each skipped candidate with its reason. */
export interface RoutingRow {
  tier: string;
  runs: string;
  skipped: string[];
}

/**
 * The Routing table's rows: for each tier the candidate that would run now, and every skipped candidate with its reason
 * (the same reasons route events and stop messages use). Nothing is called and nothing is recorded.
 */
export async function routingCheckRows(ctx: WorkflowContext): Promise<RoutingRow[]> {
  const seen = await availability(ctx);
  const check = candidateCheck(ctx);
  const table = ctx.store.readMetrics();
  const rows: RoutingRow[] = [];
  for (const tier of TIER_KEYS) {
    const selection = selectCandidate({ tier, taskType: "general", config: ctx.config, table, availability: seen, candidateCheck: check, strictAvailability: true, rng: () => 0.5, at: ctx.now() });
    const label = (item: { provider: string; model: string }) => modelLabel(ctx.config, item.provider, item.model);
    const usable = selection.considered.filter((item) => !item.excludedReason);
    const others = usable.filter((item) => item.provider !== selection.candidate?.provider || item.model !== selection.candidate?.model).map(label);
    rows.push({
      tier,
      runs: selection.candidate
        ? `${label(selection.candidate)}${others.length > 0 ? ` (also usable: ${others.join(", ")})` : ""}`
        : `nothing usable${tierCandidates(ctx.config, tier).length === 0 ? " (no model configured)" : ""}`,
      skipped: selection.considered.filter((item) => item.excludedReason).map((item) => `${label(item)}: ${item.excludedReason}`),
    });
  }
  return rows;
}

const mdTable = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)];

/** "Review" row: how the last review went, in a phrase. */
function reviewSummary(review: ReviewReport | undefined, git: GitFacts): string {
  if (!review) return "not run";
  const rows = reviewRows(review);
  const kept = rows.filter((row) => row.item).length;
  const dropped = rows.filter((row) => !row.item && row.verdict.startsWith("dropped")).length;
  const when = clock(review.at);
  const text = review.passed
    ? [`passed${when ? ` ${when}` : ""}`, kept + dropped > 0 ? `${kept} kept, ${dropped} dropped` : "no findings"]
    : ["did not pass", `${kept} finding${kept === 1 ? "" : "s"}`];
  return [...text, ...(reviewOutOfDate(review, git) ? ["out of date"] : [])].join(" · ");
}

/** The Tickets table: each planned ticket with its difficulty, implementer, review, cost, and status. */
function ticketTable(state: TaskState): string[] {
  const tickets = state.plan?.tickets ?? [];
  if (tickets.length === 0) return [];
  const rows = tickets.map((ticket) => {
    const run = state.ticketRuns?.[ticket.id];
    const result = run?.status === "done" ? `done${run.commit ? ` ${run.commit.slice(0, 7)}` : ""}` : run?.status === "failed" ? `failed${run.error ? `: ${run.error}` : ""}` : run && run.attempts > 0 ? "in progress" : "pending";
    return [cell(ticket.id), cell(ticket.title, 60), ticketDifficulty(ticket), cell(run?.provider && run.model ? `${run.provider}/${run.model}` : "-"), cell(reviewLabel(run)), cell(costLabel(run)), cell(result, 80)];
  });
  return ["### Tickets", "", ...mdTable(["#", "Ticket", "Difficulty", "Implementer", "Review", "Cost", "Status"], rows)];
}

/** The `/status` markdown: the state line, a summary table, tickets, routing, logins, and warnings. */
export async function statusMarkdown(ctx: WorkflowContext, state: TaskState | undefined, auth: ProviderAuthView[]): Promise<{ markdown: string; stateLine: string }> {
  const records = ctx.store.readLedger();
  const budget = budgetState(ctx, state?.taskId, records);
  const corrupt = state ? ctx.store.corruptEventLines(state.taskId) : 0;
  const git: GitFacts = {};
  let ahead: number | undefined;
  try {
    git.head = await ctx.git.head();
    if (state?.build) ahead = await ctx.git.aheadOf(state.build.base);
  } catch {
    // Not a repository, or no commit yet: the git facts stay out of the report.
  }
  const label = taskState(state, state?.review, git);
  const approved = state?.approvedVersion;
  const plan = approved ? `v${approved} approved${clock(state?.approvedAt) ? ` ${clock(state?.approvedAt)}` : ""}` : state?.plan ? `Draft v${state.plan.version}` : "none";
  const summary = routingSummary(ctx);
  const unknown = budget.task.unknownRecords;
  const budgetCell = [
    `task ${unknown > 0 ? "≥ " : ""}${formatUsdShort(budget.task.knownUsd)} / $${ctx.config.budgets.taskUsd}`,
    `daily ${budget.daily.unknownRecords > 0 ? "≥ " : ""}${formatUsdShort(budget.daily.knownUsd)} / $${ctx.config.budgets.dailyUsd}`,
    budget.status,
    ...(unknown + budget.daily.unknownRecords > 0 ? [`${unknown} task / ${budget.daily.unknownRecords} daily record(s) with unknown cost, counted at an estimate`] : []),
  ].join(" · ");
  const pairs: [string, string][] = [
    ["Task", state ? `${state.taskId} (${state.phase})` : "none"],
    ["Plan", plan],
    ["Branch", state?.build ? `${state.build.branch} (base ${state.build.base})${ahead !== undefined ? ` · ${ahead} commit${ahead === 1 ? "" : "s"} ahead` : ""}` : "not started"],
    ["Review", reviewSummary(state?.review, git)],
    ["Next", label.next],
    ["Budget", budgetCell],
    ["Session model", `${summary.session}${ctx.config.session.pin ? " (pinned)" : ""}`],
    ...(state?.classification ? [["Rating", classificationLine(state.classification).replace(/^Rating \(([^)]*)\): /, "$1: ")] as [string, string]] : []),
    ...(state?.routing ? [["Last route", routeLine(ctx, state.routing)] as [string, string]] : []),
  ];
  const routing = (await routingCheckRows(ctx)).map((row) => [cell(row.tier), cell(row.runs, 160), cell(row.skipped.join("; ") || "-", 400)]);
  const logins = auth.map((view) => [cell(view.provider), view.method === "api-key" && view.status === "ready" ? "api-key" : view.status, cell(`${view.method}${view.detail ? ` · ${view.detail}` : ""}`, 160)]);
  const missingPricing = unpricedModels(records, ctx.config.pricing);
  const warnings = [
    ...(ctx.config.warnings ?? []).map((warning) => `Config: ${warning}`),
    ...(corrupt > 0 ? [`${corrupt} corrupt line(s) in the task event log. state.json is the source of truth; inspect events.jsonl.`] : []),
    ...(missingPricing.length > 0 ? [`No pricing row for ${missingPricing.join(", ")}; their spend is unknown. Add a row to pricing.`] : []),
    ...(state?.blockedReason && !["BLOCKED", "PAUSED", "FAILED"].includes(state.phase) ? [`Note: ${state.blockedReason}`] : []),
  ];
  const tickets = state ? ticketTable(state) : [];
  const markdown = [
    `## Status · ${label.line}`,
    "",
    "| | |",
    "| --- | --- |",
    ...pairs.map(([key, value]) => `| ${key} | ${cell(value, 400)} |`),
    ...(tickets.length > 0 ? ["", ...tickets] : []),
    "",
    "### Routing",
    "",
    ...mdTable(["Tier", "Runs", "Skipped"], routing),
    "",
    "### Logins",
    "",
    ...mdTable(["Provider", "Status", "Detail"], logins),
    ...(warnings.length > 0 ? ["", "### Warnings", "", ...warnings.map((warning) => `- ${warning}`)] : []),
  ].join("\n");
  return { markdown, stateLine: label.line };
}

async function statusReport(ctx: WorkflowContext, arg: string): Promise<CommandResult> {
  if (arg !== "" && arg !== "foundry") return fail("USAGE", "Use /status or /status foundry.");
  const state = active(ctx);
  const auth = await Promise.all(PROVIDERS.map((provider) => ctx.authProbe.inspect(provider)));
  const { markdown: base, stateLine } = await statusMarkdown(ctx, state, auth);
  const markdown = arg === "foundry" ? [base, "", ...(await foundrySection(ctx))].join("\n") : base;
  // The chat block holds the tables (no clipping); the command result stays one line. Without a UI the result is the markdown.
  ctx.report?.(markdown);
  const budget = budgetState(ctx, state?.taskId).status;
  return done(ctx.report ? stateLine : markdown, { state, auth, budget, corruptEventLines: state ? ctx.store.corruptEventLines(state.taskId) : 0, stateLine });
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
