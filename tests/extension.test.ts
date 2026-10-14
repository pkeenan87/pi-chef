import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { COMMANDS } from "../src/commands.js";
import { registerWorkflow } from "../src/extension.js";
import { isDeniedCommand } from "../src/sandbox.js";
import { tempRepo } from "./helpers.js";

describe("pi extension surface", () => {
  it("registers the spec commands with completions", async () => {
    const cwd = await tempRepo();
    const commands = new Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => { value: string }[] | null; handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options);
      },
      on() { return () => undefined; },
      appendEntry() {},
      registerVirtualModel() {},
      setModel: async () => false,
    };
    registerWorkflow(pi as unknown as ExtensionAPI);
    for (const spec of COMMANDS) {
      expect(commands.get(spec.name)?.description).toBeTruthy();
    }
    const auth = commands.get("auth");
    const completions = await auth?.getArgumentCompletions?.("login an");
    expect(completions?.map((item) => item.value)).toContain("anthropic");
    const resets: string[] = [];
    await commands.get("route")?.handler("rename a typo", {
      cwd,
      hasUI: true,
      ui: { notify() {}, setStatus() {}, confirm: async () => false },
      newSession: async (options?: { withSession?: (next: { sendMessage: (message: unknown, extra?: unknown) => Promise<void> }) => Promise<void> }) => {
        await options?.withSession?.({ async sendMessage() { resets.push("sent"); } });
        return { cancelled: false };
      },
      compact() {},
    });
    expect(resets).toEqual([]);
  });

  it("blocks destructive shell commands", () => {
    expect(isDeniedCommand("rm -rf /")).toBe(true);
    expect(isDeniedCommand("git push --force origin main")).toBe(true);
    expect(isDeniedCommand("npm test")).toBe(false);
  });
});

describe("installed Pi providers", () => {
  it("ships account login for OpenAI and Anthropic and not for Azure", () => {
    const openai = openaiProvider();
    const anthropic = anthropicProvider();
    const codex = openaiCodexProvider();
    const azure = azureProvider();
    expect(openai.auth.oauth?.name).toMatch(/ChatGPT/);
    expect(openai.auth.oauth?.isSubscription).toBe(true);
    expect(openai.auth.apiKey).toBeTruthy();
    expect(anthropic.auth.oauth?.name).toMatch(/Claude Pro\/Max/);
    expect(anthropic.auth.oauth?.isSubscription).toBe(true);
    expect(codex.auth.oauth?.isSubscription).toBe(true);
    expect(codex.auth.apiKey).toBeUndefined();
    expect(azure.auth.oauth).toBeUndefined();
    expect(azure.auth.apiKey?.name).toMatch(/API key/);
  });
});
