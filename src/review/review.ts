import { redact } from "../redact.js";
import type { CheckEvidence, Finding, ReviewReport } from "../domain.js";
import { assertCommandSafe, commandLine } from "../sandbox.js";

export interface CheckRunner {
  run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

const SECRET_DIFF = new RegExp(
  [
    String.raw`\bsk-[A-Za-z0-9_-]{20,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bghp_[A-Za-z0-9]{20,}`,
    // Quoted literal values only, so `password = process.env.X` or `apiKey: string` do not match.
    String.raw`\bpassword\s*[:=]\s*["'][^"'\s]{4,}["']`,
    String.raw`\bapi[_-]?key\s*[:=]\s*["'][^"'\s]{8,}["']`,
    "BEGIN [A-Z ]*PRIVATE KEY",
  ].join("|"),
  "i",
);
const AUTH_BYPASS = /\b(skip(?:ped)?\s+auth|disable(?:d)?\s+auth|auth\s*[:=]\s*false|verify\s*[:=]\s*false)\b/i;
// Not a method call such as `model.eval(` or an identifier ending in eval.
const EVAL_CALL = /(?<![.\w$])eval\s*\(/;
const CHECK_CONCURRENCY = 4;

async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function reviewDiff(options: {
  /** The branch's changes against its base, working tree included. */
  diff: string;
  checks: { name: string; command: string; args: string[] }[];
  /** Commands run one after another before the checks (an install). A failure fails the review and skips the checks. */
  setup?: { name: string; command: string; args: string[] }[];
  /** Clock for check durations (injectable for tests). */
  now?: () => number;
  /** A line per stage and per check, for the chat. */
  onProgress?: (line: string) => void;
  /** What is running now, for the live progress line: "static scan", "setup step 1 of 2: npm ci", "checks 2 of 3 running: npm test". */
  onStage?: (text: string) => void;
  cwd: string;
  runner: CheckRunner;
  planAcceptance: string[];
}): Promise<ReviewReport> {
  const findings: Finding[] = [];
  const now = options.now ?? (() => Date.now());
  const progress = options.onProgress ?? (() => undefined);
  const combined = options.diff;
  options.onStage?.("static scan");
  progress(`static scan of the diff (${Math.round(combined.length / 1000)}k chars)`);
  if (SECRET_DIFF.test(combined)) {
    findings.push({
      severity: "blocking",
      category: "secrets",
      message: "Diff introduces a secret or credential-like literal.",
      evidence: redact(combined.match(SECRET_DIFF)?.[0] ?? "secret pattern"),
    });
  }
  if (AUTH_BYPASS.test(combined)) {
    findings.push({
      severity: "blocking",
      category: "auth",
      message: "Diff appears to bypass authentication or authorization.",
      evidence: redact(combined.match(AUTH_BYPASS)?.[0] ?? "auth bypass"),
    });
  }
  if (EVAL_CALL.test(combined)) {
    findings.push({
      severity: "blocking",
      category: "security",
      message: "Diff introduces eval().",
      evidence: "eval(",
    });
  }
  if (/\bTODO\b|\bFIXME\b/.test(combined)) {
    findings.push({
      severity: "suggestion",
      category: "maintainability",
      message: "Diff contains TODO or FIXME markers.",
      evidence: "TODO/FIXME",
    });
  }
  const checks: CheckEvidence[] = [];
  const runOne = async (check: { name: string; command: string; args: string[] }): Promise<{ evidence: CheckEvidence; finding?: Finding }> => {
    try {
      assertCommandSafe(check.command, check.args);
    } catch (error) {
      const message = (error as Error).message;
      const evidence: CheckEvidence = { name: check.name, command: check.command, args: check.args, cwd: options.cwd, exitCode: null, stdout: "", stderr: message, ran: false };
      const finding: Finding = { severity: "blocking", category: "checks", message: `Check ${check.name} was refused.`, evidence: message };
      return { evidence, finding };
    }
    let result: { code: number; stdout: string; stderr: string };
    progress(`running ${check.name} (${commandLine(check.command, check.args)})`);
    const started = now();
    try {
      result = await options.runner.run(check.command, check.args, options.cwd);
    } catch (error) {
      result = { code: 1, stdout: "", stderr: `Runner error: ${(error as Error).message}` };
    }
    const durationMs = now() - started;
    progress(`${check.name}: ${result.code === 0 ? (result.stdout.startsWith("cached:") ? "passed (cached from an identical tree)" : "passed") : `exit ${result.code}`} in ${(durationMs / 1000).toFixed(1)}s`);
    const evidence: CheckEvidence = {
      name: check.name,
      command: check.command,
      args: check.args,
      cwd: options.cwd,
      exitCode: result.code,
      stdout: redact(result.stdout).slice(0, 4000),
      stderr: redact(result.stderr).slice(0, 4000),
      ran: true,
      durationMs,
    };
    const finding: Finding | undefined =
      result.code !== 0
        ? {
            severity: "blocking",
            category: "tests",
            message: `${check.name} failed.`,
            evidence: redact(`${commandLine(check.command, check.args)} exited ${result.code}\n${result.stderr || result.stdout}`).slice(0, 2000),
          }
        : undefined;
    return { evidence, finding };
  };
  // Setup runs first and in order: a check cannot run before the install it needs.
  let setupFailed = false;
  const setupStarted = now();
  const steps = options.setup ?? [];
  for (const [index, step] of steps.entries()) {
    options.onStage?.(`setup step ${index + 1} of ${steps.length}: ${commandLine(step.command, step.args)}`);
    const outcome = await runOne({ ...step, name: `setup: ${step.name}` });
    checks.push(outcome.evidence);
    if (outcome.finding) {
      findings.push(outcome.finding);
      setupFailed = true;
      break;
    }
  }
  const setupMs = now() - setupStarted;
  const checksStarted = now();
  let checksStartedCount = 0;
  const outcomes: { evidence: CheckEvidence; finding?: Finding }[] = setupFailed
    ? options.checks.map((check) => ({ evidence: { name: check.name, command: check.command, args: check.args, cwd: options.cwd, exitCode: null, stdout: "", stderr: "skipped: setup failed", ran: false } }))
    : await mapBounded(options.checks, CHECK_CONCURRENCY, (check) => {
        options.onStage?.(`checks ${++checksStartedCount} of ${options.checks.length} running: ${commandLine(check.command, check.args)}`);
        return runOne(check);
      });
  const checksMs = now() - checksStarted;
  for (const outcome of outcomes) {
    checks.push(outcome.evidence);
    if (outcome.finding) findings.push(outcome.finding);
  }
  if (options.checks.length === 0) {
    findings.push({
      severity: "suggestion",
      category: "tests",
      message: "No checks are configured, so this review cannot claim a test pass.",
      evidence: "checks: []",
    });
  }
  progress(`static findings: ${findings.filter((finding) => finding.severity === "blocking").length} blocking, ${findings.filter((finding) => finding.severity === "suggestion").length} suggestion(s)`);
  for (const acceptance of options.planAcceptance) {
    if (acceptance && !combined.includes(acceptance) && options.checks.length === 0) {
      findings.push({
        severity: "suggestion",
        category: "plan",
        message: `Acceptance criterion is not visible in the diff: ${acceptance}`,
        evidence: acceptance,
      });
    }
  }
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const checksPassed = options.checks.length > 0 && checks.every((check) => check.ran && check.exitCode === 0);
  const passed = blocking.length === 0 && checksPassed;
  // Say why, not just how many: a review that cannot pass for lack of checks must not look like a clean one.
  const why: string[] = [];
  if (blocking.length > 0) why.push(`${blocking.length} blocking finding(s): ${blocking.map((finding) => finding.message).join(" ")}`);
  if (options.checks.length === 0) why.push("no checks ran, so there is no evidence of a test pass. Set `checks:` in .pi-workflows/config.yaml (for example npm test) or give the plan's tickets allowlisted checks, then run /review again");
  return {
    passed,
    claimedPass: passed,
    findings,
    checks,
    diff: redact(options.diff),
    stages: { ...((options.setup ?? []).length > 0 ? { setup: { elapsedMs: setupMs } } : {}), checks: { elapsedMs: checksMs } },
    summary: passed ? `Review passed with ${checks.length} check(s) and no blocking findings.` : `Review did not pass: ${why.join("; ")}.`,
  };
}
