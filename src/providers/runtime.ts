import type { LocalConfig } from "../config.js";
import { redact } from "../redact.js";
import { knownLocalModel } from "./known-models.js";

/** The Pi provider name of the `local` section. */
export const LOCAL_PROVIDER = "local";

interface RegisterApi {
  registerProvider(name: string, config: unknown): void;
}

/** One `local.models` entry as Pi's `registerProvider` takes it. A preset (Qwen 3.8 27B) adds what the server needs from Pi. */
function modelEntry(item: LocalConfig["models"][number]) {
  const known = knownLocalModel(item.id);
  return {
    id: item.id,
    name: known?.label ?? item.id,
    input: ["text" as const],
    reasoning: known?.reasoning ?? false,
    // A local model has no per-token charge; spend is priced in the ledger ($0 unless a pricing row says otherwise).
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: item.contextWindow,
    maxTokens: item.maxTokens ?? known?.maxTokens ?? 8_192,
    // What the server needs from Pi (no developer role, the reasoning levels it accepts) comes only from a preset, never from config.
    ...(known?.compat ? { compat: known.compat } : {}),
    ...(known ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
  };
}

/** The registration Pi gets for the `local` section: an OpenAI-compatible server and its models. */
export function localProviderConfig(local: LocalConfig) {
  return {
    name: "Local (OpenAI-compatible)",
    baseUrl: local.baseUrl,
    api: "openai-completions" as const,
    // Pi resolves "$NAME" (or "${NAME}") from the environment when it makes a request, so no key is held here. With
    // no variable named the server needs none, and Pi still wants a value to treat the provider as configured.
    apiKey: local.apiKeyEnv ? `$${local.apiKeyEnv}` : "local",
    models: local.models.map(modelEntry),
  };
}

/**
 * Registers the `local` section with Pi as provider "local" so the registry can resolve its models. Returns the names
 * registered (none without a `local` section). A refusal throws, unless `errors` is given: then it gets one redacted line.
 */
export function registerLocalProvider(pi: RegisterApi, local: LocalConfig | undefined, errors?: string[]): string[] {
  if (!local) return [];
  try {
    pi.registerProvider(LOCAL_PROVIDER, localProviderConfig(local));
    return [LOCAL_PROVIDER];
  } catch (error) {
    if (!errors) throw error;
    errors.push(`provider ${LOCAL_PROVIDER} could not be registered with Pi: ${redact(error instanceof Error && error.message ? error.message : String(error))}`);
    return [];
  }
}
