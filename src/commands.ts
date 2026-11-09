import { agentTable, AGENT_PREFIX } from "./agents.js";
import type { CommandResult } from "./domain.js";
import { runBuild, type BuildDriver } from "./orchestrator/build.js";
import type { Workflow } from "./orchestrator/service.js";

export interface CommandSpec {
  name: string;
  /** Runs the command against a workflow. `confirm` asks the person (always false without a UI). A command with `drive` has none. */
  run?: (workflow: Workflow, args: string, confirm: (title: string, message: string) => Promise<boolean>) => Promise<CommandResult>;
  /** For /build, which opens a herdr tab per ticket: the host passes the live workflow getter and a ticket driver. */
  drive?: (getWorkflow: () => Workflow, driver: BuildDriver) => Promise<CommandResult>;
  description: string;
  /** Completions for the text typed so far. The live workflow is passed when there is one, for commands that complete task names. */
  complete: (prefix: string, workflow?: Workflow) => { label: string; value: string }[];
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "plan", run: (w, args) => {
      const flag = (name: string) => new RegExp(`(^|\\s)--${name}(\\s|$)`).test(args);
      const noQuestions = flag("no-questions");
      const request = args.replace(/(^|\s)--no-questions(?=\s|$)/g, " ").trim();
      return w.startPlan(request, { noQuestions });
    },
    description: "Plan a task: a short interview of decisions (3-7 questions with recommendations), a spec, then tickets for approval. --no-questions skips the interview. Does not edit the repo.",
    complete: (prefix) => completeWords(prefix, ["--no-questions"]),
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
    name: "build",
    drive: (getWorkflow, driver) => runBuild(getWorkflow, driver),
    description: "Build the approved plan one ticket at a time, each in its own herdr tab on one branch: routed model per ticket, checks, a commit each. Run again to resume.",
    complete: () => [],
  },
  {
    name: "review", run: (w, args) => w.review(args),
    description: "Review the changes against the base branch (checks, static scan, advisory model pass), then fix the findings in this session. /review --with <model> reviews with another Pi model (provider/id) or agent (agent:<name>[/model]) for this run. Never commits or pushes.",
    complete: (prefix, workflow) => {
      const words = prefix.split(/\s+/);
      const token = words.at(-1) ?? "";
      if (words.length <= 1) return "--with".startsWith(token) ? [{ label: "--with", value: "--with" }] : [];
      if (words.length !== 2 || words[0] !== "--with") return [];
      const models = workflow ? Object.values(workflow.config.models) : [];
      const agents = Object.keys(agentTable(workflow?.config ?? {})).map((name) => `${AGENT_PREFIX}${name}`);
      return [...new Set([...models, ...agents])].filter((value) => value.startsWith(token)).map((value) => ({ label: value, value }));
    },
  },
  { name: "cost", run: (w, args) => w.cost(args), description: "Show spend by model, job and task against budgets. /cost json or /cost csv writes the ledger to a file under .pi-workflows/reports/.", complete: (prefix) => completeWords(prefix, ["json", "csv"]) },
];

function completeWords(prefix: string, words: string[]): { label: string; value: string }[] {
  const token = prefix.trim().split(/\s+/).at(-1) ?? "";
  return words.filter((word) => word.startsWith(token)).map((value) => ({ label: value, value }));
}
