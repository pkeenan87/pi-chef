import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkflowError } from "../domain.js";
import type { CheckRun, GitHubClient, PullRequestSnapshot, ReviewThread } from "./types.js";

const exec = promisify(execFile);

export interface GhRunner {
  run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function defaultGhRunner(): GhRunner {
  return {
    async run(args, cwd) {
      try {
        const { stdout, stderr } = await exec("gh", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
    },
  };
}

const QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: OPEN, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number url headRefName baseRefName headRefOid baseRefOid mergeable reviewDecision mergeStateStatus
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            id isResolved isOutdated path line
            comments(first: 20) { nodes { id databaseId body author { login } } }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun { databaseId name status conclusion detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;
// Note: threads and check contexts use generous first:100 limits; if GitHub reports more pages we throw
// GH_TOO_LARGE rather than silently ignoring unresolved threads or failing checks.

interface GqlComment { id?: string; databaseId?: number | null; body?: string; author?: { login?: string } | null }
interface GqlThread { id: string; isResolved: boolean; isOutdated: boolean; path?: string | null; line?: number | null; comments?: { nodes?: GqlComment[] } }
interface GqlContext {
  __typename?: string;
  databaseId?: number | null;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
}
interface GqlPr {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid?: string;
  mergeable?: string;
  reviewDecision?: string | null;
  mergeStateStatus?: string;
  reviewThreads?: { pageInfo?: { hasNextPage?: boolean }; nodes?: GqlThread[] };
  commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: { pageInfo?: { hasNextPage?: boolean }; nodes?: GqlContext[] } } | null } }[] };
}

const FAILURE_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

export function parseRunUrl(url: string | null | undefined): { runId: string; jobId?: string } | undefined {
  const match = url?.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  return match ? { runId: match[1]!, jobId: match[2] } : undefined;
}

function mapContext(context: GqlContext, sha: string, index: number): CheckRun {
  if (context.__typename === "StatusContext" || context.context !== undefined) {
    const name = context.context ?? `status-${index}`;
    const state = context.state ?? "";
    const done = state === "SUCCESS" || state === "FAILURE" || state === "ERROR";
    return {
      id: `status:${name}`,
      name,
      status: done ? "completed" : "in_progress",
      conclusion: state === "SUCCESS" ? "success" : state === "FAILURE" || state === "ERROR" ? "failure" : null,
      sha,
      url: context.targetUrl ?? undefined,
    };
  }
  const name = context.name ?? `check-${index}`;
  const run = parseRunUrl(context.detailsUrl);
  const id = run?.jobId ? `${run.runId}:${run.jobId}` : `check:${context.databaseId ?? name}`;
  const status = context.status === "COMPLETED" ? "completed" : context.status === "IN_PROGRESS" ? "in_progress" : "queued";
  let conclusion: CheckRun["conclusion"] = null;
  if (status === "completed") {
    const raw = context.conclusion ?? "";
    conclusion = raw === "SUCCESS" ? "success" : FAILURE_CONCLUSIONS.has(raw) ? "failure" : raw === "SKIPPED" ? "skipped" : "neutral";
  }
  return { id, name, status, conclusion, sha, url: context.detailsUrl ?? undefined, runId: run?.runId };
}

function transient(message: string): WorkflowError {
  return new WorkflowError("GH_TRANSIENT", message);
}

export class GhCli implements GitHubClient {
  constructor(
    private readonly cwd: string,
    private readonly runner: GhRunner = defaultGhRunner(),
  ) {}

