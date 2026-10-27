import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowConfig } from "../config.js";
import { DEFAULT_FOUNDRY_AUDIENCE, DEFAULT_VERCEL_GATEWAY_URL, foundryDeployment, foundryDeploymentApis, isHttpsUrl, tierCandidates } from "../config.js";
import { redact } from "../redact.js";
import { assertCommandSafe } from "../sandbox.js";
import { TIER_KEYS, WorkflowError, type ProviderId, type TierCandidate } from "../domain.js";
import { FileAuthProbe, type AuthProbe } from "./auth.js";
import { foundryV1Base, type FoundryConfig } from "./clients.js";
import { createVercelTokenSource, type VercelTokenSource } from "./vercel.js";
import { knownModel } from "./local-models.js";

const exec = promisify(execFile);

export const VERCEL_GATEWAY_URL = DEFAULT_VERCEL_GATEWAY_URL;
export const FOUNDRY_DEFAULT_AUDIENCE = DEFAULT_FOUNDRY_AUDIENCE;
const LOCAL_PROBE_TTL_MS = 30_000;
const LOCAL_PROBE_TIMEOUT_MS = 800;

/** Cached `GET <baseUrl>/models` with a short timeout. Any HTTP answer below 500 counts as reachable. */
export function createReachabilityProbe(options: { baseUrl: string; fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number; timeoutMs?: number }): () => Promise<boolean> {
  const now = options.now ?? Date.now;
  let cached: { at: number; ok: boolean } | undefined;
  return async () => {
    if (cached && now() - cached.at < (options.ttlMs ?? LOCAL_PROBE_TTL_MS)) return cached.ok;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS);
    let ok = false;
    try {
      const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl.replace(/\/+$/, "")}/models`, { signal: controller.signal });
      ok = response.status < 500;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    cached = { at: now(), ok };
    return ok;
  };
}

/** Foundry endpoint and wire settings from config and the environment. */
export function foundryConfigFrom(config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env): FoundryConfig {
  const provider = config.providers.foundry;
  const endpoint = (provider?.endpointEnv ? env[provider.endpointEnv] : undefined) ?? provider?.endpoint;
  if (!endpoint) {
    throw new WorkflowError("CONFIG_INVALID", `Foundry endpoint is not set. Export ${provider?.endpointEnv ?? "the endpointEnv variable"} or set providers.foundry.endpoint.`);
  }
  // The az token is sent here, so an endpoint from the environment must be https like one from the config.
  if (!isHttpsUrl(endpoint)) throw new WorkflowError("CONFIG_INVALID", `Foundry endpoint must be an https URL (from ${provider?.endpointEnv && env[provider.endpointEnv] ? provider.endpointEnv : "providers.foundry.endpoint"}).`);
  return {
    endpoint,
    apiVersion: provider?.apiVersion,
    audience: provider?.audience ?? FOUNDRY_DEFAULT_AUDIENCE,
    api: provider?.api ?? "openai-completions",
    style: provider?.routeStyle ?? (provider?.apiVersion ? "deployments" : "v1"),
  };
}

export interface ProviderRuntime {
  auth: AuthProbe;
  vercel?: VercelTokenSource;
}

export async function runAz(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  assertCommandSafe("az", args);
  try {
    const { stdout, stderr } = await exec("az", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    if (failed.code === "ENOENT") return { code: 127, stdout: "", stderr: "az is not on PATH" };
    return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message ?? "" };
  }
}

export interface RuntimeOverrides {
  azure?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  vercelRun?: (args: string[], cwd: string) => Promise<void>;
  now?: () => number;
}

/** Real probes and clients for the configured providers. Tests pass overrides; nothing here reads a secret into config. */
export function createRuntime(config: WorkflowConfig, root: string, overrides: RuntimeOverrides = {}): ProviderRuntime {
  const azure = overrides.azure ?? runAz;
  const vercelConfig = config.providers.vercel;
  const vercel = vercelConfig
    ? createVercelTokenSource({ root, projectDir: vercelConfig.projectDir, envFile: vercelConfig.envFile, env: overrides.env, run: overrides.vercelRun, now: overrides.now })
    : undefined;
  const local = config.providers.local;
  const localReachable = local?.baseUrl ? createReachabilityProbe({ baseUrl: local.baseUrl, fetchImpl: overrides.fetchImpl, now: overrides.now }) : undefined;
  const auth = new FileAuthProbe({
    azure,
    localReachable,
    vercel: vercel ? () => vercel.status() : undefined,
    vercelRefresh: vercel ? () => vercel.getToken() : undefined,
    apiKeyFallback: (provider) => config.providers[provider]?.apiKeyFallback === true,
    now: overrides.now,
  });
  return { auth, vercel };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface RegisterApi {
  registerProvider(name: string, config: unknown): void;
}

function modelEntry(provider: string, id: string, item: TierCandidate, api?: string) {
  const known = knownModel(provider, id);
  return {
    ...(api ? { api } : {}),
    id,
    name: item.label ?? id,
    input: ["text" as const],
    reasoning: item.reasoning ?? false,
    // Prices are tracked in the ledger's pricing rows, not in Pi's catalog.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: item.contextWindow ?? 128_000,
    maxTokens: item.maxTokens ?? 8_192,
    // What the server needs from Pi (no developer role, reasoning levels) comes only from a preset, never from config.
    ...(known ? { compat: known.compat, thinkingLevelMap: known.thinkingLevelMap } : {}),
  };
}

/**
 * Registers Foundry, Vercel AI Gateway, and local chat models with Pi so the registry can resolve them.
 * Credentials come from `!command` values Pi runs at request time (Azure CLI token, the pulled Vercel
 * env file), so no token is held in this process or written to config.
 */
export function registerChatProviders(
  pi: RegisterApi,
  config: WorkflowConfig,
  runtime: Pick<ProviderRuntime, "vercel">,
  env: NodeJS.ProcessEnv = process.env,
  /** When given, receives one redacted line per provider that Pi refused and the others are still registered; else the first failure throws. */
  errors?: string[],
): string[] {
  const registered: string[] = [];
  const register = (name: string, value: unknown) => {
    try {
      pi.registerProvider(name, value);
      registered.push(name);
    } catch (error) {
      if (!errors) throw error;
      errors.push(`provider ${name} could not be registered with Pi: ${redact(error instanceof Error && error.message ? error.message : String(error))}`);
    }
  };
  const chatModels = new Map<ProviderId, TierCandidate[]>();
  for (const tier of TIER_KEYS) {
    for (const candidate of tierCandidates(config, tier)) {
      if (!candidate.model) continue;
      const list = chatModels.get(candidate.provider) ?? [];
      const sameTarget = (item: TierCandidate) => (candidate.provider === "foundry" ? foundryDeployment(config, item.model) === foundryDeployment(config, candidate.model) : item.model === candidate.model);
      if (!list.some(sameTarget)) list.push(candidate);
      chatModels.set(candidate.provider, list);
    }
  }
  const foundry = config.providers.foundry;
  const foundryModels = chatModels.get("foundry");
  if (foundry && foundryModels?.length) {
    let endpoint: string | undefined;
    try {
      endpoint = foundryConfigFrom(config, env).endpoint;
    } catch {
      endpoint = undefined;
    }
    if (endpoint) {
      const providerApi = foundry.api ?? "openai-completions";
      const { apis } = foundryDeploymentApis(config);
      const audience = foundry.audience ?? FOUNDRY_DEFAULT_AUDIENCE;
      register("foundry", {
        name: "Azure AI Foundry",
        baseUrl: foundryV1Base(endpoint),
        api: providerApi,
        apiKey: `!az account get-access-token --resource ${shellQuote(audience)} --query accessToken -o tsv`,
        // Per-model api only where it differs from the provider's. The registry chat resolves the api from here.
        // The id Pi calls is the Azure deployment name (the model name unless providers.foundry.deployments maps it).
        models: foundryModels.map((item) => {
          const api = apis.get(item.model);
          return modelEntry("foundry", foundryDeployment(config, item.model), item, api && api !== providerApi ? api : undefined);
        }),
      });
    }
  }
  const vercel = config.providers.vercel;
  const vercelModels = chatModels.get("vercel");
  const envFile = runtime.vercel?.envFilePath();
  if (vercel && vercelModels?.length && envFile) {
    register("vercel", {
      name: "Vercel AI Gateway (CLI auth)",
      baseUrl: vercel.baseUrl ?? VERCEL_GATEWAY_URL,
      api: "openai-completions",
      // Reads the token that `vercel env pull` wrote; the auth probe refreshes that file when routing checks Vercel.
      apiKey: `!sed -n 's/^VERCEL_OIDC_TOKEN="\\{0,1\\}\\([^"]*\\)"\\{0,1\\}$/\\1/p' ${shellQuote(envFile)}`,
      models: vercelModels.map((item) => modelEntry("vercel", item.model, item)),
    });
  }
  const local = config.providers.local;
  const localModels = chatModels.get("local");
  if (local?.baseUrl && localModels?.length) {
    register("local", {
      name: "Local (OpenAI-compatible)",
      baseUrl: local.baseUrl,
      api: "openai-completions",
      apiKey: local.apiKeyEnv ? `$${local.apiKeyEnv}` : "local",
      models: localModels.map((item) => modelEntry("local", item.model, item)),
    });
  }
  return registered;
}
