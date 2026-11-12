import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sweepAgentLogs } from "../src/orchestrator/agent-sweep.js";
import { claudeProjectSlug, createAgentMeter } from "../src/runner/agent-usage.js";
import { addTask, contextOf, tempRepo, workflow } from "./helpers.js";

const BEFORE = "2026-10-14T11:00:00.000Z";
const AFTER = "2026-10-14T12:30:00.000Z"; // the fixture clock is 12:00

const use = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const claudeLine = (id: string, usage: Record<string, number>, timestamp = AFTER) => JSON.stringify({ type: "assistant", timestamp, message: { id, model: "claude-sonnet", usage } }) + "\n";
const codexMeta = (cwd: string) => JSON.stringify({ type: "session_meta", timestamp: BEFORE, payload: { cwd } }) + "\n";
const codexTotal = (input: number, output: number, timestamp = AFTER) =>
  JSON.stringify({ type: "event_msg", timestamp, payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } } } }) + "\n";
const model = JSON.stringify({ type: "turn_context", timestamp: BEFORE, payload: { model: "gpt-5.4" } }) + "\n";

async function setup() {
  const app = workflow(await tempRepo());
  const ctx = contextOf(app);
  const task = await addTask(app, "fix");
  const home = mkdtempSync(path.join(tmpdir(), "sweep-home-"));
  const project = path.join(home, ".claude", "projects", claudeProjectSlug(ctx.git.repoRoot));
  mkdirSync(project, { recursive: true });
  const progress: string[] = [];
  ctx.progress = (text) => void progress.push(text);
  const rows = () => ctx.store.readLedger().filter((entry) => entry.reason === "outside chef");
  const tokens = () => rows().reduce((sum, entry) => sum + (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0), 0);
  return { app, ctx, task, home, project, file: path.join(project, "s1.jsonl"), progress, rows, tokens, sweep: () => sweepAgentLogs(ctx, task.taskId, home) };
}

describe("outside-chef sweep, Claude Code", () => {
  it("initialises on the first sweep without ledgering, then counts new lines once", async () => {
    const t = await setup();
    writeFileSync(t.file, claudeLine("old", use(1000, 1000), BEFORE));
    expect(t.sweep()).toBeUndefined();
    expect(t.rows()).toHaveLength(0);
    expect(t.ctx.store.readAgentWatermark(t.task.taskId)?.files[t.file]?.offset).toBeGreaterThan(0);

    appendFileSync(t.file, claudeLine("m1", use(100, 10)));
    const line = t.sweep();
    expect(line).toContain("Claude Code");
    expect(line).toContain("outside chef");
    expect(t.progress).toEqual([line]);
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toMatchObject({ meter: "agent-log", tier: "agent", provider: "anthropic", model: "claude-sonnet" });
    expect(t.tokens()).toBe(110);

    expect(t.sweep()).toBeUndefined();
    expect(t.tokens()).toBe(110);
  });

  it("counts a message id repeated across the boundary once, and a half-written line only when it is whole", async () => {
    const t = await setup();
    writeFileSync(t.file, "");
    t.sweep();
    appendFileSync(t.file, claudeLine("m1", use(100, 10)));
    t.sweep();
    appendFileSync(t.file, claudeLine("m1", use(100, 10)) + claudeLine("m2", use(5, 5)));
    const whole = claudeLine("m3", use(7, 7));
    appendFileSync(t.file, whole.slice(0, 30));
    t.sweep();
    expect(t.tokens()).toBe(110 + 10);
    appendFileSync(t.file, whole.slice(30));
    t.sweep();
    expect(t.tokens()).toBe(110 + 10 + 14);
  });

  it("counts a file that appears after the first sweep, but only the lines stamped since it began", async () => {
    const t = await setup();
    t.sweep();
    const later = path.join(t.project, "s2.jsonl");
    writeFileSync(later, claudeLine("a", use(1000, 1000), BEFORE) + claudeLine("b", use(20, 2)));
    t.sweep();
    expect(t.tokens()).toBe(22);
  });

  it("does not double count what a ticket meter ledgered", async () => {
    const t = await setup();
    writeFileSync(t.file, claudeLine("old", use(1000, 1000), BEFORE));
    t.sweep();
    const meter = createAgentMeter("claude", { cwd: t.ctx.git.repoRoot, home: t.home, onConsumed: (file, offset) => t.ctx.store.advanceAgentLog(t.task.taskId, file, offset) })!;
    appendFileSync(t.file, claudeLine("ticket", use(300, 30)));
    expect(meter.collect()).toHaveLength(1);
    t.sweep();
    expect(t.rows()).toHaveLength(0);
    appendFileSync(t.file, claudeLine("outside", use(4, 4)));
    t.sweep();
    expect(t.tokens()).toBe(8);
  });

  it("is skipped while a live build holds the task, and counts the rest afterwards", async () => {
    const t = await setup();
    t.sweep();
    appendFileSync(t.file, claudeLine("m1", use(50, 5)));
    expect(t.ctx.store.claimBuild(t.task.taskId, t.ctx.git.repoRoot, BEFORE)).toBeUndefined();
    expect(t.sweep()).toBeUndefined();
    expect(t.rows()).toHaveLength(0);
    t.ctx.store.releaseBuild(t.task.taskId);
    t.sweep();
    expect(t.tokens()).toBe(55);
  });

  it("is no usage when the log directory is missing", async () => {
    const t = await setup();
    expect(sweepAgentLogs(t.ctx, t.task.taskId, path.join(t.home, "nowhere"))).toBeUndefined();
    expect(sweepAgentLogs(t.ctx, t.task.taskId, path.join(t.home, "nowhere"))).toBeUndefined();
  });
});

