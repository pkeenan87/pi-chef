export interface CommandSpec {
  name: string;
  description: string;
  complete: (prefix: string) => { label: string; value: string }[];
}

const PROVIDER_VALUES = ["openai", "anthropic", "foundry", "local"];

export const COMMANDS: CommandSpec[] = [
  { name: "plan", description: "Draft a scoped plan, risks, tests, cost, and acceptance criteria. Does not edit the repo.", complete: () => [] },
  { name: "approve-plan", description: "Freeze the current draft as an immutable plan version.", complete: () => [] },
  { name: "implement", description: "Run an approved plan in isolated worktrees. Refuses a draft.", complete: () => [] },
  { name: "review", description: "Review each worktree and the integrated diff in a fresh context.", complete: () => [] },
  { name: "push", description: "After checks and approval, push the integration branch and open or update one PR.", complete: () => [] },
  {
    name: "autopilot",
    description: "Watch the PR locally: bounded verified fixes, no auto-merge. Subcommands: stop, status.",
    complete: (prefix) => completeWords(prefix, ["stop", "status"]),
  },
  { name: "route", description: "Preview provider, tier, and cost for a task without changing state.", complete: () => [] },
  { name: "cost", description: "Show spend by phase, provider, model, and task against budgets.", complete: (prefix) => completeWords(prefix, ["json", "csv"]) },
  { name: "status", description: "Show phase, approvals, auth, worktrees, and budget.", complete: () => [] },
  { name: "reset-phase", description: "Compact or open a fresh session while keeping durable task files.", complete: () => [] },
  {
    name: "worktrees",
    description: "List worktrees or clean up merged and abandoned ones. Cleanup asks before deleting unmerged work.",
    complete: (prefix) => completeWords(prefix, ["status", "list", "cleanup"]),
  },
  {
    name: "auth",
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
