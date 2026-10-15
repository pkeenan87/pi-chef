import { WorkflowError, type CommandResult, type TaskState } from "../domain.js";
import { autopilotCycle, freshCursor, type AutopilotCursor, type FixResult } from "../github/autopilot.js";
import { redact } from "../redact.js";
import { budgetState, remember, warnSoft } from "./budget.js";
import { active, done, fail, guard, iso, requireActive, transition, type WorkflowContext } from "./context.js";
import { move } from "./machine.js";
import { finish } from "./publish.js";
import { announce, decide } from "./routing.js";

const TRANSIENT_KEY = "gh:transient";
const MAX_TRANSIENT_FAILURES = 8;
const MAX_TRANSIENT_BACKOFF_SECONDS = 30 * 60;

export function autopilot(ctx: WorkflowContext, arg = ""): Promise<CommandResult> {
  return guard(async () => {
    const command = arg.trim();
    const state = requireActive(ctx);
    if (command === "status") {
      return done(state.autopilot ? JSON.stringify({ phase: state.phase, ...state.autopilot }, null, 2) : "Autopilot has not been started.", state.autopilot);
    }
    if (command === "stop") {
      // Invalidate any timer or in-flight cycle first so neither can re-arm after this returns.
      ctx.poller.stop();
      await ctx.store.update(state.taskId, "autopilot stop", (task) => ({
        ...task,
        autopilot: { ...(task.autopilot ?? freshCursor(iso(ctx))), running: false, pausedReason: "Stopped by /autopilot stop." },
        updatedAt: iso(ctx),
      }));
      return done("Autopilot watcher stopped. The cursor is still on disk.");
    }
    const poller = ctx.poller;
    if (poller.polling) return fail("BUSY", "An autopilot poll is already running.");
    poller.polling = true;
    poller.cycleStop = poller.stopGen;
    poller.disarm();
    try {
      return await watch(ctx, state);
    } finally {
      poller.polling = false;
    }
  });
}

/** Merge-ready tasks are only watched for a merge, so they poll at a tenth of the normal rate. */
const MERGE_READY_POLL_FACTOR = 10;

function mergeReadyDelaySeconds(ctx: WorkflowContext): number {
  return ctx.config.autopilot.pollSeconds * MERGE_READY_POLL_FACTOR;
}

/**
 * Re-arms the timer for a task that is still being watched (after a restart or a new Pi session).
 * Returns true when a poll was scheduled.
 */
export function resumeWatcher(ctx: WorkflowContext): boolean {
  const state = active(ctx);
  const cursor = state?.autopilot;
  if (!state || !cursor) return false;
  const watching = state.phase === "AUTOPILOT" && cursor.running;
  const waitingForMerge = state.phase === "MERGE_READY" && !cursor.pausedReason;
  if (!watching && !waitingForMerge) return false;
  // An explicit resume supersedes any earlier stop recorded on this poller.
  ctx.poller.cycleStop = ctx.poller.stopGen;
  ctx.poller.arm(watching ? cursor.backoffSeconds : mergeReadyDelaySeconds(ctx));
  return true;
}

/** Timer callback: runs one cycle if the task is still being watched, and never leaves a silent dead watcher. */
export async function onPoll(ctx: WorkflowContext): Promise<void> {
  const state = active(ctx);
  if (!state?.autopilot) return;
  if (state.phase === "MERGE_READY" && !state.autopilot.pausedReason) {
    await watchForMerge(ctx, state);
    return;
  }
  if (!state.autopilot.running || state.phase !== "AUTOPILOT") return;
  const result = await autopilot(ctx);
  if (result.ok) return;
  ctx.notify(`Autopilot poll failed (${result.code ?? "ERROR"}): ${result.text}`);
  // A poll that was only blocked by another run in flight: try again later, do not pause.
  if (result.code === "BUSY") {
    ctx.poller.arm(0);
    return;
  }
  // GH_TRANSIENT re-armed itself with backoff. Anything else that left the watcher "running" with no
  // timer is paused here, with the reason persisted, instead of dying silently.
  const after = active(ctx);
  if (result.code !== "GH_TRANSIENT" && after?.autopilot?.running) {
    await pauseWatcher(ctx, after, result.text);
    ctx.notify(`Autopilot watcher for task ${after.taskId} was paused: ${result.text}`);
  }
}

