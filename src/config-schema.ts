/**
 * One table of every key the config loader reads, for tools that show or edit the config (the chef-config CLI
 * and the herdr panel). It mirrors docs/configuration.md; tests/config-schema.test.ts keeps the two, the sample
 * user config (templates/chef.yaml) and the loader's built-in defaults in step. It reads no files.
 */

import { ACCOUNT_PROVIDERS, CHAT_APIS, PROVIDERS, THINKING_LEVELS, TIERS, TIER_KEYS } from "./domain.js";

export type SchemaType =
  | "bool"
  | "int"
  | "number"
  | "usd"
  | "ms"
  | "enum"
  | "string"
  | "path"
  | "modelRef"
  | "list"
  | "object-list"
  | "map";

/**
 * How the project file layers over the user file for a key (docs/configuration.md, "How the files layer").
 * `user-wins`: the user's value wins, but a project's is used when the user sets none (`tiers.local`).
 * `off-or-raise`: a project 0 always turns the feature off, even over a higher user value; a project nonzero is
 * dropped when the user has 0 or a higher value, so it never turns the feature on or tightens it (`advisors.watchdogEvery`).
 */
export type SchemaRule =
  | "project-wins"
  | "merged"
  | "replaced"
  | "lower-wins"
  | "higher-wins"
  | "off-only"
  | "user-only"
  | "restricts-only"
  | "user-wins"
  | "off-or-raise"
  | "adds-to"
  | "fixed";

export interface SchemaKey {
  /** Dotted path. `*` stands for any provider or tier name; `[]` marks an entry of a list. */
  key: string;
  section: string;
  type: SchemaType;
  /** Allowed values of an `enum`, or of the items of a `list`. */
  enum?: string[];
  min?: number;
  max?: number;
  /** True when `min` is exclusive (`> min`). */
  exclusiveMin?: boolean;
  /** The built-in default; undefined when the key has none. */
  default?: unknown;
  /** False when the default applies at a different place than the loaded config (provider, tier and row keys). */
  inConfig?: false;
  rule: SchemaRule;
  description: string;
}

type Init = Omit<SchemaKey, "key" | "section" | "type" | "rule" | "description">;

const KEYS: SchemaKey[] = [];

function add(section: string, key: string, type: SchemaType, rule: SchemaRule, description: string, extra: Init = {}): void {
  KEYS.push({ key, section, type, rule, description, ...extra });
}

const TIER_NAMES: string[] = [...TIER_KEYS];
const PROVIDER_NAMES: string[] = [...PROVIDERS];
const CHAT_API_NAMES: string[] = [...CHAT_APIS];
const NOT_LOADED = { inConfig: false } as const;

// Top level
add("Top level", "workspaceDir", "path", "user-only", "Where task state, the cost ledger, metrics and reports live, relative to the project root", { default: ".pi-workflows" });
add("Top level", "branchPrefix", "string", "project-wins", "/build creates <branchPrefix>/<task name> from the default branch for every new build", { default: "chef" });
add("Top level", "isolation.worktree", "bool", "user-only", "/build works in a git worktree per task; false works in the main checkout", { default: true });
add("Top level", "isolation.dir", "path", "user-only", "Where the worktrees go, relative to the project; empty means ../<repo>.worktrees", { default: "" });
add("Top level", "isolation.runner", "enum", "user-only", "How /build runs a ticket: in a subagent session beside yours, by replacing your session per ticket, or as its own pi process in a herdr tab", { enum: ["subagent", "session", "herdr"], default: "subagent" });
add("Top level", "isolation.herdrCommand", "string", "user-only", "The herdr CLI that isolation.runner: herdr calls (a command name or path)", { default: "hc" });
add("Top level", "orgProviderAllowlist", "list", "restricts-only", "Providers any route or advisor may use; empty means all", { enum: PROVIDER_NAMES, default: [] });
add("Top level", "proprietaryCode", "bool", "restricts-only", "Marks the code proprietary: only allowlisted providers may see it (on if either file sets it; needs orgProviderAllowlist)", { default: false });
add("Top level", "checks", "object-list", "replaced", "Commands that verify work: run by /review, and by /build for a ticket with no checks of its own", { default: [] });
add("Top level", "setup", "object-list", "replaced", "Commands that run once per build before the first checks, and before every /review's checks", { default: [] });
add("Top level", "schemaVersion", "int", "fixed", "Accepted and ignored", { default: 1 });
for (const list of ["checks", "setup"]) {
  add("Top level", `${list}[].name`, "string", "replaced", "Label in reports", NOT_LOADED);
  add("Top level", `${list}[].command`, "string", "replaced", "The program, on PATH or a path", NOT_LOADED);
  add("Top level", `${list}[].args`, "list", "replaced", "Its arguments", NOT_LOADED);
}

