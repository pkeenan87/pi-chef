import { localDifficultiesFor, localProfile } from "../config.js";
import { isDifficulty, WorkflowError, type AcceptedClassification, type CommandResult, type Complexity, type TaskState } from "../domain.js";
import { redact, redactUnknown } from "../redact.js";
import { classifyKeywords, isSecuritySensitive, plannerClassification, type PlannerRating } from "../router/classify.js";
import { budgetState } from "./budget.js";
import { active, done, fail, guard, iso, type WorkflowContext } from "./context.js";
import { move } from "./machine.js";
import { announceParked, newTask, retireCurrent } from "./planning.js";
import { INTERVIEW_RULES, LOCAL_PLAN_NOTE, type LocalPlanTarget, LOCAL_TICKET_RULES, MAX_INTERVIEW_QUESTIONS, NO_QUESTIONS_RULES, REVISION_RULES, TICKET_RULES } from "./prompts.js";
import { renderTicketsMarkdown } from "./tickets.js";
import { activeTask, displayName } from "./tasks.js";

export interface InterviewOption {
  value: string;
  label: string;
  description?: string;
}

export interface InterviewQuestion {
  id: string;
  title: string;
  prompt: string;
  options: InterviewOption[];
  recommended: string;
  reason: string;
  dependsOn?: string[];
}

export interface InterviewAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  acceptedRecommendation: boolean;
}

export interface InterviewRound {
  round: number;
  at: string;
  questions: InterviewQuestion[];
  answers: InterviewAnswer[];
  /** True when no UI was available and the recommendations were recorded as the answers. */
  headless: boolean;
}

/** `interview.json` in the task folder: everything needed to resume an interview after a restart. */
export interface InterviewFile {
  version: 1;
  request: string;
  noQuestions: boolean;
  rounds: InterviewRound[];
  /** A round that was shown but not answered yet. Only one may be pending; a new round is refused until it is answered. */
  pending?: { round: number; questions: InterviewQuestion[] };
}

/** A technical implementation plan, in the shape of an engineer's plan mode: what changes where, and how it is verified. */
export interface PlanSpec {
  summary: string;
  /** What the code does today in the area that changes, with the files and functions read. */
  context: string;
  /** The technical design: components, data flow, types and signatures, error handling. */
  approach: string;
  /** One entry per file to create, modify, or delete, with the concrete change. */
  changes: { path: string; change: string }[];
  /** Existing functions, types, and utilities to reuse, with their paths. */
  reuse: string[];
  decisions: { question: string; answer: string; rationale: string }[];
  assumptions: string[];
  outOfScope: string[];
  risks: string[];
  /** How to prove it works end to end: tests to add and commands to run. */
  verification: string[];
}

export const INTERVIEW_FILE = "interview.json";
export const SPEC_FILE = "spec.md";

