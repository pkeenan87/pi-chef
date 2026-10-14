export interface ReviewThread {
  id: string;
  body: string;
  path?: string;
  sha: string;
  inReplyTo?: string;
}

export interface CheckRun {
  id: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "neutral" | "skipped" | null;
  sha: string;
  summary?: string;
}

export interface PullRequestSnapshot {
  number: number;
  url: string;
  branch: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeable: boolean;
  approved: boolean;
  protectionSatisfied: boolean;
  threads: ReviewThread[];
  checks: CheckRun[];
}

export interface GitHubClient {
  findByBranch(branch: string): Promise<PullRequestSnapshot | undefined>;
  upsert(input: { branch: string; base: string; title: string; body: string }): Promise<PullRequestSnapshot>;
  reply(threadId: string, body: string): Promise<void>;
  fileAt(sha: string, file: string): Promise<string>;
  checkLog(checkId: string): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

export type FindingClass = "actionable" | "informational" | "ambiguous" | "human";

const SECURITY = /\b(auth|secret|credential|permission|production|exploit|vulnerability|cve)\b/i;
const HUMAN = /\b(please confirm|need a human|out of scope|product decision|security review)\b/i;

export function classifyThread(body: string, inScope: boolean): FindingClass {
  if (SECURITY.test(body) || HUMAN.test(body)) return "human";
  if (!inScope) return "human";
  if (/\b(nit|style|optional|consider)\b/i.test(body)) return "informational";
  if (/\b(fail|error|null|bug|broken|fix|test)\b/i.test(body) || body.includes(".ts") || body.includes(".js")) {
    return "actionable";
  }
  if (body.trim().length < 12) return "ambiguous";
  return "ambiguous";
}

export function classifyCheck(check: CheckRun): FindingClass {
  if (check.status !== "completed") return "informational";
  if (check.conclusion === "failure") return "actionable";
  return "informational";
}
