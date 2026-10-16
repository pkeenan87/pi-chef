import { describe, expect, it, vi } from "vitest";
import { createFoundryClient, foundryV1Base } from "../src/providers/clients.js";
import { createRuntime, createReachabilityProbe, foundryConfigFrom, registerChatProviders } from "../src/providers/runtime.js";
import { createVercelTokenSource, jwtExpiryMs, tokenFromDotenv } from "../src/providers/vercel.js";
import { FileAuthProbe } from "../src/providers/auth.js";
import { tieredConfig, unsignedJwt } from "./helpers.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ready = { async inspect() { return { provider: "foundry" as const, status: "ready" as const, method: "azure-cli" as const, detail: "ok" }; } };

describe("Foundry v1 route", () => {
  it("builds https://<resource>/openai/v1/chat/completions with no api-version and the ai.azure.com audience", async () => {
    const config = tieredConfig();
    const foundry = foundryConfigFrom(config, {});
    expect(foundry).toMatchObject({ endpoint: "https://res.services.ai.azure.com", audience: "https://ai.azure.com", style: "v1" });
    const urls: string[] = [];
    const audiences: string[] = [];
    const client = createFoundryClient({
      auth: ready,
      config: async () => foundry,
      token: async (audience) => {
        audiences.push(audience);
        return { token: "t", expiresOn: new Date(Date.now() + 3_600_000).toISOString() };
      },
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return json({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }) as unknown as typeof fetch,
    });
    await client.complete({ model: "grok-4-7", messages: [{ role: "user", content: "x" }] });
    expect(urls).toEqual(["https://res.services.ai.azure.com/openai/v1/chat/completions"]);
    expect(audiences).toEqual(["https://ai.azure.com"]);
    expect(foundryV1Base("https://r.openai.azure.com/openai/v1/")).toBe("https://r.openai.azure.com/openai/v1");
  });

  it("keeps the legacy deployments route for configs that set apiVersion", async () => {
    const urls: string[] = [];
    const client = createFoundryClient({
      auth: ready,
      config: async () => ({ endpoint: "https://r.openai.azure.com", apiVersion: "2024-10-21", audience: "https://cognitiveservices.azure.com", api: "openai-completions" }),
      token: async () => ({ token: "t" }),
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return json({ choices: [{ message: { content: "hi" } }] });
      }) as unknown as typeof fetch,
    });
    await client.complete({ model: "dep", messages: [{ role: "user", content: "x" }] });
    expect(urls[0]).toBe("https://r.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2024-10-21");
    const legacy = tieredConfig();
    legacy.providers.foundry = { ...legacy.providers.foundry!, routeStyle: undefined, apiVersion: "2024-10-21" };
    expect(foundryConfigFrom(legacy, {}).style).toBe("deployments");
  });
});

describe("S1 az token command", () => {
  it("S1: single-quotes the audience in the az command Pi runs, so metacharacters stay literal", () => {
    const config = tieredConfig();
    config.providers.foundry!.audience = "https://x.example/'; touch /tmp/pwned; echo '";
    const registered: Record<string, { apiKey: string }> = {};
    registerChatProviders({ registerProvider: (name, cfg) => { registered[name] = cfg as never; } }, config, {}, {});
    expect(registered.foundry!.apiKey).toBe(String.raw`!az account get-access-token --resource 'https://x.example/'\''; touch /tmp/pwned; echo '\''' --query accessToken -o tsv`);
  });
});

