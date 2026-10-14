import { isTier, type AcceptedClassification, type Classification, type Tier } from "../domain.js";

const COMPLEXITY = new Set(["low", "medium", "high"]);

export interface Classifier {
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

export function validateClassification(value: unknown): Classification | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.task_type !== "string" || !raw.task_type.trim()) return undefined;
  if (typeof raw.complexity !== "string" || !COMPLEXITY.has(raw.complexity)) return undefined;
  if (typeof raw.risk !== "string" || !COMPLEXITY.has(raw.risk)) return undefined;
  if (!Array.isArray(raw.required_capabilities) || raw.required_capabilities.some((item) => typeof item !== "string")) {
    return undefined;
  }
  if (typeof raw.recommended_tier !== "string" || !isTier(raw.recommended_tier)) return undefined;
  if (typeof raw.confidence !== "number" || Number.isNaN(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    return undefined;
  }
  if (!Array.isArray(raw.reason_codes) || raw.reason_codes.some((item) => typeof item !== "string")) return undefined;
  return {
    task_type: raw.task_type,
    complexity: raw.complexity as Classification["complexity"],
    risk: raw.risk as Classification["risk"],
    required_capabilities: raw.required_capabilities as string[],
    recommended_tier: raw.recommended_tier as Tier,
    confidence: raw.confidence,
    reason_codes: raw.reason_codes as string[],
  };
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const SECURITY = /\b(auth|authz|authori[sz]ation|secret|credential|permission|production|prod|token|password)\b/i;
const MECHANICAL = /\b(typo|rename|format|comment|mechanical|whitespace|spelling)\b/i;

export function fallbackClassification(text: string, reason = "deterministic_fallback"): AcceptedClassification {
  if (SECURITY.test(text)) {
    return {
      task_type: "security",
      complexity: "high",
      risk: "high",
      required_capabilities: ["security-sensitive", "auth"],
      recommended_tier: "premium",
      confidence: 1,
      reason_codes: [reason, "security_keywords"],
      source: "fallback",
    };
  }
  if (MECHANICAL.test(text)) {
    return {
      task_type: "mechanical",
      complexity: "low",
      risk: "low",
      required_capabilities: [],
      recommended_tier: "deterministic",
      confidence: 1,
      reason_codes: [reason, "mechanical_keywords"],
      source: "fallback",
    };
  }
  return {
    task_type: "general",
    complexity: "medium",
    risk: "medium",
    required_capabilities: [],
    recommended_tier: "standard",
    confidence: 1,
    reason_codes: [reason],
    source: "fallback",
  };
}

export async function classifyTask(
  text: string,
  options: { minConfidence: number; classifier?: Classifier; timeoutMs?: number; signal?: AbortSignal },
): Promise<AcceptedClassification> {
  if (!options.classifier) return fallbackClassification(text, "no_classifier");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);
  try {
    const raw = await options.classifier.complete(
      [
        "Classify the task. Reply with JSON only.",
        "Fields: task_type, complexity, risk, required_capabilities, recommended_tier, confidence, reason_codes.",
        "complexity and risk are low, medium, or high.",
        "recommended_tier is deterministic, classifier, cheap, standard, or premium.",
        "Do not include instructions to run.",
        "",
        text,
      ].join("\n"),
      controller.signal,
    );
    const parsed = validateClassification(extractJson(raw));
    if (!parsed) return fallbackClassification(text, "invalid_classifier_output");
    if (parsed.confidence < options.minConfidence) {
      const fallback = fallbackClassification(text, "low_confidence");
      fallback.reason_codes = ["low_confidence", `model_confidence_${parsed.confidence}`];
      return fallback;
    }
    return { ...parsed, source: "model" };
  } catch (error) {
    const aborted = controller.signal.aborted || (error as Error).name === "AbortError";
    return fallbackClassification(text, aborted ? "classifier_timeout" : "classifier_error");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