/** MERGE_READY: only look for a merge (cheap), then wait again. New review activity needs a manual /autopilot. */
async function watchForMerge(ctx: WorkflowContext, state: TaskState): Promise<void> {
  const poller = ctx.poller;
  if (poller.polling) return;
  poller.polling = true;
  poller.cycleStop = poller.stopGen;
  poller.disarm();
  try {
    const branch = state.pullRequest?.branch;
    if (ctx.github && branch) {
      try {
        if (!(await ctx.github.findByBranch(branch)) && (await ctx.github.wasMerged?.(branch))) {
          await finish(ctx, state, "pull request merged");
          ctx.notify(`Pull request #${state.pullRequest!.number} was merged. Task ${state.taskId} is complete.`);
          return;
        }
      } catch (error) {
        ctx.notify(`Could not check whether the pull request was merged: ${redact((error as Error).message)}`);
      }
    }
    poller.arm(mergeReadyDelaySeconds(ctx));
  } finally {
    poller.polling = false;
  }
}

async function relation(ctx: WorkflowContext, previous: string, next: string): Promise<"fast-forward" | "force" | "unknown"> {
  if (!ctx.github) return "unknown";
  const ancestor = await ctx.github.isAncestor(previous, next);
  return ancestor ? "fast-forward" : "force";
}

