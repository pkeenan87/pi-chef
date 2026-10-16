import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowConfig } from "../config.js";
import { DEFAULT_FOUNDRY_AUDIENCE, DEFAULT_VERCEL_GATEWAY_URL, tierCandidates } from "../config.js";
import { redact } from "../redact.js";
import { TIER_KEYS, WorkflowError, type ProviderId, type TierCandidate } from "../domain.js";
import { FileAuthProbe, type AuthProbe } from "./auth.js";
import { foundryV1Base, type FoundryConfig } from "./clients.js";
import { createVercelTokenSource, type VercelTokenSource } from "./vercel.js";

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
  try {
    const { stdout, stderr } = await exec("az", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
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

function modelEntry(id: string, label: string | undefined) {
  return {
    id,
    name: label ?? id,
    input: ["text" as const],
    reasoning: false,
    // Prices are tracked in the ledger's pricing rows, not in Pi's catalog.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/**
 * Registers Foundry, Vercel AI Gateway, and local chat models with Pi so the registry can resolve them.
 * Credentials come from `!command` values Pi runs at request time (Azure CLI token, the pulled Vercel
 * env file), so no token is held in this process or written to config.
 */
export function registerChatProviders(pi: RegisterApi, config: WorkflowConfig, runtime: Pick<ProviderRuntime, "vercel">, env: NodeJS.ProcessEnv = process.env): string[] {
  const registered: string[] = [];
  const chatModels = new Map<ProviderId, TierCandidate[]>();
  for (const tier of TIER_KEYS) {
    for (const candidate of tierCandidates(config, tier)) {
      if (!candidate.model) continue;
      const list = chatModels.get(candidate.provider) ?? [];
      if (!list.some((item) => item.model === candidate.model)) list.push(candidate);
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
      const audience = foundry.audience ?? FOUNDRY_DEFAULT_AUDIENCE;
      pi.registerProvider("foundry", {
        name: "Azure AI Foundry",
        baseUrl: foundryV1Base(endpoint),
        api: "openai-completions",
        apiKey: `!az account get-access-token --resource ${shellQuote(audience)} --query accessToken -o tsv`,
        models: foundryModels.map((item) => modelEntry(item.model, item.label)),
      });
      registered.push("foundry");
    }
  }
  const vercel = config.providers.vercel;
  const vercelModels = chatModels.get("vercel");
  const envFile = runtime.vercel?.envFilePath();
  if (vercel && vercelModels?.length && envFile) {
    pi.registerProvider("vercel", {
      name: "Vercel AI Gateway (CLI auth)",
      baseUrl: vercel.baseUrl ?? VERCEL_GATEWAY_URL,
      api: "openai-completions",
      // Reads the token that `vercel env pull` wrote; the router refreshes that file before it selects a Vercel model.
      apiKey: `!sed -n 's/^VERCEL_OIDC_TOKEN="\\{0,1\\}\\([^"]*\\)"\\{0,1\\}$/\\1/p' ${shellQuote(envFile)}`,
      models: vercelModels.map((item) => modelEntry(item.model, item.label)),
    });
    registered.push("vercel");
  }
  const local = config.providers.local;
  const localModels = chatModels.get("local");
  if (local?.baseUrl && localModels?.length) {
    pi.registerProvider("local", {
      name: "Local (OpenAI-compatible)",
      baseUrl: local.baseUrl,
      api: "openai-completions",
      apiKey: local.apiKeyEnv ? `$${local.apiKeyEnv}` : "local",
      models: localModels.map((item) => modelEntry(item.model, item.label)),
    });
    registered.push("local");
  }
  return registered;
}
