import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ticket } from "../domain.js";
import { redact } from "../redact.js";

/** Set to "1" in a child `pi` process. `src/extension.ts` then registers only providers and web tools. */
export const CHILD_ENV = "PI_COST_ROUTER_CHILD";
export const CHILD_TASK_ENV = "PI_COST_ROUTER_TASK";
export const CHILD_TICKET_ENV = "PI_COST_ROUTER_TICKET";
/** Project root of the parent session: the child reads config, budgets, and the ledger from here, not from its worktree. */
export const CHILD_ROOT_ENV = "PI_COST_ROUTER_ROOT";

/**
 * Flags were verified against the installed pi 1.2.0 `--help`: `--mode json`, `-p`, `--no-session`, `--model provider/id`,
 * `--tools`, `--thinking`, `-ne/--no-extensions` with an explicit `-e`, `--append-system-prompt <text|file>`, and `@file` prompts.
 * Child mode was verified to load and register `local/qwen2.5-coder:7b` via `pi -ne -e ./src/extension.ts --list-models`.
 * The JSON event names are not verified live.
 */

/** Tools a ticket child may use. `bash` in the child gets only a deny hook (child-mode.ts), not our command allowlist. */
export const TICKET_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch"];

/**
 * What a ticket child inherits: an allowlist, not "everything minus a few keys", so a token the parent happens to hold
 * (GITHUB_TOKEN, AWS_*, VERCEL_OIDC_TOKEN, ...) never reaches model-driven shell commands. Pi finds its login in
 * `$HOME/.pi/agent` or `PI_CODING_AGENT_DIR`, both covered below. `AZURE_AI_ENDPOINT` is the Foundry endpoint (not a secret).
 */
const ENV_ALLOW_EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "TMPDIR", "TZ", "NODE_OPTIONS", "NODE_PATH", "AZURE_AI_ENDPOINT",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "npm_config_cache", "npm_config_registry",
  // Windows equivalents of HOME, TMPDIR, and PATH lookup.
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SystemRoot", "PATHEXT", "COMSPEC",
]);
const ENV_ALLOW_PREFIX = ["LC_", "XDG_", "PI_"];
/** Never passed, even when an allowed prefix matches (`PI_SOMETHING_TOKEN`) or the name is allowed explicitly. */
const ENV_DENY_ALWAYS = /^(GITHUB_|GH_|AWS_|VERCEL_|ANTHROPIC_|OPENAI_|XAI_|GOOGLE_|GCP_|AZURE_(?!AI_ENDPOINT$)|NPM_TOKEN|NODE_AUTH_TOKEN|SSH_|GIT_)/i;
const ENV_DENY_SECRET = /(_TOKEN|_KEY|_SECRET|_PASSWORD|_CREDENTIALS?|^TOKEN|^PASSWORD)$/i;
const STDERR_TAIL_CHARS = 4000;
const DEFAULT_KILL_GRACE_MS = 5000;

/** The part of a ChildProcess the runner uses, so tests can supply a scripted fake. */
export interface ChildLike {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
  pid?: number;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean }) => ChildLike;

/** Tokens and Pi's own cost for one model call, as reported in a JSON event. */
export interface RunnerSpend {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Pi's cost.total for this call, or null when the event carried none. */
  costUsd: number | null;
}

export type RunnerEvent =
  | { kind: "turn"; turn: number; contextTokens: number; spend: RunnerSpend }
  | { kind: "tool"; name: string }
  | { kind: "compaction"; count: number; spend?: RunnerSpend }
  | { kind: "crossed-target"; contextTokens: number; target: number };

export interface TicketRunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of Pi's own cost.total; null when no event carried one. */
  costUsd: number | null;
  turns: number;
}

