import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewReport } from "../src/domain.js";
import { COMMANDS } from "../src/commands.js";
import { SCORE_RULES } from "../src/review/risk.js";
import { claudeProjectSlug } from "../src/runner/agent-usage.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import { fakeHerdrClient, type FakeHerdrClientOptions, type FakeTab } from "./herdr-fake.js";
import { sampleTicket, tempRepo, tieredConfig, ticketWorkflow, workflow } from "./helpers.js";

const FINDINGS = [
  { likelihood: 8, severity: 7, category: "bug", file: "src/ingest.ts", message: "ingest drops the last record." },
  { likelihood: 1, severity: 2, category: "style", message: "naming nit" },
];

/** The path the prompt asks the agent to write its findings to. */
const outFileOf = (prompt: string) => /findings to (\S+) \(no prose/.exec(prompt)![1]!;

/** A repo with an uncommitted change, a workflow with `models.review` set, and a fake herdr whose agent writes `answer` to the findings file. */
async function agentReview(options: { review?: string; answer?: string | undefined; fake?: FakeHerdrClientOptions; herdr?: boolean; withTask?: boolean; chat?: ChatFn } = {}) {
  const config = tieredConfig(`models: { review: '${options.review ?? "agent:gemini"}' }\n`);
  const reports: string[] = [];
  const progress: string[] = [];
  const answer = "answer" in options ? options.answer : JSON.stringify(FINDINGS);
  const fake = fakeHerdrClient({
    onSend: (tab, text) => {
      if (answer !== undefined) writeFileSync(outFileOf(text), answer);
    },
    ...options.fake,
  });
  const extras = { config, herdrTimings: { sleep: async () => undefined }, herdr: options.herdr === false ? undefined : fake.client, report: (markdown: string) => void reports.push(markdown), progress: (text: string) => void progress.push(text), ...(options.chat ? { chat: options.chat } : {}) };
  const made = options.withTask ? await ticketWorkflow([sampleTicket("01")], extras) : { app: workflow(await tempRepo(), extras), cwd: "" };
  const app = made.app;
  mkdirSync(path.join(app.cwd, "src"), { recursive: true });
  writeFileSync(path.join(app.cwd, "src", "ingest.ts"), "export const ingest = 1;\n");
  return { app, fake, reports, progress, run: (args = "") => app.review(args), report: () => JSON.parse(readFileSync(path.join(app.store.root, "reports", `review-20261014-120000.json`), "utf8")) as ReviewReport };
}

describe("/review with an agent", () => {
  it("opens a tab, sends the review prompt, reads and filters the findings file, and closes the tab", async () => {
    const t = await agentReview();
    const result = await t.run();
    expect(result.ok, result.text).toBe(true);
    const tab = t.fake.tabs[0]!;
    expect(t.fake.tabs).toHaveLength(1);
    expect(tab.options.cwd).toBe(t.app.cwd);
    expect(tab.options.argv.slice(0, 3)).toEqual(["env", `PATH=${process.env.PATH}`, "gemini"]);
    expect(tab.killed).toBe(true);
    const prompt = tab.sends[0]!;
    expect(prompt).toContain("Do not modify any file");
    expect(prompt).toContain(SCORE_RULES);
    expect(prompt).toContain("Retry failed ingests.".slice(0, 0) + "# Plan");
    expect(prompt).toMatch(/git diff [0-9a-f]{40}/);
    // No task: the findings file lives under the workspace's reports dir, as an absolute path.
    const out = outFileOf(prompt);
    expect(path.isAbsolute(out)).toBe(true);
    expect(out.startsWith(path.join(t.app.store.root, "reports"))).toBe(true);
    const review = t.report().modelReview!;
    expect(review.findings.map((finding) => finding.message)).toEqual(["ingest drops the last record."]);
    expect(review.dropped).toBe(1);
    expect(review.provider).toBe("agent");
    expect(review.parts).toEqual([{ index: 1, reviewedBy: "agent:gemini", findings: 1, failures: [] }]);
    // Advisory: the verdict is still the checks and the static scan.
    expect(t.report().passed).toBe(true);
    expect(t.reports.join("\n")).toContain("agent:gemini");
  });

  it("keeps the findings file under the task's reports dir when a task is open", async () => {
    const t = await agentReview({ withTask: true });
    expect((await t.run()).ok).toBe(true);
    const out = outFileOf(t.fake.tabs[0]!.sends[0]!);
    expect(out.startsWith(path.join(t.app.store.taskDir(t.app.activeTaskId()!), "reports"))).toBe(true);
  });

  it("ledgers one 'not metered' row for an agent with no reader, shown as 'not metered' and never as an unknown cost", async () => {
    const t = await agentReview();
    await t.run();
    const rows = t.app.store.readLedger().filter((row) => row.reason === "model review");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "agent", model: "gemini", meter: "not-metered", actualUsd: 0, phase: "REVIEWING", tier: "review" });
    const review = t.report();
    expect(review.stages!.model).toEqual(expect.objectContaining({ notMetered: true }));
    expect(review.stages!.model!.costUsd).toBeUndefined();
    expect(t.reports.join("\n")).toContain("not metered");
  });

  it("meters Claude Code from its log and prices it, like a ticket", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    const prior = process.env.HOME;
    process.env.HOME = home;
    try {
      const t = await agentReview({
        review: "agent:claude/claude-opus-5-5",
        fake: {
          onSend: (tab, text) => {
            writeFileSync(outFileOf(text), "[]");
            const dir = path.join(home, ".claude", "projects", claudeProjectSlug(tab.options.cwd!));
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "r.jsonl"), `${JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n`);
          },
        },
      });
      expect((await t.run()).ok).toBe(true);
      const [row] = t.app.store.readLedger().filter((entry) => entry.reason === "model review");
      expect(row).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", meter: "agent-log", inputTokens: 1000, outputTokens: 100 });
      expect(row!.actualUsd).toBeCloseTo(0.0225, 6);
      expect(t.report().stages!.model!.costUsd).toBeCloseTo(0.0225, 6);
    } finally {
      process.env.HOME = prior;
    }
  });

  it("reports the model stage unavailable, with a clear note, when the agent wrote no findings file; the checks still report", async () => {
    const t = await agentReview({ answer: undefined });
    const result = await t.run();
    expect(result.ok, result.text).toBe(true);
    const review = t.report();
    expect(review.passed).toBe(true);
    expect(review.checks).toHaveLength(1);
    expect(review.modelReview!.findings).toEqual([]);
    expect(review.modelReview!.error).toContain("did not write the findings file");
    expect(review.modelReview!.error).toContain("left open to read");
    // The tab stays open so the person can see why.
    expect(t.fake.tabs[0]!.killed).toBe(false);
  });

  it("reports an unreadable findings file as unavailable", async () => {
    const t = await agentReview({ answer: "I found some problems, see above." });
    expect((await t.run()).ok).toBe(true);
    expect(t.report().modelReview!.error).toMatch(/is not a JSON list of findings/);
  });

  it("warns in the report when the working tree changed while the agent reviewed", async () => {
    const t = await agentReview({
      fake: {
        onSend: (tab, text) => {
          writeFileSync(outFileOf(text), JSON.stringify(FINDINGS));
          writeFileSync(path.join(tab.options.cwd!, "src", "ingest.ts"), "export const ingest = 2;\n");
        },
      },
    });
    expect((await t.run()).ok).toBe(true);
    const review = t.report().modelReview!;
    expect(review.findings).toHaveLength(1);
    expect(review.error).toContain("working tree changed");
    expect(t.reports.join("\n")).toContain("working tree changed");
  });

  it("keeps waiting while the agent is blocked on the person, and says so", async () => {
    const t = await agentReview({ fake: { turn: () => ["blocked", "done"] } });
    expect((await t.run()).ok).toBe(true);
    expect(t.progress.filter((line) => line.includes("waiting for you in tab"))).toHaveLength(1);
    expect(t.report().modelReview!.findings).toHaveLength(1);
  });

  it("is unavailable, saying why, when pi-chef is not inside herdr", async () => {
    const outside = await agentReview({ fake: { self: { problem: "HC_TERMINAL_ID is not set" } } });
    expect((await outside.run()).ok).toBe(true);
    expect(outside.report().modelReview!.error).toContain("start Pi inside herdr");
    expect(outside.fake.tabs).toEqual([]);
    const unbound = await agentReview({ herdr: false });
    expect((await unbound.run()).ok).toBe(true);
    expect(unbound.report().modelReview!.error).toContain("start Pi inside herdr");
  });
});

