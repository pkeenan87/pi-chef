import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderAuthView } from "../src/providers/auth.js";
import type { DecisionAnswer, DecisionsClient } from "../src/providers/clients.js";
import type { ProviderId } from "../src/domain.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import type { GroupExecutor } from "../src/orchestrator/service.js";
import { fallbackClassification } from "../src/router/classify.js";
import { checkRunner, seededRng, singleTaskRequest, tempRepo, tieredConfig, workflow } from "./helpers.js";

function authWith(statuses: Partial<Record<ProviderId, ProviderAuthView["status"]>> = {}) {
  return {
    async inspect(provider: ProviderId): Promise<ProviderAuthView> {
      const status = statuses[provider] ?? "ready";
      return { provider, status, method: provider === "local" ? "local" : "oauth", detail: status };
    },
  };
}

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 };
const fence = "```";
const emptyGroupPlan = `rename a typo in README.md\n${fence}tasks\n[{"id":"docs","files":["README.md"],"edits":[]}]\n${fence}`;
const literalPlan = `rename a typo in README.md\n${fence}tasks\n[{"id":"docs","files":["README.md"],"edits":[{"path":"README.md","content":"base\\nfixed\\n"}]}]\n${fence}`;
const mechanical = fallbackClassification("rename a typo in README");

function fakeChat(reply: (provider: string, model: string) => string) {
  const calls: { provider: string; model: string; user: string; system: string }[] = [];
  const chat: ChatFn = async (candidate, request) => {
    calls.push({
      provider: candidate.provider,
      model: candidate.model,
      user: request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"),
      system: request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"),
    });
    return { text: reply(candidate.provider, candidate.model), usage, provider: candidate.provider, model: candidate.model };
  };
  return { chat, calls };
}

describe("deterministic tier", () => {
  it("routes to the local model when it is configured and reachable", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith() });
    const decision = await app.decide(mechanical, "implement");
    expect(decision).toMatchObject({ tier: "deterministic", provider: "local", model: "qwen2.5-coder:7b" });
    expect(decision.candidate?.provider).toBe("local");
  });

  it("falls back to the literal-edit path when the local server is down", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith({ local: "unavailable" }) });
    const decision = await app.decide(mechanical, "implement");
    expect(decision).toMatchObject({ tier: "deterministic", provider: "none", model: "deterministic" });
    expect(decision.blocked).toBeUndefined();
    expect(decision.reason).toContain("local_unreachable");
    expect(decision.selectionReason).toMatch(/literal edits/);
  });

  it("uses the local model for a group with no literal edits, ledgers it, and learns per model", async () => {
    const cwd = await tempRepo();
    const { chat, calls } = fakeChat(() => JSON.stringify({ edits: [{ path: "README.md", content: "base\nfixed\n" }] }));
    const statuses: string[] = [];
    const app = workflow(cwd, { config: tieredConfig(), auth: authWith(), chat, status: (text) => text && statuses.push(text) });
    await app.plan(emptyGroupPlan);
    await app.approveDraft();
    const result = await app.implement();
    expect(result.ok, result.text).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "local", model: "qwen2.5-coder:7b" });
    expect(calls[0]!.user).toContain("README.md");
    expect(readFileSync(path.join(cwd, ".pi-workflows", "worktrees", app.activeTaskId()!, "docs", "README.md"), "utf8")).toBe("base\nfixed\n");
    const records = app.store.readLedger().filter((r) => r.provider === "local");
    expect(records.some((r) => r.inputTokens === 100 && r.tier === "deterministic")).toBe(true);
    expect(app.store.readMetrics().mechanical?.["model:deterministic:local/qwen2.5-coder:7b"]).toMatchObject({ success: 1, failure: 0 });
    expect(statuses.some((s) => s.startsWith("deterministic → local/qwen2.5-coder:7b"))).toBe(true);
    const cost = await app.cost();
    expect(cost.text).toContain("local/qwen2.5-coder:7b: ");
    expect(cost.text).toMatch(/1 success \/ 0 failure/);
    expect((await app.status()).text).toContain("Model stats: local/qwen2.5-coder:7b");
  });

  it("does not let a model write outside the group's files and records the failure", async () => {
    const { chat } = fakeChat(() => JSON.stringify({ edits: [{ path: "src/other.ts", content: "x" }] }));
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith(), chat });
    await app.plan(emptyGroupPlan);
    await app.approveDraft();
    const result = await app.implement();
    expect(result.ok).toBe(false);
    expect(app.store.readMetrics().mechanical?.["model:deterministic:local/qwen2.5-coder:7b"]).toMatchObject({ success: 0, failure: 1 });
  });

  it("keeps applying approved literal edits, with no model call, even when the local model is up", async () => {
    const { chat, calls } = fakeChat(() => "{}");
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith(), chat });
    await app.plan(literalPlan);
    await app.approveDraft();
    expect((await app.implement()).ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("classifier tier", () => {
  const answers: DecisionAnswer[] = [
    { type: "choice", name: "task_type", choice: "feature", confidence: 0.9 },
    { type: "choice", name: "complexity", choice: "medium", confidence: 0.9 },
    { type: "choice", name: "risk", choice: "low", confidence: 0.9 },
    { type: "choice", name: "recommended_tier", choice: "standard", confidence: 0.9 },
    { type: "predicate", name: "security_sensitive", probability: 0.01 },
  ];
  const client = (id: ProviderId, log: string[]): DecisionsClient => ({
    id,
    async decide(request) {
      log.push(`${id}:${request.model}`);
      return { model: request.model, answers, usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1 }, provider: id };
    },
  });

  it("classifies through the selected Decisions candidate, ledgers it, and learns success per model", async () => {
    const log: string[] = [];
    // vercel is signed out, so Foundry's Decision-1 is the only ready classifier.
    const app = workflow(await tempRepo(), {
      config: tieredConfig(),
      auth: authWith({ vercel: "missing" }),
      deciders: { foundry: client("foundry", log), vercel: client("vercel", log) },
      rng: seededRng(1),
    });
    const result = await app.route("add a feature to the exporter");
    const data = result.data as { classification: { source: string; recommended_tier: string } };
    expect(log).toEqual(["foundry:Microsoft-Decision-1"]);
    expect(data.classification).toMatchObject({ source: "model", recommended_tier: "standard" });
    expect(app.store.readLedger().some((r) => r.tier === "classifier" && r.provider === "foundry" && r.model === "Microsoft-Decision-1" && r.inputTokens === 50)).toBe(true);
    expect(app.store.readMetrics().classification?.["model:classifier:foundry/Microsoft-Decision-1"]).toMatchObject({ success: 1, failure: 0 });
  });

  it("explores between decision models and falls back to keywords when none is available", async () => {
    const log: string[] = [];
    const config = tieredConfig();
    for (let seed = 1; seed <= 12; seed++) {
      const app = workflow(await tempRepo(), { config, auth: authWith(), deciders: { foundry: client("foundry", log), vercel: client("vercel", log) }, rng: seededRng(seed) });
      await app.route("add a feature");
    }
    expect(new Set(log.map((entry) => entry.split(":")[0]))).toEqual(new Set(["foundry", "vercel"]));
    const none = workflow(await tempRepo(), { config, auth: authWith() });
    const fallback = (await none.route("rename a typo")).data as { classification: { source: string } };
    expect(fallback.classification.source).toBe("fallback");
  });
});

