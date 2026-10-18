import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { containsSecret, redact } from "./redact.js";
import { WorkflowError, CHAT_APIS, PROVIDERS, TIERS, TIER_KEYS, TICKET_TIERS, isAccountProvider, isProviderId, isTier, type ProviderId, type Tier, type TierCandidate, type TierKey, type ChatApi } from "./domain.js";

export interface ProviderConfig {
  type: string;
  auth: string;
  piProvider?: string;
  endpointEnv?: string;
  apiVersion?: string;
  audience?: string;
  api?: "openai-responses" | "openai-completions" | "azure-openai-responses";
  /**
   * Foundry: maps a model name used in `tiers` (for example gpt-6.1-sol) to your Azure deployment name. A model with
   * no entry is called by its own name. Pi is registered with the deployment name; routing shows `model → deployment`.
   */
  deployments?: Record<string, string>;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  /** Foundry: literal resource endpoint (not a secret) used when `endpointEnv` is unset. */
  endpoint?: string;
  /** Foundry: the Azure resource group of the resource named by `endpoint`. Only `/status foundry` reads it (to list deployments); user config only. */
  resourceGroup?: string;
  /** Foundry: "v1" uses `<endpoint>/openai/v1/...` (no api-version); "deployments" is the legacy route. Defaults to deployments when apiVersion is set, else v1. */
  routeStyle?: "v1" | "deployments";
  /** Vercel: directory that has been `vercel link`ed (relative paths resolve from the project root). */
  projectDir?: string;
  /** Vercel: env file `vercel env pull` writes. Defaults to .env.local. */
  envFile?: string;
  /**
   * openai, anthropic, xai: accept an API key stored in Pi (`/login` with a key) when no account login is
   * present. Billed per token, so it needs `billing: api-key` pricing rows. User config only.
   */
  apiKeyFallback?: boolean;
}

export const DEFAULT_VERCEL_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1";
export const DEFAULT_FOUNDRY_AUDIENCE = "https://ai.azure.com";

export interface PricingRow {
  provider: string;
  model: string;
  effectiveFrom: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  /** "api-key": this row prices the model while the provider is on a Pi-stored API key (per-token billing). */
  billing?: "api-key";
}

/** How an account provider is billed right now: its subscription (account login) or per token (API key). */
export type Billing = "subscription" | "api-key";

let billingOf: (provider: string) => Billing = () => "subscription";

/** How a provider is billed right now: "api-key" while Pi holds a key for it and the fallback is on, else "subscription". */
export function billingFor(provider: string): Billing {
  return billingOf(provider);
}

/**
 * Tells pricing how each provider is billed right now. The host sets this from Pi's stored credentials, so
 * every price lookup (ranking, ledger, budgets) uses API-key rows while a provider runs on an API key.
 */
export function setBillingResolver(resolve: ((provider: string) => Billing) | undefined): void {
  billingOf = resolve ?? (() => "subscription");
}

/**
 * Ranking-only shadow price for a subscription model, in USD per million tokens. It steers the selector away
 * from scarce quota (Opus, Sol, Fable) on easy work. It never reaches the ledger, `actualUsd`, or budgets.
 */
export interface QuotaWeight {
  provider: string;
  model: string;
  perMillionTokensUsd: number;
}

/** Soft token caps for one subscription provider. Over a cap, its shadow prices are multiplied; nothing is blocked. */
export interface QuotaCap {
  dailyTokens?: number;
  weeklyTokens?: number;
}

export interface QuotaConfig {
  models: QuotaWeight[];
  providers: Partial<Record<ProviderId, QuotaCap>>;
  /** Factor applied to a provider's shadow prices once it is at or over a daily or weekly cap. */
  overCapMultiplier: number;
}

export interface CheckConfig {
  name: string;
  command: string;
  args: string[];
}

/** Tiers a session, direct, or review job can be pinned to. */
export type ChatTierName = "cheap" | "standard" | "premium";
const CHAT_TIER_NAMES: readonly string[] = ["cheap", "standard", "premium"];

export interface SessionConfig {
  /** The main session's model as `provider/id`. */
  model: string;
  /** Switch the session to `model` at session start. False leaves the model the user picked. */
  pin: boolean;
  /** Tier that writes compaction summaries (session_before_compact). Pi compacts on the session model when none can. */
  compactionTier: ChatTierName;
}

export const DEFAULT_SESSION: SessionConfig = { model: "anthropic/claude-opus-5-5", pin: true, compactionTier: "cheap" };

/** Splits `provider/id` at the first slash. Undefined when either part is empty. */
export function parseModelRef(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || /\s/.test(value)) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export interface WorkflowConfig {
  schemaVersion: 1;
  workspaceDir: string;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
  /** Candidate models per tier, in preference order for ties. A tier it does not list uses DEFAULT_TIERS. */
  tiers: Partial<Record<TierKey, TierCandidate[]>>;
  routing: {
    maxEscalations: number;
    maxTier: Tier;
    /** Tier the /review model pass routes to. */
    reviewTier: ChatTierName;
    requirePremiumReviewFor: string[];
    circuitBreakerFailures: number;
    /**
     * Ranking-only USD added to every candidate's price before dividing by its success rate: the time and retry
     * cost of a failed attempt, so a $0 subscription model with a poor record does not always win. Like the quota
     * shadow price it never reaches the ledger, budgets, the over-budget filter, or expectedUsd.
     */
    attemptOverheadUsd: number;
    /**
     * How a tier picks its model. `ordered` (default): the first usable candidate in the tier's listed order, so the
     * choice is predictable and the list is a fallback chain. `adaptive`: cost per success with Thompson sampling.
     */
    selection: "ordered" | "adaptive";
  };
  /** The main chat session: a normal Pi model, pinned at session start, with compaction on a cheap tier. */
  session: SessionConfig;
  /**
   * Local mode (`/plan --local`, or every plan with `default: true`): tickets are written for and built by the
   * local models in tiers.localSmall (low tickets) and tiers.localLarge (medium), and never go to a cloud model.
   * `ticketContextTokens` is the size a local ticket must fit (system prompt and tools included); `maxFilesPerTicket`
   * caps the files one ticket may touch. Planning and the per-ticket review stay on the session and review models.
   */
  localMode: { default: boolean; ticketContextTokens: number; maxFilesPerTicket: number };
  workers: {
    /** Tokens the router prices one call at (the cost model). */
    tokenBudget: number;
    /** Soft context-window target for one ticket, in tokens. Planning rejects a ticket estimated above it. */
    ticketContextTokens: number;
  };
  /** /build names the branch `<branchPrefix>/<taskId>` when they start from the default branch. */
  branchPrefix: string;
  budgets: {
    taskUsd: number;
    dailyUsd: number;
    softWarningRatio: number;
    /**
     * Budget math only: what one ledger entry with unknown cost and nothing to price it from (no token counts, or no
     * pricing row) counts as. The ledger keeps `actualUsd: null`. A project can only raise it (the higher value wins).
     */
    unknownCallUsd: number;
  };
  approvals: {
    plan: "required";
    merge: "manual";
  };
  checks: CheckConfig[];
  /** Commands /review runs in the repo root before the checks (an install, for example). Same rules as checks. */
  setup: CheckConfig[];
  /** The model pass of /review: a review-tier model reads the branch diff and lists advisory findings. */
  review: { model: boolean; maxDiffChars: number; maxChunks: number; timeoutMs: number };
  /**
   * Second opinions during /build: after a ticket's checks pass, the review tier reads its diff and, by difficulty,
   * the advisor tier is consulted in parallel. `tickets: false` turns the per-ticket review off; `plan: false` skips the
   * advisor consult on every plan (plan_consult). `adHocMinLines`: an ad-hoc branch (no plan) with more changed lines
   * than this gets one advisor in /review. `summarizeCut`: when a diff is clipped for an
   * advisor packet or a review part, the batch tier writes a one-line summary of each cut file. `fromDifficulty`: the
   * lowest ticket difficulty that gets advisors in the per-ticket review and /review (`high` by default; `medium`
   * also gives medium tickets and large ad-hoc branches one advisor from another vendor).
   */
  advisors: { timeoutMs: number; maxDiffChars: number; maxOutputTokens: number; tickets: boolean; plan: boolean; adHocMinLines: number; summarizeCut: boolean; maxPlanConsults: number; fromDifficulty: "medium" | "high" };
  orgProviderAllowlist: ProviderId[];
  proprietaryCode: boolean;
  pricing: PricingRow[];
  /** Subscription quota shadow prices and soft caps. Ranking only; see QuotaConfig. */
  quota: QuotaConfig;
  /** Notes from loading, for example project settings that were ignored. Shown by /status. */
  warnings?: string[];
}

/** Default for `budgets.unknownCallUsd`. */
export const DEFAULT_UNKNOWN_CALL_USD = 0.05;

/**
 * Built-in tiers: the same model lists as the sample .pi-workflows/config.yaml. A config's `tiers` replaces a tier's list.
 * No prices live here: a model without a `pricing` row has an unknown cost (see the config warning).
 */
