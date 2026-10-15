import { emptyUsage, WorkflowError, type CommandResult, type RoutingDecision, type TaskState } from "../domain.js";
import { budgetState, gateBudget, remember, warnSoft } from "./budget.js";
import { done, fail, guard, handoff, iso, IMPLEMENTABLE, requireActive, active, transition, type WorkflowContext } from "./context.js";
import { redact } from "../redact.js";
import { move } from "./machine.js";
import { announce, decide, suggestAdvisor } from "./routing.js";
import { runImplementation, type ImplementationOutcome } from "./waves.js";

/** True when an attempt at this decision would do model work rather than repeat the plan's literal edits. */
function canUseModel(ctx: WorkflowContext, decision: RoutingDecision, state: TaskState): boolean {
  if (ctx.executors[decision.tier]) return true;
  return !!ctx.chat && decision.provider !== "none" && (state.plan?.groups.some((group) => group.edits.length === 0) ?? false);
}

/** A thrown error mid-implementation must not leave the task parked in IMPLEMENTING. */
async function failImplementation(ctx: WorkflowContext, state: TaskState, decision: RoutingDecision, escalations: number, error: unknown): Promise<CommandResult> {
  const code = error instanceof WorkflowError ? error.code : "ERROR";
  const message = redact((error as Error).message || "Implementation failed.");
  const current = active(ctx) ?? state;
  remember(ctx, current, current.phase, decision.tier, decision.provider, decision.model, emptyUsage(), "failure", escalations, message);
  await ctx.store.bumpMetric(current.classification?.task_type ?? "general", decision.tier, false, ctx.now(), decision.candidate);
  if (current.phase === "IMPLEMENTING") {
    await transition(ctx, current.taskId, message, code.startsWith("AUTH") ? "BLOCKED" : "FAILED", message);
  }
  return fail(code, message);
}

