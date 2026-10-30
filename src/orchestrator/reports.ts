import path from "node:path";
import { localProfile, modelLabel, tierCandidates, type WorkflowConfig } from "../config.js";
import { selectCandidate } from "../router/select.js";
import { foundrySection } from "./status-foundry.js";
import { PROVIDERS, ticketDifficulty, type AcceptedClassification, type CommandResult, type CostRecord, type ReviewReport, type TaskState, type TierKey } from "../domain.js";
import type { ProviderAuthView } from "../providers/auth.js";
import { summarize, toCsv, unpricedModels } from "../cost/ledger.js";
import { quotaLines } from "../cost/quota.js";
import { atomicWrite } from "../storage/store.js";
import { availability, candidateCheck, routingSummary } from "./routing.js";
import { clock, reviewOutOfDate, taskState, type GitFacts } from "./state-label.js";
import { reviewRows } from "./review-report.js";
import { budgetState, quotaState, statusFor } from "./budget.js";
import { done, fail, guard, type WorkflowContext } from "./context.js";
import { activeTask, displayName, listTasks, unfinishedTasks } from "./tasks.js";
import { isSecuritySensitive } from "../router/classify.js";
import { costLabel, resultLabel, reviewLabel } from "./build.js";
import { cell, flat, formatDuration, formatUsd, formatUsdShort, mdTable } from "./format.js";

/**
 * How the task is rated and by whom: the planner's rating once plan_spec ran, else the keyword scan of the request.
 * Only risk and the security flag act on anything (premium review, the /build confirmation).
 */
function ratingLine(classification: AcceptedClassification): string {
  const security = isSecuritySensitive(classification) ? " · security-sensitive" : "";
  const reason = classification.reason_codes.find((code) => code.startsWith("reason: "));
  return classification.source === "planner"
    ? `${classification.risk} risk${security} (planner${reason ? `: ${reason.slice(8)}` : ""})`
    : `${classification.risk} risk${security} (keyword scan; the planner rates it during /plan)`;
}

export function cost(ctx: WorkflowContext, format = ""): Promise<CommandResult> {
  return guard(() => costReport(ctx, format.trim()));
}

/**
 * The job a ledger row paid for: its reason without the ticket tag (` · ticket 01`, or ` ticket 01` as the ticket
 * review and its advisors write it) and the detail in parentheses. The main session's turns split into the turns of a
 * /build ticket, the planning conversation, and the rest.
 */
function jobOf(entry: CostRecord): string {
  const ticket = / ticket \S+$/.test(entry.reason);
  const job = entry.reason.replace(/(?: ·)? ticket \S+$/, "").replace(/\s*[(:].*$/, "").trim();
  if (!job.startsWith("observed assistant usage")) return job || "other";
  return ticket ? "ticket turns" : entry.phase === "PLANNING" ? "planning turns" : "session turns";
}

/**
 * Per key, largest first: calls, known spend, rows whose cost is unknown, and the total with those rows at the estimate
 * budgets count them at (tokens at the provider's dearest row, else Pi's own price, else budgets.unknownCallUsd).
 */
function spendRows(ctx: WorkflowContext, records: CostRecord[], key: (entry: CostRecord) => string, extra?: (key: string) => string[]): string[][] {
  const groups = new Map<string, CostRecord[]>();
  for (const entry of records) groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry]);
  return [...groups.entries()]
    .map(([name, rows]) => ({ name, calls: rows.reduce((sum, entry) => sum + entry.requests, 0), spend: summarize(rows, { pricing: ctx.config.pricing, unknownCallUsd: ctx.config.budgets.unknownCallUsd }) }))
    .sort((a, b) => b.spend.knownUsd + b.spend.estimatedUnknownUsd - (a.spend.knownUsd + a.spend.estimatedUnknownUsd))
    .map(({ name, calls, spend }) => [
      cell(name),
      String(calls),
      formatUsd(spend.knownUsd),
      spend.unknownRecords > 0 ? String(spend.unknownRecords) : "-",
      spend.unknownRecords > 0 ? `≈ ${formatUsd(spend.knownUsd + spend.estimatedUnknownUsd)}` : formatUsd(spend.knownUsd),
      ...(extra?.(name) ?? []),
    ]);
}

