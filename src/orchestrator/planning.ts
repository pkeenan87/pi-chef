import path from "node:path";
import type { AcceptedClassification, CommandResult, PlanDocument, TaskState } from "../domain.js";
import { classifyTaskWithUsage, type ClassifierUsage, type Decider } from "../router/classify.js";
import { selectCandidate } from "../router/select.js";
import { redact } from "../redact.js";
import { budgetRemainingUsd, budgetState, recordClassifier, remember } from "./budget.js";
import { active, done, fail, guard, iso, knownZero, PUBLISHED_PHASES, requireActive, transition, type WorkflowContext } from "./context.js";
import { move } from "./machine.js";
import { acceptanceCriteria, applyOverlap, assertGraph, forNewPlan, materialChange, parseGroups, PLAN_FILE, renderPlan, renderPlanReview } from "./plan.js";
import { requestPlanChanges, SPEC_FILE } from "./interview.js";
import { announce, availability, decide, suggestAdvisor } from "./routing.js";

/** Classifies with the tier's Decisions model when one is selected and reachable, else the chat classifier, else keywords. */
export async function classify(ctx: WorkflowContext, text: string): Promise<{ classification: AcceptedClassification; usage?: ClassifierUsage }> {
  const minConfidence = ctx.config.routing.minConfidence;
  const selection = selectCandidate({
    tier: "classifier",
    taskType: "classification",
    config: ctx.config,
    table: ctx.store.readMetrics(),
    availability: await availability(ctx),
    budgetRemainingUsd: budgetRemainingUsd(ctx, ctx.store.readActive()),
    rng: ctx.rng,
    at: ctx.now(),
    api: "decisions",
    // A classifier call to a provider that is not signed in cannot succeed; the keyword fallback is cheaper than a billed failure.
    strictAvailability: true,
  });
  const candidate = selection.candidate;
  const client = candidate ? ctx.deciders[candidate.provider] : undefined;
  if (!candidate || !client) return classifyTaskWithUsage(text, { minConfidence, classifier: ctx.classifier });
  await announce(ctx, undefined, "classify", { tier: "classifier", provider: candidate.provider, model: candidate.model, selectionReason: selection.reason, considered: selection.considered });
  let threw = false;
  const decider: Decider = {
    async decide(input, questions, signal) {
      try {
        const result = await client.decide({ model: candidate.model, input, questions, signal });
        return { answers: result.answers, usage: result.usage, provider: candidate.provider, model: candidate.model };
      } catch (error) {
        threw = true;
        throw error;
      }
    },
  };
  const result = await classifyTaskWithUsage(text, { minConfidence, decider });
  // Only a model answer counts as a success, and only an error, invalid output, or refusal counts as a
  // failure. A low-confidence answer is neither: it says the request was vague, not that the model broke.
  const codes = result.classification.reason_codes;
  if (result.classification.source === "model") {
    await ctx.store.bumpMetric("classification", "classifier", true, ctx.now(), candidate);
  } else if (!codes.includes("low_confidence")) {
    await ctx.store.bumpMetric("classification", "classifier", false, ctx.now(), candidate);
  }
  // A call that threw or timed out may still have been billed: ledger it as unknown cost, never as zero.
  if (threw && !result.usage) {
    return { ...result, usage: { usage: { input: null, output: null, cacheRead: null, cacheWrite: null, requests: 1 }, provider: candidate.provider, model: candidate.model } };
  }
  return result;
}

export function blank(taskId: string, request: string, at: string): TaskState {
  return {
    taskId,
    phase: "PLANNING",
    createdAt: at,
    updatedAt: at,
    phaseEnteredAt: at,
    request,
    publishApproved: false,
    attempts: [],
  };
}

/** Moves a task back to AWAITING_PLAN_APPROVAL for a new draft; a paused task resumes through PLANNING first. */
export function backToApproval(task: TaskState, at: string, note?: string): TaskState {
  return move(task.phase === "PAUSED" ? move(task, "PLANNING", at) : task, "AWAITING_PLAN_APPROVAL", at, note);
}

/**
 * Closes a task whose pull request is published, so a new /plan can start (this replaces /complete). A merged PR closes it
 * with a chat line; an unmerged one asks first. Returns a failure when the person declines or there is no UI, else undefined.
 */
