/**
 * The herdr client: a small injected interface over the `hc` command, like `ChildSdk`. The real one spawns with
 * `execFile` and argv arrays (never a shell); tests use a fake exec. Every failure is a `HerdrError` carrying the
 * command (text sent to a terminal is never put in it, since it may hold prompts) and redacted stderr; nothing here
 * throws anything else, and hc's JSON is parsed defensively.
 */
import { execFile } from "node:child_process";
import { redact } from "../redact.js";
import { assertCommandSafe } from "../sandbox.js";

export class HerdrError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly stderr = "",
    /** hc's error kind (for example `status_mismatch` when the terminal was blocked and nothing was typed), when it gave one. */
    readonly kind?: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when the process could not start or was killed. */
  code: number | null;
  /** Set when the process could not be started at all (ENOENT). */
  spawnError?: string;
}

export type HerdrExec = (file: string, args: string[], options: { timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult>;

export function execFileExec(): HerdrExec {
  return (file, args, options) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", env: options.env }, (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, code: 0 });
        const e = error as NodeJS.ErrnoException & { code?: number | string; signal?: string | null; killed?: boolean };
        const out = { stdout: stdout ?? "", stderr: stderr ?? "" };
        if (typeof e.code === "number") return resolve({ ...out, code: e.code });
        // Died by signal or timeout. Node's message is "Command failed: <full argv>", which may hold a pasted prompt, so it is never kept.
        if (e.signal != null || e.killed) return resolve({ ...out, code: null });
        resolve({ ...out, code: null, spawnError: typeof e.code === "string" ? e.code : "spawn failed" });
      });
    });
}

export type Labels = Record<string, string>;

export type SelfResult = { terminal: string; space: string } | { problem: string };

export interface RunOptions {
  argv: string[];
  cwd?: string;
  name?: string;
  labels?: Labels;
}

export type WaitStatus = "working" | "idle" | "done" | "blocked" | "error" | "ended" | "timeout" | string;
export interface WaitResult {
  /** The last status seen: "working" when a `send` checked in before its turn ended, "ended" when the terminal exited, or "timeout" when the deadline passed. */
  status: WaitStatus;
  exitCode: number | null;
  turn?: number;
  /** True when the overall deadline passed while the terminal was still working. */
  timedOut: boolean;
}

export interface HerdrClient {
  self(): Promise<SelfResult>;
  run(options: RunOptions): Promise<string>;
  /**
   * Pastes `text`, presses Enter and waits for the turn THIS send started (`hc send --wait`), for at most `timeoutMs`; one
   * hc call blocks for at most its wait slice. It does not check the status first (hc refuses a blocked terminal and queues
   * text for a working one), so callers look before sending. The result is "working" when the call checked in before the
   * turn ended: look again with `waitIdle`. The text goes without `HC_TERMINAL_ID` and `HC_SCOPE`, so hc adds no `<hc from=…>` tag.
   */
  send(terminal: string, text: string, options: { timeoutMs: number }): Promise<WaitResult>;
  /** Waits until the terminal is no longer working, or the deadline passes. Any other status returns at once (`done` and `idle` alike). */
  waitIdle(terminal: string, options: { timeoutMs: number }): Promise<WaitResult>;
  /** The terminal's screen as text, with `lines` of history above it (`hc read --json --lines`). */
  read(terminal: string, lines?: number): Promise<string>;
  kill(terminal: string): Promise<void>;
}

export interface ClientOptions {
  /** The hc binary, later `isolation.herdrCommand`. */
  command?: string;
  exec?: HerdrExec;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Seconds a single `hc wait` may block (hc's default is 180). */
  waitSliceSeconds?: number;
}

const LABEL_KEY = /^[A-Za-z0-9_.-]+$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** hc's wait JSON (also what `send --wait` prints) as a result, or undefined when it names no status and no exit. */
function waitResult(parsed: Record<string, unknown> | undefined): WaitResult | undefined {
  if (!parsed) return undefined;
  const exitCode = typeof parsed.exit_code === "number" ? parsed.exit_code : null;
  const turn = typeof parsed.turn === "number" ? parsed.turn : undefined;
  if (exitCode !== null || parsed.signal != null) return { status: "ended", exitCode, turn, timedOut: false };
  return typeof parsed.status === "string" ? { status: parsed.status, exitCode: null, turn, timedOut: false } : undefined;
}

export function createHerdrClient(options: ClientOptions = {}): HerdrClient {
  const command = options.command?.trim() || "hc";
  const exec = options.exec ?? execFileExec();
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const slice = Math.max(1, Math.floor(options.waitSliceSeconds ?? 180));

  /** Runs hc; `display` is what an error may say about the call (never the text sent). */
  async function call(args: string[], display: string, timeoutMs?: number, checked: string[] = args, childEnv?: Record<string, string>): Promise<unknown> {
    const shown = `${command} ${display}`;
    try {
      // Pasted text is data for the terminal, not a command of ours: only the structural args are checked.
      assertCommandSafe(command, checked);
    } catch (error) {
      throw new HerdrError(`${command} was refused by the command rules`, shown);
    }
    const result = await exec(command, args, { timeoutMs, env: childEnv });
    if (result.spawnError) {
      throw new HerdrError(result.spawnError === "ENOENT" ? `${command} is not installed or not on PATH` : `could not run ${command}: ${redact(result.spawnError)}`, shown);
    }
    const parsed = parse(result.stdout);
    if (result.code !== 0) {
      const err = asRecord(asRecord(parsed)?.error);
      const reason = typeof err?.message === "string" ? err.message : result.code === null ? "killed or timed out" : `exit ${result.code}`;
      throw new HerdrError(`${shown} failed: ${redact(reason)}`, shown, redact(result.stderr.trim()), typeof err?.kind === "string" ? err.kind : undefined);
    }
    return parsed;
  }

  function parse(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  function terminalArg(terminal: string, what: string): string {
    if (!terminal || terminal.startsWith("-")) throw new HerdrError(`${what}: bad terminal address`, `${command} ${what}`);
    return terminal;
  }

  /** The environment for sends: hc tags text with `<hc from=…>` when it finds the caller's terminal, so that is removed. */
  function untaggedEnv(): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "HC_TERMINAL_ID" && k !== "HC_SCOPE") clean[k] = v;
    return clean;
  }

