import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseConfig, type WorkflowConfig } from "../src/config.js";
import type { ProviderAuthView } from "../src/providers/auth.js";
import type { ProviderId } from "../src/domain.js";
import { Workflow, type WorkflowOptions } from "../src/orchestrator/service.js";
import type { CheckRunner } from "../src/review/review.js";
import type { GitHubClient, PullRequestSnapshot } from "../src/github/types.js";

export function checkRunner(run: CheckRunner["run"]): CheckRunner {
  return { run };
}

const exec = promisify(execFile);

export async function tempRepo(): Promise<string> {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-cost-"));
  writeFileSync(path.join(cwd, ".gitignore"), ".pi-workflows/worktrees/\n.pi-workflows/tasks/\n");
  writeFileSync(path.join(cwd, "README.md"), "base\n");
  await exec("git", ["init"], { cwd });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd });
  await exec("git", ["config", "user.name", "test"], { cwd });
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["commit", "-m", "base"], { cwd });
  return cwd;
}

export function testConfig(): WorkflowConfig {
  return parseConfig(`
providers:
  openai: { type: openai, auth: account-login, model: gpt-5.4 }
  anthropic: { type: anthropic, auth: account-login, model: claude-sonnet }
  foundry:
    type: azure-foundry
    auth: azure-cli
    endpointEnv: AZURE_AI_ENDPOINT
    deployments: { classifier: classifier, reasoning: reasoning, cheap: classifier }
  local: { type: openai-compatible, baseUrl: http://127.0.0.1:11434/v1, model: local-coder }
models: { classifier: local, cheap: foundry, standard: anthropic, premium: openai }
routing: { minConfidence: 0.75, maxEscalations: 2, maxTier: premium, requirePremiumReviewFor: [auth, permissions, secrets, security-sensitive], circuitBreakerFailures: 3 }
workers: { concurrency: 2, isolatedWorktrees: true, preserveUntilReviewed: true, tokenBudget: 8000, deadlineMs: 60000 }
budgets: { taskUsd: 20, autopilotPrUsd: 10, dailyUsd: 75, softWarningRatio: 0.8 }
checks:
  - name: unit
    command: npm
    args: ["test"]
pricing:
  - { provider: foundry, model: classifier, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 }
  - { provider: anthropic, model: claude-sonnet, effectiveFrom: "2026-01-01", inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
  - { provider: openai, model: gpt-5.4, effectiveFrom: "2026-01-01", inputPerMillionUsd: 2.5, outputPerMillionUsd: 15 }
`);
}

export function readyAuth(status: ProviderAuthView["status"] = "ready"): WorkflowOptions["auth"] {
  return {
    async inspect(provider: ProviderId): Promise<ProviderAuthView> {
      return { provider, status, method: provider === "foundry" ? "azure-cli" : provider === "local" ? "local" : "oauth", detail: status };
    },
  };
}

export function workflow(cwd: string, extras: Partial<WorkflowOptions> = {}): Workflow {
  return new Workflow({
    cwd,
    config: testConfig(),
    auth: readyAuth(),
    now: () => new Date("2026-10-14T12:00:00.000Z"),
    confirm: async () => true,
    runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })),
    push: async () => undefined,
    session: { async reset() { return { mode: "new-session", cancelled: false }; } },
    ...extras,
  });
}

export const tasksRequest = `
Maintain Neo.
AC: ingest rejects empty events
\`\`\`tasks
[
  {"id":"ingest","summary":"Guard ingest","files":["src/ingest.ts"],"edits":[{"path":"src/ingest.ts","content":"export function ingest(value: string) {\\n  if (!value) throw new Error(\\"empty\\");\\n  return value;\\n}\\n"}]},
  {"id":"alert","summary":"Route alerts","files":["src/alert.ts"],"edits":[{"path":"src/alert.ts","content":"export function alert(kind: string) {\\n  return kind;\\n}\\n"}]}
]
\`\`\`
`;

export class MemoryGitHub implements GitHubClient {
  replies: { threadId: string; body: string }[] = [];
  merged = false;
  constructor(public pr: PullRequestSnapshot) {}
  async findByBranch(): Promise<PullRequestSnapshot | undefined> {
    return this.pr;
  }
  async upsert(input: { branch: string; base: string; title: string; body: string }): Promise<PullRequestSnapshot> {
    this.pr = { ...this.pr, branch: input.branch, base: input.base, url: "https://example.test/pull/7", number: 7 };
    return this.pr;
  }
  async reply(threadId: string, body: string): Promise<void> {
    this.replies.push({ threadId, body });
  }
  async fileAt(): Promise<string> {
    return "export {}\n";
  }
  async checkLog(): Promise<string> {
    return "AssertionError: expected 1";
  }
  async isAncestor(): Promise<boolean> {
    return true;
  }
}
