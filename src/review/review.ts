import { redact } from "../redact.js";
import type { CheckEvidence, Finding, ReviewReport } from "../domain.js";
import { assertCommandAllowed, commandLine } from "../sandbox.js";

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
  diffs: { groupId: string; diff: string }[];
  integratedDiff: string;
  checks: { name: string; command: string; args: string[] }[];
  cwd: string;
  runner: CheckRunner;
  allowlist: string[];
  planAcceptance: string[];
}): Promise<ReviewReport> {
  const findings: Finding[] = [];
  const combined = options.diffs.map((item) => item.diff).join("\n") + options.integratedDiff;
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
  const outcomes = await mapBounded(options.checks, CHECK_CONCURRENCY, async (check) => {
    try {
      assertCommandAllowed(check.command, check.args, options.allowlist);
    } catch (error) {
      const message = (error as Error).message;
      const evidence: CheckEvidence = { name: check.name, command: check.command, args: check.args, cwd: options.cwd, exitCode: null, stdout: "", stderr: message, ran: false };
      const finding: Finding = { severity: "blocking", category: "checks", message: `Check ${check.name} is not allowlisted.`, evidence: message };
      return { evidence, finding };
    }
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await options.runner.run(check.command, check.args, options.cwd);
    } catch (error) {
      result = { code: 1, stdout: "", stderr: `Runner error: ${(error as Error).message}` };
    }
    const evidence: CheckEvidence = {
      name: check.name,
      command: check.command,
      args: check.args,
      cwd: options.cwd,
      exitCode: result.code,
      stdout: redact(result.stdout).slice(0, 4000),
      stderr: redact(result.stderr).slice(0, 4000),
      ran: true,
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
  });
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
    worktreeDiffs: options.diffs.map((item) => ({ groupId: item.groupId, diff: redact(item.diff) })),
    integratedDiff: redact(options.integratedDiff),
    summary: passed ? `Review passed with ${checks.length} check(s) and no blocking findings.` : `Review did not pass: ${why.join("; ")}.`,
  };
}
