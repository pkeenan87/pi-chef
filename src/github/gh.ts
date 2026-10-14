import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

interface GhPr {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid?: string;
  mergeable?: string;
  reviewDecision?: string;
  statusCheckRollup?: { name?: string; status?: string; conclusion?: string; state?: string }[];
  reviews?: { state?: string }[];
}

export class GhCli implements GitHubClient {
  constructor(
    private readonly cwd: string,
    private readonly runner: GhRunner = defaultGhRunner(),
  ) {}

  async findByBranch(branch: string): Promise<PullRequestSnapshot | undefined> {
    const result = await this.runner.run(
      ["pr", "view", branch, "--json", "number,url,headRefName,baseRefName,headRefOid,baseRefOid,mergeable,reviewDecision,statusCheckRollup"],
      this.cwd,
    );
    if (result.code !== 0) return undefined;
    return this.toSnapshot(JSON.parse(result.stdout) as GhPr, [], []);
  }

  async upsert(input: { branch: string; base: string; title: string; body: string }): Promise<PullRequestSnapshot> {
    const existing = await this.findByBranch(input.branch);
    if (existing) {
      await this.runner.run(["pr", "edit", String(existing.number), "--title", input.title, "--body", input.body], this.cwd);
      return { ...existing, ...input, branch: input.branch, base: input.base };
    }
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
    const result = await this.runner.run(["api", `repos/{owner}/{repo}/pulls/comments/${threadId}/replies`, "-f", `body=${body}`], this.cwd);
    if (result.code !== 0) throw new Error(result.stderr || "Could not reply to the review thread.");
  }

  async fileAt(sha: string, file: string): Promise<string> {
    const result = await this.runner.run(["api", `repos/{owner}/{repo}/contents/${file}?ref=${sha}`, "--jq", ".content"], this.cwd);
    if (result.code !== 0) return "";
    return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
  }

  async checkLog(checkId: string): Promise<string> {
    const result = await this.runner.run(["run", "view", checkId, "--log"], this.cwd);
    return result.stdout || result.stderr;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.runner.run(["api", `repos/{owner}/{repo}/compare/${ancestor}...${descendant}`, "--jq", ".status"], this.cwd);
    const status = result.stdout.trim();
    return status === "ahead" || status === "identical";
  }

  private toSnapshot(pr: GhPr, threads: ReviewThread[], checks: CheckRun[]): PullRequestSnapshot {
    const rollup = checks.length
      ? checks
      : (pr.statusCheckRollup ?? []).map((check, index) => ({
          id: `${pr.headRefOid}:${check.name ?? index}`,
          name: check.name ?? "check",
          status: "completed" as const,
          conclusion: (check.conclusion === "FAILURE" ? "failure" : check.conclusion === "SUCCESS" ? "success" : "neutral") as CheckRun["conclusion"],
          sha: pr.headRefOid,
        }));
    return {
      number: pr.number,
      url: pr.url,
      branch: pr.headRefName,
      base: pr.baseRefName,
      headSha: pr.headRefOid,
      baseSha: pr.baseRefOid ?? "",
      mergeable: pr.mergeable !== "CONFLICTING",
      approved: pr.reviewDecision === "APPROVED",
      protectionSatisfied: pr.reviewDecision === "APPROVED",
      threads,
      checks: rollup,
    };
  }
}
