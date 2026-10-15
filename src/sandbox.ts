import { WorkflowError } from "./domain.js";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "xargs"]);
/** Wrapper options that consume the next token as their value. */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g"]);
/** More value-taking options for specific wrappers (`nice -n 5`, `xargs -n 1 -I{}`), which a generic list would get wrong for `sudo -n`. */
const WRAPPER_EXTRA_VALUE_FLAGS: Record<string, Set<string>> = {
  nice: new Set(["-n"]),
  xargs: new Set(["-n", "-I", "-P", "-L", "-s", "-d", "-a", "-E"]),
};
/** git global options that consume the next token as their value. */
export const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

export interface Segment {
  tokens: string[];
  /** True when this segment's stdin is piped from the previous segment. */
  piped: boolean;
}

/** Minimal shell-ish splitter: honours quotes, splits on unquoted | ; & and newlines. */
export function splitSegments(line: string): Segment[] {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let current = "";
  let has = false;
  let quote: string | null = null;
  let nextPiped = false;
  const endToken = () => {
    if (has) tokens.push(current);
    current = "";
    has = false;
  };
  const endSegment = (piped: boolean) => {
    endToken();
    if (tokens.length > 0) segments.push({ tokens, piped: nextPiped });
    tokens = [];
    nextPiped = piped;
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      has = true;
    } else if (ch === "|") {
      if (line[i + 1] === "|") {
        // `||` is a separator, not a pipe.
        i += 1;
        endSegment(false);
      } else {
        if (line[i + 1] === "&") i += 1;
        endSegment(true);
      }
    } else if (ch === ";" || ch === "&" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") {
      endSegment(false);
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      current += ch;
      has = true;
    }
  }
  endSegment(false);
  return segments;
}

export function baseName(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] ?? token;
}

