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
    // /review does not move phases, and nothing enters PUBLISHED any more; an old file in it can still leave.
    expect(canTransition("IMPLEMENTING", "PUBLISHED")).toBe(false);
    expect(canTransition("PUBLISHED", "PUBLISHED")).toBe(false);
    expect(canTransition("PUBLISHED", "IMPLEMENTING")).toBe(true);
    expect(canTransition("PUBLISHED", "COMPLETE")).toBe(true);
  });

  it("no longer enters the retired phases, but a task loaded in one can always leave it", () => {
    for (const retired of ["AUTOPILOT", "MERGE_READY", "AWAITING_PUBLISH_APPROVAL"] as const) {
      for (const from of ["IDLE", "PLANNING", "AWAITING_PLAN_APPROVAL", "IMPLEMENTING", "REVIEWING", "PUBLISHED", "COMPLETE", "FAILED", "BLOCKED"] as const) {
        expect(canTransition(from, retired), `${from} -> ${retired}`).toBe(false);
      }
      for (const to of ["COMPLETE", "PLANNING", "IDLE"] as const) {
        expect(canTransition(retired, to), `${retired} -> ${to}`).toBe(true);
      }
    }
  });

  it("resumes a pause to the phase it left", () => {
    const paused = move({ ...base, phase: "IMPLEMENTING" }, "PAUSED", "2026-10-14T00:00:00.000Z", "wait");
    expect(paused.pausedFrom).toBe("IMPLEMENTING");
    expect(canTransition("PAUSED", "IMPLEMENTING", paused)).toBe(true);
    expect(canTransition("PAUSED", "COMPLETE", paused)).toBe(false);
  });
});
