import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openTicketAgent, ticketBashProblem, ticketTools, toolActivity, type ChildMessage, type ChildTool } from "../src/subagent/ticket-agent.js";
import { piChildSdk, runtimeOf } from "../src/subagent/pi-sdk.js";
import { TURN_GRACE } from "../src/orchestrator/build.js";

describe("ticket tools", () => {
  const tool = (name: string): ChildTool => ({ name, execute: async (_id, params) => ({ ran: name, params }) });

  it("keeps Pi's file tools and a bash, in that order, and drops anything else", () => {
    const tools = ticketTools(["task", "bash", "read", "edit", "write", "grep", "find", "ls", "web_search"].map(tool));
    expect(tools.map((item) => item.name)).toEqual(["read", "edit", "write", "grep", "find", "ls", "bash"]);
  });

  it("refuses push, branch switches, worktree changes and destructive commands in bash, and runs the rest", async () => {
    const bash = ticketTools([tool("bash")])[0]!;
    for (const command of ["git push origin main", "git switch main", "git worktree add ../x", "rm -rf /"]) {
      await expect(bash.execute("1", { command }), command).rejects.toThrow(/do not|Blocked/);
    }
    await expect(bash.execute("2", { command: "npm test" })).resolves.toMatchObject({ ran: "bash" });
    expect(ticketBashProblem("git status")).toBeUndefined();
  });

  it("labels tool calls for the progress line, redacted and short", () => {
    expect(toolActivity("edit", { path: "src/x.ts" })).toBe("edit src/x.ts");
    expect(toolActivity("bash", { command: "npm   test" })).toBe("bash npm test");
    expect(toolActivity("bash", { command: "x".repeat(200) }).length).toBeLessThanOrEqual(65);
    expect(toolActivity("ls", {})).toBe("ls");
  });
});

// A real Pi 1.2.0 session (createAgentSession) on pi-ai's faux provider: no network, no model, real tools and events.
describe("ticket subagent on Pi's SDK", () => {
  const priorHome = process.env.HOME;
  let cwd: string;
  beforeEach(() => {
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    cwd = mkdtempSync(path.join(tmpdir(), "ticket-"));
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });

  async function faux() {
    const runtime = await ModelRuntime.create({ authPath: path.join(process.env.HOME!, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const provider = fauxProvider({ provider: "faux", models: [{ id: "m", reasoning: true }] });
    runtime.registerNativeProvider(provider.provider);
    const registry = new ModelRegistry(runtime);
    return { runtime, registry, provider, model: registry.find("faux", "m") };
  }

  it("reaches the runtime behind a ModelRegistry, and refuses anything else", async () => {
    const { runtime, registry } = await faux();
    expect(runtimeOf(registry)).toBe(runtime);
    expect(runtimeOf({ runtime: {} })).toBeUndefined();
    expect(runtimeOf(undefined)).toBeUndefined();
  });

  it("runs a ticket: blocks git push with pi-chef's reason, writes files, returns the last text, reports every message", async () => {
    const { runtime, provider, model } = await faux();
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "git push origin main" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "hi\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.\n- [x] it works")),
    ]);
    const messages: ChildMessage[] = [];
    const activity: string[] = [];
    const agent = await openTicketAgent({ sdk: piChildSdk(runtime), cwd, model, limits: { maxTurns: 50 }, onMessage: (message) => void messages.push(message), onActivity: (text) => void activity.push(text) });
    const reply = await agent.send("Build ticket 01.");
    agent.dispose();
    expect(reply).toEqual({ lastText: "Done.\n- [x] it works", aborted: false });
    expect(readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("hi\n");
    const pushResult = messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(pushResult?.content)).toContain("do not push");
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(3);
    expect(messages.find((message) => message.role === "assistant")).toMatchObject({ provider: "faux", model: "m" });
    expect(activity).toContain("turn 1 · bash git push origin main");
    expect(activity).toContain("turn 2 · write a.txt");
  });

  it("keeps working across sends of one attempt, like a check retry turn", async () => {
    const { runtime, provider, model } = await faux();
    provider.setResponses([fauxAssistantMessage(fauxText("First.")), fauxAssistantMessage(fauxToolCall("write", { path: "b.txt", content: "b\n" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Fixed."))]);
    const agent = await openTicketAgent({ sdk: piChildSdk(runtime), cwd, model });
    expect((await agent.send("Build it.")).lastText).toBe("First.");
    expect((await agent.send("The checks failed. Fix it.")).lastText).toBe("Fixed.");
    expect(existsSync(path.join(cwd, "b.txt"))).toBe(true);
    agent.dispose();
  });

  it("runs at the ticket's thinking level", async () => {
    const { runtime, provider, model } = await faux();
    const asked: unknown[] = [];
    provider.setResponses([(_context, options) => (asked.push(options?.reasoning), fauxAssistantMessage(fauxText("ok")))]);
    const agent = await openTicketAgent({ sdk: piChildSdk(runtime), cwd, model, thinking: "high" });
    await agent.send("Build it.");
    agent.dispose();
    expect(asked).toEqual(["high"]);
  });

  it("steers at the turn limit and stops the run TURN_GRACE turns later with turnLimit", async () => {
    const { runtime, provider, model } = await faux();
    const looping = Array.from({ length: 2 + TURN_GRACE + 5 }, (_, index) => fauxAssistantMessage(fauxToolCall("ls", { path: "." }, { id: `call-${index}` }), { stopReason: "toolUse" }));
    provider.setResponses(looping);
    const seen: string[] = [];
    const agent = await openTicketAgent({
      sdk: piChildSdk(runtime),
      cwd,
      model,
      limits: { maxTurns: 2 },
      onMessage: (message) => {
        if (message.role === "user") seen.push(JSON.stringify(message.content));
      },
    });
    const reply = await agent.send("Build it.");
    agent.dispose();
    expect(reply.turnLimit).toBe(true);
    expect(reply.aborted).toBe(true);
    expect(seen.some((text) => text.includes("budget of 2 turns"))).toBe(true);
    expect(provider.state.callCount).toBeLessThanOrEqual(2 + TURN_GRACE + 1);
  });
});
