/**
 * The Pi ticket runner: `models.<difficulty>: provider/id`. One ticket attempt is one `pi -ne -e <ticket-mode.ts>` process
 * in a herdr tab, which the person can watch and type into. pi-chef keeps everything else (routing, the ledger, checks, the
 * review gate, the commit); only where the model runs changes. The tab itself (open, send, wait, close) is `tab.ts`, shared
 * with the agent runner; this file adds how a Pi child is started and what is collected after each turn.
 *
 * - Start: `hc run` with `env PI_CHEF_TICKET=… PI_CHEF_MAX_TURNS=… PI_CHEF_STATUS=… pi …`. `hc run` has no env option, so
 *   the child's environment rides in an argv-only `env` wrapper. The session dir is `<sessions>/<ticket>-<n>` (n the next
 *   free number) and the status file `<sessions>/<ticket>-<n>.status.json` beside it: both in the main checkout's
 *   workspace, never in the worktree, or `commitAll` would stage them.
 * - `send`: sweep the earlier attempts of the ticket (a crash between a child's turn and our read loop loses nothing), send
 *   the text and wait for the turn, then collect: read the child's session files and ledger what is new (deduped by session
 *   and entry id, so every read is safe to repeat), take the last assistant text and the status file's
 *   `aborted`/`turnLimit`. A status `error` (the child could not load its providers) stops the ticket.
 * - Retries (`runBuild`'s check and review retries) call `send` again on the same tab. A tab that died mid-send, or never
 *   became ready, is a `stopped`.
 * - End: a committed ticket's tab is killed; a failed or stopped one stays open to read, and the next attempt opens a new tab.
 *
 * Never throws: any failure is a `{ stopped }`, which `runBuild` handles like the other runners'.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ChunkLimits, ChunkSession, ModelRef } from "../orchestrator/build.js";
import { lastAssistantText, readChildSession, type ChildSessionFile } from "../herdr/session-file.js";
import type { HerdrClient } from "../herdr/client.js";
import { redact } from "../redact.js";
import { messageOf, openTab, tabName, type Tab, type TabTimings } from "./tab.js";

/** What the runner needs from the workflow: a sessions root and the ledger. Kept narrow so the runner is tested without Pi. */
export interface HerdrTicketHost {
  /** `<task dir>/sessions` of the active task, or undefined when no task is open. */
  sessionsRoot(): string | undefined;
  /** Ledgers the child's new entries under ` · ticket <id>`; `model` is what the runner launched. */
  ledger(files: readonly ChildSessionFile[], ticketId: string, model: { provider: string; id: string }): void;
  /** The active task's readable name, for the tab name. */
  taskName(): string;
  /** The resume sweep over the ticket's earlier session dirs. */
  sweep(ticketId: string, model: { provider: string; id: string }): void;
  progress(text: string): void;
}

export interface PiTicketInput extends TabTimings {
  client: HerdrClient;
  host: HerdrTicketHost;
  /** The herdr space of pi-chef's own terminal (`client.self()`): the ticket's tab opens beside it. */
  space: string;
  /** The build's checkout: the child's cwd. */
  cwd: string;
  ticketId: string;
  model: ModelRef;
  /** The ticket's attempt number from the build (1 for the first); the tab and session dir use at least this. */
  attempt?: number;
  limits?: ChunkLimits;
  /** Absolute path of this install's `src/ticket-mode.ts`. */
  ticketModePath: string;
}

interface ChildStatus {
  turns?: number;
  turnLimit?: boolean;
  aborted?: boolean;
  error?: string;
}

/** A Pi child is up in seconds; a tab that is not ready after this never started it. */
const READY_TIMEOUT_MS = 2 * 60_000;

function readStatus(file: string): ChildStatus {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ChildStatus) : {};
  } catch {
    return {}; // none yet, or a half-written file: no news
  }
}

