import { mkdirSync, writeFileSync } from "node:fs";
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
});
