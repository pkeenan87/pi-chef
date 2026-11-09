import { pathToFileURL } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The panel's pure helpers (herdr/chef-config/lib.js); main.js needs herdr's runtime and is checked with `herdr-app check`.
type Helpers = {
  looksSecret(text: string): boolean;
  modelValue(kind: string, parts: Record<string, string>): { value?: string; error?: string };
  agentPick(row: { kind: string; agent?: string }, name: string): Record<string, string>;
  fmtUsd(n: number): string;
  ratio(spend: number, limit: number): number;
  ctxText(n: number): string;
  ticketsText(plan: { ticketsDone: number; ticketsTotal: number; ticketsFailed: number }): string;
  parseResult(r: { stdout: string; stderr: string; code: number }): Record<string, unknown>;
  setArgv(root: string, key: string, value: string, sha?: string): string[];
  numberText(n: unknown): string;
  positive(text: string): number | null;
};
let h: Helpers;
beforeAll(async () => {
  h = (await import(pathToFileURL(path.join(__dirname, "..", "herdr", "chef-config", "lib.js")).href)) as Helpers;
});

describe("panel helpers", () => {
  it("changing the agent drops the model text typed for the earlier one; the same agent keeps it", () => {
    const row = { kind: "agent", agent: "claude" };
    expect(h.agentPick(row, "codex")).toEqual({ agent: "codex", agentModel: "" });
    expect(h.agentPick(row, "claude")).toEqual({ agent: "claude" });
    expect(h.agentPick({ kind: "pi" }, "claude")).toEqual({ agent: "claude", agentModel: "" });
  });

  it("builds the models.* value for each kind", () => {
    expect(h.modelValue("pi", { piText: "  anthropic/claude-sonnet-5-5:high " })).toEqual({ value: "anthropic/claude-sonnet-5-5:high" });
    expect(h.modelValue("local", { localId: "Qwen3.8-27B" })).toEqual({ value: "local/Qwen3.8-27B" });
    expect(h.modelValue("agent", { agent: "claude", agentModel: "" })).toEqual({ value: "agent:claude" });
    expect(h.modelValue("agent", { agent: "codex", agentModel: " gpt-6 " })).toEqual({ value: "agent:codex/gpt-6" });
  });

  it("explains an input that cannot be a model", () => {
    for (const parts of [{ piText: "" }, { piText: "grok" }, { piText: "a b/c" }, { piText: "x/" }, { piText: "/x" }]) expect(h.modelValue("pi", parts).error, JSON.stringify(parts)).toBeTruthy();
    expect(h.modelValue("local", { localId: "" }).error).toContain("Pick");
    expect(h.modelValue("agent", { agent: "" }).error).toContain("Pick");
    expect(h.modelValue("agent", { agent: "claude", agentModel: "a b" }).error).toContain("spaces");
  });

  it("never lets a secret reach an argv", () => {
    expect(h.modelValue("pi", { piText: "openai/sk-proj-abcdefghijklmnopqrstu" }).error).toContain("secret");
    expect(h.modelValue("agent", { agent: "claude", agentModel: "ghp_abcdefghijklmnopqrstuvwxyz" }).error).toContain("secret");
    expect(h.looksSecret("Bearer abcdefghijkl")).toBe(true);
    expect(h.looksSecret("anthropic/claude-opus-5-5")).toBe(false);
    expect(h.looksSecret("local/Qwen3.8-27B-Q4_K_M-00001-of-00002")).toBe(false);
  });

  it("formats money, context sizes, ratios and tickets", () => {
    expect([h.fmtUsd(0), h.fmtUsd(4.049), h.fmtUsd(0.0042), h.fmtUsd(123.4), h.fmtUsd(NaN)]).toEqual(["$0", "$4.05", "$0.0042", "$123", "—"]);
    expect([h.ctxText(131072), h.ctxText(4096), h.ctxText(800), h.ctxText(NaN)]).toEqual(["128k", "4k", "800", "?"]);
    expect([h.ratio(5, 20), h.ratio(30, 20), h.ratio(0, 20), h.ratio(5, 0)]).toEqual([0.25, 1, 0, 0]);
    expect(h.ticketsText({ ticketsDone: 1, ticketsTotal: 3, ticketsFailed: 0 })).toBe("1/3 tickets");
    expect(h.ticketsText({ ticketsDone: 1, ticketsTotal: 3, ticketsFailed: 2 })).toBe("1/3 tickets, 2 failed");
  });

  it("reads the CLI's answer, or says what it printed instead", () => {
    expect(h.parseResult({ stdout: '{"ok":true,"plans":[]}\n', stderr: "", code: 0 })).toEqual({ ok: true, plans: [] });
    const bad = h.parseResult({ stdout: "", stderr: "node: not found", code: 127 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("exit 127");
    expect(bad.error).toContain("node: not found");
  });

  it("builds the set argv with the stale-write guard, and reads numbers", () => {
    expect(h.setArgv("/p", "models.low", "local/a", "abc")).toEqual(["set", "--cwd", "/p", "--key", "models.low", "--value", "local/a", "--expect", "abc"]);
    expect(h.setArgv("/p", "budgets.taskUsd", "7")).toEqual(["set", "--cwd", "/p", "--key", "budgets.taskUsd", "--value", "7"]);
    expect([h.positive("7.5"), h.positive(" 3 "), h.positive("0"), h.positive("-1"), h.positive("x"), h.positive("")]).toEqual([7.5, 3, null, null, null, null]);
    expect([h.numberText(20), h.numberText(0.30000000000000004), h.numberText(undefined)]).toEqual(["20", "0.3", ""]);
  });
});
