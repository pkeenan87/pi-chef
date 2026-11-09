/**
 * The agent ticket runner: `models.<difficulty>: agent:<name>[/<model>]`. One ticket attempt is one external coding agent
 * (Claude Code, Codex, ...) in a herdr tab, in the repo, which the person can watch and answer. The tab itself (open,
 * send, wait, close) is `tab.ts`, shared with the Pi runner.
 *
 * - Start: the agent's usage log is snapshotted (`agent-usage.ts`), then `hc run` opens the tab with the agent's argv
 *   (`agentCommand`) and pi-chef waits until the agent is ready.
 * - `send`: the ticket prompt (the same text a Pi ticket gets, plus the rule not to commit and where to write its summary)
 *   is typed into the tab and pi-chef waits for the turn. A `blocked` agent is waiting for the person (an approval);
 *   pi-chef keeps waiting and posts "Ticket N is waiting for you in tab <name>" once. There is no turn limit: a wall-clock
 *   timeout is the backstop.
 * - Collect, after each turn: the agent's new log entries are ledgered under the ticket (an agent with no reader gets one
 *   "not metered" row for the attempt); the checkout must still be on the build branch, else the ticket stops (nothing is
 *   reset onto a branch the person did not pick); a commit made anyway (HEAD moved on the build branch) is undone with
 *   `git reset --soft`, so the checks, the review and the commit stay pi-chef's; `lastText` is the summary file the agent
 *   was asked to write (a short summary and the acceptance-criteria checklist), else the redacted tail of its screen.
 * - Retries (a failed check, a failed review) `send` again into the same tab. A committed ticket's tab is closed; a failed
 *   or stopped one stays open to read, and the next attempt opens a new tab.
 *
 * Never throws: any failure is a `{ stopped }`, which `runBuild` handles like the Pi runner's.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { ChunkSession } from "../orchestrator/build.js";
import type { HerdrClient } from "../herdr/client.js";
import { redact } from "../redact.js";
import { createAgentMeter, meteredEntries, notMeteredEntry, type AgentLedgerEntry, type AgentMeter } from "./agent-usage.js";
import { messageOf, openTab, tabName, type Tab, type TabTimings } from "./tab.js";

/** Added to the ticket prompt an agent gets: an agent commits on its own unless told not to. */
export const AGENT_TICKET_RULE = "Do not commit, push, or switch branches; pi-chef commits when checks and review pass.";

/** What an agent is asked to leave in `file` when it finishes: pi-chef reads the criteria from it, not from the screen. */
export const summaryRule = (file: string): string => `When you finish, write a short summary of what you did, then one line per acceptance criterion ("- [x] <criterion>" met, "- [ ] <criterion>" not met), to ${file} (that file, not only your reply), then stop.`;

/** The most of the summary file that is kept. */
const SUMMARY_CHARS = 8000;

/** What the runner needs from the workflow, kept narrow so it is tested without Pi. */
export interface AgentTicketHost {
  /** The active task's readable name, for the tab name. */
  taskName(): string;
  /** `<task dir>/sessions` of the active task: the agent's summary file goes there. */
  sessionsRoot(): string | undefined;
  /** Ledgers an agent's usage under the ticket. */
  ledgerAgent(entries: readonly AgentLedgerEntry[], ticketId: string): void;
  /** The meter has read an agent log file to this byte offset (the outside-chef sweep starts there). */
  agentLogRead?(file: string, offset: number): void;
  /** HEAD of the checkout. */
  head(): Promise<string | undefined>;
  /** The checked-out branch ("HEAD" when detached). */
  branch(): Promise<string | undefined>;
  /** The branch /build made for the task, when a build is running. */
  buildBranch(): string | undefined;
  /** `git reset --soft <sha>`: moves HEAD back and keeps the changes staged. */
  resetSoft(sha: string): Promise<void>;
  progress(text: string): void;
}

export interface AgentTicketInput extends TabTimings {
  client: HerdrClient;
  host: AgentTicketHost;
  space: string;
  /** The repo: the agent's cwd, and where its usage log is found. */
  cwd: string;
  ticketId: string;
  /** The ticket's attempt number, for the tab name and the summary file. */
  attempt: number;
  agent: { name: string; model?: string };
  /** The agent's argv from `agentCommand`. */
  argv: string[];
  /** Replaces the home directory the agent's usage log is read under (tests). */
  home?: string;
}

