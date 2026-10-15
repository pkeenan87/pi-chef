import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync, type Stats } from "node:fs";
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

export interface RemoveWorktreeResult {
  ok: boolean;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  error?: string;
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
const DISABLED_PUSH_URL = "disabled-by-pi-cost-router://";

/** The GIT_CONFIG_* variables that make `git push` fail for the given remotes and for any other URL. See `GitWorkspace.childGitEnv`. */
export function pushDisabledGitEnv(remotes: string[]): Record<string, string> {
  const config: [string, string][] = [
    ...remotes.map((name): [string, string] => [`remote.${name}.pushurl`, DISABLED_PUSH_URL]),
    // An empty pushInsteadOf matches every URL, so pushes to a new remote or a literal URL go to the disabled scheme too.
    [`url.${DISABLED_PUSH_URL}.pushInsteadOf`, ""],
    ["credential.helper", ""],
    ["core.hooksPath", NO_HOOKS],
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(config.length), GIT_TERMINAL_PROMPT: "0" };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

function samePath(a: string, b: string): boolean {
  const resolve = (value: string) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return resolve(a) === resolve(b);
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

  /** Why worktrees cannot be made here (not a repository, or no commit yet), or undefined when they can. */
  async preflight(): Promise<string | undefined> {
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return `${this.repoRoot} is not a git repository. Run \`git init\` and make a first commit, then /implement again.`;
    }
    const head = await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.code !== 0) {
      return `The repository at ${this.repoRoot} has no commits yet, so there is nothing to branch worktrees from. Make a first commit (for example \`git commit --allow-empty -m "Initial commit"\`), then /implement again.`;
    }
    return undefined;
  }

  async createWorktree(spec: WorktreeSpec): Promise<CreatedWorktree> {
    mkdirSync(path.dirname(spec.dir), { recursive: true });
    const existing = (await this.listWorktrees()).find((item) => samePath(item.path, spec.dir));
    if (existing) {
      // Reuse a worktree left by a crashed run, but only if it is for the expected branch.
      if (existing.branch !== spec.branch) {
        throw new WorkflowError("GIT", `Worktree ${spec.dir} already exists on branch ${existing.branch || "(detached)"}, expected ${spec.branch}.`);
      }
      return { ...spec, headSha: await this.head(spec.dir) };
    }
    const branchExists = (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${spec.branch}`])).code === 0;
    const result = branchExists
      ? await this.git(["worktree", "add", spec.dir, spec.branch])
      : await this.git(["worktree", "add", "-b", spec.branch, spec.dir, spec.baseSha]);
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
    if (relative.startsWith("/") || relative.split("/").includes("..")) {
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
    // Walk each component between the root and the target with lstat, so a symlinked directory is
    // refused before mkdir can create anything through it.
    let cursor = root;
    for (const part of path.relative(root, path.dirname(absolute)).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      let stat: Stats | undefined;
      try {
        stat = lstatSync(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!stat) {
        mkdirSync(cursor);
      } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new WorkflowError("PATH_DENIED", `Refusing path ${file}: ${part} is a symlink or not a directory.`);
      }
    }
    // Defense in depth: the resolved parent must still sit inside the worktree.
    const realRoot = realpathSync(root);
    const realParent = realpathSync(path.dirname(absolute));
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
      throw new WorkflowError("PATH_DENIED", `Refusing path ${file}: resolves outside the worktree.`);
    }
    // lstat (not existsSync) so a dangling symlink is seen too.
    try {
      if (lstatSync(absolute).isSymbolicLink()) throw new WorkflowError("PATH_DENIED", `Refusing to write through symlink ${file}.`);
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // O_NOFOLLOW closes the race between the lstat above and the open.
    let fd: number;
    try {
      fd = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o666);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new WorkflowError("PATH_DENIED", `Refusing to write through symlink ${file}.`);
      throw error;
    }
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Commits everything in `cwd`. A worktree may hold hooks or config a ticket child wrote (hooks live in the shared
   * .git directory), so no hook runs and no fsmonitor command is started: `core.hooksPath=/dev/null`, `--no-verify`.
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

  async ensureBranch(branch: string, base: string): Promise<void> {
    const exists = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists.code === 0) return;
    const created = await this.git(["branch", "--", branch, base]);
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
    // The integration worktree is tool-owned and rebuilt from the base every time, so a branch an earlier plan version
    // merged (and later abandoned) does not linger in it. All-or-nothing: a conflict rolls back to this start.
    const reset = await this.git(["reset", "--hard", options.baseSha], options.worktreePath);
    if (reset.code !== 0) throw new WorkflowError("GIT", reset.stderr || reset.stdout);
    const startSha = await this.head(options.worktreePath);
    const rollback = async () => {
      await this.git(["merge", "--abort"], options.worktreePath);
      await this.git(["reset", "--hard", startSha], options.worktreePath);
    };
    for (const branch of options.branches) {
      const merge = await this.git(["merge", "--no-ff", "--no-commit", "--", branch], options.worktreePath);
      if (merge.code !== 0) {
        const files = await this.git(["diff", "--name-only", "--diff-filter=U"], options.worktreePath);
        const conflicted = files.stdout.split("\n").filter(Boolean);
        await rollback();
        if (conflicted.length === 0) {
          throw new WorkflowError("GIT", `Merge of ${branch} failed: ${merge.stderr || merge.stdout}`);
        }
        conflicts.push({ branch, files: conflicted });
        return { conflicts };
      }
      const commit = await this.git(["commit", "-m", `Integrate ${branch}`], options.worktreePath);
      if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        await rollback();
        throw new WorkflowError("GIT", commit.stderr || commit.stdout);
      }
    }
    return { sha: await this.head(options.worktreePath), conflicts };
  }

  async isMerged(branch: string, into: string): Promise<boolean> {
    const result = await this.git(["merge-base", "--is-ancestor", branch, into]);
    return result.code === 0;
  }

  /**
   * Removes the worktree and then (only if that succeeded) the branch. Never throws on git failure;
   * callers must check `ok` before dropping state for the worktree.
   */
  async removeWorktree(dir: string, branch?: string): Promise<RemoveWorktreeResult> {
    const removed = await this.git(["worktree", "remove", "--force", "--", dir]);
    if (removed.code !== 0) {
      return { ok: false, worktreeRemoved: false, branchDeleted: false, error: (removed.stderr || removed.stdout).trim() || "git worktree remove failed" };
    }
    if (!branch) return { ok: true, worktreeRemoved: true, branchDeleted: false };
    const deleted = await this.git(["branch", "-D", "--", branch]);
    if (deleted.code !== 0) {
      return { ok: false, worktreeRemoved: true, branchDeleted: false, error: (deleted.stderr || deleted.stdout).trim() || "git branch -D failed" };
    }
    return { ok: true, worktreeRemoved: true, branchDeleted: true };
  }

  /**
   * Environment for a ticket child so that git cannot publish from its worktree: every remote gets an unusable pushurl,
   * any URL (including a remote the child adds, or a URL on the command line) is rewritten for pushes to the same
   * unusable scheme, credential helpers and hooks are off, and git never prompts. Uses git's GIT_CONFIG_COUNT variables,
   * which override every config file, so the child cannot undo it by editing config.
   */
  async childGitEnv(cwd: string): Promise<Record<string, string>> {
    const remotes = await this.git(["remote"], cwd);
    return pushDisabledGitEnv(remotes.code === 0 ? remotes.stdout.split("\n").map((name) => name.trim()).filter(Boolean) : []);
  }

  async push(branch: string, remote = "origin"): Promise<GitResult> {
    return this.git(["push", "-u", "--", remote, branch]);
  }
}
