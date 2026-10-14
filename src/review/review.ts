import { redact } from "../redact.js";
import type { CheckEvidence, Finding, ReviewReport } from "../domain.js";
import { assertCommandAllowed, commandLine } from "../sandbox.js";

export interface CheckRunner {
  run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

const SECRET_DIFF = /(?:sk-|AKIA|ghp_|password\s*[:=]|api[_-]?key\s*[:=]|BEGIN [A-Z ]*PRIVATE KEY)/i;
const AUTH_BYPASS = /\b(skip(?:ped)?\s+auth|disable(?:d)?\s+auth|auth\s*[:=]\s*false|verify\s*[:=]\s*false)\b/i;
const EVAL_CALL = /\beval\s*\(/;

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
  for (const check of options.checks) {
    try {
      assertCommandAllowed(check.command, check.args, options.allowlist);
    } catch (error) {
      checks.push({
        name: check.name,
        command: check.command,
        args: check.args,
        cwd: options.cwd,
        exitCode: null,
        stdout: "",
        stderr: (error as Error).message,
        ran: false,
      });
      findings.push({
        severity: "blocking",
        category: "checks",
        message: `Check ${check.name} is not allowlisted.`,
        evidence: (error as Error).message,
      });
      continue;
    }
    const result = await options.runner.run(check.command, check.args, options.cwd);
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
    checks.push(evidence);
    if (result.code !== 0) {
      findings.push({
        severity: "blocking",
        category: "tests",
        message: `${check.name} failed.`,
        evidence: redact(`${commandLine(check.command, check.args)} exited ${result.code}\n${result.stderr || result.stdout}`).slice(0, 2000),
      });
    }
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
  return {
    passed,
    claimedPass: passed,
    findings,
    checks,
    worktreeDiffs: options.diffs.map((item) => ({ groupId: item.groupId, diff: redact(item.diff) })),
    integratedDiff: redact(options.integratedDiff),
    summary: passed
      ? `Review passed with ${checks.length} check(s) and no blocking findings.`
      : `Review has ${blocking.length} blocking finding(s).`,
  };
}
