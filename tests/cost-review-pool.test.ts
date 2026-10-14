import { describe, expect, it } from "vitest";
import { runWorkerPool } from "../src/agents/pool.js";
import { baselineFromRecords, budgetStatus, buildCostRecord, compareBaseline, summarize, toCsv } from "../src/cost/ledger.js";
import { reviewDiff, type CheckRunner } from "../src/review/review.js";
import { emptyUsage } from "../src/domain.js";

describe("cost, review, and workers", () => {
  it("keeps missing usage unknown and exports it as blank", () => {
    const pricing = [{ provider: "openai", model: "gpt-5.4", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2, outputPerMillionUsd: 10 }];
    const known = buildCostRecord({
      provider: "openai", model: "gpt-5.4", phase: "IMPLEMENTING", taskId: "t", tier: "premium",
      usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, requests: 1 },
      outcome: "success", retries: 1, reason: "ok",
    }, pricing, new Date("2026-10-14T00:00:00Z"), "a");
    const unknown = buildCostRecord({
      provider: "openai", model: "gpt-5.4", phase: "IMPLEMENTING", taskId: "t", tier: "premium",
      usage: emptyUsage(), outcome: "unknown", retries: 0, reason: "no usage",
    }, pricing, new Date("2026-10-14T00:00:00Z"), "b");
    expect(known.actualUsd).toBeCloseTo(0.012);
    expect(unknown.actualUsd).toBeNull();
    expect(unknown.usageKnown).toBe(false);
    const summary = summarize([known, unknown]);
    expect(summary.knownUsd).toBeCloseTo(0.012);
    expect(summary.unknownRecords).toBe(1);
    const csv = toCsv([unknown]).trim().split("\n");
    const header = csv[0]!.split(",");
    const row = csv[1]!.split(",");
    expect(csv[1]).toContain("no usage");
    expect(row[header.indexOf("actualUsd")]).toBe("");
    expect(row[header.indexOf("usageKnown")]).toBe("false");
    expect(budgetStatus(20, 20, 0.8)).toBe("hard");
    expect(compareBaseline(baselineFromRecords([known], { source: "this-workflow", regressions: 0, interventions: 1 }), {
      source: "cursor-auto", costPerMergedPrUsd: 1, timeToMergeReadyMs: 10, successRate: 1, retries: 0, regressions: 1, interventions: 2,
    }).regressions).toBe(-1);
  });

  it("blocks a failing check and a secret in the diff without claiming a pass", async () => {
    const failing = await reviewDiff({
      diffs: [{ groupId: "main", diff: "export const value = 1;\n" }],
      integratedDiff: "",
      checks: [{ name: "unit", command: "npm", args: ["test"] }],
      cwd: "/tmp",
      allowlist: ["npm test"],
      planAcceptance: [],
      runner: { async run() { return { code: 1, stdout: "", stderr: "FAIL injected test" }; } } satisfies CheckRunner,
    });
    expect(failing.passed).toBe(false);
    expect(failing.claimedPass).toBe(false);
    expect(failing.findings.some((finding) => finding.severity === "blocking" && finding.evidence.includes("FAIL injected"))).toBe(true);

    const secret = "sk-live-SECRETVALUE123456";
    const leak = await reviewDiff({
      diffs: [{ groupId: "main", diff: `const password = "${secret}";\n` }],
      integratedDiff: "",
      checks: [{ name: "unit", command: "npm", args: ["test"] }],
      cwd: "/tmp",
      allowlist: ["npm test"],
      planAcceptance: [],
      runner: { async run() { return { code: 0, stdout: "ok", stderr: "" }; } } satisfies CheckRunner,
    });
    expect(leak.passed).toBe(false);
    expect(JSON.stringify(leak)).not.toContain(secret);
    expect(leak.findings.some((finding) => finding.category === "secrets")).toBe(true);
  });

  it("runs two workers at once and refuses a shared file at the same time", async () => {
    let inFlight = 0;
    let max = 0;
    const result = await runWorkerPool({
      concurrency: 2,
      jobs: [
        { id: "a", files: ["a.ts"], summary: "a", tokenBudget: 10, deadlineMs: 1000 },
        { id: "b", files: ["b.ts"], summary: "b", tokenBudget: 10, deadlineMs: 1000 },
      ],
      run: async () => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return { summary: "done", changedFiles: [], testResults: [], unresolvedIssues: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } };
      },
    });
    expect(max).toBe(2);
    expect(result.stopped).toBe("completed");

    const order: string[] = [];
    await runWorkerPool({
      concurrency: 2,
      jobs: [
        { id: "a", files: ["same.ts"], summary: "a", tokenBudget: 10, deadlineMs: 1000 },
        { id: "b", files: ["same.ts"], summary: "b", tokenBudget: 10, deadlineMs: 1000 },
      ],
      run: async (job) => {
        order.push(`start ${job.id}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`end ${job.id}`);
        return { summary: "done", changedFiles: ["same.ts"], testResults: [], unresolvedIssues: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 } };
      },
    });
    expect(order.join(" ")).not.toMatch(/start a start b|start b start a/);
  });
});
