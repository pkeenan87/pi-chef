import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitWorkspace } from "../src/git/workspace.js";
import { tempRepo } from "./helpers.js";

describe("git helpers for the main checkout", () => {
  const exec = promisify(execFile);
  const sh = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

  it("falls back from origin/HEAD to main, then master, then the current branch", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    await sh(cwd, "branch", "-M", "trunk");
    expect(await git.defaultBranch()).toBe("trunk");
    await sh(cwd, "branch", "master");
    expect(await git.defaultBranch()).toBe("master");
    await sh(cwd, "branch", "main");
    expect(await git.defaultBranch()).toBe("main");
    await sh(cwd, "update-ref", "refs/remotes/origin/develop", "HEAD");
    await sh(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(await git.defaultBranch()).toBe("develop");
  });

  it("switchCreate carries uncommitted changes, and refuses a bad name", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    writeFileSync(path.join(cwd, "README.md"), "changed\n");
    await git.switchCreate("feature/x");
    expect(await git.currentBranch()).toBe("feature/x");
    expect(readFileSync(path.join(cwd, "README.md"), "utf8")).toBe("changed\n");
    expect(await git.statusPorcelain()).toContain("README.md");
    await expect(git.switchCreate("--detach")).rejects.toThrow(/valid branch name/);
    await expect(git.switchCreate("bad name")).rejects.toThrow(/valid branch name/);
    expect(await git.currentBranch()).toBe("feature/x");
  });

  it("counts commits ahead of the base and finds the merge base", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.defaultBranch();
    const start = await git.head();
    expect(await git.aheadOf(base)).toBe(0);
    await git.switchCreate("feature/y");
    writeFileSync(path.join(cwd, "a.txt"), "a\n");
    await git.commitAll(cwd, "one");
    writeFileSync(path.join(cwd, "b.txt"), "b\n");
    await git.commitAll(cwd, "two");
    expect(await git.aheadOf(base)).toBe(2);
    expect(await git.mergeBase(base)).toBe(start);
  });

  it("workingDiff covers commits, staged and unstaged edits, and untracked files without touching the index", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.defaultBranch();
    await git.switchCreate("feature/z");
    writeFileSync(path.join(cwd, "committed.txt"), "committed line\n");
    await git.commitAll(cwd, "committed");
    writeFileSync(path.join(cwd, "README.md"), "base\nedited line\n");
    writeFileSync(path.join(cwd, "untracked.txt"), "untracked line\n");
    const diff = await git.workingDiff(base);
    expect(diff).toContain("committed line");
    expect(diff).toContain("+edited line");
    expect(diff).toContain("+++ b/untracked.txt");
    expect(diff).toContain("+untracked line");
    expect(await git.statusPorcelain()).toContain("?? untracked.txt");
  });
});

describe("changedPaths", () => {
  const exec = promisify(execFile);
  const sh = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

  it("reports the new path of a rename and unquoted odd names", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    await sh(cwd, "mv", "README.md", "RENAMED.md");
    writeFileSync(path.join(cwd, "sp ace é.txt"), "x\n");
    const paths = (await git.changedPaths()).sort();
    expect(paths).toEqual(["RENAMED.md", "sp ace é.txt"]);
  });

  it("commitAll leaves excluded paths out", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    mkdirSync(path.join(cwd, "ws"));
    writeFileSync(path.join(cwd, "ws", "state.json"), "{}\n");
    writeFileSync(path.join(cwd, "a.txt"), "a\n");
    await git.commitAll(cwd, "pre", ["ws"]);
    expect((await sh(cwd, "show", "--name-only", "--format=", "HEAD")).stdout.trim()).toBe("a.txt");
    expect(await git.changedPaths()).toEqual(["ws/state.json"]);
  });
});

describe("commit identity", () => {
  const exec = promisify(execFile);
  const sh = (cwd: string, ...args: string[]) => exec("git", args, { cwd });
  const author = async (cwd: string) => (await sh(cwd, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).stdout.trim();

  async function withIsolatedGit<T>(run: () => Promise<T>): Promise<T> {
    const home = mkdtempSync(path.join(tmpdir(), "pi-cost-home-"));
    const names = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" });
    try {
      return await run();
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  }

  async function bareRepo(): Promise<string> {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-cost-id-"));
    await sh(cwd, "init");
    writeFileSync(path.join(cwd, "a.txt"), "a\n");
    return cwd;
  }

  it("commits as the repo's configured user", async () => {
    await withIsolatedGit(async () => {
      const cwd = await bareRepo();
      await sh(cwd, "config", "user.name", "Real Person");
      await sh(cwd, "config", "user.email", "real@example.com");
      await new GitWorkspace(cwd).commitAll(cwd, "mine");
      expect(await author(cwd)).toBe("Real Person <real@example.com>|Real Person <real@example.com>");
    });
  });

  it("falls back to pi-cost only for the part that is missing", async () => {
    await withIsolatedGit(async () => {
      const cwd = await bareRepo();
      await sh(cwd, "config", "user.name", "Only Name");
      await new GitWorkspace(cwd).commitAll(cwd, "half");
      expect(await author(cwd)).toBe("Only Name <pi-cost@localhost>|Only Name <pi-cost@localhost>");
    });
  });

  it("uses pi-cost when git has no identity at all", async () => {
    await withIsolatedGit(async () => {
      const cwd = await bareRepo();
      await new GitWorkspace(cwd).commitAll(cwd, "none");
      expect(await author(cwd)).toBe("pi-cost <pi-cost@localhost>|pi-cost <pi-cost@localhost>");
    });
  });

  it("treats the GIT_AUTHOR and GIT_COMMITTER variables as configured", async () => {
    await withIsolatedGit(async () => {
      const cwd = await bareRepo();
      Object.assign(process.env, { GIT_AUTHOR_NAME: "Env Author", GIT_AUTHOR_EMAIL: "env@example.com", GIT_COMMITTER_NAME: "Env Author", GIT_COMMITTER_EMAIL: "env@example.com" });
      await new GitWorkspace(cwd).commitAll(cwd, "env");
      expect(await author(cwd)).toBe("Env Author <env@example.com>|Env Author <env@example.com>");
    });
  });
});