/** Success and failure counts the router learned per `provider/model`, over every tier and task type. */
function outcomes(ctx: WorkflowContext): Map<string, { wins: number; losses: number }> {
  const out = new Map<string, { wins: number; losses: number }>();
  for (const types of Object.values(ctx.store.readMetrics())) {
    for (const [key, stat] of Object.entries(types ?? {})) {
      const match = key.match(/^model:[^:]+:(.+)$/);
      if (!match) continue;
      const found = out.get(match[1]!) ?? { wins: 0, losses: 0 };
      found.wins += stat.success;
      found.losses += stat.failure;
      out.set(match[1]!, found);
    }
  }
  return out;
}

async function costReport(ctx: WorkflowContext, format: string): Promise<CommandResult> {
  const records = ctx.store.readLedger();
  const task = await activeTask(ctx);
  const summary = summarize(records, { pricing: ctx.config.pricing, unknownCallUsd: ctx.config.budgets.unknownCallUsd });
  const budget = budgetState(ctx, task?.taskId, records);
  const quota = quotaState(ctx, records);
  // The exports are files: a chat line is clipped, and a ledger is long.
  if (format === "csv" || format === "json") {
    const file = path.join(ctx.store.root, "reports", `cost-${ctx.now().toISOString().replace(/[-:.]/g, "").slice(0, 15)}.${format}`);
    atomicWrite(file, format === "csv" ? toCsv(records) : JSON.stringify({ summary, quota, records }, null, 2));
    return done(`Wrote ${records.length} ledger record(s) to ${file}.`, { file, summary });
  }
  if (format !== "") return fail("USAGE", "Use /cost, /cost csv, or /cost json.");
  const unpriced = unpricedModels(records, ctx.config.pricing);
  const results = outcomes(ctx);
  const names = new Map(listTasks(ctx).map((item) => [item.taskId, displayName(item)]));
  const line = `Known spend ${formatUsd(summary.knownUsd)} across ${records.length} record(s)${summary.unknownRecords > 0 ? ` · ${summary.unknownRecords} with unknown cost, estimated at ${formatUsd(summary.estimatedUnknownUsd)} · total ≈ ${formatUsd(summary.knownUsd + summary.estimatedUnknownUsd)}` : ""}`;
  const markdown = [
    `## Cost · ${line}`,
    "",
    `Budget: task ${formatUsdShort(budget.task.knownUsd)} / $${ctx.config.budgets.taskUsd} (${statusFor(ctx, budget.task, ctx.config.budgets.taskUsd)}) · daily ${formatUsdShort(budget.daily.knownUsd)} / $${ctx.config.budgets.dailyUsd} (${statusFor(ctx, budget.daily, ctx.config.budgets.dailyUsd)})`,
    ...(unpriced.length ? ["", `No pricing row for ${unpriced.join(", ")}: their spend is unknown. Add a row to pricing.`] : []),
    "",
    "### By model",
    "",
    ...mdTable(["Model", "Calls", "Known", "Unknown rows", "Total", "Success / failure"], spendRows(ctx, records, (entry) => `${entry.provider}/${entry.model}`, (name) => {
      const found = results.get(name);
      return [found ? `${found.wins} / ${found.losses}` : "-"];
    })),
    "",
    "### By job",
    "",
    ...mdTable(["Job", "Calls", "Known", "Unknown rows", "Total"], spendRows(ctx, records, jobOf)),
    "",
    "### By task",
    "",
    ...mdTable(["Task", "Calls", "Known", "Unknown rows", "Total"], spendRows(ctx, records, (entry) => names.get(entry.taskId) ?? entry.taskId)),
    ...(Object.keys(quota).length > 0 ? ["", "### Subscription quota (ranks models; never billed or budgeted)", "", ...quotaLines(quota).map((item) => `- ${item}`)] : []),
  ].join("\n");
  ctx.report?.(markdown);
  return done(ctx.report ? line : markdown, summary);
}

