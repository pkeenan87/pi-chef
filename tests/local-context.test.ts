import { describe, expect, it } from "vitest";
import { contextMismatch, probeLocalContext, serverOrigin } from "../src/providers/local-context.js";
import { warnLocalContext } from "../src/extension.js";
import { parseConfig } from "../src/config.js";

/** A fetch that answers from a table of URL to JSON body; anything else is a 404. */
const fakeFetch = (routes: Record<string, unknown>, asked: string[] = []): typeof fetch =>
  (async (url: string) => {
    asked.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return new Response("no", { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

describe("probeLocalContext", () => {
  it("strips /v1 to reach the server's own endpoints", () => {
    expect(serverOrigin("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(serverOrigin("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
    expect(serverOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  it("reads llama-server's n_ctx from /props", async () => {
    const fetchImpl = fakeFetch({ "http://127.0.0.1:8080/props": { default_generation_settings: { n_ctx: 131072 } } });
    expect(await probeLocalContext("http://127.0.0.1:8080/v1", "Qwen3.8-27B", { fetchImpl })).toBe(131_072);
  });

  it("falls back to Ollama's /api/ps context_length for the loaded model, matched by name", async () => {
    const asked: string[] = [];
    const fetchImpl = fakeFetch({ "http://127.0.0.1:11434/api/ps": { models: [{ name: "other:7b", context_length: 4096 }, { name: "qwen3.5:9b", context_length: 32768 }] } }, asked);
    expect(await probeLocalContext("http://127.0.0.1:11434/v1", "qwen3.5:9b", { fetchImpl })).toBe(32_768);
    expect(asked).toEqual(["http://127.0.0.1:11434/props", "http://127.0.0.1:11434/api/ps"]);
  });

  it("is undefined when the model is not loaded, the server is down, or the answer is junk", async () => {
    expect(await probeLocalContext("http://127.0.0.1:11434/v1", "qwen3.5:9b", { fetchImpl: fakeFetch({ "http://127.0.0.1:11434/api/ps": { models: [] } }) })).toBeUndefined();
    expect(await probeLocalContext("http://127.0.0.1:11434/v1", "qwen3.5:9b", { fetchImpl: fakeFetch({ "http://127.0.0.1:11434/props": new Error("ECONNREFUSED"), "http://127.0.0.1:11434/api/ps": new Error("ECONNREFUSED") }) })).toBeUndefined();
    expect(await probeLocalContext("http://127.0.0.1:8080/v1", "m", { fetchImpl: fakeFetch({ "http://127.0.0.1:8080/props": { n_ctx: "lots" } }) })).toBeUndefined();
  });
});

describe("contextMismatch", () => {
  it("says nothing when they agree or the server does not say", () => {
    expect(contextMismatch("m", 65_536, 65_536)).toBeUndefined();
    expect(contextMismatch("m", 65_536, undefined)).toBeUndefined();
  });

  it("names both windows and the fix, and says which way it goes wrong", () => {
    const over = contextMismatch("qwen3.5:9b", 65_536, 32_768)!;
    expect(over).toContain("32768-token");
    expect(over).toContain("contextWindow: 65536");
    expect(over).toContain("drops the start of the conversation");
    expect(over).toContain("Set contextWindow: 32768");
    expect(contextMismatch("m", 8192, 32_768)).toContain("planned smaller");
    expect(contextMismatch("m", undefined, 32_768)).toContain("Pi assumes 128000");
  });
});

describe("warnLocalContext", () => {
  const config = parseConfig(`local:\n  baseUrl: "http://127.0.0.1:11434/v1"\n  models:\n    - { id: "qwen3.5:9b", contextWindow: 65536 }\n`);
  const ui = () => {
    const notices: string[] = [];
    return { notices, ctx: { hasUI: true, ui: { notify: (message: string) => void notices.push(message) } } as never };
  };

  it("warns once with the served window", async () => {
    const { notices, ctx } = ui();
    await warnLocalContext(config, "qwen3.5:9b", ctx, fakeFetch({ "http://127.0.0.1:11434/api/ps": { models: [{ name: "qwen3.5:9b", context_length: 4096 }] } }));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("4096-token");
  });

  it("stays quiet when the server agrees or cannot be asked", async () => {
    const { notices, ctx } = ui();
    await warnLocalContext(config, "qwen3.5:9b", ctx, fakeFetch({ "http://127.0.0.1:11434/api/ps": { models: [{ name: "qwen3.5:9b", context_length: 65536 }] } }));
    await warnLocalContext(config, "qwen3.5:9b", ctx, fakeFetch({}));
    expect(notices).toEqual([]);
  });
});
