import path from "node:path";
import { fromMicroUsd, loadConfig, toMicroUsd, type WorkflowConfig } from "../config.js";
import { type CommandResult, type CostRecord, type TicketRun, type TokenUsage } from "../domain.js";
import { GitWorkspace } from "../git/workspace.js";
import { TaskStore } from "../storage/store.js";
import { buildReport, finishChunk, nextChunk, startBuild, unstartChunk } from "./build.js";
import { budgetState, checkBudget, observeUsage, recordAgentUsage, recordPiUsage, recordWebSearch } from "./budget.js";
import { active, type WorkflowContext } from "./context.js";
import { ledgerChildSession, sweepTicketSessions } from "../herdr/session-file.js";
import { displayName, stateText } from "./tasks.js";
import { cachingRunner, defaultRunner } from "./exec.js";
import { abandonRound, beginRound, planningPrompt, planningStatusText, recordAnswers, savePlanSpec, startPlan, activePlanning, type InterviewAnswer, type InterviewQuestion } from "./interview.js";
import { checkTickets, commitTickets, requireTicketStage } from "./ticket-plan.js";
import { presentPendingPlan } from "./present-plan.js";
import { plans, taskNames } from "./plans.js";
import { approveDraft, showPlan } from "./planning.js";
import { review } from "./review.js";
import { cost } from "./reports.js";
import type { WorkflowBinding, WorkflowOptions } from "./types.js";

export type { PlanReviewFn, PlanReviewRequest, WorkflowBinding, WorkflowOptions } from "./types.js";

/**
 * Public facade. Each command lives in its own module as a function of a shared WorkflowContext;
 * this class owns the context.
 */
export class Workflow {
  readonly store: TaskStore;
  readonly git: GitWorkspace;
  readonly cwd: string;
  private readonly ctx: WorkflowContext;

  constructor(options: WorkflowOptions) {
    this.cwd = options.cwd;
    const config = options.config ?? loadConfig(options.cwd);
    this.store = options.store ?? new TaskStore(path.join(options.cwd, config.workspaceDir));
    this.git = options.git ?? new GitWorkspace(options.cwd);
    const ctx: WorkflowContext = {
      cwd: this.cwd,
      config,
      store: this.store,
      git: this.git,
      now: options.now ?? (() => new Date()),
      id: options.id ?? (() => `id-${Math.random().toString(16).slice(2, 10)}`),
      checkRunner: cachingRunner(this.git, options.runner ?? defaultRunner),
      shutdown: new AbortController(),
      warned: new Set(),
      confirm: options.confirm ?? (async () => false),
      notify: options.notify ?? ((message) => this.store.notify(message)),
      progress: options.progress,
      report: options.report,
      chat: options.chat,
      herdr: options.herdr,
      herdrTimings: options.herdrTimings,
      ticketModePath: options.ticketModePath,
      status: options.status,
      planStatus: options.planStatus,
      startTurn: options.startTurn,
    };
    this.ctx = ctx;
  }

  /** The config in effect. It changes when `reconfigure` is called. */
  get config(): WorkflowConfig {
    return this.ctx.config;
  }

  /** Applies a reloaded config without rebuilding the workflow. */
  reconfigure(config: WorkflowConfig): void {
    this.ctx.config = config;
  }

  /** Rebinds per-command UI hooks without rebuilding the workflow. */
  bind(binding: WorkflowBinding): void {
    const ctx = this.ctx;
    ctx.chat = binding.chat ?? ctx.chat;
    ctx.herdr = binding.herdr ?? ctx.herdr;
    ctx.ticketModePath = binding.ticketModePath ?? ctx.ticketModePath;
    ctx.registry = binding.registry ?? ctx.registry;
    ctx.status = binding.status ?? ctx.status;
    ctx.planStatus = binding.planStatus ?? ctx.planStatus;
    ctx.startTurn = binding.startTurn ?? ctx.startTurn;
    ctx.confirm = binding.confirm ?? (async () => false);
    ctx.notify = binding.notify ?? ((message) => this.store.notify(message));
    ctx.progress = binding.progress ?? ctx.progress;
    ctx.report = binding.report ?? ctx.report;
    ctx.review = binding.review;
    ctx.edit = binding.edit;
    ctx.show = binding.show ?? ctx.show;
  }

  /** Aborts work still running for this workflow (the model review). Call when the session ends. */
  dispose(): void {
    this.ctx.shutdown.abort();
    // Re-armed so a workflow that is reused afterwards can run again.
    this.ctx.shutdown = new AbortController();
  }

