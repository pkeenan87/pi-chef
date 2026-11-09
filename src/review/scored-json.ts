/**
 * Reading a model's scored findings, shared by the /review model pass (`model-review.ts`), an agent's findings file
 * (`agent-review.ts`) and the per-ticket review (`ticket-review.ts`): lenient JSON extraction from prose, one finding's
 * fields, the dedupe across parts, and the risk filter. Scoring itself is `risk.ts`.
 */
import type { ModelFinding } from "../domain.js";
import { redact } from "../redact.js";
import { compareRisk, findingKey, keepFinding, readScore, type MaybeScored } from "./risk.js";

/** A finding as the model gave it: a score it left out or got wrong is missing, and `keepFinding` drops the finding. */
export type ParsedFinding = Omit<ModelFinding, "likelihood" | "severity"> & MaybeScored;

/** Balanced `[...]` and `{...}` spans of the text in order of their start, skipping brackets inside JSON strings. */
export function bracketSpans(text: string): string[] {
  const spans: string[] = [];
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== "[" && open !== "{") continue;
    const stack: string[] = [];
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i]!;
      if (inString) {
        if (char === "\\") i++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "[" || char === "{") stack.push(char === "[" ? "]" : "}");
      else if (char === "]" || char === "}") {
        if (stack.pop() !== char) break;
        if (stack.length === 0) {
          spans.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return spans;
}

/** The first JSON value in the answer that `accept` takes: the whole text, a ```fence, or a balanced span inside prose. */
export function firstJson<T>(text: string, accept: (value: unknown) => T | undefined): T | undefined {
  const fenced = [...text.matchAll(/```[a-z]*\s*\n?([\s\S]*?)```/gi)].map((match) => match[1]!.trim());
  for (const candidate of [text.trim(), ...fenced, ...bracketSpans(text)]) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const taken = accept(value);
    if (taken !== undefined) return taken;
  }
  return undefined;
}

/**
 * One finding from a model's object: its text (the first of `textKeys` that holds some, cut to `maxText`), the scores
 * `readScore` could read, and the optional file, category and evidence. Undefined when it has no text.
 */
export function readFinding(raw: Record<string, unknown>, textKeys: string[], maxText: number): ParsedFinding | undefined {
  const field = (key: string, max: number) => (typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim().slice(0, max) : undefined);
  const message = textKeys.map((key) => field(key, maxText)).find((text) => text !== undefined);
  if (!message) return undefined;
  const likelihood = readScore(raw.likelihood);
  const severity = readScore(raw.severity);
  const file = field("file", 200);
  const evidence = field("evidence", 200);
  return { ...(likelihood !== undefined ? { likelihood } : {}), ...(severity !== undefined ? { severity } : {}), category: field("category", 40) ?? "general", message, ...(file ? { file } : {}), ...(evidence ? { evidence } : {}) };
}

/** Same file and message across parts: one finding, the one with the higher risk (then severity); an unscored one loses to a scored one. */
export function dedupe(findings: ParsedFinding[]): ParsedFinding[] {
  const score = (finding: ParsedFinding) => ({ likelihood: finding.likelihood ?? 0, severity: finding.severity ?? 0 });
  const best = new Map<string, ParsedFinding>();
  for (const finding of findings) {
    const key = findingKey(finding.file, finding.message);
    const current = best.get(key);
    if (!current || compareRisk(score(finding), score(current)) < 0) best.set(key, finding);
  }
  return [...best.values()];
}

/**
 * Redacts, dedupes, applies the risk filter once, sorts highest risk first and caps: the findings a review reports and how
 * many were dropped (below the risk threshold, or missing a score).
 */
export function keepBest(parsed: ParsedFinding[], cap: number): { findings: ModelFinding[]; dropped: number } {
  const unique = dedupe(parsed.map((finding) => ({ ...finding, message: redact(finding.message), ...(finding.evidence ? { evidence: redact(finding.evidence) } : {}) })));
  const kept = unique.filter(keepFinding).sort(compareRisk);
  return { findings: kept.slice(0, cap), dropped: unique.length - kept.length };
}

/** " (k below the risk threshold dropped)", or nothing when none were. */
export const droppedNote = (count: number): string => (count > 0 ? ` (${count} below the risk threshold dropped)` : "");
