import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProjectSlug, createAgentMeter, meteredEntries, notMeteredEntry } from "../src/runner/agent-usage.js";

const dir = () => mkdtempSync(path.join(tmpdir(), "agent-log-"));

describe("claudeProjectSlug", () => {
  it("replaces every character that is not a letter or digit, as Claude Code names its project dirs", () => {
    expect(claudeProjectSlug("/home/pkeenan/Work/pi-chef")).toBe("-home-pkeenan-Work-pi-chef");
    expect(claudeProjectSlug("/home/pkeenan/.codex")).toBe("-home-pkeenan--codex");
    expect(claudeProjectSlug("/work/my_repo v2")).toBe("-work-my-repo-v2");
  });
});

describe("Claude Code meter", () => {
  const repo = "/work/app";
  const line = (id: string, usage: Record<string, number>, model = "claude-sonnet-5-5", type = "assistant") => JSON.stringify({ type, message: { id, model, usage } });
  const use = (input: number, output: number, read = 0, write = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });

  function setup() {
    const home = dir();
    const project = path.join(home, ".claude", "projects", claudeProjectSlug(repo));
    mkdirSync(project, { recursive: true });
    return { home, project, file: path.join(project, "s1.jsonl") };
  }

  it("counts each message.id once however many lines repeat it, and maps the usage fields", () => {
    const { home, file } = setup();
    const meter = createAgentMeter("claude", { cwd: repo, home })!;
    writeFileSync(
      file,
      [
        line("m1", use(10, 5, 1000, 200)),
        line("m1", use(10, 5, 1000, 200)),
        line("m1", use(10, 5, 1000, 200)),
        line("m2", use(20, 7)),
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        line("m3", use(1, 1), "claude-sonnet-5-5", "system"),
      ].join("\n") + "\n",
    );
    expect(meter.collect()).toEqual([{ provider: "anthropic", model: "claude-sonnet-5-5", usage: { input: 30, output: 12, cacheRead: 1000, cacheWrite: 200, requests: 2 } }]);
    // Nothing new: nothing more to ledger.
    expect(meter.collect()).toEqual([]);
  });

  it("keeps the largest value per field when a streamed message is written more than once", () => {
    const { home, file } = setup();
    const meter = createAgentMeter("claude", { cwd: repo, home })!;
    writeFileSync(file, `${line("m1", use(10, 1))}\n${line("m1", use(10, 40))}\n`);
    expect(meter.collect()[0]!.usage).toMatchObject({ input: 10, output: 40, requests: 1 });
  });

  it("reads only what grew since the snapshot: an old file's earlier lines are not this ticket's", () => {
    const { home, file } = setup();
    writeFileSync(file, `${line("old1", use(999, 999))}\n${line("old2", use(999, 999))}\n`);
    const meter = createAgentMeter("claude", { cwd: repo, home })!;
    expect(meter.collect()).toEqual([]);
    appendFileSync(file, `${line("n1", use(100, 10))}\n${line("n1", use(100, 10))}\n`);
    expect(meter.collect()).toEqual([{ provider: "anthropic", model: "claude-sonnet-5-5", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, requests: 1 } }]);
    // A retry turn appends more: only the new message comes back.
    appendFileSync(file, `${line("n2", use(5, 6))}\n`);
    expect(meter.collect()).toEqual([{ provider: "anthropic", model: "claude-sonnet-5-5", usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, requests: 1 } }]);
  });

  it("does not count a message already in the old part of a grown file again", () => {
    const { home, file } = setup();
    writeFileSync(file, `${line("m1", use(100, 10))}\n`);
    const meter = createAgentMeter("claude", { cwd: repo, home })!;
    appendFileSync(file, `${line("m1", use(100, 10))}\n${line("m2", use(1, 2))}\n`);
    expect(meter.collect()).toEqual([{ provider: "anthropic", model: "claude-sonnet-5-5", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, requests: 1 } }]);
  });

  it("reads new files, including sub-agent logs, and groups usage by model", () => {
    const { home, project } = setup();
    const meter = createAgentMeter("claude", { cwd: repo, home })!;
    writeFileSync(path.join(project, "new.jsonl"), `${line("a", use(10, 1), "claude-opus-5-5")}\n${line("b", use(20, 2), "claude-sonnet-5-5")}\n`);
    mkdirSync(path.join(project, "new", "subagents"), { recursive: true });
    writeFileSync(path.join(project, "new", "subagents", "agent-1.jsonl"), `${line("c", use(30, 3), "claude-sonnet-5-5")}\n`);
    const calls = meter.collect();
    expect(calls.map((call) => [call.model, call.usage.input, call.usage.output]).sort()).toEqual([["claude-opus-5-5", 10, 1], ["claude-sonnet-5-5", 50, 5]]);
  });

  it("skips a half-written last line and counts it once it is complete", () => {
    const { home, file } = setup();
    const meter = createAgentMeter("claude", { cwd: repo, home })!;
    writeFileSync(file, `${line("m1", use(10, 1))}\n{"type":"assistant","message":{"id":"m2"`);
    expect(meter.collect()[0]!.usage).toMatchObject({ input: 10 });
    writeFileSync(file, `${line("m1", use(10, 1))}\n${line("m2", use(4, 4))}\n`);
    expect(meter.collect()[0]!.usage).toMatchObject({ input: 4, output: 4 });
  });

  it("finds the log through a symlinked repo path, and finds nothing for another repo", () => {
    const home = dir();
    const real = dir();
    const link = path.join(dir(), "link");
    symlinkSync(real, link);
    const project = path.join(home, ".claude", "projects", claudeProjectSlug(real));
    mkdirSync(project, { recursive: true });
    const meter = createAgentMeter("claude", { cwd: link, home })!;
    writeFileSync(path.join(project, "s.jsonl"), `${line("m1", use(3, 3))}\n`);
    expect(meter.collect()[0]!.usage).toMatchObject({ input: 3 });
    const other = createAgentMeter("claude", { cwd: "/elsewhere", home })!;
    expect(other.collect()).toEqual([]);
  });

  it("returns nothing, and never throws, when the log directory does not exist", () => {
    expect(createAgentMeter("claude", { cwd: repo, home: dir() })!.collect()).toEqual([]);
  });
});

