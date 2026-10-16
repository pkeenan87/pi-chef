import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { ProviderId, ReviewReport } from "../src/domain.js";
import { statusMarkdown } from "../src/orchestrator/reports.js";
import type { ProviderAuthView } from "../src/providers/auth.js";
import { contextOf, sampleTicket, tempRepo, tieredConfig, ticketWorkflow, workflow } from "./helpers.js";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

async function built(extra: { report?: (markdown: string) => void } = {}) {
  const t = await ticketWorkflow([sampleTicket("01", { difficulty: "low" }), sampleTicket("02", { title: "Handle a|b" })], { ...extra });
  const base = (await git(t.cwd, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
  await git(t.cwd, "checkout", "-q", "-b", "chef/task-test");
  writeFileSync(path.join(t.cwd, "a.txt"), "a\n");
  await git(t.cwd, "add", "a.txt");
  await git(t.cwd, "commit", "-q", "-m", "ticket 01");
  const head = (await git(t.cwd, "rev-parse", "HEAD")).stdout.trim();
  const ctx = contextOf(t.app);
  await ctx.store.update(t.taskId, "test", (task) => ({
    ...task,
    phase: "IMPLEMENTING",
    build: { branch: "chef/task-test", base, baseSha: head, currentTicket: "02" },
    ticketRuns: {
      "01": { status: "done", attempts: 1, turns: 1, tokens: 10, costUsd: 0.12, maxContextTokens: 1, crossedTarget: false, provider: "anthropic", model: "claude-sonnet-5-5", commit: head },
      "02": { status: "in-progress", attempts: 1, turns: 0, tokens: 0, costUsd: null, maxContextTokens: 0, crossedTarget: false },
    },
  }));
  return { ...t, ctx, head };
}

describe("/status tables", () => {
  it("shows a task mid-build", async () => {
    const t = await built();
    const text = (await t.app.status()).text;
    expect(text.startsWith("## Status · Building · ticket 02 of 2\n\n| | |\n| --- | --- |\n| Task | " + "retry-ingest-parser (" + t.taskId + ") |")).toBe(true);
    expect(text).toMatch(/\| Plan \| v1 approved \d\d:\d\d \|/);
    expect(text).toContain("| Branch | chef/task-test (base ");
    expect(text).toContain(") · 1 commit ahead |");
    expect(text).toContain("| Review | not run |");
    expect(text).toContain("| Next | ");
    expect(text).toMatch(/\| Budget \| task \$0\.00 \/ \$20 · daily \$0\.00 \/ \$75 · ok \|/);
    expect(text).toMatch(/\| Session model \| \S+ \(pinned\) \|/);
    expect(text).toContain("### Tickets\n\n| # | Ticket | Difficulty | Implementer | Review | Cost | Status |");
    expect(text).toMatch(/\| 01 \| Ticket 01 \| low \| anthropic\/claude-sonnet-5-5 \| - \| \$0\.1200 \| done [0-9a-f]{7} \|/);
    expect(text).toContain("| 02 | Handle a\\|b | ");
    expect(text).toContain("| in progress |");
    const order = ["## Status", "| Task |", "### Tickets", "### Routing", "### Logins"].map((part) => text.indexOf(part));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(text).not.toContain("### Warnings");
  });

  it("shows a built and reviewed task, and flags a review that a later commit left behind", async () => {
    const t = await built();
    const review: ReviewReport = { passed: true, claimedPass: true, findings: [], checks: [], summary: "ok", at: "2026-10-14T14:32:00.000Z", headSha: t.head };
    await t.ctx.store.update(t.taskId, "test", (task) => ({
      ...task,
      build: { ...task.build!, currentTicket: undefined },
      ticketRuns: { ...task.ticketRuns!, "02": { ...task.ticketRuns!["02"]!, status: "done" } },
      review,
    }));
    const current = (await t.app.status()).text;
    expect(current).toMatch(/^## Status · Reviewed · passed \d\d:\d\d · push and open the PR/);
    expect(current).toMatch(/\| Review \| passed \d\d:\d\d · no findings \|/);

    writeFileSync(path.join(t.cwd, "b.txt"), "b\n");
    await git(t.cwd, "add", "b.txt");
    await git(t.cwd, "commit", "-q", "-m", "more");
    const stale = (await t.app.status()).text;
    expect(stale).toContain("review is out of date (commits since) · /review again");
    expect(stale).toMatch(/\| Review \| passed \d\d:\d\d · no findings · out of date \|/);
    expect(stale).toContain("· 2 commits ahead |");
  });

  it("shows no task, with routing and logins but no tickets", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig() });
    const text = (await app.status()).text;
    expect(text.startsWith("## Status · No active task · /plan <request> to start")).toBe(true);
    expect(text).toContain("| Task | none |");
    expect(text).toContain("| Plan | none |");
    expect(text).toContain("| Branch | not started |");
    expect(text).not.toContain("### Tickets");
  });

  it("lists, per tier, what runs and each skipped model with its reason", async () => {
    const config = parseConfig(`tiers:
  ticketLow:
    - { provider: openai, model: gpt-6.1-sol }
    - { provider: xai, model: grok-4.7 }
`);
    const auth = { async inspect(provider: ProviderId): Promise<ProviderAuthView> { return { provider, status: provider === "xai" ? "ready" : "missing", method: "oauth", detail: "d" }; } };
    const text = (await workflow(await tempRepo(), { config, auth, rng: () => 0.5 }).status()).text;
    expect(text).toContain("| ticketLow | xai/grok-4.7 | openai/gpt-6.1-sol: provider openai has no login (run /login openai) |");
  });

  it("shows a logins table from the auth probe", async () => {
    const views: Record<string, ProviderAuthView> = {
      openai: { provider: "openai", status: "ready", method: "oauth", detail: "signed in" },
      anthropic: { provider: "anthropic", status: "expired", method: "oauth", detail: "run /login anthropic" },
      xai: { provider: "xai", status: "ready", method: "api-key", detail: "key | fallback" },
    };
    const auth = { async inspect(provider: ProviderId): Promise<ProviderAuthView> { return views[provider] ?? { provider, status: "missing", method: "none", detail: "none" }; } };
    const text = (await workflow(await tempRepo(), { auth }).status()).text;
    expect(text).toContain("### Logins\n\n| Provider | Status | Detail |");
    expect(text).toContain("| openai | ready | oauth · signed in |");
    expect(text).toContain("| anthropic | expired | oauth · run /login anthropic |");
    expect(text).toContain("| xai | api-key | api-key · key \\| fallback |");
    expect(text).toContain("| foundry | missing | none · none |");
  });

  it("adds warnings only when there are some", async () => {
    const clean = (await workflow(await tempRepo()).status()).text;
    expect(clean).not.toContain("### Warnings");
    const config = parseConfig("branchPrefix: x\n");
    config.warnings = ["Ignored project providers.foundry.endpoint"];
    const text = (await workflow(await tempRepo(), { config }).status()).text;
    expect(text).toContain("### Warnings\n\n- Config: Ignored project providers.foundry.endpoint");
  });

  it("posts the tables with ctx.report and returns the state line; without it the result is the markdown", async () => {
    const reports: string[] = [];
    const withReport = workflow(await tempRepo(), { report: (markdown) => void reports.push(markdown) });
    const result = await withReport.status();
    expect(result.text).toBe("No active task · /plan <request> to start");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("| Task | none |");
    const plain = await workflow(await tempRepo()).status();
    expect(plain.text).toContain("## Status · No active task");
    expect(plain.text).toContain("| Task | none |");
  });

  it("escapes pipes and flattens newlines in cells", async () => {
    const t = await built();
    await t.ctx.store.update(t.taskId, "test", (task) => ({ ...task, ticketRuns: { ...task.ticketRuns!, "02": { ...task.ticketRuns!["02"]!, status: "failed", error: "bad | thing\nsecond line" } } }));
    const text = (await t.app.status()).text;
    expect(text).toContain("| failed: bad \\| thing second line |");
    const rows = text.split("\n").filter((line) => line.startsWith("| 02 "));
    expect(rows).toHaveLength(1);
  });

  it("builds the markdown without a model call", async () => {
    const app = workflow(await tempRepo());
    const ctx = contextOf(app);
    const out = await statusMarkdown(ctx, undefined, []);
    expect(out.stateLine).toBe("No active task · /plan <request> to start");
  });
});
