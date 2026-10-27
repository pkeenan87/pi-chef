import { describe, expect, it } from "vitest";
import { parseConfig, tierCandidates } from "../src/config.js";
import { knownModel } from "../src/providers/local-models.js";
import { registerChatProviders } from "../src/providers/runtime.js";
import { tieredConfig } from "./helpers.js";

type Entry = { id: string; reasoning: boolean; maxTokens: number; contextWindow: number; compat?: { supportsDeveloperRole: boolean }; thinkingLevelMap?: Record<string, string | null> };
const registerLocal = (model: string, extra: Record<string, unknown> = {}) => {
  const config = tieredConfig();
  config.tiers.local = [{ provider: "local", model, ...extra }];
  const registered: Record<string, { models: Entry[] }> = {};
  registerChatProviders({ registerProvider: (name, cfg) => { registered[name] = cfg as never; } }, config, {}, {});
  return registered.local!.models.find((entry) => entry.id === model)!;
};

describe("known local models", () => {
  it("matches Qwen 3.8 27B by alias, GGUF name and Ollama tag, only for provider local", () => {
    for (const name of ["Qwen3.8-27B", "qwen3.8-27b", "Qwen3.8-27B-UD-Q4_K_XL", "qwen3.8:27b"]) expect(knownModel("local", name)?.label, name).toBe("Qwen 3.8 27B (local)");
    for (const name of ["qwen3.6:27b", "qwen3.8:8b", "Qwen3.8-270B", "qwen3.5:9b"]) expect(knownModel("local", name), name).toBeUndefined();
    expect(knownModel("foundry", "Qwen3.8-27B")).toBeUndefined();
  });

  it("fills the fields a tier entry leaves out, and lets the entry win", () => {
    const config = tieredConfig();
    config.tiers.local = [{ provider: "local", model: "Qwen3.8-27B", contextWindow: 65_536 }];
    expect(tierCandidates(config, "local")[0]).toMatchObject({ contextWindow: 65_536, maxTokens: 32_768, reasoning: true, label: "Qwen 3.8 27B (local)" });
    config.tiers.local = [{ provider: "local", model: "Qwen3.8-27B", maxTokens: 4096, reasoning: false, label: "mine" }];
    expect(tierCandidates(config, "local")[0]).toMatchObject({ contextWindow: 131_072, maxTokens: 4096, reasoning: false, label: "mine" });
  });

  it("registers the preset with reasoning, 32768 output tokens, no developer role and the thinking level map", () => {
    expect(registerLocal("Qwen3.8-27B", { contextWindow: 131_072 })).toMatchObject({
      reasoning: true,
      maxTokens: 32_768,
      contextWindow: 131_072,
      compat: { supportsDeveloperRole: false },
      thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: null },
    });
  });

  it("registers a plain local model with the old defaults and no compat", () => {
    const entry = registerLocal("my-coder");
    expect(entry).toMatchObject({ reasoning: false, maxTokens: 8192 });
    expect("compat" in entry).toBe(false);
    expect("thinkingLevelMap" in entry).toBe(false);
  });

  it("passes a tier entry's maxTokens and reasoning to Pi for any model", () => {
    expect(registerLocal("my-coder", { maxTokens: 16_384, reasoning: true })).toMatchObject({ reasoning: true, maxTokens: 16_384 });
  });

  it("rejects maxTokens below 1024 and a non-boolean reasoning", () => {
    const yaml = (entry: string) => `tiers:\n  local:\n    - { provider: local, model: x, ${entry} }\n`;
    expect(() => parseConfig(yaml("maxTokens: 100"), "test.yaml")).toThrow(/maxTokens/);
    expect(() => parseConfig(yaml('reasoning: "yes"'), "test.yaml")).toThrow(/reasoning/);
  });
});