describe("Codex meter", () => {
  const repo = "/work/app";
  const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { cwd } });
  const context = (model: string) => JSON.stringify({ type: "turn_context", payload: { model, cwd: repo } });
  const total = (input: number, cached: number, output: number, reasoning = 0) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output } } } });

  function setup() {
    const home = dir();
    const day = path.join(home, ".codex", "sessions", "2026", "11", "08");
    mkdirSync(day, { recursive: true });
    return { home, day };
  }

  it("takes a new session's last running total, with cached input split out and reasoning left inside the output", () => {
    const { home, day } = setup();
    const meter = createAgentMeter("codex", { cwd: repo, home })!;
    writeFileSync(path.join(day, "rollout-a.jsonl"), [meta(repo), context("gpt-6-astra"), total(1000, 400, 50, 20), total(3000, 1200, 150, 60)].join("\n") + "\n");
    expect(meter.collect()).toEqual([{ provider: "openai", model: "gpt-6-astra", usage: { input: 1800, output: 150, cacheRead: 1200, cacheWrite: 0, requests: 2 } }]);
    expect(meter.collect()).toEqual([]);
  });

  it("subtracts the total seen at the snapshot from a session that grew, and a later turn adds only its own", () => {
    const { home, day } = setup();
    const file = path.join(day, "rollout-b.jsonl");
    writeFileSync(file, [meta(repo), context("gpt-6-astra"), total(1000, 0, 100)].join("\n") + "\n");
    const meter = createAgentMeter("codex", { cwd: repo, home })!;
    expect(meter.collect()).toEqual([]);
    appendFileSync(file, `${total(1500, 500, 160)}\n${total(2500, 1500, 260)}\n`);
    expect(meter.collect()).toEqual([{ provider: "openai", model: "gpt-6-astra", usage: { input: 0, output: 160, cacheRead: 1500, cacheWrite: 0, requests: 2 } }]);
    appendFileSync(file, `${total(3500, 1500, 300)}\n`);
    expect(meter.collect()).toEqual([{ provider: "openai", model: "gpt-6-astra", usage: { input: 1000, output: 40, cacheRead: 0, cacheWrite: 0, requests: 1 } }]);
  });

  it("skips sessions of another directory, other files, and unchanged sessions", () => {
    const { home, day } = setup();
    writeFileSync(path.join(day, "rollout-old.jsonl"), [meta(repo), context("m"), total(9, 0, 9)].join("\n") + "\n");
    const meter = createAgentMeter("codex", { cwd: repo, home })!;
    writeFileSync(path.join(day, "rollout-other.jsonl"), [meta("/somewhere/else"), context("m"), total(500, 0, 50)].join("\n") + "\n");
    writeFileSync(path.join(day, "notes.jsonl"), [meta(repo), context("m"), total(500, 0, 50)].join("\n") + "\n");
    expect(meter.collect()).toEqual([]);
  });

  it("walks the whole sessions tree, not just today's folder", () => {
    const { home } = setup();
    const meter = createAgentMeter("codex", { cwd: repo, home })!;
    const other = path.join(home, ".codex", "sessions", "2026", "12", "01");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, "rollout-z.jsonl"), [meta(repo), context("gpt-6-astra"), total(10, 0, 1)].join("\n") + "\n");
    expect(meter.collect()[0]!.usage).toMatchObject({ input: 10, output: 1 });
  });
});

describe("agents with no reader", () => {
  it("have no meter, and their attempt is one 'not metered' entry", () => {
    for (const name of ["gemini", "cursor-agent", "grok", "agy", "opencode", "mine"]) expect(createAgentMeter(name, { cwd: "/work/app", home: dir() })).toBeUndefined();
    expect(notMeteredEntry("gemini")).toMatchObject({ agent: "gemini", meter: "not-metered", provider: "agent", model: "gemini", usage: { input: 0, output: 0, requests: 1 } });
    expect(meteredEntries("claude", [{ provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } }])).toEqual([{ agent: "claude", meter: "agent-log", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } }]);
  });
});
