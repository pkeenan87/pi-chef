/**
 * Metering for external agents: what an agent spent on a ticket (or a review), read from the agent's own session log
 * instead of a provider response. The meter snapshots the log directory before the agent's tab opens (file -> size and
 * mtime); `collect()` reads only the files that are new or have grown since, and returns what is new since the last
 * `collect()`, so a retry `send` ledgers just its own turn. Nothing here runs a process or touches the ledger.
 *
 * - Claude Code: `~/.claude/projects/<cwd slug>/**.jsonl` (the slug is the repo path with every character outside
 *   A-Z a-z 0-9 replaced by "-", which is how `.` in `/home/me/.codex` becomes `--codex`; sub-agent logs sit in
 *   `<session>/subagents/`). Lines of `type: "assistant"` carry `message.id`, `message.model` and `message.usage`; one
 *   message repeats on a line per content block, so each `message.id` counts once (the largest value seen per field,
 *   since a streamed message may be written more than once).
 * - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The first line is `session_meta` with `payload.cwd` (a
 *   session of another directory is skipped). `event_msg` lines with `payload.type: "token_count"` hold the session's
 *   running `total_token_usage`; the spend is the last total minus the last total at the snapshot. `input_tokens`
 *   includes `cached_input_tokens`, and `output_tokens` already includes the reasoning tokens.
 * - Every other agent has no reader (`createAgentMeter` returns undefined): the caller ledgers one "not metered" row.
 *
 * Both formats were read off files on this machine (2026-11-08); they are the agents' internal logs, not a documented API.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TokenUsage } from "../domain.js";

/** Usage of one model since the last `collect()`. `provider` is the pricing provider (`anthropic`, `openai`). */
export interface AgentCall {
  provider: string;
  model: string;
  usage: TokenUsage;
}

/** What the ledger records for an agent: metered calls, or the single "not metered" row of an agent with no reader. */
export interface AgentLedgerEntry {
  agent: string;
  meter: "agent-log" | "not-metered";
  provider: string;
  model: string;
  usage: TokenUsage;
}

export interface AgentMeter {
  /** Usage that appeared in the agent's log since the snapshot or the previous `collect()`. Never throws. */
  collect(): AgentCall[];
}

export interface AgentMeterOptions {
  /** The repo the agent runs in (its log is found by this path). */
  cwd: string;
  /** Replaces the home directory the logs are looked for under (tests). */
  home?: string;
  /** Called with a log file and the byte offset `collect()` has read it to (the per-task watermark follows it). */
  onConsumed?: (file: string, offset: number) => void;
}

/** The agents that have a reader, with the provider their usage is priced under. */
const READERS: Record<string, "claude" | "codex"> = { claude: "claude", codex: "codex" };
const PRICING_PROVIDER = { claude: "anthropic", codex: "openai" } as const;

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

interface Found {
  provider: string;
  model: string;
  totals: Totals;
}

type Snapshot = Map<string, number>;

const ZERO: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Claude Code's project directory name for a working directory. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The path and its real path (symlinks resolved), without repeats. */
function pathForms(cwd: string): string[] {
  const forms = new Set([path.resolve(cwd)]);
  try {
    forms.add(realpathSync(cwd));
  } catch {
    /* a path that does not exist has only its own form */
  }
  return [...forms];
}

/** Every `.jsonl` file under `dir` (at most `depth` levels down) with its size. A missing dir is no files. */
function jsonlFiles(dir: string, accept: (name: string) => boolean, depth: number, out: Snapshot = new Map()): Snapshot {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) jsonlFiles(full, accept, depth - 1, out);
    } else if (entry.isFile() && accept(entry.name)) {
      try {
        out.set(full, statSync(full).size);
      } catch {
        /* gone since the listing */
      }
    }
  }
  return out;
}

