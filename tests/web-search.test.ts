import { describe, expect, it, vi } from "vitest";
import { getAnthropicOAuth, runSearch, createWebSearchTool, type SearchRequest, type SearchTransport } from "../src/tools/web-search.js";
import { registerWebTools } from "../src/tools/index.js";

const auth = { accessToken: "sk-ant-oat01-abcdefghijklmnop", baseUrl: "https://api.anthropic.com/" };

const success = {
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 2 } },
  content: [
    { type: "server_tool_use", name: "web_search", input: { query: "q" } },
    { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.example/1", title: "A", page_age: "1 day ago" }, { type: "web_search_result", url: "https://b.example/2", title: "B" }] },
    { type: "text", text: "1. A - https://a.example/1", citations: [{ type: "web_search_result_location", url: "https://a.example/1", title: "A", cited_text: "cited snippet for A" }] },
  ],
};

function fake(...bodies: unknown[]): { transport: SearchTransport; reqs: SearchRequest[] } {
  const reqs: SearchRequest[] = [];
  let i = 0;
  return { reqs, transport: async (req) => (reqs.push(req), { status: 200, body: bodies[Math.min(i++, bodies.length - 1)] }) };
}

describe("runSearch", () => {
  it("sends haiku + basic web_search tool with oauth headers and returns results", async () => {
    const { transport, reqs } = fake(success);
    const out = await runSearch({ query: "q", allowed_domains: ["a.example"] }, auth, transport);
    const r = reqs[0]!;
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.body.model).toBe("claude-haiku-5-5");
    expect(r.body.max_tokens).toBe(2000);
    expect(r.body).not.toHaveProperty("thinking");
    expect(r.body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3, allowed_domains: ["a.example"] }]);
    expect(r.headers.authorization).toBe(`Bearer ${auth.accessToken}`);
    expect(r.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(r.headers["x-api-key"]).toBeUndefined();
    expect(out.hits.map((h) => [h.title, h.url, h.snippet])).toEqual([["A", "https://a.example/1", "cited snippet for A"], ["B", "https://b.example/2", undefined]]);
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 50, webSearchRequests: 2 });
  });

  it("clamps max_uses and uses blocked_domains alone; rejects both", async () => {
    const { transport, reqs } = fake(success);
    await runSearch({ query: "q", max_results: 99, blocked_domains: ["x.com"] }, auth, transport);
    expect((reqs[0]!.body.tools as Record<string, unknown>[])[0]).toMatchObject({ max_uses: 5, blocked_domains: ["x.com"] });
    expect((reqs[0]!.body.tools as Record<string, unknown>[])[0]).not.toHaveProperty("allowed_domains");
    await expect(runSearch({ query: "q", allowed_domains: ["a"], blocked_domains: ["b"] }, auth, transport)).rejects.toThrow(/not both/);
  });

  it("handles the error-object result at HTTP 200", async () => {
    const { transport } = fake({ stop_reason: "end_turn", content: [{ type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }] });
    const out = await runSearch({ query: "q" }, auth, transport);
    expect(out.hits).toEqual([]);
    expect(out.errors).toEqual(["max_uses_exceeded"]);
  });

  it("continues once on pause_turn and sums usage", async () => {
    const paused = { stop_reason: "pause_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://p.example", title: "P" }] }] };
    const { transport, reqs } = fake(paused, success);
    const out = await runSearch({ query: "q" }, auth, transport);
    expect(reqs).toHaveLength(2);
    expect((reqs[1]!.body.messages as { role: string }[])[1]!.role).toBe("assistant");
    expect(out.hits).toHaveLength(3);
    expect(out.usage.inputTokens).toBe(110);
  });

  it("stops after a second pause_turn", async () => {
    const { transport, reqs } = fake({ stop_reason: "pause_turn", content: [] });
    await runSearch({ query: "q" }, auth, transport);
    expect(reqs).toHaveLength(2);
  });

  it("reports refusal", async () => {
    const { transport } = fake({ stop_reason: "refusal", content: [] });
    expect((await runSearch({ query: "q" }, auth, transport)).refused).toBe(true);
  });

  it("surfaces HTTP errors without leaking secrets", async () => {
    const transport: SearchTransport = async () => ({ status: 401, body: { error: { message: "bad token sk-ant-oat01-zzzzzzzzzzzz" } } });
    const err = await runSearch({ query: "q" }, auth, transport).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain("zzzzzzzzzzzz");
  });

  it("refuses non-oauth credentials (API keys)", async () => {
    const { transport, reqs } = fake(success);
    await expect(runSearch({ query: "q" }, { accessToken: "sk-ant-api03-abcdef" }, transport)).rejects.toThrow(/API keys are not accepted/);
    expect(reqs).toHaveLength(0);
  });
});

