/**
 * "Fix all in a tab": after /review, the findings are fixed by `models.medium` in a herdr tab instead of the main session
 * (an expensive, large-context model). `models.medium` is a Pi model (`pi -ne -e ticket-mode.ts`, ledgered from the
 * child's session files) or `agent:<name>[/<model>]` (metered from the agent's log, else one "not metered" row). Either way
 * every row is ledgered as "review fix" under REVIEWING, tier "medium"; no task is needed (the rows go to the session).
 *
 * Nothing is committed here: HEAD and the branch are recorded first, and a commit made anyway is undone with
 * `git reset --soft` while the checkout is still on the same branch (the changes stay staged); on another branch HEAD is
 * left alone and the result says so. A finished fix closes the tab and answers with what the model reported; a failed one
 * leaves the tab open and answers with the reason. Never throws.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { agentCommand, modelText, type TicketModel } from "../agents.js";
import { lastAssistantText, ledgerChildSession, readChildSession, type ChildSessionFile } from "../herdr/session-file.js";
import { registryProblem } from "../providers/usable.js";
import { redact } from "../redact.js";
import { createAgentMeter, meteredEntries, notMeteredEntry } from "../runner/agent-usage.js";
import { readStatus } from "../runner/pi-ticket.js";
import { messageOf, openTab, tabName, type Tab } from "../runner/tab.js";
import { herdrSpace } from "../runner/ticket.js";
import { recordAgentUsage, SESSION_TASK_ID } from "./budget.js";
import type { WorkflowContext } from "./context.js";

export const FIX_REASON = "review fix";

/** A Pi child is up in seconds; a tab that is not ready after this never started it (as in pi-ticket.ts). */
const READY_TIMEOUT_MS = 2 * 60_000;
/** The most of the model's reply that comes back in the result. */
const REPLY_CHARS = 1500;

export interface FixInput {
  prompt: string;
  model: TicketModel;
  /** The task the rows are ledgered under (`SESSION_TASK_ID` without one). */
  taskId: string;
  /** The task's readable name for the tab name; "" without a task. */
  taskName: string;
  /** Replaces the home directory an agent's usage log is read under (tests). */
  home?: string;
}

/** What differs between a Pi child and an agent: the argv, and what is read back after a turn. */
interface Program {
  argv: string[];
  readyTimeoutMs?: number;
  /** Ledgers whatever the program spent since the last look. */
  collect(): void;
  /** What the model said last. */
  reply(tab: Tab): Promise<string>;
  /** A failure the program itself reported (a Pi child that could not load its providers). */
  failed?(): string | undefined;
}

function piProgram(ctx: WorkflowContext, model: Extract<TicketModel, { kind: "pi" }>, at: number): Program | { refused: string } {
  const problem = ctx.registry ? registryProblem(ctx.registry, model.provider, model.id) : `model ${model.id} cannot be checked: this Pi session has no model registry`;
  if (problem) return { refused: `${model.provider}/${model.id}: ${problem}. Change models.medium or sign in` };
  const sessionDir = path.join(ctx.store.root, "sessions", `review-fix-${at}`);
  const statusFile = `${sessionDir}.status.json`;
  mkdirSync(sessionDir, { recursive: true });
  const thinking = model.thinking ? `:${model.thinking}` : "";
  const launched = { provider: model.provider, id: model.id };
  let files: ChildSessionFile[] = [];
  return {
    argv: ["env", "PI_CHEF_TICKET=review-fix", `PI_CHEF_STATUS=${statusFile}`, "pi", "-ne", "-e", ctx.ticketModePath!, "--model", `${model.provider}/${model.id}${thinking}`, "--session-dir", sessionDir],
    readyTimeoutMs: ctx.herdrTimings?.readyTimeoutMs ?? READY_TIMEOUT_MS,
    collect: () => {
      files = readChildSession(sessionDir);
      ledgerChildSession(ctx, files, { model: launched, job: FIX_REASON, tier: "medium" });
    },
    reply: async (tab) => lastAssistantText(files) ?? tab.lastText(),
    failed: () => {
      const error = readStatus(statusFile).error;
      return error ? `the Pi child reported: ${redact(error)}` : undefined;
    },
  };
}

