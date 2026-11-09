import { describe, expect, it } from "vitest";
import { parseTicketReview } from "../src/orchestrator/ticket-review.js";
import { parseModelFindings } from "../src/review/model-review.js";
import { bracketSpans, dedupe, firstJson, keepBest, readFinding } from "../src/review/scored-json.js";

describe("the scored-findings reader the three reviews share", () => {
  it("finds JSON in the whole text, a fence, or prose, skipping brackets inside strings", () => {
    const take = (value: unknown) => (Array.isArray(value) ? value : undefined);
    expect(firstJson('[{"a":1}]', take)).toEqual([{ a: 1 }]);
    expect(firstJson('Result:\n```json\n[{"a":2}]\n```\nbye', take)).toEqual([{ a: 2 }]);
    expect(firstJson('see [1] then [{"a":"has ] inside"}] done', (value) => (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" ? value : undefined))).toEqual([{ a: "has ] inside" }]);
    expect(firstJson("nothing", take)).toBeUndefined();
    expect(bracketSpans('x {"a":[1,2]} y [3]')).toEqual(['{"a":[1,2]}', "[1,2]", "[3]"]);
  });

  it("reads one finding: the first text key that holds some, cut to the limit, with scores clamped and no default for a missing one", () => {
    expect(readFinding({ issue: "", message: "m".repeat(500), likelihood: "4", severity: 11, file: " a.ts " }, ["issue", "message"], 400)).toEqual({ likelihood: 4, severity: 10, category: "general", message: "m".repeat(400), file: "a.ts" });
    expect(readFinding({ message: "x", severity: 3 }, ["message"], 300)).toEqual({ severity: 3, category: "general", message: "x" });
    expect(readFinding({ message: "  " }, ["message"], 300)).toBeUndefined();
  });

  it("dedupes by file and message keeping the higher risk, then filters once, redacts, sorts and caps", () => {
    const found = [
      { likelihood: 3, severity: 4, category: "bug", file: "a.ts", message: "Loop never ends." },
      { likelihood: 9, severity: 5, category: "bug", file: "a.ts", message: "loop never ends" },
      { likelihood: 2, severity: 2, category: "x", message: "weak" },
      { severity: 9, category: "x", message: "no likelihood" },
      { likelihood: 6, severity: 6, category: "x", message: "token=abcdef123456 leaked" },
    ];
    expect(dedupe(found)).toHaveLength(4);
    const { findings, dropped } = keepBest(found, 1);
    expect(dropped).toBe(2);
    expect(findings).toEqual([{ likelihood: 9, severity: 5, category: "bug", file: "a.ts", message: "loop never ends" }]);
    expect(keepBest(found, 5).findings.map((finding) => finding.message)).toEqual(["loop never ends", expect.stringContaining("[REDACTED]")]);
  });

  it("the model pass and the ticket review read the same answer shapes", () => {
    const list = '[{"likelihood":8,"severity":9,"message":"bad"}]';
    expect(parseModelFindings(`prose ${list} prose`)).toEqual([{ likelihood: 8, severity: 9, category: "general", message: "bad" }]);
    expect(parseTicketReview(`\`\`\`json\n{"summary":"ok","findings":${list.replace("message", "issue")}}\n\`\`\``)).toEqual({ findings: [{ likelihood: 8, severity: 9, issue: "bad" }], dropped: 0, summary: "ok" });
    expect(parseTicketReview(list)).toBeUndefined();
  });
});
