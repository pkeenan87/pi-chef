import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WorkflowError } from "../domain.js";

const exec = promisify(execFile);

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Name and email to fall back to when the repo has no identity of its own (the user's identity is used otherwise). */
const FALLBACK_NAME = "pi-chef";
const FALLBACK_EMAIL = "pi-chef@localhost";

interface Identity {
  name: boolean;
  email: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat" };
}

/** Whether a name and an email are configured (global, system, local, includeIf) or set through the environment. */
async function resolveIdentity(cwd: string): Promise<Identity> {
  const env = gitEnv();
  // Probe with no fallback injected, or `config --get` would find the fallback.
  const probe = { name: true, email: true };
  const configured = async (key: string, vars: string[]) => {
    if (vars.some((name) => env[name]?.trim())) return true;
    const result = await runGit(cwd, ["config", "--get", key], probe);
    return result.code === 0 && result.stdout.trim() !== "";
  };
  return {
    name: await configured("user.name", ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]),
    email: await configured("user.email", ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]),
  };
}

async function runGit(cwd: string, args: string[], identity: Identity): Promise<GitResult> {
  // Commits are authored by the user; the pi-chef identity is only a fallback for the parts git has no value for.
  // commit.gpgsign=false always: a signing prompt would hang a non-interactive commit.
  const config = [
    ...(identity.name ? [] : ["-c", `user.name=${FALLBACK_NAME}`]),
    ...(identity.email ? [] : ["-c", `user.email=${FALLBACK_EMAIL}`]),
    "-c",
    "commit.gpgsign=false",
  ];
  try {
    const { stdout, stderr } = await exec("git", [...config, ...args], {
      cwd,
      encoding: "utf8",
      // A large branch diff (or untracked file) must not fail /review with an empty "git diff failed".
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? String(error) };
  }
}

const NO_HOOKS = "/dev/null";

/** True when both name the same directory, through symlinks (macOS `/tmp` is `/private/tmp`). */
export function samePath(a: string, b: string): boolean {
  const real = (dir: string) => {
    try {
      return realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  return real(a) === real(b);
}

/**
 * The main checkout of the repository `dir` belongs to, when `dir` is the top of a linked git worktree; else `dir`.
 * Reads only files (the worktree's `.git` file, then `commondir`), never git, so hot paths can call it.
 */
export function mainCheckoutOf(dir: string): string {
  try {
    const dotGit = path.join(dir, ".git");
    if (!statSync(dotGit).isFile()) return dir;
    const gitdir = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    if (!gitdir) return dir;
    const own = path.resolve(dir, gitdir);
    const common = path.resolve(own, readFileSync(path.join(own, "commondir"), "utf8").trim());
    // Only a plain `<main>/.git` directory has a checkout beside it (a bare repository has none).
    return path.basename(common) === ".git" && statSync(common).isDirectory() ? path.dirname(common) : dir;
  } catch {
    return dir;
  }
}

/**
 * The diff format the review and the static scan parse (`+++ b/<file>`, no colour), whatever the user's git config says
 * (`diff.mnemonicPrefix`, `diff.noprefix`, `color.ui=always`, `diff.external`): command-line options beat config.
 */
const PLAIN_DIFF = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

export class GitWorkspace {
  private identity?: Promise<Identity>;

  constructor(readonly repoRoot: string) {}

  async git(args: string[], cwd = this.repoRoot): Promise<GitResult> {
    this.identity ??= resolveIdentity(this.repoRoot);
    return runGit(cwd, args, await this.identity);
  }

  async head(cwd = this.repoRoot): Promise<string> {
    const result = await this.git(["rev-parse", "HEAD"], cwd);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git rev-parse failed");
    return result.stdout.trim();
  }

  /** Why /build and /review cannot run here (not a repository, or no commit yet), or undefined when they can. */
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
   * Commits everything in `cwd` except the `exclude` paths (relative to `cwd`). The tree may hold hooks or config a model wrote (hooks live in the .git directory), so no hook runs and no fsmonitor command is started: `core.hooksPath=/dev/null`, `--no-verify`.
   */
  async commitAll(cwd: string, message: string, exclude: string[] = []): Promise<string> {
    const safe = ["-c", `core.hooksPath=${NO_HOOKS}`, "-c", "core.fsmonitor=false"];
    const add = await this.git([...safe, "add", "-A", "--", ".", ...exclude.map((dir) => `:(exclude)${dir}`)], cwd);
    if (add.code !== 0) throw new WorkflowError("GIT", add.stderr);
    if (exclude.length > 0) {
      // `add` skips the excluded paths, but anything already staged there would still be committed.
      const unstage = await this.git([...safe, "reset", "-q", "--", ...exclude], cwd);
      if (unstage.code !== 0) throw new WorkflowError("GIT", unstage.stderr);
    }
    const commit = await this.git([...safe, "commit", "--no-verify", "-m", message], cwd);
    if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      throw new WorkflowError("GIT", commit.stderr || commit.stdout);
    }
    return this.head(cwd);
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

  /**
   * Creates and switches to a new branch at `startPoint` (a commit sha; HEAD when left out); uncommitted changes come
   * along when they do not conflict. The name is validated first (`switch -c` takes no `--`).
   */
  async switchCreate(branch: string, startPoint?: string): Promise<void> {
    await this.assertBranchName(branch);
    if (startPoint !== undefined) this.assertSha(startPoint);
    const result = await this.git(["switch", "-c", branch, ...(startPoint ? [startPoint] : [])]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `Could not create ${branch}`);
  }

  /** The commit /build branches from for `base`: the local branch, else `origin/<base>`, else HEAD. */
  async startPoint(base: string): Promise<string> {
    for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
      const result = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
    }
    return this.head();
  }

  /**
   * Adds a worktree at `dir`: on a new branch at `startPoint` when one is given, else on the existing `branch`. The
   * worktree gets its own index and working tree, so the checkout this runs in is not touched.
   */
  async addWorktree(dir: string, branch: string, startPoint?: string): Promise<void> {
    await this.assertBranchName(branch);
    if (startPoint !== undefined) this.assertSha(startPoint);
    const args = startPoint ? ["worktree", "add", "-b", branch, "--", dir, startPoint] : ["worktree", "add", "--", dir, branch];
    const result = await this.git(args);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `Could not add a worktree at ${dir}`);
  }

  /** The worktree that has `branch` checked out, or undefined (`git worktree list --porcelain`). */
  async worktreeOf(branch: string): Promise<string | undefined> {
    const result = await this.git(["worktree", "list", "--porcelain"]);
    if (result.code !== 0) return undefined;
    let dir: string | undefined;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
      else if (line === `branch refs/heads/${branch}` && dir) return dir;
    }
    return undefined;
  }

  private async assertBranchName(branch: string): Promise<void> {
    if (branch.startsWith("-") || (await this.git(["check-ref-format", "--branch", branch])).code !== 0) {
      throw new WorkflowError("GIT", `Not a valid branch name: ${branch}`);
    }
  }

  private assertSha(sha: string): void {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new WorkflowError("GIT", `Not a commit id: ${sha}`);
  }

  /** True when a local branch of this name exists. */
  async branchExists(branch: string): Promise<boolean> {
    return (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  }

  /** Switches to an existing local branch. Fails (git refuses) rather than carrying conflicting changes along. */
  async switchTo(branch: string): Promise<void> {
    await this.assertBranchName(branch);
    const result = await this.git(["switch", "--", branch]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `Could not switch to ${branch}`);
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

  /** Paths with changes (`git status --porcelain -z`): a rename reports its new path, and names are never quoted. */
  async changedPaths(): Promise<string[]> {
    const result = await this.git(["status", "--porcelain", "-z", "--untracked-files=all"]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git status failed");
    const fields = result.stdout.split("\0");
    const paths: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i]!;
      if (entry.length < 4) continue;
      paths.push(entry.slice(3));
      // A rename or copy is followed by its source path as its own field.
      if (/[RC]/.test(entry.slice(0, 2))) i++;
    }
    return paths;
  }

  /** How many commits HEAD has that `base` does not. */
  /** The newest commit in `since..HEAD` whose subject is exactly `subject`, or undefined (also on any git error). */
  async commitWithSubject(since: string, subject: string): Promise<string | undefined> {
    const result = await this.git(["log", "--format=%H%x00%s", `${since}..HEAD`, "--"]);
    if (result.code !== 0) return undefined;
    for (const line of result.stdout.split("\n")) {
      const [sha, text] = line.split("\0");
      if (sha && text?.trim() === subject.trim()) return sha;
    }
    return undefined;
  }

  async aheadOf(base: string): Promise<number> {
    const result = await this.git(["rev-list", "--count", `${base}..HEAD`, "--"]);
    if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || `Could not compare with ${base}`);
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  }

  /**
   * The working tree against the merge base with `base`: commits on the branch, staged and unstaged edits, and
   * untracked files. Untracked files are diffed against /dev/null, so the index is never touched. `exclude` paths
   * (repo-relative, such as the workspace dir) are left out.
   */
  async workingDiff(base: string, exclude: string[] = []): Promise<string> {
    const point = await this.mergeBase(base);
    const paths = ["--", ".", ...exclude.map((dir) => `:(exclude)${dir}`)];
    const tracked = await this.git(["diff", ...PLAIN_DIFF, point, ...paths]);
    if (tracked.code !== 0) throw new WorkflowError("GIT", tracked.stderr || "git diff failed");
    const listed = await this.git(["ls-files", "--others", "--exclude-standard", "-z", ...paths]);
    if (listed.code !== 0) throw new WorkflowError("GIT", listed.stderr || "git ls-files failed");
    const parts = [tracked.stdout];
    for (const file of listed.stdout.split("\0").filter(Boolean)) {
      // Exit code 1 is how --no-index says "the files differ".
      const added = await this.git(["diff", "--no-index", ...PLAIN_DIFF, "--", "/dev/null", file]);
      if (added.code > 1) throw new WorkflowError("GIT", added.stderr || `git diff failed for ${file}`);
      parts.push(added.stdout);
    }
    return parts.join("");
  }
}
