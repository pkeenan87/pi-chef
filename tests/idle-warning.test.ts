import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflow, bindWorkflow } from "../src/extension.js";
import { parseConfig } from "../src/config.js";
import { tempRepo, testConfig, workflow } from "./helpers.js";

const MIN = 60_000;

async function setup(budgets: Record<string, number> = {}, priced = true) {
  const cwd = await tempRepo();
  const clock = { at: new Date("2026-10-14T12:00:00.000Z").getTime() };
  const config = testConfig();
  Object.assign(config.budgets, budgets);
  if (priced) config.pricing.push({ provider: "anthropic", model: "claude-opus-5-5", effectiveFrom: "2026-01-01", inputPerMillionUsd: 5, outputPerMillionUsd: 25, cacheWritePerMillionUsd: 6.25 });
  bindWorkflow(workflow(cwd, { config, now: () => new Date(clock.at) }));
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  registerWorkflow({ registerCommand() {}, on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => (handlers.set(event, handler), () => undefined), appendEntry() {}, setModel: async () => true } as unknown as ExtensionAPI);
  handlers.get("session_start")?.({}, { cwd, hasUI: false, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined, getEntries: () => [] }, ui: { notify() {}, setStatus() {} } });
  const asks: string[] = [];
  const notes: string[] = [];
  const answer = { value: "Don't send" };
  const ui = { notify: (m: string) => notes.push(m), setStatus() {}, select: async (m: string) => (asks.push(m), answer.value) };
  const ctxFor = (extra: Record<string, unknown> = {}) => ({ cwd, hasUI: true, ui, model: { provider: "anthropic", id: "claude-opus-5-5" }, getContextUsage: () => ({ tokens: 250_000 }), ...extra });
  const endTurn = () => handlers.get("message_end")!({ message: { role: "assistant", content: [] } }, ctxFor());
  const send = (text = "hello", source = "interactive", extra: Record<string, unknown> = {}) => handlers.get("input")!({ type: "input", text, source }, ctxFor(extra)) as Promise<{ action: string }>;
  return { clock, asks, notes, answer, endTurn, send };
}

describe("idle cache warning", () => {
  afterEach(() => bindWorkflow(undefined));

  it("asks over both thresholds, blocks on Don't send, and prices from cacheWrite", async () => {
    const t = await setup();
    t.endTurn();
    t.clock.at += 125 * MIN;
    expect(await t.send()).toEqual({ action: "handled" });
    expect(t.asks).toHaveLength(1);
    expect(t.asks[0]).toContain("250k tokens");
    expect(t.asks[0]).toContain("idle 2h 5m");
    expect(t.asks[0]).toContain("probably expired");
    expect(t.asks[0]).toContain("≈$1.56 at claude-opus-5-5 rates");
    expect(t.notes).toContain("Not sent. Run /new to start fresh; the task resumes from the branch.");
  });

  it("continues on Send anyway and does not ask again in the same idle period", async () => {
    const t = await setup();
    t.answer.value = "Send anyway";
    t.endTurn();
    t.clock.at += 90 * MIN;
    expect(await t.send()).toEqual({ action: "continue" });
    expect(await t.send("again")).toEqual({ action: "continue" });
    expect(t.asks).toHaveLength(1);
    t.endTurn();
    t.clock.at += 90 * MIN;
    await t.send();
    expect(t.asks).toHaveLength(2);
  });

  it("omits the dollar figure with no pricing row", async () => {
    const t = await setup({}, false);
    t.endTurn();
    t.clock.at += 90 * MIN;
    await t.send();
    expect(t.asks[0]).not.toContain("$");
  });

  it("stays silent below either threshold, for commands, extension input, no UI, no prior turn, and when disabled", async () => {
    const t = await setup();
    t.clock.at += 500 * MIN;
    await t.send(); // no assistant turn yet
    t.endTurn();
    t.clock.at += 30 * MIN;
    await t.send(); // not idle long enough
    t.clock.at += 60 * MIN;
    expect(await t.send("hi", "interactive", { getContextUsage: () => ({ tokens: 50_000 }) })).toEqual({ action: "continue" });
    expect(await t.send("hi", "interactive", { getContextUsage: () => undefined })).toEqual({ action: "continue" });
    expect(await t.send("/cost")).toEqual({ action: "continue" });
    expect(await t.send("hi", "extension")).toEqual({ action: "continue" });
    expect(await t.send("hi", "interactive", { hasUI: false })).toEqual({ action: "continue" });
    expect(t.asks).toHaveLength(0);
    for (const budgets of [{ idleWarnMinutes: 0 }, { idleWarnTokens: 0 }] as Record<string, number>[]) {
      const off = await setup(budgets);
      off.endTurn();
      off.clock.at += 500 * MIN;
      expect(await off.send()).toEqual({ action: "continue" });
      expect(off.asks).toHaveLength(0);
    }
  });

  it("continues when the prompt throws", async () => {
    const t = await setup();
    t.endTurn();
    t.clock.at += 90 * MIN;
    expect(await t.send("hi", "interactive", { ui: { notify() {}, select: async () => { throw new Error("boom"); } } })).toEqual({ action: "continue" });
  });

  it("validates the config keys", () => {
    expect(parseConfig("budgets: { idleWarnMinutes: 30, idleWarnTokens: 0 }").budgets).toMatchObject({ idleWarnMinutes: 30, idleWarnTokens: 0 });
    expect(parseConfig("{}").budgets).toMatchObject({ idleWarnMinutes: 60, idleWarnTokens: 100_000 });
    expect(() => parseConfig("budgets: { idleWarnMinutes: -1 }")).toThrow();
    expect(() => parseConfig("budgets: { idleWarnTokens: 1.5 }")).toThrow();
  });
});
