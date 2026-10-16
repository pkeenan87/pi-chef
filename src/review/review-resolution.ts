import type { AdvisorOpinion, ModelFinding, ModelReview, ResolvedFinding } from "../domain.js";
import { redact } from "../redact.js";
import { bracketSpans } from "./model-review.js";

/**
 * How /review shows the reviewer's resolution of its own findings and the advisors' concerns. The reviewer decides:
 * accepted findings are the ones "Fix all" sends, rejected ones are listed dimmed with the reviewer's reason.
 */

/** "claude-opus-5-5" -> "Opus", "gpt-6-astra" -> "Astra", "claude-fable-5-1" -> "Fable". */
export function shortModel(model: string): string {
  const word = model.split(/[-/]/).find((part) => part && !/^\d/.test(part) && part !== "gpt" && part !== "claude");
  return word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : model;
}

const SEVERITIES = new Set(["high", "medium", "low"]);
const RANK = { high: 0, medium: 1, low: 2 } as const;
const MAX_RESOLVED = 30;

/** Canonical name of who raised or agrees with a finding: "opus", an advisor's model id, or the text as given. */
function who(value: string, reviewerModel: string, advisorModels: string[]): string {
  const text = value.trim();
  const lower = text.toLowerCase();
  if (lower === "opus" || lower === "reviewer" || lower === reviewerModel.toLowerCase() || lower === shortModel(reviewerModel).toLowerCase()) return "opus";
  const advisor = advisorModels.find((model) => model.toLowerCase() === lower || shortModel(model).toLowerCase() === lower || lower.endsWith(`/${model.toLowerCase()}`));
  return advisor ?? text.slice(0, 80);
}

/** Reads the resolve call's answer leniently. Undefined when there is no object with a `findings` list. */
export function parseResolution(text: string, input: { reviewerModel: string; advisorModels: string[] }): { findings: ResolvedFinding[]; rationale?: string } | undefined {
  const fenced = [...text.matchAll(/```[a-z]*\s*\n?([\s\S]*?)```/gi)].map((match) => match[1]!.trim());
  for (const candidate of [text.trim(), ...fenced, ...bracketSpans(text)]) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { findings?: unknown }).findings)) continue;
    const raw = value as { findings: unknown[]; rationale?: unknown };
    const findings: ResolvedFinding[] = [];
    for (const item of raw.findings) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const message = typeof entry.message === "string" ? entry.message.trim() : typeof entry.issue === "string" ? entry.issue.trim() : "";
      if (!message) continue;
      const status = typeof entry.status === "string" && entry.status.trim().toLowerCase() === "rejected" ? "rejected" : "accepted";
      const severity = typeof entry.severity === "string" && SEVERITIES.has(entry.severity.toLowerCase()) ? (entry.severity.toLowerCase() as ModelFinding["severity"]) : "medium";
      const file = typeof entry.file === "string" && entry.file.trim() ? entry.file.trim().slice(0, 200) : undefined;
      const category = typeof entry.category === "string" && entry.category.trim() ? entry.category.trim().slice(0, 40) : "general";
      const evidence = typeof entry.evidence === "string" && entry.evidence.trim() ? redact(entry.evidence.trim()).slice(0, 200) : undefined;
      const source = who(typeof entry.source === "string" && entry.source.trim() ? entry.source : "opus", input.reviewerModel, input.advisorModels);
      const agreedBy = [...new Set((Array.isArray(entry.agreedBy) ? entry.agreedBy : []).filter((name): name is string => typeof name === "string" && name.trim() !== "").map((name) => who(name, input.reviewerModel, input.advisorModels)))].filter((name) => name !== source);
      findings.push({ severity, category, message: redact(message).slice(0, 400), ...(file ? { file } : {}), ...(evidence ? { evidence } : {}), status, rationale: redact(typeof entry.rationale === "string" ? entry.rationale.trim() : "").slice(0, 400), source, agreedBy });
      if (findings.length >= MAX_RESOLVED) break;
    }
    findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
    const rationale = typeof raw.rationale === "string" && raw.rationale.trim() ? redact(raw.rationale.trim()).slice(0, 1500) : undefined;
    return { findings, ...(rationale ? { rationale } : {}) };
  }
  return undefined;
}

const nameOf = (name: string, reviewerModel: string) => (name === "opus" ? shortModel(reviewerModel) : shortModel(name));

/** "[Opus · Astra agrees]", "[Fable · Opus accepts]"; a rejected finding is tagged with who raised it only. */
export function attribution(finding: ResolvedFinding, reviewerModel: string): string {
  const parts = [nameOf(finding.source, reviewerModel)];
  if (finding.status === "accepted") {
    if (finding.source !== "opus") parts.push(`${shortModel(reviewerModel)} accepts`);
    for (const name of finding.agreedBy) parts.push(`${nameOf(name, reviewerModel)} agrees`);
  }
  return `[${parts.join(" · ")}]`;
}

/** The reviewer's accepted findings with their attribution: what "Fix all" sends. */
export function acceptedLines(review: ModelReview): { finding: ResolvedFinding; text: string }[] {
  const reviewer = review.model;
  return (review.resolution?.findings ?? [])
    .filter((finding) => finding.status === "accepted")
    .map((finding) => ({ finding, text: `${finding.severity.toUpperCase()} ${finding.file ? `${finding.file}: ` : ""}${finding.message} ${attribution(finding, reviewer)}` }));
}

/** Rejected advisor or reviewer findings, unnumbered and dimmed (a `> ` line), with the reviewer's reason. */
export function rejectedLines(review: ModelReview): string[] {
  const reviewer = review.model;
  return (review.resolution?.findings ?? [])
    .filter((finding) => finding.status === "rejected")
    .map((finding) => `> ${finding.severity.toUpperCase()} ${finding.file ? `${finding.file}: ` : ""}${finding.message} ${attribution(finding, reviewer)} — ${shortModel(reviewer)} rejects: ${finding.rationale || "no reason given"}`);
}

/** Advisor concerns the reviewer did not weigh (the resolve call failed): shown dimmed and labelled, not sent by "Fix all". */
export function unresolvedConcernLines(advisors: AdvisorOpinion[]): string[] {
  return advisors.flatMap((advisor) =>
    advisor.concerns.map((concern) => `> unresolved advisor concern (${shortModel(advisor.model)}): ${concern.severity.toUpperCase()} ${concern.file ? `${concern.file}: ` : ""}${concern.issue}`),
  );
}

/** One line per advisor: who, the verdict and how many concerns, or why it did not answer. */
export function advisorSummaryLines(advisors: AdvisorOpinion[]): string[] {
  return advisors.map((advisor) =>
    advisor.error ? `- ${shortModel(advisor.model)} (${advisor.provider}/${advisor.model}): did not answer (${advisor.error})` : `- ${shortModel(advisor.model)} (${advisor.provider}/${advisor.model}): ${advisor.verdict ?? "unsure"}, ${advisor.concerns.length} concern(s)`,
  );
}

/** The "Advisors" line of the report header: who was consulted and why, or none and why. */
export function advisorsHeader(review: ModelReview | undefined): string | undefined {
  const rule = review?.advisorRule;
  if (!rule) return undefined;
  if (rule.planned.length === 0) return `Advisors: none (${rule.reason})`;
  const names = rule.planned.map(shortModel).join(", ");
  return review!.advisorsSkipped ? `Advisors: ${names} (${rule.reason}); not consulted: ${review!.advisorsSkipped}` : `Advisors: ${names} (${rule.reason})`;
}
