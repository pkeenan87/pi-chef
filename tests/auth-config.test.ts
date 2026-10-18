import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { FileAuthProbe, viewFromCredential } from "../src/providers/auth.js";
import { redact } from "../src/redact.js";

describe("auth and config", () => {
  it("treats openai and anthropic account logins as callable together and rejects api keys", () => {
    const now = Date.parse("2026-10-14T00:00:00.000Z");
    const openai = viewFromCredential("openai", { type: "oauth", expires: now + 60_000 }, now);
    const anthropic = viewFromCredential("anthropic", { type: "oauth", expires: now + 60_000 }, now);
    expect(openai.status).toBe("ready");
    expect(anthropic.status).toBe("ready");
    expect(viewFromCredential("openai", { type: "api_key" }, now).status).toBe("blocked");
    expect(viewFromCredential("anthropic", { type: "oauth", expires: now - 1000 }, now).status).toBe("expired");
  });

  it("reads credential metadata without copying secrets", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-auth-"));
    const file = path.join(dir, "auth.json");
    const secret = "sk-ant-SECRETVALUE999999";
    writeFileSync(file, JSON.stringify({
      openai: { type: "oauth", access: "access-token-value", refresh: "refresh-token-value", expires: Date.now() + 60_000 },
      anthropic: { type: "api_key", key: secret },
      "openai-codex": { type: "oauth", access: "codex-access", expires: Date.now() + 60_000 },
    }));
    const probe = new FileAuthProbe({ authFile: file });
    const openai = await probe.inspect("openai");
    const anthropic = await probe.inspect("anthropic");
    const encoded = JSON.stringify({ openai, anthropic });
    expect(openai.status).toBe("ready");
    expect(openai.method).toBe("oauth");
    expect(anthropic.status).toBe("blocked");
    expect(encoded).not.toContain("access-token-value");
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain("refresh-token-value");
  });

  it("rejects secrets and api-key auth in yaml", () => {
    expect(() => parseConfig("providers:\n  openai:\n    type: openai\n    auth: api-key\n")).toThrow(/account-login/);
    expect(() => parseConfig("providers:\n  openai:\n    type: openai\n    auth: account-login\n    apiKey: sk-live-SECRETVALUE123456\n")).toThrow(/secret|apiKey/i);
    expect(() => parseConfig("approvals:\n  merge: auto\n")).toThrow(/merge/);
  });

});