/** Drops leading VAR=value assignments and wrapper commands such as sudo/env. */
export function stripWrappers(tokens: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
    if (i < tokens.length && WRAPPERS.has(baseName(tokens[i]))) {
      const extra = WRAPPER_EXTRA_VALUE_FLAGS[baseName(tokens[i])];
      i += 1;
      while (i < tokens.length && tokens[i].startsWith("-")) {
        const flag = tokens[i];
        i += 1;
        if (WRAPPER_VALUE_FLAGS.has(flag) || extra?.has(flag)) i += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function shortFlags(args: string[]): string {
  let out = "";
  for (const arg of args) {
    if (arg === "--") break;
    if (/^-[A-Za-z]+$/.test(arg)) out += arg.slice(1);
  }
  return out;
}

function longFlag(args: string[], name: string): boolean {
  return args.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function deniedArgv(argv: string[]): boolean {
  const tokens = stripWrappers(argv);
  if (tokens.length === 0) return false;
  const cmd = baseName(tokens[0]).toLowerCase();
  const args = tokens.slice(1);
  const shorts = shortFlags(args);

  if (cmd === "rm") {
    const recursive = /[rR]/.test(shorts) || longFlag(args, "recursive");
    const force = shorts.includes("f") || longFlag(args, "force");
    return recursive && force;
  }
  if (cmd.startsWith("mkfs") || cmd === "shutdown" || cmd === "reboot" || cmd === "halt" || cmd === "poweroff") return true;
  if (cmd === "dd") return args.some((arg) => arg.toLowerCase().startsWith("if="));
  if (cmd === "chmod") {
    const recursive = shorts.includes("R") || longFlag(args, "recursive");
    return recursive && args.some((arg) => arg === "777" || arg === "0777" || arg === "a+rwx");
  }
  if (cmd === "git") {
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) {
      i += GIT_VALUE_FLAGS.has(args[i]) ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (sub === "push") {
      return rest.some(
        (arg) =>
          arg === "--force" ||
          arg.startsWith("--force-with-lease") ||
          arg.startsWith("--force-if-includes") ||
          (/^-[A-Za-z]+$/.test(arg) && arg.includes("f")) ||
          /^\+\S/.test(arg),
      );
    }
    if (sub === "reset") return rest.includes("--hard");
    return false;
  }
  if (SHELLS.has(cmd)) {
    // `bash -c "<script>"` and `bash <(curl ...)` carry a nested command line.
    const idx = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    if (idx >= 0 && args[idx + 1] !== undefined) return isDeniedCommand(args[idx + 1]);
  }
  return false;
}

function isDownloader(tokens: string[]): boolean {
  const stripped = stripWrappers(tokens);
  const cmd = stripped.length > 0 ? baseName(stripped[0]).toLowerCase() : "";
  return cmd === "curl" || cmd === "wget";
}

/** True when the command line (shell syntax allowed) contains a destructive operation. */
export function isDeniedCommand(line: string): boolean {
  if (/<\(\s*(curl|wget)\b/i.test(line) || /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(\S*\/)?(sh|bash|zsh|dash|ksh)\b/i.test(line)) {
    return true;
  }
  const segments = splitSegments(line);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (deniedArgv(segment.tokens)) return true;
    if (segment.piped && i > 0 && isDownloader(segments[i - 1].tokens)) {
      const stripped = stripWrappers(segment.tokens);
      if (stripped.length > 0 && SHELLS.has(baseName(stripped[0]).toLowerCase())) return true;
    }
  }
  return false;
}

export function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

/** Refuses destructive commands (rm -rf, force push, reset --hard, piping a download into a shell) unless `approved`. Everything else may run. */
export function assertCommandSafe(command: string, args: string[], approved = false): void {
  const line = commandLine(command, args);
  if ((isDeniedCommand(line) || deniedArgv([command, ...args])) && !approved) {
    throw new WorkflowError("COMMAND_DENIED", `Blocked destructive command: ${line}`);
  }
}

/** Matches `git push` (also `git -C dir push`, `git -c k=v push`) anywhere in a command line. */
const GIT_PUSH = /(^|[;&|(\n`]|\$\()\s*(\S*\/)?git(\s+(-[cC]\s+\S+|--[\w-]+(=\S+)?|-\w+))*\s+push\b/;
const MAX_NESTING = 4;

/** The git subcommand and its arguments for one segment, or undefined when the segment is not git. */
function gitCall(tokens: string[]): { sub: string | undefined; rest: string[] } | undefined {
  const stripped = stripWrappers(tokens);
  const first = stripped[0];
  if (!first || baseName(first).toLowerCase() !== "git") return undefined;
  const args = stripped.slice(1);
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += GIT_VALUE_FLAGS.has(args[i]!) ? 2 : 1;
  return { sub: args[i], rest: args.slice(i + 1) };
}

/** True for `git switch`, `git checkout -b|-B|--orphan|--detach`, and `git checkout <ref>` (a `--` before the paths means a file restore). */
function movesBranch(call: { sub: string | undefined; rest: string[] }): boolean {
  if (call.sub === "switch") return true;
  if (call.sub !== "checkout") return false;
  if (call.rest.some((arg) => /^-[A-Za-z]*[bB][A-Za-z]*$/.test(arg) || arg === "--orphan" || arg === "--detach")) return true;
  const dash = call.rest.indexOf("--");
  const before = dash < 0 ? call.rest : call.rest.slice(0, dash);
  return dash < 0 ? before.some((arg) => !arg.startsWith("-")) : false;
}

/** Walks a command line, descending into `sh -c "..."` and `eval`, and reports whether `test` holds for any git call. */
function anyGitCall(command: string, test: (call: { sub: string | undefined; rest: string[] }, segmentTokens: string[]) => boolean, depth = 0): boolean {
  if (depth >= MAX_NESTING) return false;
  for (const segment of splitSegments(command)) {
    const tokens = stripWrappers(segment.tokens);
    const first = tokens[0];
    if (!first) continue;
    const name = baseName(first).toLowerCase();
    const args = tokens.slice(1);
    const call = gitCall(segment.tokens);
    if (call && test(call, segment.tokens)) return true;
    if (SHELLS.has(name)) {
      const at = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
      const script = at >= 0 ? args[at + 1] : undefined;
      if (script !== undefined && anyGitCall(script, test, depth + 1)) return true;
    } else if (name === "eval" && anyGitCall(args.join(" "), test, depth + 1)) return true;
  }
  return false;
}

/**
 * True when the command line may run `git push`. Conservative: command substitution or a variable next to the word
 * `push` cannot be inspected, so it counts. Defense in depth only; the real push controls are elsewhere.
 */
export function runsGitPush(command: string, depth = 0): boolean {
  if (GIT_PUSH.test(command)) return true;
  if (/\bpush\b/.test(command) && (/\$\(|`/.test(command) || /(^|[;&|(\n])\s*\\?\$\{?\w/.test(command))) return true;
  if (depth >= MAX_NESTING) return /\bpush\b/.test(command);
  for (const segment of splitSegments(command)) {
    const tokens = stripWrappers(segment.tokens);
    const first = tokens[0];
    if (!first) continue;
    const name = baseName(first).toLowerCase();
    const args = tokens.slice(1);
    if (first.includes("$") && args.some((arg) => arg === "push")) return true;
    if (name === "git") {
      if (gitCall(segment.tokens)?.sub === "push") return true;
    } else if (SHELLS.has(name)) {
      const at = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
      const script = at >= 0 ? args[at + 1] : undefined;
      if (script !== undefined) {
        if (runsGitPush(script, depth + 1)) return true;
      } else if (segment.piped && /\bpush\b/.test(command)) return true;
    } else if (name === "eval" && runsGitPush(args.join(" "), depth + 1)) return true;
  }
  return false;
}

/** True when the command line switches branches: `git switch`, `git checkout -b|-B|<branch>` (also inside `sh -c`). */
export function switchesBranch(command: string): boolean {
  return anyGitCall(command, (call) => movesBranch(call));
}

/** Why a bash command is refused while a /build ticket runs, or undefined. */
export function buildBashBlock(command: string): string | undefined {
  return runsGitPush(command) || switchesBranch(command) ? "/build commits and ships; do not push or switch branches during a ticket." : undefined;
}
