/**
 * Ticket mode: the second Pi entry point. A herdr-run ticket child starts as `pi -ne -e <pi-chef>/src/ticket-mode.ts`,
 * so it has the `local` provider (registered from the config, as the main extension does), the bash rules of a ticket
 * and a turn budget, and none of pi-chef's session machinery. Registers NO commands and none of pi-chef's session hooks
 * (no ledgering: the runner reads the ledger rows from the session file); its `session_start` handlers are a warning
 * shown when the config has a problem and no status file is set, and the reset of the turn count and status on a new session.
 *
 * Environment (all optional; unset means that feature is off):
 * - PI_CHEF_MAX_TURNS: the turn budget. At the limit the model is steered once; TURN_GRACE turns later the run is aborted.
 * - PI_CHEF_STATUS: a file the extension writes `{turns, turnLimit, aborted}` to, atomically, after each assistant turn.
 *   It lives in the workspace dir, never in the checkout; this extension writes only where told.
 * - PI_CHEF_TICKET: the ticket id, for labels only.
 *
 * It imports the config loader, the provider registration and the bash rules, never `extension.ts` or `commands.ts`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { isDeniedCommand, ticketBashProblem } from "./sandbox.js";
import { registerLocalProvider } from "./providers/runtime.js";
import { redact } from "./redact.js";
import { turnBudget } from "./orchestrator/turn-budget.js";

/** What the extension writes to PI_CHEF_STATUS after each assistant turn. */
export interface TicketStatus {
  turns: number;
  turnLimit: boolean;
  aborted: boolean;
  /** Set when the providers could not be loaded or registered (redacted); carried in every later write. */
  error?: string;
}

export interface TicketModeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function writeStatus(file: string, status: Partial<TicketStatus>): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(status)}\n`, "utf8");
    renameSync(temp, file);
  } catch {
    /* the runner treats a missing or stale status file as "no news"; never throw into Pi */
  }
}

/**
 * Registers the `local` provider from the config, the same way extension.ts does, so `local/<id>` resolves in the child.
 * Never throws: Pi's own providers still work. Returns the redacted problem, if any, so the runner and the user are told.
 */
function registerProviders(pi: ExtensionAPI, cwd: string): string | undefined {
  try {
    const errors: string[] = [];
    registerLocalProvider(pi, loadConfig(cwd).local, errors);
    return errors.length > 0 ? redact(errors.join("; ")) : undefined;
  } catch (error) {
    return redact(error instanceof Error && error.message ? error.message : String(error));
  }
}

export function ticketMode(pi: ExtensionAPI, options: TicketModeOptions = {}): void {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const statusFile = env.PI_CHEF_STATUS || undefined;
  const problem = registerProviders(pi, cwd);
  // The runner reads the status file; with none, the person at the tab sees a warning at session start.
  if (problem && statusFile) writeStatus(statusFile, { error: problem });
  if (problem && !statusFile) pi.on("session_start", (_event, ctx) => void ctx.ui.notify(`pi-chef ticket mode: ${problem}`, "warning"));

  // Bash rules: always on (a ticket child has no other mode); the same rules the main session's tool_call hook applies to a ticket.
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("bash", event)) {
      const reason = ticketBashProblem(event.input.command);
      if (reason) return { block: true, reason };
    }
    if (isToolCallEventType("powershell", event) && isDeniedCommand(event.input.command)) return { block: true, reason: "Blocked destructive command." };
    return undefined;
  });
  pi.on("user_bash", (event) => {
    if (isDeniedCommand(event.command)) return { result: { output: "Blocked destructive command.", exitCode: 126, cancelled: false, truncated: false } };
    return undefined;
  });

  // Turn budget and status file.
  const limit = Number.parseInt(env.PI_CHEF_MAX_TURNS ?? "", 10);
  if (!(limit > 0) && !statusFile) return;
  let turns = 0;
  let aborted = false;
  let abortRun: (() => void) | undefined;
  const newBudget = () => (limit > 0 ? turnBudget({ maxTurns: limit }, (text) => pi.sendMessage({ customType: "chef-turn-limit", content: text, display: true }, { deliverAs: "steer" }), () => abortRun?.()) : undefined);
  let budget = newBudget();
  const publish = () => {
    if (statusFile) writeStatus(statusFile, { turns, turnLimit: budget?.stopped() ?? false, aborted, ...(problem ? { error: problem } : {}) });
  };
  // A new session starts a new count and a clean status; the
  // startup session start does the same, harmlessly. A resume or fork keeps counting nothing from the old one either.
  pi.on("session_start", () => {
    turns = 0;
    aborted = false;
    budget = newBudget();
    publish();
    return undefined;
  });
  // `aborted` describes the current run only: a retry on the same session starts clean.
  pi.on("agent_start", () => {
    aborted = false;
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string };
    if (message.role !== "assistant") return undefined;
    turns += 1;
    abortRun = () => ctx.abort();
    budget?.count();
    if (message.stopReason === "aborted" || budget?.stopped()) aborted = true;
    publish();
    return undefined;
  });
  // An interrupt during a tool produces no assistant message_end; the settled run is the final word.
  pi.on("agent_settled", (event) => {
    aborted = event.aborted || budget?.stopped() === true;
    publish();
    return undefined;
  });
}


export default function (pi: ExtensionAPI): void {
  ticketMode(pi);
}