  activeTaskId(): string | undefined {
    return this.store.readActive();
  }

  /** `/plan`: starts or resumes the model-run interview. */
  startPlan(request: string, options: { noQuestions?: boolean } = {}): Promise<CommandResult> {
    return startPlan(this.ctx, request, options);
  }

  /** Interview rules and state for the model while /plan is running, else undefined. */
  planningPrompt(): string | undefined {
    return planningPrompt(this.ctx);
  }

  /** "plan" while a /plan interview or ticket stage is running (read-only tools apply), else undefined. */
  planningStage(): "interview" | "tickets" | undefined {
    return activePlanning(this.ctx)?.task.planning?.stage;
  }

  /** The persistent status line for the stored active task (no git call): task, state, spend; today's spend alone with no open task. */
  statusLine(): string | undefined {
    const state = active(this.ctx);
    const { task, daily } = budgetState(this.ctx, state?.taskId);
    const { taskUsd, dailyUsd } = this.ctx.config.budgets;
    const spend = (s: { knownUsd: number; unknownRecords: number; estimatedUnknownUsd: number }) => (s.unknownRecords > 0 ? `≈$${fromMicroUsd(toMicroUsd(s.knownUsd) + toMicroUsd(s.estimatedUnknownUsd)).toFixed(2)}` : `$${s.knownUsd.toFixed(2)}`);
    const today = `today ${spend(daily)} of $${dailyUsd}`;
    if (!state || state.phase === "IDLE" || state.phase === "COMPLETE") return daily.knownUsd > 0 || daily.unknownRecords > 0 ? `chef · ${today}` : undefined;
    return ["chef", displayName(state), planningStatusText(this.ctx) ?? stateText(state), `${spend(task)} of $${taskUsd}`, today].join(" · ");
  }

  /** Validates a round of plan_questions input against the cap and ordering rules and records it as pending. */
  beginQuestionRound(input: { round: number; questions: InterviewQuestion[] }) {
    return beginRound(this.ctx, input);
  }

  /** Releases the pending-round marker after a dismissed or failed round, so it can be asked again. */
  abandonQuestionRound(): void {
    abandonRound(this.ctx);
  }

  recordInterviewAnswers(round: number, questions: InterviewQuestion[], answers: InterviewAnswer[], headless: boolean) {
    return recordAnswers(this.ctx, round, questions, answers, headless);
  }

  savePlanSpec(input: unknown) {
    return savePlanSpec(this.ctx, input);
  }

  /** Throws unless the spec is saved and plan_tickets may run. */
  requireTicketStage(): void {
    requireTicketStage(this.ctx);
  }

  checkTickets(input: unknown) {
    return checkTickets(this.ctx, input);
  }

  commitTickets(tickets: Parameters<typeof commitTickets>[1], options?: Parameters<typeof commitTickets>[2]) {
    return commitTickets(this.ctx, tickets, options);
  }

  /** True when plan_tickets saved a draft that has not been shown yet. */
  hasPendingPlan(): boolean {
    const task = this.activeTaskId() ? this.store.load(this.activeTaskId()!) : undefined;
    return !!task?.presentPlan && task.presentPlan.version === task.plan?.version;
  }

  /** When the planning turn has settled: posts a just-saved plan and asks what to do with it. Needs a bound UI. */
  presentPendingPlan(): Promise<void> {
    return presentPendingPlan(this.ctx);
  }
  /** Approves the active draft: freezes plan.vN.approved.json. The choice was made on a review screen. */
  approveDraft(): Promise<CommandResult> {
    return approveDraft(this.ctx);
  }

  /** Posts markdown as a displayed chat message, when a Pi session is bound. */
  showMarkdown(markdown: string): void {
    this.ctx.show?.(markdown);
  }

  showPlan(): Promise<CommandResult> {
    return showPlan(this.ctx);
  }

  /** `/plans`: list the tasks, switch to one, or close one. */
  plans(arg = ""): Promise<CommandResult> {
    return plans(this.ctx, arg);
  }

  /** Task names for completion (open ones, and closed ones with `all`). */
  taskNames(all = false): string[] {
    return taskNames(this.ctx, all);
  }

  /** `/build`: starts or resumes the build (branch, budget, approval). The session loop is in extension.ts. */
  startBuild(): Promise<CommandResult> {
    return startBuild(this.ctx);
  }

  releaseBuild(): void {
    const taskId = this.store.readActive();
    if (taskId) this.store.releaseBuild(taskId);
  }

