import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { registryProblem } from "../src/providers/usable.js";
import { contextOf, tempRepo, tieredConfig, workflow } from "./helpers.js";
import { CLOUD_TICKET_TOKENS, climbed, contextTarget, escalate, localLimits, modelFor, nextRung, reviewModel, routeFor, ticketReviewModel } from "../src/orchestrator/routing.js";

const LOCAL = `local:
  baseUrl: "http://127.0.0.1:8081/v1"
  models: [{ id: Qwen3.8-27B, contextWindow: 131072 }]
`;

describe("modelFor and escalate", () => {
  it("routes each difficulty to its model, from the defaults when models is unset", () => {
    const config = tieredConfig();
    expect(["low", "medium", "high"].map((d) => modelFor(config, d as never))).toEqual([
      { kind: "pi", provider: "xai", id: "grok-4.7" },
      { kind: "pi", provider: "anthropic", id: "claude-sonnet-5-5" },
      { kind: "pi", provider: "openai", id: "gpt-6.1-sol" },
    ]);
    expect(reviewModel(config)).toEqual({ kind: "pi", provider: "anthropic", id: "claude-opus-5-5" });
  });

  it("climbs low, medium, high and then stops: there is no rung above high", () => {
    expect(escalate("low")).toBe("medium");
    expect(escalate("medium")).toBe("high");
    expect(escalate("high")).toBeUndefined();
    expect(climbed("low", "high")).toBe(2);
    expect(climbed("medium", "low")).toBe(0);
    const config = tieredConfig();
    expect(nextRung(config, "low")).toBe("medium");
    expect(nextRung(config, "high")).toBeUndefined();
  });

  it("skips a rung that names the same model, and stops when nothing above differs", () => {
    const config = parseConfig("models: { low: anthropic/claude-sonnet-5-5, medium: anthropic/claude-sonnet-5-5, high: anthropic/claude-sonnet-5-5:high }\n");
    // The thinking level is part of the request, so a higher level of the same model is a different rung.
    expect(nextRung(config, "low")).toBe("high");
    const same = parseConfig("models: { low: anthropic/x, medium: anthropic/x, high: anthropic/x }\n");
    expect(nextRung(same, "low")).toBeUndefined();
  });

  it("returns an agent as an agent", () => {
    const config = parseConfig("models: { high: 'agent:claude/opus' }\n");
    expect(modelFor(config, "high")).toEqual({ kind: "agent", name: "claude", model: "opus" });
  });
});

describe("review models", () => {
  it("the ticket review uses models.review when it is a Pi model", () => {
    expect(ticketReviewModel(parseConfig("models: { review: openai/gpt-6.1-sol:high }\n"))).toMatchObject({ provider: "openai", id: "gpt-6.1-sol" });
  });

  it("falls back to models.high when review is an agent, else to the default review model", () => {
    expect(ticketReviewModel(parseConfig("models: { review: 'agent:claude', high: openai/gpt-6.1-sol }\n"))).toMatchObject({ provider: "openai", id: "gpt-6.1-sol" });
    expect(ticketReviewModel(parseConfig("models: { review: 'agent:claude', high: 'agent:codex' }\n"))).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
    expect(reviewModel(parseConfig("models: { review: 'agent:claude/opus' }\n"))).toEqual({ kind: "agent", name: "claude", model: "opus" });
  });
});

describe("availability is Pi's registry", () => {
  const registry = (known: Record<string, boolean | undefined>) => ({
    find: (provider: string, id: string) => (`${provider}/${id}` in known ? { provider, id } : undefined),
    hasConfiguredAuth: (model: { provider: string; id: string }) => known[`${model.provider}/${model.id}`] === true,
  });

  it("a model Pi does not know, or holds no credentials for, is blocked with the reason", () => {
    const reg = registry({ "anthropic/a": true, "xai/b": false });
    expect(registryProblem(reg, "anthropic", "a")).toBeUndefined();
    expect(registryProblem(reg, "openai", "c")).toMatch(/model c is not among the openai provider's registered models/);
    expect(registryProblem(reg, "xai", "b")).toMatch(/provider xai has no login or key in Pi \(run \/login xai\)/);
    expect(registryProblem({ find: () => undefined }, "x", "")).toMatch(/not among/);
    expect(registryProblem({ find: () => { throw new Error("boom"); } }, "x", "y")).toMatch(/not among/);
    // A registry with no auth test only checks that the model is known.
    expect(registryProblem({ find: () => ({}) }, "x", "y")).toBeUndefined();
  });

  it("routeFor checks a Pi model only when a registry is bound, and never an agent", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig() });
    const ctx = contextOf(app);
    const sol = modelFor(ctx.config, "high");
    expect(routeFor(ctx, "high", sol)).toEqual({ rung: "high", model: sol, label: "openai/gpt-6.1-sol" });
    ctx.registry = registry({ "anthropic/claude-sonnet-5-5": true });
    expect(routeFor(ctx, "high", sol).blocked).toMatch(/^openai\/gpt-6\.1-sol: model gpt-6\.1-sol is not among the openai/);
    expect(routeFor(ctx, "medium", modelFor(ctx.config, "medium")).blocked).toBeUndefined();
    expect(routeFor(ctx, "high", { kind: "agent", name: "claude" })).toEqual({ rung: "high", model: { kind: "agent", name: "claude" }, label: "agent:claude" });
  });
});

describe("local model limits for the planner", () => {
  it("names the difficulties built by a local model with a window, and sizes tickets to half of it", () => {
    const config = parseConfig(`models: { low: local/Qwen3.8-27B, medium: local/other }\n${LOCAL}`);
    expect(localLimits(config)).toEqual([{ difficulty: "low", model: "local/Qwen3.8-27B", contextWindow: 131072, targetTokens: 65536 }]);
    expect(contextTarget(config, "low")).toBe(65536);
    expect(contextTarget(config, "medium")).toBe(CLOUD_TICKET_TOKENS);
    expect(contextTarget(config, "high")).toBe(CLOUD_TICKET_TOKENS);
    expect(localLimits(tieredConfig())).toEqual([]);
  });
});
