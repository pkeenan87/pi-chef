import path from "node:path";
import { loadConfig, modelLabel, type WorkflowConfig } from "../config.js";
import { type AcceptedClassification, type CommandResult, type CostRecord, type RoutingDecision, type Tier, type Ticket, type TicketRun, type TicketTier, type TokenUsage } from "../domain.js";
import { GitWorkspace, mainCheckoutOf, samePath } from "../git/workspace.js";
import type { Availability } from "../router/select.js";
import { TaskStore } from "../storage/store.js";
import type { AuthProbe } from "../providers/auth.js";
import type { ChatFn } from "../providers/pi-chat.js";
import { runAz } from "../providers/runtime.js";
import { advisor } from "./advisor.js";
import { buildReport, finishChunk, nextChunk, startBuild, unstartChunk, type StartBuildOptions } from "./build.js";
import { budgetRemainingUsd, budgetState, checkBudget, observeUsage, recordPiUsage, recordWebSearch, type BudgetStatus } from "./budget.js";
import { summarizeForCompaction, type CompactionInput, type CompactionSummary } from "./compaction.js";
import { active, type WorkflowContext } from "./context.js";
import { statusLine } from "./state-label.js";
import { displayName } from "./tasks.js";
import { cachingRunner, defaultRunner } from "./exec.js";
import { abandonRound, beginRound, planningPrompt, planningStatusText, recordAnswers, savePlanSpec, startPlan, activePlanning, type InterviewAnswer, type InterviewQuestion } from "./interview.js";
import { adviceForTickets, consultPlan } from "./plan-consult.js";
import { checkTickets, commitTickets, requireTicketStage } from "./ticket-plan.js";
import { presentPendingPlan } from "./present-plan.js";
import { plans, taskNames } from "./plans.js";
import { approveDraft, showPlan } from "./planning.js";
import { ProgressIndicator } from "./progress.js";
import { review } from "./review.js";
import { auth, cost, status } from "./reports.js";
import { availability, decide } from "./routing.js";
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
  private readonly progressLine?: ProgressIndicator;

  constructor(options: WorkflowOptions) {
    this.cwd = options.cwd;
    // A /build worktree shares the main checkout's tasks, ledger and config, so its tickets cannot change the policy.
    const project = mainCheckoutOf(options.cwd);
    const config = options.config ?? loadConfig(project);
    this.store = options.store ?? new TaskStore(path.join(project, config.workspaceDir), project === options.cwd ? undefined : options.cwd);
    this.git = options.git ?? new GitWorkspace(options.cwd);
    const ctx: WorkflowContext = {
      cwd: this.cwd,
      config,
      store: this.store,
      git: this.git,
      now: options.now ?? (() => new Date()),
      id: options.id ?? (() => `id-${Math.random().toString(16).slice(2, 10)}`),
      authProbe: options.auth,
      azure: options.azure ?? runAz,
      rng: options.rng,
      checkRunner: cachingRunner(this.git, options.runner ?? defaultRunner),
      shutdown: new AbortController(),
      warned: new Set(),
      confirm: options.confirm ?? (async () => false),
      notify: options.notify ?? ((message) => this.store.notify(message)),
      progress: options.progress,
      report: options.report,
      chat: options.chat,
      status: options.status,
      planStatus: options.planStatus,
      startTurn: options.startTurn,
    };
    if (options.indicator) ctx.indicator = options.indicator;
    else {
      this.progressLine = new ProgressIndicator(ctx.now);
      ctx.indicator = this.progressLine;
    }
    this.ctx = ctx;
  }

  /** The config in effect. It changes when `reconfigure` is called. */
  get config(): WorkflowConfig {
    return this.ctx.config;
  }

  /** Applies a reloaded config (and the providers built from it) without rebuilding the workflow. */
  reconfigure(config: WorkflowConfig, providers?: { auth: AuthProbe }): void {
    this.ctx.config = config;
    if (providers) this.ctx.authProbe = providers.auth;
  }

  /** Rebinds per-command UI hooks without rebuilding the workflow. */
  bind(binding: WorkflowBinding): void {
    const ctx = this.ctx;
    ctx.chat = binding.chat ?? ctx.chat;
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
    // The sink is the live ctx's UI; it is replaced on every bind so a stopped line never draws on a dead session.
    this.progressLine?.attach(binding.indicatorSink);
    ctx.show = binding.show ?? ctx.show;
  }

  /** Aborts work still running for this workflow (the advisory model review). Call when the session ends. */
  dispose(): void {
    this.ctx.indicator?.stop();
    this.ctx.shutdown.abort();
    // Re-armed so a workflow that is reused afterwards can run again.
    this.ctx.shutdown = new AbortController();
  }

  activeTaskId(): string | undefined {
    return this.store.readActive();
  }

  /** Which providers can be called right now, each with the reason when it cannot. */
  availability(): Promise<Availability> {
    return availability(this.ctx);
  }

  /** Smaller of the task and daily budget left (USD), counting only known spend. */
  budgetRemainingUsd(taskId?: string): number {
    return budgetRemainingUsd(this.ctx, taskId);
  }

  /** decideRoute with live availability, remaining budget, and learned per-model metrics. Does not announce. */
  decide(
    classification: AcceptedClassification,
    purpose: "implement" | "review",
    extra: { failedTier?: Tier; escalations?: number; taskId?: string; ticketTier?: TicketTier; strictAvailability?: boolean } = {},
  ): Promise<RoutingDecision> {
    return decide(this.ctx, classification, purpose, extra);
  }

  /** `/plan`: starts or resumes the model-run interview. */
  startPlan(request: string, options: { noQuestions?: boolean; local?: boolean } = {}): Promise<CommandResult> {
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

  /** The persistent status line for the stored active task (no git call), or undefined to clear it. */
  statusLine(): string | undefined {
    const state = active(this.ctx);
    const running = state?.build?.currentTicket ? state.ticketRuns?.[state.build.currentTicket] : undefined;
    const { task, daily } = budgetState(this.ctx, state?.taskId);
    const { taskUsd, dailyUsd } = this.ctx.config.budgets;
    return statusLine(state, {
      name: state ? displayName(state) : "",
      local: state?.localMode === true,
      planning: planningStatusText(this.ctx),
      model: running?.provider && running.model ? modelLabel(this.ctx.config, running.provider, running.model) : undefined,
      spentUsd: task.knownUsd,
      unknownSpend: task.unknownRecords > 0,
      estimatedUnknownUsd: task.estimatedUnknownUsd,
      budgetUsd: taskUsd,
      daily: { spentUsd: daily.knownUsd, unknownSpend: daily.unknownRecords > 0, estimatedUnknownUsd: daily.estimatedUnknownUsd, budgetUsd: dailyUsd },
    });
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

  /** plan_consult: both advisors on the draft tickets, once per draft. */
  consultPlan(input: Parameters<typeof consultPlan>[1]) {
    return consultPlan(this.ctx, input);
  }

  /** What plan_tickets needs from the advisor consult (throws when it is missing), as the review to store on the plan. */
  adviceForTickets(resolution: string | undefined, tickets: Ticket[], reconsultWaived?: boolean) {
    return adviceForTickets(this.ctx, resolution, tickets, reconsultWaived);
  }
  checkTickets(input: unknown) {
    return checkTickets(this.ctx, input);
  }

  commitTickets(tickets: Parameters<typeof commitTickets>[1], advisorReview?: Parameters<typeof commitTickets>[2], options?: Parameters<typeof commitTickets>[3]) {
    return commitTickets(this.ctx, tickets, advisorReview, options);
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
  startBuild(options?: StartBuildOptions): Promise<CommandResult> {
    return startBuild(this.ctx, options);
  }

  buildCheckout(): { dir: string; taskId: string } | undefined {
    const state = active(this.ctx);
    const dir = state?.build?.worktree;
    return state && dir && !samePath(dir, this.cwd) ? { dir, taskId: state.taskId } : undefined;
  }

  followBuild(taskId: string): void {
    this.store.setActive(taskId, this.store.load(taskId)?.build?.branch);
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

  /** The ticket a /build chunk is running now, if any. */
  buildingTicket(): string | undefined {
    const id = this.store.readActive();
    return id ? this.store.load(id)?.build?.currentTicket : undefined;
  }

  /** One-line chat event, when a Pi session is bound. */
  progress(text: string): void {
    this.ctx.progress?.(text);
  }

  /** Multi-line markdown block kept in the chat transcript, when a Pi session is bound. */
  report(markdown: string): void {
    this.ctx.report?.(markdown);
  }

  /** `/review`: checks, static scan, and the advisory model pass over the changes against the base branch; offers to fix the findings in this session. Never commits or pushes. */
  review(): Promise<CommandResult> {
    return review(this.ctx);
  }


  advisor(question: string): Promise<CommandResult> {
    return advisor(this.ctx, question);
  }

  cost(format = ""): Promise<CommandResult> {
    return cost(this.ctx, format);
  }

  status(arg = ""): Promise<CommandResult> {
    return status(this.ctx, arg);
  }

  auth(arg = ""): Promise<CommandResult> {
    return auth(this.ctx, arg);
  }

  observeUsage(input: { provider: string; model: string; usage: TokenUsage }): CostRecord | undefined {
    return observeUsage(this.ctx, input);
  }

  /** Ledgers the calls Pi made on its own (cache warming, its own compaction and branch summaries) from the session file. */
  recordPiUsage(input: Parameters<typeof recordPiUsage>[1]): CostRecord[] {
    return recordPiUsage(this.ctx, input);
  }

  /**
   * A compaction summary from `session.compactionTier`, ledgered as `compaction`. Undefined when no model can write it
   * (hard budget, nobody signed in, a failed call), so the caller lets Pi compact with the session model.
   */
  summarizeForCompaction(chat: ChatFn, input: CompactionInput): Promise<CompactionSummary | undefined> {
    return summarizeForCompaction(this.ctx, chat, input);
  }

  /** Task or daily budget state with no warning, for gates that decide for themselves what to say. */
  budgetStatus(taskId?: string): BudgetStatus {
    return budgetState(this.ctx, taskId).status;
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
