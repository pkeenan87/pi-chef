import { HerdrError, type ExecResult, type HerdrClient, type HerdrExec, type RunOptions, type SelfResult, type WaitResult } from "../src/herdr/client.js";

export interface FakeCall {
  file: string;
  args: string[];
  timeoutMs?: number;
}

export type FakeReply = ExecResult | ((call: FakeCall) => ExecResult);

/** A fake `hc`: replies are consumed in order per subcommand (the last one repeats); every call is recorded. */
export function fakeHerdr(replies: Record<string, FakeReply[]> = {}): { exec: HerdrExec; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const index: Record<string, number> = {};
  const exec: HerdrExec = async (file, args, options) => {
    const call = { file, args, timeoutMs: options.timeoutMs };
    calls.push(call);
    const list = replies[args[0]] ?? [];
    const i = Math.min(index[args[0]] ?? 0, list.length - 1);
    index[args[0]] = (index[args[0]] ?? 0) + 1;
    const reply = list[i] ?? ok({});
    return typeof reply === "function" ? reply(call) : reply;
  };
  return { exec, calls };
}

export const ok = (json: unknown): ExecResult => ({ stdout: JSON.stringify(json), stderr: "", code: 0 });
export const fail = (message: string, stderr = ""): ExecResult => ({ stdout: JSON.stringify({ error: { kind: "x", message } }), stderr, code: 1 });

/** What a fake tab knows about the program it "runs", parsed from the `hc run` argv the runner built. */
export interface FakeTab {
  address: string;
  options: RunOptions;
  /** `--session-dir`, `PI_CHEF_STATUS`, `PI_CHEF_MAX_TURNS`, `--model`: read from the argv. */
  sessionDir: string;
  statusFile?: string;
  maxTurns?: string;
  model: string;
  sends: string[];
  killed: boolean;
  /** What herdr shows for the tab: `idle` when it is ready, `done` after a finished turn (nobody looked yet), `working`, `blocked`... */
  status: string;
  /** Turns started so far. */
  turn: number;
  /** The calls the runner made, in order: `wait` (hc wait) and `send` (hc send --wait). */
  events: string[];
}

export interface FakeHerdrClientOptions {
  self?: SelfResult;
  /** Runs when text is sent to a tab: the program "does the turn" here (writes its session file, status file, working-tree change). */
  onSend?: (tab: FakeTab, text: string) => void | Promise<void>;
  /**
   * What the tab shows from the moment a send starts a turn: the first status is what `hc send --wait` answers (`working` is
   * its check-in), each later one is the next `hc wait` answer; the last stays. Default: `["done"]`. An object sets the exit code of `ended`.
   */
  turn?: (tab: FakeTab, send: number) => Array<string | { status: string; exitCode?: number }>;
  /** Runs when a tab starts, before `run` returns (a child failing at startup writes its status file here). */
  onRun?: (tab: FakeTab) => void;
  /** What a tab's first `hc wait` (its ready wait) answers, `idle` by default. */
  ready?: (tab: FakeTab) => WaitResult;
  /** A reason makes `run` fail with it (hc's message for a duplicate name, say) before any tab exists. */
  failRun?: (run: RunOptions) => string | undefined;
  /** What `read` answers for a tab (the agent's screen). */
  read?: (tab: FakeTab) => string;
}

/**
 * A fake `HerdrClient`: records tabs, sends and kills; the test's `onSend` plays the program. Models hc: a send refuses a
 * `blocked` tab (nothing is typed), `--wait` answers for the turn the send started, and a finished turn leaves the tab `done`.
 */
export function fakeHerdrClient(options: FakeHerdrClientOptions = {}) {
  const tabs: FakeTab[] = [];
  const queued = new Map<string, WaitResult[]>();
  const argAfter = (argv: string[], flag: string) => (argv.includes(flag) ? (argv[argv.indexOf(flag) + 1] ?? "") : "");
  const envOf = (argv: string[], key: string) => argv.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
  const find = (address: string) => {
    const tab = tabs.find((t) => t.address === address);
    if (!tab) throw new Error(`no tab ${address}`);
    return tab;
  };
  const result = (tab: FakeTab, item: string | { status: string; exitCode?: number }): WaitResult => {
    const { status, exitCode } = typeof item === "string" ? { status: item, exitCode: undefined } : item;
    return { status, exitCode: exitCode ?? (status === "ended" ? 1 : null), turn: tab.turn, timedOut: false };
  };
  const client: HerdrClient = {
    async self() {
      return options.self ?? { terminal: "t0", space: "sp1" };
    },
    async run(run) {
      const refused = options.failRun?.(run);
      if (refused) throw new HerdrError(`run --bg failed: ${refused}`, "hc run");
      const address = `t${tabs.length + 1}`;
      const tab: FakeTab = {
        address,
        options: run,
        sessionDir: argAfter(run.argv, "--session-dir"),
        statusFile: envOf(run.argv, "PI_CHEF_STATUS"),
        maxTurns: envOf(run.argv, "PI_CHEF_MAX_TURNS"),
        model: argAfter(run.argv, "--model"),
        sends: [],
        killed: false,
        status: "idle",
        turn: 0,
        events: [],
      };
      tabs.push(tab);
      options.onRun?.(tab);
      return address;
    },
    async send(terminal, text) {
      const tab = find(terminal);
      tab.events.push("send");
      if (tab.status === "blocked") throw new HerdrError("send failed: the terminal is blocked; nothing was typed", "hc send", "", "status_mismatch");
      tab.sends.push(text);
      await options.onSend?.(tab, text);
      tab.turn += 1;
      const [first, ...rest] = options.turn?.(tab, tab.sends.length) ?? ["done"];
      queued.set(terminal, rest.map((item) => result(tab, item)));
      const answer = result(tab, first ?? "done");
      tab.status = answer.status;
      return answer;
    },
    async waitIdle(terminal) {
      const tab = find(terminal);
      tab.events.push("wait");
      const next = queued.get(terminal)?.shift();
      if (next) {
        tab.status = next.status;
        return next;
      }
      if (tab.events.filter((event) => event === "wait").length === 1 && tab.sends.length === 0 && options.ready) return options.ready(tab);
      return { status: tab.status, exitCode: null, turn: tab.turn, timedOut: false };
    },
    async read(terminal) {
      return options.read?.(find(terminal)) ?? "";
    },
    async kill(terminal) {
      find(terminal).killed = true;
    },
  };
  return { client, tabs };
}
