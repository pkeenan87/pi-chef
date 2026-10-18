import { WorkflowError } from "./domain.js";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "xargs", "timeout", "setsid", "stdbuf", "ionice", "chrt", "taskset"]);
/** Wrapper options that consume the next token as their value. */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g"]);
/** More value-taking options for specific wrappers (`nice -n 5`, `xargs -n 1 -I{}`), which a generic list would get wrong for `sudo -n`. */
const WRAPPER_EXTRA_VALUE_FLAGS: Record<string, Set<string>> = {
  nice: new Set(["-n"]),
  xargs: new Set(["-n", "-I", "-P", "-L", "-s", "-d", "-a", "-E"]),
  timeout: new Set(["-s", "-k"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n", "-p"]),
};
/** Wrappers that take positional words before the command (`timeout 60 cmd`, `chrt 10 cmd`, `taskset 3 cmd`). */
const WRAPPER_POSITIONALS: Record<string, number> = { timeout: 1, chrt: 1, taskset: 1 };
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

/**
 * Drops leading VAR=value assignments and wrapper commands such as sudo/env/timeout. `env -S "a b"` is split into
 * words. `xargs` is true when a wrapper was xargs, whose arguments come from stdin and so cannot be inspected.
 */
function unwrap(input: string[]): { argv: string[]; xargs: boolean } {
  let tokens = input;
  let xargs = false;
  let i = 0;
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
    const name = i < tokens.length ? baseName(tokens[i]) : "";
    if (!WRAPPERS.has(name)) break;
    if (name === "xargs") xargs = true;
    const extra = WRAPPER_EXTRA_VALUE_FLAGS[name];
    i += 1;
    let split: string | undefined;
    while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "--") {
      const flag = tokens[i];
      i += 1;
      if (name === "env" && (flag === "-S" || flag === "--split-string")) split = tokens[i++];
      else if (name === "env" && (flag.startsWith("-S") || flag.startsWith("--split-string="))) split = flag.slice(flag.startsWith("-S") ? 2 : 15);
      else if (WRAPPER_VALUE_FLAGS.has(flag) || extra?.has(flag)) i += 1;
    }
    if (tokens[i] === "--") i += 1;
    if (split !== undefined) {
      tokens = [...(splitSegments(split)[0]?.tokens ?? []), ...tokens.slice(i)];
      i = 0;
      continue;
    }
    i += WRAPPER_POSITIONALS[name] ?? 0;
  }
  return { argv: tokens.slice(i), xargs };
}

export function stripWrappers(tokens: string[]): string[] {
  return unwrap(tokens).argv;
}

const MAX_NESTING = 4;

export interface SimpleCommand {
  /** The command and its arguments, wrappers stripped. */
  argv: string[];
  /** True when xargs supplies more arguments from stdin. */
  xargs: boolean;
  /** True when the command reads its stdin from a pipe (so a shell may be reading a script). */
  piped: boolean;
  /** A nested script left unread because the nesting is too deep. */
  opaque?: string;
}

/** The script of `sh -c [--] <script>` (also `-ec`, `-xc`), or undefined. */
function shellScript(args: string[]): string | undefined {
  const at = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
  if (at < 0) return undefined;
  return args[at + 1] === "--" ? args[at + 2] : args[at + 1];
}

function commandsOfArgv(tokens: string[], piped: boolean, depth: number): SimpleCommand[] {
  const { argv, xargs } = unwrap(tokens);
  if (argv.length === 0) return [];
  const out: SimpleCommand[] = [{ argv, xargs, piped }];
  const name = baseName(argv[0]).toLowerCase();
  const args = argv.slice(1);
  const nested = (script: string) => {
    if (depth + 1 >= MAX_NESTING) out.push({ argv: [], xargs: false, piped: false, opaque: script });
    else out.push(...commandsIn(script, depth + 1));
  };
  if (SHELLS.has(name)) {
    const script = shellScript(args);
    if (script !== undefined) nested(script);
  } else if (name === "eval") nested(args.join(" "));
  else if (name === "find") {
    for (let i = 0; i < args.length; i += 1) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(args[i])) continue;
      const end = args.findIndex((arg, j) => j > i && (arg === ";" || arg === "+"));
      const inner = args.slice(i + 1, end < 0 ? undefined : end);
      if (depth + 1 < MAX_NESTING) out.push(...commandsOfArgv(inner, false, depth + 1));
      else out.push({ argv: [], xargs: false, piped: false, opaque: inner.join(" ") });
    }
  }
  return out;
}

