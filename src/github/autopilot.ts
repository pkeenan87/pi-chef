import type { TokenUsage } from "../domain.js";
import { classifyCheck, classifyThread, type CheckRun, type PullRequestSnapshot, type ReviewThread } from "./types.js";

export interface AutopilotCursor {
  running: boolean;
  headSha?: string;
  baseSha?: string;
  seen: string[];
  replies: string[];
  fixCycles: number;
  /** Unverified fix attempts per item key. */
  attempts?: Record<string, number>;
  spentUsd: number;
  startedAt?: string;
  backoffSeconds: number;
  lastPollAt?: string;
  pausedReason?: string;
}

export interface FixRequest {
  reason: string;
  path?: string;
  log?: string;
  sha: string;
  kind: "thread" | "check";
  id: string;
}

export interface FixResult {
  verified: boolean;
  evidence: string;
  summary: string;
  usage?: TokenUsage;
  /** Route the fixer actually used, so its charge is attributed correctly. */
  route?: { tier: string; provider: string; model: string };
  edits?: { path: string; content: string }[];
}

export interface AutopilotLimits {
  maxFixCycles: number;
  maxSpendUsd: number;
  maxRuntimeMs: number;
  backoffSeconds: number;
  /** Cap for exponential backoff; defaults to 30 minutes. */
  maxBackoffSeconds?: number;
  /** Unverified attempts per item before pausing; defaults to 3. */
  maxAttemptsPerItem?: number;
}

export interface CycleOutcome {
  cursor: AutopilotCursor;
  action: "continue" | "merge-ready" | "pause" | "blocked";
  reason: string;
  replies: { threadId: string; body: string }[];
  spendUsd: number;
}

function key(kind: string, id: string, sha: string): string {
  return `${kind}:${id}:${sha}`;
}

const DEFAULT_MAX_BACKOFF_SECONDS = 30 * 60;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_BACKOFF_EXPONENT = 4;

function withinScope(path: string | undefined, allowed: string[]): boolean {
  if (!path) return true;
  return allowed.length === 0 || allowed.some((file) => path === file || path.endsWith(`/${file}`));
}

export function freshCursor(now: string): AutopilotCursor {
  return { running: true, seen: [], replies: [], fixCycles: 0, spentUsd: 0, startedAt: now, backoffSeconds: 0 };
}

