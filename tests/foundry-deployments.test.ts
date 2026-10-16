import { describe, expect, it } from "vitest";
import { foundryDeployment, modelLabel, parseConfig, piModelId, priceFor, tierCandidates } from "../src/config.js";
import { createRegistryChat } from "../src/providers/pi-chat.js";
import { registerChatProviders } from "../src/providers/runtime.js";
import { runBuild, type BuildDriver, type ModelRef } from "../src/orchestrator/build.js";
import { routingSummary } from "../src/orchestrator/routing.js";
import { sampleTicket, ticketWorkflow, tempRepo, tieredConfig, checkRunner } from "./helpers.js";

const FOUNDRY = `providers:
  foundry:
    type: azure-foundry
    auth: azure-cli
    endpoint: "https://res.services.ai.azure.com"
    deployments: { "gpt-6.1-sol": "my-sol", "grok-4-7": "grok-4-6" }
tiers:
  ticketHigh:
    - { provider: foundry, model: gpt-6.1-sol }
  ticketLow:
    - { provider: foundry, model: grok-4-7 }
  cheap:
    - { provider: foundry, model: gpt-6-luna }
`;
const row = (model: string, input: number) => `  - { provider: foundry, model: ${model}, effectiveFrom: "2026-01-01", inputPerMillionUsd: ${input}, outputPerMillionUsd: ${input * 2} }\n`;
const AT = new Date("2026-10-16T00:00:00Z");

