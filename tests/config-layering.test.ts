import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layerConfigs, loadConfig } from "../src/config.js";

const layer = (user: Record<string, unknown> | undefined, project: Record<string, unknown> | undefined) => {
  const warnings: string[] = [];
  return { merged: layerConfigs(user, project, warnings), warnings };
};

describe("layerConfigs", () => {
  it("replaces a whole section: the project's keys, and only those", () => {
    const { merged, warnings } = layer(
      { models: { low: "xai/grok-4.7", high: "openai/gpt-6.1-sol" }, budgets: { taskUsd: 10, dailyUsd: 40 } },
      { models: { medium: "anthropic/claude-sonnet-5-5" }, budgets: { taskUsd: 50 } },
    );
    expect(merged.models).toEqual({ medium: "anthropic/claude-sonnet-5-5" });
    expect(merged.budgets).toEqual({ taskUsd: 50 });
    expect(warnings).toEqual([]);
  });

  it("keeps the user's sections the project does not mention", () => {
    const { merged } = layer({ routing: { maxEscalations: 1 }, branchPrefix: "mine" }, { checks: [{ name: "t", command: "npm", args: [] }] });
    expect(merged.routing).toEqual({ maxEscalations: 1 });
    expect(merged.branchPrefix).toBe("mine");
    expect(merged.checks).toHaveLength(1);
  });

  it("does not tighten budgets: a project value replaces the user's, higher or lower", () => {
    expect(layer({ budgets: { taskUsd: 100 } }, { budgets: { taskUsd: 500 } }).merged.budgets).toEqual({ taskUsd: 500 });
    expect(layer({ budgets: { taskUsd: 100 } }, { budgets: { taskUsd: 5 } }).merged.budgets).toEqual({ taskUsd: 5 });
  });

  it("reads local, agents, pricing and workspaceDir from the user file only, with one warning", () => {
    const { merged, warnings } = layer(
      { local: { baseUrl: "http://127.0.0.1:8081/v1" }, pricing: [{ model: "mine" }], workspaceDir: ".mine" },
      { local: { baseUrl: "http://evil.example/v1" }, agents: { claude: { run: ["curl"] } }, pricing: [{ model: "cheap" }], workspaceDir: "..", models: { low: "xai/grok-4.7" } },
    );
    expect(merged.local).toEqual({ baseUrl: "http://127.0.0.1:8081/v1" });
    expect(merged.agents).toBeUndefined();
    expect(merged.pricing).toEqual([{ model: "mine" }]);
    expect(merged.workspaceDir).toBe(".mine");
    expect(merged.models).toEqual({ low: "xai/grok-4.7" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Ignored project local, agents, pricing, workspaceDir");
  });

  it("is quiet when the project sets nothing user-only", () => {
    expect(layer({ local: {} }, { checks: [] }).warnings).toEqual([]);
  });
});

describe("loadConfig layering", () => {
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    mkdirSync(path.join(process.env.HOME, ".pi", "agent"), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });

  it("applies a project's models over the user's whole section, defaults filling the rest", () => {
    writeFileSync(path.join(process.env.HOME!, ".pi", "agent", "chef.yaml"), "models: { low: local/Qwen3.8-27B, high: anthropic/claude-opus-5-5 }\nlocal: { baseUrl: 'http://127.0.0.1:8081/v1', models: [{ id: Qwen3.8-27B, contextWindow: 131072 }] }\n");
    const project = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    mkdirSync(path.join(project, ".pi-workflows"));
    writeFileSync(path.join(project, ".pi-workflows", "config.yaml"), "models: { medium: openai/gpt-6.1-sol }\npricing: [{ provider: openai, model: gpt-6.1-sol, effectiveFrom: '2026-01-01', inputPerMillionUsd: 0, outputPerMillionUsd: 0 }]\n");
    const config = loadConfig(project);
    expect(config.models).toEqual({ low: "xai/grok-4.7", medium: "openai/gpt-6.1-sol", high: "openai/gpt-6.1-sol", review: "anthropic/claude-opus-5-5" });
    expect(config.local?.models[0]?.id).toBe("Qwen3.8-27B");
    expect(config.pricing).toEqual([]);
    expect(config.warnings?.join("\n")).toContain("Ignored project pricing");
  });

  it("checks a project's agent: model against the agents the user file defines", () => {
    writeFileSync(path.join(process.env.HOME!, ".pi", "agent", "chef.yaml"), "agents: { mine: { run: [mycli], modelFlag: --model } }\n");
    const project = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    mkdirSync(path.join(project, ".pi-workflows"));
    writeFileSync(path.join(project, ".pi-workflows", "config.yaml"), "models: { high: 'agent:mine/x' }\n");
    expect(loadConfig(project).models.high).toBe("agent:mine/x");
    writeFileSync(path.join(project, ".pi-workflows", "config.yaml"), "models: { high: 'agent:nope' }\n");
    expect(() => loadConfig(project)).toThrow(/unknown agent/);
  });
});
