import { describe, expect, it } from "vitest";
import { canTransition, move } from "../src/orchestrator/machine.js";
import type { TaskState } from "../src/domain.js";

const base = { phase: "IDLE", pausedFrom: undefined } as TaskState;

describe("state machine", () => {
  it("walks the happy path and rejects a skip", () => {
    expect(canTransition("IDLE", "IMPLEMENTING")).toBe(false);
    expect(canTransition("IDLE", "PLANNING")).toBe(true);
    expect(canTransition("AWAITING_PLAN_APPROVAL", "IMPLEMENTING")).toBe(true);
    expect(canTransition("IMPLEMENTING", "REVIEWING")).toBe(true);
    expect(canTransition("REVIEWING", "IMPLEMENTING")).toBe(true);
    expect(canTransition("AWAITING_PUBLISH_APPROVAL", "PUBLISHED")).toBe(true);
    expect(canTransition("PUBLISHED", "AUTOPILOT")).toBe(true);
    expect(canTransition("AUTOPILOT", "MERGE_READY")).toBe(true);
    expect(canTransition("MERGE_READY", "COMPLETE")).toBe(true);
  });

  it("resumes a pause to the phase it left", () => {
    const paused = move({ ...base, phase: "IMPLEMENTING" }, "PAUSED", "2026-10-14T00:00:00.000Z", "wait");
    expect(paused.pausedFrom).toBe("IMPLEMENTING");
    expect(canTransition("PAUSED", "IMPLEMENTING", paused)).toBe(true);
    expect(canTransition("PAUSED", "PUBLISHED", paused)).toBe(false);
  });
});