// session
add("session", "session.model", "modelRef", "user-only", "The session's model (provider/id), set at session start when pin is on", { default: "anthropic/claude-opus-5-5" });
add("session", "session.pin", "bool", "off-only", "Switch the session to session.model at session start; false leaves the model you chose with /model", { default: true });
add("session", "session.compactionTier", "enum", "user-only", "Tier that writes compaction summaries", { enum: ["cheap", "standard", "premium"], default: "cheap" });

// localMode
add("localMode", "localMode.default", "bool", "merged", "Make every /plan local, unless --cloud is passed", { default: false });
add("localMode", "localMode.difficulties", "list", "merged", "A hybrid local plan: only tickets of these difficulties go to the local model (capped by its size)", { enum: ["low", "medium"] });

// workers
add("workers", "workers.tokenBudget", "number", "merged", "The tokens one call is priced at when ranking models", { min: 0, exclusiveMin: true, default: 8000 });
add("workers", "workers.ticketContextTokens", "int", "merged", "The context size one cloud ticket must fit", { min: 20000, default: 150000 });

// budgets
add("budgets", "budgets.taskUsd", "usd", "lower-wins", "Hard limit on one task's spend", { min: 0, exclusiveMin: true, default: 20 });
add("budgets", "budgets.dailyUsd", "usd", "lower-wins", "Hard limit on all spend today", { min: 0, exclusiveMin: true, default: 75 });
add("budgets", "budgets.softWarningRatio", "number", "lower-wins", "Warn once a budget reaches this share; above it, advisors and batch summaries are skipped", { min: 0, max: 1, default: 0.8 });
add("budgets", "budgets.unknownCallUsd", "usd", "higher-wins", "What one call with an unknown cost counts as, in budget math only", { min: 0, default: 0.05 });

// approvals
add("approvals", "approvals.plan", "enum", "fixed", "A plan must be approved before /build; cannot be changed", { enum: ["required"], default: "required" });
add("approvals", "approvals.merge", "enum", "fixed", "Nothing merges, pushes or opens a PR; any other value rejects the file", { enum: ["manual"], default: "manual" });

// routing
add("routing", "routing.selection", "enum", "merged", "How a tier picks its model: first usable entry, or lowest expected cost per success", { enum: ["ordered", "adaptive"], default: "ordered" });
add("routing", "routing.maxEscalations", "int", "merged", "Tier steps a failed ticket may climb from its difficulty tier", { min: 0, default: 3 });
add("routing", "routing.maxTier", "enum", "merged", "The highest tier any route may use", { enum: TIERS.filter((t) => t !== "batch"), default: "premium" });
add("routing", "routing.reviewTier", "enum", "user-only", "Tier of the per-ticket review that gates each commit, and of /review's model pass", { enum: ["cheap", "standard", "premium"], default: "premium" });
add("routing", "routing.requirePremiumReviewFor", "list", "adds-to", "Task types and capabilities whose review always runs on premium and that need confirmation before /build", { default: ["auth", "permissions", "secrets", "security-sensitive"] });
add("routing", "routing.circuitBreakerFailures", "int", "lower-wins", "Failures with no success, per task type and tier, that open the tier's circuit", { min: 1, default: 3 });
add("routing", "routing.maxTicketTurns", "int", "lower-wins", "Assistant turns one /build ticket attempt may take before it fails", { min: 5, default: 100 });
add("routing", "routing.attemptOverheadUsd", "usd", "merged", "Ranking only, in adaptive selection: added to each model's price before dividing by its success rate", { min: 0, default: 0.02 });

// tiers
for (const tier of TIER_NAMES) {
  add("tiers", `tiers.${tier}`, "object-list", tier === "local" ? "user-wins" : "replaced", `Candidate models of the ${tier} tier, in preference order${tier === "local" ? " (the user's list wins; a project's is used only when the user names none)" : "; a project's list replaces the user's for this tier"}`, NOT_LOADED);
}
add("tiers", "tiers.*[].provider", "enum", "merged", "Who serves the model", { enum: PROVIDER_NAMES, ...NOT_LOADED });
add("tiers", "tiers.*[].model", "string", "merged", "The model id (for Foundry, the model name; providers.foundry.deployments maps it to a deployment)", NOT_LOADED);
add("tiers", "tiers.*[].label", "string", "merged", "Display name in reports", NOT_LOADED);
add("tiers", "tiers.*[].api", "enum", "merged", "Foundry only: the wire API for this deployment, overriding providers.foundry.api", { enum: CHAT_API_NAMES, ...NOT_LOADED });
add("tiers", "tiers.*[].contextWindow", "int", "merged", "The context window Pi is told", { min: 4096, default: 128000, ...NOT_LOADED });
add("tiers", "tiers.*[].maxTokens", "int", "merged", "The output-token limit Pi is told", { min: 1024, default: 8192, ...NOT_LOADED });
add("tiers", "tiers.*[].reasoning", "bool", "merged", "A thinking model: Pi sends it reasoning levels", { default: false, ...NOT_LOADED });
add("tiers", "tiers.*[].thinking", "enum", "merged", "The thinking level a /build ticket on this model runs at", { enum: [...THINKING_LEVELS], ...NOT_LOADED });

