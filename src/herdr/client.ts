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
    /** hc's error kind (`status_mismatch` when `--if idle` found the terminal busy and typed nothing), when it gave one. */
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

export interface SelfInfo {
  terminal: string;
  space: string;
}
export type SelfResult = SelfInfo | { problem: string };

export interface RunOptions {
  argv: string[];
  cwd?: string;
  name?: string;
  labels?: Labels;
  /** Default false: herdr-core types no notes about the child into the parent. */
  notify?: boolean;
  outliveParent?: boolean;
}

export type WaitStatus = "idle" | "done" | "blocked" | "error" | "ended" | "timeout" | string;
export interface WaitResult {
  /** The last status seen: not "working", "ended" when the terminal exited, or "timeout" when the deadline passed. */
  status: WaitStatus;
  exitCode: number | null;
  turn?: number;
  /** True when the overall deadline passed while the terminal was still working. */
  timedOut: boolean;
}

export interface SendOptions {
  /** Pass `--if idle`: only type when the terminal's status is idle (hc fails otherwise). */
  ifIdle?: boolean;
}

export interface TerminalInfo {
  address: string;
  status?: string;
  state?: string;
  /** Labels. `get` fills them; the rows of `hc ls --json` (so `find`) carry none, so match on the labels you asked for. */
  labels: Labels;
  cwd?: string;
  name?: string;
  raw: Record<string, unknown>;
}

export interface HerdrClient {
  self(): Promise<SelfResult>;
  run(options: RunOptions): Promise<string>;
  /** Pastes text and presses Enter, untagged (see `command`). `ifIdle` types only when the terminal is idle. */
  send(terminal: string, text: string, options?: SendOptions): Promise<void>;
  /**
   * Sends a slash command (`/new`, `/model a/b`) to Pi. Same as `send`: hc run from inside herdr wraps the text in an
   * `<hc from=…>` tag, which Pi reads as a chat message, so both run hc without `HC_TERMINAL_ID` and `HC_SCOPE` and
   * the text arrives plain. Use this, not `keys`, for slash commands.
   */
  command(terminal: string, text: string, options?: SendOptions): Promise<void>;
  keys(terminal: string, keys: string[]): Promise<void>;
  waitIdle(terminal: string, options: { timeoutMs: number }): Promise<WaitResult>;
  interrupt(terminal: string): Promise<void>;
  kill(terminal: string): Promise<void>;
  get(terminal: string): Promise<TerminalInfo>;
  find(options: { labels: Labels }): Promise<TerminalInfo[]>;
}

