import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { knownLocalModel } from "../src/providers/known-models.js";
import { localProviderConfig, registerLocalProvider } from "../src/providers/runtime.js";

type Entry = { id: string; name: string; reasoning: boolean; maxTokens: number; contextWindow: number; compat?: { supportsDeveloperRole: boolean }; thinkingLevelMap?: Record<string, string | null> };

const localOf = (models: string, extra = "") => parseConfig(`local:\n  baseUrl: "http://127.0.0.1:8081/v1"\n${extra}  models: [${models}]\n`).local!;
const registerLocal = (id: string, extra = "") => {
  const registered: Record<string, { models: Entry[] }> = {};
  registerLocalProvider({ registerProvider: (name, cfg) => { registered[name] = cfg as never; } }, localOf(`{ id: "${id}", contextWindow: 65536${extra} }`));
  return registered.local!.models[0]!;
};

describe("known local models", () => {
  it("matches Qwen 3.8 27B by alias, GGUF name and Ollama tag", () => {
    for (const name of ["Qwen3.8-27B", "qwen3.8-27b", "Qwen3.8-27B-UD-Q4_K_XL", "qwen3.8:27b"]) expect(knownLocalModel(name)?.label, name).toBe("Qwen 3.8 27B (local)");
    for (const name of ["qwen3.6:27b", "qwen3.8:8b", "Qwen3.8-270B", "qwen3.5:9b"]) expect(knownLocalModel(name), name).toBeUndefined();
  });

  it("registers the preset with reasoning, 32768 output tokens, no developer role and the thinking level map", () => {
    expect(registerLocal("Qwen3.8-27B")).toMatchObject({
      name: "Qwen 3.8 27B (local)",
      reasoning: true,
      maxTokens: 32_768,
      contextWindow: 65_536,
      compat: { supportsDeveloperRole: false },
      thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: null },
    });
  });

  it("lets the entry's maxTokens win over the preset", () => {
    expect(registerLocal("Qwen3.8-27B", ", maxTokens: 4096")).toMatchObject({ maxTokens: 4096, reasoning: true });
  });

  it("registers a plain local model with the defaults and no compat", () => {
    const entry = registerLocal("my-coder");
    expect(entry).toMatchObject({ id: "my-coder", name: "my-coder", reasoning: false, maxTokens: 8192, contextWindow: 65_536 });
    expect("compat" in entry).toBe(false);
    expect("thinkingLevelMap" in entry).toBe(false);
  });
});

describe("registering the local provider", () => {
  it("is one OpenAI-compatible provider named local, with the key read from the named variable by Pi", () => {
    const config = localProviderConfig(localOf("{ id: m, contextWindow: 8192 }", "  apiKeyEnv: MY_LOCAL_KEY\n"));
    expect(config).toMatchObject({ baseUrl: "http://127.0.0.1:8081/v1", api: "openai-completions", apiKey: "$MY_LOCAL_KEY" });
    // Pi still wants a value to treat the provider as configured when the server needs no key.
    expect(localProviderConfig(localOf("{ id: m, contextWindow: 8192 }")).apiKey).toBe("local");
    expect(JSON.stringify(config)).not.toMatch(/sk-|Bearer/);
  });

  it("registers nothing without a local section, and reports Pi refusing it", () => {
    const calls: string[] = [];
    expect(registerLocalProvider({ registerProvider: (name) => void calls.push(name) }, undefined)).toEqual([]);
    expect(calls).toEqual([]);
    const errors: string[] = [];
    expect(registerLocalProvider({ registerProvider: () => { throw new Error("no"); } }, localOf("{ id: m, contextWindow: 8192 }"), errors)).toEqual([]);
    expect(errors).toEqual(["provider local could not be registered with Pi: no"]);
    expect(() => registerLocalProvider({ registerProvider: () => { throw new Error("no"); } }, localOf("{ id: m, contextWindow: 8192 }"))).toThrow("no");
  });
});