// providers
add("providers", "providers.*.type", "string", "merged", "Informational", NOT_LOADED);
add("providers", "providers.*.auth", "string", "merged", "account-login for openai, anthropic and xai; azure-cli for foundry; vercel-cli for vercel", NOT_LOADED);
add("providers", "providers.*.model", "string", "merged", "Used only by the deprecated models: map", NOT_LOADED);
add("providers", "providers.*.piProvider", "string", "merged", "Accepted and ignored", NOT_LOADED);
for (const p of ACCOUNT_PROVIDERS) {
  add("providers", `providers.${p}.apiKeyFallback`, "bool", "user-only", "Use an API key saved in Pi when no account login is present (billed per token)", { default: false, ...NOT_LOADED });
}
add("providers", "providers.foundry.endpoint", "string", "user-only", "The resource endpoint (https URL)", NOT_LOADED);
add("providers", "providers.foundry.endpointEnv", "string", "user-only", "A variable holding the endpoint; wins over endpoint. AZURE_AI_ENDPOINT is the sample's name; the loader applies none until you define the foundry block", NOT_LOADED);
add("providers", "providers.foundry.audience", "string", "user-only", "The token audience az account get-access-token is asked for", { default: "https://ai.azure.com", ...NOT_LOADED });
add("providers", "providers.foundry.api", "enum", "merged", "Default wire API for every deployment", { enum: CHAT_API_NAMES, default: "openai-completions", ...NOT_LOADED });
add("providers", "providers.foundry.deployments", "map", "merged", "Maps a tier model name to your Azure deployment name (merged per model)", NOT_LOADED);
add("providers", "providers.foundry.routeStyle", "enum", "merged", "v1: <endpoint>/openai/v1/…; deployments: the legacy per-deployment route. The default is v1, or deployments when apiVersion is set", { enum: ["v1", "deployments"], default: "v1", ...NOT_LOADED });
add("providers", "providers.foundry.apiVersion", "string", "merged", "api-version for the legacy deployments route", NOT_LOADED);
add("providers", "providers.foundry.resourceGroup", "string", "user-only", "Lets /status foundry list your deployments", NOT_LOADED);
add("providers", "providers.vercel.projectDir", "path", "user-only", "A directory you ran vercel link in; vercel env pull runs there", NOT_LOADED);
add("providers", "providers.vercel.envFile", "path", "user-only", "The file vercel env pull writes the token to, and Pi reads it from", { default: ".env.local", ...NOT_LOADED });
add("providers", "providers.vercel.baseUrl", "string", "user-only", "The gateway URL (https)", { default: "https://ai-gateway.vercel.sh/v1", ...NOT_LOADED });
add("providers", "providers.local.baseUrl", "string", "user-only", "The OpenAI-compatible server (required); http only for localhost", NOT_LOADED);
add("providers", "providers.local.apiKeyEnv", "string", "user-only", "A variable holding the server's key, if it needs one", NOT_LOADED);

// review
add("review", "review.model", "bool", "replaced", "Run the advisory model pass of /review", { default: true });
add("review", "review.maxDiffChars", "int", "replaced", "The diff size of one review call; a larger diff is split at file boundaries", { min: 1000, default: 120000 });
add("review", "review.maxChunks", "int", "replaced", "At most this many calls; the parts beyond them are listed as not reviewed", { min: 1, default: 6 });
add("review", "review.timeoutMs", "ms", "replaced", "Per call", { min: 1000, default: 300000 });

