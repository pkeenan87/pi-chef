import { describe, expect, it } from "vitest";
import { GhCli, parseRunUrl, type GhRunner } from "../src/github/gh.js";

function runner(result: { code: number; stdout: string; stderr?: string }, calls: string[][] = []): GhRunner {
  return {
    async run(args) {
      calls.push(args);
      return { stderr: "", ...result };
    },
  };
}

function payload(pr: object | null) {
  return JSON.stringify({ data: { repository: { pullRequests: { nodes: pr ? [pr] : [] } } } });
}

const basePr = {
  number: 3,
  url: "https://github.com/o/r/pull/3",
  headRefName: "feat",
  baseRefName: "main",
  headRefOid: "h1",
  baseRefOid: "b1",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN",
  reviewThreads: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { id: "N1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 4, comments: { nodes: [{ id: "C1", databaseId: 101, body: "null bug", author: { login: "x" } }] } },
      { id: "N2", isResolved: true, isOutdated: false, path: "src/b.ts", comments: { nodes: [{ id: "C2", databaseId: 102, body: "done" }] } },
    ],
  },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { __typename: "CheckRun", databaseId: 9, name: "unit", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "https://github.com/o/r/actions/runs/555/job/777" },
                { __typename: "CheckRun", databaseId: 10, name: "lint", status: "IN_PROGRESS", conclusion: null, detailsUrl: "https://github.com/o/r/actions/runs/555/job/778" },
                { __typename: "CheckRun", databaseId: 11, name: "ok", status: "COMPLETED", conclusion: "SUCCESS" },
                { __typename: "StatusContext", context: "ci/ext", state: "ERROR" },
                { __typename: "StatusContext", context: "ci/wait", state: "PENDING" },
                { __typename: "StatusContext", context: "ci/good", state: "SUCCESS" },
              ],
            },
          },
        },
      },
    ],
  },
};

describe("GhCli.findByBranch", () => {
  it("maps threads, checks, and merge state from one graphql call", async () => {
    const calls: string[][] = [];
    const gh = new GhCli("/x", runner({ code: 0, stdout: payload(basePr) }, calls));
    const snap = await gh.findByBranch("feat");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(snap?.threads).toEqual([{ id: "101", nodeId: "N1", body: "null bug", path: "src/a.ts", sha: "h1", outdated: false }]);
    const byName = Object.fromEntries(snap!.checks.map((c) => [c.name, c]));
    expect(byName.unit).toMatchObject({ id: "555:777", status: "completed", conclusion: "failure", runId: "555" });
    expect(byName.lint).toMatchObject({ status: "in_progress", conclusion: null });
    expect(byName.ok?.conclusion).toBe("success");
    expect(byName["ci/ext"]).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(byName["ci/wait"]).toMatchObject({ status: "in_progress", conclusion: null });
    expect(byName["ci/good"]).toMatchObject({ status: "completed", conclusion: "success" });
    expect(snap).toMatchObject({ approved: true, protectionSatisfied: true, mergeable: true, headSha: "h1", baseSha: "b1" });
  });

  it("derives protectionSatisfied from mergeStateStatus", async () => {
    const gh = new GhCli("/x", runner({ code: 0, stdout: payload({ ...basePr, mergeStateStatus: "BLOCKED" }) }));
    expect((await gh.findByBranch("feat"))?.protectionSatisfied).toBe(false);
  });

  it("returns undefined for no PR but throws GH_TRANSIENT on failures", async () => {
    expect(await new GhCli("/x", runner({ code: 0, stdout: payload(null) })).findByBranch("feat")).toBeUndefined();
    await expect(new GhCli("/x", runner({ code: 1, stdout: "", stderr: "network down" })).findByBranch("feat")).rejects.toMatchObject({ code: "GH_TRANSIENT" });
    await expect(new GhCli("/x", runner({ code: 0, stdout: "not json" })).findByBranch("feat")).rejects.toMatchObject({ code: "GH_TRANSIENT" });
  });

  it("rejects option-like branch names", async () => {
    await expect(new GhCli("/x", runner({ code: 0, stdout: payload(null) })).findByBranch("--evil")).rejects.toMatchObject({ code: "GH_BAD_REF" });
  });
});

describe("GhCli.checkLog", () => {
  it("parses run and job ids and uses --log-failed", async () => {
    const calls: string[][] = [];
    const gh = new GhCli("/x", runner({ code: 0, stdout: "boom" }, calls));
    expect(await gh.checkLog("555:777")).toBe("boom");
    expect(calls[0]).toEqual(["run", "view", "555", "--job", "777", "--log-failed"]);
  });

  it("reports log unavailable without a run id", async () => {
    const calls: string[][] = [];
    const gh = new GhCli("/x", runner({ code: 0, stdout: "" }, calls));
    expect(await gh.checkLog("status:ci/ext")).toMatch(/Log unavailable/);
    expect(calls).toHaveLength(0);
  });

  it("parseRunUrl extracts ids", () => {
    expect(parseRunUrl("https://github.com/o/r/actions/runs/1/job/2")).toEqual({ runId: "1", jobId: "2" });
    expect(parseRunUrl("https://example.com")).toBeUndefined();
  });
});