function agentProgram(ctx: WorkflowContext, model: Extract<TicketModel, { kind: "agent" }>, input: FixInput): Program {
  // Before the tab opens, so everything the agent writes after is new.
  // Advancing the task's agent-log watermark keeps the sweep from counting this tab again as "outside chef".
  const meter = createAgentMeter(model.name, { cwd: ctx.git.repoRoot, home: input.home, onConsumed: input.taskId !== SESSION_TASK_ID ? (file, offset) => ctx.store.advanceAgentLog(input.taskId, file, offset) : undefined });
  return {
    argv: agentCommand(model, ctx.config),
    collect: () => {
      const calls = meter?.collect() ?? [];
      const entries = calls.length > 0 ? meteredEntries(model.name, calls) : [notMeteredEntry(model.name)];
      recordAgentUsage(ctx, { reason: FIX_REASON, entries, taskId: input.taskId, phase: "REVIEWING", tier: "medium" });
    },
    reply: (tab) => tab.lastText(),
  };
}

/** Runs the fix in a herdr tab. Never throws: a failure is `{ ok: false }` with the reason, and the tab is left open. */
export async function runFixInTab(ctx: WorkflowContext, input: FixInput): Promise<{ ok: boolean; text: string }> {
  const { model } = input;
  const label = modelText(model);
  const progress = (line: string) => ctx.progress?.(`Review: ${line}`);
  let tab: Tab | undefined;
  try {
    const where = await herdrSpace(ctx.herdr);
    if ("problem" in where) return { ok: false, text: `Fixing in a tab needs herdr: start Pi inside herdr (${where.problem}).` };
    if (model.kind === "pi" && !ctx.ticketModePath) return { ok: false, text: `Cannot fix on ${label}: this Pi session does not know where the ticket-mode extension is.` };
    const at = ctx.now().getTime();
    const program = model.kind === "agent" ? agentProgram(ctx, model, input) : piProgram(ctx, model, at);
    if ("refused" in program) return { ok: false, text: `Cannot fix on ${program.refused}.` };
    const name = tabName(input.taskName, "fix", 1, at);
    const headBefore = await ctx.git.head().catch(() => undefined);
    const branchBefore = await ctx.git.currentBranch().catch(() => undefined);
    progress(`opening ${label} in a herdr tab to fix the findings`);
    tab = await openTab({
      ...ctx.herdrTimings,
      ...(program.readyTimeoutMs ? { readyTimeoutMs: program.readyTimeoutMs } : {}),
      client: ctx.herdr!,
      space: where.space,
      cwd: ctx.git.repoRoot,
      argv: program.argv,
      name,
      labels: { "pi-chef.review-fix": name },
      progress,
      blockedNotice: `The fix (${label}) is waiting for you in tab ${name}`,
    });
    const opened = tab;
    progress(`fixing in herdr tab ${opened.name} (${label})`);
    let failure: string | undefined;
    try {
      await opened.prompt(input.prompt);
    } catch (error) {
      failure = messageOf(error);
    }
    // Whatever the model spent is ledgered even when the turn failed: it happened.
    try {
      program.collect();
    } catch (error) {
      progress(`could not ledger the fix's usage: ${messageOf(error)}`);
    }
    const notes: string[] = [];
    const branchAfter = await ctx.git.currentBranch().catch(() => undefined);
    const headAfter = await ctx.git.head().catch(() => undefined);
    if (branchBefore && branchAfter && branchAfter !== branchBefore) {
      notes.push(`The fix left ${branchBefore} and is on ${branchAfter}; pi-chef left HEAD alone.`);
    } else if (headBefore && headAfter && headAfter !== headBefore) {
      await ctx.git.resetSoft(headBefore);
      notes.push(`The fix committed anyway; pi-chef moved HEAD back to ${headBefore.slice(0, 7)} (git reset --soft), so its changes are staged, not committed.`);
    }
    const reason = failure ?? program.failed?.();
    if (reason) return { ok: false, text: [`The fix on ${label} did not finish: ${reason} (the herdr tab ${opened.name} is left open to read).`, ...notes].join("\n") };
    const said = redact((await program.reply(opened)).trim()).slice(-REPLY_CHARS);
    await opened.close();
    tab = undefined;
    return { ok: true, text: [`Fixed in tab ${opened.name} (${label}), nothing committed.`, ...(said ? ["", said, ""] : []), ...notes, "Run /review to check."].join("\n") };
  } catch (error) {
    return { ok: false, text: `The fix on ${label} stopped: ${messageOf(error)}${tab ? ` (herdr tab ${tab.name} is left open)` : ""}.` };
  }
}
