import type { AcceptedClassification, Complexity } from "../domain.js";

/**
 * How a task is rated. The planner rates complexity, risk and security itself in plan_spec; nothing scans the request
 * for keywords and no model classifies. Until plan_spec saves a rating, a task has the default one.
 */

const SECURITY_CAPABILITIES = ["security-sensitive", "auth"];

/** The rating of a task the planner has not rated yet: a general, medium one. */
export function defaultClassification(reason = "default"): AcceptedClassification {
  return { task_type: "general", complexity: "medium", risk: "medium", required_capabilities: [], reason_codes: [reason], source: "default" };
}

/** True when the classification marks the task security-sensitive. */
export function isSecuritySensitive(classification: Pick<AcceptedClassification, "task_type" | "required_capabilities">): boolean {
  return classification.task_type === "security" || classification.required_capabilities.includes("security-sensitive");
}

/** What the planner says about the task in plan_spec. */
export interface PlannerRating {
  complexity: Complexity;
  risk: Complexity;
  securitySensitive: boolean;
  /** A short sentence, shown in the plan. */
  reason?: string;
}

/** The classification a saved spec gives the task. A security-sensitive task is high risk whatever risk the planner gave. */
export function plannerClassification(rating: PlannerRating): AcceptedClassification {
  const sensitive = rating.securitySensitive;
  const reason = rating.reason?.replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    task_type: sensitive ? "security" : "general",
    complexity: rating.complexity,
    risk: sensitive ? "high" : rating.risk,
    required_capabilities: sensitive ? [...SECURITY_CAPABILITIES] : [],
    reason_codes: ["planner", ...(sensitive ? ["planner_security_sensitive"] : []), ...(reason ? [`reason: ${reason}`] : [])],
    source: "planner",
  };
}
