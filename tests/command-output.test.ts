import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CostRecord } from "../src/domain.js";
import { COMMANDS } from "../src/commands.js";
import { sampleTicket, tempRepo, ticketWorkflow, tieredConfig, workflow } from "./helpers.js";

const row = (taskId: string, provider: string, model: string, reason: string, actualUsd: number | null): CostRecord => ({
  id: `${model}-${reason}-${actualUsd}`, at: "2026-10-14T12:00:00.000Z", taskId, phase: "IMPLEMENTING", provider, model, tier: "interactive", requests: 1,
  inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, actualUsd, usageKnown: actualUsd !== null, outcome: "success", retries: 0, reason,
});

describe("/cost", () => {
  it("posts spend by model, job and task as tables, and writes the exports to files", async () => {
    const reports: string[] = [];
    const { app, taskId } = await ticketWorkflow([sampleTicket("01")], { report: (markdown) => void reports.push(markdown) });
    app.store.appendLedger(row(taskId, "anthropic", "claude-sonnet-5-5", "observed assistant usage · ticket 01", 0.25));
    app.store.appendLedger(row(taskId, "anthropic", "claude-opus-5-5", "ticket review (round 1) · ticket 01", 0.5));
    app.store.appendLedger(row(taskId, "openai", "gpt-6-luna", "batch summary", null));
    // The ticket review and its advisors tag the ticket without the dot; each job is still one row.
    app.store.appendLedger(row(taskId, "anthropic", "claude-opus-5-5", "ticket review ticket 02", 0.5));
    app.store.appendLedger(row(taskId, "openai", "gpt-6-luna", "advisor ticket review ticket 01", 0.1));
    app.store.appendLedger(row(taskId, "openai", "gpt-6-luna", "advisor ticket review ticket 02", 0.1));
    // The main session's turns: planning, and chat outside planning and tickets.
    app.store.appendLedger({ ...row(taskId, "anthropic", "claude-opus-5-5", "observed assistant usage", 0.2), id: "plan-turn", phase: "PLANNING" });
    app.store.appendLedger({ ...row(taskId, "anthropic", "claude-opus-5-5", "observed assistant usage", 0.05), id: "chat-turn", phase: "REVIEWING" });
    const result = await app.cost();
    expect(result.ok, result.text).toBe(true);
    // The command result is one line; the tables go to the chat block.
    expect(result.text).toMatch(/^Known spend \$1\.7000 across 8 record\(s\) · 1 with unknown cost, estimated at \$\d+\.\d{4} · total ≈ \$1\.70\d\d$/);
    const markdown = reports.at(-1)!;
    expect(markdown).toContain("| Model | Calls | Known | Unknown rows | Not metered | Total |");
    expect(markdown).toContain("| anthropic/claude-opus-5-5 | 4 | $1.2500 | - | - | $1.2500 |");
    expect(markdown).toContain("| ticket turns | 1 | $0.2500 | - | - | $0.2500 |");
    expect(markdown).toContain("| planning turns | 1 | $0.2000 | - | - | $0.2000 |");
    expect(markdown).toContain("| session turns | 1 | $0.0500 | - | - | $0.0500 |");
    expect(markdown).toContain("| ticket review | 2 | $1.0000 | - | - | $1.0000 |");
    expect(markdown).toContain("| advisor ticket review | 2 | $0.2000 | - | - | $0.2000 |");
    expect(markdown).not.toMatch(/ticket review ticket|chat turns/);
    // The unknown row is counted at an estimate, shown apart from known spend.
    expect(markdown).toMatch(/\| batch summary \| 1 \| \$0\.0000 \| 1 \| - \| ≈ \$\d+\.\d{4} \|/);
    expect(markdown).toMatch(new RegExp(`\\| ${app.store.load(taskId)!.name} \\| 8 \\| \\$1\\.7000 \\| 1 \\| - \\| ≈ \\$1\\.70\\d\\d \\|`));
    expect(markdown).not.toMatch(/By phase|Last route|\{"/);

    const csv = await app.cost("csv");
    const file = (csv.data as { file: string }).file;
    expect(csv.text).toBe(`Wrote 8 ledger record(s) to ${file}.`);
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe("id,at,taskId,phase,provider,model,tier,requests,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,actualUsd,usageKnown,outcome,retries,reason,meter");
    expect((await app.cost("pdf")).code).toBe("USAGE");
  });
});

describe("/cost with agents that are not metered", () => {
  it("shows a count instead of dollars, never lists the agent as unpriced, and never makes the row an unknown call", async () => {
    const reports: string[] = [];
    const { app, taskId } = await ticketWorkflow([sampleTicket("01")], { report: (markdown) => void reports.push(markdown) });
    const unmetered = { ...row(taskId, "agent", "gemini", "agent gemini · ticket 01", 0), meter: "not-metered" as const, usageKnown: true, inputTokens: 0, outputTokens: 0 };
    app.store.appendLedger(unmetered);
    app.store.appendLedger({ ...unmetered, id: "second", reason: "model review" });
    app.store.appendLedger({ ...row(taskId, "anthropic", "claude-sonnet-5-5", "agent claude · ticket 02", 0.25), meter: "agent-log" as const });
    const result = await app.cost();
    expect(result.text).toContain("2 not metered");
    expect(result.text).not.toContain("unknown cost");
    const markdown = reports.at(-1)!;
    expect(markdown).toContain("| agent/gemini | 2 | - | - | 2 | not metered |");
    expect(markdown).toContain("| agent gemini | 1 | - | - | 1 | not metered |");
    expect(markdown).toContain("| anthropic/claude-sonnet-5-5 | 1 | $0.2500 | - | - | $0.2500 |");
    expect(markdown).not.toContain("No pricing row");
    // The budget sees $0.25 and nothing for the subscription rows: no flat estimate.
    expect(app.statusLine()).toContain("$0.25");
  });
});

describe("the command table", () => {
  it("has no /route: the planner picks no model", () => {
    expect(COMMANDS.map((command) => command.name)).not.toContain("route");
  });
});