export function status(ctx: WorkflowContext, arg = ""): Promise<CommandResult> {
  return guard(() => statusReport(ctx, arg.trim()));
}

/** One row of the Routing table: the jobs a tier serves, what would run now, and each skipped candidate with its reason. */
export interface RoutingRow {
  tier: string;
  jobs: string;
  runs: string;
  skipped: string[];
}

/** The tiers the config uses, each with the jobs it serves, in workflow order. Tiers no job uses are left out. */
export function tierJobs(config: WorkflowConfig): [TierKey, string[]][] {
  const jobs = new Map<TierKey, string[]>();
  const add = (tier: TierKey, job: string) => jobs.set(tier, [...(jobs.get(tier) ?? []), job]);
  add("ticketLow", "low tickets");
  add("ticketMedium", "medium tickets");
  add("ticketHigh", "high tickets");
  if (config.providers.local) add("local", "local-mode tickets");
  add("premium", "a failed high ticket");
  add(config.routing.reviewTier, "review (per ticket and /review)");
  if (config.routing.reviewTier !== "premium") add("premium", "review of security-sensitive work");
  add("advisor", "advisors");
  add(config.session.compactionTier, "compaction");
  add(tierCandidates(config, "batch").length > 0 ? "batch" : "cheap", "summaries of cut files");
  return [...jobs.entries()];
}

/**
 * The Routing table's rows: for each tier a job uses, the candidate that would run now, and every skipped candidate
 * with its reason (the same reasons route events and stop messages use). Nothing is called and nothing is recorded.
 */