describe("/review --with", () => {
  const chatLog = () => {
    const models: string[] = [];
    const chat: ChatFn = async (candidate) => {
      models.push(`${candidate.provider}/${candidate.model}`);
      return { text: "[]", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, requests: 1 }, provider: candidate.provider, model: candidate.model };
    };
    return { models, chat };
  };

  it("runs a Pi model for one review instead of models.review", async () => {
    const { models, chat } = chatLog();
    const t = await agentReview({ review: "anthropic/claude-opus-5-5", chat });
    expect((await t.run("--with openai/gpt-6.1-sol:high")).ok).toBe(true);
    expect(models).toEqual(["openai/gpt-6.1-sol"]);
    expect(t.fake.tabs).toEqual([]);
    // models.review itself is untouched.
    expect(t.app.config.models.review).toBe("anthropic/claude-opus-5-5");
    await t.run();
    expect(models.at(-1)).toBe("anthropic/claude-opus-5-5");
  });

  it("runs an agent for one review when models.review is a Pi model, with no one-shot call", async () => {
    const { models, chat } = chatLog();
    const t = await agentReview({ review: "anthropic/claude-opus-5-5", chat });
    expect((await t.run("--with agent:gemini/gemini-3")).ok).toBe(true);
    expect(models).toEqual([]);
    expect(t.fake.tabs[0]!.options.argv).toEqual(["env", `PATH=${process.env.PATH}`, "gemini", "--approval-mode", "auto_edit", "-m", "gemini-3"]);
  });

  it("forces the model pass with --with when review.model is false, and stays off without it", async () => {
    const { models, chat } = chatLog();
    const t = await agentReview({ review: "anthropic/claude-opus-5-5", chat });
    (t.app.config.review as { model: boolean }).model = false;
    expect((await t.run()).ok).toBe(true);
    expect(models).toEqual([]);
    expect((await t.run("--with openai/gpt-6.1-sol")).ok).toBe(true);
    expect(models).toEqual(["openai/gpt-6.1-sol"]);
    expect((await t.run("--with agent:gemini")).ok).toBe(true);
    expect(t.fake.tabs).toHaveLength(1);
  });

  it("refuses a bad ref, an unknown agent and other arguments", async () => {
    const t = await agentReview();
    expect(await t.run("--with nonsense")).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await t.run("--with agent:nobody")).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await t.run("--with")).toMatchObject({ ok: false, code: "USAGE" });
    expect(await t.run("--with a/b c/d")).toMatchObject({ ok: false, code: "USAGE" });
    expect(await t.run("please")).toMatchObject({ ok: false, code: "USAGE" });
    expect(t.fake.tabs).toEqual([]);
  });

  it("completes --with, then the configured models and the built-in agents", async () => {
    const t = await agentReview();
    const spec = COMMANDS.find((item) => item.name === "review")!;
    expect(spec.complete("", t.app)).toEqual([{ label: "--with", value: "--with" }]);
    expect(spec.complete("--wi", t.app).map((item) => item.value)).toEqual(["--with"]);
    const all = spec.complete("--with ", t.app).map((item) => item.value);
    expect(all).toEqual(expect.arrayContaining(["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol", "agent:claude", "agent:cursor-agent", "agent:opencode"]));
    expect(spec.complete("--with agent:c", t.app).map((item) => item.value)).toEqual(["agent:claude", "agent:codex", "agent:cursor-agent"]);
    expect(spec.complete("--with anthropic/claude-sonnet-5-5 x", t.app)).toEqual([]);
  });
});