export const DEFAULT_TIERS: Record<TierKey, TierCandidate[]> = {
  deterministic: [{ provider: "local", model: "qwen2.5-coder:7b" }],
  cheap: [{ provider: "anthropic", model: "claude-haiku-5-5" }],
  // Foundry entries are fallbacks for when the account login does not work (for example ChatGPT Enterprise, or no SuperGrok).
  // A Foundry candidate with no endpoint or no az login is unavailable and skipped. The `model` is YOUR deployment name:
  // these assume deployments named like the models, so rename them in your config.
  batch: [
    { provider: "openai", model: "gpt-6-luna" },
    { provider: "foundry", model: "gpt-6-luna", label: "GPT Luna (Foundry)" },
  ],
  standard: [
    { provider: "anthropic", model: "claude-sonnet-5-5" },
    { provider: "openai", model: "gpt-6.1-sol" },
    { provider: "foundry", model: "gpt-6.1-sol", label: "GPT Sol (Foundry)", api: "openai-responses" },
  ],
  premium: [{ provider: "anthropic", model: "claude-opus-5-5" }],
  ticketLow: [
    { provider: "xai", model: "grok-4.7", label: "Grok 4.7 (SuperGrok)" },
    { provider: "foundry", model: "grok-4-7", label: "Grok 4.7 (Foundry)" },
  ],
  ticketMedium: [{ provider: "anthropic", model: "claude-sonnet-5-5" }],
  ticketHigh: [
    { provider: "openai", model: "gpt-6.1-sol" },
    { provider: "foundry", model: "gpt-6.1-sol", label: "GPT Sol (Foundry)", api: "openai-responses" },
  ],
  // Local mode (/plan --local): the Ollama tags of the two local models. Set tiers.localSmall / localLarge to yours.
  // contextWindow must match what Ollama runs (OLLAMA_CONTEXT_LENGTH), or Pi overfills a smaller window.
  localSmall: [{ provider: "local", model: "qwen3.5:9b", label: "Qwen 3.5 9B (local)", contextWindow: 65_536 }],
  localLarge: [{ provider: "local", model: "qwen3.5:27b", label: "Qwen 3.5 27B (local)", contextWindow: 65_536 }],
  advisor: [
    { provider: "openai", model: "gpt-6-astra" },
    { provider: "anthropic", model: "claude-fable-5-1" },
    { provider: "foundry", model: "gpt-6-astra", label: "GPT Astra (Foundry deployment)" },
  ],
};

const DEFAULTS: WorkflowConfig = {
  schemaVersion: 1,
  workspaceDir: ".pi-workflows",
  providers: {},
  tiers: {},
  routing: {
    maxEscalations: 3,
    maxTier: "premium",
    reviewTier: "premium",
    requirePremiumReviewFor: ["auth", "permissions", "secrets", "security-sensitive"],
    circuitBreakerFailures: 3,
    attemptOverheadUsd: 0.02,
    selection: "ordered",
  },
  session: DEFAULT_SESSION,
  localMode: { default: false, ticketContextTokens: 32_000, maxFilesPerTicket: 3 },
  workers: {
    tokenBudget: 8000,
    ticketContextTokens: 150000,
  },
  branchPrefix: "chef",
  budgets: { taskUsd: 20, dailyUsd: 75, softWarningRatio: 0.8, unknownCallUsd: DEFAULT_UNKNOWN_CALL_USD },
  approvals: { plan: "required", merge: "manual" },
  checks: [],
  setup: [],
  review: { model: true, maxDiffChars: 120_000, maxChunks: 6, timeoutMs: 300_000 },
  advisors: { timeoutMs: 180_000, maxDiffChars: 40_000, maxOutputTokens: 1500, tickets: true, plan: true, adHocMinLines: 400, summarizeCut: true, maxPlanConsults: 2, fromDifficulty: "high" },
  orgProviderAllowlist: [],
  proprietaryCode: false,
  pricing: [],
  quota: { models: [], providers: {}, overCapMultiplier: 4 },
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

function invalid(where: string, field: string, message: string): never {
  throw new WorkflowError("CONFIG_INVALID", `${where}: ${field} ${message}`);
}

function checkNumber(
  section: Record<string, unknown>,
  key: string,
  where: string,
  rule: { min?: number; max?: number; exclusiveMin?: number; integer?: boolean },
  prefix: string,
): void {
  const value = section[key];
  if (value === undefined) return;
  const field = `${prefix}.${key}`;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(where, field, "must be a finite number");
  if (rule.integer && !Number.isInteger(value)) invalid(where, field, "must be an integer");
  if (rule.min !== undefined && value < rule.min) invalid(where, field, `must be >= ${rule.min}`);
  if (rule.exclusiveMin !== undefined && value <= rule.exclusiveMin) invalid(where, field, `must be > ${rule.exclusiveMin}`);
  if (rule.max !== undefined && value > rule.max) invalid(where, field, `must be <= ${rule.max}`);
}

function section(raw: Record<string, unknown>, key: string, where: string): Record<string, unknown> | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(where, key, "must be a mapping");
  return value;
}

function stringArray(value: unknown, field: string, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    invalid(where, field, "must be a list of non-empty strings");
  }
  return value as string[];
}

/** Normalizes a YAML date (string or Date) to YYYY-MM-DD, or returns undefined if invalid. */
export function normalizeEffectiveFrom(value: unknown): string | undefined {
  let text: string;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    text = value.toISOString().slice(0, 10);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return undefined;
  return text;
}

function normalizePricing(value: unknown, where: string): PricingRow[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(where, "pricing", "must be a list");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const field = `pricing[${index}]`;
    if (!isRecord(item)) invalid(where, field, "must be a mapping");
    if (typeof item.provider !== "string" || item.provider === "") invalid(where, `${field}.provider`, "must be a non-empty string");
    if (typeof item.model !== "string" || item.model === "") invalid(where, `${field}.model`, "must be a non-empty string");
    const effectiveFrom = normalizeEffectiveFrom(item.effectiveFrom);
    if (!effectiveFrom) invalid(where, `${field}.effectiveFrom`, "must be a valid date in YYYY-MM-DD format");
    for (const key of ["inputPerMillionUsd", "outputPerMillionUsd"] as const) {
      if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0) {
        invalid(where, `${field}.${key}`, "must be a finite number >= 0");
      }
    }
    for (const key of ["cacheReadPerMillionUsd", "cacheWritePerMillionUsd"] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0)) {
        invalid(where, `${field}.${key}`, "must be a finite number >= 0");
      }
    }
    if (item.billing !== undefined && item.billing !== "api-key") invalid(where, `${field}.billing`, 'must be "api-key" when set');
    const key = `${item.provider}\u0000${item.model}\u0000${effectiveFrom}\u0000${item.billing ?? ""}`;
    if (seen.has(key)) {
      invalid(where, field, `duplicates another row for ${item.provider}/${item.model}${item.billing ? ` (${item.billing})` : ""} effective ${effectiveFrom}`);
    }
    seen.add(key);
    return { ...(item as unknown as PricingRow), effectiveFrom };
  });
}

function normalizeQuota(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(where, "quota", "must be a mapping");
  const out: Record<string, unknown> = { ...value };
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) invalid(where, "quota.models", "must be a list");
    const seen = new Set<string>();
    out.models = value.models.map((item, index) => {
      const field = `quota.models[${index}]`;
      if (!isRecord(item)) invalid(where, field, "must be a mapping");
      if (typeof item.provider !== "string" || item.provider === "") invalid(where, `${field}.provider`, "must be a non-empty string");
      if (typeof item.model !== "string" || item.model === "") invalid(where, `${field}.model`, "must be a non-empty string");
      checkNumber(item, "perMillionTokensUsd", where, { min: 0 }, field);
      if (item.perMillionTokensUsd === undefined) invalid(where, `${field}.perMillionTokensUsd`, "is required");
      const key = `${item.provider}\u0000${item.model}`;
      if (seen.has(key)) invalid(where, field, `duplicates another row for ${item.provider}/${item.model}`);
      seen.add(key);
      return { provider: item.provider, model: item.model, perMillionTokensUsd: item.perMillionTokensUsd as number } satisfies QuotaWeight;
    });
  }
  const providers = section(value, "providers", where);
  if (providers) {
    for (const [name, cap] of Object.entries(providers)) {
      if (!isProviderId(name)) invalid(where, `quota.providers.${name}`, "is not a known provider");
      if (!isRecord(cap)) invalid(where, `quota.providers.${name}`, "must be a mapping");
      for (const key of ["dailyTokens", "weeklyTokens"]) checkNumber(cap, key, where, { exclusiveMin: 0, integer: true }, `quota.providers.${name}`);
    }
  }
  checkNumber(value, "overCapMultiplier", where, { min: 1 }, "quota");
  return out;
}

