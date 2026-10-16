import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseConfig, type WorkflowConfig } from "../src/config.js";
import type { ProviderAuthView } from "../src/providers/auth.js";
import type { ProviderId, Ticket, TokenUsage } from "../src/domain.js";
import type { WorkflowContext } from "../src/orchestrator/context.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import { runBuild, type BuildDriver } from "../src/orchestrator/build.js";
import { Workflow, type WorkflowOptions } from "../src/orchestrator/service.js";
import type { CheckRunner } from "../src/review/review.js";

export function checkRunner(run: CheckRunner["run"]): CheckRunner {
  return { run };
}

const exec = promisify(execFile);

export async function tempRepo(): Promise<string> {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-conductor-"));
  writeFileSync(path.join(cwd, ".gitignore"), ".pi-workflows/tasks/\n.pi-workflows/cost/\n.pi-workflows/metrics/\n.pi-workflows/reports/\n.pi-workflows/active-task.json\n.pi-workflows/notifications.jsonl\n");
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
models: { cheap: foundry, standard: anthropic, premium: openai }
routing: { maxEscalations: 2, maxTier: premium, requirePremiumReviewFor: [auth, permissions, secrets, security-sensitive], circuitBreakerFailures: 3 }
workers: { tokenBudget: 8000 }
budgets: { taskUsd: 20, dailyUsd: 75, softWarningRatio: 0.8 }
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

export const singleTaskRequest = `
Maintain Neo.
\`\`\`tasks
[{"id":"ingest","summary":"Guard ingest","files":["src/ingest.ts"],"edits":[{"path":"src/ingest.ts","content":"export const ingest = 1;\\n"}]}]
\`\`\`
`;

/** A build driver whose "session" writes `src/ingest.ts` into the checkout, like a model finishing a ticket. */
export function writingDriver(cwd: string, files: Record<string, string> = { "src/ingest.ts": "export const ingest = 1;\n" }): BuildDriver {
  return {
    async fresh(_model, run) {
      await run({
        async send() {
          for (const [name, body] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
            writeFileSync(path.join(cwd, name), body);
          }
          return { lastText: "Done.\n- [x] retry works\nFiles changed: src/ingest.ts", aborted: false };
        },
      });
    },
    async finish() {},
  };
}

/** Drives a one-ticket task through plan, approve, and build: IMPLEMENTING with every ticket done. */
export async function builtWorkflow(extras: Partial<WorkflowOptions> = {}) {
  const cwd = await tempRepo();
  const { app } = await ticketWorkflow([sampleTicket("01")], { config: testConfig(), ...extras }, { cwd });
  const built = await runBuild(() => app, writingDriver(cwd));
  if (!built.ok) throw new Error(`build failed in fixture: ${built.text}`);
  return { cwd, app };
}

/** A config that uses the multi-candidate `tiers` map (see .pi-workflows/config.yaml). Prices are test values. */
export function tieredYaml(extraYaml = ""): string {
  return `
providers:
  openai: { type: openai, auth: account-login }
  anthropic: { type: anthropic, auth: account-login }
  xai: { type: xai, auth: account-login }
  foundry: { type: azure-foundry, auth: azure-cli, endpoint: "https://res.services.ai.azure.com", routeStyle: v1, audience: "https://ai.azure.com" }
  vercel: { type: vercel-ai-gateway, auth: vercel-cli, projectDir: ".", envFile: .env.local }
  local: { type: openai-compatible, baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b" }
tiers:
  deterministic:
    - { provider: local, model: "qwen2.5-coder:7b" }
  cheap:
    - { provider: openai, model: gpt-6-luna }
    - { provider: anthropic, model: claude-haiku-5-5 }
  standard:
    - { provider: anthropic, model: claude-sonnet-5-5 }
    - { provider: foundry, model: grok-4-7 }
  premium:
    - { provider: anthropic, model: claude-opus-5-5 }
    - { provider: openai, model: "gpt-6.1-sol" }
  ticketLow:
    - { provider: xai, model: grok-4.7 }
  ticketMedium:
    - { provider: anthropic, model: claude-sonnet-5-5 }
  ticketHigh:
    - { provider: openai, model: "gpt-6.1-sol" }
  advisor:
    - { provider: anthropic, model: claude-fable-5-1 }
    - { provider: foundry, model: gpt-6-astra }
workers: { tokenBudget: 8000 }
checks:
  - { name: unit, command: npm, args: ["test"] }
pricing:
  - { provider: local, model: "qwen2.5-coder:7b", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: openai, model: gpt-6-luna, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: anthropic, model: claude-haiku-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  - { provider: anthropic, model: claude-sonnet-5-5, effectiveFrom: "2026-01-01", inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
  - { provider: xai, model: grok-4.7, effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
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

export function sampleTicket(id: string, extra: Partial<Ticket> = {}): Ticket {
  return { id, slug: `t${id}`, title: `Ticket ${id}`, whatToBuild: `Build part ${id}.`, acceptanceCriteria: ["retry works"], blockedBy: [], estimatedContextTokens: 40_000, ...extra };
}

export const sampleSpec = { summary: "Retry failed ingests.", context: "src/ingest.ts parses and drops failures.", approach: "Wrap parse() in retryParse() with a fixed backoff.", changes: [{ path: "src/ingest.ts", change: "add retryParse(input, attempts)" }], reuse: ["sleep() in src/util.ts"], verification: ["npm test"], decisions: [{ question: "Backoff?", answer: "Fixed", rationale: "simple" }], assumptions: [], outOfScope: [], risks: [] };

/** A workflow in a fresh repo with a ticket plan saved through the /plan tools and, unless `approve` is false, approved. */
export async function ticketWorkflow(tickets: Ticket[], extras: Partial<WorkflowOptions> = {}, options: { approve?: boolean; cwd?: string } = {}) {
  const cwd = options.cwd ?? (await tempRepo());
  const app = workflow(cwd, { config: tieredConfig(), rng: () => 0.5, startTurn: () => undefined, ...extras });
  if (!(await app.startPlan("Add retry to the Neo ingest parser")).ok) throw new Error("startPlan failed in fixture");
  await app.savePlanSpec(sampleSpec);
  await app.commitTickets(tickets);
  if (options.approve !== false && !(await app.approveDraft()).ok) throw new Error("approveDraft failed in fixture");
  return { cwd, app, taskId: app.activeTaskId()! };
}

/** The context a Workflow holds, for tests of the modules that take one. */
export function contextOf(app: Workflow): WorkflowContext {
  return (app as unknown as { ctx: WorkflowContext }).ctx;
}

/** The sample advisor tier of the real config (Astra on OpenAI, then Fable), priced: Astra at $0 (ChatGPT), Fable per token. */
export function withAdvisors(config: WorkflowConfig): WorkflowConfig {
  config.tiers.advisor = [
    { provider: "openai", model: "gpt-6-astra" },
    { provider: "anthropic", model: "claude-fable-5-1" },
    { provider: "foundry", model: "gpt-6-astra" },
  ];
  config.pricing.push({ provider: "openai", model: "gpt-6-astra", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
  return config;
}

export interface FakeCall {
  provider: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** A chat client that records every call and answers from `answer`; a thrown error is the call failing. */
export function fakeChat(answer: (call: FakeCall) => string | { text: string; usage?: Partial<TokenUsage> } | Promise<string | { text: string; usage?: Partial<TokenUsage> }>) {
  const calls: FakeCall[] = [];
  const chat: ChatFn = async (candidate, request) => {
    const call: FakeCall = {
      provider: candidate.provider,
      model: candidate.model,
      system: request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"),
      user: request.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n"),
      maxTokens: request.maxTokens,
      signal: request.signal,
    };
    calls.push(call);
    const reply = await answer(call);
    const text = typeof reply === "string" ? reply : reply.text;
    const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, requests: 1, ...(typeof reply === "string" ? {} : reply.usage) };
    return { text, usage, provider: candidate.provider, model: candidate.model };
  };
  return { chat, calls };
}
