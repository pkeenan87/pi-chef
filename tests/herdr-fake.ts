import { SessionManager } from "@earendil-works/pi-coding-agent";
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

/** What a fake tab knows about the child it "runs", parsed from the `hc run` argv the runner built. */
export interface FakeTab {
  address: string;
  options: RunOptions;
  /** `--session-dir`, `PI_CHEF_STATUS`, `PI_CHEF_MAX_TURNS`, `--model`: read from the argv. */
  sessionDir: string;
  statusFile?: string;
  maxTurns?: string;
  model: string;
  sends: string[];
  /** Slash commands sent with `command()` (`/new`). */
  commands: string[];
  killed: boolean;
}

export interface FakeHerdrClientOptions {
  self?: SelfResult;
  /** Runs when text is sent to a tab: the "child" writes its session file, status file and working-tree change. */
  onSend?: (tab: FakeTab, text: string) => void | Promise<void>;
  /** Overrides what `waitIdle` answers; the second argument counts the tab's waits (1 is the ready wait). */
  waitIdle?: (tab: FakeTab, wait: number) => WaitResult;
  /** Runs when a tab starts, before `run` returns (a child failing at startup writes its status file here). */
  onRun?: (tab: FakeTab) => void;
  /** A reason makes `run` fail with it (hc's message for a duplicate name, say) before any tab exists. */
  failRun?: (run: RunOptions) => string | undefined;
  /** Runs when a slash command is sent (the child starts a new session). */
  onCommand?: (tab: FakeTab, text: string) => void | Promise<void>;
}

/** A fake `HerdrClient` for the runner: records tabs, sends and kills; the test's `onSend` plays the child. */
export function fakeHerdrClient(options: FakeHerdrClientOptions = {}) {
  const tabs: FakeTab[] = [];
  const idle: WaitResult = { status: "idle", exitCode: null, timedOut: false };
  const waits = new Map<string, number>();
  const argAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1] ?? "";
  const envOf = (argv: string[], key: string) => argv.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
  const find = (address: string) => {
    const tab = tabs.find((t) => t.address === address);
    if (!tab) throw new Error(`no tab ${address}`);
    return tab;
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
        commands: [],
        killed: false,
      };
      tabs.push(tab);
      options.onRun?.(tab);
      return address;
    },
    async send(terminal, text) {
      const tab = find(terminal);
      tab.sends.push(text);
      await options.onSend?.(tab, text);
    },
    async command(terminal, text) {
      const tab = find(terminal);
      tab.commands.push(text);
      await options.onCommand?.(tab, text);
    },
    async keys() {},
    async waitIdle(terminal) {
      const tab = find(terminal);
      const n = (waits.get(terminal) ?? 0) + 1;
      waits.set(terminal, n);
      return options.waitIdle?.(tab, n) ?? idle;
    },
    async interrupt() {},
    async kill(terminal) {
      find(terminal).killed = true;
    },
    async get(terminal) {
      return { address: terminal, labels: { ...find(terminal).options.labels }, raw: {} };
    },
    // Like `hc ls --label`: the live tabs carrying every asked label (rows carry no labels, as in hc's list).
    async find({ labels }) {
      return tabs.filter((t) => !t.killed && Object.entries(labels).every(([k, v]) => t.options.labels?.[k] === v)).map((t) => ({ address: t.address, labels: {}, raw: {} }));
    },
  };
  return { client, tabs };
}

/** The reviewer tab's session, as Pi's SessionManager writes it. */
const cost = (total: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total });
const assistant = (content: unknown[], input: number, output: number, total: number, model = "claude-opus-5-5", extra: Record<string, unknown> = {}) => ({
  role: "assistant" as const,
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model,
  usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: cost(total) },
  stopReason: "stop" as const,
  timestamp: Date.now(),
  ...extra,
});

/** The reviewer's session as Pi's real SessionManager writes it: a new session (what `/new` makes) with two turns. */
export function reviewerWrites(dir: string, final: string) {
  const sm = SessionManager.create("/work", dir);
  sm.appendMessage({ role: "user", content: "Review request", timestamp: Date.now() } as never);
  sm.appendMessage(assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } }], 10, 5, 0.01) as never);
  sm.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x" }], isError: false, timestamp: Date.now() } as never);
  sm.appendMessage(assistant([{ type: "text", text: final }], 20, 7, 0.02) as never);
  return sm;
}

export const VERDICT = 'I read src/a.ts and it looks fine.\n\n```json\n{"verdict":"pass","findings":[],"rationale":"criteria met"}\n```\nThat is my review.';