/** Characters `hc keys` accepts as their own name (checked against hc): letters, digits and these marks. */
const KEY_CHARS = /^[a-z0-9/\-.,;'=[\]`\\]$/;

/**
 * Key names for typing text key by key, then enter. Only for text made of characters hc has key names for: an
 * uppercase letter becomes `shift+<lower>`, and any character without a name (`: _ @ + ( ) "` …) throws a
 * HerdrError. Slash commands go through `command()`, which has no such limit.
 */
export function slashKeys(text: string, submit = true): string[] {
  const keys = [...text].map((ch) => {
    if (ch === " ") return "space";
    if (ch === "\n") return "enter";
    if (ch === "\t") return "tab";
    if (/^[A-Z]$/.test(ch)) return `shift+${ch.toLowerCase()}`;
    if (KEY_CHARS.test(ch)) return ch;
    throw new HerdrError(`no key name for ${JSON.stringify(ch)}; use command() for slash commands`, "hc keys");
  });
  return submit ? [...keys, "enter"] : keys;
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

function toInfo(value: unknown): TerminalInfo | undefined {
  const rec = asRecord(value);
  if (!rec || typeof rec.address !== "string") return undefined;
  const labels: Labels = {};
  for (const [k, v] of Object.entries(asRecord(rec.labels) ?? {})) if (typeof v === "string") labels[k] = v;
  const status = typeof rec.status === "string" ? rec.status : asRecord(rec.status) && typeof asRecord(rec.status)!.state === "string" ? (asRecord(rec.status)!.state as string) : undefined;
  return {
    address: rec.address,
    status,
    state: typeof rec.state === "string" ? rec.state : undefined,
    labels,
    cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
    name: typeof rec.name === "string" ? rec.name : undefined,
    raw: rec,
  };
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

  async function sendText(terminal: string, text: string, opts: SendOptions | undefined, what: string): Promise<void> {
    const args = ["send", "--json"];
    if (opts?.ifIdle) args.push("--if", "idle");
    args.push(terminalArg(terminal, what));
    await call([...args, "--", text], `${what} ${terminal} (text omitted)`, undefined, args, untaggedEnv());
  }

  const client: HerdrClient = {
    async self() {
      const terminal = env.HC_TERMINAL_ID?.trim();
      if (!terminal) return { problem: "HC_TERMINAL_ID is not set; pi-chef is not running inside a herdr terminal" };
      try {
        const info = toInfo(await call(["get", terminal, "--json"], `get ${terminal} --json`));
        if (!info) return { problem: `${command} get ${terminal} returned no terminal` };
        const space = info.labels["herdr.space"];
        if (!space) return { problem: `terminal ${terminal} has no herdr.space label` };
        return { terminal, space };
      } catch (error) {
        return { problem: (error as Error).message };
      }
    },

    async run(opts) {
      if (!opts.argv.length) throw new HerdrError("run: empty argv", `${command} run`);
      const args = ["run", "--bg", "--json"];
      if (!opts.notify) args.push("--no-notify");
      if (opts.outliveParent) args.push("--outlive-parent");
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

    send: (terminal, text, opts) => sendText(terminal, text, opts, "send"),
    command: (terminal, text, opts) => sendText(terminal, text, opts, "command"),

    async keys(terminal, keys) {
      if (!keys.length) return;
      await call(["keys", "--json", terminalArg(terminal, "keys"), ...keys], `keys ${terminal} (${keys.length} keys)`);
    },

    async waitIdle(terminal, { timeoutMs }) {
      terminalArg(terminal, "wait");
      const deadline = now() + timeoutMs;
      for (;;) {
        const remaining = deadline - now();
        if (remaining <= 0) return { status: "timeout", exitCode: null, timedOut: true };
        const seconds = Math.max(1, Math.min(slice, Math.ceil(remaining / 1000)));
        const parsed = asRecord(await call(["wait", terminal, "--json", "--timeout", String(seconds)], `wait ${terminal}`, seconds * 1000 + 15_000));
        if (!parsed) throw new HerdrError("wait: hc printed no JSON", `${command} wait ${terminal}`);
        const exitCode = typeof parsed.exit_code === "number" ? parsed.exit_code : null;
        const signal = parsed.signal != null;
        const turn = typeof parsed.turn === "number" ? parsed.turn : undefined;
        if (exitCode !== null || signal) return { status: "ended", exitCode, turn, timedOut: false };
        const status = typeof parsed.status === "string" ? parsed.status : undefined;
        // A timeout or a message to the caller returns while it is still working: keep waiting.
        if (status && status !== "working") return { status, exitCode: null, turn, timedOut: false };
      }
    },

    async interrupt(terminal) {
      await call(["interrupt", terminalArg(terminal, "interrupt"), "--json"], `interrupt ${terminal}`);
    },

    async kill(terminal) {
      await call(["kill", terminalArg(terminal, "kill"), "--json"], `kill ${terminal}`);
    },

    async get(terminal) {
      const info = toInfo(await call(["get", terminalArg(terminal, "get"), "--json"], `get ${terminal}`));
      if (!info) throw new HerdrError("get: hc printed no terminal", `${command} get ${terminal}`);
      return info;
    },

    async find({ labels }) {
      const args = ["ls", "--json"];
      for (const [k, v] of Object.entries(labels)) {
        if (!LABEL_KEY.test(k) || v.includes("\n")) throw new HerdrError(`ls: bad label "${k}"`, `${command} ls`);
        args.push("--label", `${k}=${v}`);
      }
      const parsed = asRecord(await call(args, "ls --json"));
      const list = Array.isArray(parsed?.terminals) ? parsed.terminals : [];
      return list.map(toInfo).filter((x): x is TerminalInfo => !!x);
    },
  };
  return client;
}
