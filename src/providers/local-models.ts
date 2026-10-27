import type { TierCandidate } from "../domain.js";

/** What Pi needs to drive a local model well; the fields mirror Pi's model entry. */
export interface KnownModel {
  /** Matches the model id or tag, case-insensitively. */
  match: RegExp;
  label: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  compat: Record<string, unknown>;
  thinkingLevelMap: Record<string, string | null>;
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

/** The preset for a model, for provider `local` only. */
export function knownModel(provider: string, model: string): KnownModel | undefined {
  if (provider !== "local") return undefined;
  return KNOWN_LOCAL_MODELS.find((entry) => entry.match.test(model));
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
