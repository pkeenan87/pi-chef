import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { containsSecret } from "./redact.js";
import { WorkflowError, type ProviderId, type Tier } from "./domain.js";

export interface ProviderConfig {
  type: string;
  auth: string;
  piProvider?: string;
  endpointEnv?: string;
  apiVersion?: string;
  audience?: string;
  api?: "openai-responses" | "openai-completions" | "azure-openai-responses";
  deployments?: { classifier?: string; reasoning?: string; cheap?: string };
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
}

export interface PricingRow {
  provider: string;
  model: string;
  effectiveFrom: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
}

export interface CheckConfig {
  name: string;
  command: string;
  args: string[];
}

export interface WorkflowConfig {
  schemaVersion: 1;
  workspaceDir: string;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
  models: Record<"classifier" | "cheap" | "standard" | "premium", ProviderId>;
  routing: {
    minConfidence: number;
    maxEscalations: number;
    maxTier: Tier;
    requirePremiumReviewFor: string[];
    circuitBreakerFailures: number;
  };
  workers: {
    concurrency: number;
    isolatedWorktrees: boolean;
    preserveUntilReviewed: boolean;
    tokenBudget: number;
    deadlineMs: number;
  };
  worktrees: {
    strategy: "per-independent-task";
    integrationBranch: boolean;
    cleanupRequiresConfirmation: boolean;
    branchPrefix: string;
  };
  budgets: { taskUsd: number; autopilotPrUsd: number; dailyUsd: number; softWarningRatio: number };
  approvals: {
    plan: "required";
    publish: "required" | "auto";
    merge: "manual";
    securitySensitiveFix: "required";
  };
  autopilot: {
    pollSeconds: number;
    maxFixCycles: number;
    autoMerge: false;
    maxRuntimeMs: number;
    backoffSeconds: number;
  };
  checks: CheckConfig[];
  commandAllowlist: string[];
  orgProviderAllowlist: ProviderId[];
  proprietaryCode: boolean;
  pricing: PricingRow[];
}

