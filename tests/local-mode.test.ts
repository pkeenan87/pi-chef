import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands.js";
import { localProfile, modelSizeB, parseConfig, priceFor } from "../src/config.js";
import type { Ticket } from "../src/domain.js";
import { statusLine } from "../src/orchestrator/state-label.js";
import { validateTickets } from "../src/orchestrator/tickets.js";
import { sampleSpec, sampleTicket, tempRepo, tieredConfig, workflow } from "./helpers.js";

const steps = "1. In src/ingest.ts add `export function retry(n: number): number` after `parse`.\n2. In tests/ingest.test.ts add a test that retry(2) returns 2.";
const good = (extra: Partial<Ticket> = {}) =>
  ({ ...sampleTicket("01", { difficulty: "low", files: ["src/ingest.ts", "tests/ingest.test.ts"], implementation: steps, checks: ["npm test"] }), estimatedContextTokens: 10_000, ...extra }) as Ticket;
const local = { label: "27B model", difficulties: ["low", "medium"], maxFiles: 3, needChecks: true };
const check = (ticket: Ticket) => validateTickets([ticket], { target: 32_000, fileSize: () => 0, commandExists: () => true, local }).errors;

describe("local-mode ticket rules", () => {
  it("accepts a small, stepwise ticket with files and a check", () => {
    expect(check(good())).toEqual([]);
    expect(check(good({ difficulty: "medium" }))).toEqual([]);
  });

  it("rejects what a small model cannot finish: high difficulty, too many or no files, prose steps, no check", () => {
    expect(check(good({ difficulty: "high" })).join("\n")).toContain("for the local 27B model, difficulty must be low or medium (not high)");
    expect(check(good({ files: ["a.ts", "b.ts", "c.ts", "d.ts"] })).join("\n")).toContain("the local 27B model gets at most 3");
    expect(check(good({ files: undefined })).join("\n")).toContain("local mode needs files");
    expect(check(good({ implementation: "Add a retry helper and test it." })).join("\n")).toContain("numbered steps");
    expect(check(good({ checks: undefined })).join("\n")).toContain("at least one check");
    expect(validateTickets([good({ checks: undefined })], { target: 32_000, fileSize: () => 0, local: { ...local, needChecks: false } }).errors).toEqual([]);
  });

  it("holds local tickets to the local context target", () => {
    expect(validateTickets([good({ estimatedContextTokens: 40_000 })], { target: 32_000, fileSize: () => 0, commandExists: () => true, local }).errors.join("\n")).toContain("above the 32000 target");
  });
});

describe("the local model's size decides the ticket rules (no switch)", () => {
  it("reads the size from the model tag", () => {
    expect(["qwen3.5:9b", "gemma3:27b", "llama3.1:8b-instruct-q4_K_M", "phi-4-14B", "deepseek-coder-v2:16b", "qwen3.5:0.6b", "mistral:latest", "qwen3.5"].map(modelSizeB)).toEqual([9, 27, 8, 14, 16, 0.6, undefined, undefined]);
  });

  it("holds a 9B model (or an unknown size) to low tickets in 2 files, and lets 14B and up take medium ones in 3", () => {
    const nine = localProfile(tieredConfig());
    expect(nine).toMatchObject({ model: "local/qwen3.5:9b", sizeB: 9, label: "9B model", small: true, difficulties: ["low"], maxFiles: 2, targetTokens: 32_768 });
    const withLocal = (model: string, contextWindow?: number) => {
      const config = tieredConfig();
      config.tiers.local = [{ provider: "local", model, ...(contextWindow ? { contextWindow } : {}) }];
      return config;
    };
    const big = localProfile(withLocal("gemma3:27b", 131_072));
    expect(big).toMatchObject({ sizeB: 27, label: "27B model", small: false, difficulties: ["low", "medium"], maxFiles: 3, targetTokens: 65_536 });
    expect(localProfile(withLocal("my-coder"))).toMatchObject({ label: "small model", small: true, targetTokens: 16_384 });
  });
});

describe("/plan --local", () => {
  it("marks the task local and tells the planner, at every stage, who builds the tickets", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig(), startTurn: () => undefined });
    const started = await app.startPlan("Add retry to the ingest parser", { local: true });
    expect(started.text).toContain("Local mode: tickets will be written for a 9B model (local/qwen3.5:9b)");
    expect(app.store.load(app.activeTaskId()!)!.localMode).toBe(true);
    expect(app.planningPrompt()).toContain("This plan will be built by a 9B model running locally");
    await app.savePlanSpec(sampleSpec);
    const tickets = app.planningPrompt()!;
    expect(tickets).toContain("[LOCAL MODE TICKETS]");
    expect(tickets).toContain("Every ticket is built by the same 9B model");
    expect(tickets).toContain("Soft target: 32768 tokens");
    expect(tickets).not.toContain("Rate a ticket high when it touches auth");
    // The plan tools validate against the 9B model's rules: low only, two files.
    expect(app.checkTickets([good({ difficulty: "medium" })]).errors.join("\n")).toContain("for the local 9B model, difficulty must be low (not medium)");
    expect(app.checkTickets([good()]).errors).toEqual([]);
  });

  it("follows localMode.default, and --cloud and --local override it per plan", async () => {
    const config = tieredConfig("localMode: { default: true }\n");
    expect(config.localMode).toEqual({ default: true });
    const app = workflow(await tempRepo(), { config, startTurn: () => undefined });
    const plan = COMMANDS.find((command) => command.name === "plan")!;
    await plan.run(app, "Add retry", async () => true);
    expect(app.store.load(app.activeTaskId()!)!.localMode).toBe(true);
    await plan.run(app, "--cloud Add a second thing", async () => true);
    const cloud = app.store.load(app.activeTaskId()!)!;
    expect(cloud.localMode).toBeUndefined();
    expect(cloud.request).toBe("Add a second thing");
    expect((await plan.run(app, "--local --cloud x", async () => true)).code).toBe("USAGE");
    expect(() => parseConfig("localMode: { default: maybe }")).toThrow(/localMode.default/);
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