export function implement(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    let state = requireActive(ctx);
    if (!state.approvedVersion || !state.plan) {
      return fail("APPROVAL_REQUIRED", "/implement refused: the plan is still a draft.");
    }
    // Every ticket runs in a git worktree branched from HEAD, so check for a repository with a commit before anything starts.
    const gitProblem = await ctx.git.preflight();
    if (gitProblem) return fail("GIT_NOT_READY", gitProblem);
    // Ticket plans carry no literal edits: only the ticket runner (child pi processes) or a configured executor can run them.
    if (state.plan.tickets && !ctx.ticketRunner && Object.keys(ctx.executors).length === 0) {
      return fail("TICKET_RUNNER_MISSING", "Ticket runner not configured: this plan's tickets have no literal edits and no executor is available to run them. The plan stays approved; nothing was applied.");
    }
    // Budget first: do not ask a person to approve work that cannot be paid for.
    const exhausted = gateBudget(ctx, state.taskId);
    if (exhausted) return exhausted;
    if (state.plan.securitySensitive) {
      const allowed = await ctx.confirm("Security-sensitive plan", "This plan touches auth, secrets, or production. Approve implementation?");
      if (!allowed) {
        if (state.phase !== "PAUSED") await transition(ctx, state.taskId, "security approval withheld", "PAUSED", "security approval withheld");
        return fail("SECURITY_PAUSE", "Implementation paused. Security-sensitive work needs a person.");
      }
    }
    // Validate the resume target before moving anything, so a refusal leaves the task untouched.
    const resumeFrom = state.phase === "PAUSED" ? state.pausedFrom : state.phase;
    if (!resumeFrom || !IMPLEMENTABLE.includes(resumeFrom)) {
      return fail("ILLEGAL_TRANSITION", `Cannot implement from ${state.phase}${state.phase === "PAUSED" && resumeFrom ? ` (paused from ${resumeFrom})` : ""}.`);
    }
    if (!state.classification) return fail("NOT_READY", "The task has no classification. Run /plan again.");
    const routing = await decide(ctx, state.classification, "implement", { taskId: state.taskId });
    // A ticket plan routes and checks sign-in per ticket (ticket-run.ts), so the task-level choice is only a label here:
    // a task-level tier with no signed-in provider must not block tickets that route to an available tier.
    const perTicket = !!(ctx.ticketRunner && state.plan.tickets);
    if (routing.blocked && !perTicket) {
      await announce(ctx, state.taskId, "implement", routing);
      if (state.phase !== "BLOCKED" && state.phase !== "PAUSED") await transition(ctx, state.taskId, routing.blocked, "BLOCKED", routing.blocked);
      return fail("NO_CANDIDATE", routing.blocked);
    }
    if (routing.circuitOpen && !perTicket) {
      if (state.phase !== "BLOCKED" && state.phase !== "PAUSED") await transition(ctx, state.taskId, "circuit open", "BLOCKED", "circuit breaker");
      return fail("CIRCUIT_OPEN", "Circuit breaker is open for this task class.");
    }
    // Resume (if paused) and start in one atomic update.
    state = await ctx.store.update(state.taskId, "start implementation", (task) => {
      let next = task;
      if (next.phase === "PAUSED") next = move(next, resumeFrom, iso(ctx));
      if (next.phase !== "IMPLEMENTING") next = move(next, "IMPLEMENTING", iso(ctx));
      return next;
    });
    let decision = routing;
    let lastError = "implementation failed";
    let stopNote = "Escalation stopped at the configured maximum.";
    let fatal = false;
    for (let escalations = 0; escalations <= ctx.config.routing.maxEscalations; escalations++) {
      const budget = budgetState(ctx, state.taskId);
      if (budget.status === "hard") {
        await transition(ctx, state.taskId, "budget exhausted", "BLOCKED", "budget exhausted");
        return fail("BUDGET", `Task or daily budget is exhausted${escalations > 0 ? " before the next attempt" : ""}. Unknown charges were not treated as zero.`);
      }
      if (budget.status === "soft") warnSoft(ctx, state.taskId);
      if (decision.provider !== "none" && !perTicket) {
        const view = await ctx.authProbe.inspect(decision.provider);
        if (view.status !== "ready") {
          await transition(ctx, state.taskId, view.detail, view.status === "expired" ? "PAUSED" : "BLOCKED", view.detail);
          return fail(view.status === "expired" ? "AUTH_EXPIRED" : view.method === "api-key" ? "API_KEY_REJECTED" : "AUTH_MISSING", view.detail);
        }
      }
      if (!perTicket) await announce(ctx, state.taskId, "implement", decision);
      let outcome: ImplementationOutcome;
      try {
        outcome = await runImplementation(ctx, state, decision);
      } catch (error) {
        return await failImplementation(ctx, state, decision, escalations, error);
      }
      state = requireActive(ctx);
      // Ticket runs ledger each attempt and bump metrics per ticket with the model that actually ran.
      if (!outcome.ledgered) {
        remember(ctx, state, state.phase, decision.tier, decision.provider, decision.model, outcome.usage, outcome.ok ? "success" : "failure", escalations, outcome.ok ? "implement" : outcome.error);
        await ctx.store.bumpMetric(state.classification?.task_type ?? "general", decision.tier, outcome.ok, ctx.now(), decision.candidate);
      }
      if (outcome.ok) {
        const note = await handoff(ctx, state, "post-implementation", outcome.handoff);
        await ctx.store.update(state.taskId, "implementation handoff", (task) => ({ ...task, contextResets: [...task.contextResets, note], routing: decision, updatedAt: iso(ctx) }));
        const latest = requireActive(ctx);
        const warned = outcome.warnings?.length ? `\nWarnings:\n${outcome.warnings.map((item) => `- ${item}`).join("\n")}` : "";
        return done(`${outcome.summary} Context reset: ${note.mode}.${warned}`, { worktrees: latest.worktrees, integration: latest.integration, warnings: outcome.warnings });
      }
      lastError = outcome.error;
      if (outcome.budget) {
        await transition(ctx, state.taskId, "budget exhausted", "BLOCKED", "budget exhausted");
        return fail("BUDGET", `Task or daily budget is exhausted; no further tickets were started. Finished tickets stay done and /implement resumes the rest. ${outcome.error}`);
      }
      if (outcome.blocked) {
        await transition(ctx, state.taskId, outcome.error, "BLOCKED", outcome.error);
        suggestAdvisor(ctx, state.taskId, "ticket escalation exhausted");
        return fail("BLOCKED", `${outcome.error} Tickets that finished stay done; fix the failure and run /implement again.`);
      }
      if (outcome.fatal) {
        stopNote = "Retrying at a higher tier would not help.";
        fatal = true;
        break;
      }
      const next = await decide(ctx, state.classification!, "implement", { failedTier: decision.tier, escalations: escalations + 1, taskId: state.taskId });
      if (next.blocked) {
        // An exhausted budget is reported by the check at the top of the loop, not as a missing model.
        if (budgetState(ctx, state.taskId).status === "hard") continue;
        stopNote = next.blocked;
        break;
      }
      if (next.tier === decision.tier || escalations === ctx.config.routing.maxEscalations) break;
      if (!canUseModel(ctx, next, state) && !canUseModel(ctx, decision, state)) {
        stopNote = `Escalation to ${next.tier} would repeat identical deterministic work (the plan's literal edits), so it was not attempted.`;
        break;
      }
      decision = next;
    }
    await transition(ctx, state.taskId, lastError, "FAILED", lastError);
    if (!fatal) suggestAdvisor(ctx, state.taskId, "escalation exhausted");
    return fail("FAILED", `${lastError} ${stopNote}`);
  });
}