function parseUrl(value: string): URL | undefined {
  if (/\s/.test(value)) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function isHttpsUrl(value: string): boolean {
  const url = parseUrl(value);
  return !!url && url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

function isLoopbackHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return !!url && url.protocol === "http:" && url.username === "" && url.password === "" && isLoopbackHost(url.hostname);
}

/** Adds a load note once, however many files carry the same old key. */
function warnOnce(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

/**
 * Removes settings from earlier versions, each with one warning, so an old file still loads. The cost-opt/auto
 * virtual model, its router settings, and the Decisions classifier are gone.
 */
const LEGACY_DEPLOYMENT_KEYS = ["cheap", "reasoning", "classifier"];

function dropLegacy(raw: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (isRecord(out.providers)) {
    const providers: Record<string, unknown> = {};
    for (const [name, provider] of Object.entries(out.providers)) {
      let current: unknown = provider;
      if (isRecord(current) && "decisionsPath" in current) {
        warnOnce(warnings, `providers.${name}.decisionsPath is no longer used; the Decisions classifier is gone.`);
        const { decisionsPath: _gone, ...rest } = current;
        current = rest;
      }
      if (name === "foundry" && isRecord(current) && isRecord(current.deployments)) {
        const kept: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(current.deployments)) {
          if (LEGACY_DEPLOYMENT_KEYS.includes(key)) {
            warnOnce(warnings, `providers.foundry.deployments.${key} is ignored: deployments now maps a Foundry model to your deployment name, for example { "gpt-6.1-sol": "my-sol" }. Name the model under tiers.`);
          } else kept[key] = value;
        }
        current = { ...current, deployments: kept };
      }
      providers[name] = current;
    }
    out.providers = providers;
  }
  if (isRecord(out.models) && "classifier" in out.models) {
    warnOnce(warnings, "models.classifier is no longer used; the classifier tier is gone (the planner rates complexity during /plan).");
    const { classifier: _gone, ...rest } = out.models;
    out.models = rest;
  }
  if (isRecord(out.tiers)) {
    const tiers: Record<string, unknown> = {};
    for (const [key, list] of Object.entries(out.tiers)) {
      if (key === "classifier") {
        warnOnce(warnings, "tiers.classifier is no longer used; the classifier tier is gone (the planner rates complexity during /plan).");
        continue;
      }
      if (!Array.isArray(list)) {
        tiers[key] = list;
        continue;
      }
      // A Decisions model cannot chat, so it is dropped; a tier left with nothing is dropped too.
      const kept = list.filter((item) => {
        if (!isRecord(item) || item.api !== "decisions") return true;
        warnOnce(warnings, `tiers.${key}: dropped ${String(item.provider)}/${String(item.model)} (api: decisions is no longer supported).`);
        return false;
      });
      if (kept.length > 0 || list.length === 0) tiers[key] = kept;
    }
    out.tiers = tiers;
  }
  if (isRecord(out.routing)) {
    const routing = { ...out.routing };
    if ("minConfidence" in routing) {
      warnOnce(warnings, "routing.minConfidence is no longer used; nothing is classified by a model.");
      delete routing.minConfidence;
    }
    if ("sessionTier" in routing) {
      warnOnce(warnings, "routing.sessionTier is no longer used; the main session is a normal Pi model (set session.model).");
      delete routing.sessionTier;
    }
    if ("directTier" in routing) {
      warnOnce(warnings, "routing.directTier is no longer used; compaction runs on session.compactionTier.");
      delete routing.directTier;
    }
    out.routing = routing;
  }
  return out;
}

/** Validates and normalizes one raw YAML document. Returns a shallow copy with normalized fields. */
function normalizeRaw(input: unknown, where: string, warnings: string[] = [], lenient = false): Record<string, unknown> {
  if (!isRecord(input)) throw new WorkflowError("CONFIG_INVALID", `${where} must be a mapping`);
  const raw = dropLegacy(input, warnings);
  assertNoSecrets(raw, where);
  const out: Record<string, unknown> = { ...raw };

  const providers = section(raw, "providers", where) ?? {};
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
    if (name === "xai" && provider.auth && provider.auth !== "account-login") {
      throw new WorkflowError("CONFIG_INVALID", "xAI auth must be account-login.");
    }
    if (provider.apiKeyFallback !== undefined) {
      if (typeof provider.apiKeyFallback !== "boolean") invalid(where, `providers.${name}.apiKeyFallback`, "must be true or false");
      if (!isAccountProvider(name)) invalid(where, `providers.${name}.apiKeyFallback`, "applies only to openai, anthropic, and xai");
    }
    if (name === "foundry" && provider.auth && provider.auth !== "azure-cli") {
      throw new WorkflowError("CONFIG_INVALID", "Foundry auth must be azure-cli.");
    }
    if (name === "vercel" && provider.auth && provider.auth !== "vercel-cli") {
      throw new WorkflowError("CONFIG_INVALID", "Vercel auth must be vercel-cli.");
    }
    if (provider.resourceGroup !== undefined && (typeof provider.resourceGroup !== "string" || !/^[A-Za-z0-9._()-]{1,90}$/.test(provider.resourceGroup))) {
      invalid(where, `providers.${name}.resourceGroup`, "must be an Azure resource group name");
    }
    for (const key of ["endpoint", "projectDir", "envFile", "baseUrl", "model"] as const) {
      if (provider[key] !== undefined && (typeof provider[key] !== "string" || provider[key] === "")) {
        invalid(where, `providers.${name}.${key}`, "must be a non-empty string");
      }
    }
    if (provider.apiKeyEnv !== undefined && (typeof provider.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv))) {
      invalid(where, `providers.${name}.apiKeyEnv`, "must be an environment variable name");
    }
    for (const key of ["endpoint", "audience"] as const) {
      if (typeof provider[key] === "string" && !isHttpsUrl(provider[key])) invalid(where, `providers.${name}.${key}`, "must be an https URL");
    }
    if (typeof provider.baseUrl === "string" && !isHttpsUrl(provider.baseUrl) && !(name === "local" && isLoopbackHttpUrl(provider.baseUrl))) {
      invalid(where, `providers.${name}.baseUrl`, name === "local" ? "must be an https URL, or http only for localhost" : "must be an https URL");
    }
    if (provider.deployments !== undefined) {
      if (name !== "foundry") invalid(where, `providers.${name}.deployments`, "applies only to foundry");
      if (!isRecord(provider.deployments)) invalid(where, `providers.${name}.deployments`, "must map a model name to a deployment name");
      for (const [model, deployment] of Object.entries(provider.deployments)) {
        if (typeof deployment !== "string" || !DEPLOYMENT_NAME.test(deployment)) {
          invalid(where, `providers.${name}.deployments.${model}`, "must be a deployment name (letters, digits, dot, underscore, hyphen)");
        }
      }
    }
    if (provider.routeStyle !== undefined && provider.routeStyle !== "v1" && provider.routeStyle !== "deployments") {
      invalid(where, `providers.${name}.routeStyle`, 'must be "v1" or "deployments"');
    }
    if (typeof provider.envFile === "string" && (provider.envFile.startsWith("-") || provider.envFile.includes(".."))) {
      invalid(where, `providers.${name}.envFile`, "must be a plain file name or relative path without ..");
    }
  }
  for (const name of Object.keys(providers)) {
    if (!isProviderId(name)) invalid(where, `providers.${name}`, `is not a known provider (${PROVIDERS.join(", ")})`);
  }
  const approvals = section(raw, "approvals", where);
  if (approvals?.merge && approvals.merge !== "manual") {
    throw new WorkflowError("CONFIG_INVALID", "approvals.merge must stay manual.");
  }

  const models = section(raw, "models", where);
  if (models) {
    for (const [key, value] of Object.entries(models)) {
      if (!MODEL_KEYS.includes(key as (typeof MODEL_KEYS)[number])) invalid(where, `models.${key}`, "is not a known tier");
      if (typeof value !== "string" || !isProviderId(value)) {
        invalid(where, `models.${key}`, `must be one of ${PROVIDERS.join(", ")}`);
      }
    }
  }

  const tiers = section(raw, "tiers", where);
  if (tiers) {
    const kept: Record<string, unknown> = {};
    for (const [key, list] of Object.entries(tiers)) {
      // A bad tier drops only that tier when loading real files: the built-in tier applies and the rest of the file still loads.
      try {
        checkTier(key, list);
        kept[key] = list;
      } catch (error) {
        if (!lenient || !(error instanceof WorkflowError) || error.code !== "CONFIG_INVALID") throw error;
        warnOnce(warnings, `${error.message}; tiers.${key} was dropped, so the built-in ${key} tier applies.`);
      }
    }
    out.tiers = kept;
  }
  function checkTier(key: string, list: unknown): void {
    {
      if (!(TIER_KEYS as readonly string[]).includes(key)) invalid(where, `tiers.${key}`, `is not a known tier (${TIER_KEYS.join(", ")})`);
      if (!Array.isArray(list) || list.length === 0) invalid(where, `tiers.${key}`, "must be a non-empty list of candidates");
      list.forEach((item, index) => {
        const field = `tiers.${key}[${index}]`;
        if (!isRecord(item)) invalid(where, field, "must be a mapping");
        if (typeof item.provider !== "string" || !isProviderId(item.provider)) {
          invalid(where, `${field}.provider`, `must be one of ${PROVIDERS.join(", ")}`);
        }
        if (typeof item.model !== "string" || item.model.trim() === "") invalid(where, `${field}.model`, "must be a non-empty string");
        if (item.api !== undefined && item.api !== "chat") {
          if (typeof item.api !== "string" || !(CHAT_APIS as readonly string[]).includes(item.api)) invalid(where, `${field}.api`, `must be one of ${CHAT_APIS.join(", ")}`);
          if (item.provider !== "foundry") invalid(where, `${field}.api`, "applies only to foundry candidates");
        }
        if (item.label !== undefined && typeof item.label !== "string") invalid(where, `${field}.label`, "must be a string");
        if (item.contextWindow !== undefined && (typeof item.contextWindow !== "number" || !Number.isInteger(item.contextWindow) || item.contextWindow < 4096)) invalid(where, `${field}.contextWindow`, "must be an integer of at least 4096");
      });
    }
  }

  const routing = section(raw, "routing", where);
  if (routing) {
    checkNumber(routing, "maxEscalations", where, { min: 0, integer: true }, "routing");
    checkNumber(routing, "circuitBreakerFailures", where, { min: 1, integer: true }, "routing");
    checkNumber(routing, "attemptOverheadUsd", where, { min: 0 }, "routing");
    if (routing.maxTier !== undefined && (typeof routing.maxTier !== "string" || !isTier(routing.maxTier) || routing.maxTier === "batch")) {
      invalid(where, "routing.maxTier", `must be one of ${TIERS.filter((tier) => tier !== "batch").join(", ")}`);
    }
    if (routing.reviewTier !== undefined && (typeof routing.reviewTier !== "string" || !CHAT_TIER_NAMES.includes(routing.reviewTier))) {
      invalid(where, "routing.reviewTier", `must be one of ${CHAT_TIER_NAMES.join(", ")}`);
    }
    if (routing.requirePremiumReviewFor !== undefined) stringArray(routing.requirePremiumReviewFor, "routing.requirePremiumReviewFor", where);
    if (routing.selection !== undefined && routing.selection !== "ordered" && routing.selection !== "adaptive") invalid(where, "routing.selection", "must be ordered or adaptive");
  }
  const session = section(raw, "session", where);
  if (session) {
    const checkSession = () => {
    if (session.model !== undefined && (typeof session.model !== "string" || !parseModelRef(session.model))) invalid(where, "session.model", "must be provider/id, for example anthropic/claude-opus-5-5");
    if (session.pin !== undefined && typeof session.pin !== "boolean") invalid(where, "session.pin", "must be true or false");
    if (session.compactionTier !== undefined && (typeof session.compactionTier !== "string" || !CHAT_TIER_NAMES.includes(session.compactionTier))) {
      invalid(where, "session.compactionTier", `must be one of ${CHAT_TIER_NAMES.join(", ")}`);
    }
    };
    if (!lenient) checkSession();
    else {
      try {
        checkSession();
      } catch (error) {
        if (!(error instanceof WorkflowError) || error.code !== "CONFIG_INVALID") throw error;
        warnOnce(warnings, `${error.message}; the whole session section was dropped, so the default session settings apply.`);
        delete out.session;
      }
    }
  }
  const workers = section(raw, "workers", where);
  if (workers) {
    checkNumber(workers, "tokenBudget", where, { exclusiveMin: 0 }, "workers");
    checkNumber(workers, "ticketContextTokens", where, { min: 20000, integer: true }, "workers");
  }
  const localMode = section(raw, "localMode", where);
  if (localMode) {
    if (localMode.default !== undefined && typeof localMode.default !== "boolean") invalid(where, "localMode.default", "must be a boolean");
    checkNumber(localMode, "ticketContextTokens", where, { min: 8000, integer: true }, "localMode");
    checkNumber(localMode, "maxFilesPerTicket", where, { min: 1, integer: true }, "localMode");
  }
  if (raw.branchPrefix !== undefined && (typeof raw.branchPrefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw.branchPrefix) || raw.branchPrefix.endsWith("/") || raw.branchPrefix.includes(".."))) {
    invalid(where, "branchPrefix", "must be a plain branch-name prefix such as chef");
  }
  const budgets = section(raw, "budgets", where);
  if (budgets) {
    for (const key of ["taskUsd", "dailyUsd"]) checkNumber(budgets, key, where, { exclusiveMin: 0 }, "budgets");
    checkNumber(budgets, "softWarningRatio", where, { min: 0, max: 1 }, "budgets");
    checkNumber(budgets, "unknownCallUsd", where, { min: 0 }, "budgets");
  }
  for (const key of ["checks", "setup"] as const) {
    const list = raw[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) invalid(where, key, "must be a list");
    list.forEach((check, index) => {
      const field = `${key}[${index}]`;
      if (!isRecord(check)) invalid(where, field, "must be a mapping");
      if (typeof check.name !== "string" || typeof check.command !== "string" || check.command === "") {
        invalid(where, field, "needs string name and command");
      }
      if (check.args !== undefined) stringArray(check.args, `${field}.args`, where);
    });
  }
  if (raw.review !== undefined) {
    if (!isRecord(raw.review)) invalid(where, "review", "must be a mapping");
    if (raw.review.model !== undefined && typeof raw.review.model !== "boolean") invalid(where, "review.model", "must be a boolean");
    checkNumber(raw.review, "maxDiffChars", where, { min: 1000, integer: true }, "review");
    checkNumber(raw.review, "maxChunks", where, { min: 1, integer: true }, "review");
    checkNumber(raw.review, "timeoutMs", where, { min: 1000, integer: true }, "review");
  }
  if (raw.advisors !== undefined) {
    if (!isRecord(raw.advisors)) invalid(where, "advisors", "must be a mapping");
    if (raw.advisors.tickets !== undefined && typeof raw.advisors.tickets !== "boolean") invalid(where, "advisors.tickets", "must be a boolean");
    if (raw.advisors.plan !== undefined && typeof raw.advisors.plan !== "boolean") invalid(where, "advisors.plan", "must be a boolean");
    if (raw.advisors.summarizeCut !== undefined && typeof raw.advisors.summarizeCut !== "boolean") invalid(where, "advisors.summarizeCut", "must be a boolean");
    checkNumber(raw.advisors, "timeoutMs", where, { min: 1000, integer: true }, "advisors");
    checkNumber(raw.advisors, "maxDiffChars", where, { min: 1000, integer: true }, "advisors");
    checkNumber(raw.advisors, "maxOutputTokens", where, { min: 100, integer: true }, "advisors");
    checkNumber(raw.advisors, "adHocMinLines", where, { min: 0, integer: true }, "advisors");
    checkNumber(raw.advisors, "maxPlanConsults", where, { min: 1, integer: true }, "advisors");
    if (raw.advisors.fromDifficulty !== undefined && raw.advisors.fromDifficulty !== "medium" && raw.advisors.fromDifficulty !== "high") invalid(where, "advisors.fromDifficulty", "must be medium or high");
  }
  if (raw.orgProviderAllowlist !== undefined) {
    const list = stringArray(raw.orgProviderAllowlist, "orgProviderAllowlist", where);
    for (const id of list) if (!isProviderId(id)) invalid(where, "orgProviderAllowlist", `contains unknown provider ${id}`);
  }
  if (raw.proprietaryCode !== undefined && typeof raw.proprietaryCode !== "boolean") {
    invalid(where, "proprietaryCode", "must be a boolean");
  }
  out.pricing = normalizePricing(raw.pricing, where);
  try {
    const quota = normalizeQuota(raw.quota, where);
    if (quota) out.quota = quota;
  } catch (error) {
    // Quota only ranks models (it never bills), so a bad section is dropped with a warning when loading real files.
    if (!lenient || !(error instanceof WorkflowError) || error.code !== "CONFIG_INVALID") throw error;
    warnOnce(warnings, `${error.message}; the whole quota section was dropped, so no quota shadow prices apply.`);
    delete out.quota;
  }
  return out;
}

const DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MODEL_KEYS = ["cheap", "standard", "premium"] as const;

/**
 * Cross-checks a resolved config: tier candidates must reference configured providers. Only what the file wrote is
 * checked; the built-in tiers are never validated against the file's providers.
 */
export function validateResolvedConfig(config: WorkflowConfig, where = "config"): void {
  for (const [key, list] of Object.entries(config.tiers)) {
    list?.forEach((candidate, index) => {
      if (!config.providers[candidate.provider]) {
        invalid(where, `tiers.${key}[${index}].provider`, `references provider "${candidate.provider}" which is not defined under providers`);
      }
    });
  }
}

/**
 * The lenient form of `validateResolvedConfig`: a tier naming a provider the config does not define is dropped with a
 * warning. The account providers (openai, anthropic, xai) need no block: their login is Pi's, and routing checks it.
 */
function dropUnresolvedTiers(config: WorkflowConfig, where: string, warnings: string[]): void {
  for (const [key, list] of Object.entries(config.tiers)) {
    const index = list?.findIndex((candidate) => !config.providers[candidate.provider] && !isAccountProvider(candidate.provider)) ?? -1;
    if (index < 0) continue;
    warnOnce(warnings, `${where}: tiers.${key}[${index}].provider references provider "${list![index]!.provider}" which is not defined under providers; tiers.${key} was dropped, so the built-in ${key} tier applies.`);
    delete config.tiers[key as TierKey];
  }
}

