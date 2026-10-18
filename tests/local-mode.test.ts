import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands.js";
import { parseConfig, priceFor } from "../src/config.js";
import type { Ticket } from "../src/domain.js";
import { statusLine } from "../src/orchestrator/state-label.js";
import { validateTickets } from "../src/orchestrator/tickets.js";
import { sampleSpec, sampleTicket, tempRepo, tieredConfig, workflow } from "./helpers.js";

const steps = "1. In src/ingest.ts add `export function retry(n: number): number` after `parse`.\n2. In tests/ingest.test.ts add a test that retry(2) returns 2.";
const good = (extra: Partial<Ticket> = {}) =>
  ({ ...sampleTicket("01", { difficulty: "low", files: ["src/ingest.ts", "tests/ingest.test.ts"], implementation: steps, checks: ["npm test"] }), estimatedContextTokens: 10_000, ...extra }) as Ticket;
const local = { maxFiles: 3, needChecks: true };
const check = (ticket: Ticket) => validateTickets([ticket], { target: 32_000, fileSize: () => 0, commandExists: () => true, local }).errors;

describe("local-mode ticket rules", () => {
  it("accepts a small, stepwise ticket with files and a check", () => {
    expect(check(good())).toEqual([]);
    expect(check(good({ difficulty: "medium" }))).toEqual([]);
  });

  it("rejects what a small model cannot finish: high difficulty, too many or no files, prose steps, no check", () => {
    expect(check(good({ difficulty: "high" })).join("\n")).toContain("difficulty low or medium (not high)");
    expect(check(good({ files: ["a.ts", "b.ts", "c.ts", "d.ts"] })).join("\n")).toContain("at most 3 (localMode.maxFilesPerTicket)");
    expect(check(good({ files: undefined })).join("\n")).toContain("local mode needs files");
    expect(check(good({ implementation: "Add a retry helper and test it." })).join("\n")).toContain("numbered steps");
    expect(check(good({ checks: undefined })).join("\n")).toContain("at least one check");
    expect(validateTickets([good({ checks: undefined })], { target: 32_000, fileSize: () => 0, local: { maxFiles: 3, needChecks: false } }).errors).toEqual([]);
  });

  it("holds local tickets to the local context target", () => {
    expect(validateTickets([good({ estimatedContextTokens: 40_000 })], { target: 32_000, fileSize: () => 0, commandExists: () => true, local }).errors.join("\n")).toContain("above the 32000 target");
  });
});

describe("/plan --local", () => {
  it("marks the task local and tells the planner, at every stage, who builds the tickets", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig(), startTurn: () => undefined });
    const started = await app.startPlan("Add retry to the ingest parser", { local: true });
    expect(started.text).toContain("Local mode");
    expect(app.store.load(app.activeTaskId()!)!.localMode).toBe(true);
    expect(app.planningPrompt()).toContain("[LOCAL MODE]");
    await app.savePlanSpec(sampleSpec);
    const tickets = app.planningPrompt()!;
    expect(tickets).toContain("[LOCAL MODE TICKETS]");
    expect(tickets).toContain("Soft target: 32000 tokens");
    expect(tickets).not.toContain("Rate a ticket high when it touches auth");
    // The plan tools validate against the local rules.
    expect(app.checkTickets([good({ difficulty: "high" })]).errors.join("\n")).toContain("difficulty low or medium");
  });

  it("follows localMode.default, and --cloud and --local override it per plan", async () => {
    const config = tieredConfig("localMode: { default: true }\n");
    expect(config.localMode).toEqual({ default: true, ticketContextTokens: 32_000, maxFilesPerTicket: 3 });
    const app = workflow(await tempRepo(), { config, startTurn: () => undefined });
    const plan = COMMANDS.find((command) => command.name === "plan")!;
    await plan.run(app, "Add retry", async () => true);
    expect(app.store.load(app.activeTaskId()!)!.localMode).toBe(true);
    await plan.run(app, "--cloud Add a second thing", async () => true);
    const cloud = app.store.load(app.activeTaskId()!)!;
    expect(cloud.localMode).toBeUndefined();
    expect(cloud.request).toBe("Add a second thing");
    expect((await plan.run(app, "--local --cloud x", async () => true)).code).toBe("USAGE");
    expect(() => parseConfig("localMode: { maxFilesPerTicket: 0 }")).toThrow(/maxFilesPerTicket/);
  });
});

describe("local mode visibility and cost", () => {
  it("says local in the status line", () => {
    const state = { taskId: "t", phase: "PLANNING", createdAt: "", updatedAt: "", request: "x", publishApproved: false, attempts: [], phaseEnteredAt: "", localMode: true } as never;
    expect(statusLine(state, { name: "retry", local: true, planning: "plan · writing tickets", spentUsd: 0, unknownSpend: false, budgetUsd: 10 })).toBe("chef · retry · local · plan · writing tickets · $0.00 of $10");
  });

  it("prices an unpriced local model at a known $0, never unknown", () => {
    expect(priceFor([], "local", "qwen3.5:9b", new Date("2026-10-18"))).toMatchObject({ inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
    expect(priceFor([], "anthropic", "unpriced", new Date("2026-10-18"))).toBeUndefined();
  });
});
