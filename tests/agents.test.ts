import { describe, expect, it } from "vitest";
import { agentCommand, agentTable, BUILTIN_AGENTS, modelText, parseModelRef, parseTicketModel, ticketModelProblem } from "../src/agents.js";

describe("parseTicketModel", () => {
  it("reads a Pi model as provider and id", () => {
    expect(parseTicketModel("anthropic/claude-sonnet-5-5")).toEqual({ kind: "pi", provider: "anthropic", id: "claude-sonnet-5-5" });
    expect(parseTicketModel("local/Qwen3.8-27B")).toEqual({ kind: "pi", provider: "local", id: "Qwen3.8-27B" });
    expect(parseTicketModel("  openai/gpt-6.1-sol  ")).toEqual({ kind: "pi", provider: "openai", id: "gpt-6.1-sol" });
  });

  it("reads a :thinking suffix only when it is one of Pi's levels, so ids with a colon stay whole", () => {
    expect(parseTicketModel("anthropic/claude-opus-5-5:high")).toEqual({ kind: "pi", provider: "anthropic", id: "claude-opus-5-5", thinking: "high" });
    expect(parseTicketModel("openai/gpt-6.1-sol:xhigh")).toMatchObject({ id: "gpt-6.1-sol", thinking: "xhigh" });
    expect(parseTicketModel("local/qwen3.5:9b")).toEqual({ kind: "pi", provider: "local", id: "qwen3.5:9b" });
    expect(parseTicketModel("local/qwen3.5:9b:low")).toEqual({ kind: "pi", provider: "local", id: "qwen3.5:9b", thinking: "low" });
    expect(parseTicketModel("openrouter/meta/llama:max")).toEqual({ kind: "pi", provider: "openrouter", id: "meta/llama", thinking: "max" });
  });

  it("reads agent:<name> and agent:<name>/<model>", () => {
    expect(parseTicketModel("agent:claude")).toEqual({ kind: "agent", name: "claude" });
    expect(parseTicketModel("agent:claude/opus")).toEqual({ kind: "agent", name: "claude", model: "opus" });
    expect(parseTicketModel("agent:opencode/anthropic/claude-sonnet-5-5")).toEqual({ kind: "agent", name: "opencode", model: "anthropic/claude-sonnet-5-5" });
    expect(parseTicketModel("agent:cursor-agent/gpt-5")).toEqual({ kind: "agent", name: "cursor-agent", model: "gpt-5" });
  });

  it("knows the built-in agents and the ones the config adds", () => {
    for (const name of Object.keys(BUILTIN_AGENTS)) expect(parseTicketModel(`agent:${name}`)).toEqual({ kind: "agent", name });
    expect(() => parseTicketModel("agent:mine")).toThrow(/unknown agent.*claude, codex/);
    expect(parseTicketModel("agent:mine/x", { agents: { mine: { run: ["mycli"], modelFlag: "--model" } } })).toEqual({ kind: "agent", name: "mine", model: "x" });
  });

  it.each([
    ["", /must not be empty/],
    ["claude", /provider\/id/],
    ["/gpt", /provider\/id/],
    ["openai/", /provider\/id/],
    ["open ai/gpt", /provider\/id/],
    ["agent:", /agent:<name>/],
    ["agent:bad name", /agent:<name>/],
    ["agent:claude/", /empty model/],
    ["agent:claude/two words", /whitespace/],
    ["agent:nope", /unknown agent/],
  ])("rejects %j", (text, message) => {
    expect(() => parseTicketModel(text)).toThrow(message);
  });

  it("refuses a model for an agent with no modelFlag", () => {
    expect(() => parseTicketModel("agent:mine/x", { agents: { mine: { run: ["mycli"] } } })).toThrow(/no modelFlag/);
    expect(parseTicketModel("agent:mine", { agents: { mine: { run: ["mycli"] } } })).toEqual({ kind: "agent", name: "mine" });
  });

  it("checks only the shape with anyAgent, for a file that may name an agent another file defines", () => {
    expect(parseTicketModel("agent:elsewhere/x", {}, { anyAgent: true })).toEqual({ kind: "agent", name: "elsewhere", model: "x" });
    expect(ticketModelProblem("agent:bad name", {}, { anyAgent: true })).toMatch(/agent:<name>/);
    expect(ticketModelProblem("agent:elsewhere")).toMatch(/unknown agent/);
    expect(ticketModelProblem("anthropic/x")).toBeUndefined();
  });
});