// advisors
add("advisors", "advisors.tickets", "bool", "off-only", "The per-ticket review in /build; false turns the review gate and its advisors off", { default: true });
add("advisors", "advisors.plan", "bool", "off-only", "plan_consult: advisors read the draft tickets once per plan version", { default: true });
add("advisors", "advisors.fromDifficulty", "enum", "restricts-only", "The lowest ticket difficulty that gets advisors (a project can only raise it to high)", { enum: ["medium", "high"], default: "high" });
add("advisors", "advisors.adHocMinLines", "int", "higher-wins", "With fromDifficulty: medium, a branch with no plan gets an advisor in /review above this many changed lines", { min: 0, default: 400 });
add("advisors", "advisors.summarizeCut", "bool", "off-only", "When a diff is clipped for an advisor, the batch tier summarizes each cut file", { default: true });
add("advisors", "advisors.maxPlanConsults", "int", "lower-wins", "Plan consults per draft version", { min: 1, default: 2 });
add("advisors", "advisors.tools", "bool", "off-only", "Advisors run as short read-only Pi sessions in the repository", { default: false });
add("advisors", "advisors.watchdogEvery", "int", "off-or-raise", "Mid-ticket watchdog: check the diff every N assistant turns; 0 is off (a project can turn it off or raise it)", { min: 0, default: 0 });
add("advisors", "advisors.maxDiffChars", "int", "lower-wins", "The diff sent to the reviewer and advisors", { min: 1000, default: 40000 });
add("advisors", "advisors.maxOutputTokens", "int", "lower-wins", "The answer length an advisor is asked to stay within", { min: 100, default: 1500 });
add("advisors", "advisors.timeoutMs", "ms", "lower-wins", "Per advisor or review call", { min: 1000, default: 180000 });

// pricing
add("pricing", "pricing", "object-list", "merged", "Prices per million tokens; rows from both files are combined", { default: [] });
add("pricing", "pricing[].provider", "string", "merged", "Provider of the priced model", NOT_LOADED);
add("pricing", "pricing[].model", "string", "merged", "The priced model (for Foundry, a deployment name row wins over the model name row)", NOT_LOADED);
add("pricing", "pricing[].effectiveFrom", "string", "merged", "YYYY-MM-DD the row applies from", NOT_LOADED);
add("pricing", "pricing[].inputPerMillionUsd", "usd", "merged", "Input price per million tokens", { min: 0, ...NOT_LOADED });
add("pricing", "pricing[].outputPerMillionUsd", "usd", "merged", "Output price per million tokens", { min: 0, ...NOT_LOADED });
add("pricing", "pricing[].cacheReadPerMillionUsd", "usd", "merged", "Cache read price; defaults to the input rate", { min: 0, ...NOT_LOADED });
add("pricing", "pricing[].cacheWritePerMillionUsd", "usd", "merged", "Cache write price; defaults to the input rate", { min: 0, ...NOT_LOADED });
add("pricing", "pricing[].billing", "enum", "merged", "api-key prices the model while its provider runs on an API key", { enum: ["api-key"], ...NOT_LOADED });

// quota
add("quota", "quota.models", "object-list", "merged", "Ranking-only price per million tokens for a subscription model; merged by provider and model", { default: [] });
add("quota", "quota.models[].provider", "string", "merged", "Provider of the model", NOT_LOADED);
add("quota", "quota.models[].model", "string", "merged", "The model", NOT_LOADED);
add("quota", "quota.models[].perMillionTokensUsd", "usd", "merged", "Shadow price per million tokens", { min: 0, ...NOT_LOADED });
add("quota", "quota.providers.*.dailyTokens", "int", "merged", "A soft daily token cap", { min: 0, exclusiveMin: true, ...NOT_LOADED });
add("quota", "quota.providers.*.weeklyTokens", "int", "merged", "A soft weekly token cap", { min: 0, exclusiveMin: true, ...NOT_LOADED });
add("quota", "quota.overCapMultiplier", "number", "merged", "Multiplies a provider's shadow prices once it is at or over a cap", { min: 1, default: 4 });

/** Every config key, in the order of docs/configuration.md. */
export const CONFIG_SCHEMA: readonly SchemaKey[] = KEYS;

/** The sections, in the order of docs/configuration.md. */
export const CONFIG_SECTIONS: readonly string[] = [...new Set(KEYS.map((k) => k.section))];

/** The schema entry for a concrete dotted path (`providers.foundry.api`, `tiers.ticketLow[].model`), if any. */
export function schemaFor(key: string): SchemaKey | undefined {
  const exact = KEYS.find((k) => k.key === key);
  if (exact) return exact;
  const parts = key.split(".");
  return KEYS.find((k) => {
    const want = k.key.split(".");
    // `*` matches any one name; `*[]` matches any `<name>[]`.
    return want.length === parts.length && want.every((part, i) => part === "*" || part === parts[i] || (part === "*[]" && parts[i]!.endsWith("[]")));
  });
}
