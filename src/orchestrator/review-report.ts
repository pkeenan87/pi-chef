import { fromMicroUsd, toMicroUsd } from "../config.js";
import type { CheckEvidence, ReviewReport, ReviewStage } from "../domain.js";
import { acceptedLines, rejectedLines, shortModel, unresolvedConcernLines } from "../review/review-resolution.js";
import { cell, formatDuration, formatUsdShort } from "./format.js";

/** The text of a /review: the tables of the chat block and of the saved report, and the numbered items the findings dialog and "Fix all" use. */

/** Characters of a Finding cell; the full text stays in the saved report JSON. */
const FINDING_CELL = 160;
const NONE = "—";

/** A check that failed for want of installed tools. */
const MISSING_TOOLING = /command not found|Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|not recognized as an internal or external command/i;

const commandLine = (check: { command: string; args: string[] }) => [check.command, ...check.args].join(" ");
const isSetup = (check: CheckEvidence) => check.name.startsWith("setup: ");
const isSkipped = (check: CheckEvidence) => check.stderr.startsWith("skipped:");
const passedCheck = (check: CheckEvidence) => check.ran && check.exitCode === 0;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Why a check that did not pass says it failed: the tail of its output. */
export function checkTail(check: { stderr: string; stdout: string }): string {
  return (check.stderr.trim() || check.stdout.trim()).split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 400);
}

/** A hint when a check failed for want of a tool: nothing may be installed in this checkout. */
function setupHint(report: ReviewReport, setupConfigured: boolean): string | undefined {
  if (setupConfigured || !report.checks.some((check) => check.exitCode !== 0 && MISSING_TOOLING.test(`${check.stderr}\n${check.stdout}`))) return undefined;
  return "A check failed because a tool or package is missing. Install it in this checkout, or list the install command under `setup:` in .pi-workflows/config.yaml (for example npm ci) so /review runs it before the checks.";
}

/** One numbered, fixable finding from the report. */
export interface ReviewItem {
  kind: "static" | "check" | "model";
  text: string;
}

/** One row of the Findings table. `item` is set for the numbered rows, the ones "Fix all" sends. */
export interface ReviewRow {
  kind: ReviewItem["kind"];
  item?: ReviewItem;
  /** The row's number; absent for rejected or unresolved findings, which show "–". */
  n?: number;
  severity: string;
  where: string;
  finding: string;
  raisedBy: string;
  /** The reviewer's verdict column: who agrees, "accepts", "rejects: why", or "—" when no advisor was consulted. */
  verdict: string;
}

/**
 * Everything the review found, in the order the person sees and numbers it: static blocking findings, failed checks
 * (Where is the command), static suggestions, then the model's findings. A blocking `tests` finding is its failed
 * check, so it is not listed twice. The numbers are the ones the Findings table, the dialog and "Fix all" share.
 */
export function reviewRows(report: ReviewReport): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const statics = report.findings.filter((finding) => !(finding.severity === "blocking" && (finding.category === "tests" || finding.category === "checks")));
  const staticRow = (finding: (typeof statics)[number]): ReviewRow => {
    const evidence = finding.evidence.split("\n")[0]?.slice(0, 160);
    const blocking = finding.severity === "blocking";
    return {
      kind: "static",
      item: { kind: "static", text: `${blocking ? "BLOCKING" : "suggestion"} ${finding.category}: ${finding.message}${evidence ? ` (${evidence})` : ""}` },
      severity: blocking ? "BLOCKING" : "SUGGESTION",
      where: finding.category,
      finding: `${finding.message}${evidence ? ` (${evidence})` : ""}`,
      raisedBy: "Static scan",
      verdict: NONE,
    };
  };
  for (const finding of statics.filter((item) => item.severity === "blocking")) rows.push(staticRow(finding));
  for (const check of report.checks) {
    if (passedCheck(check) || isSkipped(check)) continue;
    const command = commandLine(check);
    rows.push({
      kind: "check",
      item: { kind: "check", text: `Check failed: ${check.name} (\`${command}\`)${check.ran ? ` exit ${check.exitCode}` : " did not run"}: ${checkTail(check) || "no output"}` },
      severity: "BLOCKING",
      where: command,
      finding: `${check.name} ${check.ran ? `failed with exit ${check.exitCode}` : "did not run"}: ${checkTail(check) || "no output"}`,
      raisedBy: "Check",
      verdict: NONE,
    });
  }
  for (const finding of statics.filter((item) => item.severity !== "blocking")) rows.push(staticRow(finding));

  const model = report.modelReview;
  if (model?.resolution) {
    // After the advisors answered, the reviewer's accepted findings are the model findings; rejected ones are notes.
    const name = (source: string) => (source === "opus" ? shortModel(model.model) : shortModel(source));
    for (const { finding, text } of acceptedLines(model)) {
      const agrees = finding.agreedBy.map((who) => `${name(who)} agrees`);
      rows.push({
        kind: "model",
        item: { kind: "model", text },
        severity: finding.severity.toUpperCase(),
        where: finding.file ?? NONE,
        finding: finding.message,
        raisedBy: name(finding.source),
        verdict: [...(finding.source === "opus" ? [] : ["accepts"]), ...agrees].join("; ") || NONE,
      });
    }
    for (const finding of model.resolution.findings.filter((item) => item.status === "rejected")) {
      rows.push({ kind: "model", severity: finding.severity.toUpperCase(), where: finding.file ?? NONE, finding: finding.message, raisedBy: name(finding.source), verdict: `rejects: ${finding.rationale || "no reason given"}` });
    }
  } else if (model) {
    for (const finding of model.findings) {
      const evidence = finding.evidence ? ` (evidence: ${finding.evidence.replace(/\s+/g, " ").slice(0, 200)})` : "";
      rows.push({
        kind: "model",
        item: { kind: "model", text: `${finding.severity.toUpperCase()} ${finding.file ? `${finding.file}: ` : ""}${finding.message}${evidence}` },
        severity: finding.severity.toUpperCase(),
        where: finding.file ?? NONE,
        finding: finding.message,
        raisedBy: shortModel(model.model),
        verdict: NONE,
      });
    }
    if (model.resolutionError) {
      for (const advisor of model.advisors ?? []) {
        for (const concern of advisor.concerns) {
          rows.push({ kind: "model", severity: concern.severity.toUpperCase(), where: concern.file ?? NONE, finding: concern.issue, raisedBy: shortModel(advisor.model), verdict: "unresolved" });
        }
      }
    }
  }
  let n = 0;
  for (const row of rows) if (row.item) row.n = ++n;
  return rows;
}