export function readInterview(ctx: WorkflowContext, taskId: string): InterviewFile | undefined {
  const text = ctx.store.readText(taskId, INTERVIEW_FILE);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as InterviewFile;
    return parsed && Array.isArray(parsed.rounds) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeInterview(ctx: WorkflowContext, taskId: string, file: InterviewFile): void {
  ctx.store.writeText(taskId, INTERVIEW_FILE, `${JSON.stringify(redactUnknown(file), null, 2)}\n`);
}

export function questionsAsked(file: InterviewFile): number {
  return file.rounds.reduce((sum, round) => sum + round.questions.length, 0);
}

/** The task whose /plan interview or ticket stage is running now, with its interview file. */
export function activePlanning(ctx: WorkflowContext): { task: TaskState; interview: InterviewFile } | undefined {
  const task = active(ctx);
  if (!task?.planning || task.phase !== "PLANNING") return undefined;
  const interview = readInterview(ctx, task.taskId);
  return interview ? { task, interview } : undefined;
}

export function planningStatusText(ctx: WorkflowContext): string | undefined {
  const found = activePlanning(ctx);
  if (!found) return undefined;
  const { task, interview } = found;
  if (task.planning!.stage === "tickets") return "plan · writing tickets";
  if (task.planning!.revision) return "plan · revising";
  if (interview.noQuestions) return "plan · writing spec (no questions)";
  const round = interview.pending?.round ?? interview.rounds.length + 1;
  return `plan · interview round ${round} (${questionsAsked(interview)}/${MAX_INTERVIEW_QUESTIONS} questions)`;
}

function showStatus(ctx: WorkflowContext): void {
  ctx.planStatus?.(planningStatusText(ctx));
}

/** Steps a task back to PLANNING from wherever it is, one legal edge at a time. */
function toPlanning(task: TaskState, at: string): TaskState {
  if (task.phase === "PLANNING") return task;
  const direct = ["PAUSED", "AWAITING_PLAN_APPROVAL", "FAILED", "BLOCKED", "COMPLETE", "IDLE"];
  return move(direct.includes(task.phase) ? task : move(task, "AWAITING_PLAN_APPROVAL", at), "PLANNING", at);
}

function resumeMessage(request: string): string {
  return `Resume planning: ${request}`;
}

/** `/plan` entry point. Starts (or resumes) the model-run interview in the session. */
export function startPlan(ctx: WorkflowContext, request: string, options: { noQuestions?: boolean; local?: boolean } = {}): Promise<CommandResult> {
  return guard(async () => {
    const current = await activeTask(ctx);
    const text = request.trim();
    if (!text && !current?.planning) return fail("USAGE", "Usage: /plan [--no-questions] [--local | --cloud] <request>");
    if (!ctx.startTurn) return fail("NO_SESSION", "Planning needs a Pi session to run the interview.");
    const safe = redact(text);
    const noQuestions = options.noQuestions ?? false;
    const at = iso(ctx);
    // Resume: no request, or the same request again, and an interview already on disk. A different request is a new task.
    if (current?.planning && (!text || current.request === safe)) {
      const interview = readInterview(ctx, current.taskId);
      if (interview) {
        await ctx.store.update(current.taskId, "plan resumed", (task) => toPlanning(task, at));
        showStatus(ctx);
        ctx.startTurn(resumeMessage(current.request));
        return done(`Resuming the plan for ${displayName(current)}. ${planningStatusText(ctx) ?? ""}`.trim(), { taskId: current.taskId, resumed: true });
      }
    }
    if (budgetState(ctx).status === "hard") {
      return fail("BUDGET", "Task or daily budget is exhausted. /plan was not run. Run /cost for details.");
    }
    // A request always starts a new task. A finished task is closed; any other is parked untouched (/plans switches back).
    const parked = await retireCurrent(ctx, current);
    // Until plan_spec saves the planner's rating, the task has the keyword classification.
    const classification: AcceptedClassification = classifyKeywords(safe);
    // Local mode: --local or --cloud, else localMode.default. Fixed for the task once planning starts, with the
    // difficulties the local model takes (localMode.difficulties, capped by its size; unset: every ticket).
    const wanted = options.local ?? ctx.config.localMode.default;
    const only = wanted ? localDifficultiesFor(ctx.config) : undefined;
    // localMode.difficulties that the model's size rules out entirely (medium for a 9B model): a cloud plan.
    const localMode = wanted && only?.length !== 0;
    const scope = localMode ? { localMode: true, ...(only ? { localDifficulties: only } : {}) } : {};
    const state = await ctx.store.create({ ...newTask(ctx, safe, at), classification, planning: { stage: "interview", noQuestions }, ...scope });
    announceParked(ctx, parked);
    writeInterview(ctx, state.taskId, { version: 1, request: safe, noQuestions, rounds: [] });
    showStatus(ctx);
    const mode = !localMode ? "" : only ? ` (local mode: ${only.join("/")} tickets go to the local model, the rest to the cloud)` : " (local mode: every ticket goes to the local model)";
    ctx.startTurn(`Plan this request${noQuestions ? " (no questions)" : ""}${mode}:\n\n${safe}`);
    const profile = localMode ? localProfile(ctx.config) : undefined;
    // Say which model and size the tickets are written for, so a wrong tiers.local is caught before planning.
    const where = !profile
      ? wanted
        ? ` Local mode is off for this plan: the ${localProfile(ctx.config).label} in tiers.local takes no ${ctx.config.localMode.difficulties!.join("/")} tickets.`
        : ""
      : only
        ? ` Local mode: ${only.join("/")} tickets will be written for a ${profile.label} (${profile.model}) and built there; the rest go to the cloud ticket tiers.`
        : ` Local mode: tickets will be written for a ${profile.label} (${profile.model}) and built only there.`;
    return done(
      `${noQuestions ? `Planning ${displayName(state)} without an interview. The model will write the spec and tickets.` : `Interview started for ${displayName(state)}. ${planningStatusText(ctx)}`}${where}`,
      { taskId: state.taskId },
    );
  });
}

function planningOrThrow(ctx: WorkflowContext, stage: "interview" | "tickets"): { task: TaskState; interview: InterviewFile } {
  const found = activePlanning(ctx);
  if (!found) throw new WorkflowError("NO_INTERVIEW", "No /plan is running. Start one with /plan <request>.");
  if (found.task.planning!.stage !== stage) {
    throw new WorkflowError("WRONG_STAGE", stage === "interview" ? "The interview is over: the spec is saved. Call plan_consult, then plan_tickets." : "Write the spec first with plan_spec, then call plan_tickets.");
  }
  return found;
}

/** Rounds shown in this process and not yet answered, per workflow context. Disk `pending` alone cannot tell a live round from one left by a restart. */
const inFlight = new WeakMap<WorkflowContext, Set<string>>();

function inFlightFor(ctx: WorkflowContext): Set<string> {
  let set = inFlight.get(ctx);
  if (!set) inFlight.set(ctx, (set = new Set()));
  return set;
}

/** Releases the in-process pending marker (the user dismissed the round or the tool failed). The pending record stays on disk for a re-ask. */
export function abandonRound(ctx: WorkflowContext): void {
  const taskId = ctx.store.readActive();
  if (taskId) inFlightFor(ctx).delete(taskId);
}

/** Validates a round of questions against the cap, ordering, and shape rules, then records it as pending. */
export async function beginRound(ctx: WorkflowContext, input: { round: number; questions: InterviewQuestion[] }): Promise<{ round: number; asked: number; remaining: number }> {
  const { task, interview } = planningOrThrow(ctx, "interview");
  if (interview.noQuestions) throw new WorkflowError("NO_QUESTIONS", "The user chose --no-questions. Do not ask; call plan_spec and record assumptions instead.");
  if (task.planning!.revision) throw new WorkflowError("NO_QUESTIONS", "This is a revision of a drafted plan. Do not ask; apply the requested changes and call plan_spec.");
  const asked = questionsAsked(interview);
  const round = interview.rounds.length + 1;
  const { questions } = input;
  const pending = interview.pending;
  if (pending) {
    if (inFlightFor(ctx).has(task.taskId)) {
      throw new WorkflowError("ROUND_PENDING", `Round ${pending.round} is still waiting for the user's answers. Ask one round at a time; wait for this result.`);
    }
    // Left by a restart: only the same round may be asked again, and it replaces the stale pending one.
    if (input.round !== pending.round) throw new WorkflowError("ROUND_PENDING", `Round ${pending.round} was shown but not answered. Ask round ${pending.round} again, or call plan_spec.`);
  }
  if (!Array.isArray(questions) || questions.length === 0) throw new WorkflowError("QUESTIONS_INVALID", "A round needs at least one question.");
  if (asked + questions.length > MAX_INTERVIEW_QUESTIONS) {
    throw new WorkflowError(
      "QUESTION_CAP",
      `Asking ${questions.length} more would exceed the ${MAX_INTERVIEW_QUESTIONS}-question cap (${asked} already asked). ${asked >= MAX_INTERVIEW_QUESTIONS ? "" : `At most ${MAX_INTERVIEW_QUESTIONS - asked} more are allowed. `}Finalize now: call plan_spec and record any open decision as an assumption.`,
    );
  }
  if (input.round !== round) throw new WorkflowError("QUESTIONS_INVALID", `This is round ${round}, not ${input.round}.`);
  const answered = new Set(interview.rounds.flatMap((item) => item.answers.map((answer) => answer.id)));
  const inRound = new Set(questions.map((question) => question.id));
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const question of questions) {
    const where = `Question ${question.id || "(no id)"}`;
    if (!question.id) errors.push("Every question needs an id.");
    else if (seen.has(question.id) || answered.has(question.id)) errors.push(`${where}: id already used.`);
    seen.add(question.id);
    if (!question.title?.trim() || !question.prompt?.trim()) errors.push(`${where}: title and prompt are required.`);
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) errors.push(`${where}: needs 2 to 4 options.`);
    else {
      const values = question.options.map((option) => option.value);
      if (new Set(values).size !== values.length || question.options.some((option) => !option.value || !option.label)) errors.push(`${where}: option values must be unique, and each needs a value and label.`);
      if (!values.includes(question.recommended)) errors.push(`${where}: recommended must be one of the option values.`);
    }
    if (!question.reason?.trim()) errors.push(`${where}: a one-line reason for the recommendation is required.`);
    for (const dep of question.dependsOn ?? []) {
      if (inRound.has(dep)) errors.push(`${where}: depends on ${dep}, which is in the same round. Ask ${dep} first and ${question.id} in the next round.`);
      else if (!answered.has(dep)) errors.push(`${where}: depends on ${dep}, which has not been answered. Ask it in an earlier round.`);
    }
  }
  if (errors.length) throw new WorkflowError("QUESTIONS_INVALID", errors.join("\n"));
  writeInterview(ctx, task.taskId, { ...interview, pending: { round, questions } });
  inFlightFor(ctx).add(task.taskId);
  showStatus(ctx);
  return { round, asked, remaining: MAX_INTERVIEW_QUESTIONS - asked - questions.length };
}