describe("outside-chef sweep, Codex", () => {
  it("counts the delta of the cumulative totals after the first sweep, for this repo only", async () => {
    const t = await setup();
    const day = path.join(t.home, ".codex", "sessions", "2026", "10", "14");
    mkdirSync(day, { recursive: true });
    const mine = path.join(day, "rollout-a.jsonl");
    const other = path.join(day, "rollout-b.jsonl");
    writeFileSync(mine, codexMeta(t.ctx.git.repoRoot) + model + codexTotal(500, 50, BEFORE));
    writeFileSync(other, codexMeta("/elsewhere") + model + codexTotal(500, 50, BEFORE));
    t.sweep();
    appendFileSync(mine, codexTotal(600, 70));
    appendFileSync(other, codexTotal(900, 90));
    t.sweep();
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toMatchObject({ provider: "openai", model: "gpt-5.4" });
    expect(t.tokens()).toBe(120);
    appendFileSync(mine, codexTotal(650, 75));
    t.sweep();
    expect(t.tokens()).toBe(120 + 55);
    t.sweep();
    expect(t.tokens()).toBe(175);
  });
});

describe("triggers", () => {
  it("/cost sweeps first and shows the rows as outside chef", async () => {
    const app = workflow(await tempRepo());
    const ctx = contextOf(app);
    const task = await addTask(app, "fix");
    const progress: string[] = [];
    ctx.progress = (text) => void progress.push(text);
    const project = path.join(homedir(), ".claude", "projects", claudeProjectSlug(ctx.git.repoRoot));
    mkdirSync(project, { recursive: true });
    const file = path.join(project, "s1.jsonl");
    writeFileSync(file, claudeLine("old", use(1000, 1000), BEFORE));
    expect((await app.cost()).ok).toBe(true);
    expect(ctx.store.readAgentWatermark(task.taskId)).toBeDefined();
    appendFileSync(file, claudeLine("m1", use(100, 10)));
    const result = await app.cost();
    expect(result.text).toContain("outside chef");
    expect(progress.some((line) => line.includes("Claude Code") && line.includes("outside chef"))).toBe(true);
  });
});