export interface TicketRunInput {
  ticket: Pick<Ticket, "id" | "slug" | "title">;
  /** Full ticket prompt. Passed to the child as an `@file` argument so its size is not limited by argv. */
  prompt: string;
  worktreePath: string;
  model: { provider: string; id: string };
  thinking?: string;
  tools: string[];
  systemPromptAppend: string;
  /** Extra variables for the child (task and ticket ids, git config). Merged over the filtered parent environment. */
  env?: Record<string, string>;
  /** Further parent variables to pass by exact name, for example the local provider's apiKeyEnv. */
  allowEnv?: string[];
  signal?: AbortSignal;
  /** Kill the child after this long. */
  deadlineMs?: number;
  /** Soft context target in tokens: crossing it is recorded, never enforced. */
  contextTarget?: number;
  onEvent?: (event: RunnerEvent) => void;
  spawn?: SpawnFn;
  /** Overrides how the pi binary is found (tests). */
  invocation?: { command: string; args: string[] };
  /** Overrides the extension entry passed with `-e`. */
  extensionPath?: string;
  /** Parent environment to filter (defaults to process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  /** Sends a signal to a process group (tests). Defaults to `process.kill(-pid, signal)`. */
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface TicketRunResult {
  ok: boolean;
  finalText: string;
  usage: TicketRunUsage;
  maxContextTokens: number;
  crossedTarget: boolean;
  compactions: number;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Redacted tail of the child's stderr. */
  stderrTail: string;
  /** True when the model hit its output limit (stopReason "length"): the work is cut off, not finished. */
  truncated?: boolean;
  /** Last assistant stopReason "error" message, redacted, when there was one. */
  error?: string;
}

export type TicketRunner = (input: Omit<TicketRunInput, "spawn">) => Promise<TicketRunResult>;

/** A running child, so process-level handlers can stop it. */
interface LiveChild {
  /** Marks the run aborted and starts SIGTERM then SIGKILL. */
  abort(): void;
  /** SIGKILLs the child's process group now (the parent is exiting). */
  killNow(): void;
}
const live = new Set<LiveChild>();
let handlersInstalled = false;

/** Number of ticket children currently running. */
export function liveChildCount(): number {
  return live.size;
}

/** Aborts every running ticket child: SIGTERM to its process group now, SIGKILL after the grace period. */
export function abortAllChildren(): void {
  for (const child of [...live]) child.abort();
}

function installProcessHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", () => {
    for (const child of [...live]) child.killNow();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      abortAllChildren();
      // Ours was the only listener, so Node's default (terminate) would otherwise be lost: restore it.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, handler);
  }
}

/** The extension entry that child processes load: this package's own, next to this file's directory. */
export function extensionEntry(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(path.dirname(self)), `extension${path.extname(self) || ".js"}`);
}

/** How to start pi: the running CLI script when we are inside pi, otherwise `pi` on PATH (as Pi's subagent example does). */
export function piInvocation(): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return { command: process.execPath, args: [script] };
  const name = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(name)) return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

/**
 * The child's environment: only allowlisted parent variables (see `ENV_ALLOW_*`), plus `allow` (exact names the caller
 * needs, for example a local provider's apiKeyEnv), plus `extra`. Credentials such as GITHUB_TOKEN never pass.
 */
export function childEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}, allow: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const explicit = new Set(allow);
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || ENV_DENY_ALWAYS.test(key)) continue;
    const named = explicit.has(key);
    const allowed = named || ENV_ALLOW_EXACT.has(key) || ENV_ALLOW_PREFIX.some((prefix) => key.startsWith(prefix));
    if (!allowed) continue;
    if (!named && ENV_DENY_SECRET.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra, [CHILD_ENV]: "1" };
}

export function childArgs(input: Pick<TicketRunInput, "model" | "thinking" | "tools">, files: { system: string; prompt: string; extension: string }): string[] {
  return [
    "--mode", "json",
    "-p",
    "--no-session",
    "--model", `${input.model.provider}/${input.model.id}`,
    ...(input.thinking ? ["--thinking", input.thinking] : []),
    "--tools", input.tools.join(","),
    "--no-extensions",
    "-e", files.extension,
    "--append-system-prompt", files.system,
    `@${files.prompt}`,
    "Task: implement the ticket described in the attached file.",
  ];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("");
}

/**
 * Runs one ticket in a fresh child `pi` process inside its worktree and returns what the JSON event stream said.
 * Never throws for a failed run: spawn errors, non-zero exits, deadlines, and aborts are all reported in the result.
 */