/**
 * The deprecated `models: { cheap: <provider> }` map becomes a one-candidate tier when `providers.<provider>.model` names
 * the model and `tiers` does not list that tier. Otherwise (Foundry, or no model) the entry is dropped with a warning.
 */
function applyLegacyModels(norm: Record<string, unknown>, config: WorkflowConfig, warnings: string[]): void {
  if (!isRecord(norm.models) || Object.keys(norm.models).length === 0) return;
  warnOnce(warnings, "models: is deprecated; list candidates under tiers: instead (a models entry becomes a one-model tier).");
  for (const [key, provider] of Object.entries(norm.models)) {
    if (!(MODEL_KEYS as readonly string[]).includes(key) || typeof provider !== "string" || !isProviderId(provider)) continue;
    if (config.tiers[key as TierKey]) continue;
    const model = config.providers[provider]?.model;
    if (provider === "foundry" || !model) {
      warnOnce(warnings, `models.${key}: ${provider} is dropped (${provider === "foundry" ? "name the Foundry model under tiers" : `set providers.${provider}.model`}); the built-in ${key} tier applies.`);
      continue;
    }
    config.tiers[key as TierKey] = [{ provider, model }];
  }
}

function build(norm: Record<string, unknown>): WorkflowConfig {
  const obj = (key: string): Record<string, unknown> => (isRecord(norm[key]) ? (norm[key] as Record<string, unknown>) : {});
  return {
    ...DEFAULTS,
    providers: { ...DEFAULTS.providers, ...obj("providers") } as WorkflowConfig["providers"],
    tiers: normalizeTiers(obj("tiers")),
    routing: { ...DEFAULTS.routing, ...obj("routing") } as WorkflowConfig["routing"],
    session: { ...DEFAULTS.session, ...obj("session") } as WorkflowConfig["session"],
    localMode: { ...DEFAULTS.localMode, ...obj("localMode") } as WorkflowConfig["localMode"],
    workers: { ...DEFAULTS.workers, ...obj("workers") } as WorkflowConfig["workers"],
    branchPrefix: typeof norm.branchPrefix === "string" ? norm.branchPrefix : DEFAULTS.branchPrefix,
    budgets: { ...DEFAULTS.budgets, ...obj("budgets") } as WorkflowConfig["budgets"],
    // Fixed: plan approval stays required and merge manual. An old approvals.securitySensitiveFix is ignored.
    approvals: { plan: "required", merge: "manual" },
    checks: Array.isArray(norm.checks)
      ? (norm.checks as CheckConfig[]).map((check) => ({ ...check, args: check.args ?? [] }))
      : DEFAULTS.checks,
    setup: Array.isArray(norm.setup) ? (norm.setup as CheckConfig[]).map((check) => ({ ...check, args: check.args ?? [] })) : DEFAULTS.setup,
    review: { ...DEFAULTS.review, ...obj("review") } as WorkflowConfig["review"],
    advisors: { ...DEFAULTS.advisors, ...obj("advisors") } as WorkflowConfig["advisors"],
    orgProviderAllowlist: Array.isArray(norm.orgProviderAllowlist) ? (norm.orgProviderAllowlist as ProviderId[]) : [],
    proprietaryCode: norm.proprietaryCode === true,
    pricing: Array.isArray(norm.pricing) ? (norm.pricing as PricingRow[]) : [],
    quota: {
      ...DEFAULTS.quota,
      ...obj("quota"),
      models: Array.isArray(obj("quota").models) ? (obj("quota").models as QuotaWeight[]) : [],
      providers: isRecord(obj("quota").providers) ? (obj("quota").providers as QuotaConfig["providers"]) : {},
    },
    schemaVersion: 1,
    workspaceDir: typeof norm.workspaceDir === "string" ? norm.workspaceDir : DEFAULTS.workspaceDir,
  };
}

function normalizeTiers(raw: Record<string, unknown>): WorkflowConfig["tiers"] {
  const out: WorkflowConfig["tiers"] = {};
  for (const [key, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    out[key as TierKey] = list.map((item) => {
      const entry = item as Record<string, unknown>;
      const candidate: TierCandidate = {
        provider: entry.provider as ProviderId,
        model: String(entry.model),
      };
      if (typeof entry.label === "string") candidate.label = entry.label;
      if (typeof entry.api === "string" && (CHAT_APIS as readonly string[]).includes(entry.api)) candidate.api = entry.api as ChatApi;
      if (typeof entry.contextWindow === "number") candidate.contextWindow = entry.contextWindow;
      return candidate;
    });
  }
  return out;
}

function mergeConfig(raw: unknown, where: string, warnings: string[] = [], lenient = false): WorkflowConfig {
  const norm = normalizeRaw(raw, where, warnings, lenient);
  const config = build(norm);
  applyLegacyModels(norm, config, warnings);
  applyDeploymentPricing(config, warnings);
  // A standalone document that spells out both providers and tiers must be self-consistent.
  // Partial overlays are cross-checked after layering in loadConfig.
  if (lenient) dropUnresolvedTiers(config, where, warnings);
  else if (isRecord(norm.providers) && Object.keys(norm.providers).length > 0 && (isRecord(norm.models) || isRecord(norm.tiers))) {
    validateResolvedConfig(config, where);
  }
  return config;
}

export function parseConfig(text: string, where = "config"): WorkflowConfig {
  const raw = parse(text);
  const warnings: string[] = [];
  const config = mergeConfig(raw, where, warnings);
  if (warnings.length > 0) config.warnings = warnings;
  return config;
}

function mergeSection(user: unknown, project: unknown): Record<string, unknown> | undefined {
  if (!isRecord(user) && !isRecord(project)) return undefined;
  return { ...(isRecord(user) ? user : {}), ...(isRecord(project) ? project : {}) };
}

/**
 * Provider fields that choose where credentials go or which local files are read. A project file is
 * untrusted (it ships with a cloned repo), so these come from the user config only. The one exception
 * is a provider the user did not define, where a project may repeat the built-in default.
 */
const DEFAULT_PROVIDER_TYPE: Record<string, string> = { foundry: "azure-foundry", vercel: "vercel-ai-gateway", local: "openai-compatible" };

const USER_ONLY_PROVIDER_FIELDS = ["baseUrl", "endpoint", "endpointEnv", "apiKeyEnv", "audience", "projectDir", "envFile", "resourceGroup"] as const;

function isBuiltinDefault(provider: string, field: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (field === "baseUrl") return provider === "vercel" ? value === DEFAULT_VERCEL_GATEWAY_URL : provider === "local" && isLoopbackHttpUrl(value);
  if (field === "audience") return provider === "foundry" && value === DEFAULT_FOUNDRY_AUDIENCE;
  // The sample config's variable name; the endpoint it holds must still be https (foundryConfigFrom).
  if (field === "endpointEnv") return provider === "foundry" && value === "AZURE_AI_ENDPOINT";
  if (field === "projectDir") return provider === "vercel" && value === ".";
  if (field === "envFile") return provider === "vercel" && value === ".env.local";
  return false;
}

function restrictProject(name: string, user: unknown, project: unknown, warnings: string[]): unknown {
  if (!isRecord(project)) return project;
  const out: Record<string, unknown> = { ...project };
  // Accepting an API key loosens the sign-in policy, so only the user can turn it on.
  if ("apiKeyFallback" in out) {
    if (out.apiKeyFallback === true) warnings.push(`Ignored project providers.${name}.apiKeyFallback: only the user config (~/.pi/agent/chef.yaml) can allow an API key.`);
    delete out.apiKeyFallback;
  }
  for (const field of USER_ONLY_PROVIDER_FIELDS) {
    if (!(field in out)) continue;
    const userDefines = isRecord(user);
    const harmless = !userDefines && isBuiltinDefault(name, field, out[field]);
    if (harmless) continue;
    // A user-defined provider that already matches the built-in default needs no warning.
    if (!(userDefines && name !== "local" && isBuiltinDefault(name, field, out[field]))) {
      warnings.push(`Ignored project providers.${name}.${field}: credential and location settings are read from the user config (~/.pi/agent/chef.yaml) only.`);
    }
    delete out[field];
  }
  return out;
}

/**
 * Advisor settings a project may only tighten: switches can only be turned off; limits that raise cost or the data
 * sent take the lower value (the default when the user sets none); a higher ad-hoc threshold means fewer advisor calls.
 */
function restrictAdvisors(user: unknown, project: unknown, warnings: string[]): unknown {
  if (!isRecord(project)) return project;
  const u = isRecord(user) ? user : {};
  const out: Record<string, unknown> = { ...project };
  const drop = (key: string, why: string) => {
    warnings.push(`Ignored project advisors.${key}: ${why}.`);
    delete out[key];
  };
  for (const key of ["tickets", "plan", "summarizeCut"] as const) {
    if (!(key in out)) continue;
    if (out[key] === true) drop(key, "a project can only turn advisors off");
  }
  const base = DEFAULTS.advisors as unknown as Record<string, number>;
  for (const key of ["maxDiffChars", "maxOutputTokens", "timeoutMs", "maxPlanConsults"] as const) {
    if (typeof out[key] !== "number") continue;
    const limit = typeof u[key] === "number" ? u[key] : base[key]!;
    if (out[key] > limit) drop(key, `a project can only lower it (limit ${limit})`);
  }
  if (typeof out.adHocMinLines === "number") {
    const limit = typeof u.adHocMinLines === "number" ? u.adHocMinLines : DEFAULTS.advisors.adHocMinLines;
    if (out.adHocMinLines < limit) drop("adHocMinLines", `a project can only raise it (limit ${limit})`);
  }
  // medium means more advisor calls, so a project can only move it up to high.
  if (out.fromDifficulty === "medium" && (u.fromDifficulty ?? DEFAULTS.advisors.fromDifficulty) === "high") drop("fromDifficulty", "a project can only raise it to high");
  return out;
}

/** The session model and compaction tier are user-config-only; a project may only unpin (`pin: false`). */
function restrictSession(project: unknown, warnings: string[]): unknown {
  if (!isRecord(project)) return project;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(project)) {
    if (key === "pin" && value === false) out.pin = false;
    else warnings.push(`Ignored project session.${key}: ${key === "pin" ? "a project can only set pin: false" : "session settings are read from the user config (~/.pi/agent/chef.yaml) only"}.`);
  }
  return out;
}

