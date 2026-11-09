import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { parseModelRef, parseTicketModel, ticketModelProblem, type AgentDef } from "./agents.js";
import { containsSecret, redact } from "./redact.js";
import { WorkflowError } from "./domain.js";

export { parseModelRef };

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

/** One model the local server serves. Pi is told `contextWindow` and `maxTokens`; the planner sizes tickets from `contextWindow`. */
export interface LocalModelConfig {
  id: string;
  contextWindow: number;
  maxTokens?: number;
}

/** The one OpenAI-compatible server, registered with Pi as provider `local`. */
export interface LocalConfig {
  baseUrl: string;
  /** The name of a variable holding the server's key, when it needs one. */
  apiKeyEnv?: string;
  models: LocalModelConfig[];
}

/** Which model builds each ticket difficulty, and which reviews. Each is `provider/id[:thinking]` or `agent:<name>[/<model>]`. */
export interface ModelsConfig {
  low: string;
  medium: string;
  high: string;
  review: string;
}

export const MODEL_KEYS = ["low", "medium", "high", "review"] as const;

export interface WorkflowConfig {
  workspaceDir: string;
  models: ModelsConfig;
  local?: LocalConfig;
  /** Overrides of the built-in agents, and added ones (see agents.ts). */
  agents: Record<string, AgentDef>;
  routing: {
    /** How many rungs (low, medium, high) a failed ticket may climb. */
    maxEscalations: number;
    /**
     * Assistant turns a /build ticket attempt may take (its retries included). At the limit the model is told to wrap
     * up; a few turns later the run is stopped and the ticket fails like a failed check, so it escalates.
     */
    maxTicketTurns: number;
  };
  /** /build names each task's branch `<branchPrefix>/<task name>` (with -2, -3 when taken), always from the default branch. */
  branchPrefix: string;
  budgets: {
    taskUsd: number;
    dailyUsd: number;
    softWarningRatio: number;
    /**
     * Budget math only: what one ledger entry with unknown cost and nothing to price it from (no token counts, or no
     * pricing row) counts as. The ledger keeps `actualUsd: null`.
     */
    unknownCallUsd: number;
    /** Ask before a message re-sends a big context after this many idle minutes (the prompt cache has probably expired). 0 disables. */
    idleWarnMinutes: number;
    /** The idle warning applies only at this many context tokens or more. 0 disables. */
    idleWarnTokens: number;
  };
  checks: CheckConfig[];
  /** Commands /review runs in the repo root before the checks (an install, for example). Same rules as checks. */
  setup: CheckConfig[];
  /**
   * The model pass of /review (`model`): the review model reads the branch diff and lists advisory findings. `tickets: false`
   * turns the per-ticket review gate of /build off. `timeoutMs` is per review call, `maxDiffChars` the diff of one call.
   */
  review: { model: boolean; tickets: boolean; maxDiffChars: number; maxChunks: number; timeoutMs: number };
  pricing: PricingRow[];
  /** Notes from loading, for example settings that were ignored. Shown at session start. */
  warnings?: string[];
}

/** Default for `budgets.unknownCallUsd`. */
export const DEFAULT_UNKNOWN_CALL_USD = 0.05;

/** Used for a `models` key the config leaves out. No prices live here: a model without a `pricing` row has an unknown cost. */
export const DEFAULT_MODELS: ModelsConfig = {
  low: "xai/grok-4.7",
  medium: "anthropic/claude-sonnet-5-5",
  high: "openai/gpt-6.1-sol",
  review: "anthropic/claude-opus-5-5",
};

const DEFAULTS: WorkflowConfig = {
  workspaceDir: ".pi-workflows",
  models: DEFAULT_MODELS,
  agents: {},
  routing: { maxEscalations: 2, maxTicketTurns: 100 },
  branchPrefix: "chef",
  budgets: { taskUsd: 20, dailyUsd: 75, softWarningRatio: 0.8, unknownCallUsd: DEFAULT_UNKNOWN_CALL_USD, idleWarnMinutes: 60, idleWarnTokens: 100_000 },
  checks: [],
  setup: [],
  review: { model: true, tickets: true, maxDiffChars: 120_000, maxChunks: 6, timeoutMs: 300_000 },
  pricing: [],
};

