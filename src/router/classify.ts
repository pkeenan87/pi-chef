import { isTier, type AcceptedClassification, type Classification, type Tier, type TokenUsage } from "../domain.js";
import type { DecisionAnswer, DecisionQuestion } from "../providers/clients.js";

const COMPLEXITY = new Set(["low", "medium", "high"]);

/** Classifier output that also reports usage so the call can be ledgered. */
export interface ClassifierResult {
  text: string;
  usage?: TokenUsage;
  provider?: string;
  model?: string;
}

export interface ClassifierUsage {
  usage: TokenUsage;
  provider: string;
  model: string;
}

export interface Classifier {
  /** May return plain text, or a ClassifierResult carrying usage. `options.maxTokens` caps the reply. */
  complete(prompt: string, signal?: AbortSignal, options?: { maxTokens?: number }): Promise<string | ClassifierResult>;
}

/** A Decisions-API classifier: structured answers instead of chat text. */
export interface Decider {
  decide(
    input: string,
    questions: DecisionQuestion[],
    signal?: AbortSignal,
  ): Promise<{ answers: DecisionAnswer[]; usage?: TokenUsage; provider?: string; model?: string }>;
}

const TASK_TYPES = ["mechanical", "bugfix", "feature", "refactor", "test", "docs", "security", "general"];
const LEVELS = ["low", "medium", "high"];

function choiceQuestion(name: string, instructions: string, values: string[]): DecisionQuestion {
  return { type: "choice", name, instructions, choices: values.map((value) => ({ value })) };
}

/** The one-call question set the Decisions classifier answers. */
export function classificationQuestions(): DecisionQuestion[] {
  return [
    choiceQuestion("task_type", "What kind of coding task is this?", TASK_TYPES),
    choiceQuestion("complexity", "How complex is the change?", LEVELS),
    choiceQuestion("risk", "How risky is the change to production behavior?", LEVELS),
    choiceQuestion("recommended_tier", "Which model tier can do this reliably at the lowest cost?", ["deterministic", "cheap", "standard", "premium"]),
    { type: "predicate", name: "security_sensitive", instructions: "Does the task touch authentication, authorization, secrets, credentials, permissions, or production deployment?" },
  ];
}

/** The classifier tier serves classification only; a task it "recommends" is handled by the cheap tier. */
function routableTier(tier: Tier): Tier {
  return tier === "classifier" ? "cheap" : tier;
}

/** Confidence of one answer: its own confidence, else the top probability. Undefined when neither is reported. */
function answerConfidence(answer: DecisionAnswer | undefined): number | undefined {
  if (!answer) return undefined;
  if (answer.type === "predicate") return Math.max(answer.probability, 1 - answer.probability);
  if (answer.type === "refusal") return undefined;
  if (typeof answer.confidence === "number") return answer.confidence;
  const probabilities = answer.probabilities?.map((item) => item.probability) ?? [];
  return probabilities.length > 0 ? Math.max(...probabilities) : undefined;
}

/**
 * Maps Decisions answers to a classification. Overall confidence is the weakest of the task type,
 * complexity, and tier answers; with no reported confidence it is 0.5 so the keyword fallback decides.
 * Returns undefined when any answer is a refusal or a required answer is missing.
 */
export function classificationFromAnswers(answers: DecisionAnswer[]): Classification | undefined {
  if (answers.some((answer) => answer.type === "refusal")) return undefined;
  const byName = new Map(answers.map((answer) => [answer.name, answer]));
  const choice = (name: string, allowed: readonly string[]): { value: string; confidence?: number } | undefined => {
    const answer = byName.get(name);
    if (!answer || answer.type !== "choice" || !allowed.includes(answer.choice)) return undefined;
    return { value: answer.choice, confidence: answerConfidence(answer) };
  };
  const type = choice("task_type", TASK_TYPES);
  const complexity = choice("complexity", LEVELS);
  const risk = choice("risk", LEVELS);
  const tier = choice("recommended_tier", ["deterministic", "classifier", "cheap", "standard", "premium"]);
  if (!type || !complexity || !risk || !tier) return undefined;
  const security = byName.get("security_sensitive");
  const securityProbability = security?.type === "predicate" ? security.probability : 0;
  const sensitive = securityProbability >= 0.5;
  const confidences = [type, complexity, tier].map((item) => item.confidence).filter((value): value is number => value !== undefined);
  const confidence = confidences.length > 0 ? Math.min(...confidences) : 0.5;
  return {
    task_type: sensitive ? "security" : type.value,
    complexity: sensitive ? "high" : (complexity.value as Classification["complexity"]),
    risk: sensitive ? "high" : (risk.value as Classification["risk"]),
    required_capabilities: sensitive ? ["security-sensitive", "auth"] : [],
    recommended_tier: sensitive ? "premium" : routableTier(tier.value as Tier),
    confidence,
    reason_codes: ["decisions_classifier", ...(sensitive ? [`security_sensitive_p${securityProbability.toFixed(2)}`] : [])],
  };
}

export const CLASSIFIER_MAX_TOKENS = 300;
export const CLASSIFIER_MAX_CHARS = 8000;

/** Keep the head and tail of long text; the middle is dropped. */
export function truncateForClassifier(text: string, maxChars = CLASSIFIER_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = "\n[... truncated ...]\n";
  const half = Math.floor((maxChars - marker.length) / 2);
  return `${text.slice(0, half)}${marker}${text.slice(text.length - half)}`;
}