/** Every simple command a line runs, descending into `sh -c`, `eval`, `env -S` and `find -exec`. */
export function commandsIn(line: string, depth = 0): SimpleCommand[] {
  return splitSegments(line).flatMap((segment) => commandsOfArgv(segment.tokens, segment.piped, depth));
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

function deniedArgv(tokens: string[]): boolean {
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
  const call = gitCall(tokens);
  if (call?.sub === "push") {
    // A force push, or a remote branch deletion (`--delete`, `-d`, `:branch`).
    return call.rest.some(
      (arg) =>
        arg === "--force" ||
        arg === "--delete" ||
        arg.startsWith("--force-with-lease") ||
        arg.startsWith("--force-if-includes") ||
        (/^-[A-Za-z]+$/.test(arg) && /[fd]/.test(arg)) ||
        /^\+\S/.test(arg) ||
        /^:\S/.test(arg),
    );
  }
  if (call?.sub === "reset") return call.rest.includes("--hard");
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
  const commands = commandsIn(line);
  if (commands.some((command) => deniedArgv(command.argv) || (command.opaque !== undefined && isDeniedCommand(command.opaque)))) return true;
  const segments = splitSegments(line);
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].piped && isDownloader(segments[i - 1].tokens)) {
      const stripped = stripWrappers(segments[i].tokens);
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
  if ((isDeniedCommand(line) || commandsOfArgv([command, ...args], false, 0).some((call) => deniedArgv(call.argv))) && !approved) {
    throw new WorkflowError("COMMAND_DENIED", `Blocked destructive command: ${line}`);
  }
}

/** Matches `git push` (also `git -C dir push`, `git -c k=v push`) anywhere in a command line. */
const GIT_PUSH = /(^|[;&|(\n`]|\$\()\s*(\S*\/)?git(\s+(-[cC]\s+\S+|--[\w-]+(=\S+)?|-\w+))*\s+push\b/;

interface GitCall {
  sub: string | undefined;
  rest: string[];
}

/**
 * The git subcommand and its arguments for a stripped argv, or undefined when it is not git. An alias defined inline
 * (`git -c alias.p=push p`, `-c alias.p='!git push'`) is expanded.
 */
function gitCall(argv: string[]): GitCall | undefined {
  const first = argv[0];
  if (!first || baseName(first).toLowerCase() !== "git") return undefined;
  const args = argv.slice(1);
  const aliases = new Map<string, string>();
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const alias = args[i] === "-c" ? /^alias\.([^=]+)=(.*)$/i.exec(args[i + 1] ?? "") : null;
    if (alias) aliases.set(alias[1]!.toLowerCase(), alias[2]!);
    i += GIT_VALUE_FLAGS.has(args[i]!) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const expansion = sub === undefined ? undefined : aliases.get(sub.toLowerCase());
  if (expansion === undefined) return { sub, rest };
  const words = expansion.replace(/^!\s*/, "").trim().split(/\s+/);
  if (words[0] === "git") words.shift();
  return { sub: words[0], rest: [...words.slice(1), ...rest] };
}

/** True for `git switch`, `git checkout -b|-B|--orphan|--detach|-|<ref>` (a `--` before the paths means a file restore), and `git symbolic-ref HEAD <ref>`. */
function movesBranch(call: GitCall): boolean {
  if (call.sub === "switch") return true;
  if (call.sub === "symbolic-ref") return call.rest.filter((arg) => !arg.startsWith("-")).length >= 2;
  if (call.sub !== "checkout") return false;
  if (call.rest.some((arg) => /^-[A-Za-z]*[bB][A-Za-z]*$/.test(arg) || arg === "--orphan" || arg === "--detach")) return true;
  const dash = call.rest.indexOf("--");
  return dash < 0 && call.rest.some((arg) => arg === "-" || !arg.startsWith("-"));
}

/**
 * True when the command line may run git with `test` true. Conservative: a git call fed by xargs, a shell reading a
 * piped script, or a script nested too deep counts when the line contains `word` at all.
 */
function mayRunGit(command: string, word: RegExp, test: (call: GitCall) => boolean): boolean {
  for (const simple of commandsIn(command)) {
    if (simple.opaque !== undefined) {
      if (word.test(simple.opaque)) return true;
      continue;
    }
    const call = gitCall(simple.argv);
    if (call && test(call)) return true;
    const first = simple.argv[0] ?? "";
    if ((simple.xargs || (simple.piped && SHELLS.has(baseName(first).toLowerCase()) && shellScript(simple.argv.slice(1)) === undefined)) && word.test(command)) return true;
  }
  return false;
}

/**
 * True when the command line may run `git push`. Conservative: command substitution or a variable next to the word
 * `push` cannot be inspected, so it counts. Defense in depth only; the real push controls are elsewhere.
 */
export function runsGitPush(command: string): boolean {
  if (GIT_PUSH.test(command)) return true;
  if (/\bpush\b/.test(command) && (/\$\(|`/.test(command) || /(^|[;&|(\n])\s*\\?\$\{?\w/.test(command))) return true;
  if (commandsIn(command).some((simple) => (simple.argv[0] ?? "").includes("$") && simple.argv.includes("push"))) return true;
  return mayRunGit(command, /\bpush\b/, (call) => call.sub === "push");
}

/** True when the command line switches branches: `git switch`, `git checkout -b|-B|<branch>` (also inside `sh -c`). */
export function switchesBranch(command: string): boolean {
  return mayRunGit(command, /\b(switch|checkout|symbolic-ref)\b/, movesBranch);
}

/** Why a bash command is refused while a /build ticket runs, or undefined. */
export function buildBashBlock(command: string): string | undefined {
  return runsGitPush(command) || switchesBranch(command) ? "/build commits each ticket; do not push or switch branches during a ticket." : undefined;
}