const DEFAULTS: WorkflowConfig = {
  schemaVersion: 1,
  workspaceDir: ".pi-workflows",
  providers: {},
  models: { classifier: "local", cheap: "foundry", standard: "anthropic", premium: "openai" },
  routing: {
    minConfidence: 0.75,
    maxEscalations: 2,
    maxTier: "premium",
    requirePremiumReviewFor: ["auth", "permissions", "secrets", "security-sensitive"],
    circuitBreakerFailures: 3,
  },
  workers: {
    concurrency: 2,
    isolatedWorktrees: true,
    preserveUntilReviewed: true,
    tokenBudget: 8000,
    deadlineMs: 600000,
  },
  worktrees: {
    strategy: "per-independent-task",
    integrationBranch: true,
    cleanupRequiresConfirmation: true,
    branchPrefix: "cost",
  },
  budgets: { taskUsd: 20, autopilotPrUsd: 10, dailyUsd: 75, softWarningRatio: 0.8 },
  approvals: { plan: "required", publish: "required", merge: "manual", securitySensitiveFix: "required" },
  autopilot: { pollSeconds: 90, maxFixCycles: 5, autoMerge: false, maxRuntimeMs: 7_200_000, backoffSeconds: 30 },
  checks: [],
  commandAllowlist: ["npm test", "npm run typecheck", "npm run lint", "npx vitest", "git status", "git diff"],
  orgProviderAllowlist: [],
  proprietaryCode: false,
  pricing: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertNoSecrets(value: unknown, where: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (containsSecret(text)) {
    throw new WorkflowError("CONFIG_SECRET", `${where} contains a secret. Keep credentials out of YAML.`);
  }
}

function mergeConfig(raw: unknown, where: string): WorkflowConfig {
  if (!isRecord(raw)) throw new WorkflowError("CONFIG_INVALID", `${where} must be a mapping`);
  assertNoSecrets(raw, where);
  const providers = isRecord(raw.providers) ? (raw.providers as WorkflowConfig["providers"]) : {};
  for (const [name, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue;
    if (typeof provider.apiKey === "string" || typeof provider.key === "string" || typeof provider.token === "string") {
      throw new WorkflowError("CONFIG_SECRET", `Provider ${name} must not carry apiKey, key, or token fields.`);
    }
    if (name === "openai" && provider.auth && provider.auth !== "account-login") {
      throw new WorkflowError("CONFIG_INVALID", "OpenAI auth must be account-login.");
    }
    if (name === "anthropic" && provider.auth && provider.auth !== "account-login") {
      throw new WorkflowError("CONFIG_INVALID", "Anthropic auth must be account-login.");
    }
    if (name === "foundry" && provider.auth && provider.auth !== "azure-cli") {
      throw new WorkflowError("CONFIG_INVALID", "Foundry auth must be azure-cli.");
    }
  }
  if (raw.autopilot && isRecord(raw.autopilot) && raw.autopilot.autoMerge === true) {
    throw new WorkflowError("CONFIG_INVALID", "autopilot.autoMerge cannot be true.");
  }
  if (raw.approvals && isRecord(raw.approvals) && raw.approvals.merge && raw.approvals.merge !== "manual") {
    throw new WorkflowError("CONFIG_INVALID", "approvals.merge must stay manual.");
  }
  return {
    ...DEFAULTS,
    ...raw,
    providers: { ...DEFAULTS.providers, ...providers },
    models: { ...DEFAULTS.models, ...(isRecord(raw.models) ? raw.models : {}) } as WorkflowConfig["models"],
    routing: { ...DEFAULTS.routing, ...(isRecord(raw.routing) ? raw.routing : {}) } as WorkflowConfig["routing"],
    workers: { ...DEFAULTS.workers, ...(isRecord(raw.workers) ? raw.workers : {}) } as WorkflowConfig["workers"],
    worktrees: { ...DEFAULTS.worktrees, ...(isRecord(raw.worktrees) ? raw.worktrees : {}) } as WorkflowConfig["worktrees"],
    budgets: { ...DEFAULTS.budgets, ...(isRecord(raw.budgets) ? raw.budgets : {}) } as WorkflowConfig["budgets"],
    approvals: {
      ...DEFAULTS.approvals,
      ...(isRecord(raw.approvals) ? raw.approvals : {}),
      plan: "required",
      merge: "manual",
      securitySensitiveFix: "required",
    } as WorkflowConfig["approvals"],
    autopilot: {
      ...DEFAULTS.autopilot,
      ...(isRecord(raw.autopilot) ? raw.autopilot : {}),
      autoMerge: false,
    } as WorkflowConfig["autopilot"],
    checks: Array.isArray(raw.checks) ? (raw.checks as CheckConfig[]) : DEFAULTS.checks,
    commandAllowlist: Array.isArray(raw.commandAllowlist)
      ? (raw.commandAllowlist as string[])
      : DEFAULTS.commandAllowlist,
    orgProviderAllowlist: Array.isArray(raw.orgProviderAllowlist)
      ? (raw.orgProviderAllowlist as ProviderId[])
      : [],
    proprietaryCode: raw.proprietaryCode === true,
    pricing: Array.isArray(raw.pricing) ? (raw.pricing as PricingRow[]) : [],
    schemaVersion: 1,
    workspaceDir: typeof raw.workspaceDir === "string" ? raw.workspaceDir : DEFAULTS.workspaceDir,
  };
}

export function parseConfig(text: string, where = "config"): WorkflowConfig {
  const raw = parse(text);
  return mergeConfig(raw, where);
}

export function loadConfig(cwd: string): WorkflowConfig {
  const projectPath = path.join(cwd, ".pi-workflows", "config.yaml");
  const userPath = path.join(homedir(), ".pi", "agent", "cost-workflow.yaml");
  let config = { ...DEFAULTS, providers: { ...DEFAULTS.providers } };
  if (existsSync(userPath)) {
    config = parseConfig(readFileSync(userPath, "utf8"), userPath);
  }
  if (existsSync(projectPath)) {
    const project = parseConfig(readFileSync(projectPath, "utf8"), projectPath);
    config = mergeConfig({ ...config, ...project, providers: { ...config.providers, ...project.providers }, pricing: project.pricing.length ? project.pricing : config.pricing }, projectPath);
  }
  if (config.proprietaryCode && config.orgProviderAllowlist.length === 0) {
    throw new WorkflowError(
      "CONFIG_INVALID",
      "proprietaryCode requires orgProviderAllowlist so proprietary tasks cannot reach an unapproved provider.",
    );
  }
  return config;
}

export function priceFor(
  pricing: PricingRow[],
  provider: string,
  model: string,
  at: Date,
): PricingRow | undefined {
  const day = at.toISOString().slice(0, 10);
  const matches = pricing
    .filter((row) => row.provider === provider && row.model === model && row.effectiveFrom <= day)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return matches[0];
}

export function estimateUsd(
  row: PricingRow | undefined,
  usage: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null },
): number | null {
  if (!row) return null;
  if (usage.input === null || usage.output === null) return null;
  const cachePriced = (row.cacheReadPerMillionUsd ?? 0) > 0 || (row.cacheWritePerMillionUsd ?? 0) > 0;
  if (cachePriced && (usage.cacheRead === null || usage.cacheWrite === null)) return null;
  const million = 1_000_000;
  return (
    (usage.input * row.inputPerMillionUsd +
      usage.output * row.outputPerMillionUsd +
      (usage.cacheRead ?? 0) * (row.cacheReadPerMillionUsd ?? 0) +
      (usage.cacheWrite ?? 0) * (row.cacheWritePerMillionUsd ?? 0)) /
    million
  );
}

/** Model id used for pricing lookup. Missing ids stay unresolved so the charge is unknown. */
export function modelNameFor(config: WorkflowConfig, provider: ProviderId, tier: Tier): string {
  if (provider === "foundry") {
    const deployments = config.providers.foundry?.deployments;
    if (tier === "classifier" || tier === "cheap" || tier === "deterministic") {
      return deployments?.cheap ?? deployments?.classifier ?? "";
    }
    return deployments?.reasoning ?? "";
  }
  return config.providers[provider]?.model ?? "";
}