describe("Vercel CLI token", () => {
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  const exp = (offsetMs: number) => Math.floor((NOW + offsetMs) / 1000);

  it("decodes JWT expiry and dotenv tokens", () => {
    expect(jwtExpiryMs(unsignedJwt(1234))).toBe(1_234_000);
    expect(jwtExpiryMs("not-a-jwt")).toBeUndefined();
    expect(tokenFromDotenv('A=1\nVERCEL_OIDC_TOKEN="abc.def.ghi"\n')).toBe("abc.def.ghi");
    expect(tokenFromDotenv("export VERCEL_OIDC_TOKEN=plain")).toBe("plain");
    expect(tokenFromDotenv("OTHER=1")).toBeUndefined();
  });

  it("uses a valid env token without running the CLI", async () => {
    const run = vi.fn();
    const token = unsignedJwt(exp(3_600_000));
    const source = createVercelTokenSource({ root: "/p", projectDir: ".", env: { VERCEL_OIDC_TOKEN: token }, now: () => NOW, run, readFile: () => undefined });
    expect(await source.getToken()).toBe(token);
    expect(run).not.toHaveBeenCalled();
    expect(source.status().status).toBe("ready");
  });

  it("reads a valid token from the env file", async () => {
    const token = unsignedJwt(exp(3_600_000));
    const run = vi.fn();
    const source = createVercelTokenSource({ root: "/p", projectDir: "app", env: {}, now: () => NOW, run, readFile: (file) => (file === "/p/app/.env.local" ? `VERCEL_OIDC_TOKEN="${token}"\n` : undefined) });
    expect(await source.getToken()).toBe(token);
    expect(run).not.toHaveBeenCalled();
    expect(source.envFilePath()).toBe("/p/app/.env.local");
  });

  it("runs `vercel env pull` (no shell, in projectDir) when the token expires within 10 minutes, then caches", async () => {
    let file = `VERCEL_OIDC_TOKEN="${unsignedJwt(exp(5 * 60_000))}"\n`;
    const fresh = unsignedJwt(exp(11 * 3_600_000));
    const run = vi.fn(async (args: string[], cwd: string) => {
      expect(args).toEqual(["env", "pull", ".env.local", "--yes"]);
      expect(cwd).toBe("/p/app");
      file = `VERCEL_OIDC_TOKEN="${fresh}"\n`;
    });
    const source = createVercelTokenSource({ root: "/p", projectDir: "app", env: {}, now: () => NOW, run, readFile: () => file });
    expect(source.status().status).toBe("expired");
    expect(source.status().detail).toMatch(/refreshed/);
    expect(await source.getToken()).toBe(fresh);
    expect(await source.getToken()).toBe(fresh);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("shares one pull between concurrent callers", async () => {
    let file = "";
    const fresh = unsignedJwt(exp(3_600_000));
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      file = `VERCEL_OIDC_TOKEN=${fresh}`;
    });
    const source = createVercelTokenSource({ root: "/p", projectDir: ".", env: {}, now: () => NOW, run, readFile: () => file });
    const [a, b] = await Promise.all([source.getToken(), source.getToken()]);
    expect(a).toBe(fresh);
    expect(b).toBe(fresh);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails clearly, without a projectDir or when the pull fails, and never prints the token", async () => {
    const stale = unsignedJwt(exp(-1000));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const none = createVercelTokenSource({ root: "/p", env: { VERCEL_OIDC_TOKEN: stale }, now: () => NOW });
    await expect(none.getToken()).rejects.toMatchObject({ code: "AUTH_MISSING" });
    expect(none.status().status).toBe("expired");
    const failing = createVercelTokenSource({
      root: "/p", projectDir: ".", env: { VERCEL_OIDC_TOKEN: stale }, now: () => NOW, readFile: () => undefined,
      run: async () => { throw new Error("vercel: not linked"); },
    });
    const error = await failing.getToken().catch((e) => e as Error);
    expect((error as unknown as { code: string }).code).toBe("AUTH_EXPIRED");
    for (const text of [(error as Error).message, none.status().detail, JSON.stringify(none.status()), JSON.stringify(failing.status())]) expect(text).not.toContain(stale);
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });

  it("/auth status reports vercel through the probe", async () => {
    const token = unsignedJwt(exp(3_600_000));
    const source = createVercelTokenSource({ root: "/p", projectDir: ".", env: { VERCEL_OIDC_TOKEN: token }, now: () => NOW, readFile: () => undefined });
    const probe = new FileAuthProbe({ vercel: () => source.status() });
    const view = await probe.inspect("vercel");
    expect(view).toMatchObject({ provider: "vercel", status: "ready", method: "vercel-cli" });
    expect(JSON.stringify(view)).not.toContain(token);
    expect((await new FileAuthProbe().inspect("vercel")).status).toBe("unavailable");
    const missingNoDir = new FileAuthProbe({ vercel: () => createVercelTokenSource({ root: "/p", env: {}, now: () => NOW }).status() });
    expect((await missingNoDir.inspect("vercel")).status).toBe("missing");
  });
});

describe("local reachability and provider registration", () => {
  it("probes <baseUrl>/models once per TTL", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => json({ data: [] }));
    const probe = createReachabilityProbe({ baseUrl: "http://127.0.0.1:11434/v1/", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:11434/v1/models");
    t = 60_000;
    const down = createReachabilityProbe({ baseUrl: "http://x/v1", fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    expect(await down()).toBe(false);
  });

  it("registers foundry, vercel, and local chat models with command-based credentials", () => {
    const registered: Record<string, { baseUrl: string; apiKey: string; models: { id: string }[] }> = {};
    const config = tieredConfig();
    expect(registerChatProviders({ registerProvider() {} }, config, {}, {})).not.toContain("vercel");
    config.tiers.standard!.push({ provider: "vercel", model: "xai/grok-4" });
    const vercel = createVercelTokenSource({ root: "/proj", projectDir: ".", env: {} });
    const names = registerChatProviders({ registerProvider: (name, cfg) => { registered[name] = cfg as never; } }, config, { vercel }, {});
    expect(names.sort()).toEqual(["foundry", "local", "vercel"]);
    expect(registered.foundry!.baseUrl).toBe("https://res.services.ai.azure.com/openai/v1");
    expect(registered.foundry!.apiKey).toBe("!az account get-access-token --resource 'https://ai.azure.com' --query accessToken -o tsv");
    expect(registered.foundry!.models.map((m) => m.id).sort()).toEqual(["gpt-6-astra", "grok-4-7"]);
    expect(registered.vercel!.baseUrl).toBe("https://ai-gateway.vercel.sh/v1");
    expect(registered.vercel!.apiKey.startsWith("!sed ")).toBe(true);
    expect(registered.vercel!.apiKey).toContain("/proj/.env.local");
    // decisions models (jev) are not chat models and are not registered
    expect(registered.vercel!.models.map((m) => m.id)).toEqual(["xai/grok-4"]);
    expect(registered.local!.models.map((m) => m.id)).toEqual(["qwen2.5-coder:7b"]);
  });
});