export async function closePublished(ctx: WorkflowContext, task: TaskState): Promise<CommandResult | undefined> {
  const pr = task.pullRequest;
  let merged = false;
  if (pr && ctx.github?.wasMerged) {
    try {
      merged = await ctx.github.wasMerged(pr.branch);
    } catch {
      /* cannot confirm the merge: ask the person */
    }
  }
  if (merged) {
    await transition(ctx, task.taskId, "pull request merged", "COMPLETE");
    ctx.progress?.(`Closed ${task.taskId}: PR #${pr!.number} is merged.`);
    return undefined;
  }
  const label = pr ? `PR #${pr.number}` : "its pull request";
  const allowed = await ctx.confirm("Start a new task?", `${label} for ${task.taskId} is not merged. Close that task and start a new one?`);
  if (!allowed) return fail("TASK_ACTIVE", `Task ${task.taskId} is still tracking ${label}, which is not merged. Merge it, or confirm to close the task and start a new one.`);
  await transition(ctx, task.taskId, "closed by a new plan", "COMPLETE");
  ctx.progress?.(`Closed ${task.taskId}: ${label} was not merged.`);
  return undefined;
}

export function plan(ctx: WorkflowContext, request: string): Promise<CommandResult> {
  return guard(async () => {
    const safe = redact(request);
    const at = iso(ctx);
    // Classifying costs money, so an exhausted budget stops here rather than after the charge.
    if (budgetState(ctx, ctx.store.readActive()).status === "hard") {
      return fail("BUDGET", "Task or daily budget is exhausted. /plan was not run. Run /cost for details.");
    }
    const parsed = applyOverlap(parseGroups(safe));
    assertGraph(parsed.groups);
    let current = active(ctx);
    if (current && PUBLISHED_PHASES.includes(current.phase)) {
      const blocked = await closePublished(ctx, current);
      if (blocked) return blocked;
      current = active(ctx);
    }
    const terminal = !current || current.phase === "COMPLETE" || current.phase === "FAILED" || current.phase === "IDLE";
    // Reuse the stored classification when the request text is unchanged (no second classifier charge).
    const reused = !terminal && current?.request === safe ? current.classification : undefined;
    let classification: AcceptedClassification;
    let classifierUsage: ClassifierUsage | undefined;
    if (reused) {
      classification = reused;
    } else {
      const result = await classify(ctx, safe);
      classification = result.classification;
      classifierUsage = result.usage;
    }
    const routing = await decide(ctx, classification, "plan", { taskId: current?.taskId });
    let state: TaskState;
    if (terminal) {
      const taskId = `task-${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${ctx.id()}`;
      state = await ctx.store.create(blank(taskId, safe, at));
    } else {
      state = current!;
    }
    recordClassifier(ctx, state.taskId, state.phase, classifierUsage);
    const draft: PlanDocument = {
      version: state.approvedVersion ? state.approvedVersion + 1 : state.plan?.version ?? 1,
      createdAt: at,
      summary: safe.slice(0, 400),
      risks: classification.risk === "high" ? ["Security-sensitive change. Human approval stays required."] : ["Ordinary change. Policy still gates publish."],
      acceptance: acceptanceCriteria(safe),
      estimatedUsd: routing.expectedUsd,
      groups: parsed.groups,
      overlap: parsed.overlap,
      securitySensitive: routing.requireHumanApproval,
    };
    if (state.approvedVersion && state.plan && !materialChange(state.plan, draft)) {
      return done("Approved plan is unchanged. No new version was written.");
    }
    if (state.phase === "PLANNING") {
      state = await ctx.store.update(state.taskId, "plan drafted", (task) => move({ ...task, plan: draft, classification, routing, request: safe, approvedVersion: undefined }, "AWAITING_PLAN_APPROVAL", at));
    } else if (state.phase === "AWAITING_PLAN_APPROVAL" && !state.approvedVersion) {
      state = await ctx.store.update(state.taskId, "draft replaced", (task) => ({ ...task, ...forNewPlan(task, draft), plan: draft, classification, routing, request: safe, updatedAt: at }));
    } else if (state.approvedVersion) {
      state = await ctx.store.update(state.taskId, "scope change requires re-approval", (task) =>
        backToApproval({ ...task, ...forNewPlan(task, draft), plan: draft, classification, routing, request: safe, approvedVersion: undefined, publishApproved: false }, at, "scope change"),
      );
    } else {
      state = await ctx.store.update(state.taskId, "plan drafted", (task) => backToApproval({ ...task, ...forNewPlan(task, draft), plan: draft, classification, routing, request: safe }, at));
    }
    ctx.store.writeText(state.taskId, "plan.json", JSON.stringify(draft, null, 2));
    ctx.store.writeText(state.taskId, PLAN_FILE, renderPlan(draft));
    remember(ctx, state, state.phase, routing.tier, routing.provider, routing.model, knownZero(), "success", 0, "plan");
    await announce(ctx, state.taskId, "plan", routing);
    if (draft.securitySensitive) suggestAdvisor(ctx, state.taskId, "security-sensitive plan");
    const overlap = draft.overlap.length ? ` Overlap on ${draft.overlap.join(", ")} will be serialized.` : " No file overlap.";
    return done(`Draft v${draft.version} is waiting for approval (/show-plan).${overlap} Nothing was committed.`, { taskId: state.taskId, plan: draft, routing });
  });
}

