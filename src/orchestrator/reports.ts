import path from "node:path";
import { type CommandResult, type CostRecord } from "../domain.js";
import { summarize, toCsv, unpricedModels } from "../cost/ledger.js";
import { atomicWrite } from "../storage/store.js";
import { budgetState, statusFor } from "./budget.js";
import { done, fail, guard, type WorkflowContext } from "./context.js";
import { activeTask, displayName, listTasks } from "./tasks.js";
import { cell, formatUsd, formatUsdShort, mdTable } from "./format.js";

export function cost(ctx: WorkflowContext, format = ""): Promise<CommandResult> {
  return guard(() => costReport(ctx, format.trim()));
}

/**
 * The job a ledger row paid for: its reason without the ticket tag (` · ticket 01`, or ` ticket 01` as the ticket
 * review writes it) and the detail in parentheses. The main session's turns split into the turns of a
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
    .map(({ name, calls, spend }) => {
      // A group of nothing but subscription agents' rows has no dollar figure: it shows a count.
      const onlyUnmetered = spend.notMeteredRecords > 0 && spend.notMeteredRecords === groups.get(name)!.length;
      return [
        cell(name),
        String(calls),
        onlyUnmetered ? "-" : formatUsd(spend.knownUsd),
        spend.unknownRecords > 0 ? String(spend.unknownRecords) : "-",
        spend.notMeteredRecords > 0 ? String(spend.notMeteredRecords) : "-",
        onlyUnmetered ? "not metered" : spend.unknownRecords > 0 ? `≈ ${formatUsd(spend.knownUsd + spend.estimatedUnknownUsd)}` : formatUsd(spend.knownUsd),
        ...(extra?.(name) ?? []),
      ];
    });
}

async function costReport(ctx: WorkflowContext, format: string): Promise<CommandResult> {
  const records = ctx.store.readLedger();
  const task = await activeTask(ctx);
  const summary = summarize(records, { pricing: ctx.config.pricing, unknownCallUsd: ctx.config.budgets.unknownCallUsd });
  const budget = budgetState(ctx, task?.taskId, records);
  // The exports are files: a chat line is clipped, and a ledger is long.
  if (format === "csv" || format === "json") {
    const file = path.join(ctx.store.root, "reports", `cost-${ctx.now().toISOString().replace(/[-:.]/g, "").slice(0, 15)}.${format}`);
    atomicWrite(file, format === "csv" ? toCsv(records) : JSON.stringify({ summary, records }, null, 2));
    return done(`Wrote ${records.length} ledger record(s) to ${file}.`, { file, summary });
  }
  if (format !== "") return fail("USAGE", "Use /cost, /cost csv, or /cost json.");
  const unpriced = unpricedModels(records, ctx.config.pricing);
  const names = new Map(listTasks(ctx).map((item) => [item.taskId, displayName(item)]));
  const line = `Known spend ${formatUsd(summary.knownUsd)} across ${records.length} record(s)${summary.unknownRecords > 0 ? ` · ${summary.unknownRecords} with unknown cost, estimated at ${formatUsd(summary.estimatedUnknownUsd)} · total ≈ ${formatUsd(summary.knownUsd + summary.estimatedUnknownUsd)}` : ""}${summary.notMeteredRecords > 0 ? ` · ${summary.notMeteredRecords} not metered (agent subscriptions)` : ""}`;
  const markdown = [
    `## Cost · ${line}`,
    "",
    `Budget: task ${formatUsdShort(budget.task.knownUsd)} / $${ctx.config.budgets.taskUsd} (${statusFor(ctx, budget.task, ctx.config.budgets.taskUsd)}) · daily ${formatUsdShort(budget.daily.knownUsd)} / $${ctx.config.budgets.dailyUsd} (${statusFor(ctx, budget.daily, ctx.config.budgets.dailyUsd)})`,
    ...(unpriced.length ? ["", `No pricing row for ${unpriced.join(", ")}: their spend is unknown. Add a row to pricing.`] : []),
    "",
    "### By model",
    "",
    ...mdTable(["Model", "Calls", "Known", "Unknown rows", "Not metered", "Total"], spendRows(ctx, records, (entry) => `${entry.provider}/${entry.model}`)),
    "",
    "### By job",
    "",
    ...mdTable(["Job", "Calls", "Known", "Unknown rows", "Not metered", "Total"], spendRows(ctx, records, jobOf)),
    "",
    "### By task",
    "",
    ...mdTable(["Task", "Calls", "Known", "Unknown rows", "Not metered", "Total"], spendRows(ctx, records, (entry) => names.get(entry.taskId) ?? entry.taskId)),
  ].join("\n");
  ctx.report?.(markdown);
  return done(ctx.report ? line : markdown, summary);
}
