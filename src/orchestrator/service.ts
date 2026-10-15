import path from "node:path";
import { loadConfig, type WorkflowConfig } from "../config.js";
import { WorkflowError, type AcceptedClassification, type CommandResult, type CostRecord, type RoutingDecision, type Tier, type TokenUsage } from "../domain.js";
import { GitWorkspace } from "../git/worktrees.js";
import type { Availability } from "../router/select.js";
import { redact } from "../redact.js";
import { TaskStore } from "../storage/store.js";
import type { AuthProbe } from "../providers/auth.js";
import { advisor } from "./advisor.js";
import { autopilot, onPoll, resumeWatcher } from "./autopilot-service.js";
import type { QuotaUsage } from "../cost/quota.js";
import { buildReport, finishChunk, nextChunk, startBuild } from "./build.js";
import { budgetRemainingUsd, checkBudget, quotaState, observeUsage, recordClassifier, recordWebSearch } from "./budget.js";
import type { WorkflowContext } from "./context.js";
import { InFlightSpend } from "./inflight.js";
import { cachingRunner, defaultRunner } from "./exec.js";
import { implement } from "./implementation.js";
import { abandonRound, beginRound, planningPrompt, planningStatusText, recordAnswers, savePlanSpec, startPlan, activePlanning, type InterviewAnswer, type InterviewQuestion } from "./interview.js";
import { checkTickets, commitTickets, previewPlan, requireTicketStage } from "./ticket-plan.js";
import { approveDraft, classify, plan, route, showPlan } from "./planning.js";
import { Poller } from "./poller.js";
import { complete, push, review } from "./publish.js";
import { auth, cost, resetPhase, status } from "./reports.js";
import { announce, availability, decide } from "./routing.js";
import type { WorkflowBinding, WorkflowOptions } from "./types.js";
import { worktrees } from "./worktrees.js";

export type { ExecutorInput, ExecutorResult, GroupExecutor, PlanReviewFn, PlanReviewRequest, SessionControl, WorkflowBinding, WorkflowOptions } from "./types.js";

