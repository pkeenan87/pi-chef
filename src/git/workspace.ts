import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkflowError } from "../domain.js";

const exec = promisify(execFile);

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
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

const NO_HOOKS = "/dev/null";

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

  /** Why /build and /ship cannot run here (not a repository, or no commit yet), or undefined when they can. */
  async preflight(): Promise<string | undefined> {
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return `${this.repoRoot} is not a git repository. Run \`git init\` and make a first commit, then /build again.`;
    }
    const head = await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.code !== 0) {
      return `The repository at ${this.repoRoot} has no commits yet, so there is nothing to branch from. Make a first commit (for example \`git commit --allow-empty -m "Initial commit"\`), then /build again.`;
    }
    return undefined;
  }

  /**
   * Commits everything in `cwd`. The tree may hold hooks or config a model wrote (hooks live in the .git directory), so no hook runs and no fsmonitor command is started: `core.hooksPath=/dev/null`, `--no-verify`.
   */
  async commitAll(cwd: string, message: string): Promise<string> {
    const safe = ["-c", `core.hooksPath=${NO_HOOKS}`, "-c", "core.fsmonitor=false"];
    const add = await this.git([...safe, "add", "-A"], cwd);
    if (add.code !== 0) throw new WorkflowError("GIT", add.stderr);
    const commit = await this.git([...safe, "commit", "--no-verify", "-m", message], cwd);
    if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      throw new WorkflowError("GIT", commit.stderr || commit.stdout);
    }
    return this.head(cwd);
  }

  async diff(cwd: string, base: string): Promise<string> {
    const result = await this.git(["diff", `${base}...HEAD`, "--"], cwd);
    if (result.code !== 0) {
      const fallback = await this.git(["diff", base, "--"], cwd);
      return fallback.stdout;
    }
    return result.stdout;
  }

  /** The checked-out branch name, or "HEAD" when detached. */
  async currentBranch(): Promise<string> {
    const result = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git rev-parse failed");
    return result.stdout.trim();
  }

  /** `origin/HEAD` when set, else a local `main` or `master`, else the current branch. */
  async defaultBranch(): Promise<string> {
    const remote = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const named = remote.stdout.trim().replace(/^origin\//, "");
    if (remote.code === 0 && named) return named;
    for (const name of ["main", "master"]) {
      if ((await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])).code === 0) return name;
    }
    return this.currentBranch();
  }

  /** Creates and switches to a new branch; uncommitted changes come along. The name is validated first (`switch -c` takes no `--`). */
  async switchCreate(branch: string): Promise<void> {
    if (branch.startsWith("-") || (await this.git(["check-ref-format", "--branch", branch])).code !== 0) {
      throw new WorkflowError("GIT", `Not a valid branch name: ${branch}`);
    }
    const result = await this.git(["switch", "-c", branch]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `Could not create ${branch}`);
  }

  /** The commit where HEAD left `base`. */
  async mergeBase(base: string): Promise<string> {
    const result = await this.git(["merge-base", "HEAD", base]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `No merge base with ${base}`);
    return result.stdout.trim();
  }

  /** `git status --porcelain`: empty when the tree is clean. */
  async statusPorcelain(): Promise<string> {
    const result = await this.git(["status", "--porcelain"]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git status failed");
    return result.stdout;
  }

  /** How many commits HEAD has that `base` does not. */
  async aheadOf(base: string): Promise<number> {
    const result = await this.git(["rev-list", "--count", `${base}..HEAD`, "--"]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `Could not compare with ${base}`);
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  }

  /**
   * The working tree against the merge base with `base`: commits on the branch, staged and unstaged edits, and
   * untracked files. Untracked files are diffed against /dev/null, so the index is never touched.
   */
  async workingDiff(base: string): Promise<string> {
    const point = await this.mergeBase(base);
    const tracked = await this.git(["diff", point, "--"]);
    if (tracked.code !== 0) throw new WorkflowError("GIT", tracked.stderr || "git diff failed");
    const listed = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (listed.code !== 0) throw new WorkflowError("GIT", listed.stderr || "git ls-files failed");
    const parts = [tracked.stdout];
    for (const file of listed.stdout.split("\0").filter(Boolean)) {
      // Exit code 1 is how --no-index says "the files differ".
      const added = await this.git(["diff", "--no-index", "--", "/dev/null", file]);
      if (added.code > 1) throw new WorkflowError("GIT", added.stderr || `git diff failed for ${file}`);
      parts.push(added.stdout);
    }
    return parts.join("");
  }

  async push(branch: string, remote = "origin"): Promise<GitResult> {
    return this.git(["push", "-u", "--", remote, branch]);
  }
}
