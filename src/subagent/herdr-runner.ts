/**
 * The herdr ticket runner: `isolation.runner: herdr`. One ticket attempt is one `pi -ne -e <ticket-mode.ts>` process in a
 * herdr tab (`HerdrClient.run`), which the person can watch and type into. pi-chef keeps everything else (routing, the
 * ledger, checks, the review gate, the commit); only where the model runs changes.
 *
 * - Start: `hc run` with `env PI_CHEF_TICKET=… PI_CHEF_MAX_TURNS=… PI_CHEF_STATUS=… pi …`. `hc run` has no env option, so
 *   the child's environment rides in an argv-only `env` wrapper. The session dir is `<sessions>/<ticket>-<n>` (n the next
 *   free number) and the status file `<sessions>/<ticket>-<n>.status.json` beside it: both in the main checkout's
 *   workspace, never in the worktree, or `commitAll` would stage them.
 * - `send`: sweep the earlier attempts of the ticket (a crash between a child's turn and our read loses nothing), type the
 *   text into the idle tab, wait until Pi is idle again, then read the child's session files: ledger what is new (deduped
 *   by session and entry id, so every read is safe to repeat), the last assistant text, and the status file's
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
  activity(action: "start" | "stage" | "stop", text?: string): void;
}

export interface HerdrRunInput {
  client: HerdrClient;
  host: HerdrTicketHost;
  /** The herdr space of pi-chef's own terminal (`client.self()`): the ticket's tab opens beside it. */
  space: string;
  /** The build's checkout (the worktree): the child's cwd. */
  cwd: string;
  ticketId: string;
  model: ModelRef;
  /** `foundry/<model> → <deployment>` style label (`modelLabel`) for progress lines. `model.id` is already the id Pi knows (the deployment for Foundry). */
  modelLabel: string;
  limits?: ChunkLimits;
  /** Absolute path of this install's `src/ticket-mode.ts`. */
  ticketModePath: string;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** After Pi reports idle with no new reply yet, how often to look again (the status may lag the send). */
  settleTries?: number;
}

interface ChildStatus {
  turns?: number;
  turnLimit?: boolean;
  aborted?: boolean;
  error?: string;
}

const READY_TIMEOUT_MS = 2 * 60_000;
const TURN_TIMEOUT_MS = 4 * 60 * 60_000;

function readStatus(file: string): ChildStatus {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ChildStatus) : {};
  } catch {
    return {}; // none yet, or a half-written file: no news
  }
}

