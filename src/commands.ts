import type { CommandResult } from "./domain.js";
import type { Workflow } from "./orchestrator/service.js";

export interface CommandSpec {
  name: string;
  /** Runs the command against a workflow. `confirm` asks the person (always false without a UI). */
  run: (workflow: Workflow, args: string, confirm: (title: string, message: string) => Promise<boolean>) => Promise<CommandResult>;
  description: string;
  complete: (prefix: string) => { label: string; value: string }[];
}

const PROVIDER_VALUES = ["openai", "anthropic", "xai", "foundry", "vercel", "local"];

export const COMMANDS: CommandSpec[] = [
  {
    name: "plan", run: (w, args) => {
      const noQuestions = /(^|\s)--no-questions(\s|$)/.test(args);
      return w.startPlan(args.replace(/(^|\s)--no-questions(?=\s|$)/g, " ").trim(), { noQuestions });
    },
    description: "Plan a task: a short interview of decisions (3-7 questions with recommendations), a spec, then tickets for approval. --no-questions skips the interview. Does not edit the repo.",
    complete: (prefix) => completeWords(prefix, ["--no-questions"]),
  },
  { name: "show-plan", run: (w) => w.showPlan(), description: "Show the active task's full plan (technical spec and tickets).", complete: () => [] },
  { name: "implement", run: (w) => w.implement(), description: "Run an approved plan in isolated worktrees. Refuses a draft.", complete: () => [] },
  { name: "review", run: (w) => w.review(), description: "Review each worktree and the integrated diff in a fresh context.", complete: () => [] },
  { name: "push", run: (w) => w.push(), description: "After checks and approval, push the integration branch and open or update one PR.", complete: () => [] },
  {
    name: "autopilot", run: (w, args) => w.autopilot(args),
    description: "Watch the PR locally: bounded verified fixes, no auto-merge. Subcommands: stop, status.",
    complete: (prefix) => completeWords(prefix, ["stop", "status"]),
  },
  { name: "complete", run: (w) => w.complete(), description: "Mark the published task complete (after its PR is merged) so a new task can start.", complete: () => [] },
  { name: "route", run: (w, args) => w.route(args), description: "Preview provider, tier, and cost for a task without changing state.", complete: () => [] },
  { name: "advisor", run: (w, args) => w.advisor(args), description: "Ask the advisor tier (Claude Fable or GPT Astra) one question about the active task. Costs money, runs only when you ask, never changes the phase.", complete: () => [] },
  { name: "cost", run: (w, args) => w.cost(args), description: "Show spend by phase, provider, model, and task against budgets.", complete: (prefix) => completeWords(prefix, ["json", "csv"]) },
  { name: "status", run: (w) => w.status(), description: "Show phase, approvals, auth, worktrees, and budget.", complete: () => [] },
  { name: "reset-phase", run: (w) => w.resetPhase(), description: "Compact or open a fresh session while keeping durable task files.", complete: () => [] },
  {
    name: "worktrees", run: async (w, args, confirm) => {
      const confirmed = args.includes("confirm") ? await confirm("Clean worktrees", "Delete unmerged worktrees that are not part of an active PR?") : false;
      return w.worktrees(args.replace(/\s*confirm\s*/g, " ").trim(), confirmed);
    },
    description: "List worktrees or clean up merged and abandoned ones. Cleanup asks before deleting unmerged work.",
    complete: (prefix) => completeWords(prefix, ["status", "list", "cleanup"]),
  },
  {
    name: "auth", run: (w, args) => w.auth(args),
    description: "Show account-login status, or explain /login for a provider. API keys are not accepted.",
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