/** Lines of a JSONL file with the byte offset each starts at. A half-written last line fails to parse and is skipped by the caller. */
function* lines(buffer: Buffer): Generator<{ start: number; value: unknown }> {
  let start = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(10, start);
    if (end < 0) end = buffer.length;
    const text = buffer.toString("utf8", start, end).trim();
    if (text) {
      try {
        yield { start, value: JSON.parse(text) };
      } catch {
        /* a half-written line, or not JSON */
      }
    }
    start = end + 1;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Whether a line is already accounted for: it takes the line's start offset and its parsed value. */
type Before = (start: number, value: Record<string, unknown>) => boolean;

/** Claude Code messages in a file whose lines are not `before`, by message id (the largest value per field). */
function claudeMessages(buffer: Buffer, before: Before): Map<string, Found> {
  const earlier = new Set<string>();
  const found = new Map<string, Found>();
  for (const { start, value } of lines(buffer)) {
    if (!isRecord(value) || value.type !== "assistant" || !isRecord(value.message)) continue;
    const message = value.message;
    const id = typeof message.id === "string" ? message.id : undefined;
    if (!id) continue;
    if (before(start, value)) {
      earlier.add(id);
      continue;
    }
    if (earlier.has(id)) continue;
    const usage = isRecord(message.usage) ? message.usage : {};
    const totals: Totals = { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens), requests: 1 };
    const model = typeof message.model === "string" && message.model ? message.model : "unknown";
    const seen = found.get(id);
    if (!seen) found.set(id, { provider: PRICING_PROVIDER.claude, model, totals });
    else
      found.set(id, {
        provider: seen.provider,
        model: seen.model === "unknown" ? model : seen.model,
        totals: { input: Math.max(seen.totals.input, totals.input), output: Math.max(seen.totals.output, totals.output), cacheRead: Math.max(seen.totals.cacheRead, totals.cacheRead), cacheWrite: Math.max(seen.totals.cacheWrite, totals.cacheWrite), requests: 1 },
      });
  }
  return found;
}

/** A Codex rollout's spend after the lines that are `before`: the last running total minus the one at the boundary. Undefined for another directory's session. */
function codexSession(buffer: Buffer, before: Before, repos: string[]): Found | undefined {
  let cwd: string | undefined;
  let model: string | undefined;
  let base: Totals = ZERO;
  let last: Totals = ZERO;
  let requests = 0;
  for (const { start, value } of lines(buffer)) {
    if (!isRecord(value)) continue;
    const payload = isRecord(value.payload) ? value.payload : {};
    if (value.type === "session_meta" && cwd === undefined && typeof payload.cwd === "string") cwd = payload.cwd;
    else if (value.type === "turn_context" && typeof payload.model === "string" && payload.model) model = payload.model;
    else if (value.type === "event_msg" && payload.type === "token_count" && isRecord(payload.info) && isRecord(payload.info.total_token_usage)) {
      const total = payload.info.total_token_usage;
      const cached = num(total.cached_input_tokens);
      const now: Totals = { input: Math.max(0, num(total.input_tokens) - cached), output: num(total.output_tokens), cacheRead: cached, cacheWrite: 0, requests: 0 };
      if (before(start, value)) base = now;
      else if (now.input !== last.input || now.output !== last.output || now.cacheRead !== last.cacheRead) requests += 1;
      last = now;
    }
  }
  if (cwd === undefined || !repos.some((repo) => samePath(repo, cwd!))) return undefined;
  const totals: Totals = { input: Math.max(0, last.input - base.input), output: Math.max(0, last.output - base.output), cacheRead: Math.max(0, last.cacheRead - base.cacheRead), cacheWrite: 0, requests };
  return { provider: PRICING_PROVIDER.codex, model: model ?? "unknown", totals };
}

function samePath(a: string, b: string): boolean {
  const strip = (p: string) => path.resolve(p);
  return strip(a) === strip(b);
}