describe("agentCommand", () => {
  it("is the run argv with the model flag and model appended", () => {
    expect(agentCommand({ kind: "agent", name: "claude" })).toEqual(["claude", "--permission-mode", "acceptEdits"]);
    expect(agentCommand({ kind: "agent", name: "claude", model: "opus" })).toEqual(["claude", "--permission-mode", "acceptEdits", "--model", "opus"]);
    expect(agentCommand({ kind: "agent", name: "codex", model: "gpt-5" })).toEqual(["codex", "--no-daemon", "-s", "workspace-write", "-a", "on-request", "-m", "gpt-5"]);
    expect(agentCommand({ kind: "agent", name: "cursor-agent", model: "auto" })).toEqual(["cursor-agent", "--auto-review", "--model", "auto"]);
    expect(agentCommand({ kind: "agent", name: "grok", model: "g" })).toEqual(["grok", "--permission-mode", "acceptEdits", "-m", "g"]);
    expect(agentCommand({ kind: "agent", name: "agy", model: "g" })).toEqual(["agy", "--mode", "accept-edits", "--model", "g"]);
    expect(agentCommand({ kind: "agent", name: "gemini", model: "g" })).toEqual(["gemini", "--approval-mode", "auto_edit", "-m", "g"]);
    expect(agentCommand({ kind: "agent", name: "opencode", model: "p/m" })).toEqual(["opencode", "--model", "p/m"]);
  });

  it("never defaults to a flag that skips every permission check", () => {
    const skipAll = /yolo|dangerously|bypass|--force|always-approve|^--auto$|approve-for-me|full-access/i;
    for (const [name, def] of Object.entries(BUILTIN_AGENTS)) {
      expect(def.run.filter((arg) => skipAll.test(arg)), name).toEqual([]);
    }
  });

  it("uses an override's run, keeping the built-in model flag it does not set", () => {
    const config = { agents: { claude: { run: ["claude", "--permission-mode", "plan"] } } };
    expect(agentTable(config).claude).toEqual({ run: ["claude", "--permission-mode", "plan"], modelFlag: "--model" });
    expect(agentCommand({ kind: "agent", name: "claude", model: "opus" }, config)).toEqual(["claude", "--permission-mode", "plan", "--model", "opus"]);
    expect(agentCommand({ kind: "agent", name: "claude", model: "opus" }, { agents: { claude: { run: ["c"], modelFlag: "-m" } } })).toEqual(["c", "-m", "opus"]);
  });

  it("does not change the built-ins when overridden, and rejects unknown agents and flagless models", () => {
    agentTable({ agents: { claude: { run: ["x"] } } });
    expect(BUILTIN_AGENTS.claude).toEqual({ run: ["claude", "--permission-mode", "acceptEdits"], modelFlag: "--model" });
    expect(() => agentCommand({ kind: "agent", name: "nope" })).toThrow(/Unknown agent/);
    expect(() => agentCommand({ kind: "agent", name: "mine", model: "x" }, { agents: { mine: { run: ["m"] } } })).toThrow(/no modelFlag/);
  });
});

describe("labels", () => {
  it("prints a model as it was written, without the thinking suffix", () => {
    expect(modelText(parseTicketModel("anthropic/claude-opus-5-5:high"))).toBe("anthropic/claude-opus-5-5");
    expect(modelText(parseTicketModel("agent:claude/opus"))).toBe("agent:claude/opus");
    expect(modelText(parseTicketModel("agent:codex"))).toBe("agent:codex");
    expect(parseModelRef("a/b")).toEqual({ provider: "a", id: "b" });
    expect(parseModelRef("ab")).toBeUndefined();
  });
});
