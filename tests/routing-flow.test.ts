import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderAuthView } from "../src/providers/auth.js";
import type { ProviderId } from "../src/domain.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import { seededRng, singleTaskRequest, tempRepo, tieredConfig, workflow } from "./helpers.js";

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

describe("/route", () => {
  it("uses the keyword scan only and says the planner sets complexity during /plan", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: authWith(), rng: seededRng(1) });
    const result = await app.route("add a feature to the exporter");
    expect(result.ok, result.text).toBe(true);
    const data = JSON.parse(result.text) as { note: string; classification: { source: string; recommended_tier: string; task_type: string } };
    expect(data.classification).toMatchObject({ source: "keywords", task_type: "general", recommended_tier: "standard" });
    expect(data.note).toMatch(/planner sets complexity and risk during \/plan/);
    expect(app.store.readLedger().filter((record) => record.reason === "classify")).toEqual([]);
    const secure = (await app.route("rotate the oauth credentials")).data as { classification: { source: string; risk: string } };
    expect(secure.classification).toMatchObject({ source: "keywords", risk: "high" });
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
    expect((await app.status()).text).toMatch(/\| Last route \| standard → /);
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

});