/** The top-level sections and, for the nested ones, the keys inside them. Anything else is ignored with a warning. */
const KNOWN_KEYS: Record<string, readonly string[] | undefined> = {
  models: MODEL_KEYS,
  local: ["baseUrl", "apiKeyEnv", "models"],
  agents: undefined,
  budgets: ["taskUsd", "dailyUsd", "softWarningRatio", "unknownCallUsd", "idleWarnMinutes", "idleWarnTokens"],
  pricing: undefined,
  review: ["model", "tickets", "maxDiffChars", "maxChunks", "timeoutMs"],
  checks: undefined,
  setup: undefined,
  branchPrefix: undefined,
  workspaceDir: undefined,
  routing: ["maxEscalations", "maxTicketTurns"],
};

/** Sections that only the user file may set: a project file ships with a cloned repo and must not choose servers, commands or prices. */
export const USER_ONLY_SECTIONS = ["local", "agents", "pricing", "workspaceDir"] as const;

export const CONFIG_DOCS = "docs/configuration.md";

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
  return value.flatMap((item, index) => {
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
    const key = `${item.provider}\u0000${item.model}\u0000${effectiveFrom}`;
    if (seen.has(key)) invalid(where, field, `duplicates another row for ${item.provider}/${item.model} effective ${effectiveFrom}`);
    seen.add(key);
    return [{ ...(item as unknown as PricingRow), effectiveFrom }];
  });
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