/**
 * The routing fields that guard the gating review can only tighten: `reviewTier` is user-only, a project's
 * `requirePremiumReviewFor` adds to the user's list, and `circuitBreakerFailures` takes the lower value.
 */
function restrictRouting(user: unknown, project: unknown, warnings: string[]): unknown {
  if (!isRecord(project)) return project;
  const out: Record<string, unknown> = { ...project };
  const u = isRecord(user) ? user : {};
  if ("reviewTier" in out) {
    if (out.reviewTier !== (u.reviewTier ?? DEFAULTS.routing.reviewTier)) warnings.push("Ignored project routing.reviewTier: the review that gates commits is set in the user config (~/.pi/agent/chef.yaml) only.");
    delete out.reviewTier;
  }
  if (Array.isArray(out.requirePremiumReviewFor)) {
    const base = Array.isArray(u.requirePremiumReviewFor) ? u.requirePremiumReviewFor : DEFAULTS.routing.requirePremiumReviewFor;
    out.requirePremiumReviewFor = [...new Set([...base, ...out.requirePremiumReviewFor])];
  }
  if (typeof out.circuitBreakerFailures === "number") {
    out.circuitBreakerFailures = Math.min(typeof u.circuitBreakerFailures === "number" ? u.circuitBreakerFailures : DEFAULTS.routing.circuitBreakerFailures, out.circuitBreakerFailures);
  }
  return out;
}

/** True when `row` charges less than `floor` for any kind of token (a missing cache rate counts as the input rate). */
function cheaperThan(row: PricingRow, floor: PricingRow): boolean {
  const rates = (r: PricingRow) => [r.inputPerMillionUsd, r.outputPerMillionUsd, r.cacheReadPerMillionUsd ?? r.inputPerMillionUsd, r.cacheWritePerMillionUsd ?? r.inputPerMillionUsd];
  const a = rates(row);
  const b = rates(floor);
  return a.some((rate, i) => rate < b[i]!);
}

/**
 * Layers a project document over a user document. Policy fields follow "user wins / most
 * restrictive"; everything else is merged field-wise with the project overriding.
 */
export function layerConfigs(
  userRaw: Record<string, unknown> | undefined,
  projectRaw: Record<string, unknown> | undefined,
  warnings: string[] = [],
): Record<string, unknown> {
  const user = userRaw ?? {};
  const project = projectRaw ?? {};
  const merged: Record<string, unknown> = { ...user, ...project };
  // Where state, the ledger and metrics live is user-only: a project could move it outside the repo or reset the budget.
  if (project.workspaceDir !== undefined) {
    if (project.workspaceDir !== (user.workspaceDir ?? DEFAULTS.workspaceDir)) warnings.push("Ignored project workspaceDir: it is read from the user config (~/.pi/agent/chef.yaml) only.");
    if (user.workspaceDir !== undefined) merged.workspaceDir = user.workspaceDir;
    else delete merged.workspaceDir;
  }

  for (const key of ["models", "tiers", "routing", "session", "workers", "advisors", "localMode"]) {
    const projectSection =
      key === "advisors"
        ? restrictAdvisors(user.advisors, project.advisors, warnings)
        : key === "session"
          ? restrictSession(project.session, warnings)
          : key === "routing"
            ? restrictRouting(user.routing, project.routing, warnings)
            : project[key];
    const value = mergeSection(user[key], projectSection);
    if (value) merged[key] = value;
    else delete merged[key];
  }
  if (isRecord(user.providers) || isRecord(project.providers)) {
    const providers: Record<string, unknown> = {};
    const u = isRecord(user.providers) ? user.providers : {};
    const p = isRecord(project.providers) ? project.providers : {};
    for (const name of new Set([...Object.keys(u), ...Object.keys(p)])) {
      let entry = mergeSection(u[name], restrictProject(name, u[name], p[name], warnings)) ?? p[name] ?? u[name];
      if (isRecord(entry) && isRecord(u[name]) && isRecord(p[name]) && isRecord(u[name].deployments) && isRecord(p[name].deployments)) {
        // Deployment names merge per model, the project winning, so a project can rename one target without dropping the user's others.
        entry = { ...entry, deployments: { ...u[name].deployments, ...p[name].deployments } };
      }
      if (isRecord(entry) && entry.type === undefined) {
        // Only an account provider (openai, anthropic, xai) with no type is an adjustment such as apiKeyFallback and is
        // not a provider of its own. Foundry, Vercel, and local have no other form, so a missing type is filled in.
        const defaultType = DEFAULT_PROVIDER_TYPE[name];
        if (!defaultType) continue;
        entry = { ...entry, type: defaultType };
      }
      providers[name] = entry;
    }
    merged.providers = providers;
  }

  // Budgets: the lower (stricter) of user and project.
  const ub = isRecord(user.budgets) ? user.budgets : {};
  const pb = isRecord(project.budgets) ? project.budgets : {};
  if (isRecord(user.budgets) || isRecord(project.budgets)) {
    const budgets: Record<string, unknown> = { ...ub, ...pb };
    for (const key of Object.keys(budgets)) {
      if (key === "softWarningRatio" || key === "unknownCallUsd") continue;
      // A project value is compared with the user's, or the default when the user sets none: it can only tighten.
      const base = typeof ub[key] === "number" ? ub[key] : (DEFAULTS.budgets as unknown as Record<string, unknown>)[key];
      if (typeof pb[key] === "number" && typeof base === "number") budgets[key] = Math.min(base, pb[key]);
    }
    // A lower estimate for an unknown-cost call would loosen the budget, so a project can only raise it. A project
    // value is compared with the user's, or the default when the user sets none.
    if (typeof pb.unknownCallUsd === "number") {
      budgets.unknownCallUsd = Math.max(typeof ub.unknownCallUsd === "number" ? ub.unknownCallUsd : DEFAULT_UNKNOWN_CALL_USD, pb.unknownCallUsd);
    }
    // A lower ratio warns earlier, which is the more restrictive choice.
    if (typeof pb.softWarningRatio === "number") {
      budgets.softWarningRatio = Math.min(typeof ub.softWarningRatio === "number" ? ub.softWarningRatio : DEFAULTS.budgets.softWarningRatio, pb.softWarningRatio);
    }
    merged.budgets = budgets;
  }

  // Approvals: a project can never relax them. approvals.publish is gone (/review never pushes); old files still load.
  if ([user.approvals, project.approvals].some((item) => isRecord(item) && item.publish !== undefined)) {
    warnings.push("approvals.publish is no longer used; /review never pushes.");
  }
  merged.approvals = { plan: "required", merge: "manual" };

  // worktrees.* and the worker pool settings are gone (/build runs tickets one at a time on one branch).
  // An old worktrees.branchPrefix still names the branches while branchPrefix is unset.
  if (user.worktrees !== undefined || project.worktrees !== undefined) {
    const old = [project.worktrees, user.worktrees].map((item) => (isRecord(item) ? item.branchPrefix : undefined)).find((item) => typeof item === "string");
    if (merged.branchPrefix === undefined && typeof old === "string") merged.branchPrefix = old;
    warnings.push(`worktrees is no longer used${typeof old === "string" ? "; worktrees.branchPrefix is honored as branchPrefix, so move it to the top level" : ""}.`);
  }
  delete merged.worktrees;
  if (isRecord(merged.workers)) {
    const removed = ["concurrency", "deadlineMs", "isolatedWorktrees", "preserveUntilReviewed"].filter((key) => key in (merged.workers as Record<string, unknown>));
    if (removed.length > 0) {
      warnings.push(`workers.${removed.join("/")} are no longer used (only workers.tokenBudget and workers.ticketContextTokens remain).`);
      merged.workers = Object.fromEntries(Object.entries(merged.workers).filter(([key]) => !removed.includes(key)));
    }
  }
  // commandAllowlist is gone: checks run any non-destructive command. Old files still load.
  if (user.commandAllowlist !== undefined || project.commandAllowlist !== undefined) {
    warnings.push("commandAllowlist is no longer used; checks run any non-destructive command.");
  }
  delete merged.commandAllowlist;
  // The autopilot is gone, and merge stays manual (approvals.merge). Old files still load.
  if (user.autopilot !== undefined || project.autopilot !== undefined) {
    warnings.push("autopilot is no longer used; merge stays manual.");
  }
  delete merged.autopilot;
  for (const source of [user, project]) {
    if (isRecord(source.budgets) && source.budgets.autopilotPrUsd !== undefined) {
      warnings.push("budgets.autopilotPrUsd is no longer used.");
      break;
    }
  }
  if (isRecord(merged.budgets)) delete merged.budgets.autopilotPrUsd;
  // orgProviderAllowlist: an empty list means "all providers", so a project list can only restrict that.
  // Once the user names providers, the user's list is final.
  if (Array.isArray(user.orgProviderAllowlist) && user.orgProviderAllowlist.length > 0) {
    merged.orgProviderAllowlist = user.orgProviderAllowlist;
  }
  merged.proprietaryCode = user.proprietaryCode === true || project.proprietaryCode === true;

  // Pricing: project rows override user rows for the same provider/model/date, but a project row cheaper than any
  // user row for the same provider/model/billing is ignored: a lower price would loosen the user's budgets.
  const userRows = (user.pricing as PricingRow[] | undefined) ?? [];
  const sameModel = (a: PricingRow, b: PricingRow) => a.provider === b.provider && a.model === b.model && (a.billing ?? "") === (b.billing ?? "");
  const rows = new Map<string, PricingRow>();
  for (const row of userRows) rows.set(`${row.provider}\u0000${row.model}\u0000${row.effectiveFrom}\u0000${row.billing ?? ""}`, row);
  for (const row of (project.pricing as PricingRow[] | undefined) ?? []) {
    if (userRows.some((floor) => sameModel(row, floor) && cheaperThan(row, floor))) {
      warnings.push(`Ignored project pricing row for ${row.provider}/${row.model}${row.billing ? ` (${row.billing})` : ""}: it is cheaper than the user config's row, and a project can only raise a price.`);
      continue;
    }
    rows.set(`${row.provider}\u0000${row.model}\u0000${row.effectiveFrom}\u0000${row.billing ?? ""}`, row);
  }
  merged.pricing = [...rows.values()];

  // Quota: ranking preference only (never billing or a budget), so the project wins field by field.
  const uq = isRecord(user.quota) ? user.quota : undefined;
  const pq = isRecord(project.quota) ? project.quota : undefined;
  if (uq || pq) {
    const weights = new Map<string, QuotaWeight>();
    for (const row of [...((uq?.models as QuotaWeight[] | undefined) ?? []), ...((pq?.models as QuotaWeight[] | undefined) ?? [])]) {
      weights.set(`${row.provider}\u0000${row.model}`, row);
    }
    const up = isRecord(uq?.providers) ? uq.providers : {};
    const pp = isRecord(pq?.providers) ? pq.providers : {};
    const providers: Record<string, unknown> = {};
    for (const name of new Set([...Object.keys(up), ...Object.keys(pp)])) providers[name] = mergeSection(up[name], pp[name]);
    merged.quota = { ...uq, ...pq, models: [...weights.values()], providers };
  }
  return merged;
}

