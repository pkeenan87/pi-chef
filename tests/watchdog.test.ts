import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layerConfigs } from "../src/config.js";
import { parseWatchdog, watchdogSteer, WATCHDOG_SYSTEM } from "../src/orchestrator/watchdog.js";
import { fakeChat, readyAuth, sampleTicket, tieredConfig, ticketWorkflow } from "./helpers.js";

describe("parseWatchdog", () => {
  it("returns the note only when the work is off track", () => {
    expect(parseWatchdog('{"onTrack": false, "note": "You are editing the tests to pass."}')).toBe("You are editing the tests to pass.");
    expect(parseWatchdog('```json\n{"onTrack": false, "note": "Out of scope."}\n```')).toBe("Out of scope.");
    expect(parseWatchdog('{"onTrack": true, "note": "fine"}')).toBeUndefined();
    expect(parseWatchdog('{"onTrack": false}')).toBeUndefined();
    expect(parseWatchdog("looks fine to me")).toBeUndefined();
    expect(parseWatchdog('{"onTrack": false, "note": "' + "x".repeat(2000) + '"}')!.length).toBe(600);
  });

  it("marks the steer as advice from the watchdog", () => {
    expect(watchdogSteer("Out of scope.", "gpt-6-luna")).toMatch(/^\[pi-chef watchdog, gpt-6-luna\] Out of scope\.\n\(Advice/);
  });
});

describe("Workflow.watchTicket", () => {
  async function setup(answer: string | (() => never), mutate?: (config: ReturnType<typeof tieredConfig>) => void) {
    const config = tieredConfig();
    mutate?.(config);
    const fake = fakeChat(() => (typeof answer === "string" ? answer : answer()));
    const { app, cwd } = await ticketWorkflow([sampleTicket("01")], { config, chat: fake.chat, auth: readyAuth() });
    writeFileSync(path.join(cwd, "work.txt"), "half done\n");
    return { app, calls: fake.calls };
  }

  it("asks the first usable cheap model with the ticket and the diff so far, never a transcript, and ledgers it", async () => {
    const { app, calls } = await setup('{"onTrack": false, "note": "The ticket asks for retries; you are rewriting the parser."}');
    const steer = await app.watchTicket("01", 12);
    expect(steer).toContain("you are rewriting the parser");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "openai", model: "gpt-6-luna" });
    expect(calls[0]!.system).toBe(WATCHDOG_SYSTEM);
    expect(calls[0]!.user).toContain("# Ticket 01");
    expect(calls[0]!.user).toContain("half done");
    expect(calls[0]!.user).toContain("12 turns so far");
    const rows = app.store.readLedger().filter((row) => row.reason.includes("watchdog ticket 01"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "openai", model: "gpt-6-luna", outcome: "success" });
  });

  it("says nothing when on track, and nothing (but ledgers a failure) when the call fails", async () => {
    expect(await (await setup('{"onTrack": true}')).app.watchTicket("01", 3)).toBeUndefined();
    const failing = await setup(() => {
      throw new Error("503");
    });
    expect(await failing.app.watchTicket("01", 3)).toBeUndefined();
    expect(failing.app.store.readLedger().filter((row) => row.reason.includes("watchdog")).map((row) => row.outcome)).toEqual(["failure"]);
  });

  it("skips models the policy excludes, and an unknown ticket", async () => {
    const { app, calls } = await setup('{"onTrack": false, "note": "x"}', (config) => void (config.orgProviderAllowlist = ["xai"]));
    expect(await app.watchTicket("01", 3)).toBeUndefined();
    expect(await app.watchTicket("99", 3)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("advisors.watchdogEvery", () => {
  const every = (user: Record<string, unknown> | undefined, project: Record<string, unknown>) => {
    const warnings: string[] = [];
    const merged = layerConfigs(user, { advisors: project }, warnings) as { advisors?: { watchdogEvery?: number } };
    return { value: merged.advisors?.watchdogEvery, warnings };
  };

  it("is off by default, and a project can turn it off or space it out but never turn it on or tighten it", () => {
    expect(tieredConfig().advisors.watchdogEvery).toBe(0);
    expect(every(undefined, { watchdogEvery: 5 }).value).toBeUndefined();
    expect(every(undefined, { watchdogEvery: 5 }).warnings[0]).toContain("cannot turn the watchdog on");
    expect(every({ advisors: { watchdogEvery: 10 } }, { watchdogEvery: 20 }).value).toBe(20);
    expect(every({ advisors: { watchdogEvery: 10 } }, { watchdogEvery: 5 }).value).toBe(10);
    expect(every({ advisors: { watchdogEvery: 10 } }, { watchdogEvery: 0 }).value).toBe(0);
  });
});
