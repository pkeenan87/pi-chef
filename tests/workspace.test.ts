import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
