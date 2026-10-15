import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { CHILD_ROOT_ENV, CHILD_TASK_ENV } from "./agents/pi-runner.js";
import { baseName, GIT_VALUE_FLAGS, isDeniedCommand, splitSegments, stripWrappers } from "./sandbox.js";
import { Workflow } from "./orchestrator/service.js";
import { createRuntime, registerChatProviders } from "./providers/runtime.js";
import { registerWebTools, type WebToolsDeps } from "./tools/index.js";

/**
 * The only thing a ticket child process (`PI_COST_ROUTER_CHILD=1`) loads from this package: our chat providers
 * (foundry, vercel, local) and the web tools. No commands, no virtual router, no poller, no plan tools, no
 * message_end ledgering. The one hook is a `tool_call` deny on `bash` (see `childBashBlock`): the sandbox deny rules plus
 * `git push` and `gh` writes (best effort; the real controls are the child's allowlisted environment and git config, see pi-runner.ts and GitWorkspace.childGitEnv), but not the command allowlist, because a ticket must run builds and tests. The parent ledgers the child's model usage from its JSON events,
 * so recording it here too would count it twice. Only web_search is ledgered here, because the parent never sees it.
 * Budget and ledger are read from the parent's project root (PI_COST_ROUTER_ROOT), and spend lands under the parent task.
 */
/** Matches `git push` (also `git -C dir push`, `git -c k=v push`) anywhere in a command line. */
const GIT_PUSH = /(^|[;&|(\n`]|\$\()\s*(\S*\/)?git(\s+(-[cC]\s+\S+|--[\w-]+(=\S+)?|-\w+))*\s+push\b/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_NESTING = 4;
/** `gh <noun> <verb>` verbs that change something on GitHub. */
const GH_WRITE_VERBS = new Set(["create", "merge", "edit", "comment", "close", "reopen", "review", "ready", "delete", "rename", "archive", "unarchive", "fork", "sync", "run", "set", "remove", "transfer", "lock", "unlock", "pin", "unpin", "upload", "update-branch", "cancel", "rerun", "enable", "disable", "add", "import", "clone-and-push"]);
/** `gh` command groups that are never needed by a ticket child. */
const GH_BLOCKED_NOUNS = new Set(["release", "secret", "variable", "ssh-key", "gpg-key", "codespace", "extension", "alias"]);
const BLOCKED_PUSH = "Blocked: ticket children never push. Commit locally; the parent publishes after review.";
const BLOCKED_GH = "Blocked: ticket children do not change anything on GitHub. Commit locally; the parent publishes after review.";

function ghWrites(args: string[]): boolean {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-R" || arg === "--repo" || arg === "--hostname") i += 1;
    else if (!arg.startsWith("-")) words.push(arg);
  }
  const [noun, verb] = words;
  if (!noun) return false;
  if (GH_BLOCKED_NOUNS.has(noun)) return true;
  if (noun === "auth") return verb === "token" || verb === "login" || verb === "refresh" || verb === "setup-git";
  if (noun === "api") {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      const method = arg === "-X" || arg === "--method" ? args[i + 1] : arg.startsWith("--method=") ? arg.slice(9) : /^-X.+/.test(arg) ? arg.slice(2) : undefined;
      if (method !== undefined && method.toUpperCase() !== "GET") return true;
      if (/^(-f|-F|--field|--raw-field|--input)(=.*)?$/.test(arg) || /^-[fF].+/.test(arg)) return true;
    }
    return false;
  }
  return verb !== undefined && GH_WRITE_VERBS.has(verb);
}

/** A reason to refuse this child bash command, or undefined to allow it. Defense in depth: see README Limitations. */
export function childBashBlock(command: string, depth = 0): string | undefined {
  if (isDeniedCommand(command)) {
    return "Blocked: this command is destructive (recursive delete, force push, hard reset, or piping a download into a shell). Use a safer command inside the worktree.";
  }
  if (GIT_PUSH.test(command)) return BLOCKED_PUSH;
  // Command substitution or a backtick next to the word push cannot be inspected, so it is refused.
  if (/\bpush\b/.test(command) && (/\$\(|`/.test(command) || /(^|[;&|(\n])\s*\\?\$\{?\w/.test(command))) return BLOCKED_PUSH;
  if (depth >= MAX_NESTING) return /\bpush\b/.test(command) ? BLOCKED_PUSH : undefined;
  for (const segment of splitSegments(command)) {
    const tokens = stripWrappers(segment.tokens);
    const first = tokens[0];
    if (!first) continue;
    const name = baseName(first).toLowerCase();
    const args = tokens.slice(1);
    if (first.includes("$") && args.some((arg) => arg === "push")) return BLOCKED_PUSH;
    if (name === "git") {
      let i = 0;
      while (i < args.length && args[i]!.startsWith("-")) i += GIT_VALUE_FLAGS.has(args[i]!) ? 2 : 1;
      if (args[i] === "push") return BLOCKED_PUSH;
    } else if (name === "gh") {
      if (ghWrites(args)) return BLOCKED_GH;
    } else if (SHELLS.has(name)) {
      const at = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
      const script = at >= 0 ? args[at + 1] : undefined;
      if (script !== undefined) {
        const nested = childBashBlock(script, depth + 1);
        if (nested) return nested;
      } else if (segment.piped && /\bpush\b/.test(command)) return BLOCKED_PUSH;
    } else if (name === "eval") {
      const nested = childBashBlock(args.join(" "), depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function registerChildMode(pi: Pick<ExtensionAPI, "registerProvider" | "registerTool" | "on">, env: NodeJS.ProcessEnv = process.env, overrides: Partial<WebToolsDeps> = {}): void {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const reason = childBashBlock(event.input.command);
    return reason ? { block: true, reason } : undefined;
  });
  const root = env[CHILD_ROOT_ENV] || process.cwd();
  const taskId = env[CHILD_TASK_ENV] || undefined;
  const config = loadConfig(root);
  const runtime = createRuntime(config, root);
  try {
    registerChatProviders(pi as ExtensionAPI, config, { vercel: runtime.vercel });
  } catch {
    /* the model lookup fails visibly if a provider is missing */
  }
  const workflow = new Workflow({ cwd: root, config, auth: runtime.auth });
  registerWebTools(pi, {
    budgetCheck: () => {
      if (workflow.checkBudget(taskId) === "hard") {
        throw new Error("Task or daily budget is exhausted. web_search was not called.");
      }
    },
    onUsage: (record) => {
      workflow.recordWebSearch({ ...record, taskId });
    },
    ...overrides,
  });
}
