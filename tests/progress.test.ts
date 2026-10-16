import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runBuild, type BuildDriver } from "../src/orchestrator/build.js";
import { ProgressIndicator, formatClock, type Indicator, type IndicatorSink, type IndicatorTimer } from "../src/orchestrator/progress.js";
import { checkRunner, fakeChat, sampleTicket, tempRepo, tieredConfig, ticketWorkflow, workflow } from "./helpers.js";

/** Records every call, and whether the line is showing. */
function fakeIndicator() {
  const events: string[] = [];
  let shown = false;
  const indicator: Indicator & { events: string[]; readonly shown: boolean } = {
    events,
    get shown() {
      return shown;
    },
    start(label) {
      shown = true;
      events.push(`start ${label}`);
    },
    stage(text) {
      events.push(`stage ${text}`);
    },
    stop() {
      shown = false;
      events.push("stop");
    },
  };
  return indicator;
}

function fakeTimer() {
  const timers = new Map<number, () => void>();
  let next = 1;
  const cleared: number[] = [];
  const timer: IndicatorTimer = {
    every(fn) {
      timers.set(next, fn);
      return next++;
    },
    clear(handle) {
      cleared.push(handle as number);
      timers.delete(handle as number);
    },
  };
  return { timer, timers, cleared, tick: () => [...timers.values()].forEach((fn) => fn()) };
}

describe("ProgressIndicator", () => {
  function setup() {
    let now = 1_000_000;
    const lines: (string | undefined)[] = [];
    const sink: IndicatorSink = { owner: "ui", render: (line) => void lines.push(line) };
    const clock = fakeTimer();
    const indicator = new ProgressIndicator(() => new Date(now), clock.timer);
    indicator.attach(sink);
    return { indicator, lines, clock, advance: (ms: number) => void (now += ms), sink };
  }

  it("draws spinner, label, stage and elapsed, and redraws on the timer from the clock", () => {
    const { indicator, lines, clock, advance } = setup();
    indicator.start("Review");
    expect(lines.at(-1)).toBe("⠋ Review · 0s");
    indicator.stage("model review part 2/3 · anthropic/claude-opus-5-5");
    advance(72_000);
    clock.tick();
    expect(lines.at(-1)).toBe("⠙ Review · model review part 2/3 · anthropic/claude-opus-5-5 · 1m12s");
    expect(clock.timers.size).toBe(1);
  });

  it("clears the timer and the line on stop, and stop is safe twice", () => {
    const { indicator, lines, clock } = setup();
    indicator.start("Review");
    indicator.stop();
    expect(lines.at(-1)).toBeUndefined();
    expect(clock.timers.size).toBe(0);
    const count = lines.length;
    indicator.stop();
    indicator.stage("late");
    clock.tick();
    expect(lines).toHaveLength(count);
  });

  it("is a no-op without a UI: no line and no timer", () => {
    const clock = fakeTimer();
    const indicator = new ProgressIndicator(() => new Date(0), clock.timer);
    indicator.start("Review");
    indicator.stage("checks");
    indicator.stop();
    expect(clock.timers.size).toBe(0);
    expect(clock.cleared).toEqual([]);
  });

  it("stops quietly when its UI is stale, and a new ctx takes over a running line", () => {
    const { indicator, lines, clock, sink } = setup();
    indicator.start("Build · ticket 01");
    const next: (string | undefined)[] = [];
    indicator.attach({ owner: "next", render: (line) => void next.push(line) });
    expect(lines.at(-1)).toBeUndefined();
    expect(next.at(-1)).toBe("⠋ Build · ticket 01 · 0s");
    // Same owner again is not a change.
    const before = next.length;
    indicator.attach({ owner: "next", render: () => undefined });
    expect(next).toHaveLength(before);
    indicator.attach({
      owner: "dead",
      render: () => {
        throw new Error("stale ctx");
      },
    });
    expect(clock.timers.size).toBe(0);
    indicator.stop();
    expect(sink.owner).toBe("ui");
  });

  it("formats the clock in whole seconds", () => {
    expect([formatClock(900), formatClock(12_400), formatClock(72_000), formatClock(3_720_000)]).toEqual(["0s", "12s", "1m12s", "1h02m"]);
  });
});