export async function runTicketInChild(input: TicketRunInput): Promise<TicketRunResult> {
  const scratch = mkdtempSync(path.join(tmpdir(), "pi-cost-ticket-"));
  try {
    const files = { system: path.join(scratch, "system.md"), prompt: path.join(scratch, `ticket-${input.ticket.id}.md`), extension: input.extensionPath ?? extensionEntry() };
    writeFileSync(files.system, input.systemPromptAppend, { mode: 0o600 });
    writeFileSync(files.prompt, input.prompt, { mode: 0o600 });
    const base = input.invocation ?? piInvocation();
    const args = [...base.args, ...childArgs(input, files)];
    const env = childEnvironment(input.baseEnv ?? process.env, input.env, input.allowEnv);
    return await supervise(input, base.command, args, env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function supervise(input: TicketRunInput, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<TicketRunResult> {
  const usage: TicketRunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: 0 };
  let maxContext = 0;
  let crossed = false;
  let compactions = 0;
  let finalText = "";
  let lastStop: { reason?: string; error?: string } = {};
  let stderr = "";
  let buffer = "";
  let timedOut = false;
  let aborted = false;
  let spawnError: string | undefined;

  const emit = (event: RunnerEvent) => {
    try {
      input.onEvent?.(event);
    } catch {
      /* a progress listener must not break the run */
    }
  };

  /** Adds one usage object (a message's or a compaction's) to the totals and returns it. */
  const addUsage = (used: Record<string, unknown>): RunnerSpend => {
    const spend: RunnerSpend = { usage: { input: num(used.input), output: num(used.output), cacheRead: num(used.cacheRead), cacheWrite: num(used.cacheWrite) }, costUsd: null };
    usage.input += spend.usage.input;
    usage.output += spend.usage.output;
    usage.cacheRead += spend.usage.cacheRead;
    usage.cacheWrite += spend.usage.cacheWrite;
    const cost = (used.cost as { total?: unknown } | undefined)?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      spend.costUsd = cost;
      usage.costUsd = (usage.costUsd ?? 0) + cost;
    }
    return spend;
  };

  const handle = (event: Record<string, unknown>) => {
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      emit({ kind: "tool", name: event.toolName });
    } else if (event.type === "compaction_end" && event.result && !event.aborted) {
      compactions += 1;
      // Compaction is a model call too (the summary), so its usage counts toward the ticket's cost.
      const summary = (event.result as { usage?: Record<string, unknown> }).usage;
      const spend = summary && typeof summary === "object" ? addUsage(summary) : undefined;
      emit({ kind: "compaction", count: compactions, ...(spend ? { spend } : {}) });
    } else if (event.type === "message_end") {
      const message = event.message as { role?: unknown; content?: unknown; usage?: Record<string, unknown>; stopReason?: unknown; errorMessage?: unknown } | undefined;
      if (!message || message.role !== "assistant") return;
      const text = textOf(message.content);
      if (text.trim()) finalText = text;
      lastStop = { reason: typeof message.stopReason === "string" ? message.stopReason : undefined, error: typeof message.errorMessage === "string" ? message.errorMessage : undefined };
      const used = message.usage;
      if (!used) return;
      usage.turns += 1;
      const spend = addUsage(used);
      const context = num(used.totalTokens) || num(used.input) + num(used.output) + num(used.cacheRead) + num(used.cacheWrite);
      maxContext = Math.max(maxContext, context);
      emit({ kind: "turn", turn: usage.turns, contextTokens: context, spend });
      if (!crossed && input.contextTarget !== undefined && context > input.contextTarget) {
        crossed = true;
        emit({ kind: "crossed-target", contextTokens: context, target: input.contextTarget });
      }
    }
  };

  const line = (raw: string) => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!text.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // noise on stdout (banners, warnings) is not an event
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) handle(parsed as Record<string, unknown>);
  };

  const grouped = process.platform !== "win32";
  return new Promise<TicketRunResult>((resolve) => {
    let child: ChildLike;
    try {
      // Its own process group (not on Windows), so one signal reaches the shell commands and servers the child started.
      child = (input.spawn ?? (nodeSpawn as unknown as SpawnFn))(command, args, { cwd: input.worktreePath, env, detached: grouped });
    } catch (error) {
      resolve(finish(null, `Could not start pi: ${redact((error as Error).message)}`));
      return;
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    let terminating = false;
    const send = (signal: NodeJS.Signals) => {
      if (grouped && typeof child.pid === "number" && child.pid > 0) {
        try {
          (input.signalGroup ?? process.kill)(-child.pid, signal);
          return;
        } catch {
          /* no such group (already exited) or not permitted: fall back to the child itself */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    };
    const terminate = () => {
      terminating = true;
      send("SIGTERM");
      killTimer ??= setTimeout(() => send("SIGKILL"), input.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const entry: LiveChild = { abort: onAbort, killNow: () => send("SIGKILL") };
    live.add(entry);
    installProcessHandlers();
    const cleanup = () => {
      live.delete(entry);
      if (killTimer) clearTimeout(killTimer);
      if (deadline) clearTimeout(deadline);
      input.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS * 2);
    });
    child.on("error", (error) => {
      spawnError = `Could not run pi: ${redact(error.message)}`;
      if (!settled) {
        settled = true;
        cleanup();
        resolve(finish(null, spawnError));
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      // The leader is gone; anything it left in the group after a requested stop gets SIGKILL.
      if (terminating && typeof child.pid === "number") send("SIGKILL");
      cleanup();
      if (buffer.trim()) line(buffer);
      buffer = "";
      resolve(finish(code, spawnError));
    });
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort);
    if (input.deadlineMs !== undefined) {
      deadline = setTimeout(() => {
        timedOut = true;
        terminate();
      }, input.deadlineMs);
    }
  });

  function finish(exitCode: number | null, error?: string): TicketRunResult {
    const truncated = lastStop.reason === "length";
    const failedStop = lastStop.reason === "error" || lastStop.reason === "aborted" || truncated;
    const message = error ?? (truncated ? "The model's output was truncated (stopReason length), so the ticket is not finished." : failedStop ? redact(lastStop.error ?? `Model run ended with ${lastStop.reason}.`) : undefined);
    return {
      ok: exitCode === 0 && !timedOut && !aborted && !failedStop && !error,
      finalText: redact(finalText),
      usage,
      maxContextTokens: maxContext,
      crossedTarget: crossed,
      compactions,
      exitCode,
      timedOut,
      aborted,
      stderrTail: redact(stderr.slice(-STDERR_TAIL_CHARS)),
      ...(truncated ? { truncated: true } : {}),
      ...(message ? { error: message } : {}),
    };
  }
}