export async function autopilotCycle(input: {
  cursor: AutopilotCursor;
  pr: PullRequestSnapshot;
  allowedFiles: string[];
  limits: AutopilotLimits;
  now: Date;
  headRelation: "same" | "fast-forward" | "force" | "unknown";
  fixer?: (request: FixRequest) => Promise<FixResult>;
  apply?: (edits: { path: string; content: string }[], message: string) => Promise<{ sha: string; spentUsd?: number }>;
  charge?: (usage: TokenUsage | undefined) => number | null;
}): Promise<CycleOutcome> {
  const cursor: AutopilotCursor = { ...input.cursor, seen: [...input.cursor.seen], replies: [...input.cursor.replies], attempts: { ...input.cursor.attempts }, backoffSeconds: 0, lastPollAt: input.now.toISOString() };
  const replies: CycleOutcome["replies"] = [];
  const started = cursor.startedAt ? Date.parse(cursor.startedAt) : input.now.getTime();
  if (input.now.getTime() - started > input.limits.maxRuntimeMs) {
    cursor.running = false;
    cursor.pausedReason = "Autopilot runtime limit reached.";
    return { cursor, action: "pause", reason: cursor.pausedReason, replies, spendUsd: 0 };
  }
  if (cursor.spentUsd >= input.limits.maxSpendUsd) {
    cursor.running = false;
    cursor.pausedReason = "Autopilot spend limit reached.";
    return { cursor, action: "pause", reason: cursor.pausedReason, replies, spendUsd: 0 };
  }
  if (cursor.baseSha && input.pr.baseSha && cursor.baseSha !== input.pr.baseSha) {
    cursor.running = false;
    cursor.pausedReason = "The pull request base changed.";
    return { cursor, action: "pause", reason: cursor.pausedReason, replies, spendUsd: 0 };
  }
  if (cursor.headSha && cursor.headSha !== input.pr.headSha && input.headRelation === "force") {
    cursor.running = false;
    cursor.pausedReason = "Force push or a non-descendant head SHA was detected.";
    return { cursor, action: "blocked", reason: cursor.pausedReason, replies, spendUsd: 0 };
  }
  if (!cursor.baseSha) cursor.baseSha = input.pr.baseSha;
  cursor.headSha = input.pr.headSha;

  const actionable: { thread?: ReviewThread; check?: CheckRun; seenKey: string }[] = [];
  for (const thread of input.pr.threads) {
    const id = key("thread", thread.id, thread.sha);
    if (cursor.seen.includes(id)) continue;
    const scope = withinScope(thread.path, input.allowedFiles);
    const klass = classifyThread(thread.body, scope);
    if (klass === "actionable") actionable.push({ thread, seenKey: id });
    else cursor.seen.push(id);
    if (klass === "human" || klass === "ambiguous") {
      cursor.running = false;
      cursor.pausedReason = klass === "human" ? "A review comment needs a human." : "A review comment is ambiguous.";
      return { cursor, action: "blocked", reason: cursor.pausedReason, replies, spendUsd: 0 };
    }
  }
  for (const check of input.pr.checks) {
    const id = key("check", check.id, check.sha);
    if (cursor.seen.includes(id)) continue;
    if (classifyCheck(check) === "actionable") actionable.push({ check, seenKey: id });
    else cursor.seen.push(id);
  }

  let spendUsd = 0;
  try {
    for (const item of actionable) {
      if (cursor.fixCycles >= input.limits.maxFixCycles) {
        cursor.running = false;
        cursor.pausedReason = "Max fix cycles reached.";
        return { cursor, action: "pause", reason: cursor.pausedReason, replies, spendUsd };
      }
      if (!input.fixer || !input.apply) {
        cursor.running = false;
        cursor.pausedReason = "No verified fixer is configured.";
        return { cursor, action: "pause", reason: cursor.pausedReason, replies, spendUsd };
      }
      const request: FixRequest = item.thread
        ? { kind: "thread", id: item.thread.id, reason: item.thread.body, path: item.thread.path, sha: input.pr.headSha }
        : { kind: "check", id: item.check!.id, reason: item.check!.summary || item.check!.name, sha: input.pr.headSha };
      const fix = await input.fixer(request);
      const charged = input.charge?.(fix.usage);
      if (charged !== null && charged !== undefined) {
        spendUsd += charged;
        cursor.spentUsd += charged;
      }
      cursor.fixCycles += 1;
      if (!fix.verified) {
        // Not marked seen: the item is retried next poll, up to maxAttemptsPerItem.
        const maxBackoff = input.limits.maxBackoffSeconds ?? DEFAULT_MAX_BACKOFF_SECONDS;
        const grown = input.limits.backoffSeconds * 2 ** Math.min(MAX_BACKOFF_EXPONENT, Math.max(0, cursor.fixCycles - 1));
        cursor.backoffSeconds = Math.max(cursor.backoffSeconds, Math.min(maxBackoff, grown));
        const attempts = (cursor.attempts![item.seenKey] ?? 0) + 1;
        cursor.attempts![item.seenKey] = attempts;
        if (attempts >= (input.limits.maxAttemptsPerItem ?? DEFAULT_MAX_ATTEMPTS)) {
          cursor.running = false;
          cursor.pausedReason = `Fix for ${item.thread ? "thread" : "check"} ${item.thread?.id ?? item.check!.id} was not verified after ${attempts} attempts.`;
          return { cursor, action: "pause", reason: cursor.pausedReason, replies, spendUsd };
        }
        continue;
      }
      if (item.thread && !withinScope(item.thread.path, input.allowedFiles)) {
        cursor.running = false;
        cursor.pausedReason = "The fix would leave the approved file set.";
        return { cursor, action: "blocked", reason: cursor.pausedReason, replies, spendUsd };
      }
      const applied = await input.apply(fix.edits ?? [], fix.summary);
      cursor.seen.push(item.seenKey);
      cursor.headSha = applied.sha;
      if (item.thread) {
        const replyKey = key("reply", item.thread.id, input.pr.headSha);
        if (!cursor.replies.includes(replyKey)) {
          cursor.replies.push(replyKey);
          replies.push({ threadId: item.thread.id, body: `Verified fix on ${applied.sha}. ${fix.evidence}` });
        }
      }
      if (cursor.spentUsd >= input.limits.maxSpendUsd) {
        cursor.running = false;
        cursor.pausedReason = "Autopilot spend limit reached.";
        return { cursor, action: "pause", reason: cursor.pausedReason, replies, spendUsd };
      }
    }
  } catch (error) {
    // A fixer, apply, or budget failure mid-cycle must not lose the fixes already applied or the spend
    // already charged, or the next poll would repeat them. The caller persists this partial cursor.
    if (error && typeof error === "object") (error as { partialCursor?: AutopilotCursor }).partialCursor = cursor;
    throw error;
  }

  const checksDone = input.pr.checks.length > 0 && input.pr.checks.every((check) => check.status === "completed" && (check.conclusion === "success" || check.conclusion === "neutral" || check.conclusion === "skipped"));
  const openThreads = input.pr.threads.filter((thread) => classifyThread(thread.body, withinScope(thread.path, input.allowedFiles)) === "actionable");
  const unresolved = openThreads.filter((thread) => !cursor.replies.includes(key("reply", thread.id, input.pr.headSha)) && !cursor.replies.includes(key("reply", thread.id, cursor.headSha ?? "")));
  if (checksDone && input.pr.approved && input.pr.mergeable && input.pr.protectionSatisfied && unresolved.length === 0 && actionable.length === 0) {
    cursor.running = false;
    cursor.pausedReason = undefined;
    return { cursor, action: "merge-ready", reason: "Required checks passed, the PR is approved, and no blocking thread remains. Not merged.", replies, spendUsd };
  }
  cursor.backoffSeconds = actionable.length > 0 ? Math.max(cursor.backoffSeconds, input.limits.backoffSeconds) : 0;
  return { cursor, action: "continue", reason: "Watcher is waiting for the next poll.", replies, spendUsd };
}