describe("route display", () => {
  it("sets the status line and appends a route event with the considered summary", async () => {
    const statuses: (string | undefined)[] = [];
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith(), status: (text) => statuses.push(text), rng: seededRng(2) });
    const planned = await app.plan(singleTaskRequest);
    expect(planned.ok).toBe(true);
    expect(statuses.at(-1)).toMatch(/^standard → (anthropic\/claude-sonnet-5-5|foundry\/grok-4-7) · /);
    const events = readFileSync(path.join(app.store.root, "tasks", app.activeTaskId()!, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const route = events.find((event) => event.type === "route");
    expect(route.route).toMatchObject({ purpose: "plan", tier: "standard" });
    expect(route.route.considered).toHaveLength(2);
    expect(route.route.considered[0]).toMatch(/^anthropic\/claude-sonnet-5-5: /);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("AWAITING_PLAN_APPROVAL");
    expect((await app.status()).text).toMatch(/Model: standard → /);
  });
});

describe("advisor", () => {
  const advisorReply = "Use a feature flag.";

  async function withTask(extras = {}) {
    const { chat, calls } = fakeChat(() => advisorReply);
    const notes: string[] = [];
    const statuses: (string | undefined)[] = [];
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith(), chat, notify: (m) => notes.push(m), status: (t) => statuses.push(t), rng: seededRng(3), ...extras });
    await app.plan(singleTaskRequest);
    return { app, calls, notes, statuses };
  }

  it("answers from the advisor tier, ledgers the cost under advisor, and leaves the phase alone", async () => {
    const { app, calls, statuses } = await withTask();
    const before = app.store.load(app.activeTaskId()!)!;
    const result = await app.advisor("Is this plan safe to ship? password=hunter2hunter2");
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain(advisorReply);
    expect(calls).toHaveLength(1);
    expect(["claude-fable-5-1", "gpt-6-astra"]).toContain(calls[0]!.model);
    expect(calls[0]!.user).toContain("Guard ingest");
    expect(calls[0]!.user).not.toContain("hunter2hunter2");
    expect(calls[0]!.system).toMatch(/advisor/i);
    const record = app.store.readLedger().find((r) => r.tier === "advisor")!;
    expect(record).toMatchObject({ reason: "advisor", inputTokens: 100, outputTokens: 20, phase: before.phase });
    expect(record.actualUsd).not.toBeNull();
    const after = app.store.load(before.taskId)!;
    expect(after.phase).toBe(before.phase);
    expect(after.approvedVersion).toBe(before.approvedVersion);
    expect(statuses.at(-1)).toMatch(/^advisor → (anthropic\/claude-fable-5-1|foundry\/gpt-6-astra)/);
    expect(Object.keys(app.store.readMetrics().general ?? {}).some((key) => key.startsWith("model:advisor:"))).toBe(true);
  });

  it("checks the budget first and does not call the model when it is exhausted", async () => {
    const { app, calls } = await withTask();
    app.store.appendLedger({
      id: "big", at: "2026-10-14T12:00:00.000Z", taskId: app.activeTaskId()!, phase: "PLANNING", provider: "openai", model: "x", tier: "premium",
      requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd: 9999, usageKnown: true, outcome: "success", retries: 0, reason: "test",
    });
    const result = await app.advisor("anything");
    expect(result).toMatchObject({ ok: false, code: "BUDGET" });
    expect(calls).toHaveLength(0);
  });

  it("works without an active task, and reports clear errors", async () => {
    const { chat, calls } = fakeChat(() => advisorReply);
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith(), chat, rng: seededRng(4) });
    expect((await app.advisor("hello")).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect((await app.advisor("  ")).code).toBe("USAGE");
    const noChat = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith() });
    expect((await noChat.advisor("q")).code).toBe("NO_CHAT");
    const none = workflow(await tempRepo(), { auth: authWith(), chat });
    expect((await none.advisor("q")).code).toBe("NO_ADVISOR");
  });

  it("records a failed advisor call as a failure and stays in the same phase", async () => {
    const failing: ChatFn = async () => {
      throw new Error("provider exploded with token=abcd1234abcd1234");
    };
    const { app } = await withTask({ chat: failing });
    const phase = app.store.load(app.activeTaskId()!)!.phase;
    const result = await app.advisor("why");
    expect(result.ok).toBe(false);
    expect(result.text).not.toContain("abcd1234abcd1234");
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe(phase);
    expect(app.store.readLedger().find((r) => r.tier === "advisor")?.outcome).toBe("failure");
  });

  it("skips advisor candidates whose provider is signed out", async () => {
    const { chat, calls } = fakeChat(() => advisorReply);
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith({ anthropic: "expired" }), chat, rng: seededRng(5) });
    await app.advisor("q");
    expect(calls[0]!.provider).toBe("foundry");
  });

  it("suggests the advisor (never calls it) on a security-sensitive plan, but not on an ordinary one", async () => {
    const { chat, calls } = fakeChat(() => advisorReply);
    const notes: string[] = [];
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith(), chat, notify: (m) => notes.push(m) });
    await app.plan(singleTaskRequest);
    expect(notes.filter((m) => m.includes("/advisor"))).toHaveLength(0);
    const secure = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith(), chat, notify: (m) => notes.push(m) });
    await secure.plan(`Rotate the production API key and fix auth\n${fence}tasks\n[{"id":"a","files":["src/a.ts"],"edits":[{"path":"src/a.ts","content":"export {};\\n"}]}]\n${fence}`);
    expect(notes.some((m) => /^Consider \/advisor/.test(m) && /security-sensitive/.test(m))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("suggests the advisor once escalation is exhausted, and not when no advisor is configured", async () => {
    const failing: GroupExecutor = async ({ write }) => {
      write("README.md", "base\nstill broken\n");
      return { usage };
    };
    const run = async (config = tieredConfig()) => {
      const notes: string[] = [];
      const app = workflow(await tempRepo(), {
        config,
        auth: authWith(),
        notify: (m) => notes.push(m),
        executors: { deterministic: failing, cheap: failing, standard: failing, premium: failing },
        runner: checkRunner(async () => ({ code: 1, stdout: "", stderr: "nope" })),
        rng: seededRng(6),
      });
      await app.plan(literalPlan);
      await app.approveDraft();
      const result = await app.implement();
      return { result, notes };
    };
    const { result, notes } = await run();
    expect(result.code).toBe("FAILED");
    expect(notes.some((m) => /^Consider \/advisor/.test(m) && /escalation exhausted/.test(m))).toBe(true);
    const legacy = await run(workflow(await tempRepo()).config);
    expect(legacy.notes.some((m) => m.includes("/advisor"))).toBe(false);
  });
});

describe("tier selection during implement", () => {
  it("blocks with NO_CANDIDATE instead of running literal edits when policy leaves no model", async () => {
    const config = tieredConfig("orgProviderAllowlist: [vercel]\nrouting: { maxTier: standard }\n");
    const app = workflow(await tempRepo(), { config, auth: authWith() });
    await app.plan(`add a feature\n${fence}tasks\n[{"id":"a","files":["src/a.ts"],"edits":[{"path":"src/a.ts","content":"export {};\\n"}]}]\n${fence}`);
    await app.approveDraft();
    const result = await app.implement();
    expect(result).toMatchObject({ ok: false, code: "NO_CANDIDATE" });
    expect((await app.status()).text).toContain("BLOCKED");
  });
});