function assistantCount(files: readonly ChildSessionFile[]): number {
  let n = 0;
  for (const file of files) for (const entry of file.entries) if (entry.type === "message" && (entry.message as { role?: unknown } | undefined)?.role === "assistant") n += 1;
  return n;
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

/** `chef-<task name>-<ticket>-<n>`, at most 32 characters of a-z 0-9 - _ (hc's rule): the task name gives way when it is long. */
export function tabName(task: string, ticketId: string, attempt: number): string {
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const tail = `-${clean(ticketId)}-${attempt}`;
  return `chef-${clean(task || "task").slice(0, Math.max(1, 32 - 5 - tail.length))}${tail}`.slice(0, 32);
}

const messageOf = (error: unknown) => redact(error instanceof Error && error.message ? error.message : String(error));

export async function runInHerdr(input: HerdrRunInput, run: (session: ChunkSession) => Promise<void>): Promise<void | { stopped: string }> {
  const { client, host, ticketId } = input;
  const launched = { provider: input.model.provider, id: input.model.id };
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const label = `Build · ticket ${ticketId} · ${input.modelLabel}`;
  let tab: string | undefined;
  let activityOn = false;
  try {
    const root = host.sessionsRoot();
    if (!root) return { stopped: `Ticket ${ticketId} cannot start: there is no open task to keep the ticket's session files in. /build again.` };
    const attempt = nextAttempt(root, ticketId);
    const sessionDir = path.join(root, `${ticketId}-${attempt}`);
    const statusFile = path.join(root, `${ticketId}-${attempt}.status.json`);
    mkdirSync(sessionDir, { recursive: true });
    const thinking = input.model.thinking ? `:${input.model.thinking}` : "";
    const env = [`PI_CHEF_TICKET=${ticketId}`, `PI_CHEF_STATUS=${statusFile}`, ...(input.limits?.maxTurns ? [`PI_CHEF_MAX_TURNS=${input.limits.maxTurns}`] : [])];
    const tabId = tabName(host.taskName(), ticketId, attempt);
    tab = await client.run({
      argv: ["env", ...env, "pi", "-ne", "-e", input.ticketModePath, "--model", `${launched.provider}/${launched.id}${thinking}`, "--session-dir", sessionDir],
      cwd: input.cwd,
      name: tabId,
      labels: { "herdr.space": input.space, "herdr.tab": tabId, "pi-chef.ticket": ticketId },
    });
    const opened = tab;
    host.progress(`Ticket ${ticketId} · running in herdr tab ${opened} (${input.modelLabel})`);

    // Pi must be up before the first send; a child that died, or never reported idle, never started the ticket.
    const ready = await client.waitIdle(opened, { timeoutMs: input.readyTimeoutMs ?? READY_TIMEOUT_MS });
    const early = readStatus(statusFile).error;
    if (early) return { stopped: `Ticket ${ticketId} cannot start: ${redact(early)}. Tab ${opened} is left open. /build again.` };
    if (ready.status === "ended" || ready.timedOut) {
      return { stopped: `Ticket ${ticketId} cannot start: the herdr tab ${opened} ${ready.status === "ended" ? `ended before Pi was ready${ready.exitCode !== null ? ` (exit ${ready.exitCode})` : ""}` : "did not become ready in time"}. /build again.` };
    }

    let swept = false;
    const session: ChunkSession = {
      async send(text) {
        if (!swept) {
          swept = true;
          host.sweep(ticketId, launched);
        }
        const before = assistantCount(readChildSession(sessionDir));
        host.activity("start", label);
        activityOn = true;
        try {
          await client.send(opened, text, { ifIdle: true });
          let waited = await client.waitIdle(opened, { timeoutMs: input.turnTimeoutMs ?? TURN_TIMEOUT_MS });
          // The tab can read idle for a moment before it starts working: with no new reply yet, look again.
          for (let tries = input.settleTries ?? 5; tries > 0 && waited.status !== "ended" && !waited.timedOut && assistantCount(readChildSession(sessionDir)) === before; tries--) {
            await sleep(1000);
            waited = await client.waitIdle(opened, { timeoutMs: input.turnTimeoutMs ?? TURN_TIMEOUT_MS });
          }
          // Whatever the child wrote is ledgered even when the tab died: the spend happened.
          const files = readChildSession(sessionDir);
          host.ledger(files, ticketId, launched);
          const status = readStatus(statusFile);
          if (status.error) throw new Error(`the ticket child reported: ${redact(status.error)}`);
          if (waited.status === "ended") throw new Error(`the herdr tab ${opened} ended${waited.exitCode !== null ? ` (exit ${waited.exitCode})` : ""} during the turn`);
          if (waited.timedOut) throw new Error(`the herdr tab ${opened} was still working after ${Math.round((input.turnTimeoutMs ?? TURN_TIMEOUT_MS) / 60_000)} minutes`);
          return { lastText: lastAssistantText(files) ?? "", aborted: status.aborted === true, ...(status.turnLimit === true ? { turnLimit: true } : {}) };
        } finally {
          host.activity("stop");
          activityOn = false;
        }
      },
      async finished(kind) {
        if (kind === "committed") {
          try {
            await client.kill(opened);
          } catch {
            /* already gone */
          }
          tab = undefined;
        } else {
          host.progress(`Ticket ${ticketId} · tab ${opened} is left open so you can read what the model did`);
        }
      },
    };
    await run(session);
    return undefined;
  } catch (error) {
    return { stopped: `Ticket ${ticketId} stopped: ${messageOf(error)}${tab ? ` (herdr tab ${tab} is left open)` : ""}. /build resumes it.` };
  } finally {
    if (activityOn) {
      try {
        host.activity("stop");
      } catch {
        /* a no-op without a UI */
      }
    }
  }
}