/** The next free `<ticket>-<n>` number under the sessions root. */
function nextAttempt(root: string, ticketId: string): number {
  let highest = 0;
  try {
    for (const name of readdirSync(root)) {
      const match = /^(.*)-(\d+)$/.exec(name);
      if (match && match[1] === ticketId) highest = Math.max(highest, Number(match[2]));
    }
  } catch {
    /* no sessions yet */
  }
  return highest + 1;
}

export async function runPiTicket(input: PiTicketInput, run: (session: ChunkSession) => Promise<void>): Promise<void | { stopped: string }> {
  const { host, ticketId } = input;
  const launched = { provider: input.model.provider, id: input.model.id };
  const modelLabel = `${launched.provider}/${launched.id}`;
  let tab: Tab | undefined;
  try {
    const root = host.sessionsRoot();
    if (!root) return { stopped: `Ticket ${ticketId} cannot start: there is no open task to keep the ticket's session files in. /build again.` };
    // Never below the build's own attempt number, so the tab reads like the build's table.
    const attempt = Math.max(nextAttempt(root, ticketId), input.attempt ?? 1);
    const sessionDir = path.join(root, `${ticketId}-${attempt}`);
    const statusFile = path.join(root, `${ticketId}-${attempt}.status.json`);
    mkdirSync(sessionDir, { recursive: true });
    const thinking = input.model.thinking ? `:${input.model.thinking}` : "";
    const env = [`PI_CHEF_TICKET=${ticketId}`, `PI_CHEF_STATUS=${statusFile}`, ...(input.limits?.maxTurns ? [`PI_CHEF_MAX_TURNS=${input.limits.maxTurns}`] : [])];
    const name = tabName(host.taskName(), ticketId, attempt, (input.now ?? Date.now)());
    try {
      // Pi must be up before the first send; a child that died, or never reported idle, never started the ticket.
      tab = await openTab({
        ...input,
        argv: ["env", ...env, "pi", "-ne", "-e", input.ticketModePath, "--model", `${launched.provider}/${launched.id}${thinking}`, "--session-dir", sessionDir],
        name,
        labels: { "pi-chef.ticket": ticketId },
        progress: host.progress,
        blockedNotice: `Ticket ${ticketId} is waiting for you in tab ${name}`,
        readyTimeoutMs: input.readyTimeoutMs ?? READY_TIMEOUT_MS,
      });
    } catch (error) {
      const early = readStatus(statusFile).error;
      return { stopped: `Ticket ${ticketId} cannot start: ${early ? `${redact(early)}. The tab is left open` : messageOf(error)}. /build again.` };
    }
    const opened = tab;
    host.progress(`Ticket ${ticketId} · running in herdr tab ${opened.name} (${modelLabel})`);
    const early = readStatus(statusFile).error;
    if (early) return { stopped: `Ticket ${ticketId} cannot start: ${redact(early)}. Tab ${opened.name} is left open. /build again.` };

    let swept = false;
    const session: ChunkSession = {
      async send(text) {
        if (!swept) {
          swept = true;
          host.sweep(ticketId, launched);
        }
        let failure: unknown;
        try {
          await opened.prompt(text);
        } catch (error) {
          failure = error;
        }
        // Collect. Whatever the child wrote is ledgered even when the tab died: the spend happened.
        const files = readChildSession(sessionDir);
        host.ledger(files, ticketId, launched);
        const status = readStatus(statusFile);
        if (status.error) throw new Error(`the ticket child reported: ${redact(status.error)}`);
        if (failure) throw failure;
        return { lastText: lastAssistantText(files) ?? "", aborted: status.aborted === true, ...(status.turnLimit === true ? { turnLimit: true } : {}) };
      },
      async finished(kind) {
        if (kind === "committed") {
          await opened.close();
          tab = undefined;
        } else {
          host.progress(`Ticket ${ticketId} · tab ${opened.name} is left open so you can read what the model did`);
        }
      },
    };
    await run(session);
    return undefined;
  } catch (error) {
    return { stopped: `Ticket ${ticketId} stopped: ${messageOf(error)}${tab ? ` (herdr tab ${tab.name} is left open)` : ""}. /build resumes it.` };
  }
}
