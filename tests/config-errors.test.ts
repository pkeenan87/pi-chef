import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { bindWorkflow, registerWorkflow } from "../src/extension.js";

const priorHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = priorHome;
  bindWorkflow(undefined);
});

const LOCAL = `local:
  baseUrl: "http://127.0.0.1:8081/v1"
  models: [{ id: Qwen3.8-27B, contextWindow: 131072 }]
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
const project = () => mkdtempSync(path.join(tmpdir(), "pi-proj-"));

describe("config errors are shown", () => {
  it("names the file a model error came from: the project's when it sets models, else the user's", () => {
    const fileOf = (user: string, projectYaml: string | undefined): string | undefined => {
      home(user);
      const dir = project();
      if (projectYaml !== undefined) {
        mkdirSync(path.join(dir, ".pi-workflows"), { recursive: true });
        writeFileSync(path.join(dir, ".pi-workflows", "config.yaml"), projectYaml);
      }
      try {
        loadConfig(dir);
      } catch (error) {
        return (error as { file?: string }).file;
      }
      return undefined;
    };
    // The project's models replace the user's whole section: an agent the user file does not define is the project file's problem.
    expect(fileOf("budgets: { taskUsd: 5 }\n", "models: { high: 'agent:nope' }\n")).toMatch(/\.pi-workflows\/config\.yaml$/);
    // A project file with no models section leaves the user's models in force: the error is the user file's.
    expect(fileOf("models: { high: 'agent:nope' }\n", "budgets: { taskUsd: 5 }\n")).toMatch(/\.pi\/agent\/chef\.yaml$/);
    expect(fileOf("models: { high: 'agent:nope' }\n", undefined)).toMatch(/\.pi\/agent\/chef\.yaml$/);
  });

  it("an invalid model rejects the file and the session start names it", () => {
    const dir = home("models: { high: 'not a ref' }\n");
    expect(() => loadConfig(project())).toThrow(/models\.high is not valid/);
    const { handlers } = fakePi();
    const notes: string[] = [];
    handlers.get("session_start")!({}, ui(project(), notes));
    const text = notes.join("\n");
    expect(text).toContain("warning:~/.pi/agent/chef.yaml was ignored; built-in defaults are in use");
    expect(text).toContain("models.high");
    expect(dir).toBeTruthy();
  });

  it("an unknown agent in models is a config error", () => {
    home("models: { high: 'agent:nope' }\n");
    expect(() => loadConfig(project())).toThrow(/unknown agent/);
  });

  it("a bad local section rejects the file", () => {
    home("local: { baseUrl: 'http://example.com/v1', models: [{ id: m, contextWindow: 8192 }] }\n");
    expect(() => loadConfig(project())).toThrow(/local\.baseUrl must be an https URL, or http only for localhost/);
    home("local: { baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: m }] }\n");
    expect(() => loadConfig(project())).toThrow(/local\.models\[0\]\.contextWindow/);
  });

  it("a YAML error rejects the file and the session start says which file was ignored and why", () => {
    home("models: [unclosed\n");
    const cwd = project();
    expect(() => loadConfig(cwd)).toThrow(/YAML could not be read/);
    const { handlers } = fakePi();
    const notes: string[] = [];
    expect(() => handlers.get("session_start")!({}, ui(cwd, notes))).not.toThrow();
    const text = notes.join("\n");
    expect(text).toContain("warning:~/.pi/agent/chef.yaml was ignored; built-in defaults are in use");
    expect(text).toContain("YAML could not be read");
    // Shown once, though two steps of session start hit the same error.
    expect(notes.filter((note) => note.includes("was ignored")).length).toBe(1);
  });

  it("a secret rejects the whole file and is never shown", () => {
    home(`${LOCAL}apiKey: sk-abcdefghijklmnopqrstuvwxyz0123456789\n`);
    const cwd = project();
    expect(() => loadConfig(cwd)).toThrow(/contains a secret/);
    const { handlers } = fakePi();
    const notes: string[] = [];
    handlers.get("session_start")!({}, ui(cwd, notes));
    expect(notes.join("\n")).toContain("chef.yaml was ignored");
    expect(notes.join("\n")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("registers the local provider at session start, and reports a refusal redacted", () => {
    home(LOCAL);
    const ok = fakePi();
    ok.handlers.get("session_start")!({}, ui(project(), []));
    expect(ok.registered).toEqual(["local"]);
    bindWorkflow(undefined);
    const refused = fakePi({ failProvider: "local" });
    const notes: string[] = [];
    refused.handlers.get("session_start")!({}, ui(project(), notes));
    const text = notes.join("\n");
    expect(text).toContain("provider local could not be registered with Pi: Pi refused");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });
});

describe("old settings", () => {
  it("one warning lists every ignored key and points at the docs; the rest of the file still loads", () => {
    home("tiers: { cheap: [] }\nproviders: { foundry: {} }\nlocalMode: { default: true }\nquota: {}\napprovals: { merge: manual }\nrouting: { selection: adaptive, maxEscalations: 1 }\nbranchPrefix: kept\n");
    const config = loadConfig(project());
    expect(config.branchPrefix).toBe("kept");
    expect(config.routing.maxEscalations).toBe(1);
    const ignored = (config.warnings ?? []).filter((item) => item.startsWith("Ignored settings"));
    expect(ignored).toHaveLength(1);
    for (const key of ["tiers", "providers", "localMode", "quota", "approvals", "routing.selection"]) expect(ignored[0]).toContain(key);
    expect(ignored[0]).toContain("docs/configuration.md");
  });

  it("lists a key once even when both files carry it", () => {
    home("tiers: {}\n");
    const cwd = project();
    mkdirSync(path.join(cwd, ".pi-workflows"));
    writeFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), "tiers: {}\nworkers: {}\n");
    const warning = (loadConfig(cwd).warnings ?? []).find((item) => item.startsWith("Ignored settings"))!;
    expect(warning).toBe("Ignored settings that are no longer used: tiers, workers. See docs/configuration.md for the current settings.");
  });

  it("an old cost-workflow.yaml is not read", () => {
    const dir = home("");
    writeFileSync(path.join(dir, ".pi", "agent", "cost-workflow.yaml"), "branchPrefix: old\n");
    expect(loadConfig(project()).branchPrefix).toBe("chef");
  });
});
