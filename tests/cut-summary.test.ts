import { describe, expect, it } from "vitest";
import { record } from "../src/orchestrator/budget.js";
import { clipDiffSummarized, parseSummaries } from "../src/orchestrator/cut-summary.js";
import { contextOf, fakeChat, sampleTicket, tempRepo, tieredConfig, ticketWorkflow, withAdvisors, type FakeCall } from "./helpers.js";

const section = (name: string, fill: string) => `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${fill.repeat(2500)}\n`;
const diff = ["a.txt", "b.txt", "c.txt"].map((name, index) => section(name, "abc"[index]!)).join("");
const LUNA = "gpt-6-luna";

async function setup(options: { answer?: (call: FakeCall) => string; mutate?: (config: ReturnType<typeof tieredConfig>) => void } = {}) {
  const config = withAdvisors(tieredConfig());
  config.tiers.cheap = [{ provider: "anthropic", model: "claude-haiku-5-5", api: "chat" }];
  config.tiers.batch = [{ provider: "openai", model: LUNA, api: "chat" }];
  options.mutate?.(config);
  const fake = fakeChat(options.answer ?? (() => JSON.stringify({ "b.txt": "adds the b module", "c.txt": "adds the c module", "elsewhere.txt": "not a cut file" })));
  const { app, taskId } = await ticketWorkflow([sampleTicket("01")], { config, chat: fake.chat }, { approve: false, cwd: await tempRepo() });
  return { ctx: contextOf(app), app, taskId, calls: fake.calls };
}

describe("batch summaries of cut files", () => {
  it("replace the bare list of cut files, from each file's hunks clipped to about 2K, on the batch tier and ledgered as batch summary", async () => {
    const t = await setup();
    const clipped = await clipDiffSummarized(t.ctx, t.taskId, diff, 3000);
    expect(clipped.summarized).toBe(true);
    expect(clipped.text).toContain("- b.txt (not shown): adds the b module");
    expect(clipped.text).toContain("- c.txt (not shown): adds the c module");
    expect(clipped.text).not.toContain("not a cut file");
    expect(clipped.text).toContain("aaaa");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ provider: "openai", model: LUNA });
    expect(t.calls[0]!.user).toContain("### b.txt");
    expect(t.calls[0]!.user).not.toContain("### a.txt");
    // each file's hunks are clipped to about 2K characters
    expect(t.calls[0]!.user.length).toBeLessThan(2 * 2200 + 200);
    const entry = t.ctx.store.readLedger().find((item) => item.reason === "batch summary")!;
    expect(entry).toMatchObject({ tier: "batch", provider: "openai", model: LUNA, outcome: "success" });
  });

  it("are skipped on a soft budget, when switched off, with no cut, and when the call or its answer fails", async () => {
    const soft = await setup({ mutate: (config) => void (config.budgets.taskUsd = 0.0001) });
    record(soft.ctx, soft.taskId, "PLANNING", "standard", "anthropic", "claude-sonnet-5-5", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, requests: 1 }, "success", 0, "test");
    const skipped = await clipDiffSummarized(soft.ctx, soft.taskId, diff, 3000);
    expect(soft.calls).toHaveLength(0);
    expect(skipped.summarized).toBe(false);
    expect(skipped.text).toContain("cut: b.txt (not shown), c.txt (not shown)]");

    const off = await setup({ mutate: (config) => void (config.advisors.summarizeCut = false) });
    expect((await clipDiffSummarized(off.ctx, off.taskId, diff, 3000)).text).toContain("cut: b.txt (not shown), c.txt (not shown)]");
    expect(off.calls).toHaveLength(0);

    const none = await setup();
    expect((await clipDiffSummarized(none.ctx, none.taskId, diff, 100_000)).text).toBe(diff);
    expect(none.calls).toHaveLength(0);

    const broken = await setup({ answer: () => "I cannot do that" });
    expect((await clipDiffSummarized(broken.ctx, broken.taskId, diff, 3000)).text).toContain("cut: b.txt (not shown), c.txt (not shown)]");
    expect(broken.ctx.store.readLedger().find((item) => item.reason === "batch summary")?.outcome).toBe("failure");

    const thrown = await setup({ answer: () => { throw new Error("down"); } });
    expect((await clipDiffSummarized(thrown.ctx, thrown.taskId, diff, 3000)).summarized).toBe(false);
    expect(thrown.ctx.store.readLedger().find((item) => item.reason === "batch summary")).toMatchObject({ outcome: "failure", actualUsd: null });
  });

  it("reads the answer leniently and keeps only listed files", () => {
    expect(parseSummaries('```json\n{"a.ts": " does   x ", "z.ts": "no"}\n```', ["a.ts"])?.get("a.ts")).toBe("does x");
    expect(parseSummaries("[1]", ["a.ts"])).toBeUndefined();
  });
});
