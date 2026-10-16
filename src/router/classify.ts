import type { AcceptedClassification, Complexity } from "../domain.js";

/**
 * Task classification is deterministic. Before a spec exists the request text gets a keyword scan. When the planner
 * saves its spec (plan_spec) it rates complexity, risk and security itself; the keyword scan of the request and spec can
 * only raise the security flag, never lower it. No model is called to classify.
 */

// One strong signal, or two distinct weak signals, marks a task security-sensitive.
const STRONG_SECURITY =
  /\b(auth|authn|authz|authentication|authori[sz]ation|oauth|secrets?|credentials?|api[ -]?keys?|passwords?|private[ -]keys?|access control|rbac|permissions? (?:check|model|bug|bypass)|(?:prod|production) (?:deploy|deployment|release|rollout)|deploy(?:ing)? to prod(?:uction)?)\b/i;
const WEAK_SECURITY = [/\btokens?\b/i, /\bprod(?:uction)?\b/i, /\bpermissions?\b/i, /\bsecurity\b/i, /\bencrypt\w*/i, /\blogin\b/i, /\bsession\b/i];

/** Keep the head and tail of long text; the middle is dropped. */
export function clipMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n[... truncated ...]\n";
  const half = Math.floor((maxChars - marker.length) / 2);
  return `${text.slice(0, half)}${marker}${text.slice(text.length - half)}`;
}

/** The tier a rating points at: premium for sensitive or high-complexity work, standard for medium, cheap for low. */
function tierFor(complexity: Complexity, sensitive: boolean): AcceptedClassification["recommended_tier"] {
  if (sensitive || complexity === "high") return "premium";
  return complexity === "medium" ? "standard" : "cheap";
}

const SECURITY_CAPABILITIES = ["security-sensitive", "auth"];

/** True when the classification marks the task security-sensitive. */
export function isSecuritySensitive(classification: Pick<AcceptedClassification, "task_type" | "required_capabilities">): boolean {
  return classification.task_type === "security" || classification.required_capabilities.includes("security-sensitive");
}

/**
 * The deterministic keyword scan. Security keywords give a security-sensitive, high-risk task; anything else is a
 * general, medium task. Used for the request before planning, for `/route`, and as the floor for the planner's rating.
 */
export function classifyKeywords(text: string, reason = "keyword_scan"): AcceptedClassification {
  const strong = STRONG_SECURITY.test(text);
  const weak = WEAK_SECURITY.filter((pattern) => pattern.test(text)).length;
  if (strong || weak >= 2) {
    return {
      task_type: "security",
      complexity: "high",
      risk: "high",
      required_capabilities: [...SECURITY_CAPABILITIES],
      recommended_tier: "premium",
      reason_codes: [reason, strong ? "security_keywords_strong" : "security_keywords_weak"],
      source: "keywords",
    };
  }
  return {
    task_type: "general",
    complexity: "medium",
    risk: "medium",
    required_capabilities: [],
    recommended_tier: "standard",
    reason_codes: [reason],
    source: "keywords",
  };
}

/** What the planner says about the task in plan_spec. */
export interface PlannerRating {
  complexity: Complexity;
  risk: Complexity;
  securitySensitive: boolean;
  /** A short sentence, shown in /status and the plan. */
  reason?: string;
}

/**
 * The classification a saved spec gives the task. `scanned` is the text the keyword scan covers (the request and the
 * spec). The task is security-sensitive when the planner says so or the scan finds it: the planner cannot lower a
 * keyword hit. A sensitive task is high risk whatever risk the planner gave.
 */
export function plannerClassification(rating: PlannerRating, scanned: string): AcceptedClassification {
  const scan = classifyKeywords(scanned);
  const hit = isSecuritySensitive(scan);
  const sensitive = rating.securitySensitive || hit;
  const reason = rating.reason?.replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    task_type: sensitive ? "security" : "general",
    complexity: rating.complexity,
    risk: sensitive ? "high" : rating.risk,
    required_capabilities: sensitive ? [...SECURITY_CAPABILITIES] : [],
    recommended_tier: tierFor(rating.complexity, sensitive),
    reason_codes: [
      "planner",
      ...(hit && !rating.securitySensitive ? ["security_keyword_override", ...scan.reason_codes.slice(1)] : rating.securitySensitive ? ["planner_security_sensitive"] : []),
      ...(reason ? [`reason: ${reason}`] : []),
    ],
    source: "planner",
  };
}
