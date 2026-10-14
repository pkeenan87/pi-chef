import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, type WorkflowConfig } from "../config.js";
import {
  emptyUsage,
  WorkflowError,
  type AttemptRecord,
  type CommandResult,
  type ContextReset,
  type CostRecord,
  type PlanDocument,
  type ProviderId,
  type TaskState,
  type Tier,
  type TokenUsage,
  type WorktreeRecord,
} from "../domain.js";
import { runWorkerPool, type WorkerJob } from "../agents/pool.js";
import { budgetStatus, buildCostRecord, summarize, toCsv } from "../cost/ledger.js";
import { GitWorkspace } from "../git/worktrees.js";
import { autopilotCycle, freshCursor, type FixRequest, type FixResult } from "../github/autopilot.js";
import type { GitHubClient, PullRequestSnapshot } from "../github/types.js";
import { classifyTask, type Classifier } from "../router/classify.js";
import { decideRoute } from "../router/policy.js";
import { reviewDiff, type CheckRunner } from "../review/review.js";
import { redact } from "../redact.js";
import type { AuthProbe } from "../providers/auth.js";
import { TaskStore } from "../storage/store.js";
import { move } from "./machine.js";
import { acceptanceCriteria, applyOverlap, materialChange, parseGroups, renderPlan, waves } from "./plan.js";

const exec = promisify(execFile);

export interface SessionControl {
  reset(input: { boundary: ContextReset["boundary"]; handoff: string }): Promise<{ mode: ContextReset["mode"]; cancelled: boolean }>;
}

export interface WorkflowOptions {
  cwd: string;
  config?: WorkflowConfig;
  store?: TaskStore;
  now?: () => Date;
  id?: () => string;
  auth: AuthProbe;
  classifier?: Classifier;
  git?: GitWorkspace;
  github?: GitHubClient;
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string) => void;
  session?: SessionControl;
  runner?: CheckRunner;
  fixer?: (request: FixRequest) => Promise<FixResult>;
  push?: (branch: string) => Promise<void>;
  schedule?: (delayMs: number, run: () => void) => () => void;
}

function fail(code: string, text: string): CommandResult {
  return { ok: false, code, text };
}

function done(text: string, data?: unknown): CommandResult {
  return { ok: true, text, data };
}

