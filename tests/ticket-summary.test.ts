import { describe, expect, it } from "vitest";
import { parseCriteriaMet, setTicketStatus, tickCriteria } from "../src/orchestrator/tickets.js";

describe("ticket markdown helpers", () => {
  const md = "# 01: T\n\n## Acceptance criteria\n\n- [ ] retry works\n- [ ] logs a warning\n\n## Status: ready-for-agent\n";
  it("reads criteria from a closing summary", () => {
    const text = "Summary\n- [x] retry works\n- [ ] logs a warning (not met)\nFiles changed: a.ts";
    expect(parseCriteriaMet(text, ["retry works", "logs a warning", "absent one"])).toEqual([true, false, false]);
    expect(parseCriteriaMet("retry works: met\nlogs a warning: not met", ["retry works", "logs a warning"])).toEqual([true, false]);
  });
  it("sets status and ticks only met criteria", () => {
    expect(setTicketStatus(tickCriteria(md, [true, false]), "done")).toContain("- [x] retry works\n- [ ] logs a warning");
    expect(setTicketStatus(md, "in-progress")).toContain("## Status: in-progress");
  });
});
