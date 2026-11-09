/**
 * Risk scoring shared by /review and the per-ticket review of /build. A model rates every finding 1-10 for likelihood
 * (how likely it is a real defect that will actually trigger) and 1-10 for severity (the damage if it does). The product
 * is the risk: below `MIN_RISK` a finding is left off the report, from `TICKET_FAIL_RISK` it fails a ticket.
 */

/** Findings scoring below this (likelihood × severity) are dropped. */
export const MIN_RISK = 5;
/** A ticket fails its review when any kept finding scores at least this. */
export const TICKET_FAIL_RISK = 20;

/** The scoring rules as both review prompts state them. */
export const SCORE_RULES = [
  "Rate every finding with two integers from 1 to 10. likelihood: how likely it is a real defect that will actually trigger (1 = very unlikely, a guess; 10 = certain).",
  "severity: how bad the damage is if it does trigger (1 = cosmetic; 10 = data loss or a security breach).",
  `Omit every finding you rate below ${MIN_RISK} combined (likelihood × severity); it is dropped from the report, as is any finding missing either score.`,
].join("\n");

export interface Scored {
  likelihood: number;
  severity: number;
}

/** A finding as parsed: either score may be missing. */
export type MaybeScored = { likelihood?: number; severity?: number };

/** A model's score as 1-10: a number or numeric string, rounded and clamped. Missing, non-numeric or NaN is undefined. */
export function readScore(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(number) ? Math.min(10, Math.max(1, Math.round(number))) : undefined;
}

export const risk = (finding: Scored): number => finding.likelihood * finding.severity;

/** True when both scores are present (numbers, as `readScore` yields) and the risk reaches `MIN_RISK`. */
export function keepFinding<T extends MaybeScored>(finding: T): finding is T & Scored {
  const { likelihood, severity } = finding;
  return typeof likelihood === "number" && typeof severity === "number" && Number.isFinite(likelihood) && Number.isFinite(severity) && likelihood * severity >= MIN_RISK;
}

/** Risk descending, then severity descending. */
export const compareRisk = (a: Scored, b: Scored): number => risk(b) - risk(a) || b.severity - a.severity;

/** "L7×S8" */
export const scoreLabel = (finding: Scored): string => `L${finding.likelihood}×S${finding.severity}`;

/** "L7×S8=56" */
export const riskLabel = (finding: Scored): string => `${scoreLabel(finding)}=${risk(finding)}`;

/** The identity of a finding for deduping: its file and its message without case, punctuation or spacing. */
export function findingKey(file: string | undefined, message: string): string {
  return `${(file ?? "").trim()}\u0000${message.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
}
