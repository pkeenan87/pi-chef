import type { CommandResult } from "./domain.js";
import { fail } from "./orchestrator/context.js";
import { runBuild, type BuildDriver } from "./orchestrator/build.js";
import type { Workflow } from "./orchestrator/service.js";

export interface CommandSpec {
  name: string;
  /** Runs the command against a workflow. `confirm` asks the person (always false without a UI). */
  run: (workflow: Workflow, args: string, confirm: (title: string, message: string) => Promise<boolean>) => Promise<CommandResult>;
  /** For commands that open Pi sessions: the host passes the live workflow getter and a session driver, and `run` is not used. */
  drive?: (getWorkflow: () => Workflow, driver: BuildDriver) => Promise<CommandResult>;
  description: string;
  /** Completions for the text typed so far. The live workflow is passed when there is one, for commands that complete task names. */
  complete: (prefix: string, workflow?: Workflow) => { label: string; value: string }[];
}

const PROVIDER_VALUES = ["openai", "anthropic", "xai", "foundry", "vercel", "local"];

export const COMMANDS: CommandSpec[] = [
  {
    name: "plan", run: (w, args) => {
      const flag = (name: string) => new RegExp(`(^|\\s)--${name}(\\s|$)`).test(args);
      const noQuestions = flag("no-questions");
      // --local writes the tickets for the local model and builds them there; --cloud overrides localMode.default.
      const local = flag("local") ? true : flag("cloud") ? false : undefined;
      if (local === true && flag("cloud")) return Promise.resolve({ ok: false, code: "USAGE", text: "Use --local or --cloud, not both." });
      const request = args.replace(/(^|\s)--(no-questions|local|cloud)(?=\s|$)/g, " ").trim();
      return w.startPlan(request, { noQuestions, ...(local !== undefined ? { local } : {}) });
    },
    description: "Plan a task: a short interview of decisions (3-7 questions with recommendations), a spec, then tickets for approval. --no-questions skips the interview. --local writes the tickets for the local model (tiers.local), sized from its tag (9b, 27b), and /build runs them there only; --cloud overrides localMode.default. Does not edit the repo.",
    complete: (prefix) => completeWords(prefix, ["--no-questions", "--local", "--cloud"]),
  },
  { name: "show-plan", run: (w) => w.showPlan(), description: "Show the active task's full plan (technical spec and tickets), under its name and state.", complete: () => [] },
  {
    name: "plans", run: (w, args) => w.plans(args),
    description: "List your tasks (/plans --all adds closed ones), switch to one with /plans <name> (checks out its branch when the tree is clean and shows its plan), or close one with /plans close <name>. /plan always starts a new task and parks an unfinished one.",
    complete: (prefix, workflow) => {
      const words = prefix.split(/\s+/);
      const token = words.at(-1) ?? "";
      const names = (all: boolean) => workflow?.taskNames(all) ?? [];
      const pool = words[0] === "close" && words.length > 1 ? names(false) : words.length > 1 ? [] : ["close", "--all", ...names(false)];
      return [...new Set(pool)].filter((word) => word.startsWith(token)).map((value) => ({ label: value, value }));
    },
  },
  {
    name: "build", run: async () => fail("NO_SESSION", "/build needs a Pi session to open a fresh session per ticket."),
    drive: (getWorkflow, driver) => runBuild(getWorkflow, driver),
    description: "Build the approved plan one ticket at a time in fresh sessions on one branch: routed model per ticket, checks, a commit each. Run again to resume.",
    complete: () => [],
  },
  { name: "review", run: (w) => w.review(), description: "Review the changes against the base branch (checks, static scan, advisory model pass), then fix the findings in this session. Never commits or pushes.", complete: () => [] },
  { name: "advisor", run: (w, args) => w.advisor(args), description: "Ask the advisor tier one question about the active task (request, plan, tickets, diff stat). Costs money, runs only when you ask, never changes the phase.", complete: () => [] },
  { name: "cost", run: (w, args) => w.cost(args), description: "Show spend by model, job and task against budgets. /cost json or /cost csv writes the ledger to a file under .pi-workflows/reports/.", complete: (prefix) => completeWords(prefix, ["json", "csv"]) },
  {
    name: "status", run: (w, args) => w.status(args),
    description: "Show the task's state and next step, then tables for the plan, branch, review, budget, tickets, routing (each tier with the jobs it serves and what would run), and logins. /status <ticket> shows one ticket's attempts and reviews. /status foundry also tabulates your Foundry deployments (runs az) and flags tier entries that have none.",
    complete: (prefix) => completeWords(prefix, ["foundry"]),
  },
  {
    name: "auth", run: (w, args) => w.auth(args),
    description: "Show the Logins table (/auth or /auth status), or explain how to sign in to a provider (/auth login <provider>). API keys are not accepted.",
    complete: (prefix) => {
      const [first, second] = prefix.split(/\s+/, 2);
      if (!first || ("status".startsWith(first) && !prefix.includes(" ")) || ("login".startsWith(first) && !prefix.includes(" "))) {
        return completeWords(prefix, ["status", "login"]);
      }
      if (first === "login") return (second ? PROVIDER_VALUES.filter((item) => item.startsWith(second)) : PROVIDER_VALUES).map((value) => ({ label: value, value }));
      return [];
    },
  },
];

function completeWords(prefix: string, words: string[]): { label: string; value: string }[] {
  const token = prefix.trim().split(/\s+/).at(-1) ?? "";
  return words.filter((word) => word.startsWith(token)).map((value) => ({ label: value, value }));
}

export function helpText(): string {
  return COMMANDS.map((command) => `/${command.name} — ${command.description}`).join("\n");
}