describe("web_search tool", () => {
  const exec = (tool: ReturnType<typeof createWebSearchTool>, params: object) => (tool.execute as any)("id", params, undefined, undefined, {});
  it("reports usage, redacts output and checks budget first", async () => {
    const { transport } = fake({ ...success, content: [{ type: "text", text: "token=supersecretvalue123" }, ...success.content] });
    const onUsage = vi.fn();
    const tool = createWebSearchTool({ getAuth: async () => auth, onUsage, transport });
    const res = await exec(tool, { query: "q" });
    expect(res.content[0].text).toContain("1. A");
    expect(res.content[0].text).not.toContain("supersecretvalue123");
    expect(onUsage).toHaveBeenCalledWith({ provider: "anthropic", model: "claude-haiku-5-5", purpose: "web_search", query: "q", inputTokens: 100, outputTokens: 50, webSearchRequests: 2 });
  });

  it("denies when budgetCheck throws, without any request or auth lookup", async () => {
    const transport = vi.fn();
    const getAuth = vi.fn();
    const tool = createWebSearchTool({ getAuth, transport, budgetCheck: () => { throw new Error("budget exhausted"); } });
    await expect(exec(tool, { query: "q" })).rejects.toThrow("budget exhausted");
    expect(transport).not.toHaveBeenCalled();
    expect(getAuth).not.toHaveBeenCalled();
  });
});

describe("getAnthropicOAuth", () => {
  const haiku = { provider: "anthropic", id: "claude-haiku-5-5", baseUrl: "https://api.anthropic.com" };
  const reg = (over: object) => ({ find: () => undefined, getAvailable: () => [], isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-ant-oat01-x" }), ...over });
  it("uses the registry oauth model", async () => {
    const a = await getAnthropicOAuth({ modelRegistry: reg({ find: () => haiku }) });
    expect(a).toMatchObject({ accessToken: "sk-ant-oat01-x", baseUrl: "https://api.anthropic.com" });
  });
  it("falls back to another anthropic oauth model, but never to API-key models", async () => {
    const other = { provider: "anthropic", id: "claude-sonnet" };
    expect((await getAnthropicOAuth({ modelRegistry: reg({ getAvailable: () => [other] }) })).accessToken).toBe("sk-ant-oat01-x");
    await expect(getAnthropicOAuth({ modelRegistry: reg({ find: () => haiku, getAvailable: () => [haiku], isUsingOAuth: () => false }) })).rejects.toThrow(/API keys are not accepted/);
  });
  it("does not read ANTHROPIC_API_KEY", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-envkey");
    await expect(getAnthropicOAuth({ modelRegistry: reg({}) })).rejects.toThrow(/\/login anthropic/);
    vi.unstubAllEnvs();
  });
});

describe("registerWebTools", () => {
  it("registers web_search and web_fetch", () => {
    const names: string[] = [];
    registerWebTools({ registerTool: (t: { name: string }) => void names.push(t.name) } as never, {});
    expect(names).toEqual(["web_search", "web_fetch"]);
  });
});
