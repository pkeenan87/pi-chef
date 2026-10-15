import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileAuthProbe } from "../src/providers/auth.js";
import { buildAnthropicBody, buildOpenAiBody, createFoundryClient, createTokenCache, readUsage } from "../src/providers/clients.js";

describe("usage parsing", () => {
  it("subtracts OpenAI cached tokens from input", () => {
    const usage = readUsage({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } });
    expect(usage).toMatchObject({ input: 200, output: 50, cacheRead: 800 });
    const responses = readUsage({ usage: { input_tokens: 500, output_tokens: 5, input_tokens_details: { cached_tokens: 100 } } });
    expect(responses).toMatchObject({ input: 400, cacheRead: 100 });
  });

  it("keeps Anthropic input separate from cache tokens", () => {
    const usage = readUsage({ usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 } });
    expect(usage).toMatchObject({ input: 20, output: 7, cacheRead: 900, cacheWrite: 40 });
  });
});

describe("prompt caching", () => {
  const request = { model: "m", promptCacheKey: "k", messages: [{ role: "system" as const, content: "stable" }, { role: "user" as const, content: "task" }] };

  it("marks the Anthropic system prefix and can opt out", () => {
    const body = buildAnthropicBody(request) as { system: { cache_control?: unknown }[] };
    expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    const off = buildAnthropicBody({ ...request, promptCache: false }) as { system: { cache_control?: unknown }[] };
    expect(off.system[0]!.cache_control).toBeUndefined();
  });

  it("sends prompt_cache_key only to OpenAI proper", () => {
    expect(buildOpenAiBody(request)).not.toHaveProperty("prompt_cache_key");
    expect(buildOpenAiBody(request, { openaiProper: true })).toHaveProperty("prompt_cache_key", "k");
    expect(buildOpenAiBody({ ...request, promptCache: false }, { openaiProper: true })).not.toHaveProperty("prompt_cache_key");
  });
});

describe("token and auth caching", () => {
  it("reuses an Azure token until 5 minutes before expiry", async () => {
    let now = Date.parse("2026-10-14T12:00:00Z");
    const fetchToken = vi.fn(async () => ({ token: "t", expiresOn: "2026-10-14T13:00:00Z" }));
    const get = createTokenCache(fetchToken, () => now);
    await get("aud");
    now += 54 * 60_000;
    await get("aud");
    expect(fetchToken).toHaveBeenCalledTimes(1);
    now += 2 * 60_000;
    await get("aud");
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("fetches the token once across foundry requests", async () => {
    const token = vi.fn(async () => ({ token: "t", expiresOn: new Date(Date.now() + 3_600_000).toISOString() }));
    const client = createFoundryClient({
      auth: { async inspect() { return { provider: "foundry", status: "ready", method: "azure-cli", detail: "" }; } },
      config: async () => ({ endpoint: "https://x", audience: "a", api: "openai-completions" }),
      token,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] })),
    });
    await client.complete({ model: "m", messages: [] });
    await client.complete({ model: "m", messages: [] });
    expect(token).toHaveBeenCalledTimes(1);
  });

  it("caches auth.json by mtime and az account show briefly", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "auth-"));
    const file = path.join(dir, "auth.json");
    writeFileSync(file, JSON.stringify({ anthropic: { type: "oauth", expires: Date.now() + 1e7 } }));
    const azure = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    const probe = new FileAuthProbe({ authFile: file, azure });
    expect((await probe.inspect("anthropic")).status).toBe("ready");
    writeFileSync(file, JSON.stringify({}));
    utimesSync(file, new Date(0), new Date(0));
    expect((await probe.inspect("anthropic")).status).toBe("missing");
    await probe.inspect("foundry");
    await probe.inspect("foundry");
    expect(azure).toHaveBeenCalledTimes(1);
  });
});