  /**
   * Returns undefined only when there is definitively no open PR for the branch.
   * Any other failure (non-zero exit, bad JSON, GraphQL errors) throws WorkflowError "GH_TRANSIENT"
   * so callers can re-arm instead of treating it as "no PR".
   */
  async findByBranch(branch: string): Promise<PullRequestSnapshot | undefined> {
    if (!branch || branch.startsWith("-")) throw new WorkflowError("GH_BAD_REF", `Invalid branch name: ${branch}`);
    const result = await this.runner.run(
      ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `branch=${branch}`, "-f", `query=${QUERY}`],
      this.cwd,
    );
    if (result.code !== 0) {
      if (/no pull requests found/i.test(result.stderr)) return undefined;
      throw transient(result.stderr.trim() || `gh api graphql exited with ${result.code}`);
    }
    let parsed: { data?: { repository?: { pullRequests?: { nodes?: GqlPr[] } } | null }; errors?: { message?: string }[] };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw transient("gh returned unparseable JSON.");
    }
    if (parsed.errors?.length && !parsed.data?.repository) throw transient(parsed.errors.map((e) => e.message).join("; "));
    const nodes = parsed.data?.repository?.pullRequests?.nodes;
    if (!nodes) throw transient("gh response had no repository data.");
    const pr = nodes[0];
    return pr ? this.toSnapshot(pr) : undefined;
  }

  async upsert(input: { branch: string; base: string; title: string; body: string }): Promise<PullRequestSnapshot> {
    const existing = await this.findByBranch(input.branch);
    if (existing) {
      const edited = await this.runner.run(["pr", "edit", "--title", input.title, "--body", input.body, "--", String(existing.number)], this.cwd);
      if (edited.code !== 0) throw new Error(edited.stderr || "gh pr edit failed");
      return { ...existing, ...input, branch: input.branch, base: input.base };
    }
    if (input.base.startsWith("-")) throw new WorkflowError("GH_BAD_REF", `Invalid base branch: ${input.base}`);
    const created = await this.runner.run(
      ["pr", "create", "--base", input.base, "--head", input.branch, "--title", input.title, "--body", input.body],
      this.cwd,
    );
    if (created.code !== 0) throw new Error(created.stderr || "gh pr create failed");
    const found = await this.findByBranch(input.branch);
    if (!found) throw new Error("Pull request was created but could not be read back.");
    return found;
  }

  async reply(threadId: string, body: string): Promise<void> {
    if (!/^\d+$/.test(threadId)) throw new WorkflowError("GH_BAD_REF", `Invalid review comment id: ${threadId}`);
    const result = await this.runner.run(["api", `repos/{owner}/{repo}/pulls/comments/${threadId}/replies`, "-f", `body=${body}`], this.cwd);
    if (result.code !== 0) throw new Error(result.stderr || "Could not reply to the review thread.");
  }

  async fileAt(sha: string, file: string): Promise<string> {
    const result = await this.runner.run(["api", `repos/{owner}/{repo}/contents/${file}?ref=${sha}`, "--jq", ".content"], this.cwd);
    if (result.code !== 0) return "";
    return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
  }

  /** checkId is "<runId>:<jobId>" as produced by findByBranch; anything else has no retrievable log. */
  async checkLog(checkId: string): Promise<string> {
    const match = checkId.match(/^(\d+):(\d+)$/);
    if (!match) return `Log unavailable: check ${checkId} is not a GitHub Actions job.`;
    const result = await this.runner.run(["run", "view", match[1]!, "--job", match[2]!, "--log-failed"], this.cwd);
    const text = result.code === 0 ? result.stdout : "";
    return text || `Log unavailable: ${result.stderr.trim() || "no failed-step output"}`;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.runner.run(["api", `repos/{owner}/{repo}/compare/${ancestor}...${descendant}`, "--jq", ".status"], this.cwd);
    const status = result.stdout.trim();
    return status === "ahead" || status === "identical";
  }

  async wasMerged(branch: string): Promise<boolean> {
    if (!branch || branch.startsWith("-")) throw new WorkflowError("GH_BAD_REF", `Invalid branch name: ${branch}`);
    const result = await this.runner.run(["pr", "list", "--head", branch, "--state", "merged", "--json", "number", "--limit", "1"], this.cwd);
    if (result.code !== 0) throw transient(result.stderr.trim() || `gh pr list exited with ${result.code}`);
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      throw transient("gh returned unparseable JSON.");
    }
  }

  private toSnapshot(pr: GqlPr): PullRequestSnapshot {
    if (pr.reviewThreads?.pageInfo?.hasNextPage) throw new WorkflowError("GH_TOO_LARGE", "PR has more than 100 review threads.");
    const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    if (rollup?.pageInfo?.hasNextPage) throw new WorkflowError("GH_TOO_LARGE", "PR has more than 100 status checks.");
    const threads: ReviewThread[] = [];
    for (const thread of pr.reviewThreads?.nodes ?? []) {
      if (thread.isResolved) continue;
      const first = thread.comments?.nodes?.[0];
      if (!first || first.databaseId == null) continue;
      threads.push({
        id: String(first.databaseId),
        nodeId: thread.id,
        body: first.body ?? "",
        path: thread.path ?? undefined,
        sha: pr.headRefOid,
        outdated: thread.isOutdated,
      });
    }
    const checks = (rollup?.nodes ?? []).map((context, index) => mapContext(context, pr.headRefOid, index));
    const approved = pr.reviewDecision === "APPROVED";
    return {
      number: pr.number,
      url: pr.url,
      branch: pr.headRefName,
      base: pr.baseRefName,
      headSha: pr.headRefOid,
      baseSha: pr.baseRefOid ?? "",
      mergeable: pr.mergeable !== "CONFLICTING",
      approved,
      protectionSatisfied: pr.mergeStateStatus ? pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "HAS_HOOKS" : approved,
      threads,
      checks,
    };
  }
}
