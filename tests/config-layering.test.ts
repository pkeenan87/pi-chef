import { describe, expect, it } from "vitest";
import { layerConfigs } from "../src/config.js";

const layer = (user: Record<string, unknown> | undefined, project: Record<string, unknown> | undefined) => {
  const warnings: string[] = [];
  return { merged: layerConfigs(user, project, warnings), warnings };
};
const advisors = (user: Record<string, unknown> | undefined, project: Record<string, unknown>) => layer(user, { advisors: project }).merged.advisors as Record<string, unknown>;

describe("advisors layering", () => {
  it("a project can turn the switches off, never on", () => {
    expect(advisors({ advisors: { tickets: true } }, { tickets: false }).tickets).toBe(false);
    const { merged, warnings } = layer({ advisors: { tickets: false, plan: false } }, { advisors: { tickets: true, plan: true, summarizeCut: true } });
    expect(merged.advisors).toMatchObject({ tickets: false, plan: false });
    expect((merged.advisors as Record<string, unknown>).summarizeCut).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/advisors\.tickets/);
  });

  it("limits take the lower of user and project, the default when the user sets none", () => {
    expect(advisors({ advisors: { maxDiffChars: 20000 } }, { maxDiffChars: 30000 }).maxDiffChars).toBe(20000);
    expect(advisors({ advisors: { maxDiffChars: 20000 } }, { maxDiffChars: 10000 }).maxDiffChars).toBe(10000);
    expect(advisors(undefined, { maxDiffChars: 90000 }).maxDiffChars).toBeUndefined();
    expect(advisors(undefined, { maxOutputTokens: 500, timeoutMs: 999999, maxPlanConsults: 5 })).toEqual({ maxOutputTokens: 500 });
    expect(advisors(undefined, { maxPlanConsults: 1 }).maxPlanConsults).toBe(1);
  });

  it("adHocMinLines can only go up", () => {
    expect(advisors(undefined, { adHocMinLines: 100 }).adHocMinLines).toBeUndefined();
    expect(advisors(undefined, { adHocMinLines: 900 }).adHocMinLines).toBe(900);
    expect(advisors({ advisors: { adHocMinLines: 50 } }, { adHocMinLines: 20 }).adHocMinLines).toBe(50);
  });
});

describe("session layering", () => {
  it("model and compactionTier are user-only, with a warning", () => {
    const { merged, warnings } = layer({ session: { model: "anthropic/a" } }, { session: { model: "openai/b", compactionTier: "premium" } });
    expect(merged.session).toEqual({ model: "anthropic/a" });
    expect(warnings.join("\n")).toMatch(/session\.model/);
    expect(warnings.join("\n")).toMatch(/session\.compactionTier/);
  });

  it("a project may unpin but not pin", () => {
    expect((layer({ session: { pin: true } }, { session: { pin: false } }).merged.session as Record<string, unknown>).pin).toBe(false);
    expect((layer({ session: { pin: false } }, { session: { pin: true } }).merged.session as Record<string, unknown>).pin).toBe(false);
  });
});

describe("budgets against the defaults", () => {
  const budgets = (user: Record<string, unknown> | undefined, project: Record<string, unknown>) => layer(user, { budgets: project }).merged.budgets as Record<string, number>;
  it("a project cannot raise taskUsd, dailyUsd or softWarningRatio above the default when the user sets none", () => {
    expect(budgets(undefined, { taskUsd: 1000, dailyUsd: 5000, softWarningRatio: 0.99 })).toEqual({ taskUsd: 20, dailyUsd: 75, softWarningRatio: 0.8 });
    expect(budgets(undefined, { taskUsd: 5 }).taskUsd).toBe(5);
  });
  it("the user's value still wins as the base", () => {
    expect(budgets({ budgets: { taskUsd: 100 } }, { taskUsd: 50 }).taskUsd).toBe(50);
    expect(budgets({ budgets: { taskUsd: 100 } }, { taskUsd: 500 }).taskUsd).toBe(100);
  });
});

describe("isolation layering", () => {
  it("is read from the user config only: a project can neither move the worktrees nor turn them off", () => {
    const off = layer(undefined, { isolation: { worktree: false } });
    expect(off.merged.isolation).toBeUndefined();
    expect(off.warnings.join("\n")).toContain("Ignored project isolation");
    const moved = layer({ isolation: { dir: "../trees" } }, { isolation: { dir: "/tmp/x" } });
    expect(moved.merged.isolation).toEqual({ dir: "../trees" });
    expect(moved.warnings.join("\n")).toContain("Ignored project isolation");
    // A project value that matches the user's is no change, so no warning.
    expect(layer(undefined, { isolation: { worktree: true } }).warnings).toEqual([]);
  });
});

describe("tiers.local layering", () => {
  const qwen = [{ provider: "local", model: "Qwen3.8-27B", contextWindow: 131072 }];
  const small = [{ provider: "local", model: "qwen3.5:9b", contextWindow: 65536 }];

  it("keeps the user's local model over a project's, and says so", () => {
    const { merged, warnings } = layer({ tiers: { local: qwen } }, { tiers: { local: small, ticketLow: [{ provider: "openai", model: "gpt-6-luna" }] } });
    const tiers = merged.tiers as Record<string, unknown>;
    expect(tiers.local).toEqual(qwen);
    // The project's other tiers still apply.
    expect(tiers.ticketLow).toEqual([{ provider: "openai", model: "gpt-6-luna" }]);
    expect(warnings.join("\n")).toContain("Ignored project tiers.local (qwen3.5:9b): the local model comes from the user config (~/.pi/agent/chef.yaml), which names Qwen3.8-27B.");
  });

  it("uses a project's local model when the user names none, and is quiet when they agree", () => {
    expect((layer({}, { tiers: { local: small } }).merged.tiers as Record<string, unknown>).local).toEqual(small);
    expect(layer({ tiers: { local: qwen } }, { tiers: { local: qwen } }).warnings).toEqual([]);
  });
});
