import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { layerConfigs } from "../src/config.js";
import { advisorSystem, consultAdvisors } from "../src/review/advisors.js";
import { ADVISOR_TOOL_RULES, createAgentChat } from "../src/subagent/advisor-agent.js";
import { piChildSdk } from "../src/subagent/pi-sdk.js";
import { contextOf, fakeChat, sampleTicket, tieredConfig, ticketWorkflow, withAdvisors } from "./helpers.js";

const OPINION = '{"answers": [{"question": "q", "answer": "checked parse.ts"}], "concerns": [], "verdict": "agree"}';

// A real Pi 1.2.0 session on pi-ai's faux provider standing in for the advisor model.
describe("createAgentChat on Pi's SDK", () => {
  const priorHome = process.env.HOME;
  let cwd: string;
  beforeEach(() => {
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    cwd = mkdtempSync(path.join(tmpdir(), "repo-"));
    writeFileSync(path.join(cwd, "parse.ts"), "export const parse = (s: string) => s.split(',');\n");
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });

  async function setup(provider = "foundry") {
    const runtime = await ModelRuntime.create({ authPath: path.join(process.env.HOME!, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider({ provider, models: [{ id: "gpt-6-astra" }] });
    runtime.registerNativeProvider(faux.provider);
    const registry = new ModelRegistry(runtime);
    return { faux, chat: createAgentChat({ sdk: piChildSdk(runtime), registry, cwd: () => cwd }) };
  }

  it("lets the advisor read the repository, gives it the system prompt with the tool rules, and sums usage over its turns", async () => {
    const { faux, chat } = await setup();
    const prompts: string[] = [];
    const toolResults: string[] = [];
    faux.setResponses([
      // Pi 1.2.0 sends the system prompt as the first transcript message (its `sections.preamble`).
      (context) => (prompts.push(JSON.stringify(context.messages[0])), fauxAssistantMessage(fauxToolCall("read", { path: "parse.ts" }), { stopReason: "toolUse" })),
      (context) => (toolResults.push(JSON.stringify(context.messages.at(-1))), fauxAssistantMessage(fauxText(OPINION))),
    ]);
    const response = await chat({ provider: "foundry", model: "gpt-6-astra" }, { messages: [{ role: "system", content: "SYSTEM" }, { role: "user", content: "PACKET" }] });
    expect(response.text).toBe(OPINION);
    expect(response.usage.requests).toBe(2);
    expect(prompts[0]).toContain("SYSTEM");
    expect(prompts[0]).toContain(JSON.stringify(ADVISOR_TOOL_RULES).slice(1, -1));
    expect(toolResults[0]).toContain("s.split");
  });

  it("has no tool that writes or runs commands", async () => {
    const { faux, chat } = await setup();
    const results: string[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "x.txt", content: "x" }), { stopReason: "toolUse" }),
      (context) => (results.push(JSON.stringify(context.messages.at(-1))), fauxAssistantMessage(fauxText(OPINION))),
    ]);
    await chat({ provider: "foundry", model: "gpt-6-astra" }, { messages: [{ role: "user", content: "PACKET" }] });
    expect(results[0]).toMatch(/not found|unknown|not available/i);
  });

  it("refuses an account provider without an account login, like every chat path", async () => {
    const { chat } = await setup("openai");
    await expect(chat({ provider: "openai", model: "gpt-6-astra" }, { messages: [{ role: "user", content: "PACKET" }] })).rejects.toThrow(/account login/);
  });

  it("throws with what was billed when the signal aborts", async () => {
    const { faux, chat } = await setup();
    const controller = new AbortController();
    controller.abort();
    faux.setResponses([fauxAssistantMessage(fauxText(OPINION))]);
    await expect(chat({ provider: "foundry", model: "gpt-6-astra" }, { messages: [{ role: "user", content: "PACKET" }], signal: controller.signal })).rejects.toThrow(/abort/);
  });
});

describe("consultAdvisors with advisors.tools", () => {
  async function setup(tools: boolean) {
    const config = withAdvisors(tieredConfig());
    config.advisors.tools = tools;
    const plain = fakeChat(() => OPINION);
    const agent = fakeChat(() => OPINION);
    const { app, taskId } = await ticketWorkflow([sampleTicket("01")], { config, chat: plain.chat, advisorChat: agent.chat });
    const ctx = contextOf(app);
    await consultAdvisors(ctx, { purpose: "ticket review", packet: "PACKET", questions: ["q"], candidates: [{ provider: "openai", model: "gpt-6-astra" }], taskId });
    return { plain: plain.calls, agent: agent.calls };
  }

  it("uses the read-only sessions and says the advisor may read, when on", async () => {
    const { plain, agent } = await setup(true);
    expect(plain).toHaveLength(0);
    expect(agent).toHaveLength(1);
    expect(agent[0]!.system).toBe(advisorSystem(1500, true));
    expect(agent[0]!.system).toContain("you may read the repository");
  });

  it("uses the plain chat, which says the advisor has no tools, when off (the default)", async () => {
    expect(tieredConfig().advisors.tools).toBe(false);
    const { plain, agent } = await setup(false);
    expect(agent).toHaveLength(0);
    expect(plain[0]!.system).toContain("You have no tools");
  });

  it("a project can turn it off, never on", () => {
    const warnings: string[] = [];
    const merged = layerConfigs(undefined, { advisors: { tools: true } }, warnings) as { advisors?: { tools?: boolean } };
    expect(merged.advisors?.tools).toBeUndefined();
    expect(warnings[0]).toContain("only turn advisors off");
    expect((layerConfigs({ advisors: { tools: true } }, { advisors: { tools: false } }, []) as { advisors: { tools: boolean } }).advisors.tools).toBe(false);
  });
});