/** First existing of `<base>.yaml` / `<base>.yml`; `.yaml` when neither exists. `ignored` is the `.yml` that lost to an existing `.yaml`. */
function pickYaml(base: string): { path: string; exists: boolean; ignored?: string } {
  const yaml = `${base}.yaml`;
  const yml = `${base}.yml`;
  if (existsSync(yaml)) return { path: yaml, exists: true, ignored: existsSync(yml) ? yml : undefined };
  if (existsSync(yml)) return { path: yml, exists: true };
  return { path: yaml, exists: false };
}

/** Config files that loadConfig reads, so callers can watch them for changes. `watch` lists every candidate file. */
export function configPaths(cwd: string): { projectPath: string; userPath: string; legacyUserPath: string; watch: string[] } {
  const agent = path.join(homedir(), ".pi", "agent");
  const project = path.join(cwd, ".pi-workflows", "config");
  const user = path.join(agent, "chef");
  const legacy = path.join(agent, "cost-workflow");
  return {
    projectPath: pickYaml(project).path,
    userPath: pickYaml(user).path,
    legacyUserPath: pickYaml(legacy).path,
    watch: [project, user, legacy].flatMap((base) => [`${base}.yaml`, `${base}.yml`]),
  };
}

/** `~/...` for paths under the home directory, so messages do not print a user name. */
export function displayPath(file: string): string {
  const home = homedir();
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** A config problem that makes a whole file unusable. `file` is the path that was rejected; `reason` is redacted. */
export class ConfigFileError extends WorkflowError {
  constructor(code: string, readonly file: string, readonly reason: string) {
    super(code, reason);
    this.name = "ConfigFileError";
  }
}

/**
 * Reads, parses, and checks one config file. Policy rejections (a secret, a merge that is not manual, a bad provider or
 * budget) and unreadable YAML reject the whole file: they throw a ConfigFileError that names it. Only the sections
 * `normalizeRaw` can drop on their own (a tier, session, or quota section) become warnings.
 */
function readConfigFile(file: string, warnings: string[]): Record<string, unknown> {
  try {
    let parsed: unknown;
    try {
      parsed = parse(readFileSync(file, "utf8"));
    } catch (error) {
      const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unreadable";
      throw new WorkflowError("CONFIG_INVALID", `${displayPath(file)}: YAML could not be read (${first})`);
    }
    return normalizeRaw(parsed, file, warnings, true);
  } catch (error) {
    if (error instanceof ConfigFileError) throw error;
    const code = error instanceof WorkflowError ? error.code : "CONFIG_INVALID";
    throw new ConfigFileError(code, file, redact(error instanceof Error && error.message ? error.message : String(error)));
  }
}

export function loadConfig(cwd: string): WorkflowConfig {
  const { projectPath, userPath: newUserPath, legacyUserPath } = configPaths(cwd);
  const warnings: string[] = [];
  const agent = path.join(homedir(), ".pi", "agent");
  for (const base of [path.join(cwd, ".pi-workflows", "config"), path.join(agent, "chef"), path.join(agent, "cost-workflow")]) {
    const { path: used, ignored } = pickYaml(base);
    if (ignored) warnings.push(`${displayPath(ignored)} is ignored because ${displayPath(used)} exists; delete one of them.`);
  }
  // The user file used to be cost-workflow.yaml: still read when it is the only one, and say to rename it.
  let userPath = newUserPath;
  if (existsSync(legacyUserPath)) {
    const legacyName = path.basename(legacyUserPath);
    if (existsSync(newUserPath)) warnings.push(`~/.pi/agent/${legacyName} is ignored because ~/.pi/agent/${path.basename(newUserPath)} exists; delete the old file.`);
    else {
      userPath = legacyUserPath;
      warnings.push(`Rename ~/.pi/agent/${legacyName} to chef.yaml`);
    }
  }
  const userRaw = existsSync(userPath) ? readConfigFile(userPath, warnings) : undefined;
  const projectRaw = existsSync(projectPath) ? readConfigFile(projectPath, warnings) : undefined;
  if (!userRaw && !projectRaw) return { ...DEFAULTS, providers: { ...DEFAULTS.providers } };
  const where = projectRaw ? projectPath : userPath;
  // Lenient: a bad tier, session, or quota section drops just that section (with a warning naming file and key).
  const config = mergeConfig(layerConfigs(userRaw, projectRaw, warnings), where, warnings, true);
  const unpriced = unpricedTierModels(config);
  if (unpriced.length > 0) {
    warnings.push(`No pricing rows for ${unpriced.join(", ")}: their cost is unknown. Copy the sample .pi-workflows/config.yaml (or run the init command) to price them.`);
  }
  warnings.push(...foundryApiConflicts(config));
  if (warnings.length > 0) config.warnings = warnings;
  if (config.proprietaryCode && config.orgProviderAllowlist.length === 0) {
    throw new WorkflowError(
      "CONFIG_INVALID",
      "proprietaryCode requires orgProviderAllowlist so proprietary tasks cannot reach an unapproved provider.",
    );
  }
  return config;
}

interface PriceIndex {
  length: number;
  byKey: Map<string, { day: string; row: PricingRow }[]>;
}
const priceIndexes = new WeakMap<PricingRow[], PriceIndex>();

function priceKey(provider: string, model: string, billing?: Billing): string {
  return `${provider}\u0000${model}${billing === "api-key" ? "\u0000api-key" : ""}`;
}

function priceIndex(pricing: PricingRow[]): PriceIndex {
  const cached = priceIndexes.get(pricing);
  if (cached && cached.length === pricing.length) return cached;
  const byKey: PriceIndex["byKey"] = new Map();
  pricing.forEach((row) => {
    const day = normalizeEffectiveFrom(row.effectiveFrom);
    if (!day) return;
    const key = priceKey(row.provider, row.model, row.billing);
    const list = byKey.get(key);
    if (list) list.push({ day, row });
    else byKey.set(key, [{ day, row }]);
  });
  // Array.prototype.sort is stable, so among equal dates the later row in the file stays last and wins.
  for (const list of byKey.values()) list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const index = { length: pricing.length, byKey };
  priceIndexes.set(pricing, index);
  return index;
}

/**
 * Newest row for provider+model whose effectiveFrom is on or before `at` (UTC day).
 * Equal effective dates resolve to the later row in the list. The index is built once per array.
 * While the provider is on an API key only `billing: api-key` rows apply; with none the price is unknown
 * (never the subscription's $0).
 */
export function priceFor(
  pricing: PricingRow[],
  provider: string,
  model: string,
  at: Date,
  billing: Billing = billingOf(provider),
): PricingRow | undefined {
  if (Number.isNaN(at.getTime())) return undefined;
  const list = priceIndex(pricing).byKey.get(priceKey(provider, model, billing));
  // A model on your own machine has no per-token charge: an unpriced local model is a known $0, not unknown.
  if (!list) return provider === "local" ? { provider, model, effectiveFrom: "1970-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 } : undefined;
  const day = at.toISOString().slice(0, 10);
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].day <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? undefined : list[lo - 1].row;
}

const MICRO = 1_000_000;

/** USD to integer micro-USD. */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * MICRO);
}