/** Persists a finished round, logs one `decision` event per answer, and clears the pending marker. */
export async function recordAnswers(ctx: WorkflowContext, round: number, questions: InterviewQuestion[], answers: InterviewAnswer[], headless: boolean): Promise<{ asked: number; remaining: number }> {
  const { task, interview } = planningOrThrow(ctx, "interview");
  if (round !== interview.rounds.length + 1 || interview.pending?.round !== round) {
    throw new WorkflowError("QUESTIONS_INVALID", `Round ${round} is not the pending round (${interview.pending ? `round ${interview.pending.round}` : "none pending"}).`);
  }
  const already = questionsAsked(interview);
  if (already + questions.length > MAX_INTERVIEW_QUESTIONS) {
    throw new WorkflowError("QUESTION_CAP", `Recording ${questions.length} questions would exceed the ${MAX_INTERVIEW_QUESTIONS}-question cap (${already} already asked).`);
  }
  inFlightFor(ctx).delete(task.taskId);
  const at = iso(ctx);
  const clean = redactUnknown(answers) as InterviewAnswer[];
  const next: InterviewFile = { ...interview, rounds: [...interview.rounds, { round, at, questions, answers: clean, headless }], pending: undefined };
  writeInterview(ctx, task.taskId, next);
  for (const answer of clean) {
    const question = questions.find((item) => item.id === answer.id);
    await ctx.store.appendDecision(task.taskId, { round, questionId: answer.id, title: question?.title ?? answer.id, value: answer.value, label: answer.label, wasCustom: answer.wasCustom, acceptedRecommendation: answer.acceptedRecommendation }, at);
  }
  showStatus(ctx);
  const asked = questionsAsked(next);
  return { asked, remaining: MAX_INTERVIEW_QUESTIONS - asked };
}

