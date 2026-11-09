/**
 * What every herdr tab runner shares: the tab name, and `openTab`, the open / send / wait / read / close loop of a program
 * in a tab (`pi-ticket.ts` and `agent-ticket.ts` run tickets with it, `agent-review.ts` runs /review with it). Each runner
 * adds its own "collect" step after a turn (a Pi child's session files, an agent's usage log and summary file).
 *
 * herdr reports a terminal's status as `working`, `blocked` (the program waits for the person: an approval, a question),
 * `idle`, `done` (finished while nobody looked: the same as idle here), `error`, or the terminal ended. A send is
 * `hc send --wait`, which types the text and waits for the turn that send started, so an idle status read just before the
 * turn begins cannot end it early. Before a send the tab is waited for until it is no longer working or blocked (`hc send`
 * would queue text for a working tab and refuse a blocked one). One `hc` call blocks for at most a slice: a check-in that
 * finds the tab still working is followed by `hc wait`, up to the wall-clock limit. A blocked tab is waited for with one
 * progress line, the first time.
 */
import type { HerdrClient, WaitResult } from "../herdr/client.js";
import { redact } from "../redact.js";

export const READY_TIMEOUT_MS = 5 * 60_000;
/** After this long with no ready report, tell the person the tab may need them. */
export const READY_NUDGE_MS = 20_000;
/** The wall-clock limit of one turn: agents have no turn limit, so this is the backstop. */
export const TURN_TIMEOUT_MS = 4 * 60 * 60_000;
/** How much of the screen is kept as the "last text" of a turn. */
export const SCREEN_TAIL_CHARS = 2000;
const SCREEN_HISTORY_LINES = 200;

/**
 * `chef-<task name>-<ticket>-<n>-<time>`, at most 32 characters of a-z 0-9 - _ (hc's rule): the task name gives way when it
 * is long. The last part is the clock in seconds (base 36), so a tab left open by an earlier attempt never has the name.
 */
export function tabName(task: string, ticketId: string, attempt: number, at = Date.now(), prefix = "chef"): string {
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const tail = `-${clean(ticketId)}-${attempt}-${Math.floor(at / 1000).toString(36).slice(-4)}`;
  return `${prefix}-${clean(task || "task").slice(0, Math.max(1, 32 - prefix.length - 1 - tail.length))}${tail}`.slice(0, 32);
}

export const messageOf = (error: unknown): string => redact(error instanceof Error && error.message ? error.message : String(error));