function knownZero(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

export class Workflow {
  readonly config: WorkflowConfig;
  readonly store: TaskStore;
  readonly git: GitWorkspace;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly authProbe: AuthProbe;
  private readonly classifier?: Classifier;
  private readonly github?: GitHubClient;
  private readonly confirm: (title: string, message: string) => Promise<boolean>;
  private readonly notify: (message: string) => void;
  private readonly session?: SessionControl;
  private readonly runner: CheckRunner;
  private readonly fixer?: WorkflowOptions["fixer"];
  private readonly pushBranch: (branch: string) => Promise<void>;
  private readonly schedule?: WorkflowOptions["schedule"];
  private cancelPoll?: () => void;

  constructor(options: WorkflowOptions) {
    this.config = options.config ?? loadConfig(options.cwd);
    this.store = options.store ?? new TaskStore(path.join(options.cwd, this.config.workspaceDir));
    this.git = options.git ?? new GitWorkspace(options.cwd);
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => `id-${Math.random().toString(16).slice(2, 10)}`);
    this.authProbe = options.auth;
    this.classifier = options.classifier;
    this.github = options.github;
    this.confirm = options.confirm ?? (async () => false);
    this.notify = options.notify ?? ((message) => this.store.notify(message));
    this.session = options.session;
    this.runner = options.runner ?? {
      async run(command, args, cwd) {
        try {
          const { stdout, stderr } = await exec(command, args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
          return { code: 0, stdout, stderr };
        } catch (error) {
          const failed = error as { code?: number; stdout?: string; stderr?: string };
          return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
        }
      },
    };
    this.fixer = options.fixer;
    this.schedule = options.schedule;
    this.pushBranch = options.push ?? (async (branch) => {
      const result = await this.git.push(branch);
      if (result.code !== 0) throw new WorkflowError("GIT", result.stderr || "git push failed");
    });
  }

  async plan(request: string): Promise<CommandResult> {
    try {
      const safe = redact(request);
      const at = this.iso();
      const classification = await classifyTask(safe, { minConfidence: this.config.routing.minConfidence, classifier: this.classifier });
      const routing = decideRoute(classification, this.config, this.store.readMetrics(), { purpose: "plan", at: this.now() });
      const parsed = applyOverlap(parseGroups(safe));
      const active = this.active();
      let state: TaskState;
      if (!active || active.phase === "COMPLETE" || active.phase === "FAILED" || active.phase === "IDLE") {
        const taskId = `task-${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${this.id()}`;
        state = await this.store.create(this.blank(taskId, safe, at));
      } else {
        state = active;
      }
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
        state = await this.store.update(state.taskId, "plan drafted", (current) => move({ ...current, plan: draft, classification, routing, request: safe, approvedVersion: undefined }, "AWAITING_PLAN_APPROVAL", at));
      } else if (state.phase === "AWAITING_PLAN_APPROVAL" && !state.approvedVersion) {
        state = await this.store.update(state.taskId, "draft replaced", (current) => ({ ...current, plan: draft, classification, routing, request: safe, updatedAt: at }));
      } else if (state.approvedVersion) {
        state = await this.store.update(state.taskId, "scope change requires re-approval", (current) =>
          move({ ...current, plan: draft, classification, routing, request: safe, approvedVersion: undefined, publishApproved: false }, "AWAITING_PLAN_APPROVAL", at, "scope change"),
        );
      } else {
        state = await this.store.update(state.taskId, "plan drafted", (current) => move({ ...current, plan: draft, classification, routing, request: safe }, "AWAITING_PLAN_APPROVAL", at));
      }
      this.store.writeText(state.taskId, "plan.json", JSON.stringify(draft, null, 2));
      this.store.writeText(state.taskId, "plan.md", renderPlan(draft));
      this.remember(state, state.phase, routing.tier, routing.provider, routing.model, knownZero(), "success", 0, "plan");
      const overlap = draft.overlap.length ? ` Overlap on ${draft.overlap.join(", ")} will be serialized.` : " No file overlap.";
      return done(`Draft v${draft.version} is waiting for /approve-plan.${overlap} Nothing was committed.`, { taskId: state.taskId, plan: draft, routing });
    } catch (error) {
      return this.asResult(error);
    }
  }

  async approvePlan(): Promise<CommandResult> {
    try {
      const current = this.require();
      if (current.phase !== "AWAITING_PLAN_APPROVAL" || !current.plan) {
        return fail("APPROVAL_REQUIRED", "There is no draft waiting for approval.");
      }
      if (current.approvedVersion === current.plan.version) return done(`Plan v${current.plan.version} is already approved.`);
      const at = this.iso();
      const body = `${JSON.stringify(current.plan, null, 2)}\n`;
      const frozen = this.store.writeOnceText(current.taskId, `plan.v${current.plan.version}.approved.json`, body);
      const handoff = await this.handoff(current, "post-approval", [
        "# Handoff after plan approval",
        "",
        `Approved plan: ${frozen}`,
        `Version: ${current.plan.version}`,
        "",
        current.plan.summary,
        "",
        "Implement only the files in this plan. Do not expand scope.",
      ].join("\n"));
      const state = await this.store.update(current.taskId, "plan approved", (task) => ({
        ...task,
        approvedVersion: task.plan?.version,
        updatedAt: at,
        contextResets: [...task.contextResets, handoff],
      }));
      return done(`Approved plan v${state.approvedVersion}. Context reset: ${handoff.mode}. The approved file will not be overwritten.`, state);
    } catch (error) {
      return this.asResult(error);
    }
  }

  async implement(): Promise<CommandResult> {
    try {
      let state = this.require();
      if (!state.approvedVersion || !state.plan) {
        return fail("APPROVAL_REQUIRED", "/implement refused: the plan is still a draft.");
      }
      if (state.plan.securitySensitive) {
        const allowed = await this.confirm("Security-sensitive plan", "This plan touches auth, secrets, or production. Approve implementation?");
        if (!allowed) {
          state = await this.store.update(state.taskId, "security approval withheld", (task) => move(task, "PAUSED", this.iso(), "security approval withheld"));
          return fail("SECURITY_PAUSE", "Implementation paused. Security-sensitive work needs a person.");
        }
      }
      const budget = this.budgetFor(state.taskId);
      if (budget === "hard") return fail("BUDGET", "Task or daily budget is exhausted. Unknown charges were not treated as zero.");
      if (state.phase === "PAUSED" && state.pausedFrom) {
        state = await this.store.update(state.taskId, "resume", (task) => move(task, task.pausedFrom ?? "IMPLEMENTING", this.iso()));
      }
      if (state.phase === "AWAITING_PLAN_APPROVAL" || state.phase === "FAILED" || state.phase === "REVIEWING") {
        state = await this.store.update(state.taskId, "start implementation", (task) => move(task, "IMPLEMENTING", this.iso()));
      } else if (state.phase !== "IMPLEMENTING") {
        return fail("ILLEGAL_TRANSITION", `Cannot implement from ${state.phase}.`);
      }
      const routing = decideRoute(state.classification!, this.config, this.store.readMetrics(), { purpose: "implement", at: this.now() });
      if (routing.circuitOpen) {
        await this.store.update(state.taskId, "circuit open", (task) => move(task, "BLOCKED", this.iso(), "circuit breaker"));
        return fail("CIRCUIT_OPEN", "Circuit breaker is open for this task class.");
      }
      let decision = routing;
      let lastError = "implementation failed";
      for (let escalations = 0; escalations <= this.config.routing.maxEscalations; escalations++) {
        if (decision.provider !== "none") {
          const view = await this.authProbe.inspect(decision.provider);
          if (view.status !== "ready") {
            await this.store.update(state.taskId, view.detail, (task) => move(task, view.status === "expired" ? "PAUSED" : "BLOCKED", this.iso(), view.detail));
            return fail(view.status === "expired" ? "AUTH_EXPIRED" : view.method === "api-key" ? "API_KEY_REJECTED" : "AUTH_MISSING", view.detail);
          }
        }
        const outcome = await this.runImplementation(state, decision.tier);
        state = this.require();
        this.remember(state, state.phase, decision.tier, decision.provider, decision.model, outcome.usage, outcome.ok ? "success" : "failure", escalations, outcome.ok ? "implement" : outcome.error);
        this.bumpMetric(state.classification?.task_type ?? "general", decision.tier, outcome.ok);
        if (outcome.ok) {
          const handoff = await this.handoff(state, "post-implementation", outcome.handoff);
          await this.store.update(state.taskId, "implementation handoff", (task) => ({ ...task, contextResets: [...task.contextResets, handoff], routing: decision, updatedAt: this.iso() }));
          return done(`${outcome.summary} Context reset: ${handoff.mode}.`, { worktrees: this.require().worktrees, integration: this.require().integration });
        }
        lastError = outcome.error;
        const next = decideRoute(state.classification!, this.config, this.store.readMetrics(), {
          purpose: "implement",
          failedTier: decision.tier,
          escalations: escalations + 1,
          at: this.now(),
        });
        if (next.tier === decision.tier || escalations === this.config.routing.maxEscalations) break;
        decision = next;
      }
      await this.store.update(state.taskId, lastError, (task) => move(task, "FAILED", this.iso(), lastError));
      return fail("FAILED", `${lastError} Escalation stopped at the configured maximum.`);
    } catch (error) {
      return this.asResult(error);
    }
  }

  async review(): Promise<CommandResult> {
    try {
      let state = this.require();
      if (!state.plan || !state.integration?.sha) return fail("NOT_READY", "Review needs an implementation and an integration SHA.");
      const plan = state.plan;
      const integration = state.integration;
      if (state.phase !== "REVIEWING") {
        state = await this.store.update(state.taskId, "start review", (task) => move(task, "REVIEWING", this.iso()));
      }
      const diffs = [];
      for (const worktree of state.worktrees) {
        diffs.push({ groupId: worktree.groupId, diff: await this.git.diff(worktree.path, worktree.baseSha) });
      }
      const integrated = integration.path ? await this.git.diff(integration.path, state.worktrees[0]?.baseSha ?? integration.sha) : "";
      const report = await reviewDiff({
        diffs,
        integratedDiff: integrated,
        checks: this.config.checks,
        cwd: integration.path ?? this.git.repoRoot,
        runner: this.runner,
        allowlist: this.config.commandAllowlist,
        planAcceptance: plan.acceptance,
      });
      this.store.writeText(state.taskId, "reports/review.json", JSON.stringify(report, null, 2));
      const at = this.iso();
      if (report.passed) {
        await this.store.update(state.taskId, "review passed", (task) => move({ ...task, review: report }, "AWAITING_PUBLISH_APPROVAL", at));
        return done(report.summary, report);
      }
      await this.store.update(state.taskId, "review blocking", (task) => move({ ...task, review: report }, "IMPLEMENTING", at, "blocking review findings"));
      return { ok: false, code: "REVIEW_BLOCKING", text: report.summary, data: report };
    } catch (error) {
      return this.asResult(error);
    }
  }

  async push(): Promise<CommandResult> {
    try {
      const state = this.require();
      if (state.phase !== "AWAITING_PUBLISH_APPROVAL") return fail("APPROVAL_REQUIRED", "Publish waits until review is clean.");
      if (!state.review?.passed || !state.review.claimedPass) return fail("NO_EVIDENCE", "Publish refused: review did not pass on tool evidence.");
      if (this.config.approvals.publish === "required") {
        const allowed = await this.confirm("Publish", "Push the integration branch and open or update the pull request?");
        if (!allowed) return fail("APPROVAL_REQUIRED", "Publish was not approved.");
      }
      if (!this.github) return fail("GITHUB", "No GitHub client is configured.");
      const branch = state.integration?.branch;
      if (!branch || !state.integration?.sha) return fail("GIT", "Integration branch is missing.");
      await this.pushBranch(branch);
      const snapshot = await this.github.upsert({
        branch,
        base: "main",
        title: state.plan?.summary.slice(0, 72) || state.taskId,
        body: redact(state.plan?.summary ?? ""),
      });
      const at = this.iso();
      const handoff = await this.handoff(state, "post-publish", [
        "# Handoff after publish",
        "",
        `PR #${snapshot.number} ${snapshot.url}`,
        `Branch: ${snapshot.branch}`,
        `Head: ${snapshot.headSha}`,
        `Checks: ${snapshot.checks.map((check) => `${check.name}=${check.conclusion ?? check.status}`).join(", ") || "none yet"}`,
        `Findings: ${state.review.findings.length}`,
      ].join("\n"));
      await this.store.update(state.taskId, "published", (task) =>
        move(
          {
            ...task,
            publishApproved: true,
            pullRequest: { number: snapshot.number, url: snapshot.url, branch: snapshot.branch, base: snapshot.base, headSha: snapshot.headSha, baseSha: snapshot.baseSha },
            contextResets: [...task.contextResets, handoff],
          },
          "PUBLISHED",
          at,
        ),
      );
      return done(`Published PR #${snapshot.number}. Context reset: ${handoff.mode}. Not merged.`, snapshot);
    } catch (error) {
      return this.asResult(error);
    }
  }

  async autopilot(arg = ""): Promise<CommandResult> {
    try {
      const command = arg.trim();
      let state = this.require();
      if (command === "status") {
        return done(state.autopilot ? JSON.stringify({ phase: state.phase, ...state.autopilot }, null, 2) : "Autopilot has not been started.", state.autopilot);
      }
      this.disarm();
      if (command === "stop") {
        state = await this.store.update(state.taskId, "autopilot stop", (task) => ({
          ...task,
          autopilot: { ...(task.autopilot ?? freshCursor(this.iso())), running: false, pausedReason: "Stopped by /autopilot stop." },
          updatedAt: this.iso(),
        }));
        return done("Autopilot watcher stopped. The cursor is still on disk.");
      }
      if (!state.pullRequest) return fail("NOT_READY", "Autopilot needs a published pull request.");
      const pullRequest = state.pullRequest;
      if (state.phase === "PUBLISHED") state = await this.store.update(state.taskId, "autopilot start", (task) => move(task, "AUTOPILOT", this.iso()));
      if (state.phase === "PAUSED" && state.pausedFrom === "AUTOPILOT") {
        state = await this.store.update(state.taskId, "autopilot resume", (task) => move(task, "AUTOPILOT", this.iso()));
      }
      if (state.phase !== "AUTOPILOT" && state.phase !== "MERGE_READY") {
        return fail("ILLEGAL_TRANSITION", `Cannot watch from ${state.phase}.`);
      }
      if (!this.github) return fail("GITHUB", "No GitHub client is configured.");
      const pr = await this.github.findByBranch(pullRequest.branch);
      if (!pr) return fail("GITHUB", "The pull request is no longer visible.");
      const cursor = state.autopilot ?? freshCursor(this.iso());
      const relation = !cursor.headSha || cursor.headSha === pr.headSha ? "same" : await this.relation(cursor.headSha, pr.headSha);
      const cycle = await autopilotCycle({
        cursor,
        pr,
        allowedFiles: state.plan?.groups.flatMap((group) => group.files) ?? [],
        limits: {
          maxFixCycles: this.config.autopilot.maxFixCycles,
          maxSpendUsd: this.config.budgets.autopilotPrUsd,
          maxRuntimeMs: this.config.autopilot.maxRuntimeMs,
          backoffSeconds: this.config.autopilot.backoffSeconds,
        },
        now: this.now(),
        headRelation: relation,
        fixer: this.fixer,
        apply: async (edits, message) => {
          const dir = state.integration?.path ?? this.git.repoRoot;
          for (const edit of edits) this.git.writeOwned(dir, edit.path, edit.content, state.plan?.groups.flatMap((group) => group.files) ?? []);
          const sha = await this.git.commitAll(dir, message);
          await this.pushBranch(pullRequest.branch);
          return { sha };
        },
        charge: (usage) => {
          if (!usage) return null;
          const record = this.remember(state, state.phase, "cheap", "local", this.config.providers.local?.model ?? "", usage, "unknown", cursor.fixCycles, "autopilot fix");
          return record.actualUsd;
        },
      });
      for (const reply of cycle.replies) await this.github.reply(reply.threadId, redact(reply.body));
      const at = this.iso();
      if (cycle.action === "merge-ready") {
        await this.store.update(state.taskId, cycle.reason, (task) => move({ ...task, autopilot: cycle.cursor }, "MERGE_READY", at));
        this.notify(cycle.reason);
        return done(cycle.reason, cycle.cursor);
      }
      if (cycle.action === "continue" && cycle.cursor.running) this.arm(cycle.cursor.backoffSeconds);
      if (cycle.action === "pause" || cycle.action === "blocked") {
        const phase = cycle.action === "blocked" ? "BLOCKED" : "PAUSED";
        await this.store.update(state.taskId, cycle.reason, (task) => move({ ...task, autopilot: cycle.cursor }, phase, at, cycle.reason));
        return fail(cycle.action === "blocked" ? "BLOCKED" : "PAUSED", cycle.reason);
      }
      await this.store.update(state.taskId, "autopilot poll", (task) => ({ ...task, autopilot: cycle.cursor, updatedAt: at }));
      return done(cycle.reason, cycle.cursor);
    } catch (error) {
      return this.asResult(error);
    }
  }

  async route(task: string): Promise<CommandResult> {
    try {
      const classification = await classifyTask(redact(task), { minConfidence: this.config.routing.minConfidence, classifier: this.classifier });
      const decision = decideRoute(classification, this.config, this.store.readMetrics(), { purpose: "preview", at: this.now() });
      return done(JSON.stringify({ classification, decision }, null, 2), { classification, decision });
    } catch (error) {
      return this.asResult(error);
    }
  }

  async cost(format = ""): Promise<CommandResult> {
    const records = this.store.readLedger();
    const summary = summarize(records);
    const task = this.active();
    const taskRecords = task ? records.filter((record) => record.taskId === task.taskId) : records;
    const taskSummary = summarize(taskRecords);
    const lines = [
      `Known spend $${summary.knownUsd.toFixed(4)} across ${records.length} record(s). Unknown usage records: ${summary.unknownRecords} (not counted as zero).`,
      `Task budget: ${taskSummary.knownUsd.toFixed(4)} / ${this.config.budgets.taskUsd} (${this.budgetFor(task?.taskId)}).`,
      `Daily budget: ${summary.knownUsd.toFixed(4)} / ${this.config.budgets.dailyUsd}.`,
      `By phase: ${JSON.stringify(summary.byPhase)}`,
      `By provider: ${JSON.stringify(summary.byProvider)}`,
      `By model: ${JSON.stringify(summary.byModel)}`,
    ];
    if (format.trim() === "csv") return done(toCsv(records), records);
    if (format.trim() === "json") return done(JSON.stringify({ summary, records }, null, 2), { summary, records });
    return done(lines.join("\n"), summary);
  }

  async status(): Promise<CommandResult> {
    const state = this.active();
    const auth = await Promise.all((["openai", "anthropic", "foundry", "local"] as ProviderId[]).map((provider) => this.authProbe.inspect(provider)));
    const budget = this.budgetFor(state?.taskId);
    const text = [
      state ? `Task ${state.taskId} phase ${state.phase}` : "No active task.",
      state?.approvedVersion ? `Approved plan v${state.approvedVersion}` : "No approved plan.",
      state?.blockedReason ? `Note: ${state.blockedReason}` : "",
      `Worktrees: ${state?.worktrees.map((item) => `${item.groupId}@${item.headSha.slice(0, 7)}`).join(", ") || "none"}`,
      `Integration: ${state?.integration?.sha ?? "none"}`,
      `PR: ${state?.pullRequest ? `#${state.pullRequest.number} ${state.pullRequest.headSha}` : "none"}`,
      `Budget: ${budget}`,
      ...auth.map((view) => `${view.provider}: ${view.status} (${view.method}) ${view.detail}`),
    ].filter(Boolean);
    return done(text.join("\n"), { state, auth, budget });
  }

  async resetPhase(): Promise<CommandResult> {
    try {
      const state = this.require();
      const handoff = await this.handoff(state, "manual", `# Manual reset\n\nPhase ${state.phase} kept. Artifacts were not deleted.\n`);
      await this.store.update(state.taskId, "manual context reset", (task) => ({ ...task, contextResets: [...task.contextResets, handoff], updatedAt: this.iso() }));
      return done(`Context reset (${handoff.mode}) while phase stayed ${state.phase}.`);
    } catch (error) {
      return this.asResult(error);
    }
  }

  async worktrees(arg = "", confirmed = false): Promise<CommandResult> {
    try {
      const command = arg.trim() || "status";
      const state = this.active();
      const live = await this.git.listWorktrees();
      if (command === "status" || command === "list") {
        const recorded = state?.worktrees ?? [];
        const lines = recorded.map((item) => {
          const found = live.find((entry) => entry.path === item.path);
          return `${item.groupId} ${item.branch} base ${item.baseSha.slice(0, 7)} head ${item.headSha.slice(0, 7)} ${found ? "present" : "missing"}`;
        });
        return done(lines.join("\n") || "No recorded worktrees.", { recorded, live });
      }
      if (command !== "cleanup") return fail("USAGE", "Use /worktrees status, list, or cleanup.");
      if (!state) return fail("NO_TASK", "No task to clean up.");
      const prActive = !!state.pullRequest && ["PUBLISHED", "AUTOPILOT", "MERGE_READY", "AWAITING_PUBLISH_APPROVAL"].includes(state.phase);
      if (prActive) return fail("PR_ACTIVE", "Cleanup is blocked while the pull request is active.");
      const removed: string[] = [];
      const skipped: string[] = [];
      for (const item of state.worktrees) {
        const merged = state.integration?.branch ? await this.git.isMerged(item.branch, state.integration.branch) : false;
        const safe = merged || item.abandoned || state.phase === "COMPLETE";
        if (!safe && !confirmed) {
          skipped.push(item.groupId);
          continue;
        }
        if (!safe && confirmed && this.config.worktrees.cleanupRequiresConfirmation) {
          const allowed = await this.confirm("Delete unmerged worktree", `Delete ${item.branch}?`);
          if (!allowed) {
            skipped.push(item.groupId);
            continue;
          }
        }
        await this.git.removeWorktree(item.path, item.branch);
        removed.push(item.groupId);
      }
      if (state.integration?.path && (state.phase === "COMPLETE" || confirmed)) {
        await this.git.removeWorktree(state.integration.path, state.integration.branch);
        removed.push("integration");
      }
      await this.store.update(state.taskId, "worktree cleanup", (task) => ({
        ...task,
        worktrees: task.worktrees.filter((item) => !removed.includes(item.groupId)),
        updatedAt: this.iso(),
      }));
      return done(`Removed ${removed.join(", ") || "nothing"}. Skipped ${skipped.join(", ") || "nothing"}.`);
    } catch (error) {
      return this.asResult(error);
    }
  }

  observeUsage(input: { provider: string; model: string; usage: TokenUsage }): CostRecord | undefined {
    const state = this.active();
    if (!state) return undefined;
    const known = input.usage.input !== null && input.usage.output !== null;
    return this.remember(state, state.phase, "interactive", input.provider, input.model, input.usage, "unknown", 0, known ? "observed assistant usage" : "observed assistant usage missing tokens");
  }

  async auth(arg = ""): Promise<CommandResult> {
    const [command, provider] = arg.trim().split(/\s+/, 2);
    if (command === "login") {
      if (provider === "foundry") return done("Foundry uses Azure CLI. Run `az login`, then /auth status. This extension does not collect an API key.");
      if (provider === "local") return done("Local inference uses the configured baseUrl. Start the server yourself, then /auth status. No key is written into the repo.");
      if (provider === "openai") {
        return done("OpenAI account login is Pi's `/login openai`. Choose Sign in with ChatGPT, not the API key prompt. This extension rejects OPENAI_API_KEY.");
      }
      if (provider === "anthropic") {
        return done("Anthropic account login is Pi's `/login anthropic` (Claude Pro/Max). This extension rejects ANTHROPIC_API_KEY. A subscription may still bill extra usage; this tool does not invent a different login.");
      }
      return fail("USAGE", "Use /auth login openai|anthropic|foundry|local.");
    }
    const views = await Promise.all((["openai", "anthropic", "foundry", "local"] as ProviderId[]).map((item) => this.authProbe.inspect(item)));
    return done(views.map((view) => `${view.provider}\t${view.status}\t${view.method}\t${view.detail}`).join("\n"), views);
  }

  private async runImplementation(
    state: TaskState,
    tier: Tier,
  ): Promise<{ ok: true; summary: string; handoff: string; usage: TokenUsage } | { ok: false; error: string; usage: TokenUsage }> {
    const plan = state.plan!;
    const baseSha = state.worktrees[0]?.baseSha ?? (await this.git.head());
    const heads = new Map(state.worktrees.map((item) => [item.groupId, item.headSha]));
    const usage = tier === "deterministic" ? knownZero() : emptyUsage();
    for (const wave of waves(plan.groups)) {
      const jobs: { groupId: string; record: WorktreeRecord; job: WorkerJob }[] = [];
      for (const group of wave) {
        const existing = state.worktrees.find((item) => item.groupId === group.id);
        const base = group.dependsOn[0] ? heads.get(group.dependsOn[0]) ?? baseSha : baseSha;
        const dir = existing?.path ?? path.join(this.store.root, "worktrees", state.taskId, group.id);
        const branch = existing?.branch ?? `${this.config.worktrees.branchPrefix}/${state.taskId}/${group.id}`;
        const created = existing ?? (await this.git.createWorktree({ dir, branch, baseSha: base }));
        const record: WorktreeRecord = existing ?? { groupId: group.id, branch, path: dir, baseSha: base, headSha: created.headSha };
        jobs.push({
          groupId: group.id,
          record,
          job: { id: group.id, files: group.files, summary: group.summary, tokenBudget: this.config.workers.tokenBudget, deadlineMs: this.config.workers.deadlineMs },
        });
      }
      const pool = await runWorkerPool({
        jobs: jobs.map((item) => item.job),
        concurrency: this.config.workers.concurrency,
        run: async (job) => {
          const group = plan.groups.find((item) => item.id === job.id)!;
          const located = jobs.find((item) => item.groupId === job.id)!;
          for (const edit of group.edits) this.git.writeOwned(located.record.path, edit.path, edit.content, group.files);
          if (group.edits.length > 0) located.record.headSha = await this.git.commitAll(located.record.path, group.summary);
          const testResults = [];
          for (const check of this.config.checks) {
            const result = await this.runner.run(check.command, check.args, located.record.path);
            testResults.push({
              name: check.name,
              command: check.command,
              args: check.args,
              cwd: located.record.path,
              exitCode: result.code,
              stdout: redact(result.stdout).slice(0, 2000),
              stderr: redact(result.stderr).slice(0, 2000),
              ran: true,
            });
          }
          const unresolved = testResults.filter((item) => item.exitCode !== 0).map((item) => `${item.name} exited ${item.exitCode}`);
          return { summary: group.summary, changedFiles: group.edits.map((edit) => edit.path), testResults, unresolvedIssues: unresolved, usage };
        },
      });
      if (pool.stopped !== "completed") {
        return { ok: false, error: `Workers stopped: ${pool.stopped}`, usage };
      }
      const failed = pool.artifacts.filter((item) => item.error || (item.artifact?.unresolvedIssues.length ?? 0) > 0);
      state = await this.store.update(state.taskId, `wave ${tier}`, (task) => ({
        ...task,
        worktrees: mergeWorktrees(task.worktrees, jobs.map((item) => item.record)),
        attempts: [...task.attempts, attempt(tier, this.providerLabel(tier), this.modelLabel(tier), failed.length ? "failure" : "success", this.iso())],
        updatedAt: this.iso(),
      }));
      for (const item of jobs) heads.set(item.groupId, item.record.headSha);
      if (failed.length > 0) return { ok: false, error: failed.map((item) => item.error ?? item.artifact?.unresolvedIssues.join("; ")).join("; "), usage };
    }
    const integrationBranch = `${this.config.worktrees.branchPrefix}/${state.taskId}/integration`;
    const integrationPath = path.join(this.store.root, "worktrees", state.taskId, "integration");
    const integrated = await this.git.integrate({
      integrationBranch,
      baseSha,
      worktreePath: integrationPath,
      branches: state.worktrees.map((item) => item.branch),
    });
    if (integrated.conflicts.length > 0) {
      return { ok: false, error: `Conflict integrating ${integrated.conflicts.map((item) => item.branch).join(", ")}`, usage };
    }
    await this.store.update(state.taskId, "integrated", (task) => ({
      ...task,
      integration: { branch: integrationBranch, sha: integrated.sha, path: integrationPath },
      updatedAt: this.iso(),
    }));
    this.store.writeText(state.taskId, "reports/implementation.json", JSON.stringify({ tier, integration: integrated.sha, worktrees: state.worktrees }, null, 2));
    return {
      ok: true,
      summary: `Implemented ${state.worktrees.length} worktree(s) on ${integrationBranch} at ${integrated.sha}.`,
      usage,
      handoff: [
        "# Handoff after implementation",
        "",
        `Integration ${integrationBranch} @ ${integrated.sha}`,
        `Base ${baseSha}`,
        ...state.worktrees.map((item) => `- ${item.groupId} ${item.branch} ${item.headSha}`),
        "",
        "Review the diff against the approved plan. Do not treat this note as a test pass.",
      ].join("\n"),
    };
  }

  private providerLabel(tier: Tier): string {
    return decideRoute({ task_type: "general", complexity: "low", risk: "low", required_capabilities: [], recommended_tier: tier, confidence: 1, reason_codes: [], source: "fallback" }, this.config, {}, { purpose: "preview" }).provider;
  }

  private modelLabel(tier: Tier): string {
    if (tier === "deterministic") return "deterministic";
    const provider = this.config.models[tier === "classifier" ? "classifier" : tier];
    return provider === "local" ? this.config.providers.local?.model ?? "" : provider === "foundry" ? this.config.providers.foundry?.deployments?.cheap ?? "" : this.config.providers[provider]?.model ?? "";
  }

  private remember(state: TaskState, phase: TaskState["phase"], tier: string, provider: string, model: string, usage: TokenUsage, outcome: CostRecord["outcome"], retries: number, reason: string): CostRecord {
    const record = buildCostRecord(
      { provider, model, phase, taskId: state.taskId, tier, usage, outcome, retries, reason, estimatedUsd: state.routing?.estimatedUsd ?? null },
      this.config.pricing,
      this.now(),
      this.id(),
    );
    this.store.appendLedger(record);
    return record;
  }

  private bumpMetric(taskType: string, tier: string, success: boolean): void {
    const metrics = this.store.readMetrics();
    const row = metrics[taskType] ?? {};
    const cell = row[tier] ?? { success: 0, failure: 0 };
    if (success) cell.success += 1;
    else cell.failure += 1;
    row[tier] = cell;
    metrics[taskType] = row;
    this.store.writeMetrics(metrics);
  }

  private budgetFor(taskId?: string): "ok" | "soft" | "hard" {
    const records = this.store.readLedger();
    const today = this.iso().slice(0, 10);
    const daily = summarize(records.filter((record) => record.at.slice(0, 10) === today));
    const task = summarize(taskId ? records.filter((record) => record.taskId === taskId) : []);
    const dailyStatus = budgetStatus(daily.knownUsd, this.config.budgets.dailyUsd, this.config.budgets.softWarningRatio);
    const taskStatus = budgetStatus(task.knownUsd, this.config.budgets.taskUsd, this.config.budgets.softWarningRatio);
    if (dailyStatus === "hard" || taskStatus === "hard") return "hard";
    if (dailyStatus === "soft" || taskStatus === "soft") return "soft";
    return "ok";
  }

  private disarm(): void {
    this.cancelPoll?.();
    this.cancelPoll = undefined;
  }

  private arm(backoffSeconds: number): void {
    if (!this.schedule) return;
    const delay = (backoffSeconds > 0 ? backoffSeconds : this.config.autopilot.pollSeconds) * 1000;
    this.cancelPoll = this.schedule(delay, () => {
      void this.autopilot();
    });
  }

  private async relation(previous: string, next: string): Promise<"fast-forward" | "force" | "unknown"> {
    if (!this.github) return "unknown";
    const ancestor = await this.github.isAncestor(previous, next);
    return ancestor ? "fast-forward" : "force";
  }

  private async handoff(state: TaskState, boundary: ContextReset["boundary"], body: string): Promise<ContextReset> {
    const relative = `handoffs/${boundary}.md`;
    const file = this.store.writeText(state.taskId, relative, redact(body));
    const result = this.session ? await this.session.reset({ boundary, handoff: redact(body) }) : { mode: "handoff-only" as const, cancelled: false };
    return { boundary, at: this.iso(), mode: result.mode, cancelled: result.cancelled, handoffFile: file };
  }

  private blank(taskId: string, request: string, at: string): TaskState {
    return {
      taskId,
      phase: "PLANNING",
      createdAt: at,
      updatedAt: at,
      phaseEnteredAt: at,
      request,
      publishApproved: false,
      worktrees: [],
      attempts: [],
      contextResets: [],
    };
  }

  private active(): TaskState | undefined {
    const id = this.store.readActive();
    return id ? this.store.load(id) : undefined;
  }

  private require(): TaskState {
    const state = this.active();
    if (!state) throw new WorkflowError("NO_TASK", "No active task.");
    return state;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private asResult(error: unknown): CommandResult {
    if (error instanceof WorkflowError) return fail(error.code, error.message);
    return fail("ERROR", redact((error as Error).message || "Unknown error"));
  }
}

function mergeWorktrees(current: WorktreeRecord[], next: WorktreeRecord[]): WorktreeRecord[] {
  const map = new Map(current.map((item) => [item.groupId, item]));
  for (const item of next) map.set(item.groupId, item);
  return [...map.values()];
}

function attempt(tier: Tier, provider: string, model: string, outcome: AttemptRecord["outcome"], at: string): AttemptRecord {
  return { tier, provider, model, outcome, at };
}

export function workflowFromCwd(cwd: string, auth: AuthProbe, extras: Partial<WorkflowOptions> = {}): Workflow {
  return new Workflow({ cwd, auth, ...extras });
}
