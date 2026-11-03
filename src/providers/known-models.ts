import type { ChatApi, ProviderId, TierCandidate } from "../domain.js";

/** What Pi needs to drive a model well; the fields mirror Pi's model entry. */
export interface KnownModel {
  /** Matches the model id or tag, case-insensitively. */
  match: RegExp;
  label: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  compat?: Record<string, unknown>;
  /** Pi's reasoning levels for the model: a level mapped to null is one the model refuses, so Pi never sends it. */
  thinkingLevelMap: Record<string, string | null>;
  /**
   * Foundry only: the model needs a Responses wire API. Azure refuses function tools together with `reasoning_effort`
   * on `/v1/chat/completions` for these models ("Function tools with reasoning_effort are not supported"), so a
   * deployment registered as openai-completions fails every turn that has tools.
   */
  responsesOnly?: boolean;
}

/** Local models pi-chef knows how to register, keyed by name. Only provider `local` is matched. */
export const KNOWN_LOCAL_MODELS: readonly KnownModel[] = [
  {
    // Qwen 3.8 27B on llama-server (`--alias Qwen3.8-27B`), a GGUF name, or the Ollama tag. Not 270B, 8B, or another generation.
    match: /^qwen3\.8[-:]27b(?![a-z0-9.])/i,
    label: "Qwen 3.8 27B (local)",
    contextWindow: 131_072,
    maxTokens: 32_768,
    reasoning: true,
    compat: { supportsDeveloperRole: false },
    thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: null },
  },
];

/**
 * OpenAI models on Azure AI Foundry, matched by the tier's model name (not the deployment name `deployments` maps it
 * to). The values are Pi 1.2.0's own Azure catalog entries (`pi-ai/dist/providers/data/azure.json`), which pi-chef's
 * `foundry` provider cannot inherit because Pi sees it as a custom provider.
 */
export const KNOWN_FOUNDRY_MODELS: readonly KnownModel[] = [
  {
    // Astra cannot turn reasoning off and has no minimal level.
    match: /^gpt-6-astra$/i,
    label: "GPT Astra (Foundry)",
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    responsesOnly: true,
  },
  {
    match: /^gpt-6\.1-sol$/i,
    label: "GPT Sol (Foundry)",
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    responsesOnly: true,
  },
  {
    match: /^gpt-6-luna$/i,
    label: "GPT Luna (Foundry)",
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    responsesOnly: true,
  },
];

const PRESETS: Partial<Record<ProviderId, readonly KnownModel[]>> = { local: KNOWN_LOCAL_MODELS, foundry: KNOWN_FOUNDRY_MODELS };

/** The preset for a model of provider `local` or `foundry`, by its tier model name. */
export function knownModel(provider: string, model: string): KnownModel | undefined {
  return PRESETS[provider as ProviderId]?.find((entry) => entry.match.test(model));
}

/**
 * The wire API a Foundry model is registered with: the tier entry's own `api` wins; otherwise the provider default,
 * except that a model that needs Responses moves off openai-completions to openai-responses.
 */
export function foundryApiFor(candidate: TierCandidate, providerApi: ChatApi): ChatApi {
  if (candidate.api) return candidate.api;
  if (providerApi === "openai-completions" && knownModel("foundry", candidate.model)?.responsesOnly) return "openai-responses";
  return providerApi;
}

/** The candidate with the fields it leaves out filled from its preset; a field the candidate sets always wins. */
export function withKnownModel(candidate: TierCandidate): TierCandidate {
  const known = knownModel(candidate.provider, candidate.model);
  if (!known) return candidate;
  return {
    ...candidate,
    label: candidate.label ?? known.label,
    contextWindow: candidate.contextWindow ?? known.contextWindow,
    maxTokens: candidate.maxTokens ?? known.maxTokens,
    reasoning: candidate.reasoning ?? known.reasoning,
  };
}