/** Test seams and timings shared by the runners. */
export interface TabTimings {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long the tab may take to become ready (a blocked tab may wait for the person up to `turnTimeoutMs`). Default 5 minutes. */
  readyTimeoutMs?: number;
  /** Wall-clock limit of one turn (default 4 hours). */
  turnTimeoutMs?: number;
  /** The pause between looks at a blocked tab. */
  pollMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Why a wait did not end in a settled tab, or undefined. */
export function waitProblem(waited: WaitResult, tab: string, minutes: number): string | undefined {
  if (waited.status === "ended") return `the herdr tab ${tab} ended${waited.exitCode !== null ? ` (exit ${waited.exitCode})` : ""}`;
  if (waited.timedOut) return `the herdr tab ${tab} was still working after ${minutes} minutes`;
  if (waited.status === "error") return `the program in tab ${tab} reported an error; look at the tab`;
  return undefined;
}

export interface OpenTabInput extends TabTimings {
  client: HerdrClient;
  /** The herdr space of pi-chef's own terminal: the tab opens beside it. */
  space: string;
  cwd: string;
  /** The program's argv. */
  argv: string[];
  /** The tab's name (`tabName`). */
  name: string;
  labels?: Record<string, string>;
  /** One progress line, for example "Ticket 01 is waiting for you in tab <name>". */
  progress(text: string): void;
  /** What to say, once per wait, when the program is blocked in this tab. */
  blockedNotice: string;
  /** The PATH the program is started with. Default: pi-chef's own `PATH`. */
  path?: string;
}

/**
 * The argv with pi-chef's PATH put in front through `env`. herdr starts a tab with its server's environment, not ours, and
 * a server started by launchd (macOS) has only /usr/bin:/bin:/usr/sbin:/sbin: an agent installed by fnm, nvm, npm or
 * Homebrew would not be found ("cannot start codex"), nor the `node` its script needs. An argv that is already an `env`
 * wrapper gets the PATH as its first assignment.
 */
export function withPath(argv: string[], path: string | undefined): string[] {
  if (!path || path.includes("\n")) return argv;
  const assignment = `PATH=${path}`;
  return argv[0] === "env" ? ["env", assignment, ...argv.slice(1)] : ["env", assignment, ...argv];
}

export interface Tab {
  address: string;
  name: string;
  /** Types `text` into the tab once it is quiet and waits for the turn that starts, however long a person takes to answer a block. Throws on a dead, errored or timed-out tab. */
  prompt(text: string): Promise<void>;
  /** The tail of the tab's screen (its last output), "" when the client cannot read it. */
  lastText(): Promise<string>;
  /** Closes the tab. Never throws. */
  close(): Promise<void>;
}

/**
 * Opens a tab running `argv`, waits until the program is ready, and returns the handle. Throws (with a message that names
 * the tab) when `hc run` fails or the program never becomes ready; a tab that opened is left open then.
 */
export async function openTab(input: OpenTabInput): Promise<Tab> {
  const { client } = input;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  const turnTimeoutMs = input.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  const readyTimeoutMs = input.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const address = await client.run({ argv: withPath(input.argv, "path" in input ? input.path : process.env.PATH), cwd: input.cwd, name: input.name, labels: { "herdr.space": input.space, "herdr.tab": input.name, ...input.labels } });

  /** Follows `current` until the tab is neither working nor blocked, or `limitMs` (counted from `started`) has passed. */
  async function settle(current: WaitResult, started: number, limitMs: number): Promise<WaitResult> {
    let announced = false;
    for (;;) {
      const elapsed = now() - started;
      if (current.status === "blocked") {
        // Waiting for the person (an approval): keep waiting for as long as a turn may take.
        if (!announced) {
          announced = true;
          input.progress(input.blockedNotice);
        }
        if (elapsed >= turnTimeoutMs) return { status: "timeout", exitCode: null, timedOut: true };
        await sleep(input.pollMs ?? 3000);
      } else if (current.status !== "working") return current;
      else if (elapsed >= limitMs) return { status: "timeout", exitCode: null, timedOut: true };
      current = await client.waitIdle(address, { timeoutMs: Math.max(1000, limitMs - elapsed) });
    }
  }

  const minutes = (ms: number) => Math.round(ms / 60_000);
  const readyAt = now();
  // Verified live: an agent showing a first-run dialog (Claude Code's "trust this folder?") reports no status at all,
  // not `blocked`. So after a short look the person is told the tab needs them, and the wait stretches to a turn's length.
  // Nothing is ever typed before the program reports ready: a send into such a dialog would answer it.
  let first = await client.waitIdle(address, { timeoutMs: Math.min(READY_NUDGE_MS, readyTimeoutMs) });
  let readyLimit = readyTimeoutMs;
  if (first.timedOut && readyTimeoutMs > READY_NUDGE_MS) {
    input.progress(`${input.blockedNotice} (it has not reported ready; it may be showing a first-run prompt such as "trust this folder")`);
    readyLimit = Math.max(readyTimeoutMs, turnTimeoutMs);
    first = await client.waitIdle(address, { timeoutMs: Math.max(1000, readyLimit - (now() - readyAt)) });
  }
  const ready = await settle(first, readyAt, readyLimit);
  const notReady = waitProblem(ready, address, minutes(readyTimeoutMs));
  if (notReady) throw new Error(`${notReady} before the program was ready`);

  return {
    address,
    name: input.name,
    async prompt(text) {
      const started = now();
      // A tab that is still working (the person typed into it) or blocked is waited for first: hc queues text for a working tab.
      const quiet = await settle(await client.waitIdle(address, { timeoutMs: turnTimeoutMs }), started, turnTimeoutMs);
      const before = waitProblem(quiet, address, minutes(turnTimeoutMs));
      if (before) throw new Error(before);
      const sent = await client.send(address, text, { timeoutMs: Math.max(1000, turnTimeoutMs - (now() - started)) });
      const problem = waitProblem(await settle(sent, started, turnTimeoutMs), address, minutes(turnTimeoutMs));
      if (problem) throw new Error(problem);
    },
    async lastText() {
      try {
        return redact((await client.read(address, SCREEN_HISTORY_LINES)).trim()).slice(-SCREEN_TAIL_CHARS);
      } catch {
        return "";
      }
    },
    async close() {
      try {
        await client.kill(address);
      } catch {
        /* already gone */
      }
    },
  };
}
