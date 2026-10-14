import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WorkflowError } from "../domain.js";

const exec = promisify(execFile);

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeSpec {
  dir: string;
  branch: string;
  baseSha: string;
}

export interface CreatedWorktree extends WorktreeSpec {
  headSha: string;
}

export interface IntegrateResult {
  sha?: string;
  conflicts: { branch: string; files: string[] }[];
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", ["-c", "user.email=pi-cost@localhost", "-c", "user.name=pi-cost", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? String(error) };
  }
}

export class GitWorkspace {
  constructor(readonly repoRoot: string) {}

  async git(args: string[], cwd = this.repoRoot): Promise<GitResult> {
    return runGit(cwd, args);
  }

  async head(cwd = this.repoRoot): Promise<string> {
    const result = await this.git(["rev-parse", "HEAD"], cwd);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git rev-parse failed");
    return result.stdout.trim();
  }

  async createWorktree(spec: WorktreeSpec): Promise<CreatedWorktree> {
    mkdirSync(path.dirname(spec.dir), { recursive: true });
    const result = await this.git(["worktree", "add", "-b", spec.branch, spec.dir, spec.baseSha]);
    if (result.code !== 0) {
      throw new WorkflowError("GIT", `Could not create worktree ${spec.branch}: ${result.stderr || result.stdout}`);
    }
    const headSha = await this.head(spec.dir);
    return { ...spec, headSha };
  }

  async listWorktrees(): Promise<{ path: string; branch: string; sha: string }[]> {
    const result = await this.git(["worktree", "list", "--porcelain"]);
    if (result.code !== 0) return [];
    const items: { path: string; branch: string; sha: string }[] = [];
    let current: { path?: string; branch?: string; sha?: string } = {};
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path && current.sha) items.push({ path: current.path, branch: current.branch ?? "", sha: current.sha });
        current = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("HEAD ")) current.sha = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    }
    if (current.path && current.sha) items.push({ path: current.path, branch: current.branch ?? "", sha: current.sha });
    return items;
  }

  writeOwned(worktree: string, file: string, content: string, allowed: string[]): void {
    const relative = file.replaceAll("\\", "/").replace(/^\.\//, "");
    if (relative.startsWith("/") || relative.includes("..")) {
      throw new WorkflowError("PATH_DENIED", `Refusing path ${file}`);
    }
    if (!allowed.includes(relative)) {
      throw new WorkflowError("PATH_DENIED", `${relative} is outside this worker's files.`);
    }
    const absolute = path.resolve(worktree, relative);
    const root = path.resolve(worktree);
    if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== root) {
      throw new WorkflowError("PATH_DENIED", `Refusing path ${file}`);
    }
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }

  async commitAll(cwd: string, message: string): Promise<string> {
    const add = await this.git(["add", "-A"], cwd);
    if (add.code !== 0) throw new WorkflowError("GIT", add.stderr);
    const commit = await this.git(["commit", "-m", message], cwd);
    if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      throw new WorkflowError("GIT", commit.stderr || commit.stdout);
    }
    return this.head(cwd);
  }

  async diff(cwd: string, base: string): Promise<string> {
    const result = await this.git(["diff", `${base}...HEAD`], cwd);
    if (result.code !== 0) {
      const fallback = await this.git(["diff", base], cwd);
      return fallback.stdout;
    }
    return result.stdout;
  }

  async ensureBranch(branch: string, base: string): Promise<void> {
    const exists = await this.git(["rev-parse", "--verify", "--quiet", branch]);
    if (exists.code === 0) return;
    const created = await this.git(["branch", branch, base]);
    if (created.code !== 0) throw new WorkflowError("GIT", created.stderr || `Could not create ${branch}`);
  }

  async integrate(options: {
    integrationBranch: string;
    baseSha: string;
    worktreePath: string;
    branches: string[];
  }): Promise<IntegrateResult> {
    await this.ensureBranch(options.integrationBranch, options.baseSha);
    if (!existsSync(options.worktreePath)) {
      const added = await this.git(["worktree", "add", options.worktreePath, options.integrationBranch]);
      if (added.code !== 0) throw new WorkflowError("GIT", added.stderr || added.stdout);
    }
    const conflicts: IntegrateResult["conflicts"] = [];
    for (const branch of options.branches) {
      const merge = await this.git(["merge", "--no-ff", "--no-commit", branch], options.worktreePath);
      if (merge.code !== 0) {
        const files = await this.git(["diff", "--name-only", "--diff-filter=U"], options.worktreePath);
        await this.git(["merge", "--abort"], options.worktreePath);
        conflicts.push({ branch, files: files.stdout.split("\n").filter(Boolean) });
        return { conflicts };
      }
      const commit = await this.git(["commit", "-m", `Integrate ${branch}`], options.worktreePath);
      if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        throw new WorkflowError("GIT", commit.stderr || commit.stdout);
      }
    }
    return { sha: await this.head(options.worktreePath), conflicts };
  }

  async isMerged(branch: string, into: string): Promise<boolean> {
    const result = await this.git(["merge-base", "--is-ancestor", branch, into]);
    return result.code === 0;
  }

  async removeWorktree(dir: string, branch?: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", dir]);
    if (branch) await this.git(["branch", "-D", branch]);
  }

  async push(branch: string, remote = "origin"): Promise<GitResult> {
    return this.git(["push", "-u", remote, branch]);
  }
}