function normalizeAgents(value: unknown, where: string): Record<string, AgentDef> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(where, "agents", "must be a mapping of agent names");
  const out: Record<string, AgentDef> = {};
  for (const [name, def] of Object.entries(value)) {
    const field = `agents.${name}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) invalid(where, field, "is not a valid agent name (letters, digits, - and _)");
    if (!isRecord(def)) invalid(where, field, "must be a mapping with run (and optionally modelFlag)");
    for (const key of Object.keys(def)) if (key !== "run" && key !== "modelFlag") invalid(where, `${field}.${key}`, "is not a known key (run, modelFlag)");
    const run = stringArray(def.run, `${field}.run`, where);
    if (run.length === 0) invalid(where, `${field}.run`, "must name the program to run");
    if (def.modelFlag !== undefined && (typeof def.modelFlag !== "string" || !def.modelFlag.startsWith("-"))) invalid(where, `${field}.modelFlag`, "must be a flag such as --model");
    out[name] = { run, ...(def.modelFlag !== undefined ? { modelFlag: def.modelFlag as string } : {}) };
  }
  return out;
}

function normalizeLocal(value: unknown, where: string): LocalConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalid(where, "local", "must be a mapping");
  if (typeof value.baseUrl !== "string" || value.baseUrl === "") invalid(where, "local.baseUrl", "is required (the server's OpenAI-compatible URL)");
  if (!isHttpsUrl(value.baseUrl) && !isLoopbackHttpUrl(value.baseUrl)) invalid(where, "local.baseUrl", "must be an https URL, or http only for localhost");
  if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv))) {
    invalid(where, "local.apiKeyEnv", "must be an environment variable name");
  }
  if (!Array.isArray(value.models) || value.models.length === 0) invalid(where, "local.models", "must be a non-empty list of { id, contextWindow }");
  const seen = new Set<string>();
  const models = value.models.map((item: unknown, index: number): LocalModelConfig => {
    const field = `local.models[${index}]`;
    if (!isRecord(item)) invalid(where, field, "must be a mapping");
    for (const key of Object.keys(item)) if (key !== "id" && key !== "contextWindow" && key !== "maxTokens") invalid(where, `${field}.${key}`, "is not a known key (id, contextWindow, maxTokens)");
    if (typeof item.id !== "string" || item.id.trim() === "" || /\s/.test(item.id)) invalid(where, `${field}.id`, "must be a non-empty string without spaces");
    if (seen.has(item.id)) invalid(where, `${field}.id`, `duplicates ${item.id}`);
    seen.add(item.id);
    if (typeof item.contextWindow !== "number" || !Number.isInteger(item.contextWindow) || item.contextWindow < 4096) invalid(where, `${field}.contextWindow`, "must be an integer of at least 4096 (what the server runs)");
    if (item.maxTokens !== undefined && (typeof item.maxTokens !== "number" || !Number.isInteger(item.maxTokens) || item.maxTokens < 1024)) invalid(where, `${field}.maxTokens`, "must be an integer of at least 1024");
    return { id: item.id, contextWindow: item.contextWindow, ...(item.maxTokens !== undefined ? { maxTokens: item.maxTokens } : {}) };
  });
  return { baseUrl: value.baseUrl, ...(value.apiKeyEnv !== undefined ? { apiKeyEnv: value.apiKeyEnv as string } : {}), models };
}

/** The dotted names of the keys in `raw` that this version does not read. */
function unknownKeys(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in KNOWN_KEYS)) {
      out.push(key);
      continue;
    }
    const inner = KNOWN_KEYS[key];
    if (inner && isRecord(value)) for (const name of Object.keys(value)) if (!inner.includes(name)) out.push(`${key}.${name}`);
  }
  return out;
}

/**
 * Validates one raw YAML document and returns it with the keys this version does not read removed. Those are added to
 * `ignored`, so a load ends with one warning that lists them all. A model's agent name is checked after layering
 * (`validateModels`), since the project file may name an agent the user file defines.
 */
function normalizeRaw(input: unknown, where: string, ignored: Set<string>): Record<string, unknown> {
  if (!isRecord(input)) throw new WorkflowError("CONFIG_INVALID", `${where} must be a mapping`);
  assertNoSecrets(input, where);
  const out: Record<string, unknown> = {};
  for (const name of unknownKeys(input)) ignored.add(name);
  for (const [key, value] of Object.entries(input)) {
    if (!(key in KNOWN_KEYS) || value === undefined || value === null) continue;
    const inner = KNOWN_KEYS[key];
    out[key] = inner && isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([name]) => inner.includes(name))) : value;
  }

  const models = section(out, "models", where);
  if (models) {
    for (const [key, value] of Object.entries(models)) {
      if (typeof value !== "string") invalid(where, `models.${key}`, "must be provider/id or agent:<name>");
      const problem = ticketModelProblem(value, { agents: undefined }, { anyAgent: true });
      if (problem) invalid(where, `models.${key}`, `is not valid: ${problem}`);
    }
  }
  const routing = section(out, "routing", where);
  if (routing) {
    checkNumber(routing, "maxEscalations", where, { min: 0, integer: true }, "routing");
    checkNumber(routing, "maxTicketTurns", where, { min: 5, integer: true }, "routing");
  }
  if (out.branchPrefix !== undefined && (typeof out.branchPrefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(out.branchPrefix) || out.branchPrefix.endsWith("/") || out.branchPrefix.includes(".."))) {
    invalid(where, "branchPrefix", "must be a plain branch-name prefix such as chef");
  }
  if (out.workspaceDir !== undefined && (typeof out.workspaceDir !== "string" || out.workspaceDir.trim() === "")) invalid(where, "workspaceDir", "must be a non-empty path");
  const budgets = section(out, "budgets", where);
  if (budgets) {
    for (const key of ["taskUsd", "dailyUsd"]) checkNumber(budgets, key, where, { exclusiveMin: 0 }, "budgets");
    checkNumber(budgets, "softWarningRatio", where, { min: 0, max: 1 }, "budgets");
    checkNumber(budgets, "unknownCallUsd", where, { min: 0 }, "budgets");
    for (const key of ["idleWarnMinutes", "idleWarnTokens"]) checkNumber(budgets, key, where, { min: 0, integer: true }, "budgets");
  }
  for (const key of ["checks", "setup"] as const) {
    const list = out[key];
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
  const review = section(out, "review", where);
  if (review) {
    if (review.model !== undefined && typeof review.model !== "boolean") invalid(where, "review.model", "must be a boolean");
    if (review.tickets !== undefined && typeof review.tickets !== "boolean") invalid(where, "review.tickets", "must be a boolean");
    checkNumber(review, "maxDiffChars", where, { min: 1000, integer: true }, "review");
    checkNumber(review, "maxChunks", where, { min: 1, integer: true }, "review");
    checkNumber(review, "timeoutMs", where, { min: 1000, integer: true }, "review");
  }
  const local = normalizeLocal(out.local, where);
  if (local) out.local = local;
  const agents = normalizeAgents(out.agents, where);
  if (agents) out.agents = agents;
  if (out.pricing !== undefined) out.pricing = normalizePricing(out.pricing, where);
  return out;
}

/** The ignored-settings warning: one line for every file read. */
function ignoredWarning(ignored: Set<string>): string[] {
  if (ignored.size === 0) return [];
  return [`Ignored settings that are no longer used: ${[...ignored].join(", ")}. See ${CONFIG_DOCS} for the current settings.`];
}

/** Throws unless every `models` value is valid under the agents the merged config defines. */
function validateModels(config: WorkflowConfig, where: string): void {
  for (const key of MODEL_KEYS) {
    const problem = ticketModelProblem(config.models[key], config);
    if (problem) invalid(where, `models.${key}`, `is not valid: ${problem}`);
  }
}

function build(norm: Record<string, unknown>): WorkflowConfig {
  const obj = (key: string): Record<string, unknown> => (isRecord(norm[key]) ? (norm[key] as Record<string, unknown>) : {});
  const config: WorkflowConfig = {
    workspaceDir: typeof norm.workspaceDir === "string" ? norm.workspaceDir : DEFAULTS.workspaceDir,
    models: { ...DEFAULT_MODELS, ...obj("models") } as ModelsConfig,
    ...(norm.local ? { local: norm.local as LocalConfig } : {}),
    agents: isRecord(norm.agents) ? (norm.agents as Record<string, AgentDef>) : {},
    routing: { ...DEFAULTS.routing, ...obj("routing") } as WorkflowConfig["routing"],
    branchPrefix: typeof norm.branchPrefix === "string" ? norm.branchPrefix : DEFAULTS.branchPrefix,
    budgets: { ...DEFAULTS.budgets, ...obj("budgets") } as WorkflowConfig["budgets"],
    checks: Array.isArray(norm.checks) ? (norm.checks as CheckConfig[]).map((check) => ({ ...check, args: check.args ?? [] })) : DEFAULTS.checks,
    setup: Array.isArray(norm.setup) ? (norm.setup as CheckConfig[]).map((check) => ({ ...check, args: check.args ?? [] })) : DEFAULTS.setup,
    review: { ...DEFAULTS.review, ...obj("review") } as WorkflowConfig["review"],
    pricing: Array.isArray(norm.pricing) ? (norm.pricing as PricingRow[]) : [],
  };
  return config;
}

/** Parses one standalone document into a config (tests, tools). Files on disk go through `loadConfig`, which layers them. */
export function parseConfig(text: string, where = "config"): WorkflowConfig {
  const ignored = new Set<string>();
  const config = build(normalizeRaw(parse(text) ?? {}, where, ignored));
  validateModels(config, where);
  const warnings = [...ignoredWarning(ignored), ...unpricedWarning(config)];
  if (warnings.length > 0) config.warnings = warnings;
  return config;
}

/**
 * Layers a project document over a user document. The user file is the base; a section in the project file replaces
 * the user's whole section. `local`, `agents`, `pricing` and `workspaceDir` are read from the user file only: a
 * project file ships with a cloned repo, and must not choose a server, a command to run, a price, or where the ledger lives.
 */
export function layerConfigs(
  userRaw: Record<string, unknown> | undefined,
  projectRaw: Record<string, unknown> | undefined,
  warnings: string[] = [],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(userRaw ?? {}) };
  const project = projectRaw ?? {};
  const refused: string[] = [];
  for (const [key, value] of Object.entries(project)) {
    if ((USER_ONLY_SECTIONS as readonly string[]).includes(key)) refused.push(key);
    else merged[key] = value;
  }
  if (refused.length > 0) {
    warnings.push(`Ignored project ${refused.join(", ")}: these are read from the user config (~/.pi/agent/chef.yaml) only.`);
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
export function configPaths(cwd: string): { projectPath: string; userPath: string; watch: string[] } {
  const project = path.join(cwd, ".pi-workflows", "config");
  const user = path.join(homedir(), ".pi", "agent", "chef");
  return {
    projectPath: pickYaml(project).path,
    userPath: pickYaml(user).path,
    watch: [project, user].flatMap((base) => [`${base}.yaml`, `${base}.yml`]),
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

/** Reads, parses, and checks one config file. Anything wrong with it (YAML, a secret, a bad value) rejects the whole file: a ConfigFileError that names it. */
function readConfigFile(file: string, ignored: Set<string>): Record<string, unknown> {
  try {
    return readConfigText(readFileSync(file, "utf8"), file, ignored);
  } catch (error) {
    if (error instanceof ConfigFileError) throw error;
    const code = error instanceof WorkflowError ? error.code : "CONFIG_INVALID";
    throw new ConfigFileError(code, file, redact(error instanceof Error && error.message ? error.message : String(error)));
  }
}

function readConfigText(text: string, file: string, ignored: Set<string>): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unreadable";
    throw new WorkflowError("CONFIG_INVALID", `${displayPath(file)}: YAML could not be read (${first})`);
  }
  // An empty file, or one that is all comments (the commented chef.yaml template), is an empty config.
  return normalizeRaw(parsed ?? {}, file, ignored);
}

export function loadConfig(cwd: string): WorkflowConfig {
  const { projectPath, userPath } = configPaths(cwd);
  const warnings: string[] = [];
  for (const base of [path.join(cwd, ".pi-workflows", "config"), path.join(homedir(), ".pi", "agent", "chef")]) {
    const { path: used, ignored } = pickYaml(base);
    if (ignored) warnings.push(`${displayPath(ignored)} is ignored because ${displayPath(used)} exists; delete one of them.`);
  }
  const ignored = new Set<string>();
  const userRaw = existsSync(userPath) ? readConfigFile(userPath, ignored) : undefined;
  const projectRaw = existsSync(projectPath) ? readConfigFile(projectPath, ignored) : undefined;
  if (!userRaw && !projectRaw) return build({});
  const config = build(layerConfigs(userRaw, projectRaw, warnings));
  // A project `models` section replaces the user's whole section, so a model error belongs to the file that set it.
  const where = projectRaw && isRecord(projectRaw.models) ? projectPath : userPath;
  try {
    validateModels(config, displayPath(where));
  } catch (error) {
    throw new ConfigFileError(error instanceof WorkflowError ? error.code : "CONFIG_INVALID", where, redact(error instanceof Error ? error.message : String(error)));
  }
  warnings.push(...ignoredWarning(ignored), ...unpricedWarning(config));
  if (warnings.length > 0) config.warnings = warnings;
  return config;
}

interface PriceIndex {
  length: number;
  byKey: Map<string, { day: string; row: PricingRow }[]>;
}
const priceIndexes = new WeakMap<PricingRow[], PriceIndex>();

function priceKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function priceIndex(pricing: PricingRow[]): PriceIndex {
  const cached = priceIndexes.get(pricing);
  if (cached && cached.length === pricing.length) return cached;
  const byKey: PriceIndex["byKey"] = new Map();
  pricing.forEach((row) => {
    const day = normalizeEffectiveFrom(row.effectiveFrom);
    if (!day) return;
    const key = priceKey(row.provider, row.model);
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
 */
export function priceFor(pricing: PricingRow[], provider: string, model: string, at: Date): PricingRow | undefined {
  if (Number.isNaN(at.getTime())) return undefined;
  const list = priceIndex(pricing).byKey.get(priceKey(provider, model));
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

/** `provider/id` of every Pi model the config uses (the four `models`) that has no pricing row at all. Local models are $0 and agents are not metered. */
export function unpricedConfigModels(config: WorkflowConfig): string[] {
  const priced = new Set(config.pricing.map((row) => `${row.provider}/${row.model}`));
  const out = new Set<string>();
  for (const key of MODEL_KEYS) {
    const model = parseTicketModel(config.models[key], config);
    if (model.kind !== "pi" || model.provider === "local") continue;
    const name = `${model.provider}/${model.id}`;
    if (!priced.has(name)) out.add(name);
  }
  return [...out];
}

function unpricedWarning(config: WorkflowConfig): string[] {
  const unpriced = unpricedConfigModels(config);
  return unpriced.length > 0 ? [`No pricing rows for ${unpriced.join(", ")}: their cost is unknown. Add rows under pricing in ~/.pi/agent/chef.yaml (see ${CONFIG_DOCS}).`] : [];
}