export async function routingCheckRows(ctx: WorkflowContext): Promise<RoutingRow[]> {
  const seen = await availability(ctx);
  const check = candidateCheck(ctx);
  const table = ctx.store.readMetrics();
  const rows: RoutingRow[] = [];
  for (const [tier, jobs] of tierJobs(ctx.config)) {
    const selection = selectCandidate({ tier, taskType: "general", config: ctx.config, table, availability: seen, candidateCheck: check, strictAvailability: true, rng: () => 0.5, at: ctx.now() });
    const label = (item: { provider: string; model: string }) => modelLabel(ctx.config, item.provider, item.model);
    const usable = selection.considered.filter((item) => !item.excludedReason);
    const others = usable.filter((item) => item.provider !== selection.candidate?.provider || item.model !== selection.candidate?.model).map(label);
    rows.push({
      tier,
      jobs: jobs.join(", "),
      runs: selection.candidate
        ? `${label(selection.candidate)}${others.length > 0 ? ` (also usable: ${others.join(", ")})` : ""}`
        : `nothing usable${tierCandidates(ctx.config, tier).length === 0 ? " (no model configured)" : ""}`,
      skipped: selection.considered.filter((item) => item.excludedReason).map((item) => `${label(item)}: ${item.excludedReason}`),
    });
  }
  return rows;
}


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
function ticketTable(ctx: WorkflowContext, state: TaskState): string[] {
  const tickets = state.plan?.tickets ?? [];
  if (tickets.length === 0) return [];
  const rows = tickets.map((ticket) => {
    const run = state.ticketRuns?.[ticket.id];
    const result = resultLabel(run, true);
    return [cell(ticket.id), cell(ticket.title, 60), ticketDifficulty(ticket), cell(run?.provider && run.model ? modelLabel(ctx.config, run.provider, run.model) : "-"), cell(reviewLabel(run)), cell(costLabel(run)), cell(result, 80)];
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
    ["Task", state ? `${displayName(state)} (${state.taskId})` : "none"],
    ...(state?.localMode ? [["Mode", ((profile) => `local: ${state.localDifficulties ? `${state.localDifficulties.join("/")} tickets run on ${profile.model}, the rest on the cloud ticket tiers` : `every ticket runs on ${profile.model}`} (tickets sized for a ${profile.label}: ${(state.localDifficulties ?? profile.difficulties).join("/")}, at most ${profile.maxFiles} files, ${profile.targetTokens} tokens); review stays on ${ctx.config.routing.reviewTier}`)(localProfile(ctx.config))] as [string, string]] : []),
    ["Plan", plan],
    ["Branch", state?.build ? `${state.build.branch} (base ${state.build.base})${ahead !== undefined ? ` · ${ahead} commit${ahead === 1 ? "" : "s"} ahead` : ""}` : "not started"],
    ["Review", reviewSummary(state?.review, git)],
    ["Next", label.next],
    ["Budget", budgetCell],
    ["Session model", `${summary.session}${ctx.config.session.pin ? " (pinned)" : ""}`],
    ...(state?.classification ? [["Rating", ratingLine(state.classification)] as [string, string]] : []),
  ];
  const routing = (await routingCheckRows(ctx)).map((row) => [cell(row.jobs), cell(row.tier), cell(row.runs, 160), cell(row.skipped.join("; ") || "-", 400)]);
  const logins = loginRows(auth);
  const missingPricing = unpricedModels(records, ctx.config.pricing);
  const warnings = [
    ...(ctx.config.warnings ?? []).map((warning) => `Config: ${warning}`),
    ...(corrupt > 0 ? [`${corrupt} corrupt line(s) in the task event log. state.json is the source of truth; inspect events.jsonl.`] : []),
    ...(missingPricing.length > 0 ? [`No pricing row for ${missingPricing.join(", ")}; their spend is unknown. Add a row to pricing.`] : []),
    ...(state?.blockedReason && !["BLOCKED", "PAUSED", "FAILED"].includes(state.phase) ? [`Note: ${state.blockedReason}`] : []),
  ];
  const tickets = state ? ticketTable(ctx, state) : [];
  const others = unfinishedTasks(listTasks(ctx)).filter((task) => task.taskId !== state?.taskId).length;
  const markdown = [
    `## Status · ${label.line}`,
    "",
    "| | |",
    "| --- | --- |",
    ...pairs.map(([key, value]) => `| ${key} | ${cell(value, 400)} |`),
    ...(others > 0 ? ["", `Also open: ${others} task(s) — /plans`] : []),
    ...(tickets.length > 0 ? ["", ...tickets] : []),
    "",
    "### Routing",
    "",
    ...mdTable(["Job", "Tier", "Runs", "Skipped"], routing),
    "",
    "### Logins",
    "",
    ...mdTable(["Provider", "Status", "Detail"], logins),
    ...(warnings.length > 0 ? ["", "### Warnings", "", ...warnings.map((warning) => `- ${warning}`)] : []),
  ].join("\n");
  return { markdown, stateLine: label.line };
}

/** `/status <ticket>`: one ticket's trail. Every attempt (tier, model, time, cost, outcome) and every review, with its verdict and reasoning. */
function ticketMarkdown(state: TaskState, ref: string): { markdown: string; line: string } | undefined {
  const ticket = (state.plan?.tickets ?? []).find((item) => item.id === ref || item.id === ref.padStart(2, "0"));
  if (!ticket) return undefined;
  const run = state.ticketRuns?.[ticket.id];
  const result = resultLabel(run, true);
  const pairs: [string, string][] = [
    ["Difficulty", ticketDifficulty(ticket)],
    ["Now on", run?.tier ? `${run.tier}${run.provider && run.model ? ` · ${run.provider}/${run.model}` : ""}` : "not started"],
    ["Time", run?.elapsedMs !== undefined ? formatDuration(run.elapsedMs) : "-"],
    ["Cost", costLabel(run)],
    ...(run?.commit ? [["Commit", run.commit] as [string, string]] : []),
    ...(run?.unverified ? [["Unverified", run.unverified] as [string, string]] : []),
    ...(run?.status === "failed" && run.error ? [["Last failure", run.error] as [string, string]] : []),
  ];
  const attempts = (run?.attemptLog ?? []).map((item) => [
    String(item.attempt),
    item.tier,
    cell(item.provider ? `${item.provider}/${item.model}` : item.model),
    formatDuration(item.elapsedMs),
    formatUsd(item.costUsd),
    cell(item.outcome === "success" ? "success" : `failed${item.failedBy ? ` (${item.failedBy})` : ""}${item.error ? `: ${item.error}` : ""}`, 160),
  ]);
  const reviews = (run?.reviews ?? []).map((item) => [
    `${item.attempt}.${item.round}`,
    cell(item.reviewer ?? "-"),
    item.verdict,
    cell(item.findings.map((finding) => `${finding.severity}: ${finding.file ? `${finding.file}: ` : ""}${finding.issue}`).join("; ") || "-", 400),
    cell(item.rationale, 300),
  ]);
  const markdown = [
    `## Ticket ${ticket.id} · ${cell(ticket.title, 80)} · ${cell(result, 80)}`,
    "",
    "| | |",
    "| --- | --- |",
    ...pairs.map(([key, value]) => `| ${key} | ${cell(value, 400)} |`),
    "",
    "### Attempts",
    "",
    ...(attempts.length ? mdTable(["#", "Tier", "Model", "Time", "Cost", "Outcome"], attempts) : ["None yet."]),
    "",
    "### Reviews",
    "",
    ...(reviews.length ? mdTable(["Attempt.round", "Reviewer", "Verdict", "Findings", "Reasoning"], reviews) : ["None yet."]),
  ].join("\n");
  return { markdown, line: flat(`Ticket ${ticket.id} · ${result}`, 160) };
}

async function statusReport(ctx: WorkflowContext, arg: string): Promise<CommandResult> {
  const state = await activeTask(ctx);
  if (arg !== "" && arg !== "foundry") {
    const found = state ? ticketMarkdown(state, arg) : undefined;
    if (!found) return fail("USAGE", `Use /status, /status foundry, or /status <ticket id>${state?.plan?.tickets?.length ? ` (${state.plan.tickets.map((item) => item.id).join(", ")})` : ""}.`);
    ctx.report?.(found.markdown);
    return done(ctx.report ? found.line : found.markdown, { state });
  }
  const auth = await Promise.all(PROVIDERS.map((provider) => ctx.authProbe.inspect(provider)));
  const { markdown: base, stateLine } = await statusMarkdown(ctx, state, auth);
  const markdown = arg === "foundry" ? [base, "", ...(await foundrySection(ctx))].join("\n") : base;
  // The chat block holds the tables (no clipping); the command result stays one line. Without a UI the result is the markdown.
  ctx.report?.(markdown);
  const budget = budgetState(ctx, state?.taskId).status;
  return done(ctx.report ? stateLine : markdown, { state, auth, budget, corruptEventLines: state ? ctx.store.corruptEventLines(state.taskId) : 0, stateLine });
}

/** The Logins table rows, shared by /status and /auth. */
function loginRows(auth: ProviderAuthView[]): string[][] {
  return auth.map((view) => [cell(view.provider), view.method === "api-key" && view.status === "ready" ? "api-key" : view.status, cell(`${view.method}${view.detail ? ` · ${view.detail}` : ""}`, 160)]);
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
  if (command && command !== "status") return fail("USAGE", "Use /auth, /auth status, or /auth login <provider>.");
  const views = await Promise.all(PROVIDERS.map((item) => ctx.authProbe.inspect(item)));
  const markdown = ["## Logins", "", ...mdTable(["Provider", "Status", "Detail"], loginRows(views))].join("\n");
  ctx.report?.(markdown);
  const ready = views.filter((view) => view.status === "ready").map((view) => view.provider);
  return done(ctx.report ? `Signed in: ${ready.join(", ") || "none"}.` : markdown, views);
}
