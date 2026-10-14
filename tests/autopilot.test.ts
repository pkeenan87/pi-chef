import { describe, expect, it } from "vitest";
import { autopilotCycle, freshCursor } from "../src/github/autopilot.js";
import type { PullRequestSnapshot } from "../src/github/types.js";

function pr(over: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 7,
    url: "https://example.test/pull/7",
    branch: "cost/task/integration",
    base: "main",
    headSha: "aaa",
    baseSha: "base",
    mergeable: true,
    approved: false,
    protectionSatisfied: false,
    threads: [{ id: "t1", body: "null pointer in src/ingest.ts", path: "src/ingest.ts", sha: "aaa" }],
    checks: [{ id: "ci", name: "ci", status: "completed", conclusion: "failure", sha: "aaa", summary: "FAIL injected" }],
    ...over,
  };
}

describe("autopilot", () => {
  it("fixes a failing check and a comment once, then stops at merge-ready without merging", async () => {
    const fixes: string[] = [];
    let merged = false;
    const first = await autopilotCycle({
      cursor: freshCursor("2026-10-14T00:00:00.000Z"),
      pr: pr(),
      allowedFiles: ["src/ingest.ts", "src/alert.ts"],
      limits: { maxFixCycles: 5, maxSpendUsd: 10, maxRuntimeMs: 60_000, backoffSeconds: 30 },
      now: new Date("2026-10-14T00:01:00.000Z"),
      headRelation: "same",
      fixer: async (request) => {
        fixes.push(request.id);
        return { verified: true, evidence: "npm test exit 0", summary: "fix", edits: [{ path: "src/ingest.ts", content: "export {}\n" }] };
      },
      apply: async () => ({ sha: "bbb" }),
    });
    expect(fixes).toEqual(["t1", "ci"]);
    expect(first.replies).toHaveLength(1);
    expect(first.replies[0]?.body).toContain("npm test exit 0");
    expect(merged).toBe(false);

    const second = await autopilotCycle({
      cursor: first.cursor,
      pr: pr(),
      allowedFiles: ["src/ingest.ts"],
      limits: { maxFixCycles: 5, maxSpendUsd: 10, maxRuntimeMs: 60_000, backoffSeconds: 30 },
      now: new Date("2026-10-14T00:00:20.000Z"),
      headRelation: "same",
      fixer: async () => {
        throw new Error("duplicate");
      },
      apply: async () => ({ sha: "ccc" }),
    });
    expect(second.replies).toHaveLength(0);

    const ready = await autopilotCycle({
      cursor: first.cursor,
      pr: pr({
        headSha: "bbb",
        approved: true,
        protectionSatisfied: true,
        threads: [],
        checks: [{ id: "ci2", name: "ci", status: "completed", conclusion: "success", sha: "bbb" }],
      }),
      allowedFiles: ["src/ingest.ts"],
      limits: { maxFixCycles: 5, maxSpendUsd: 10, maxRuntimeMs: 60_000, backoffSeconds: 30 },
      now: new Date("2026-10-14T00:00:30.000Z"),
      headRelation: "fast-forward",
      fixer: async () => ({ verified: false, evidence: "", summary: "" }),
    });
    expect(ready.action).toBe("merge-ready");
    expect(ready.reason).toContain("Not merged");
  });

  it("pauses for a human security comment, a force push, and the fix cap", async () => {
    const security = await autopilotCycle({
      cursor: freshCursor("2026-10-14T00:00:00.000Z"),
      pr: pr({ threads: [{ id: "s", body: "please confirm the auth bypass", path: "src/auth.ts", sha: "aaa" }], checks: [] }),
      allowedFiles: ["src/auth.ts"],
      limits: { maxFixCycles: 5, maxSpendUsd: 10, maxRuntimeMs: 60_000, backoffSeconds: 1 },
      now: new Date("2026-10-14T00:01:00.000Z"),
      headRelation: "same",
      fixer: async () => { throw new Error("should not fix"); },
    });
    expect(security.action).toBe("blocked");

    const forced = await autopilotCycle({
      cursor: { ...freshCursor("2026-10-14T00:00:00.000Z"), headSha: "old", baseSha: "base" },
      pr: pr({ headSha: "rewritten", threads: [], checks: [] }),
      allowedFiles: [],
      limits: { maxFixCycles: 5, maxSpendUsd: 10, maxRuntimeMs: 60_000, backoffSeconds: 1 },
      now: new Date("2026-10-14T00:01:00.000Z"),
      headRelation: "force",
    });
    expect(forced.action).toBe("blocked");
    expect(forced.reason).toMatch(/Force push/);

    const capped = await autopilotCycle({
      cursor: freshCursor("2026-10-14T00:00:00.000Z"),
      pr: pr({
        threads: [],
        checks: Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, name: "ci", status: "completed" as const, conclusion: "failure" as const, sha: "aaa" })),
      }),
      allowedFiles: [],
      limits: { maxFixCycles: 5, maxSpendUsd: 10, maxRuntimeMs: 60_000, backoffSeconds: 1 },
      now: new Date("2026-10-14T00:01:00.000Z"),
      headRelation: "same",
      fixer: async () => ({ verified: false, evidence: "still failing", summary: "no" }),
      apply: async () => ({ sha: "zzz" }),
    });
    expect(capped.action).toBe("pause");
    expect(capped.cursor.fixCycles).toBe(5);
    expect(capped.replies).toHaveLength(0);
  });
});
