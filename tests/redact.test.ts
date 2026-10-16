import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { containsSecret, redact, redactUnknown } from "../src/redact.js";

const secrets: Record<string, string> = {
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq\nabc123\n-----END RSA PRIVATE KEY-----",
  pemTruncated: "log: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq",
  google: "key AIzaSyA1234567890abcdefghijklmnopqrstuv",
  ya29: "token ya29.a0AfH6SMBx1234567890abcdefghij",
  npm: "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
  ghp: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  ghs: "x gho_abcdefghij1234567890 y",
  ghPat: "github_pat_11ABCDEFG0123456789_abcdefghij",
  sas: "https://acct.blob.core.windows.net/c?sv=2022&sig=abcDEF123%2Bxyz%3D&se=2026",
  accountKey: "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abc123XYZ+/==;EndpointSuffix=core",
  sharedAccessKey: "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKey=abcdEFGH1234=",
  basicUrl: "postgres://admin:hunter2@db.internal:5432/app",
  akia: "AKIAABCDEFGHIJKLMNOP",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  bearerBare: "curl -H 'Bearer abcdefghij1234567890' x",
  authHeader: "Authorization: Bearer short",
  skShort: "sk-abcd1234",
  skTrailingDash: "sk-abcdefghijkl-",
  skAnt: "sk-ant-api03-abcdefgh_ijkl-",
  dbPassword: "DB_PASSWORD=hunter2",
  clientSecret: "client_secret: s3cr3tvalue",
  jsonApiKey: '{"apiKey": "abc123def"}',
  jsonQuotedColon: '{"client_secret":"abc"}',
  envKey: "OPENAI_API_KEY=abc",
};

describe("redact positives", () => {
  for (const [name, text] of Object.entries(secrets)) {
    it(`redacts ${name}`, () => {
      expect(containsSecret(text)).toBe(true);
    });
  }

  it("removes the secret material and keeps surrounding text", () => {
    const out = redact("before DB_PASSWORD=hunter2 after");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(redact(secrets.pem)).toBe("[REDACTED]");
    expect(redact(secrets.basicUrl)).toBe("postgres://[REDACTED]@db.internal:5432/app");
    expect(redact(secrets.jsonApiKey)).not.toContain("abc123def");
    expect(redact(secrets.skTrailingDash)).not.toContain("abcdefghijkl");
  });

  it("redacts nested values", () => {
    expect(redactUnknown({ a: ["x", { b: "token=abc" }] })).toEqual({ a: ["x", { b: "[REDACTED]" }] });
  });
});

describe("redact negatives", () => {
  it.each([
    "tokenBudget: 8000",
    "max_tokens: 100",
    "apiKeyEnv: MY_ENV_NAME",
    "task-runner-config and disk-cache-size",
    "ask-me-anything",
    "http://localhost:11434/v1",
    "https://example.com:443/path",
    "git@github.com:org/repo.git",
    "the Bearer scheme is documented",
    "sig is short",
    "secrets, permissions and auth are review triggers",
    "- secrets",
    "AKIA is a prefix",
    "npm_config is fine",
    "audience: https://cognitiveservices.azure.com",
    "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
  ])("leaves %j alone", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("leaves the repo config.yaml untouched", () => {
    const text = readFileSync(new URL("../.pi-workflows/config.yaml", import.meta.url), "utf8");
    expect(containsSecret(text)).toBe(false);
  });
});

describe("redact keeps code that only looks like a secret", () => {
  it.each([
    '"node_modules/@octokit/auth-token": {',
    '"node_modules/@octokit/auth-token": [',
    "const token = process.env.GITHUB_THING;",
    "password: getPassword()",
    "const password = vault.getPassword(name);",
    "token: env.TOKEN_VALUE",
    "secret = os.environ['X']",
    "const key = import.meta.env.VITE_API_KEY",
    "token: $TOKEN",
    "password: (await read())",
    "token = null",
    "apiKey: undefined,",
    "secret: false;",
    "token = 42",
  ])("leaves %j alone", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("still redacts literals", () => {
    for (const text of ['password = "hunter2hunter"', "API_KEY=abc123def456", '"token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', "token: abcdefgh12345678", "secret = 'x'"]) {
      expect(redact(text), text).toContain("[REDACTED]");
    }
    expect(redact('password = "hunter2hunter"')).not.toContain("hunter2hunter");
    expect(redact("API_KEY=abc123def456")).not.toContain("abc123def456");
  });

  it("keeps a lockfile intact around the one real secret", () => {
    const lock = '"node_modules/@octokit/auth-token": {\n  "version": "4.0.0"\n},\n"token": "abcdef123456"';
    expect(redact(lock)).toBe('"node_modules/@octokit/auth-token": {\n  "version": "4.0.0"\n},\n[REDACTED]"');
  });
});
