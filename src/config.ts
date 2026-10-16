import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { containsSecret } from "./redact.js";
import { WorkflowError, PROVIDERS, TIERS, TIER_KEYS, TICKET_TIERS, isAccountProvider, isProviderId, isTier, type ProviderId, type Tier, type TierCandidate, type TierKey } from "./domain.js";

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
  /** Foundry: literal resource endpoint (not a secret) used when `endpointEnv` is unset. */
  endpoint?: string;
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
  /** Legacy one-provider-per-tier map. Used for any tier that `tiers` does not list. */
  models: Record<"cheap" | "standard" | "premium", ProviderId>;
  /** Candidate models per tier, in preference order for ties. Overrides `models` for the tiers it lists. */
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
  };
  /** The main chat session: a normal Pi model, pinned at session start, with compaction on a cheap tier. */
  session: SessionConfig;
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
    securitySensitiveFix: "required";
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
   * advisor packet or a review part, the batch tier writes a one-line summary of each cut file.
   */
  advisors: { timeoutMs: number; maxDiffChars: number; maxOutputTokens: number; tickets: boolean; plan: boolean; adHocMinLines: number; summarizeCut: boolean; maxPlanConsults: number };
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

const DEFAULTS: WorkflowConfig = {
  schemaVersion: 1,
  workspaceDir: ".pi-workflows",
  providers: {},
  models: { cheap: "foundry", standard: "anthropic", premium: "openai" },
  tiers: {},
  routing: {
    maxEscalations: 3,
    maxTier: "premium",
    reviewTier: "premium",
    requirePremiumReviewFor: ["auth", "permissions", "secrets", "security-sensitive"],
    circuitBreakerFailures: 3,
    attemptOverheadUsd: 0.02,
  },
  session: DEFAULT_SESSION,
  workers: {
    tokenBudget: 8000,
    ticketContextTokens: 150000,
  },
  branchPrefix: "cost",
  budgets: { taskUsd: 20, dailyUsd: 75, softWarningRatio: 0.8, unknownCallUsd: DEFAULT_UNKNOWN_CALL_USD },
  approvals: { plan: "required", merge: "manual", securitySensitiveFix: "required" },
  checks: [],
  setup: [],
  review: { model: true, maxDiffChars: 120_000, maxChunks: 6, timeoutMs: 300_000 },
  advisors: { timeoutMs: 180_000, maxDiffChars: 40_000, maxOutputTokens: 1500, tickets: true, plan: true, adHocMinLines: 400, summarizeCut: true, maxPlanConsults: 2 },
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

function isHttpsUrl(value: string): boolean {
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
function dropLegacy(raw: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (isRecord(out.providers)) {
    const providers: Record<string, unknown> = {};
    for (const [name, provider] of Object.entries(out.providers)) {
      if (isRecord(provider) && "decisionsPath" in provider) {
        warnOnce(warnings, `providers.${name}.decisionsPath is no longer used; the Decisions classifier is gone.`);
        const { decisionsPath: _gone, ...rest } = provider;
        providers[name] = rest;
      } else providers[name] = provider;
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
function normalizeRaw(input: unknown, where: string, warnings: string[] = []): Record<string, unknown> {
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
    for (const [key, list] of Object.entries(tiers)) {
      if (!(TIER_KEYS as readonly string[]).includes(key)) invalid(where, `tiers.${key}`, `is not a known tier (${TIER_KEYS.join(", ")})`);
      if (!Array.isArray(list) || list.length === 0) invalid(where, `tiers.${key}`, "must be a non-empty list of candidates");
      list.forEach((item, index) => {
        const field = `tiers.${key}[${index}]`;
        if (!isRecord(item)) invalid(where, field, "must be a mapping");
        if (typeof item.provider !== "string" || !isProviderId(item.provider)) {
          invalid(where, `${field}.provider`, `must be one of ${PROVIDERS.join(", ")}`);
        }
        if (typeof item.model !== "string" || item.model.trim() === "") invalid(where, `${field}.model`, "must be a non-empty string");
        if (item.api !== undefined && item.api !== "chat") invalid(where, `${field}.api`, 'must be "chat"');
        if (item.label !== undefined && typeof item.label !== "string") invalid(where, `${field}.label`, "must be a string");
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
  }
  const session = section(raw, "session", where);
  if (session) {
    if (session.model !== undefined && (typeof session.model !== "string" || !parseModelRef(session.model))) invalid(where, "session.model", "must be provider/id, for example anthropic/claude-opus-5-5");
    if (session.pin !== undefined && typeof session.pin !== "boolean") invalid(where, "session.pin", "must be true or false");
    if (session.compactionTier !== undefined && (typeof session.compactionTier !== "string" || !CHAT_TIER_NAMES.includes(session.compactionTier))) {
      invalid(where, "session.compactionTier", `must be one of ${CHAT_TIER_NAMES.join(", ")}`);
    }
  }
  const workers = section(raw, "workers", where);
  if (workers) {
    checkNumber(workers, "tokenBudget", where, { exclusiveMin: 0 }, "workers");
    checkNumber(workers, "ticketContextTokens", where, { min: 20000, integer: true }, "workers");
  }
  if (raw.branchPrefix !== undefined && (typeof raw.branchPrefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw.branchPrefix) || raw.branchPrefix.endsWith("/") || raw.branchPrefix.includes(".."))) {
    invalid(where, "branchPrefix", "must be a plain branch-name prefix such as cost");
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
  }
  if (raw.orgProviderAllowlist !== undefined) {
    const list = stringArray(raw.orgProviderAllowlist, "orgProviderAllowlist", where);
    for (const id of list) if (!isProviderId(id)) invalid(where, "orgProviderAllowlist", `contains unknown provider ${id}`);
  }
  if (raw.proprietaryCode !== undefined && typeof raw.proprietaryCode !== "boolean") {
    invalid(where, "proprietaryCode", "must be a boolean");
  }
  out.pricing = normalizePricing(raw.pricing, where);
  const quota = normalizeQuota(raw.quota, where);
  if (quota) out.quota = quota;
  return out;
}

const MODEL_KEYS = ["cheap", "standard", "premium"] as const;

/**
 * Cross-checks a resolved config: tier models must reference configured providers, and each
 * referenced provider must name a model so pricing and calls never use an empty id.
 */
export function validateResolvedConfig(config: WorkflowConfig, where = "config"): void {
  for (const [key, list] of Object.entries(config.tiers)) {
    list?.forEach((candidate, index) => {
      if (!config.providers[candidate.provider]) {
        invalid(where, `tiers.${key}[${index}].provider`, `references provider "${candidate.provider}" which is not defined under providers`);
      }
    });
  }
  // With no provider configured nothing routes, as with no config file at all.
  if (Object.keys(config.providers).length === 0) return;
  for (const key of MODEL_KEYS) {
    if (config.tiers[key]) continue;
    const provider = config.models[key];
    if (!config.providers[provider]) {
      invalid(where, `models.${key}`, `references provider "${provider}" which is not defined under providers`);
    }
    const tier: Tier = key;
    if (!modelNameFor(config, provider, tier)) {
      const hint = provider === "foundry" ? "providers.foundry.deployments" : `providers.${provider}.model`;
      invalid(where, hint, `must name a model because models.${key} uses ${provider}`);
    }
  }
}

function build(norm: Record<string, unknown>): WorkflowConfig {
  const obj = (key: string): Record<string, unknown> => (isRecord(norm[key]) ? (norm[key] as Record<string, unknown>) : {});
  return {
    ...DEFAULTS,
    providers: { ...DEFAULTS.providers, ...obj("providers") } as WorkflowConfig["providers"],
    models: { ...DEFAULTS.models, ...obj("models") } as WorkflowConfig["models"],
    tiers: normalizeTiers(obj("tiers")),
    routing: { ...DEFAULTS.routing, ...obj("routing") } as WorkflowConfig["routing"],
    session: { ...DEFAULTS.session, ...obj("session") } as WorkflowConfig["session"],
    workers: { ...DEFAULTS.workers, ...obj("workers") } as WorkflowConfig["workers"],
    branchPrefix: typeof norm.branchPrefix === "string" ? norm.branchPrefix : DEFAULTS.branchPrefix,
    budgets: { ...DEFAULTS.budgets, ...obj("budgets") } as WorkflowConfig["budgets"],
    approvals: {
      ...DEFAULTS.approvals,
      ...obj("approvals"),
      plan: "required",
      merge: "manual",
      securitySensitiveFix: "required",
    } as WorkflowConfig["approvals"],
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
      return candidate;
    });
  }
  return out;
}

function mergeConfig(raw: unknown, where: string, warnings: string[] = []): WorkflowConfig {
  const norm = normalizeRaw(raw, where, warnings);
  const config = build(norm);
  // A standalone document that spells out both providers and models must be self-consistent.
  // Partial overlays are cross-checked after layering in loadConfig.
  if (isRecord(norm.providers) && Object.keys(norm.providers).length > 0 && (isRecord(norm.models) || isRecord(norm.tiers))) {
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
const USER_ONLY_PROVIDER_FIELDS = ["baseUrl", "endpoint", "apiKeyEnv", "audience", "projectDir", "envFile"] as const;

function isBuiltinDefault(provider: string, field: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (field === "baseUrl") return provider === "vercel" ? value === DEFAULT_VERCEL_GATEWAY_URL : provider === "local" && isLoopbackHttpUrl(value);
  if (field === "audience") return provider === "foundry" && value === DEFAULT_FOUNDRY_AUDIENCE;
  if (field === "projectDir") return provider === "vercel" && value === ".";
  if (field === "envFile") return provider === "vercel" && value === ".env.local";
  return false;
}

function restrictProject(name: string, user: unknown, project: unknown, warnings: string[]): unknown {
  if (!isRecord(project)) return project;
  const out: Record<string, unknown> = { ...project };
  // Accepting an API key loosens the sign-in policy, so only the user can turn it on.
  if ("apiKeyFallback" in out) {
    if (out.apiKeyFallback === true) warnings.push(`Ignored project providers.${name}.apiKeyFallback: only the user config (~/.pi/agent/cost-workflow.yaml) can allow an API key.`);
    delete out.apiKeyFallback;
  }
  for (const field of USER_ONLY_PROVIDER_FIELDS) {
    if (!(field in out)) continue;
    const userDefines = isRecord(user);
    const harmless = !userDefines && isBuiltinDefault(name, field, out[field]);
    if (harmless) continue;
    // A user-defined provider that already matches the built-in default needs no warning.
    if (!(userDefines && name !== "local" && isBuiltinDefault(name, field, out[field]))) {
      warnings.push(`Ignored project providers.${name}.${field}: credential and location settings are read from the user config (~/.pi/agent/cost-workflow.yaml) only.`);
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
  return out;
}

/** The session model and compaction tier are user-config-only; a project may only unpin (`pin: false`). */
function restrictSession(project: unknown, warnings: string[]): unknown {
  if (!isRecord(project)) return project;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(project)) {
    if (key === "pin" && value === false) out.pin = false;
    else warnings.push(`Ignored project session.${key}: ${key === "pin" ? "a project can only set pin: false" : "session settings are read from the user config (~/.pi/agent/cost-workflow.yaml) only"}.`);
  }
  return out;
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

  for (const key of ["models", "tiers", "routing", "session", "workers", "advisors"]) {
    const projectSection = key === "advisors" ? restrictAdvisors(user.advisors, project.advisors, warnings) : key === "session" ? restrictSession(project.session, warnings) : project[key];
    const value = mergeSection(user[key], projectSection);
    if (value) merged[key] = value;
    else delete merged[key];
  }
  if (isRecord(user.providers) || isRecord(project.providers)) {
    const providers: Record<string, unknown> = {};
    const u = isRecord(user.providers) ? user.providers : {};
    const p = isRecord(project.providers) ? project.providers : {};
    for (const name of new Set([...Object.keys(u), ...Object.keys(p)])) {
      const entry = mergeSection(u[name], restrictProject(name, u[name], p[name], warnings)) ?? p[name] ?? u[name];
      // A user entry with no type only adjusts a provider defined elsewhere (for example apiKeyFallback). With
      // nothing under it, it is not a provider of its own.
      if (isRecord(entry) && entry.type === undefined) continue;
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
  merged.approvals = {
    plan: "required",
    merge: "manual",
    securitySensitiveFix: "required",
  };

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

  // Pricing: project rows override user rows for the same provider/model/date.
  const rows = new Map<string, PricingRow>();
  for (const row of [...((user.pricing as PricingRow[] | undefined) ?? []), ...((project.pricing as PricingRow[] | undefined) ?? [])]) {
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

/** Config files that loadConfig reads, so callers can watch them for changes. */
export function configPaths(cwd: string): { projectPath: string; userPath: string } {
  return {
    projectPath: path.join(cwd, ".pi-workflows", "config.yaml"),
    userPath: path.join(homedir(), ".pi", "agent", "cost-workflow.yaml"),
  };
}

export function loadConfig(cwd: string): WorkflowConfig {
  const { projectPath, userPath } = configPaths(cwd);
  const warnings: string[] = [];
  const userRaw = existsSync(userPath) ? normalizeRaw(parse(readFileSync(userPath, "utf8")), userPath, warnings) : undefined;
  const projectRaw = existsSync(projectPath) ? normalizeRaw(parse(readFileSync(projectPath, "utf8")), projectPath, warnings) : undefined;
  if (!userRaw && !projectRaw) return { ...DEFAULTS, providers: { ...DEFAULTS.providers } };
  const where = projectRaw ? projectPath : userPath;
  const config = mergeConfig(layerConfigs(userRaw, projectRaw, warnings), where);
  validateResolvedConfig(config, where);
  // An old config lists tiers but no ticket tiers: /build then runs low, medium and high tickets on cheap, standard and premium.
  if (Object.keys(config.tiers).length > 0) {
    const missing = TICKET_TIERS.filter((tier) => !config.tiers[tier]);
    if (missing.length > 0) {
      warnings.push(`tiers.${missing.join("/")} not set: /build uses cheap, standard and premium for low, medium and high tickets. Add ticketLow, ticketMedium and ticketHigh under tiers to pick the models.`);
    }
  }
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
  if (!list) return undefined;
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
 * Candidates for a tier: the explicit `tiers` list when present, else the legacy `models` entry as a
 * single candidate. `deterministic` and `advisor` have no legacy entry, so they are empty unless listed.
 */
export function tierCandidates(config: WorkflowConfig, tier: TierKey): TierCandidate[] {
  const explicit = config.tiers[tier];
  if (explicit) return explicit;
  if (tier === "deterministic" || tier === "advisor") return [];
  // Standalone jobs run on the direct tier's models when the config has no batch list.
  if (tier === "batch") return tierCandidates(config, "cheap");
  // Ticket tiers missing from an older config run on the general tier of the same strength.
  if (tier === "ticketLow" || tier === "ticketMedium" || tier === "ticketHigh") {
    return tierCandidates(config, tier === "ticketLow" ? "cheap" : tier === "ticketMedium" ? "standard" : "premium");
  }
  const provider = config.models[tier];
  return [{ provider, model: modelNameFor(config, provider, tier) }];
}

/** Model id used for pricing lookup. Missing ids stay unresolved so the charge is unknown. */
export function modelNameFor(config: WorkflowConfig, provider: ProviderId, tier: Tier): string {
  if (provider === "foundry") {
    const deployments = config.providers.foundry?.deployments;
    if (tier === "cheap" || tier === "deterministic") {
      return deployments?.cheap ?? deployments?.classifier ?? "";
    }
    return deployments?.reasoning ?? "";
  }
  return config.providers[provider]?.model ?? "";
}
