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
function badPathArgument(word: string, roots: string[], isOperand: boolean, command: string): boolean {
  if (/\$[A-Za-z_{(]/.test(word)) return true;
  const value = word.startsWith("-") ? (word.includes("=") ? word.slice(word.indexOf("=") + 1) : "") : word;
  if (!value) return false;
  if (value.startsWith("~")) return true;
  if (value.split("/").includes("..")) return !roots.some((root) => insideRoot(root, value));
  if (path.isAbsolute(value)) {
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
      if (sub === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url";
      return true;
    }
    default:
      return true;
  }
}

/**
 * True when a bash command is plainly read-only (the plan-mode allowlist, tightened: no redirects, no chaining,
 * no file-writing or program-running options, no paths outside `root`, no `~` or variable expansion).
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
    // Quotes and backslashes are dropped so `'--out'put` cannot hide an option from the checks below.
    const words = part.trim().split(/\s+/).map((word) => word.replace(/['"\\]/g, ""));
    const [first, second] = words;
    if (!first) return false;
    if (first === "git") {
      if (!second || !SAFE_GIT.has(second)) return false;
    } else if (!SAFE_COMMANDS.has(first)) return false;
    const operands = fileOperandIndexes(words);
    if (words.slice(1).some((word, index) => badPathArgument(word, roots, operands.has(index + 1), first))) return false;
    return safeArguments(words);
  });
}

/** Built-in write tools that are disabled while planning. */
export const PLANNING_DISABLED_TOOLS = ["edit", "write"];
/** Tools the planning turns rely on: read-only exploration, web lookup, and the plan tools. */
export const PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "web_search", "web_fetch", "plan_questions", "plan_spec", "plan_consult", "plan_tickets"];
export const PLAN_TOOL_NAMES = ["plan_questions", "plan_spec", "plan_consult", "plan_tickets"];
