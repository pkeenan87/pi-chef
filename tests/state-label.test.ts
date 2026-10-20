import { describe, expect, it } from "vitest";
import type { ReviewReport, TaskState, TicketRun } from "../src/domain.js";
import { clock, reviewOutOfDate, statusLine, taskState } from "../src/orchestrator/state-label.js";
import { sampleTicket } from "./helpers.js";

const hhmm = (iso: string) => clock(iso)!;
const run = (extra: Partial<TicketRun> = {}): TicketRun => ({ status: "done", attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false, ...extra });

function task(extra: Partial<TaskState> = {}): TaskState {
  return {
    taskId: "task-1",
    phase: "IMPLEMENTING",
    createdAt: "2026-10-14T12:00:00.000Z",
    updatedAt: "2026-10-14T12:00:00.000Z",
    request: "x",
    phaseEnteredAt: "2026-10-14T12:00:00.000Z",
    approvedVersion: 2,
    plan: { version: 2, createdAt: "", summary: "", risks: [], acceptance: [], groups: [], overlap: [], securitySensitive: false, tickets: [sampleTicket("01"), sampleTicket("02"), sampleTicket("03")] },
    build: { branch: "chef/task-1", base: "main", baseSha: "a" },
    ...extra,
  };
}

const report = (extra: Partial<ReviewReport> = {}): ReviewReport => ({ passed: true, claimedPass: true, findings: [], checks: [], summary: "ok", at: "2026-10-14T14:32:00.000Z", headSha: "abc", ...extra });

describe("taskState", () => {
  it("says there is no active task", () => {
    expect(taskState(undefined, undefined).line).toBe("No active task · /plan <request> to start");
  });

  it("names the planning stage", () => {
    expect(taskState(task({ phase: "PLANNING", planning: { stage: "interview", noQuestions: false } }), undefined).line).toBe("Planning · interview");
    expect(taskState(task({ phase: "PLANNING", planning: { stage: "tickets", noQuestions: false } }), undefined).line).toBe("Planning · writing tickets");
  });

  it("shows a draft waiting for approval", () => {
    const state = task({ phase: "AWAITING_PLAN_APPROVAL", approvedVersion: undefined, build: undefined });
    expect(taskState(state, undefined).line).toBe("Draft v2 · waiting for approval (/show-plan)");
  });

  it("shows an approved plan with nothing built", () => {
    expect(taskState(task({ phase: "AWAITING_PLAN_APPROVAL", build: undefined }), undefined).line).toBe("Approved v2 · run /build");
    expect(taskState(task({ build: undefined }), undefined).line).toBe("Approved v2 · run /build");
  });

  it("shows the ticket being built", () => {
    const state = task({ build: { branch: "b", base: "main", baseSha: "a", currentTicket: "02" }, ticketRuns: { "01": run(), "02": run({ status: "in-progress" }) } });
    expect(taskState(state, undefined).line).toBe("Building · ticket 02 of 3");
  });

  it("shows a stopped ticket with a short reason", () => {
    const failed = task({ ticketRuns: { "01": run(), "02": run({ status: "failed", error: "npm test failed:\nexit 1 | 3 tests" }) } });
    expect(taskState(failed, undefined).line).toBe("Stopped · ticket 02: npm test failed: exit 1 | 3 tests · /build resumes (/status 02 shows its attempts)");
    const halted = task({ ticketRuns: { "01": run({ status: "in-progress" }) } });
    expect(taskState(halted, undefined).line).toBe("Stopped · ticket 01: stopped · /build resumes (/status 01 shows its attempts)");
  });

  it("shows a finished build with no review", () => {
    const state = task({ ticketRuns: { "01": run(), "02": run(), "03": run() } });
    expect(taskState(state, undefined).line).toBe("Built · 3 of 3 tickets done · run /review");
  });

  it("shows tickets still to do between chunks", () => {
    expect(taskState(task({ ticketRuns: { "01": run() } }), undefined).line).toBe("Building · 1 of 3 tickets done · /build resumes");
  });

  it("shows a passed, current review", () => {
    const state = task({ ticketRuns: { "01": run() } });
    const label = taskState(state, report(), { head: "abc" });
    expect(label.line).toBe(`Reviewed · passed ${hhmm("2026-10-14T14:32:00.000Z")} · push and open the PR (a new /plan closes this task)`);
  });

  it("counts findings when the review did not pass", () => {
    const failing = report({ passed: false, headSha: "abc", findings: [{ severity: "blocking", category: "secrets", message: "key", evidence: "" }, { severity: "suggestion", category: "style", message: "nit", evidence: "" }] });
    expect(taskState(task(), failing, { head: "abc" }).line).toBe("Reviewed · 2 finding(s) to fix · fix in chat, then /review");
  });

  it("flags a review whose head has moved, and only when both heads are known", () => {
    const stale = taskState(task(), report(), { head: "def" }).line;
    expect(stale).toMatch(/^Reviewed · passed .* · review is out of date \(commits since\) · \/review again$/);
    expect(taskState(task(), report({ passed: false }), { head: "def" }).line).toContain("fix in chat, then /review · review is out of date (commits since) · /review again");
    expect(taskState(task(), report({ headSha: undefined }), { head: "def" }).line).not.toContain("out of date");
    expect(taskState(task(), report(), {}).line).not.toContain("out of date");
    expect(reviewOutOfDate(report(), { head: "abc" })).toBe(false);
  });

  it("shows complete, blocked, and paused", () => {
    expect(taskState(task({ phase: "COMPLETE" }), undefined).line).toBe("Complete");
    expect(taskState(task({ phase: "BLOCKED", blockedReason: "needs a decision" }), undefined).line).toBe("Blocked · needs a decision");
    expect(taskState(task({ phase: "PAUSED", blockedReason: "security-sensitive task" }), undefined).line).toBe("Paused · security-sensitive task");
  });

  it("calls the old publishing phases an older task", () => {
    for (const phase of ["PUBLISHED", "AUTOPILOT", "MERGE_READY"] as const) {
      expect(taskState(task({ phase }), undefined).line).toBe("Published (older task) · a new /plan closes it");
    }
  });
});

describe("statusLine", () => {
  const facts = { name: "retry", spentUsd: 1.239, unknownSpend: false, budgetUsd: 10 };
  it("shows the task, where it stands, the running model and spend", () => {
    expect(statusLine(task({ build: { branch: "b", base: "main", baseSha: "a", currentTicket: "02" } }), { ...facts, model: "anthropic/claude-sonnet-5-5" })).toBe(
      "chef · retry · Building · ticket 02 of 3 · anthropic/claude-sonnet-5-5 · $1.24 of $10",
    );
  });
  it("shows the planning stage while /plan runs, and marks unknown spend", () => {
    expect(statusLine(task({ phase: "PLANNING" }), { ...facts, planning: "plan · interview round 2 (3/12 questions)", unknownSpend: true })).toBe("chef · retry · plan · interview round 2 (3/12 questions) · $1.24+? of $10");
  });
  it("is cleared with no open task", () => {
    expect(statusLine(undefined, facts)).toBeUndefined();
    expect(statusLine(task({ phase: "COMPLETE" }), facts)).toBeUndefined();
  });
});