/** Integer micro-USD to a USD number (exactly 6 decimal places of precision). */
export function fromMicroUsd(micro: number): number {
  return micro / MICRO;
}

export function estimateUsd(
  row: PricingRow | undefined,
  usage: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null },
): number | null {
  if (!row) return null;
  if (usage.input === null || usage.output === null) return null;
  const cachePriced = (row.cacheReadPerMillionUsd ?? 0) > 0 || (row.cacheWritePerMillionUsd ?? 0) > 0;
  if (cachePriced && (usage.cacheRead === null || usage.cacheWrite === null)) return null;
  // A row without cache rates bills cache tokens at the input rate, never free.
  // Prices become integer micro-USD per million tokens, so tokens * price is an exact integer
  // sum and dividing by one million yields micro-USD for the call.
  const scaled =
    usage.input * toMicroUsd(row.inputPerMillionUsd) +
    usage.output * toMicroUsd(row.outputPerMillionUsd) +
    (usage.cacheRead ?? 0) * toMicroUsd(row.cacheReadPerMillionUsd ?? row.inputPerMillionUsd) +
    (usage.cacheWrite ?? 0) * toMicroUsd(row.cacheWritePerMillionUsd ?? row.inputPerMillionUsd);
  return fromMicroUsd(Math.round(scaled / MICRO));
}

/**
 * Candidates for a tier: the config's `tiers` list, else the built-in list. Never returns an empty model id.
 * `deterministic` and `advisor` are empty when nothing applies.
 */
export function tierCandidates(config: WorkflowConfig, tier: TierKey): TierCandidate[] {
  const explicit = config.tiers[tier];
  if (explicit) return explicit.filter((candidate) => candidate.model !== "");
  return DEFAULT_TIERS[tier];
}

/** The Azure deployment a Foundry model is called through: its `deployments` entry, else the model name itself. */
export function foundryDeployment(config: WorkflowConfig, model: string): string {
  const mapped = config.providers.foundry?.deployments?.[model];
  return mapped && mapped !== "" ? mapped : model;
}

/** The model name a Foundry deployment stands for (reverse of `foundryDeployment`); the input when no entry maps to it. */
export function foundryModelOf(config: WorkflowConfig, deployment: string): string {
  for (const [model, mapped] of Object.entries(config.providers.foundry?.deployments ?? {})) if (mapped === deployment) return model;
  return deployment;
}

/** The model id Pi knows a candidate by: the deployment name for Foundry, the model itself otherwise. */
export function piModelId(config: WorkflowConfig, provider: string, model: string): string {
  return provider === "foundry" ? foundryDeployment(config, model) : model;
}

/** `provider/model`, plus ` → deployment` when a Foundry mapping applies. Used in route events, labels, /status, and stops. */
export function modelLabel(config: WorkflowConfig, provider: string, model: string): string {
  const id = piModelId(config, provider, model);
  return id === model ? `${provider}/${model}` : `${provider}/${model} → ${id}`;
}

const VERSION_DIGITS = /\d+/g;
const MODEL_FAMILIES = ["gpt", "grok", "claude", "gemini", "llama", "mistral", "qwen", "deepseek", "phi"];

/** Heuristic: the deployment name reads like a different model or version than the key it is mapped from. */
function looksLikeDifferentModel(model: string, deployment: string): boolean {
  const wanted = model.match(VERSION_DIGITS) ?? [];
  const given = deployment.match(VERSION_DIGITS) ?? [];
  if (given.length > 0 && !wanted.every((digits, index) => given[index] === digits)) return true;
  const family = (name: string) => MODEL_FAMILIES.find((item) => new RegExp(`(^|[^a-z])${item}([^a-z]|$)`, "i").test(name));
  const a = family(model);
  const b = family(deployment);
  return !!a && !!b && a !== b;
}

/**
 * Foundry prices follow the deployment first, then the model: a pricing row for the deployment name wins and is also
 * used for the model name; otherwise the model's row is also used for the deployment name. Pi reports usage under the
 * deployment name, so both names must price the same. Warns when a mapped deployment's name suggests a different model.
 */
function applyDeploymentPricing(config: WorkflowConfig, warnings: string[]): void {
  const map = config.providers.foundry?.deployments;
  if (!map) return;
  let rows = config.pricing;
  for (const [model, deployment] of Object.entries(map)) {
    if (model === deployment) continue;
    const depRows = rows.filter((row) => row.provider === "foundry" && row.model === deployment);
    const modelRows = rows.filter((row) => row.provider === "foundry" && row.model === model);
    if (depRows.length > 0) rows = [...rows.filter((row) => !modelRows.includes(row)), ...depRows.map((row) => ({ ...row, model }))];
    else {
      if (modelRows.length > 0) rows = [...rows, ...modelRows.map((row) => ({ ...row, model: deployment }))];
      if (looksLikeDifferentModel(model, deployment)) {
        warnOnce(warnings, `providers.foundry.deployments: ${deployment} is mapped from ${model} but its name suggests a different model or version. Add a pricing row for foundry/${deployment} so its cost is right.`);
      }
    }
  }
  config.pricing = rows;
}

/**
 * The wire API each Foundry deployment is registered with: the first tier candidate that names the deployment decides,
 * and its own `api` (else the provider's) is used. A later candidate for the same deployment that resolves to a
 * different api is ignored, and `conflicts` says so.
 */
export function foundryDeploymentApis(config: WorkflowConfig): { apis: Map<string, ChatApi>; conflicts: string[] } {
  const base: ChatApi = config.providers.foundry?.api ?? "openai-completions";
  const apis = new Map<string, ChatApi>();
  const conflicts: string[] = [];
  for (const tier of TIER_KEYS) {
    for (const candidate of tierCandidates(config, tier)) {
      if (candidate.provider !== "foundry" || !candidate.model) continue;
      const api = candidate.api ?? base;
      const first = apis.get(candidate.model);
      if (first === undefined) apis.set(candidate.model, api);
      else if (first !== api) conflicts.push(`tiers.${tier}: foundry/${candidate.model} asks for api ${api} but ${first} was set by an earlier tier; ${first} is used.`);
    }
  }
  return { apis, conflicts };
}

export function foundryApiConflicts(config: WorkflowConfig): string[] {
  return [...new Set(foundryDeploymentApis(config).conflicts)];
}

/** `provider/model` of every tier candidate that has no pricing row at all (any date, any billing). */
export function unpricedTierModels(config: WorkflowConfig): string[] {
  const priced = new Set(config.pricing.map((row) => `${row.provider}/${row.model}`));
  const out = new Set<string>();
  for (const tier of Object.keys(DEFAULT_TIERS) as TierKey[]) {
    for (const candidate of tierCandidates(config, tier)) {
      const name = `${candidate.provider}/${candidate.model}`;
      if (!priced.has(name) && candidate.provider !== "local") out.add(name);
    }
  }
  return [...out];
}