/**
 * Public facade. Each command lives in its own module as a function of a shared WorkflowContext;
 * this class owns the context and keeps the long-lived pieces (the autopilot timer) on one instance.
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
      github: options.github,
      now: options.now ?? (() => new Date()),
      id: options.id ?? (() => `id-${Math.random().toString(16).slice(2, 10)}`),
      authProbe: options.auth,
      classifier: options.classifier,
      rng: options.rng,
      executors: options.executors ?? {},
      ticketRunner: options.ticketRunner,
      deciders: options.deciders ?? {},
      fixer: options.fixer,
      pushBranch:
        options.push ??
        (async (branch) => {
          const result = await this.git.push(branch);
          if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git push failed");
        }),
      checkRunner: cachingRunner(this.git, options.runner ?? defaultRunner),
      poller: new Poller(options.schedule, config.autopilot.pollSeconds, () => onPoll(ctx), (error) =>
        ctx.notify(`Autopilot poll failed: ${redact((error as Error)?.message || "unknown error")}`),
      ),
      inflight: new InFlightSpend(),
      shutdown: new AbortController(),
      warned: new Set(),
      confirm: options.confirm ?? (async () => false),
      notify: options.notify ?? ((message) => this.store.notify(message)),
      progress: options.progress,
      report: options.report,
      session: options.session,
      chat: options.chat,
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

  /** Applies a reloaded config (and the providers built from it) without rebuilding the workflow or its timer. */
  reconfigure(config: WorkflowConfig, providers?: { auth: AuthProbe; deciders: WorkflowOptions["deciders"] }): void {
    this.ctx.config = config;
    this.ctx.poller.pollSeconds = config.autopilot.pollSeconds;
    if (providers) {
      this.ctx.authProbe = providers.auth;
      this.ctx.deciders = providers.deciders ?? {};
    }
  }

  /** Rebinds per-command UI hooks without rebuilding the workflow (so the autopilot timer survives). */
  bind(binding: WorkflowBinding): void {
    const ctx = this.ctx;
    ctx.session = binding.session;
    ctx.chat = binding.chat ?? ctx.chat;
    ctx.status = binding.status ?? ctx.status;
    ctx.planStatus = binding.planStatus ?? ctx.planStatus;
    ctx.startTurn = binding.startTurn ?? ctx.startTurn;
    ctx.confirm = binding.confirm ?? (async () => false);
    ctx.notify = binding.notify ?? ((message) => this.store.notify(message));
    ctx.progress = binding.progress ?? ctx.progress;
    ctx.report = binding.report ?? ctx.report;
    ctx.review = binding.review;
    ctx.show = binding.show ?? ctx.show;
  }

  /** Re-arms the autopilot timer for a task that was being watched before a restart or session reset. */
  resumeAutopilot(): boolean {
    return resumeWatcher(this.ctx);
  }

  /** Stops the autopilot timer and aborts in-flight ticket children (SIGTERM, then SIGKILL). Call when the session ends. */
  dispose(): void {
    this.ctx.poller.stop();
    this.ctx.shutdown.abort();
    // Re-armed so a workflow that is reused afterwards can run again.
    this.ctx.shutdown = new AbortController();
  }

  activeTaskId(): string | undefined {
    return this.store.readActive();
  }

  /** Which providers can be called right now. Providers absent from the config are left out (treated as available). */
  availability(): Promise<Availability> {
    return availability(this.ctx);
  }

  /** Smaller of the task and daily budget left (USD), counting only known spend. */
  budgetRemainingUsd(taskId?: string): number {
    return budgetRemainingUsd(this.ctx, taskId);
  }

  /** Subscription quota use per provider, for shadow-price ranking. */
  quotaUsage(): QuotaUsage {
    return quotaState(this.ctx);
  }

  /** decideRoute with live availability, remaining budget, and learned per-model metrics. Does not announce. */
  decide(
    classification: AcceptedClassification,
    purpose: "plan" | "implement" | "review" | "preview",
    extra: { failedTier?: Tier; escalations?: number; taskId?: string; tierHint?: Tier } = {},
  ): Promise<RoutingDecision> {
    return decide(this.ctx, classification, purpose, extra);
  }

  /** Shows the chosen model in the status line and records a `route` event in the task log. */
  announce(
    taskId: string | undefined,
    purpose: string,
    decision: Parameters<typeof announce>[3],
    setStatus?: (text: string) => void,
  ): Promise<void> {
    return announce(this.ctx, taskId, purpose, decision, setStatus);
  }

  plan(request: string): Promise<CommandResult> {
    return plan(this.ctx, request);
  }

  /** `/plan`: starts or resumes the model-run interview (or drafts directly for a literal ```tasks request). */
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

  planningStatus(): string | undefined {
    return planningStatusText(this.ctx);
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

  commitTickets(tickets: Parameters<typeof commitTickets>[1]) {
    return commitTickets(this.ctx, tickets);
  }

  /** The full plan these tickets would produce, for review before they are saved. */
  previewPlan(tickets: Parameters<typeof previewPlan>[1]): string {
    return previewPlan(this.ctx, tickets);
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

  implement(): Promise<CommandResult> {
    return implement(this.ctx);
  }

  /** `/build`: starts or resumes the build (branch, budget, approval). The session loop is in extension.ts. */
  startBuild(): Promise<CommandResult> {
    return startBuild(this.ctx);
  }

  /** The next ticket to build, routed and with its prompt, or `done`. */
  nextChunk(): ReturnType<typeof nextChunk> {
    return nextChunk(this.ctx);
  }

  /** Checks, commit, and bookkeeping for the chunk that just ran. */
  finishChunk(ticketId: string, result: { lastText: string; aborted: boolean }, options: { final?: boolean } = {}): ReturnType<typeof finishChunk> {
    return finishChunk(this.ctx, ticketId, result, options);
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

  review(): Promise<CommandResult> {
    return review(this.ctx);
  }

  push(): Promise<CommandResult> {
    return push(this.ctx);
  }

  /** Marks a published task complete (after the PR is merged) so a new task can start. */
  complete(): Promise<CommandResult> {
    return complete(this.ctx);
  }

  autopilot(arg = ""): Promise<CommandResult> {
    return autopilot(this.ctx, arg);
  }

  route(task: string): Promise<CommandResult> {
    return route(this.ctx, task);
  }

  advisor(question: string): Promise<CommandResult> {
    return advisor(this.ctx, question);
  }

  cost(format = ""): Promise<CommandResult> {
    return cost(this.ctx, format);
  }

  status(): Promise<CommandResult> {
    return status(this.ctx);
  }

  resetPhase(): Promise<CommandResult> {
    return resetPhase(this.ctx);
  }

  worktrees(arg = "", confirmed = false): Promise<CommandResult> {
    return worktrees(this.ctx, arg, confirmed);
  }

  auth(arg = ""): Promise<CommandResult> {
    return auth(this.ctx, arg);
  }

  observeUsage(input: { provider: string; model: string; usage: TokenUsage }): CostRecord | undefined {
    return observeUsage(this.ctx, input);
  }

  /** Classifies a chat message for the virtual model (Decisions classifier, else keywords) and ledgers the classifier call to the active task. */
  async classifyChat(text: string): Promise<AcceptedClassification> {
    const result = await classify(this.ctx, text);
    const taskId = this.activeTaskId();
    const state = taskId ? this.store.load(taskId) : undefined;
    if (state) recordClassifier(this.ctx, state.taskId, state.phase, result.usage);
    return result.classification;
  }

  /** Counts a failed chat attempt against a model so the circuit breaker can open. */
  async recordChatFailure(input: { taskType: string; tier: string; provider: string; model: string }): Promise<void> {
    await this.store.bumpMetric(input.taskType, input.tier, false, this.ctx.now(), { provider: input.provider, model: input.model });
  }

  now(): Date {
    return this.ctx.now();
  }

  /** Budget state for callers outside the workflow (for example the virtual model route). Warns once on "soft". */
  checkBudget(taskId?: string): "ok" | "soft" | "hard" {
    return checkBudget(this.ctx, taskId);
  }

  /** Ledgers one web_search call. The query text is not stored. */
  recordWebSearch(input: Parameters<typeof recordWebSearch>[1]): CostRecord {
    return recordWebSearch(this.ctx, input);
  }

  /** Shows a line in the persistent routing status, if the host bound one. */
  showStatus(text: string): void {
    this.ctx.status?.(text);
  }
}

export function workflowFromCwd(cwd: string, auth: AuthProbe, extras: Partial<WorkflowOptions> = {}): Workflow {
  return new Workflow({ cwd, auth, ...extras });
}