describe("providers.foundry.deployments as a model to deployment map", () => {
  it("registers the deployment name as the model id Pi calls, and passes an unmapped model through", () => {
    const config = parseConfig(FOUNDRY);
    const registered: Record<string, { models: { id: string }[] }> = {};
    registerChatProviders({ registerProvider: (name, value) => void (registered[name] = value as never) }, config, {}, {});
    const ids = registered.foundry!.models.map((item) => item.id);
    expect(ids).toContain("my-sol");
    expect(ids).toContain("grok-4-6");
    expect(ids).not.toContain("gpt-6.1-sol");
    // gpt-6-luna has no mapping: its own name is the deployment.
    expect(ids).toContain("gpt-6-luna");
    expect(foundryDeployment(config, "gpt-6-luna")).toBe("gpt-6-luna");
    expect(piModelId(config, "openai", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  it("registry chat asks Pi for the deployment id and keeps reporting the model name", async () => {
    const config = parseConfig(FOUNDRY);
    const asked: string[] = [];
    const registry = {
      find: (_provider: string, id: string) => {
        asked.push(id);
        return { id };
      },
      complete: async () => ({ content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" }),
    };
    const chat = createRegistryChat(registry as never, () => false, (provider, model) => piModelId(config, provider, model));
    const response = await chat({ provider: "foundry", model: "gpt-6.1-sol" }, { messages: [{ role: "user", content: "hi" }] } as never);
    expect(asked).toEqual(["my-sol"]);
    expect(response.model).toBe("gpt-6.1-sol");
  });

  it("labels a mapped target as foundry/<model> → <deployment> and an unmapped one plainly", () => {
    const config = parseConfig(FOUNDRY);
    expect(modelLabel(config, "foundry", "gpt-6.1-sol")).toBe("foundry/gpt-6.1-sol → my-sol");
    expect(modelLabel(config, "foundry", "gpt-6-luna")).toBe("foundry/gpt-6-luna");
    expect(modelLabel(config, "openai", "gpt-6.1-sol")).toBe("openai/gpt-6.1-sol");
  });

  it("routing opens the session on the deployment id and shows the mapping", async () => {
    const cwd = await tempRepo();
    const config = tieredConfig();
    config.tiers.ticketLow = [{ provider: "foundry", model: "grok-4-7" }];
    config.providers.foundry!.deployments = { "grok-4-7": "grok-4-6" };
    const { app, taskId } = await ticketWorkflow([sampleTicket("01", { difficulty: "low" })], { config, runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })) }, { cwd });
    const opened: ModelRef[] = [];
    const driver: BuildDriver = {
      async fresh(model) {
        opened.push(model);
        return { stopped: "test stop" };
      },
      async finish() {},
    };
    await runBuild(() => app, driver);
    expect(opened).toEqual([{ provider: "foundry", id: "grok-4-6" }]);
    // The run and its metrics keep the model name; only the label shows the mapping.
    expect(app.store.load(taskId)?.ticketRuns?.["01"]?.model ?? "grok-4-7").toBe("grok-4-7");
    expect(routingSummary((app as unknown as { ctx: never }).ctx).tickets.low).toEqual(["foundry/grok-4-7 → grok-4-6"]);
  });

  it("ignores the legacy cheap/reasoning/classifier keys with a warning", () => {
    const config = parseConfig(`providers:\n  foundry:\n    type: azure-foundry\n    deployments: { cheap: c, reasoning: r, classifier: k, "gpt-6.1-sol": my-sol }\n`);
    expect(config.providers.foundry?.deployments).toEqual({ "gpt-6.1-sol": "my-sol" });
    for (const key of ["cheap", "reasoning", "classifier"]) expect(config.warnings?.join("\n")).toContain(`providers.foundry.deployments.${key} is ignored`);
  });

  it("rejects a deployment that is not a name, and deployments on another provider", () => {
    expect(() => parseConfig(`providers:\n  foundry:\n    type: azure-foundry\n    deployments: { a: "x y" }\n`)).toThrow(/deployments\.a/);
    expect(() => parseConfig(`providers:\n  local:\n    type: x\n    deployments: { a: b }\n`)).toThrow(/deployments/);
  });

  describe("pricing lookup order", () => {
    it("uses the deployment's row first, then the model's, and prices both names alike", () => {
      const both = parseConfig(`${FOUNDRY}pricing:\n${row("gpt-6.1-sol", 5)}${row("my-sol", 2)}`);
      expect(priceFor(both.pricing, "foundry", "gpt-6.1-sol", AT)?.inputPerMillionUsd).toBe(2);
      expect(priceFor(both.pricing, "foundry", "my-sol", AT)?.inputPerMillionUsd).toBe(2);
      const modelOnly = parseConfig(`${FOUNDRY}pricing:\n${row("gpt-6.1-sol", 5)}`);
      expect(priceFor(modelOnly.pricing, "foundry", "my-sol", AT)?.inputPerMillionUsd).toBe(5);
      expect(priceFor(modelOnly.pricing, "foundry", "gpt-6.1-sol", AT)?.inputPerMillionUsd).toBe(5);
      const none = parseConfig(FOUNDRY);
      expect(priceFor(none.pricing, "foundry", "my-sol", AT)).toBeUndefined();
    });

    it("warns when a deployment name reads like another model or version, unless the deployment is priced", () => {
      const config = parseConfig(FOUNDRY);
      const text = config.warnings?.join("\n") ?? "";
      expect(text).toMatch(/grok-4-6 is mapped from grok-4-7.*pricing row for foundry\/grok-4-6/);
      // my-sol carries no version digits, so nothing suggests a different model.
      expect(text).not.toMatch(/my-sol is mapped/);
      const priced = parseConfig(`${FOUNDRY}pricing:\n${row("grok-4-6", 1)}`);
      expect(priced.warnings?.join("\n") ?? "").not.toMatch(/grok-4-6 is mapped/);
    });
  });

  it("merges deployments per model between user and project config, and a project may set them", async () => {
    const { layerConfigs } = await import("../src/config.js");
    const layered = layerConfigs(
      { providers: { foundry: { type: "azure-foundry", deployments: { a: "one", b: "two" } } } },
      { providers: { foundry: { deployments: { b: "three" } } } },
    );
    expect((layered.providers as { foundry: { deployments: unknown } }).foundry.deployments).toEqual({ a: "one", b: "three" });
    expect(tierCandidates(parseConfig(FOUNDRY), "ticketHigh")[0]!.model).toBe("gpt-6.1-sol");
  });
});
