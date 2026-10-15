import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorkspace } from "../src/git/worktrees.js";
import { tempRepo } from "./helpers.js";

describe("git worktrees", () => {
  it("creates two branches from a recorded base and detects a conflict", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.head();
    const leftDir = path.join(cwd, ".pi-workflows", "worktrees", "left");
    const rightDir = path.join(cwd, ".pi-workflows", "worktrees", "right");
    const left = await git.createWorktree({ dir: leftDir, branch: "cost/left", baseSha: base });
    const right = await git.createWorktree({ dir: rightDir, branch: "cost/right", baseSha: base });
    expect(left.baseSha).toBe(base);
    expect(right.headSha).toBe(base);
    mkdirSync(path.join(leftDir, "src"), { recursive: true });
    mkdirSync(path.join(rightDir, "src"), { recursive: true });
    git.writeOwned(leftDir, "src/shared.ts", "export const value = 1;\n", ["src/shared.ts"]);
    git.writeOwned(rightDir, "src/shared.ts", "export const value = 2;\n", ["src/shared.ts"]);
    expect(() => git.writeOwned(leftDir, "../outside.ts", "x", ["../outside.ts"])).toThrow(/path/i);
    await git.commitAll(leftDir, "left");
    await git.commitAll(rightDir, "right");
    const integrated = await git.integrate({
      integrationBranch: "cost/integration",
      baseSha: base,
      worktreePath: path.join(cwd, ".pi-workflows", "worktrees", "integration"),
      branches: ["cost/left", "cost/right"],
    });
    expect(integrated.conflicts.length).toBe(1);
    expect(integrated.sha).toBeUndefined();
    const listed = await git.listWorktrees();
    const branches = listed.map((item) => item.branch);
    expect(branches).toEqual(expect.arrayContaining(["cost/integration", "cost/left", "cost/right"]));
    expect(branches).toHaveLength(4);
  });

  it("integrates independent files and removes a merged worktree", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.head();
    const aDir = path.join(cwd, ".wt", "a");
    const bDir = path.join(cwd, ".wt", "b");
    await git.createWorktree({ dir: aDir, branch: "cost/a", baseSha: base });
    await git.createWorktree({ dir: bDir, branch: "cost/b", baseSha: base });
    writeFileSync(path.join(aDir, "a.txt"), "a\n");
    writeFileSync(path.join(bDir, "b.txt"), "b\n");
    await git.commitAll(aDir, "a");
    await git.commitAll(bDir, "b");
    const integrated = await git.integrate({
      integrationBranch: "cost/integration",
      baseSha: base,
      worktreePath: path.join(cwd, ".wt", "integration"),
      branches: ["cost/a", "cost/b"],
    });
    expect(integrated.conflicts).toEqual([]);
    expect(integrated.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.isMerged("cost/a", "cost/integration")).toBe(true);
    await git.removeWorktree(aDir, "cost/a");
    const listed = await git.listWorktrees();
    expect(listed.some((item) => item.branch === "cost/a")).toBe(false);
  });

  it("rolls back earlier merges when a later one conflicts", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.head();
    const dirs = ["a", "b", "c"].map((n) => path.join(cwd, ".wt", n));
    for (const [i, n] of ["a", "b", "c"].entries()) await git.createWorktree({ dir: dirs[i]!, branch: `cost/${n}`, baseSha: base });
    writeFileSync(path.join(dirs[0]!, "a.txt"), "a\n");
    writeFileSync(path.join(dirs[1]!, "README.md"), "b\n");
    writeFileSync(path.join(dirs[2]!, "README.md"), "c\n");
    for (const [i, n] of ["a", "b", "c"].entries()) await git.commitAll(dirs[i]!, n);
    const wt = path.join(cwd, ".wt", "integration");
    const result = await git.integrate({ integrationBranch: "cost/integration", baseSha: base, worktreePath: wt, branches: ["cost/a", "cost/b", "cost/c"] });
    expect(result.sha).toBeUndefined();
    expect(result.conflicts).toEqual([{ branch: "cost/c", files: ["README.md"] }]);
    expect(await git.head(wt)).toBe(base);
    expect((await git.git(["status", "--porcelain"], wt)).stdout).toBe("");
  });

  it("throws (not a fake conflict) when the merge fails for another reason", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.head();
    await expect(
      git.integrate({ integrationBranch: "cost/integration", baseSha: base, worktreePath: path.join(cwd, ".wt", "i"), branches: ["cost/missing"] }),
    ).rejects.toThrow(/Merge of cost\/missing failed/);
  });

  it("createWorktree reuses an existing worktree and branch", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.head();
    const dir = path.join(cwd, ".wt", "r");
    await git.createWorktree({ dir, branch: "cost/r", baseSha: base });
    const again = await git.createWorktree({ dir, branch: "cost/r", baseSha: base });
    expect(again.headSha).toBe(base);
    await expect(git.createWorktree({ dir, branch: "cost/other", baseSha: base })).rejects.toThrow(/already exists/);
    // Worktree directory gone but branch survives (crash): re-attach.
    await git.git(["worktree", "remove", "--force", dir]);
    const reattached = await git.createWorktree({ dir, branch: "cost/r", baseSha: base });
    expect(reattached.headSha).toBe(base);
  });

  it("allows a..b.ts but refuses .. segments and symlink escapes", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.head();
    const dir = path.join(cwd, ".wt", "w");
    await git.createWorktree({ dir, branch: "cost/w", baseSha: base });
    git.writeOwned(dir, "a..b.ts", "x", ["a..b.ts"]);
    expect(() => git.writeOwned(dir, "src/../x.ts", "x", ["src/../x.ts"])).toThrow(/Refusing/);
    const outside = path.join(cwd, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(dir, "link"));
    expect(() => git.writeOwned(dir, "link/evil.ts", "x", ["link/evil.ts"])).toThrow(/symlink/);
    writeFileSync(path.join(outside, "target.txt"), "t");
    symlinkSync(path.join(outside, "target.txt"), path.join(dir, "file-link.txt"));
    expect(() => git.writeOwned(dir, "file-link.txt", "x", ["file-link.txt"])).toThrow(/symlink/);
  });

  it("refuses dangling symlinks and symlinked directory components without creating anything outside", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.head();
    const dir = path.join(cwd, ".wt", "s4");
    await git.createWorktree({ dir, branch: "cost/s4", baseSha: base });
    const outside = path.join(cwd, "outside-s4");
    mkdirSync(outside);
    // Dangling file symlink: existsSync would say false and the write would create the target.
    symlinkSync(path.join(outside, "created.txt"), path.join(dir, "dangling.txt"));
    expect(() => git.writeOwned(dir, "dangling.txt", "x", ["dangling.txt"])).toThrow(/symlink/);
    expect(existsSync(path.join(outside, "created.txt"))).toBe(false);
    // A symlinked directory component must not let mkdir create directories outside.
    symlinkSync(outside, path.join(dir, "linked"));
    expect(() => git.writeOwned(dir, "linked/new/deep.ts", "x", ["linked/new/deep.ts"])).toThrow(/symlink/);
    expect(existsSync(path.join(outside, "new"))).toBe(false);
    // Ordinary nested creation still works.
    git.writeOwned(dir, "fresh/nested/ok.ts", "ok", ["fresh/nested/ok.ts"]);
    expect(readFileSync(path.join(dir, "fresh/nested/ok.ts"), "utf8")).toBe("ok");
  });

  it("surfaces removeWorktree failure and keeps the branch", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const base = await git.head();
    const missing = await git.removeWorktree(path.join(cwd, ".wt", "nope"), "cost/keep");
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeTruthy();
    const dir = path.join(cwd, ".wt", "k");
    await git.createWorktree({ dir, branch: "cost/k", baseSha: base });
    const removed = await git.removeWorktree(dir, "cost/k");
    expect(removed).toMatchObject({ ok: true, worktreeRemoved: true, branchDeleted: true });
    await git.ensureBranch("cost/keep", base);
    expect((await git.removeWorktree(path.join(cwd, ".wt", "nope"), "cost/keep")).branchDeleted).toBe(false);
    expect((await git.git(["rev-parse", "--verify", "cost/keep"])).code).toBe(0);
  });
});
