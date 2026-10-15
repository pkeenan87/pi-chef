import { describe, expect, it } from "vitest";
import { runWorkerPool, type WorkerJob } from "../src/agents/pool.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 };
const ok = { summary: "done", changedFiles: [], testResults: [], unresolvedIssues: [], usage };
const job = (id: string, files: string[], extra: Partial<WorkerJob> = {}): WorkerJob => ({ id, files, summary: id, tokenBudget: 10, deadlineMs: 1000, ...extra });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("worker pool", () => {
  it("does not let a blocked head job hold back unrelated work", async () => {
    const events: string[] = [];
    const result = await runWorkerPool({
      concurrency: 3,
      jobs: [job("a", ["x.ts"]), job("a2", ["x.ts"]), job("b", ["y.ts"])],
      run: async (j) => {
        events.push(`start ${j.id}`);
        await sleep(j.id === "a" ? 60 : 5);
        events.push(`end ${j.id}`);
        return ok;
      },
    });
    expect(result.stopped).toBe("completed");
    expect(events.indexOf("start b")).toBeLessThan(events.indexOf("end a"));
    expect(events.indexOf("start a2")).toBeGreaterThan(events.indexOf("end a"));
    expect(result.artifacts).toHaveLength(3);
  });

  it("fails a worker that ignores its deadline", async () => {
    const started = Date.now();
    const result = await runWorkerPool({
      concurrency: 1,
      jobs: [job("slow", ["a.ts"], { deadlineMs: 20 })],
      run: async () => {
        await sleep(300);
        return ok;
      },
    });
    expect(Date.now() - started).toBeLessThan(250);
    expect(result.artifacts[0]).toMatchObject({ id: "slow", error: "deadline", status: "failed" });
    expect(result.artifacts[0]?.artifact).toBeUndefined();
  });

  it("retries up to maxAttempts then records a failure", async () => {
    let calls = 0;
    const result = await runWorkerPool({
      concurrency: 1,
      maxAttempts: 3,
      jobs: [job("flaky", ["a.ts"])],
      run: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    expect(calls).toBe(3);
    expect(result.stopped).toBe("repeated-failure");
    expect(result.artifacts.find((a) => a.id === "flaky")).toMatchObject({ error: "boom", status: "failed" });
  });

  it("succeeds when a retry works", async () => {
    let calls = 0;
    const result = await runWorkerPool({
      concurrency: 1,
      maxAttempts: 3,
      jobs: [job("flaky", ["a.ts"])],
      run: async () => {
        calls += 1;
        if (calls < 3) throw new Error("no");
        return ok;
      },
    });
    expect(calls).toBe(3);
    expect(result.stopped).toBe("completed");
    expect(result.artifacts).toEqual([{ id: "flaky", artifact: ok, status: "ok" }]);
  });

  it("emits skipped artifacts when the budget stops the pool and passes the remaining budget", async () => {
    let remaining = 5;
    const seen: (number | undefined)[] = [];
    const result = await runWorkerPool({
      concurrency: 1,
      budgetRemaining: () => remaining,
      jobs: [job("a", ["a.ts"]), job("b", ["b.ts"]), job("c", ["c.ts"])],
      run: async (_job, _signal, context) => {
        seen.push(context?.budgetRemaining);
        remaining = 0;
        return ok;
      },
    });
    expect(seen).toEqual([5]);
    expect(result.stopped).toBe("budget");
    expect(result.artifacts.map((a) => [a.id, a.status])).toEqual([["a", "ok"], ["b", "failed"], ["c", "skipped"]]);
  });

  it("marks over-budget results failed", async () => {
    const result = await runWorkerPool({
      concurrency: 1,
      jobs: [job("big", ["a.ts"], { tokenBudget: 0 })],
      run: async () => ok,
    });
    expect(result.stopped).toBe("budget");
    expect(result.artifacts[0]).toMatchObject({ status: "failed", error: "Token budget exhausted." });
  });

  it("emits cancelled artifacts for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runWorkerPool({ concurrency: 2, signal: controller.signal, jobs: [job("a", ["a.ts"]), job("b", ["b.ts"])], run: async () => ok });
    expect(result.stopped).toBe("cancelled");
    expect(result.artifacts.map((a) => a.status).sort()).toEqual(["cancelled", "cancelled"]);
  });
});
