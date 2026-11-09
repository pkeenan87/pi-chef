/** What Pi needs to drive a model well; the fields mirror Pi's model entry. */
export interface KnownModel {
  /** Matches the model id or tag, case-insensitively. */
  match: RegExp;
  label: string;
  maxTokens: number;
  reasoning: boolean;
  compat?: Record<string, unknown>;
  /** Pi's reasoning levels for the model: a level mapped to null is one the model refuses, so Pi never sends it. */
  thinkingLevelMap: Record<string, string | null>;
}

/** Local models pi-chef knows how to register, matched on the id in `local.models`. A preset fills what the entry leaves out. */
export const KNOWN_LOCAL_MODELS: readonly KnownModel[] = [
  {
    // Qwen 3.8 27B on llama-server (`--alias Qwen3.8-27B`), a GGUF name, or the Ollama tag. Not 270B, 8B, or another generation.
    match: /^qwen3\.8[-:]27b(?![a-z0-9.])/i,
    label: "Qwen 3.8 27B (local)",
    maxTokens: 32_768,
    reasoning: true,
    compat: { supportsDeveloperRole: false },
    thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: null },
  },
];

/** The preset for a model of the `local` server, by its id. */
export function knownLocalModel(id: string): KnownModel | undefined {
  return KNOWN_LOCAL_MODELS.find((entry) => entry.match.test(id));
}
