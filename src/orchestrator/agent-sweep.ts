/**
 * The outside-chef sweep: Claude Code and Codex use in this repo that pi-chef did not start (the user's own session, or
 * one the chat ran with `hc run`), ledgered so /cost and the budgets include it. It reads each agent log file from the
 * task's watermark (`agent-logs.json`, see `AgentWatermark`) to its end and moves the watermark on. The ticket and review
 * meters advance the same watermark for what they ledger, so nothing is counted twice. The first sweep of a task only
 * records where every log stands (and `since`): spend before that is not counted. A running build owns the logs, so it is
 * never swept over. Never throws: a missing or unreadable log is no usage.
 */
import { homedir } from "node:os";
import type { AgentLedgerEntry } from "../runner/agent-usage.js";
import { listAgentLogs, meteredEntries, readAgentLog, repoPathForms } from "../runner/agent-usage.js";
import type { AgentWatermark } from "../storage/store.js";
import { recordAgentUsage } from "./budget.js";
import type { WorkflowContext } from "./context.js";
import { formatUsd } from "./format.js";

const AGENTS = [
  { reader: "claude", name: "Claude Code" },
  { reader: "codex", name: "Codex" },
] as const;

/** Records where every agent log stands now, with `since` = now. Nothing is ledgered. */
function initialMark(ctx: WorkflowContext, home: string): AgentWatermark {
  const files: AgentWatermark["files"] = {};
  const repos = repoPathForms(ctx.git.repoRoot);
  for (const { reader } of AGENTS) for (const [file, size] of listAgentLogs(reader, home, repos)) files[file] = { offset: size };
  return { since: ctx.now().toISOString(), files };
}

/** Starts the task's watermark when it has none (a new task, or the first sweep of one that predates it). */
export function initAgentWatermark(ctx: WorkflowContext, taskId: string, home: string = homedir()): AgentWatermark | undefined {
  try {
    const existing = ctx.store.readAgentWatermark(taskId);
    if (existing) return existing;
    const mark = initialMark(ctx, home);
    ctx.store.writeAgentWatermark(taskId, mark);
    return mark;
  } catch {
    return undefined;
  }
}

/**
 * Ledgers what the agents spent in this repo since the task's watermark, under the reason "outside chef", and posts one
 * progress line when it did. Returns the line, or undefined when nothing was counted.
 */
export function sweepAgentLogs(ctx: WorkflowContext, taskId: string, home: string = homedir()): string | undefined {
  try {
    const first = !ctx.store.readAgentWatermark(taskId);
    const mark = initAgentWatermark(ctx, taskId, home);
    if (!mark || first) return undefined;
    // A running build's meters own the logs; whatever was left unread is swept after it ends.
    if (ctx.store.liveBuildClaim(taskId)) return undefined;
    const phase = ctx.store.load(taskId)?.phase;
    const repos = repoPathForms(ctx.git.repoRoot);
    const notes: string[] = [];
    for (const { reader, name } of AGENTS) {
      const entries: AgentLedgerEntry[] = [];
      for (const [file, size] of listAgentLogs(reader, home, repos)) {
        const known = mark.files[file];
        if (known && size <= known.offset) continue;
        const read = readAgentLog(reader, file, { offset: known?.offset ?? 0, since: mark.since, repos });
        if (!read) continue;
        entries.push(...meteredEntries(reader, read.calls));
        mark.files[file] = { offset: read.end };
      }
      if (entries.length === 0) continue;
      const records = recordAgentUsage(ctx, { reason: "outside chef", entries, taskId, ...(phase ? { phase } : {}), tier: "agent" });
      const known = records.filter((record) => record.actualUsd !== null);
      const usd = known.reduce((sum, record) => sum + (record.actualUsd ?? 0), 0);
      notes.push(known.length === records.length && usd > 0 ? `${formatUsd(usd)} of ${name} use` : `${records.length} ${name} call(s) of unknown cost`);
    }
    ctx.store.writeAgentWatermark(taskId, mark);
    if (notes.length === 0) return undefined;
    const line = `Counted ${notes.join(" and ")} in this repo that pi-chef did not start (outside chef); it counts toward the budgets.`;
    ctx.progress?.(line);
    return line;
  } catch {
    return undefined;
  }
}