/** The numbered items, in table order. */
export function reviewItems(report: ReviewReport): ReviewItem[] {
  return reviewRows(report).flatMap((row) => (row.item ? [row.item] : []));
}

/** Findings that are listed but not numbered and not sent by "Fix all": rejected by the reviewer, or advisor concerns it could not weigh. Dimmed `> ` lines. */
export function reviewNotes(report: ReviewReport): string[] {
  const model = report.modelReview;
  if (!model) return [];
  return model.resolution ? rejectedLines(model) : model.resolutionError ? unresolvedConcernLines(model.advisors ?? []) : [];
}

const table = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)];

/** The Findings table, shared by the chat block and the findings dialog so the numbers match. */
export function findingsTable(report: ReviewReport): string[] {
  const reviewer = report.modelReview ? shortModel(report.modelReview.model) : "Opus";
  return table(
    ["#", "Severity", "Where", "Finding", "Raised by", reviewer],
    reviewRows(report).map((row) => [row.n === undefined ? "–" : String(row.n), row.severity, cell(row.where, 80), cell(row.finding, FINDING_CELL), cell(row.raisedBy, 40), cell(row.verdict, 120)]),
  );
}

/** "$0.14", "unknown" for a call with no known price, "—" when the stage billed nothing. */
function stageCost(stage: ReviewStage | undefined): string {
  return stage === undefined || stage.costUsd === undefined ? NONE : stage.costUsd === null ? "unknown" : formatUsdShort(stage.costUsd);
}

const stageTime = (stage: ReviewStage | undefined) => (stage?.elapsedMs === undefined ? NONE : formatDuration(stage.elapsedMs));

/** The header's total: the sum of the stage costs, or "≥ $x (some unknown)". Undefined when no stage billed anything. */
function totalCost(report: ReviewReport): string | undefined {
  const stages = [report.stages?.model, report.stages?.advisors].filter((stage): stage is ReviewStage => stage?.costUsd !== undefined);
  if (stages.length === 0) return undefined;
  const known = stages.reduce((sum, stage) => sum + (stage.costUsd === null || stage.costUsd === undefined ? 0 : toMicroUsd(stage.costUsd)), 0);
  const total = formatUsdShort(fromMicroUsd(known));
  return stages.some((stage) => stage.costUsd === null) ? `≥ ${total} (some unknown)` : total;
}

/** A ticket of the branch's plan, for the Tickets table. */
export interface ReviewTicketRow {
  id: string;
  difficulty: string;
  implementer: string;
  review: string;
  cost: string;
}

/** The model-review stage's row: who reviewed, how many parts and findings, or why nothing came back. */
function modelRow(report: ReviewReport, found: number): string {
  const model = report.modelReview;
  if (!model) return "did not run";
  const reviewers = [...new Set((model.parts ?? []).flatMap((part) => (part.reviewedBy ? [part.reviewedBy] : [])))];
  const who = reviewers.length > 0 ? reviewers.join(", ") : `${model.provider}/${model.model}`;
  if (model.error && found === 0) return `${who} · no findings: ${model.error}`;
  const retried = (model.parts ?? []).filter((part) => part.reviewedBy && part.failures.length > 0).map((part) => `part ${part.index} retried (after ${part.failures.join("; ")})`);
  return [who, ...(model.chunks && model.chunks > 1 ? [`${model.chunks} parts`] : []), plural(found, "finding"), ...retried, ...(model.truncated ? ["part of the diff was not reviewed"] : []), ...(model.error ? [`note: ${model.error}`] : [])].join(" · ");
}