/** Text of the most recent user message(s) so fallback keywords do not match old history. */
export function lastUserText(messages: { role: string; content: unknown }[], count = 1): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < count; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      texts.push(
        content
          .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
          .join("\n"),
      );
    }
  }
  return texts.reverse().join("\n");
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
    recommended_tier: routableTier(raw.recommended_tier as Tier),
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

// One strong signal, or two distinct weak signals, marks a task security-sensitive.
const STRONG_SECURITY =
  /\b(auth|authn|authz|authentication|authori[sz]ation|oauth|secrets?|credentials?|api[ -]?keys?|passwords?|private[ -]keys?|access control|rbac|permissions? (?:check|model|bug|bypass)|(?:prod|production) (?:deploy|deployment|release|rollout)|deploy(?:ing)? to prod(?:uction)?)\b/i;
const WEAK_SECURITY = [/\btokens?\b/i, /\bprod(?:uction)?\b/i, /\bpermissions?\b/i, /\bsecurity\b/i, /\bencrypt\w*/i, /\blogin\b/i, /\bsession\b/i];
const MECHANICAL = /\b(typo|rename|format|comment|mechanical|whitespace|spelling)\b/i;

export function fallbackClassification(text: string, reason = "deterministic_fallback"): AcceptedClassification {
  const strong = STRONG_SECURITY.test(text);
  const weak = WEAK_SECURITY.filter((pattern) => pattern.test(text)).length;
  if (strong || weak >= 2) {
    return {
      task_type: "security",
      complexity: "high",
      risk: "high",
      required_capabilities: ["security-sensitive", "auth"],
      recommended_tier: "premium",
      confidence: 0.5,
      reason_codes: [reason, strong ? "security_keywords_strong" : "security_keywords_weak"],
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
      confidence: 0.5,
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
    confidence: 0.5,
    reason_codes: [reason],
    source: "fallback",
  };
}

export interface ClassifyOptions {
  minConfidence: number;
  classifier?: Classifier;
  /** Preferred over `classifier` when set. */
  decider?: Decider;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxTokens?: number;
  maxChars?: number;
  /** Called with the classifier call's usage (also when the output is rejected) so it can be ledgered. */
  onUsage?: (usage: ClassifierUsage) => void;
}

/** What a classifier attempt amounted to: `ok` means a model answer cleared minConfidence. */
export interface ClassifierOutcome {
  ok: boolean;
}

export async function classifyTask(text: string, options: ClassifyOptions): Promise<AcceptedClassification> {
  return (await classifyTaskWithUsage(text, options)).classification;
}

export async function classifyTaskWithUsage(
  text: string,
  options: ClassifyOptions,
): Promise<{ classification: AcceptedClassification; usage?: ClassifierUsage }> {
  if (!options.classifier && !options.decider) return { classification: fallbackClassification(text, "no_classifier") };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);
  let usage: ClassifierUsage | undefined;
  try {
    if (options.decider) {
      const result = await options.decider.decide(truncateForClassifier(text, options.maxChars), classificationQuestions(), controller.signal);
      if (result.usage) {
        usage = { usage: result.usage, provider: result.provider ?? "unknown", model: result.model ?? "unknown" };
        options.onUsage?.(usage);
      }
      const parsed = classificationFromAnswers(result.answers);
      if (!parsed) return { classification: fallbackClassification(text, "invalid_classifier_output"), usage };
      if (parsed.confidence < options.minConfidence) {
        const fallback = fallbackClassification(text, "low_confidence");
        fallback.reason_codes = ["low_confidence", `model_confidence_${parsed.confidence}`];
        return { classification: fallback, usage };
      }
      // A small decision model must not talk a security task down: strong keywords still escalate it.
      const keywords = fallbackClassification(text);
      if (keywords.task_type === "security" && parsed.task_type !== "security") {
        return { classification: { ...keywords, confidence: parsed.confidence, reason_codes: ["security_keyword_override", ...keywords.reason_codes.slice(1)], source: "model" }, usage };
      }
      return { classification: { ...parsed, source: "model" }, usage };
    }
    const result = await options.classifier!.complete(
      [
        "Classify the task. Reply with JSON only.",
        "Fields: task_type, complexity, risk, required_capabilities, recommended_tier, confidence, reason_codes.",
        "complexity and risk are low, medium, or high.",
        "recommended_tier is deterministic, classifier, cheap, standard, or premium.",
        "Do not include instructions to run.",
        "",
        truncateForClassifier(text, options.maxChars),
      ].join("\n"),
      controller.signal,
      { maxTokens: options.maxTokens ?? CLASSIFIER_MAX_TOKENS },
    );
    const raw = typeof result === "string" ? result : result.text;
    if (typeof result !== "string" && result.usage) {
      usage = { usage: result.usage, provider: result.provider ?? "unknown", model: result.model ?? "unknown" };
      options.onUsage?.(usage);
    }
    const parsed = validateClassification(extractJson(raw));
    if (!parsed) return { classification: fallbackClassification(text, "invalid_classifier_output"), usage };
    if (parsed.confidence < options.minConfidence) {
      const fallback = fallbackClassification(text, "low_confidence");
      fallback.reason_codes = ["low_confidence", `model_confidence_${parsed.confidence}`];
      return { classification: fallback, usage };
    }
    return { classification: { ...parsed, source: "model" }, usage };
  } catch (error) {
    const aborted = controller.signal.aborted || (error as Error).name === "AbortError";
    return { classification: fallbackClassification(text, aborted ? "classifier_timeout" : "classifier_error"), usage };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