/** The plan document for a task as it is shown for review: `plan.md`, or rendered from the stored plan. */
function planMarkdown(ctx: WorkflowContext, task: TaskState): string {
  return ctx.store.readText(task.taskId, PLAN_FILE) ?? renderPlanReview(task.plan!, ctx.store.readText(task.taskId, SPEC_FILE));
}

/** Freezes the draft as plan.v{N}.approved.json and records the approved version. No dialog and no session reset. */
export async function freezeApproval(ctx: WorkflowContext, state: TaskState): Promise<TaskState> {
  const plan = state.plan!;
  const body = `${JSON.stringify(plan, null, 2)}\n`;
  ctx.store.writeOnceText(state.taskId, `plan.v${plan.version}.approved.json`, body);
  const at = iso(ctx);
  return ctx.store.update(state.taskId, "plan approved", (task) => ({ ...task, approvedVersion: task.plan?.version, updatedAt: at }));
}

/** Approves the active draft (the choice was already made on a review screen). */
export function approveDraft(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    const current = requireActive(ctx);
    if (current.phase !== "AWAITING_PLAN_APPROVAL" || !current.plan) {
      return fail("APPROVAL_REQUIRED", "There is no draft waiting for approval.");
    }
    const version = current.plan.version;
    if (current.approvedVersion === version) return done(`Plan v${version} is already approved.`);
    assertGraph(current.plan.groups);
    const state = await freezeApproval(ctx, current);
    return done(`Approved plan v${version}. Run /build.`, state);
  });
}

/** Posts the active task's plan in the chat. A draft opens the review screen, so it can be approved from here. */
export function showPlan(ctx: WorkflowContext): Promise<CommandResult> {
  return guard(async () => {
    const current = requireActive(ctx);
    if (!current.plan) return fail("NO_PLAN", "The active task has no plan yet. Run /plan <request>.");
    const markdown = planMarkdown(ctx, current);
    const version = current.plan.version;
    const approved = current.approvedVersion === version;
    const where = path.join(ctx.store.taskDir(current.taskId), PLAN_FILE);
    if (!approved && current.phase === "AWAITING_PLAN_APPROVAL" && ctx.review) {
      assertGraph(current.plan.groups);
      const revisable = !!current.plan.tickets?.length;
      const choice = await ctx.review({
        title: `Plan v${version} (draft)`,
        markdown,
        actions: [
          { value: "approve", label: `Approve plan v${version}` },
          ...(revisable ? [{ value: "revise", label: "Request changes", input: "What should change in the plan?" }] : []),
          { value: "close", label: "Close" },
        ],
      });
      if (choice?.value === "revise") return requestPlanChanges(ctx, current, choice.text ?? "");
      if (choice?.value === "approve") {
        const state = await freezeApproval(ctx, current);
        return done(`Approved plan v${version}. Run /build.`, state);
      }
      return done(`Plan v${version} is still a draft. /show-plan to approve later. File: ${where}`, { taskId: current.taskId, file: where });
    }
    if (ctx.show) ctx.show(markdown);
    const status = approved ? "approved" : current.phase === "AWAITING_PLAN_APPROVAL" ? "a draft; /show-plan in a session with a UI approves it" : current.phase.toLowerCase();
    return done(ctx.show ? `Plan v${version} (${status}) is shown above. File: ${where}` : markdown, { taskId: current.taskId, file: where });
  });
}

/** Previews the classification and route for a task without changing its state. */
export function route(ctx: WorkflowContext, task: string): Promise<CommandResult> {
  return guard(async () => {
    const { classification, usage } = await classify(ctx, redact(task));
    const current = active(ctx);
    recordClassifier(ctx, current?.taskId ?? "route", current?.phase ?? "IDLE", usage);
    const decision = await decide(ctx, classification, "preview", { taskId: current?.taskId });
    await announce(ctx, current?.taskId, "preview", decision);
    return done(JSON.stringify({ classification, decision }, null, 2), { classification, decision });
  });
}