  /** Seconds for one hc call that blocks: at most the wait slice, at least 1. */
  const sliceFor = (remainingMs: number) => Math.max(1, Math.min(slice, Math.ceil(remainingMs / 1000)));

  return {
    async self() {
      const terminal = env.HC_TERMINAL_ID?.trim();
      if (!terminal) return { problem: "HC_TERMINAL_ID is not set; pi-chef is not running inside a herdr terminal" };
      try {
        const info = asRecord(await call(["get", terminal, "--json"], `get ${terminal} --json`));
        if (typeof info?.address !== "string") return { problem: `${command} get ${terminal} returned no terminal` };
        const space = asRecord(info.labels)?.["herdr.space"];
        if (typeof space !== "string" || !space) return { problem: `terminal ${terminal} has no herdr.space label` };
        return { terminal, space };
      } catch (error) {
        return { problem: (error as Error).message };
      }
    },

    async run(opts) {
      if (!opts.argv.length) throw new HerdrError("run: empty argv", `${command} run`);
      // No notes about the child go into the parent's chat (--no-notify).
      const args = ["run", "--bg", "--json", "--no-notify"];
      if (opts.name) args.push("--name", opts.name);
      if (opts.cwd) args.push("--cwd", opts.cwd);
      for (const [k, v] of Object.entries(opts.labels ?? {})) {
        if (!LABEL_KEY.test(k) || v.includes("\n")) throw new HerdrError(`run: bad label "${k}"`, `${command} run`);
        args.push("--label", `${k}=${v}`);
      }
      args.push("--", ...opts.argv);
      const parsed = asRecord(await call(args, `run --bg${opts.name ? ` --name ${opts.name}` : ""} (argv omitted)`));
      const address = typeof parsed?.address === "string" ? parsed.address : undefined;
      if (!address) throw new HerdrError("run: hc printed no terminal address", `${command} run`);
      return address;
    },

    async send(terminal, text, { timeoutMs }) {
      const seconds = sliceFor(timeoutMs);
      const args = ["send", "--json", "--wait", "--timeout", String(seconds), terminalArg(terminal, "send")];
      const parsed = asRecord(await call([...args, "--", text], `send ${terminal} (text omitted)`, seconds * 1000 + 15_000, args, untaggedEnv()));
      // Verified live (hc, 2026-11-08): `send --wait --json` prints {started, status, turn, wait: {...}}. The top-level
      // status is the terminal's state BEFORE the send; the turn's outcome is the nested `wait` object. Reading the top
      // level would report a still-working turn as idle. A `wait` without a status (a check-in timeout) means the caller
      // keeps waiting with waitIdle.
      const waited = asRecord(parsed?.wait);
      if (!waited) throw new HerdrError("send: hc printed no wait result", `${command} send ${terminal}`);
      return waitResult(waited) ?? { status: "working", exitCode: null, timedOut: false };
    },

    async waitIdle(terminal, { timeoutMs }) {
      terminalArg(terminal, "wait");
      const deadline = now() + timeoutMs;
      for (;;) {
        const remaining = deadline - now();
        if (remaining <= 0) return { status: "timeout", exitCode: null, timedOut: true };
        const seconds = sliceFor(remaining);
        const parsed = asRecord(await call(["wait", terminal, "--json", "--timeout", String(seconds)], `wait ${terminal}`, seconds * 1000 + 15_000));
        if (!parsed) throw new HerdrError("wait: hc printed no JSON", `${command} wait ${terminal}`);
        const result = waitResult(parsed);
        // A timeout or a message to the caller returns while it is still working: keep waiting.
        if (result && result.status !== "working") return result;
      }
    },

    async read(terminal, lines = 0) {
      const parsed = asRecord(await call(["read", terminalArg(terminal, "read"), "--json", "--lines", String(Math.max(0, Math.floor(lines)))], `read ${terminal}`));
      return typeof parsed?.text === "string" ? parsed.text : "";
    },

    async kill(terminal) {
      await call(["kill", terminalArg(terminal, "kill"), "--json"], `kill ${terminal}`);
    },
  };
}
