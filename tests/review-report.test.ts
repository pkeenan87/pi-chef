import { describe, expect, it } from "vitest";
import type { ReviewReport } from "../src/domain.js";
import { cell, formatUsdShort } from "../src/orchestrator/format.js";
import { findingsTable, reviewItems, reviewMarkdown } from "../src/orchestrator/review-report.js";

const check = (name: string, code: number, extra: Partial<ReviewReport["checks"][number]> = {}): ReviewReport["checks"][number] => ({
  name,
  command: "npm",
  args: name.split(" ").slice(1),
  cwd: "/repo",
  exitCode: code,
  stdout: "",
  stderr: code === 0 ? "" : "boom line 1\nboom line 2",
  ran: true,
  durationMs: 900,
  ...extra,
});

const base: ReviewReport = {
  passed: false,
  claimedPass: false,
  summary: "Review did not pass: 1 blocking finding(s): x.",
  elapsedMs: 168_000,
  findings: [
    { severity: "suggestion", category: "maintainability", message: "Diff contains TODO or FIXME markers.", evidence: "TODO/FIXME" },
    { severity: "blocking", category: "security", message: "Diff introduces eval().", evidence: "eval(" },
  ],
  checks: [check("npm run typecheck", 0, { durationMs: 1600 }), check("npm test", 1)],
  stages: { checks: { elapsedMs: 2500 }, model: { elapsedMs: 70_000, costUsd: 0.14 }, advisors: { elapsedMs: 40_000, costUsd: 0.05 } },
  modelReview: {
    provider: "anthropic",
    model: "claude-opus-5-5",
    truncated: false,
    findings: [{ severity: "high", category: "correctness", file: "package.json", message: "tsx is not in devDependencies" }],
    parts: [{ index: 1, reviewedBy: "anthropic/claude-opus-5-5", findings: 1, failures: [] }],
    advisorRule: { reason: "branch has a high ticket", planned: ["gpt-6-astra", "claude-fable-5-1"] },
    advisors: [
      { provider: "openai", model: "gpt-6-astra", answers: [], concerns: [], costUsd: 0.02 },
      { provider: "anthropic", model: "claude-fable-5-1", answers: [], concerns: [], costUsd: 0.03 },
    ],
    resolution: {
      by: "anthropic/claude-opus-5-5",
      costUsd: 0.01,
      findings: [
        { severity: "high", category: "c", file: "package.json", message: "tsx is not in devDependencies", status: "accepted", rationale: "real", source: "opus", agreedBy: ["gpt-6-astra"] },
        { severity: "medium", category: "c", file: "tests/evidence.test.ts", message: "SSRF tests cover 127.0.0.1 only", status: "accepted", rationale: "fair", source: "claude-fable-5-1", agreedBy: [] },
        { severity: "low", category: "c", file: "tsconfig.json", message: "tests/ not type-checked", status: "rejected", rationale: "tests run under tsx", source: "gpt-6-astra", agreedBy: [] },
      ],
    },
  },
};

const rowsOf = (markdown: string, heading: string) => {
  const part = markdown.split(`### ${heading}\n`)[1]!.split("\n\n")[0]!;
  return part.split("\n").filter((line) => line.startsWith("|"));
};

