import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeniedCommand } from "../sandbox.js";

/** Characters that chain commands, redirect output, or substitute commands. Any of them voids the allowlist. */
const UNSAFE_SYNTAX = /[;&`><]|\$\(|\n/;

/** Read-only commands allowed while planning. A pipe may only feed another allowed command. */
const SAFE_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "rg", "find", "ls", "pwd", "echo", "wc", "sort", "uniq", "diff", "file", "stat", "du", "tree", "which", "date", "uname", "whoami", "basename", "dirname", "realpath",
]);
const SAFE_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "ls-files", "blame", "rev-parse"]);

/**
 * `az` while planning: these exact reads of what is deployed, nothing else. Not `keyvault`, keys, credentials, app
 * settings or `get-access-token`: their output (a secret, a token) would land in the transcript the planner sends on.
 */
const AZ_READS = new Set(["account show", "account list", "group show", "group list", "resource show", "resource list"]);
/** az flags allowed on those reads: true when the flag takes a value (`--ids` takes several). No `--debug`, which logs HTTP traffic. */
const AZ_FLAGS = new Map<string, boolean>([
  ["--output", true], ["-o", true], ["--query", true], ["--resource-group", true], ["-g", true], ["--name", true], ["-n", true],
  ["--ids", true], ["--resource-type", true], ["--namespace", true], ["--parent", true], ["--subscription", true], ["--tag", true],
  ["--location", true], ["-l", true], ["--api-version", true], ["--all", false], ["--refresh", false], ["--only-show-errors", false],
]);

/**
 * `gh` while planning: finding and reading code in other repositories. `gh api` only GETs a repository's contents,
 * readme or tree (no method, fields, or input). Never `auth` (which can print the token), `--web`, or `--jq`, whose
 * `env` builtin prints the environment.
 */
const GH_FLAGS: Record<string, Map<string, boolean>> = {
  "repo view": new Map([["--json", true], ["--branch", true], ["-b", true]]),
  "repo list": new Map([["--json", true], ["--limit", true], ["-L", true], ["--language", true], ["-l", true], ["--topic", true], ["--visibility", true], ["--source", false], ["--no-archived", false]]),
  "search code": new Map([["--json", true], ["--limit", true], ["-L", true], ["--owner", true], ["--repo", true], ["-R", true], ["--language", true], ["--filename", true], ["--extension", true], ["--match", true]]),
  "search repos": new Map([["--json", true], ["--limit", true], ["-L", true], ["--owner", true], ["--language", true], ["--topic", true]]),
  api: new Map([["--header", true], ["-H", true], ["--paginate", false]]),
};
const GH_API_PATH = /^\/?repos\/[\w.-]+\/[\w.-]+\/(?:contents|readme|git\/trees)(?:\/[^\s?]*)?(?:\?\S*)?$/;

/** Flags and their values after the command words: only flags in `allowed`, no `@file` values (az reads the file into the argument). */
function allowedFlags(args: string[], allowed: Map<string, boolean>, positionals: (word: string) => boolean): boolean {
  let takesValues = 0;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      const [flag = "", inline] = arg.split(/=(.*)/s);
      const value = allowed.get(flag);
      if (value === undefined || (inline !== undefined && (!value || inline.startsWith("@")))) return false;
      takesValues = value && inline === undefined ? (flag === "--ids" ? Infinity : 1) : 0;
    } else if (arg.startsWith("@")) return false;
    else if (takesValues > 0) takesValues -= 1;
    else if (!positionals(arg)) return false;
  }
  return true;
}

function safeAz(args: string[]): boolean {
  return AZ_READS.has(`${args[0]} ${args[1]}`) && allowedFlags(args.slice(2), AZ_FLAGS, () => false);
}

function safeGh(args: string[]): boolean {
  if (args[0] === "api") {
    let endpoints = 0;
    // The only header is Accept (raw file contents, for example).
    const headers = args.slice(1).every((arg, index, rest) => {
      const inline = /^(?:-H|--header)=(.*)$/s.exec(arg);
      if (inline) return /^accept:/i.test(inline[1]!);
      return !/^(-H|--header)$/.test(rest[index - 1] ?? "") || /^accept:/i.test(arg);
    });
    return headers && allowedFlags(args.slice(1), GH_FLAGS.api!, (word) => GH_API_PATH.test(word) && ++endpoints === 1) && endpoints === 1;
  }
  const command = `${args[0]} ${args[1]}`;
  const flags = GH_FLAGS[command];
  if (!flags) return false;
  // repo view/list take one repo or owner; search takes free query words.
  let operands = 0;
  return allowedFlags(args.slice(2), flags, () => command.startsWith("search") || ++operands === 1);
}

const GIT_BRANCH_LIST_FLAGS = /^(-[arlv]+|--list|--show-current|--contains|--merged|--no-merged)$/;
const GIT_BRANCH_VALUE_FLAGS = new Set(["--contains", "--merged", "--no-merged"]);
const GIT_BRANCH_PATTERN_FLAGS = new Set(["-l", "--list", ...GIT_BRANCH_VALUE_FLAGS]);

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, path.resolve(root, target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Commands whose absolute operands are always checked against the project root, even when the path does not exist. */
const PATH_TARGET_COMMANDS = new Set(["cd", "ls", "cat", "head", "tail", "find", "tree", "wc", "file", "stat"]);
/** Commands that take no file operands at all. */
const NO_FILE_COMMANDS = new Set(["pwd", "echo", "which", "date", "uname", "whoami", "basename", "dirname"]);

/**
 * Splits one pipeline part into words the way bash would read them, or returns undefined when a word would be
 * expanded: an unquoted or double-quoted `$` (variables, `$'..'` ANSI-C quoting, `$0`), an unquoted brace, or an
 * unterminated quote. `globbed` marks words with an unquoted `*`, `?` or `[`.
 */
function shellWords(part: string): { words: string[]; globbed: boolean[] } | undefined {
  const words: string[] = [];
  const globbed: boolean[] = [];
  let current = "";
  let has = false;
  let glob = false;
  let quote: string | null = null;
  const end = () => {
    if (has) {
      words.push(current);
      globbed.push(glob);
    }
    current = "";
    has = false;
    glob = false;
  };
  for (let i = 0; i < part.length; i += 1) {
    const ch = part[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$") return undefined;
      else if (ch === "\\" && i + 1 < part.length) current += part[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\") {
      if (i + 1 < part.length) current += part[++i];
      has = true;
    } else if (ch === "$" || ch === "{" || ch === "}") {
      return undefined;
    } else if (/\s/.test(ch)) {
      end();
    } else {
      if (ch === "*" || ch === "?" || ch === "[") glob = true;
      current += ch;
      has = true;
    }
  }
  if (quote) return undefined;
  end();
  return { words, globbed };
}

/** Indexes (into `words`, after the command) of words that are file operands rather than patterns, flags, or expressions. */
function fileOperandIndexes(words: string[]): Set<number> {
  const [first = "", ...args] = words;
  const out = new Set<number>();
  if (NO_FILE_COMMANDS.has(first)) return out;
  let patternTaken = false;
  let patternFlag = false;
  let expression = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (first === "grep" || first === "rg") {
      // -e/-f/--regexp supply the pattern, so every bare operand is a file; otherwise the first one is the pattern.
      if (/^(-[A-Za-z]*[ef]|--regexp|--file)$/.test(arg)) {
        patternFlag = true;
        // A pattern file is read, so it is a file operand.
        if (/^(-[A-Za-z]*f|--file)$/.test(arg)) out.add(i + 2);
        i += 1;
        continue;
      }
      if (arg.startsWith("-")) continue;
      if (!patternFlag && !patternTaken) {
        patternTaken = true;
        continue;
      }
    } else if (first === "find") {
      // Paths come first; from the first option or expression word on, words are test arguments such as `-name /x`.
      if (expression || arg.startsWith("-") || arg === "(" || arg === "!") {
        expression = true;
        continue;
      }
    } else if (arg.startsWith("-")) continue;
    out.add(i + 1);
  }
  return out;
}

/**
 * Rejects arguments that escape the project root, name the home directory, or expand variables.
 * An absolute word is a path only at an operand position, and is checked when the command names its target
 * (cd, ls, cat, ...) or the path exists on disk, so `grep /api/users src` and `rg "/v1/foo"` pass.
 */
function badPathArgument(word: string, roots: string[], isOperand: boolean, command: string, globbed = false): boolean {
  const value = word.startsWith("-") ? (word.includes("=") ? word.slice(word.indexOf("=") + 1) : "") : word;
  if (!value) return false;
  if (value.startsWith("~")) return true;
  if (value.split("/").includes("..")) return !roots.some((root) => insideRoot(root, value));
  if (path.isAbsolute(value)) {
    // A glob such as `/et?/passwd` does not exist as written, so it is checked whatever the command.
    if (globbed) return !roots.some((root) => insideRoot(root, value.slice(0, value.search(/[*?[]/))));
    if (!isOperand && !word.startsWith("-")) return false;
    if (!PATH_TARGET_COMMANDS.has(command) && !existsSync(value)) return false;
    return !roots.some((root) => insideRoot(root, value));
  }
  return false;
}

/** Argument-level checks for one command of a pipeline. Returns false when an allowed command is used in a writing or executing way. */
function safeArguments(words: string[]): boolean {
  const [first = "", ...args] = words;
  // `--output` writes a file for sort, git log/diff, and others; `--pre` and friends run programs.
  if (args.some((arg) => /^--output(=|$)/.test(arg) || /^--(pre|pre-glob|hostname-bin|compress-program)(=|$)/.test(arg))) return false;
  switch (first) {
    case "sort":
      return !args.some((arg) => /^-[A-Za-z]*o/.test(arg) && !arg.startsWith("--"));
    case "tree":
      return !args.some((arg) => /^-[A-Za-z]*o/.test(arg) && !arg.startsWith("--"));
    case "uniq": {
      let operands = 0;
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]!;
        if (/^-[fsw]$/.test(arg)) i += 1;
        else if (!arg.startsWith("-")) operands += 1;
      }
      return operands <= 1;
    }
    case "find":
      return !args.some((arg) => /^-(fprint|fprint0|fprintf|fls|exec|ok|delete)/.test(arg));
    case "file":
      return !args.some((arg) => arg === "--compile" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("C")));
    case "date":
      return !args.some((arg) => arg === "--set" || arg.startsWith("--set=") || (/^-[A-Za-z]+$/.test(arg) && arg.includes("s")));
    case "git": {
      const sub = args[0];
      const rest = args.slice(1);
      if (rest.includes("-D") || rest.includes("--delete")) return false;
      if (sub === "branch") {
        let listing = false;
        for (let i = 0; i < rest.length; i += 1) {
          const arg = rest[i]!;
          if (arg.startsWith("-")) {
            if (!GIT_BRANCH_LIST_FLAGS.test(arg)) return false;
            if (GIT_BRANCH_PATTERN_FLAGS.has(arg)) listing = true;
          } else if (!listing) return false;
        }
        return true;
      }
      if (sub === "remote") {
        const words = rest.filter((arg) => arg !== "-v" && arg !== "--verbose");
        return words.length === 0 || words[0] === "show" || words[0] === "get-url";
      }
      return true;
    }
    default:
      return true;
  }
}

/**
 * True when a bash command is plainly read-only (the plan-mode allowlist, tightened: no redirects, no chaining,
 * no file-writing or program-running options, no paths outside `root`, no `~`, variable or brace expansion), or one
 * of the exact `az` reads of deployed resources and `gh` reads of other repositories.
 */
export function isReadOnlyCommand(command: string, root: string = process.cwd()): boolean {
  if (isDeniedCommand(command) || UNSAFE_SYNTAX.test(command)) return false;
  const roots = [path.resolve(root)];
  try {
    roots.push(realpathSync(root));
  } catch {
    /* the root may not exist in a test */
  }
  return command.split("|").every((part) => {
    // Words as bash reads them, so `'--out'put` or `$'-delete'` cannot hide an option from the checks below.
    const parsed = shellWords(part);
    if (!parsed) return false;
    const { words, globbed } = parsed;
    const [first, second] = words;
    if (!first) return false;
    if (first === "git") {
      if (!second || !SAFE_GIT.has(second)) return false;
    } else if (first === "az" || first === "gh") {
      if (!(first === "az" ? safeAz : safeGh)(words.slice(1))) return false;
    } else if (!SAFE_COMMANDS.has(first)) return false;
    const operands = fileOperandIndexes(words);
    if (words.slice(1).some((word, index) => badPathArgument(word, roots, operands.has(index + 1), first, globbed[index + 1]))) return false;
    // az and gh have their own exact flag lists (checked above), so the generic option rules do not apply to them.
    return first === "az" || first === "gh" || safeArguments(words);
  });
}

/** Built-in write tools that are disabled while planning. */
export const PLANNING_DISABLED_TOOLS = ["edit", "write"];
/** Tools the planning turns rely on: read-only exploration, web lookup, and the plan tools. */
export const PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "web_search", "web_fetch", "plan_questions", "plan_spec", "plan_consult", "plan_tickets"];
export const PLAN_TOOL_NAMES = ["plan_questions", "plan_spec", "plan_consult", "plan_tickets"];