async function watch(ctx: WorkflowContext, initial: TaskState): Promise<CommandResult> {
  const github = ctx.github;
  let state = initial;
  if (!state.pullRequest) return fail("NOT_READY", "Autopilot needs a published pull request.");
  const pullRequest = state.pullRequest;
  if (state.phase === "PUBLISHED") state = await transition(ctx, state.taskId, "autopilot start", "AUTOPILOT");
  if (state.phase === "PAUSED" && state.pausedFrom === "AUTOPILOT") state = await transition(ctx, state.taskId, "autopilot resume", "AUTOPILOT");
  if (state.phase !== "AUTOPILOT" && state.phase !== "MERGE_READY") {
    return fail("ILLEGAL_TRANSITION", `Cannot watch from ${state.phase}.`);
  }
  if (!github) return fail("GITHUB", "No GitHub client is configured.");
  const taskId = state.taskId;
  const exhausted = budgetState(ctx, taskId);
  if (exhausted.status === "hard") {
    await pauseWatcher(ctx, state, "Task or daily budget is exhausted.");
    return fail("BUDGET", "Task or daily budget is exhausted. The watcher was paused.");
  }
  if (exhausted.status === "soft") warnSoft(ctx, taskId);
  let pr;
  try {
    pr = await github.findByBranch(pullRequest.branch);
    if (!pr && (await github.wasMerged?.(pullRequest.branch))) {
      await finish(ctx, state, "pull request merged");
      ctx.notify(`Pull request #${pullRequest.number} was merged. Task ${taskId} is complete.`);
      return done(`Pull request #${pullRequest.number} was merged. Task complete.`);
    }
  } catch (error) {
    if (error instanceof WorkflowError && error.code === "GH_TRANSIENT") return await retryAfterTransient(ctx, state, error);
    if (error instanceof WorkflowError && error.code === "GH_TOO_LARGE") {
      await pauseWatcher(ctx, state, error.message, true);
      return fail("GH_TOO_LARGE", `${error.message} The watcher was paused.`);
    }
    throw error;
  }
  if (!pr) {
    await pauseWatcher(ctx, state, "The pull request is no longer visible.");
    return fail("GITHUB", "The pull request is no longer visible. The watcher was paused.");
  }
  const resumed = state.autopilot ?? freshCursor(iso(ctx));
  const { [TRANSIENT_KEY]: _cleared, ...attempts } = resumed.attempts ?? {};
  // A manual /autopilot (or a resume) restarts a paused watcher.
  const cursor: AutopilotCursor = { ...resumed, attempts, running: true, pausedReason: undefined };
  let lastFix: FixResult | undefined;
  const fixRoute = state.classification ? await decide(ctx, state.classification, "implement", { taskId }) : undefined;
  if (fixRoute) await announce(ctx, taskId, "autopilot", fixRoute);
  const allowedFiles = state.plan?.groups.flatMap((group) => group.files) ?? [];
  let cycle;
  try {
    const headRelation = !cursor.headSha || cursor.headSha === pr.headSha ? "same" : await relation(ctx, cursor.headSha, pr.headSha);
    cycle = await autopilotCycle({
      cursor,
      pr,
      allowedFiles,
      limits: {
        maxFixCycles: ctx.config.autopilot.maxFixCycles,
        maxSpendUsd: ctx.config.budgets.autopilotPrUsd,
        maxRuntimeMs: ctx.config.autopilot.maxRuntimeMs,
        backoffSeconds: ctx.config.autopilot.backoffSeconds,
      },
      now: ctx.now(),
      headRelation,
      fixer: ctx.fixer
        ? async (request) => {
            // Re-check the budget before every fix attempt.
            if (budgetState(ctx, taskId).status === "hard") throw new WorkflowError("BUDGET", "Task or daily budget is exhausted.");
            lastFix = await ctx.fixer!(request);
            return lastFix;
          }
        : undefined,
      apply: async (edits, message) => {
        const dir = state.integration?.path ?? ctx.git.repoRoot;
        for (const edit of edits) ctx.git.writeOwned(dir, edit.path, edit.content, allowedFiles);
        const sha = await ctx.git.commitAll(dir, message);
        await ctx.pushBranch(pullRequest.branch);
        return { sha };
      },
      charge: (usage) => {
        if (!usage) return null;
        const route = lastFix?.route ?? { tier: fixRoute?.tier ?? "unknown", provider: fixRoute?.provider ?? "unknown", model: fixRoute?.model ?? "" };
        return remember(ctx, state, state.phase, route.tier, route.provider, route.model, usage, "unknown", cursor.fixCycles, "autopilot fix").actualUsd;
      },
    });
  } catch (error) {
    // Keep the fixes already applied and the spend already charged, so the next poll does not repeat them.
    const partial = (error as { partialCursor?: AutopilotCursor }).partialCursor;
    if (partial) {
      state = await ctx.store.update(taskId, "autopilot partial progress", (task) => ({ ...task, autopilot: partial, updatedAt: iso(ctx) }));
    }
    if (error instanceof WorkflowError && error.code === "GH_TRANSIENT") return await retryAfterTransient(ctx, state, error);
    if (error instanceof WorkflowError && error.code === "BUDGET") {
      await pauseWatcher(ctx, state, error.message);
      return fail("BUDGET", `${error.message} The watcher was paused.`);
    }
    throw error;
  }
  const at = iso(ctx);
  const nextCursor: AutopilotCursor = ctx.poller.stopped ? { ...cycle.cursor, running: false, pausedReason: "Stopped by /autopilot stop." } : cycle.cursor;
  const leaveMergeReady = (task: TaskState) => (task.phase === "MERGE_READY" && cycle.action !== "merge-ready" ? move(task, "AUTOPILOT", at) : task);
  // Persist the cursor before replying so a failed reply cannot make the same fix repeat.
  let result: CommandResult;
  if (cycle.action === "merge-ready") {
    await ctx.store.update(taskId, cycle.reason, (task) => (task.phase === "MERGE_READY" ? { ...task, autopilot: nextCursor, updatedAt: at } : move({ ...task, autopilot: nextCursor }, "MERGE_READY", at)));
    ctx.notify(cycle.reason);
    // Keep a slow poll so the merge is noticed and the task finishes.
    ctx.poller.arm(mergeReadyDelaySeconds(ctx));
    result = done(cycle.reason, nextCursor);
  } else if (cycle.action === "pause" || cycle.action === "blocked") {
    const phase = cycle.action === "blocked" ? "BLOCKED" : "PAUSED";
    await ctx.store.update(taskId, cycle.reason, (task) => move({ ...leaveMergeReady(task), autopilot: nextCursor }, phase, at, cycle.reason));
    result = fail(cycle.action === "blocked" ? "BLOCKED" : "PAUSED", cycle.reason);
  } else {
    await ctx.store.update(taskId, "autopilot poll", (task) => ({ ...leaveMergeReady(task), autopilot: nextCursor, updatedAt: at }));
    if (nextCursor.running) ctx.poller.arm(nextCursor.backoffSeconds);
    result = done(cycle.reason, nextCursor);
  }
  for (const reply of cycle.replies) {
    try {
      await github.reply(reply.threadId, redact(reply.body));
    } catch (error) {
      ctx.notify(`Could not post a reply to thread ${reply.threadId}: ${redact((error as Error).message)}`);
    }
  }
  return result;
}