export function renderSpec(spec: PlanSpec): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`) : ["- (none)"]);
  return [
    "# Spec",
    "",
    spec.summary,
    "",
    "## Context",
    "",
    spec.context || "(not recorded)",
    "",
    "## Approach",
    "",
    spec.approach,
    "",
    "## Files to change",
    "",
    ...(spec.changes.length ? spec.changes.map((item) => `- \`${item.path}\`: ${item.change}`) : ["- (none)"]),
    "",
    "## Reuse",
    ...list(spec.reuse),
    "",
    "## Decisions",
    ...(spec.decisions.length ? spec.decisions.flatMap((item) => ["", `### ${item.question}`, `Answer: ${item.answer}`, `Why: ${item.rationale}`]) : ["", "- (none)"]),
    "",
    "## Assumptions",
    ...list(spec.assumptions),
    "",
    "## Out of scope",
    ...list(spec.outOfScope),
    "",
    "## Risks",
    ...list(spec.risks),
    "",
    "## Verification",
    ...list(spec.verification),
    "",
  ].join("\n");
}

function texts(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${field} must be an array of strings.`);
    return [];
  }
  return value.map((item: string) => item.trim()).filter(Boolean);
}

/** Saves `spec.md` and moves planning on to the ticket stage. */
export async function savePlanSpec(ctx: WorkflowContext, input: unknown): Promise<{ file: string; classification: AcceptedClassification; keywordRaised: boolean }> {
  // Also allowed at the ticket stage, so a change the person asks for during ticket review can reach the spec.
  const found = activePlanning(ctx);
  const { task } = found?.task.planning?.stage === "tickets" ? found : planningOrThrow(ctx, "interview");
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) errors.push("summary is required.");
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions.map((item) => {
        const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return { question: String(entry.question ?? "").trim(), answer: String(entry.answer ?? "").trim(), rationale: String(entry.rationale ?? "").trim() };
      })
    : [];
  if (raw.decisions !== undefined && !Array.isArray(raw.decisions)) errors.push("decisions must be an array.");
  if (decisions.some((item) => !item.question || !item.answer)) errors.push("Every decision needs a question and an answer.");
  const context = typeof raw.context === "string" ? raw.context.trim() : "";
  const approach = typeof raw.approach === "string" ? raw.approach.trim() : "";
  if (!approach) errors.push("approach is required: the technical design (components, data flow, types and signatures).");
  const changes = Array.isArray(raw.changes)
    ? raw.changes.map((item) => {
        const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return { path: String(entry.path ?? "").trim(), change: String(entry.change ?? "").trim() };
      })
    : [];
  if (raw.changes !== undefined && !Array.isArray(raw.changes)) errors.push("changes must be an array.");
  else if (changes.length === 0) errors.push("changes needs at least one file: { path, change } naming what is added or modified there.");
  if (changes.some((item) => !item.path || !item.change)) errors.push("Every change needs a path and a description of the change.");
  const verification = texts(raw.verification, "verification", errors);
  if (verification.length === 0 && (raw.verification === undefined || Array.isArray(raw.verification))) errors.push("verification needs at least one step (a test to add or a command to run).");
  const spec: PlanSpec = {
    summary,
    context,
    approach,
    changes,
    reuse: texts(raw.reuse, "reuse", errors),
    decisions,
    assumptions: texts(raw.assumptions, "assumptions", errors),
    outOfScope: texts(raw.outOfScope, "outOfScope", errors),
    risks: texts(raw.risks, "risks", errors),
    verification,
  };
  const rating = plannerRating(raw, task.classification, errors);
  if (errors.length) throw new WorkflowError("SPEC_INVALID", errors.join("\n"));
  const file = ctx.store.writeText(task.taskId, SPEC_FILE, redact(renderSpec(spec)));
  // The planner's rating replaces the keyword classification. A rating left out keeps the one the task has.
  const classification = rating ? plannerClassification(rating, redact(`${task.request}\n${specScanText(spec)}`)) : task.classification ?? classifyKeywords(task.request);
  await ctx.store.update(task.taskId, "spec saved", (current) => ({
    ...current,
    classification,
    planning: { stage: "tickets", noQuestions: current.planning?.noQuestions ?? false, ...(current.planning?.revision ? { revision: current.planning.revision } : {}), ...(current.planning?.stage === "tickets" && current.planning.consult ? { consult: current.planning.consult } : {}) },
    updatedAt: iso(ctx),
  }));
  showStatus(ctx);
  return { file, classification, keywordRaised: !!rating && !rating.securitySensitive && classification.reason_codes.includes("security_keyword_override") };
}

/** The parts of a spec the keyword scan reads: what it does and touches, not the long background or the decisions log. */
export function specScanText(spec: PlanSpec): string {
  return [spec.summary, spec.approach, ...spec.changes.map((item) => `${item.path} ${item.change}`), ...spec.risks].join("\n");
}

/**
 * The planner's rating from plan_spec's fields. Undefined when it gave none of them. A missing field falls back to the
 * task's current classification (and to not security-sensitive); a malformed one is an error.
 */
function plannerRating(raw: Record<string, unknown>, current: AcceptedClassification | undefined, errors: string[]): PlannerRating | undefined {
  const given = ["complexity", "risk", "securitySensitive", "classificationReason"].some((key) => raw[key] !== undefined);
  if (!given) return undefined;
  const level = (key: "complexity" | "risk"): Complexity => {
    const value = raw[key];
    if (value === undefined) return current?.[key] ?? "medium";
    if (typeof value === "string" && isDifficulty(value)) return value;
    errors.push(`${key} must be one of low, medium, high.`);
    return "medium";
  };
  const complexity = level("complexity");
  const risk = level("risk");
  if (raw.securitySensitive !== undefined && typeof raw.securitySensitive !== "boolean") errors.push("securitySensitive must be true or false.");
  if (raw.classificationReason !== undefined && typeof raw.classificationReason !== "string") errors.push("classificationReason must be a string.");
  return {
    complexity,
    risk,
    securitySensitive: raw.securitySensitive === undefined ? !!current && isSecuritySensitive(current) : raw.securitySensitive === true,
    reason: typeof raw.classificationReason === "string" ? raw.classificationReason : undefined,
  };
}

/** Rules and state to inject before a user prompt while /plan is running, or undefined when it is not. */
export function planningPrompt(ctx: WorkflowContext): string | undefined {
  const found = activePlanning(ctx);
  if (!found) return undefined;
  const text = stagePrompt(ctx, found);
  return found.task.localMode ? `${text}\n\n${LOCAL_PLAN_NOTE(localTarget(ctx, found.task))}` : text;
}

/** The local model the planner writes for, and the difficulties it takes in a hybrid plan. */
function localTarget(ctx: WorkflowContext, task: TaskState): LocalPlanTarget {
  return { ...localProfile(ctx.config), ...(task.localDifficulties ? { only: task.localDifficulties } : {}) };
}

function stagePrompt(ctx: WorkflowContext, found: NonNullable<ReturnType<typeof activePlanning>>): string {
  const { task, interview } = found;
  const revision = task.planning!.revision;
  const feedback = revision ? ["", "The user sent the drafted plan back with these requested changes:", revision] : [];
  if (task.planning!.stage === "tickets") {
    const spec = ctx.store.readText(task.taskId, SPEC_FILE) ?? "";
    // A hybrid plan keeps the cloud rules (difficulty picks the model) and adds the local rules for its local tickets.
    const target = task.localMode ? localTarget(ctx, task) : undefined;
    const rules = !target
      ? [TICKET_RULES(ctx.config.workers.ticketContextTokens)]
      : target.only
        ? [TICKET_RULES(ctx.config.workers.ticketContextTokens), "", LOCAL_TICKET_RULES(target)]
        : [TICKET_RULES(target.targetTokens, true), "", LOCAL_TICKET_RULES(target)];
    return [...rules, ...feedback, "", "Saved spec:", spec.slice(0, 12000)].join("\n");
  }
  if (revision) {
    const spec = ctx.store.readText(task.taskId, SPEC_FILE) ?? "";
    const tickets = task.plan?.tickets?.length ? renderTicketsMarkdown(task.plan.tickets) : "";
    return [REVISION_RULES, "", `Request: ${interview.request}`, ...feedback, "", "Previous spec:", spec.slice(0, 12000), ...(tickets ? ["", "Previous tickets:", tickets.slice(0, 12000)] : [])].join("\n");
  }
  const lines = [interview.noQuestions ? NO_QUESTIONS_RULES : INTERVIEW_RULES, "", `Request: ${interview.request}`];
  if (!interview.noQuestions) {
    const asked = questionsAsked(interview);
    lines.push("", `Questions asked so far: ${asked}/${MAX_INTERVIEW_QUESTIONS}. Next round: ${interview.rounds.length + 1}.`);
    for (const round of interview.rounds) {
      for (const answer of round.answers) {
        const question = round.questions.find((item) => item.id === answer.id);
        lines.push(`- [${answer.id}] ${question?.title ?? ""}: ${answer.label}${answer.wasCustom ? " (user wrote)" : answer.acceptedRecommendation ? " (accepted recommendation)" : ""}`);
      }
    }
    if (interview.pending) lines.push("", `Round ${interview.pending.round} was shown but not answered (session restarted). Ask it again with plan_questions: ${interview.pending.questions.map((item) => item.id).join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * Sends a drafted plan back to planning with the person's requested changes. The model rewrites the spec and
 * tickets (no new interview questions), and the plan returns for approval. Plan approval stays required.
 */
export async function requestPlanChanges(ctx: WorkflowContext, task: TaskState, feedback: string): Promise<CommandResult> {
  const text = redact(feedback.trim());
  if (!text) return fail("USAGE", "Describe the changes you want, then run /show-plan again.");
  if (!readInterview(ctx, task.taskId)) return fail("NO_INTERVIEW", "This plan was not drafted by the /plan interview. Run /plan again with the changes in the request.");
  if (!ctx.startTurn) return fail("NO_SESSION", "Revising the plan needs a Pi session.");
  const at = iso(ctx);
  await ctx.store.update(task.taskId, "plan changes requested", (current) => ({
    ...toPlanning(current, at),
    approvedVersion: undefined,
    planning: { stage: "interview", noQuestions: true, revision: text },
  }));
  showStatus(ctx);
  ctx.startTurn(`Revise the plan with these changes:\n\n${text}`);
  return done("Sent the plan back for changes. The revised plan will be shown for review again.", { taskId: task.taskId });
}