/** The advisors stage's row: who was consulted and why, or none and why. */
function advisorsRow(report: ReviewReport): string | undefined {
  const model = report.modelReview;
  const rule = model?.advisorRule;
  if (!model || !rule) return undefined;
  if (rule.planned.length === 0) return `none (${rule.reason})`;
  const names = model.advisors?.length ? model.advisors.map((item) => `${item.provider}/${item.model}${item.error ? " (no answer)" : ""}`) : rule.planned;
  return `${names.join(", ")} (${rule.reason})${model.advisorsSkipped ? `; not consulted: ${model.advisorsSkipped}` : ""}${model.resolutionError ? `; ${shortModel(model.model)} could not weigh their answers (${model.resolutionError})` : ""}`;
}

/** The failed checks' output tails, each a short fenced block headed by the check name. */
function failureTails(checks: CheckEvidence[]): string[] {
  return checks.filter((check) => !passedCheck(check) && !isSkipped(check)).flatMap((check) => {
    const tail = (check.stderr.trim() || check.stdout.trim()).split("\n").filter(Boolean).slice(-6).join("\n").replace(/```/g, "'''").slice(0, 600);
    return ["", `**${cell(check.name)}** (${check.ran ? `exit ${check.exitCode}` : "did not run"})`, "```", tail || "(no output)", "```"];
  });
}

/**
 * The structured review, as the chat block and as the saved report: verdict with time and cost, a table of the stages,
 * the checks, the numbered findings, the plan's tickets when there is one, and what to do next.
 */
export function reviewMarkdown(report: ReviewReport, options: { setupConfigured: boolean; savedAs?: string; tickets?: ReviewTicketRow[] } = { setupConfigured: true }): string {
  const rows = reviewRows(report);
  const setupSteps = report.checks.filter(isSetup);
  const checks = report.checks.filter((check) => !isSetup(check));
  const blocking = report.findings.filter((finding) => finding.severity === "blocking" && finding.category !== "tests" && finding.category !== "checks").length;
  const suggestions = report.findings.filter((finding) => finding.severity === "suggestion").length;
  const failedSetup = setupSteps.find((check) => !passedCheck(check));
  const hint = setupHint(report, options.setupConfigured);
  const next = report.passed
    ? "Nothing blocks. Commit and push when you are ready; /review never does."
    : hint ?? (report.checks.some((check) => check.ran && check.exitCode !== 0) ? "Fix the failing check(s) in chat, then /review again." : "Address the blocking findings in chat, then /review again.");

  const stageRows: string[][] = [
    ...(setupSteps.length > 0 ? [["Setup", failedSetup ? `${cell(failedSetup.name.replace(/^setup: /, ""))} ${failedSetup.ran ? "failed" : "did not run"}` : `${plural(setupSteps.length, "step")} ok`, stageTime(report.stages?.setup), NONE]] : []),
    ["Checks", checks.length === 0 ? "none ran" : `${checks.filter(passedCheck).length} of ${checks.length} passed`, stageTime(report.stages?.checks), NONE],
    ["Static scan", `${blocking} blocking, ${plural(suggestions, "suggestion")}`, NONE, NONE],
    ["Model review", cell(modelRow(report, rows.filter((row) => row.kind === "model").length), 400), stageTime(report.stages?.model), stageCost(report.stages?.model)],
  ];
  const advisors = advisorsRow(report);
  if (advisors) stageRows.push(["Advisors", cell(advisors, 240), stageTime(report.stages?.advisors), stageCost(report.stages?.advisors)]);

  const total = totalCost(report);
  const checkRows = checks.map((check) => [
    cell(commandLine(check)),
    isSkipped(check) ? "– skipped" : !check.ran ? "✗ did not run" : check.exitCode === 0 ? (check.stdout.startsWith("cached:") ? "✓ pass (cached)" : "✓ pass") : `✗ exit ${check.exitCode}`,
    check.durationMs !== undefined && !check.stdout.startsWith("cached:") ? formatDuration(check.durationMs) : NONE,
  ]);
  return [
    `## Review ${report.passed ? "passed" : "did not pass"}${report.elapsedMs !== undefined ? ` · ${formatDuration(report.elapsedMs)}` : ""}${total ? ` · ${total}` : ""}`,
    ...(report.passed ? [] : ["", report.summary]),
    "",
    ...table(["Stage", "Result", "Time", "Cost"], stageRows),
    "",
    "### Checks",
    ...(checkRows.length > 0 ? table(["Check", "Result", "Time"], checkRows) : ["None ran."]),
    ...failureTails(report.checks),
    "",
    "### Findings",
    ...(rows.length > 0 ? findingsTable(report) : ["None."]),
    ...(options.tickets?.length ? ["", "### Tickets", ...table(["Ticket", "Difficulty", "Implementer", "Review", "Cost"], options.tickets.map((row) => [cell(row.id), row.difficulty, cell(row.implementer), cell(row.review), cell(row.cost)]))] : []),
    "",
    "### Next",
    `- ${next}`,
    ...(options.savedAs ? [`- Full report: ${options.savedAs}`] : []),
  ].join("\n");
}