/** The agent's log files for the repo (its path forms `repos`) with their sizes; a missing directory is no files. */
export function listAgentLogs(reader: "claude" | "codex", home: string, repos: string[]): Snapshot {
  if (reader === "claude") {
    const out: Snapshot = new Map();
    for (const repo of repos) jsonlFiles(path.join(home, ".claude", "projects", claudeProjectSlug(repo)), (name) => name.endsWith(".jsonl"), 3, out);
    return out;
  }
  return jsonlFiles(path.join(home, ".codex", "sessions"), (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"), 5);
}

export { pathForms as repoPathForms };

/**
 * What a log file holds past a watermark. Lines that start before `offset`, or are stamped before `since`, are already
 * accounted for: a Claude message id seen in them is not counted again, and a Codex total in them is the base of the
 * delta. Only whole lines are read; `end` is where the next read starts.
 */
export function readAgentLog(reader: "claude" | "codex", file: string, from: { offset: number; since?: string; repos: string[] }): { calls: AgentCall[]; end: number } | undefined {
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return undefined;
  }
  const end = buffer.length > 0 && buffer[buffer.length - 1] !== 10 ? buffer.lastIndexOf(10) + 1 : buffer.length;
  buffer = buffer.subarray(0, end);
  const since = from.since ? Date.parse(from.since) : NaN;
  const before: Before = (start, value) => {
    if (start < from.offset) return true;
    const at = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
    return Number.isFinite(since) && Number.isFinite(at) && at < since;
  };
  const found: Found[] = [];
  if (reader === "claude") found.push(...claudeMessages(buffer, before).values());
  else {
    const session = codexSession(buffer, before, from.repos);
    if (session) found.push(session);
  }
  const merged = new Map<string, AgentCall>();
  for (const item of found) {
    const { input, output, cacheRead, cacheWrite, requests } = item.totals;
    if (input + output + cacheRead + cacheWrite === 0) continue;
    const name = `${item.provider}/${item.model}`;
    const sum = merged.get(name);
    merged.set(name, {
      provider: item.provider,
      model: item.model,
      usage: sum
        ? { input: sum.usage.input! + input, output: sum.usage.output! + output, cacheRead: sum.usage.cacheRead! + cacheRead, cacheWrite: sum.usage.cacheWrite! + cacheWrite, requests: sum.usage.requests + requests }
        : { input, output, cacheRead, cacheWrite, requests },
    });
  }
  return { calls: [...merged.values()].map((call) => ({ ...call, usage: { ...call.usage, requests: Math.max(1, call.usage.requests) } })), end };
}

/**
 * A meter for `agent` in `options.cwd`, snapshotted now (call it before the agent's tab opens). Undefined when the agent
 * has no reader: its usage cannot be metered.
 */
export function createAgentMeter(agent: string, options: AgentMeterOptions): AgentMeter | undefined {
  const reader = READERS[agent];
  if (!reader) return undefined;
  const home = options.home ?? homedir();
  const repos = pathForms(options.cwd);
  const list = (): Snapshot => listAgentLogs(reader, home, repos);
  const snapshot = list();
  /** Spend per message id (Claude) or per rollout file (Codex) already handed out. */
  const reported = new Map<string, Totals>();
  return {
    collect() {
      try {
        const current = new Map<string, Found>();
        for (const [file, size] of list()) {
          const was = snapshot.get(file);
          // Only files that are new or have grown since the snapshot are read.
          if (was !== undefined && size <= was) continue;
          let buffer: Buffer;
          try {
            buffer = readFileSync(file);
          } catch {
            continue;
          }
          const from = was ?? 0;
          options.onConsumed?.(file, buffer.length);
          if (reader === "claude") for (const [id, found] of claudeMessages(buffer, (start) => start < from)) current.set(`${id}`, found);
          else {
            const found = codexSession(buffer, (start) => start < from, repos);
            if (found) current.set(file, found);
          }
        }
        const merged = new Map<string, AgentCall>();
        for (const [key, found] of current) {
          const before = reported.get(key) ?? ZERO;
          const delta: Totals = {
            input: Math.max(0, found.totals.input - before.input),
            output: Math.max(0, found.totals.output - before.output),
            cacheRead: Math.max(0, found.totals.cacheRead - before.cacheRead),
            cacheWrite: Math.max(0, found.totals.cacheWrite - before.cacheWrite),
            requests: Math.max(0, found.totals.requests - before.requests),
          };
          reported.set(key, found.totals);
          if (delta.input + delta.output + delta.cacheRead + delta.cacheWrite === 0) continue;
          const name = `${found.provider}/${found.model}`;
          const sum = merged.get(name);
          const usage: TokenUsage = sum
            ? { input: sum.usage.input! + delta.input, output: sum.usage.output! + delta.output, cacheRead: sum.usage.cacheRead! + delta.cacheRead, cacheWrite: sum.usage.cacheWrite! + delta.cacheWrite, requests: sum.usage.requests + delta.requests }
            : { input: delta.input, output: delta.output, cacheRead: delta.cacheRead, cacheWrite: delta.cacheWrite, requests: delta.requests };
          merged.set(name, { provider: found.provider, model: found.model, usage });
        }
        return [...merged.values()].map((call) => ({ ...call, usage: { ...call.usage, requests: Math.max(1, call.usage.requests) } }));
      } catch {
        return []; // an unreadable log is no news; the next collect looks again
      }
    },
  };
}

/** The one "not metered" ledger entry of an agent attempt (a subscription agent with no reader, or one whose log was not found). */
export function notMeteredEntry(agent: string): AgentLedgerEntry {
  return { agent, meter: "not-metered", provider: "agent", model: agent, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 } };
}

/** Ledger entries for metered calls. */
export function meteredEntries(agent: string, calls: readonly AgentCall[]): AgentLedgerEntry[] {
  return calls.map((call) => ({ agent, meter: "agent-log", provider: call.provider, model: call.model, usage: call.usage }));
}