describe("/review progress stages", () => {
  const findings = JSON.stringify([{ severity: "low", category: "x", message: "m" }]);

  async function reviewing(options: { runnerCode?: number; yaml?: string; report?: () => void } = {}) {
    const cwd = await tempRepo();
    const indicator = fakeIndicator();
    const code = options.runnerCode ?? 0;
    const app = workflow(cwd, {
      config: tieredConfig(options.yaml ?? "setup:\n  - { name: install, command: npm, args: [ci] }"),
      chat: fakeChat(() => findings).chat,
      indicator,
      runner: checkRunner(async (_command, args) => (args[0] === "ci" || code === 0 ? { code: 0, stdout: "ok", stderr: "" } : { code, stdout: "", stderr: "FAIL" })),
      ...(options.report ? { report: options.report } : {}),
    });
    mkdirSync(path.join(cwd, "src"), { recursive: true });
    writeFileSync(path.join(cwd, "src", "ingest.ts"), "export const ingest = 1;\n");
    return { app, indicator };
  }

  it("walks through static scan, setup, checks and the model review, then stops", async () => {
    const { app, indicator } = await reviewing();
    const result = await app.review();
    expect(result.ok, result.text).toBe(true);
    expect(indicator.events[0]).toBe("start Review");
    expect(indicator.events.slice(1, 5)).toEqual(["stage static scan", "stage setup step 1 of 1: npm ci", "stage checks 1 of 1 running: npm test", expect.stringMatching(/^stage model review part 1\/1 · \S+\/\S+$/)]);
    expect(indicator.events.at(-1)).toBe("stop");
    expect(indicator.shown).toBe(false);
  });

  it("stops when the review fails", async () => {
    const { app, indicator } = await reviewing({ runnerCode: 1 });
    const result = await app.review();
    expect(result.ok).toBe(false);
    expect(indicator.events.filter((event) => event === "stop").length).toBeGreaterThanOrEqual(1);
    expect(indicator.events.at(-1)).toBe("stop");
  });

  it("stops when something throws", async () => {
    const { app, indicator } = await reviewing({
      report: () => {
        throw new Error("transcript closed");
      },
    });
    const result = await app.review();
    expect(result.ok).toBe(false);
    expect(result.text).toContain("transcript closed");
    expect(indicator.events.at(-1)).toBe("stop");
    expect(indicator.shown).toBe(false);
  });

  it("stops on Workflow.dispose", async () => {
    const { app, indicator } = await reviewing();
    indicator.start("Review");
    app.dispose();
    expect(indicator.events.at(-1)).toBe("stop");
  });
});

describe("/build progress", () => {
  /** A driver whose turn records whether the indicator was showing while it ran. */
  function driver(cwd: string, indicator: ReturnType<typeof fakeIndicator>, shownDuringTurns: boolean[]): BuildDriver {
    return {
      async fresh(_model, run) {
        await run({
          async send() {
            shownDuringTurns.push(indicator.shown);
            mkdirSync(path.join(cwd, "src"), { recursive: true });
            writeFileSync(path.join(cwd, "src", "ingest.ts"), `export const ingest = ${shownDuringTurns.length};\n`);
            return { lastText: "Done.\n- [x] retry works", aborted: false };
          },
        });
      },
      async finish() {},
    };
  }

  it("shows the line while checks and the commit run, and hides it during the ticket's turns", async () => {
    const indicator = fakeIndicator();
    let checkRuns = 0;
    const cwd = await tempRepo();
    // The first check run fails, so the ticket gets a second turn.
    const { app } = await ticketWorkflow([sampleTicket("01")], { indicator, runner: checkRunner(async () => (checkRuns++ === 0 ? { code: 1, stdout: "", stderr: "FAIL once" } : { code: 0, stdout: "ok", stderr: "" })) }, { cwd });
    const during: boolean[] = [];
    const result = await runBuild(() => app, driver(cwd, indicator, during));
    expect(result.ok, result.text).toBe(true);
    expect(during).toEqual([false, false]);
    expect(indicator.events).toEqual(["start Build · ticket 01", "stage checks", "stop", "start Build · ticket 01", "stage checks", "stage committing", "stop"]);
    expect(indicator.shown).toBe(false);
  });
});
