/**
 * Reads the Pi session files a herdr ticket child writes (`--session-dir <ws>/tasks/<task>/sessions/<ticket>-<attempt>`)
 * and ledgers their spend. The child is a separate process, so the parent learns what it cost only from these files.
 *
 * The entry shapes are Pi 1.2.0's `SessionManager` (see docs/COMPATIBILITY.md, "Session files"): a JSONL file whose
 * first line is the header (`type: "session"`, `id`), then one entry per line (`id`, `parentId`, `timestamp`, `type`).
 * A `message` entry holds an `AssistantMessage` (`content` parts, `usage`, `stopReason`, `provider`, `model`); `usage`,
 * `compaction` and `branch_summary` entries are Pi's own calls. Pi appends to the file while it works, so the last line
 * can be half written; it is skipped, and read in full on the next pass.
 *
 * Dedupe: every ledgered entry takes the ledger id `pi-<sessionId>-<entryId>` (the key `recordPiUsage` uses, in the same
 * `ctx.piLedgered` set, loaded from the ledger), so a re-read, or a new process, never counts an entry twice.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CostRecord } from "../domain.js";
import { observeUsage, recordPiUsage, refreshPiLedgered } from "../orchestrator/budget.js";
import { active, type WorkflowContext } from "../orchestrator/context.js";
import { usageOfMessage } from "../usage-message.js";

export interface ChildSessionFile {
  /** The session id from the header (the file name's id when the header is missing). */
  sessionId: string;
  file: string;
  /** Every entry after the header, in file order. */
  entries: Record<string, unknown>[];
}

/** Parses every `*.jsonl` file of a child's session dir, oldest first. A missing dir is no files. Never throws. */
export function readChildSession(dir: string): ChildSessionFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const out: ChildSessionFile[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let sessionId = name.replace(/\.jsonl$/, "").replace(/^.*_/, "");
    const entries: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a partly written last line
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const entry = parsed as Record<string, unknown>;
      if (entry.type === "session") {
        if (typeof entry.id === "string" && entry.id) sessionId = entry.id;
        continue;
      }
      entries.push(entry);
    }
    out.push({ sessionId, file, entries });
  }
  return out;
}

function timeOf(entry: Record<string, unknown>, fallback: Date): Date {
  return typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp)) ? new Date(entry.timestamp) : fallback;
}

/**
 * Ledgers what the child spent that is not in the ledger yet: each assistant message (through `usageOfMessage`, so a
 * failed zero-token attempt bills nothing and an unknown cost stays null) and Pi's own entries (`recordPiUsage`).
 * Rows carry ` · ticket <ticketId>`. Returns the rows added.
 * Pi's compaction and branch-summary entries name no model: they take `options.model` (what the runner launched), else
 * the nearest preceding assistant message's provider and model in the same file, else stay unknown.
 */
export function ledgerChildSession(ctx: WorkflowContext, files: readonly ChildSessionFile[], options: { ticketId?: string; model?: { provider: string; id: string }; /** Ledger the model calls under this job and tier (a review fix in a tab) instead of the session's. */ job?: string; tier?: string }): CostRecord[] {
  const seen = (ctx.piLedgered ??= new Set(ctx.store.readLedger().map((row) => row.id).filter((id) => id.startsWith("pi-"))));
  const out: CostRecord[] = [];
  let refreshed = false;
  for (const file of files) {
    for (const entry of file.entries) {
      if (entry.type !== "message" || typeof entry.id !== "string") continue;
      const message = entry.message as { role?: unknown; provider?: unknown; model?: unknown } | undefined;
      if (!message || typeof message !== "object" || message.role !== "assistant") continue;
      const id = `pi-${file.sessionId}-${entry.id}`;
      const at = timeOf(entry, ctx.now());
      if (seen.has(id)) continue;
      if (!refreshed) {
        refreshed = true;
        refreshPiLedgered(ctx);
        if (seen.has(id)) continue;
      }
      const call = usageOfMessage(message as Parameters<typeof usageOfMessage>[0]);
      if (!call) continue;
      seen.add(id);
      const row = observeUsage(ctx, call, { id, at, ...(options.ticketId ? { ticketId: options.ticketId } : {}), ...(options.job ? { job: options.job } : {}), ...(options.tier ? { tier: options.tier } : {}) });
      if (row) out.push(row);
    }
    // Pi's own entries, one at a time, each on the model that was running when it was written.
    let preceding: { provider: string; id: string } | undefined;
    for (const entry of file.entries) {
      const message = entry.type === "message" ? (entry.message as { role?: unknown; provider?: unknown; model?: unknown } | undefined) : undefined;
      if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string" && message.provider && message.model) preceding = { provider: message.provider, id: message.model };
      if (entry.type === "message") continue;
      const model = options.model ?? preceding;
      out.push(...recordPiUsage(ctx, { sessionId: file.sessionId, entries: [entry], ...(model ? { model } : {}), ...(options.ticketId ? { ticketId: options.ticketId } : {}) }));
    }
  }
  return out;
}

/**
 * The full text (all text parts) of the last assistant message of the newest session file, or undefined when that file
 * has no assistant message or the last one has no text (after a `/new` with no reply, the previous session's answer is
 * not this one's).
 */
export function lastAssistantText(files: readonly ChildSessionFile[]): string | undefined {
  const entries = files[files.length - 1]?.entries ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const message = entry.type === "message" ? (entry.message as { role?: unknown; content?: unknown } | undefined) : undefined;
    if (!message || message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("") : "";
    return text.trim() ? text : undefined;
  }
  return undefined;
}

/**
 * The resume sweep: ledgers every session dir of a ticket (`<ticket>-<attempt>`) under the active task's `sessions/`,
 * so a crash between a child's turn and the parent's read loses nothing. Never throws.
 */
export function sweepTicketSessions(ctx: WorkflowContext, ticketId: string, options: { model?: { provider: string; id: string } } = {}): CostRecord[] {
  try {
    const state = active(ctx);
    if (!state) return [];
    const root = path.join(ctx.store.taskDir(state.taskId), "sessions");
    if (!existsSync(root)) return [];
    const mine = new RegExp(`^${ticketId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`);
    const out: CostRecord[] = [];
    for (const name of readdirSync(root).sort()) {
      if (!mine.test(name)) continue;
      // One bad dir must not hide the rows already added.
      try {
        const dir = path.join(root, name);
        if (!statSync(dir).isDirectory()) continue;
        out.push(...ledgerChildSession(ctx, readChildSession(dir), { ticketId, ...(options.model ? { model: options.model } : {}) }));
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}
