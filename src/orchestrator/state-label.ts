import type { ReviewReport, TaskState } from "../domain.js";
import { flat } from "./format.js";
import { reviewItems } from "./review-report.js";

/** The git facts the label needs: HEAD now, when it could be read. */
export interface GitFacts {
  head?: string;
}

export interface TaskStateLabel {
  /** The whole state line, as /status shows it and the command returns it. */
  line: string;
  /** The next step alone, for the Next row. */
  next: string;
}

/** "14:32" in the local time zone; undefined for a missing or unreadable timestamp. */
export function clock(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** True when the review recorded the head it ran on and HEAD has moved since. A missing SHA on either side means unknown, so no flag. */
export function reviewOutOfDate(review: ReviewReport | undefined, git: GitFacts): boolean {
  return !!review?.headSha && !!git.head && review.headSha !== git.head;
}

const label = (head: string, next: string): TaskStateLabel => ({ line: `${head} · ${next}`, next });

/**
 * The task's state in one line, derived from the phase, the tickets, and the review rather than the raw phase. Pure:
 * `git.head` is read by the caller. `review` is the task's review, if any.
 */
export function taskState(state: TaskState | undefined, review: ReviewReport | undefined, git: GitFacts = {}): TaskStateLabel {
  if (!state || state.phase === "IDLE") return label("No active task", "/plan <request> to start");
  const reason = (fallback: string) => flat(state.blockedReason || fallback, 120);
  switch (state.phase) {
    case "PLANNING":
      return { line: `Planning · ${state.planning?.stage === "tickets" ? "writing tickets" : "interview"}`, next: "answer the planner" };
    case "AWAITING_PLAN_APPROVAL": {
      const version = state.plan?.version ?? 1;
      return state.approvedVersion && state.approvedVersion === state.plan?.version
        ? label(`Approved v${state.approvedVersion}`, "run /build")
        : label(`Draft v${version}`, "waiting for approval (/show-plan)");
    }
    case "COMPLETE":
      return { line: "Complete", next: "/plan <request> to start another" };
    case "BLOCKED":
      return { line: `Blocked · ${reason("no reason recorded")}`, next: reason("no reason recorded") };
    case "PAUSED":
      return { line: `Paused · ${reason("no reason recorded")}`, next: "resume when ready" };
    case "FAILED":
      return { line: `Failed · ${reason("no reason recorded")}`, next: reason("no reason recorded") };
    case "PUBLISHED":
    case "AUTOPILOT":
    case "MERGE_READY":
      return label("Published (older task)", "a new /plan closes it");
  }

  // IMPLEMENTING, REVIEWING, AWAITING_PUBLISH_APPROVAL: the build and the review decide.
  if (review) {
    const stale = reviewOutOfDate(review, git) ? " · review is out of date (commits since) · /review again" : "";
    if (review.passed) {
      const when = clock(review.at);
      const next = "push and open the PR (a new /plan closes this task)";
      return { line: `Reviewed · passed${when ? ` ${when}` : ""} · ${next}${stale}`, next: `${next}${stale}` };
    }
    const count = reviewItems(review).length;
    const next = "fix in chat, then /review";
    return { line: `Reviewed · ${count} finding(s) to fix · ${next}${stale}`, next: `${next}${stale}` };
  }
  const runs = state.ticketRuns ?? {};
  const tickets = state.plan?.tickets ?? [];
  const total = tickets.length || Object.keys(runs).length;
  const finished = Object.values(runs).filter((run) => run.status === "done").length;
  if (!state.build && Object.keys(runs).length === 0) {
    return label(`Approved v${state.approvedVersion ?? state.plan?.version ?? 1}`, "run /build");
  }
  const running = state.build?.currentTicket;
  if (running) return { line: `Building · ticket ${running} of ${total}`, next: "wait for /build, or abort" };
  const stopped = Object.entries(runs).find(([, run]) => run.status === "failed" || run.status === "in-progress");
  if (stopped) {
    const [id, run] = stopped;
    const why = flat(run.error || (run.failedBy ? `${run.failedBy} failed` : "stopped"), 60);
    return label(`Stopped · ticket ${id}: ${why}`, "/build resumes");
  }
  if (finished >= total && total > 0) return label(`Built · ${finished} of ${total} tickets done`, "run /review");
  return label(`Building · ${finished} of ${total} tickets done`, "/build resumes");
}
