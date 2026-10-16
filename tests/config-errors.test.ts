import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, tierCandidates } from "../src/config.js";
import { bindWorkflow, registerWorkflow } from "../src/extension.js";

const priorHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = priorHome;
  bindWorkflow(undefined);
});

const FOUNDRY = `providers:
  foundry:
    endpoint: "https://res.services.ai.azure.com"
    routeStyle: v1
`;

function home(yaml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-home-"));
  mkdirSync(path.join(dir, ".pi", "agent"), { recursive: true });
  writeFileSync(path.join(dir, ".pi", "agent", "chef.yaml"), yaml);
  process.env.HOME = dir;
  return dir;
}

function fakePi(options: { failProvider?: string } = {}) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registered: string[] = [];
  const pi = {
    registerCommand() {},
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
      return () => undefined;
    },
    appendEntry() {},
    registerProvider(name: string) {
      if (name === options.failProvider) throw new Error("Pi refused: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123");
      registered.push(name);
    },
  };
  registerWorkflow(pi as unknown as ExtensionAPI);
  return { handlers, registered };
}
const ui = (cwd: string, notes: string[]) => ({ cwd, hasUI: true, ui: { notify: (m: string, level?: string) => notes.push(`${level}:${m}`), setStatus() {}, confirm: async () => false } });

describe("config errors are shown, and a bad section drops only itself", () => {
  it("an invalid tier entry drops that tier (built-ins apply), names file and key, and Foundry still registers", () => {
    const dir = home(`${FOUNDRY}tiers:\n  ticketHigh:\n    - { provider: foundry, model: "" }\n  cheap:\n    - { provider: foundry, model: my-cheap }\n`);
    const config = loadConfig(mkdtempSync(path.join(tmpdir(), "pi-proj-")));
    expect(config.tiers.ticketHigh).toBeUndefined();
    expect(tierCandidates(config, "ticketHigh")[0]?.provider).toBe("openai");
    expect(tierCandidates(config, "cheap")[0]?.model).toBe("my-cheap");
    const warning = config.warnings?.find((item) => item.includes("tiers.ticketHigh[0].model")) ?? "";
    expect(warning).toContain(path.join(dir, ".pi", "agent", "chef.yaml"));
    expect(warning).toContain("tiers.ticketHigh was dropped, so the built-in ticketHigh tier applies");
    const { handlers, registered } = fakePi();
    const notes: string[] = [];
    handlers.get("session_start")!({}, ui(mkdtempSync(path.join(tmpdir(), "pi-proj-")), notes));
    expect(registered).toContain("foundry");
    expect(notes.join("\n")).toContain("tiers.ticketHigh[0].model");
    expect(notes.every((note) => note.startsWith("warning:"))).toBe(true);
  });

  it("a tier that names a provider the file does not define is dropped, not fatal", () => {
    home(`${FOUNDRY}tiers:\n  cheap:\n    - { provider: local, model: m }\n`);
    const config = loadConfig(mkdtempSync(path.join(tmpdir(), "pi-proj-")));
    expect(config.tiers.cheap).toBeUndefined();
    expect(config.warnings?.join("\n")).toMatch(/tiers\.cheap\[0\]\.provider references provider "local"/);
    expect(config.providers.foundry?.endpoint).toBe("https://res.services.ai.azure.com");
  });

  it("a YAML error rejects the file and the session start says which file was ignored and why", () => {
    home("providers: [unclosed\n");
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    expect(() => loadConfig(cwd)).toThrow(/YAML could not be read/);
    const { handlers } = fakePi();
    const notes: string[] = [];
    expect(() => handlers.get("session_start")!({}, ui(cwd, notes))).not.toThrow();
    const text = notes.join("\n");
    expect(text).toContain("warning:~/.pi/agent/chef.yaml was ignored; built-in tiers are in use");
    expect(text).toContain("YAML could not be read");
    // Shown once, though two steps of session start hit the same error.
    expect(notes.filter((note) => note.includes("was ignored")).length).toBe(1);
  });

  it("policy rejections are as strict as before: a secret and a non-manual merge reject the whole file", () => {
    home(`${FOUNDRY}apiKey: sk-abcdefghijklmnopqrstuvwxyz0123456789\n`);
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    expect(() => loadConfig(cwd)).toThrow(/contains a secret/);
    const { handlers } = fakePi();
    const notes: string[] = [];
    handlers.get("session_start")!({}, ui(cwd, notes));
    expect(notes.join("\n")).toContain("chef.yaml was ignored");
    expect(notes.join("\n")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    home(`${FOUNDRY}approvals: { merge: auto }\n`);
    expect(() => loadConfig(cwd)).toThrow(/approvals\.merge must stay manual/);
    home(`${FOUNDRY}routing: { maxTier: bogus }\n`);
    expect(() => loadConfig(cwd)).toThrow(/routing\.maxTier/);
  });

  it("a provider Pi refuses is reported at session start, redacted, while the others still register", () => {
    home(`${FOUNDRY}  local: { baseUrl: "http://127.0.0.1:1/v1", model: m }\ntiers:\n  cheap:\n    - { provider: local, model: m }\n    - { provider: foundry, model: f }\n`);
    const { handlers, registered } = fakePi({ failProvider: "foundry" });
    const notes: string[] = [];
    handlers.get("session_start")!({}, ui(mkdtempSync(path.join(tmpdir(), "pi-proj-")), notes));
    const text = notes.join("\n");
    expect(text).toContain("provider foundry could not be registered with Pi: Pi refused");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(registered).toContain("local");
  });

  it("a project file with a bad tier or quota section keeps the user's providers and drops just those sections", () => {
    home(`${FOUNDRY}`);
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    mkdirSync(path.join(cwd, ".pi-workflows"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), "tiers:\n  nope: [{ provider: openai, model: m }]\n  premium: [{ provider: anthropic, model: claude-opus-5-5 }]\nquota: { overCapMultiplier: 0 }\n");
    const config = loadConfig(cwd);
    // An account provider needs no providers block, so a tier naming one stays.
    expect(config.tiers.premium).toEqual([{ provider: "anthropic", model: "claude-opus-5-5" }]);
    expect(config.warnings?.join("\n")).toMatch(/tiers\.nope is not a known tier.*built-in nope tier applies/);
    expect(config.warnings?.join("\n")).toMatch(/quota\.overCapMultiplier.*quota section was dropped/);
    expect(config.providers.foundry?.endpoint).toBe("https://res.services.ai.azure.com");
  });
});
