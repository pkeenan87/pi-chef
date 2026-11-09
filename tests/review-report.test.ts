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
  stages: { checks: { elapsedMs: 2500 }, model: { elapsedMs: 70_000, costUsd: 0.14 } },
  modelReview: {
    provider: "anthropic",
    model: "claude-opus-5-5",
    truncated: false,
    findings: [
      { likelihood: 8, severity: 8, category: "correctness", file: "package.json", message: "tsx is not in devDependencies" },
      { likelihood: 5, severity: 6, category: "tests", file: "tests/evidence.test.ts", message: "SSRF tests cover 127.0.0.1 only" },
    ],
    parts: [{ index: 1, reviewedBy: "anthropic/claude-opus-5-5", findings: 2, failures: [] }],
  },
};

const rowsOf = (markdown: string, heading: string) => {
  const part = markdown.split(`### ${heading}\n`)[1]!.split("\n\n")[0]!;
  return part.split("\n").filter((line) => line.startsWith("|"));
};

describe("reviewMarkdown tables", () => {
  const markdown = reviewMarkdown(base, { setupConfigured: true });

  it("has the header with time and total cost, and the stage table", () => {
    expect(markdown.split("\n")[0]).toBe("## Review did not pass · 2m48s · $0.14");
    expect(markdown).toContain("| Stage | Result | Time | Cost |");
    expect(markdown).toContain("| Checks | 1 of 2 passed | 2.5s | — |");
    expect(markdown).toContain("| Static scan | 1 blocking, 1 suggestion | — | — |");
    expect(markdown).toContain("| Model review | anthropic/claude-opus-5-5 · 2 findings | 1m10s | $0.14 |");
    expect(markdown).not.toContain("| Advisors |");
  });

  it("lists the checks with a fenced tail for the failed one", () => {
    expect(markdown).toContain("| npm run typecheck | ✓ pass | 1.6s |");
    expect(markdown).toContain("| npm test | ✗ exit 1 | 0.9s |");
    expect(markdown).toContain("**npm test** (exit 1)\n```\nboom line 1\nboom line 2\n```");
  });

  it("orders findings static blocking, failed checks, suggestions, then model, all numbered", () => {
    const rows = rowsOf(markdown, "Findings");
    expect(rows[0]).toBe("| # | Risk | Where | Finding |");
    expect(rows.slice(2).map((row) => row.split(" | ").slice(0, 3).join(" | "))).toEqual([
      "| 1 | BLOCKING | security",
      "| 2 | BLOCKING | npm test",
      "| 3 | SUGGESTION | maintainability",
      "| 4 | L8×S8=64 | package.json",
      "| 5 | L5×S6=30 | tests/evidence.test.ts",
    ]);
  });

  it("lists the findings carried from build after the model's, with the risk prefix in the Fix all text", () => {
    const withCarried: ReviewReport = {
      ...base,
      modelReview: { ...base.modelReview!, dropped: 3 },
      carried: [{ ticket: "02", likelihood: 3, severity: 5, file: "src/b.ts", issue: "no test for the empty case" }],
    };
    const rows = rowsOf(reviewMarkdown(withCarried, { setupConfigured: true }), "Findings");
    expect(rows.at(-1)).toBe("| 6 | L3×S5=15 | src/b.ts | no test for the empty case (carried from build, ticket 02) |");
    const items = reviewItems(withCarried);
    expect(items.map((item) => item.kind).slice(-2)).toEqual(["model", "carried"]);
    expect(items.at(-1)!.text).toBe("L3×S5 src/b.ts: no test for the empty case (carried from build, ticket 02)");
    expect(items.at(-2)!.text).toMatch(/^L5×S6 tests\/evidence\.test\.ts: /);
    expect(reviewMarkdown(withCarried, { setupConfigured: true })).toContain("· 2 findings (3 below the risk threshold dropped) |");
  });

  it("numbers the dialog table and Fix all items exactly like the report", () => {
    const items = reviewItems(base);
    const numbered = findingsTable(base).filter((line) => /^\| \d+ \|/.test(line));
    expect(numbered).toHaveLength(items.length);
    expect(items.map((item) => item.kind)).toEqual(["static", "check", "static", "model", "model"]);
    expect(markdown).toContain(findingsTable(base).join("\n"));
  });

  it("shows an unknown cost as unknown and the total as a lower bound", () => {
    const text = reviewMarkdown({ ...base, stages: { ...base.stages, model: { elapsedMs: 70_000, costUsd: null } } }, { setupConfigured: true });
    expect(text).toContain("| Model review | anthropic/claude-opus-5-5 · 2 findings | 1m10s | unknown |");
    expect(text).not.toContain("| $0.00 |");
  });

  it("escapes pipes, collapses newlines and clips long finding cells", () => {
    expect(cell("a | b\nc   d")).toBe("a \\| b c d");
    expect(cell("x".repeat(300), 160)).toHaveLength(160);
    expect(cell("x".repeat(300), 160).endsWith("…")).toBe(true);
    expect(formatUsdShort(0.004)).toBe("<$0.01");
    const messy: ReviewReport = {
      ...base,
      modelReview: { ...base.modelReview!, findings: [{ likelihood: 2, severity: 3, category: "x", file: "a|b.ts", message: `uses a | b\nand ${"y".repeat(300)}` }] },
    };
    const line = rowsOf(reviewMarkdown(messy, { setupConfigured: true }), "Findings").find((row) => row.includes("a\\|b.ts"))!;
    expect(line).toContain("uses a \\| b and yyy");
    expect(line.split(/(?<!\\)\|/).length).toBe(6);
    expect(line.length).toBeLessThan(400);
    // The full text stays in the numbered item that Fix all sends.
    expect(reviewItems(messy).at(-1)!.text).toContain("y".repeat(300));
  });
});