describe("reviewMarkdown tables", () => {
  const markdown = reviewMarkdown(base, { setupConfigured: true });

  it("has the header with time and total cost, and the stage table", () => {
    expect(markdown.split("\n")[0]).toBe("## Review did not pass · 2m48s · $0.19");
    expect(markdown).toContain("| Stage | Result | Time | Cost |");
    expect(markdown).toContain("| Checks | 1 of 2 passed | 2.5s | — |");
    expect(markdown).toContain("| Static scan | 1 blocking, 1 suggestion | — | — |");
    expect(markdown).toContain("| Model review | anthropic/claude-opus-5-5 · 3 findings | 1m10s | $0.14 |");
    expect(markdown).toContain("| Advisors | openai/gpt-6-astra, anthropic/claude-fable-5-1 (branch has a high ticket) | 40.0s | $0.05 |");
  });

  it("lists the checks with a fenced tail for the failed one", () => {
    expect(markdown).toContain("| npm run typecheck | ✓ pass | 1.6s |");
    expect(markdown).toContain("| npm test | ✗ exit 1 | 0.9s |");
    expect(markdown).toContain("**npm test** (exit 1)\n```\nboom line 1\nboom line 2\n```");
  });

  it("orders findings static blocking, failed checks, suggestions, then model, with the Opus column", () => {
    const rows = rowsOf(markdown, "Findings").slice(2);
    expect(rows.map((row) => row.split(" | ").slice(0, 3).join(" | "))).toEqual([
      "| 1 | BLOCKING | security",
      "| 2 | BLOCKING | npm test",
      "| 3 | SUGGESTION | maintainability",
      "| 4 | HIGH | package.json",
      "| 5 | MEDIUM | tests/evidence.test.ts",
      "| – | LOW | tsconfig.json",
    ]);
    expect(rows[3]).toContain("| Opus | Astra agrees |");
    expect(rows[4]).toContain("| Fable | accepts |");
    expect(rows[5]).toContain("| Astra | rejects: tests run under tsx |");
  });

  it("numbers the dialog table and Fix all items exactly like the report", () => {
    const items = reviewItems(base);
    const numbered = findingsTable(base).filter((line) => /^\| \d+ \|/.test(line));
    expect(numbered).toHaveLength(items.length);
    expect(items.map((item) => item.kind)).toEqual(["static", "check", "static", "model", "model"]);
    expect(markdown).toContain(findingsTable(base).join("\n"));
    // The rejected finding is in the table but not in the items.
    expect(items.some((item) => item.text.includes("not type-checked"))).toBe(false);
  });

  it("writes a dash in the Opus column when no advisor was consulted", () => {
    const solo: ReviewReport = { ...base, modelReview: { ...base.modelReview!, resolution: undefined, advisors: undefined, advisorRule: undefined }, stages: { checks: {}, model: { costUsd: 0.14 } } };
    const text = reviewMarkdown(solo, { setupConfigured: true });
    expect(text).toContain("| 4 | HIGH | package.json | tsx is not in devDependencies | Opus | — |");
    expect(text).not.toContain("| Advisors |");
  });

  it("shows an unknown cost as unknown and the total as a lower bound", () => {
    const text = reviewMarkdown({ ...base, stages: { ...base.stages, advisors: { elapsedMs: 40_000, costUsd: null } } }, { setupConfigured: true });
    expect(text).toContain("| Advisors | openai/gpt-6-astra, anthropic/claude-fable-5-1 (branch has a high ticket) | 40.0s | unknown |");
    expect(text.split("\n")[0]).toBe("## Review did not pass · 2m48s · ≥ $0.14 (some unknown)");
    expect(text).not.toContain("| $0.00 |");
  });

  it("escapes pipes, collapses newlines and clips long finding cells", () => {
    expect(cell("a | b\nc   d")).toBe("a \\| b c d");
    expect(cell("x".repeat(300), 160)).toHaveLength(160);
    expect(cell("x".repeat(300), 160).endsWith("…")).toBe(true);
    expect(formatUsdShort(0.004)).toBe("<$0.01");
    const messy: ReviewReport = {
      ...base,
      modelReview: { ...base.modelReview!, resolution: undefined, advisors: undefined, advisorRule: undefined, findings: [{ severity: "low", category: "x", file: "a|b.ts", message: `uses a | b\nand ${"y".repeat(300)}` }] },
    };
    const line = rowsOf(reviewMarkdown(messy, { setupConfigured: true }), "Findings").find((row) => row.includes("a\\|b.ts"))!;
    expect(line).toContain("uses a \\| b and yyy");
    expect(line.split(/(?<!\\)\|/).length).toBe(8);
    expect(line.length).toBeLessThan(400);
    // The full text stays in the numbered item that Fix all sends.
    expect(reviewItems(messy).at(-1)!.text).toContain("y".repeat(300));
  });
});
