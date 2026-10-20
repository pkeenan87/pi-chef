import { describe, expect, it } from "vitest";
import { buildCostRecord, summarize } from "../src/cost/ledger.js";
import { createRegistryChat } from "../src/providers/pi-chat.js";
import { failedUsage, ProviderCallError } from "../src/providers/clients.js";
import { Workflow } from "../src/orchestrator/service.js";
import { readyAuth, sampleTicket, tempRepo, ticketWorkflow, tieredConfig } from "./helpers.js";

const at = new Date("2026-10-14T12:00:00.000Z");
const usage = (input: number, output: number, total?: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, ...(total !== undefined ? { cost: { total } } : {}) });

describe("Pi's own calls are ledgered from the session file", () => {
  const entries = [
    { type: "message", id: "m1", timestamp: "2026-10-14T12:01:00.000Z", message: {} },
    { type: "usage", id: "u1", timestamp: "2026-10-14T12:02:00.000Z", kind: "cache_warm", provider: "anthropic", model: "claude-opus-5-5", usage: usage(0, 1, 0.01) },
    { type: "compaction", id: "c1", timestamp: "2026-10-14T12:03:00.000Z", fromHook: false, usage: usage(40_000, 2_000, 0.3) },
    { type: "compaction", id: "c2", timestamp: "2026-10-14T12:04:00.000Z", fromHook: true, usage: usage(40_000, 2_000) },
    { type: "branch_summary", id: "b1", timestamp: "2026-10-14T12:05:00.000Z", usage: usage(5_000, 500) },
    { type: "usage", id: "old", timestamp: "2026-10-14T11:00:00.000Z", kind: "cache_warm", provider: "anthropic", model: "claude-opus-5-5", usage: usage(0, 1) },
  ];
  const sweep = (app: Workflow) => app.recordPiUsage({ sessionId: "s1", entries, since: new Date("2026-10-14T11:30:00.000Z"), model: { provider: "anthropic", id: "claude-opus-5-5" } });

  it("records cache warming, Pi's compaction and branch summaries once, on the active task and its running ticket", async () => {
    const { app, taskId, cwd } = await ticketWorkflow([sampleTicket("01")]);
    await app.store.update(taskId, "building", (state) => ({ ...state, build: { branch: "b", base: "main", baseSha: "0".repeat(40), currentTicket: "01" } }));
    const rows = sweep(app);
    // Not the message (message_end ledgers it), not the hook's own compaction (ledgered where it ran), not history from before the watch.
    expect(rows.map((row) => row.reason)).toEqual(["Pi cache warming · ticket 01", "Pi compaction · ticket 01", "Pi branch summary · ticket 01"]);
    expect(rows.every((row) => row.taskId === taskId && row.tier === "pi")).toBe(true);
    expect(rows[1]).toMatchObject({ id: "pi-s1-c1", at: "2026-10-14T12:03:00.000Z", provider: "anthropic", model: "claude-opus-5-5", inputTokens: 40_000, listPriceUsd: 0.3 });
    expect(sweep(app)).toEqual([]);
    // A restarted workflow reads the ids back from the ledger and records nothing twice.
    const restarted = new Workflow({ cwd, config: tieredConfig(), auth: readyAuth() });
    expect(sweep(restarted)).toEqual([]);
    expect(app.store.readLedger().filter((row) => row.id.startsWith("pi-"))).toHaveLength(3);
  });
});

describe("a failed call keeps what the provider billed", () => {
  const registry = (result: { stopReason: string; usage: ReturnType<typeof usage> }) => ({
    find: () => ({}),
    isUsingOAuth: () => true,
    complete: async () => ({ content: [], errorMessage: "stream timed out", ...result }),
  });

  it("carries the reported usage on the error of an aborted call, and Pi's price on a good one", async () => {
    const aborted = createRegistryChat(registry({ stopReason: "aborted", usage: usage(30_000, 1_200, 0.2) }));
    const error = await aborted({ provider: "anthropic", model: "claude-opus-5-5" }, { messages: [{ role: "user", content: "x" }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(failedUsage(error)).toMatchObject({ input: 30_000, output: 1_200, listPriceUsd: 0.2 });
    // A call that failed before any token is unknown, never zero.
    const empty = createRegistryChat(registry({ stopReason: "error", usage: usage(0, 0) }));
    expect(failedUsage(await empty({ provider: "anthropic", model: "m" }, { messages: [{ role: "user", content: "x" }] }).catch((caught: unknown) => caught))).toMatchObject({ input: null, output: null });
    const good = createRegistryChat(registry({ stopReason: "stop", usage: usage(100, 10, 0.001) }));
    expect((await good({ provider: "anthropic", model: "m" }, { messages: [{ role: "user", content: "x" }] })).usage).toMatchObject({ input: 100, output: 10, listPriceUsd: 0.001 });
  });

  it("ledgers a failed /advisor call at its billed tokens instead of an unknown cost", async () => {
    const { app } = await ticketWorkflow([sampleTicket("01")], {
      chat: async () => {
        throw new ProviderCallError("outage", "timed out", { input: 20_000, output: 300, cacheRead: 0, cacheWrite: 0, requests: 1 });
      },
    });
    expect((await app.advisor("why?")).ok).toBe(false);
    const row = app.store.readLedger().find((entry) => entry.reason === "advisor")!;
    expect(row).toMatchObject({ outcome: "failure", inputTokens: 20_000, outputTokens: 300 });
    expect(row.actualUsd).not.toBeNull();
  });
});

describe("unknown cost estimates", () => {
  it("use Pi's own price for a row no pricing row covers, before the flat per-call estimate", () => {
    const row = (listPriceUsd?: number) => buildCostRecord(
      { provider: "vercel", model: "unpriced", phase: "IMPLEMENTING", taskId: "t", tier: "ticketLow", usage: { input: null, output: null, cacheRead: null, cacheWrite: null, requests: 1, ...(listPriceUsd !== undefined ? { listPriceUsd } : {}) }, outcome: "success", retries: 0, reason: "x" },
      [],
      at,
      "id",
    );
    expect(row(1.25).actualUsd).toBeNull();
    expect(summarize([row(1.25)], { unknownCallUsd: 0.05 }).estimatedUnknownUsd).toBe(1.25);
    expect(summarize([row()], { unknownCallUsd: 0.05 }).estimatedUnknownUsd).toBe(0.05);
  });
});