/** Keeps the watcher alive across a transient gh failure, with exponential backoff persisted in the cursor. */
async function retryAfterTransient(ctx: WorkflowContext, state: TaskState, error: WorkflowError): Promise<CommandResult> {
  const cursor = state.autopilot ?? freshCursor(iso(ctx));
  const count = (cursor.attempts?.[TRANSIENT_KEY] ?? 0) + 1;
  const attempts = { ...cursor.attempts, [TRANSIENT_KEY]: count };
  if (count >= MAX_TRANSIENT_FAILURES) {
    const reason = `GitHub failed ${count} times in a row: ${error.message}`;
    await ctx.store.update(state.taskId, reason, (task) => ({
      ...task,
      autopilot: { ...cursor, attempts, running: false, pausedReason: reason },
      updatedAt: iso(ctx),
    }));
    return fail("GH_TRANSIENT", `${reason} The watcher was paused.`);
  }
  const base = ctx.config.autopilot.backoffSeconds > 0 ? ctx.config.autopilot.backoffSeconds : ctx.config.autopilot.pollSeconds;
  const backoff = Math.min(MAX_TRANSIENT_BACKOFF_SECONDS, base * 2 ** Math.min(4, count - 1));
  const stopped = ctx.poller.stopped;
  await ctx.store.update(state.taskId, "autopilot transient failure", (task) => ({
    ...task,
    autopilot: { ...cursor, attempts, backoffSeconds: backoff, lastPollAt: iso(ctx), running: stopped ? false : true, pausedReason: stopped ? "Stopped by /autopilot stop." : undefined },
    updatedAt: iso(ctx),
  }));
  if (!stopped) ctx.poller.arm(backoff);
  return fail("GH_TRANSIENT", `${error.message} Will retry in ${backoff}s (failure ${count}).`);
}

/** Stops polling and records why. `movePhase` also puts the task in PAUSED. */
async function pauseWatcher(ctx: WorkflowContext, state: TaskState, reason: string, movePhase = false): Promise<void> {
  ctx.poller.disarm();
  await ctx.store.update(state.taskId, reason, (task) => {
    const cursor = { ...(task.autopilot ?? freshCursor(iso(ctx))), running: false, pausedReason: reason };
    const next = { ...task, autopilot: cursor, updatedAt: iso(ctx) };
    return movePhase && task.phase !== "PAUSED" ? move(next, "PAUSED", iso(ctx), reason) : next;
  });
}
