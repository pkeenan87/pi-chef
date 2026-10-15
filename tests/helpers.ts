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

export const singleTaskRequest = `
Maintain Neo.
\`\`\`tasks
[{"id":"ingest","summary":"Guard ingest","files":["src/ingest.ts"],"edits":[{"path":"src/ingest.ts","content":"export const ingest = 1;\\n"}]}]
\`\`\`
`;

export function emptyPr(): PullRequestSnapshot {
  return { number: 0, url: "", branch: "", base: "main", headSha: "pending", baseSha: "base", mergeable: true, approved: false, protectionSatisfied: false, threads: [], checks: [] };
}

/** A fake timer: records every schedule() call and lets a test fire or inspect the pending callback. */
export function fakeTimer() {
  const state = { delays: [] as number[], cancelled: 0, pending: undefined as (() => void) | undefined };
  const schedule = (delayMs: number, run: () => void) => {
    state.delays.push(delayMs);
    state.pending = run;
    return () => {
      state.cancelled += 1;
      if (state.pending === run) state.pending = undefined;
    };
  };
  return { state, schedule };
}

/** Drives a one-group task through plan, approve, implement, review, and push. */
export async function publishedWorkflow(extras: Partial<WorkflowOptions> = {}, github: MemoryGitHub = new MemoryGitHub(emptyPr())) {
  const cwd = await tempRepo();
  const app = workflow(cwd, { github, ...extras });
  await app.plan(singleTaskRequest);
  await app.approvePlan();
  if (!(await app.implement()).ok) throw new Error("implement failed in fixture");
  if (!(await app.review()).ok) throw new Error("review failed in fixture");
  const pushed = await app.push();
  if (!pushed.ok) throw new Error(`push failed in fixture: ${pushed.text}`);
  return { cwd, app, github };
}

/** A config that uses the multi-candidate `tiers` map (see .pi-workflows/config.yaml). Prices are test values. */
export function tieredYaml(extraYaml = ""): string {
  return `
providers:
  openai: { type: openai, auth: account-login }
  anthropic: { type: anthropic, auth: account-login }
  foundry: { type: azure-foundry, auth: azure-cli, endpoint: "https://res.services.ai.azure.com", routeStyle: v1, audience: "https://ai.azure.com" }
  vercel: { type: vercel-ai-gateway, auth: vercel-cli, projectDir: ".", envFile: .env.local }
  local: { type: openai-compatible, baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b" }
tiers:
  deterministic:
    - { provider: local, model: "qwen2.5-coder:7b" }
  classifier:
    - { provider: foundry, model: Microsoft-Decision-1, api: decisions }
    - { provider: vercel, model: "typesafe-ai/jev", api: decisions }
  cheap:
    - { provider: openai, model: gpt-6-luna }
    - { provider: anthropic, model: claude-haiku-5-5 }
  standard:
    - { provider: anthropic, model: claude-sonnet-5-5 }
    - { provider: foundry, model: grok-4-7 }
  premium:
    - { provider: anthropic, model: claude-opus-5-5 }
    - { provider: openai, model: "gpt-6.1-sol" }
  advisor:
    - { provider: anthropic, model: claude-fable-5-1 }
    - { provider: foundry, model: gpt-6-astra }
workers: { concurrency: 2, isolatedWorktrees: true, preserveUntilReviewed: true, tokenBudget: 8000, deadlineMs: 60000 }
checks:
  - { name: unit, command: npm, args: ["test"] }
pricing:
  - { provider: local, model: "qwen2.5-coder:7b", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: foundry, model: Microsoft-Decision-1, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.1 }
  - { provider: vercel, model: "typesafe-ai/jev", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.1 }
  - { provider: openai, model: gpt-6-luna, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: anthropic, model: claude-haiku-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: anthropic, model: claude-sonnet-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
  - { provider: foundry, model: grok-4-7, effectiveFrom: "2026-01-01", inputPerMillionUsd: 1, outputPerMillionUsd: 4 }
  - { provider: anthropic, model: claude-opus-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 15, outputPerMillionUsd: 75 }
  - { provider: openai, model: "gpt-6.1-sol", effectiveFrom: "2026-01-01", inputPerMillionUsd: 10, outputPerMillionUsd: 50 }
  - { provider: anthropic, model: claude-fable-5-1, effectiveFrom: "2026-01-01", inputPerMillionUsd: 20, outputPerMillionUsd: 100 }
  - { provider: foundry, model: gpt-6-astra, effectiveFrom: "2026-01-01", inputPerMillionUsd: 5, outputPerMillionUsd: 25 }
${extraYaml}`;
}

export function tieredConfig(extraYaml = ""): WorkflowConfig {
  return parseConfig(tieredYaml(extraYaml));
}

/** Small seeded generator (mulberry32) so Thompson sampling is reproducible in tests. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function unsignedJwt(expSeconds: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: expSeconds })}.sig`;
}

/** A Pi registry fake in which every model asked for exists and has credentials. */
export function permissiveRegistry() {
  const seen: { provider: string; id: string }[] = [];
  return {
    find: (provider: string, id: string) => {
      const model = { provider, id };
      seen.push(model);
      return model;
    },
    isUsingOAuth: () => true,
    getAvailable: () => seen,
  };
}