export async function runAgentTicket(input: AgentTicketInput, run: (session: ChunkSession) => Promise<void>): Promise<void | { stopped: string }> {
  const { host, ticketId } = input;
  const label = `agent:${input.agent.name}${input.agent.model ? `/${input.agent.model}` : ""}`;
  let tab: Tab | undefined;
  try {
    // Before the tab opens, so everything the agent writes after is new.
    const meter: AgentMeter | undefined = createAgentMeter(input.agent.name, { cwd: input.cwd, home: input.home, onConsumed: host.agentLogRead });
    const name = tabName(host.taskName(), ticketId, input.attempt, (input.now ?? Date.now)());
    const root = host.sessionsRoot();
    const summaryFile = root ? path.resolve(root, `${ticketId}-${input.attempt}.summary.md`) : undefined;
    if (root) mkdirSync(root, { recursive: true });
    try {
      tab = await openTab({
        ...input,
        name,
        labels: { "pi-chef.ticket": ticketId },
        progress: host.progress,
        blockedNotice: `Ticket ${ticketId} is waiting for you in tab ${name}`,
      });
    } catch (error) {
      return { stopped: `Ticket ${ticketId} cannot start: ${messageOf(error)}. /build again.` };
    }
    const opened = tab;
    host.progress(`Ticket ${ticketId} · running in herdr tab ${opened.name} (${label})`);

    let sends = 0;
    let metered = false;
    let unmeteredLogged = false;
    // Whatever the agent logged since the last look is ledgered under the ticket. An agent with no reader (or a log that held
    // nothing so far) gets one "not metered" row for the attempt, which is not an unknown cost.
    const ledgerUsage = (): void => {
      try {
        const calls = meter?.collect() ?? [];
        if (calls.length > 0) {
          metered = true;
          host.ledgerAgent(meteredEntries(input.agent.name, calls), ticketId);
        } else if (!unmeteredLogged && !metered) {
          unmeteredLogged = true;
          if (meter) host.progress(`Ticket ${ticketId} · no usage found in ${input.agent.name}'s log; recorded as not metered`);
          host.ledgerAgent([notMeteredEntry(input.agent.name)], ticketId);
        }
      } catch {
        /* the ledger is best effort here; the next send looks again */
      }
    };
    const session: ChunkSession = {
      async send(text) {
        sends += 1;
        const before = await host.head().catch(() => undefined);
        const branchBefore = await host.branch().catch(() => undefined);
        // A summary left by an earlier turn is not this turn's.
        if (summaryFile) rmSync(summaryFile, { force: true });
        const prompt = sends === 1 ? `${text}\n\n${AGENT_TICKET_RULE}` : text;
        let failure: unknown;
        try {
          await opened.prompt(summaryFile ? `${prompt}\n${summaryRule(summaryFile)}` : prompt);
        } catch (error) {
          failure = error;
        }
        // Collect. Whatever the agent logged is ledgered even when the turn failed: the spend happened.
        ledgerUsage();
        if (failure) throw failure;
        const onBranch = host.buildBranch() ?? branchBefore;
        const branch = await host.branch().catch(() => undefined);
        if (onBranch && branch && branch !== onBranch) {
          throw new Error(`the agent left the build branch (${onBranch}) and is on ${branch}; pi-chef left HEAD alone. Run \`git switch ${onBranch}\` (move over any work you want to keep) and /build again`);
        }
        const after = await host.head().catch(() => undefined);
        if (before && after && after !== before) {
          await host.resetSoft(before);
          host.progress(`Ticket ${ticketId} · the agent committed anyway; pi-chef moved HEAD back to ${before.slice(0, 7)} (git reset --soft) and will commit when the checks and review pass`);
        }
        return { lastText: (summaryFile && readSummary(summaryFile)) || (await opened.lastText()), aborted: false };
      },
      async finished(kind) {
        if (kind === "committed") {
          await opened.close();
          tab = undefined;
        } else {
          host.progress(`Ticket ${ticketId} · tab ${opened.name} is left open so you can read what the agent did`);
        }
      },
    };

    await run(session);
    return undefined;
  } catch (error) {
    return { stopped: `Ticket ${ticketId} stopped: ${messageOf(error)}${tab ? ` (herdr tab ${tab.name} is left open)` : ""}. /build resumes it.` };
  }
}

/** The summary file the agent wrote, redacted and capped; "" when it wrote none. */
function readSummary(file: string): string {
  try {
    return redact(readFileSync(file, "utf8").trim()).slice(0, SUMMARY_CHARS);
  } catch {
    return "";
  }
}
