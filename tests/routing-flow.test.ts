import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sampleTicket, ticketWorkflow } from "./helpers.js";

describe("planning picks no model", () => {
  it("records no route event and no planning spend", async () => {
    const { app } = await ticketWorkflow([sampleTicket("01")], {}, { approve: false });
    const events = readFileSync(path.join(app.store.root, "tasks", app.activeTaskId()!, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "route")).toEqual([]);
    expect(app.store.readLedger()).toEqual([]);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("AWAITING_PLAN_APPROVAL");
  });
});