  /** The next ticket to build, routed and with its prompt, or `done`. */
  nextChunk(): ReturnType<typeof nextChunk> {
    return nextChunk(this.ctx);
  }

  /** Checks, commit, and bookkeeping for the chunk that just ran. */
  finishChunk(ticketId: string, result: { lastText: string; aborted: boolean }, options: { final?: boolean } = {}): ReturnType<typeof finishChunk> {
    return finishChunk(this.ctx, ticketId, result, options);
  }

  /** Rolls a ticket back to not started when its session never took its first turn. */
  unstartChunk(ticketId: string, previous?: TicketRun): Promise<void> {
    return unstartChunk(this.ctx, ticketId, previous);
  }

  /** The build's ticket table and next step, as markdown. */
  buildReport(stopped?: string): string {
    return buildReport(this.ctx, stopped);
  }

  /** The branch /build made for the active task, while it has a build. */
  buildBranch(): string | undefined {
    const id = this.store.readActive();
    return id ? this.store.load(id)?.build?.branch : undefined;
  }

  /** One-line chat event, when a Pi session is bound. */
  progress(text: string): void {
    this.ctx.progress?.(text);
  }

  /** Multi-line markdown block kept in the chat transcript, when a Pi session is bound. */
  report(markdown: string): void {
    this.ctx.report?.(markdown);
  }

  /** `/review [--with <model>]`: checks, static scan, and the advisory model pass over the changes against the base branch; offers to fix the findings in this session. Never commits or pushes. */
  review(args = ""): Promise<CommandResult> {
    return review(this.ctx, args);
  }


  cost(format = ""): Promise<CommandResult> {
    return cost(this.ctx, format);
  }

  observeUsage(input: { provider: string; model: string; usage: TokenUsage }, extra?: Parameters<typeof observeUsage>[2]): CostRecord | undefined {
    return observeUsage(this.ctx, input, extra);
  }

  /** `<task dir>/sessions` of the active task: where the Pi ticket runner keeps a child's session dirs and status files. */
  ticketSessionsRoot(): string | undefined {
    const state = active(this.ctx);
    return state ? path.join(this.store.taskDir(state.taskId), "sessions") : undefined;
  }

  /** The active task's readable name (for a herdr tab name). */
  ticketSessionsName(): string {
    const state = active(this.ctx);
    return state ? displayName(state) : "";
  }

  /** Ledgers a Pi ticket child's new session entries (`src/herdr/session-file.ts`). */
  ledgerChildSession(files: Parameters<typeof ledgerChildSession>[1], options: Parameters<typeof ledgerChildSession>[2]): CostRecord[] {
    return ledgerChildSession(this.ctx, files, options);
  }

  /** The resume sweep over a ticket's earlier child session dirs. */
  sweepTicketSessions(ticketId: string, options: Parameters<typeof sweepTicketSessions>[2] = {}): CostRecord[] {
    return sweepTicketSessions(this.ctx, ticketId, options);
  }

  /** Ledgers what an external agent spent on a ticket (`src/runner/agent-usage.ts`): metered calls, or one "not metered" row. */
  recordAgentUsage(input: Parameters<typeof recordAgentUsage>[1]): CostRecord[] {
    return recordAgentUsage(this.ctx, input);
  }

  /** A ticket meter has read an agent log to `offset`: the active task's watermark moves there so the sweep skips it. */
  advanceAgentLog(file: string, offset: number): void {
    const taskId = this.store.readActive();
    if (taskId) this.store.advanceAgentLog(taskId, file, offset);
  }

  /** Ledgers the calls Pi made on its own (cache warming, its own compaction and branch summaries) from the session file. */
  recordPiUsage(input: Parameters<typeof recordPiUsage>[1]): CostRecord[] {
    return recordPiUsage(this.ctx, input);
  }

  now(): Date {
    return this.ctx.now();
  }

  /** Budget state for callers outside the workflow (for example web_search). Warns once on "soft". */
  checkBudget(taskId?: string): "ok" | "soft" | "hard" {
    return checkBudget(this.ctx, taskId);
  }

  /** Ledgers one web_search call. The query text is not stored. */
  recordWebSearch(input: Parameters<typeof recordWebSearch>[1]): CostRecord {
    return recordWebSearch(this.ctx, input);
  }

  /** Tells the host something changed (a web_search was ledgered); the host redraws its status line from the task, so `text` is only a hint. */
  showStatus(text: string): void {
    this.ctx.status?.(text);
  }
}
