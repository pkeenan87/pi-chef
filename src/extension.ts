import type { ExtensionAPI, ExtensionContext, ModelRoute } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { COMMANDS, helpText } from "./commands.js";
import { statSync } from "node:fs";
import { configPaths, loadConfig, setBillingResolver, type WorkflowConfig } from "./config.js";
import type { FileAuthProbe } from "./providers/auth.js";
import { GhCli } from "./github/gh.js";
import { isDeniedCommand } from "./sandbox.js";
import { createRuntime, registerChatProviders, type ProviderRuntime } from "./providers/runtime.js";
import { createRegistryChat, type PiRegistryLike } from "./providers/pi-chat.js";
import { Workflow, type SessionControl } from "./orchestrator/service.js";
import { reviewPlan } from "./tools/plan-review.js";
import { asResult } from "./orchestrator/context.js";
import { declaredLimits, routeVirtual, VIRTUAL_THINKING_LEVELS, type RouterRegistry, type RouterRequest, type RouterState } from "./router/virtual.js";
import { fallbackClassification } from "./router/classify.js";
import type { Availability } from "./router/select.js";
import { ACCOUNT_PROVIDERS, type CommandResult, type TokenUsage } from "./domain.js";
import { registerPlanTools, registerWebTools, type WebToolsDeps } from "./tools/index.js";
import { isReadOnlyCommand, PLAN_TOOL_NAMES, PLANNING_DISABLED_TOOLS, PLANNING_TOOLS } from "./tools/readonly-bash.js";
import { CHILD_ENV, runTicketInChild, type TicketRunner } from "./agents/pi-runner.js";
import { registerChildMode } from "./child-mode.js";
import { SEARCH_MODEL } from "./tools/web-search.js";

let active: Workflow | undefined;
let runtime: ProviderRuntime | undefined;
let cwd = process.cwd();
let cancelPoll: (() => void) | undefined;
let piRef: Pick<ExtensionAPI, "registerProvider" | "sendUserMessage"> | undefined;
/** Last config read for a project root, keyed by the files' mtime and size. */
let loaded: { root: string; key: string; config: WorkflowConfig } | undefined;
/** Active tools before /plan restricted them, so they can be restored when planning ends. */
let toolsBeforePlan: string[] | undefined;
const TOOLS_ENTRY = "cost-workflow-tools";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
/** Signature of the provider and tier settings last registered with Pi. */
let registeredSignature: string | undefined;

/** Production ticket runner: a fresh child pi per ticket attempt. Vercel's token file is refreshed first. */
const childTicketRunner: TicketRunner = async (input) => {
  if (input.model.provider === "vercel") await runtime?.vercel?.getToken();
  return runTicketInChild(input);
};

function clearPoll(): void {
  cancelPoll?.();
  cancelPoll = undefined;
}

function schedule(delayMs: number, run: () => void): () => void {
  clearPoll();
  const timer = setTimeout(run, delayMs);
  cancelPoll = () => clearTimeout(timer);
  return clearPoll;
}

export function bindWorkflow(workflow: Workflow | undefined): void {
  clearPoll();
  // A workflow bound from outside brings its own auth probe; prices fall back to subscription billing.
  setBillingResolver(undefined);
  active = workflow;
  loaded = undefined;
  registeredSignature = undefined;
  if (workflow) cwd = workflow.cwd;
}

export function currentWorkflow(): Workflow | undefined {
  return active;
}

function stamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "-";
  }
}

/**
 * Config for a project root, reloaded when either config file changes. Throws the config error when the
 * files are invalid; the previous good config is kept so a later fix applies without a restart.
 */
function refreshConfig(root: string): { config: WorkflowConfig; changed: boolean } {
  const { projectPath, userPath } = configPaths(root);
  const key = `${stamp(projectPath)}|${stamp(userPath)}`;
  if (loaded && loaded.root === root && loaded.key === key) return { config: loaded.config, changed: false };
  const config = loadConfig(root);
  const changed = !!loaded && loaded.root === root;
  loaded = { root, key, config };
  return { config, changed };
}

/** Registers Foundry, Vercel, and local chat models with Pi, once per distinct provider/tier configuration. */
function syncProviders(config: WorkflowConfig): void {
  if (!piRef || typeof piRef.registerProvider !== "function") return;
  const signature = JSON.stringify([config.providers, config.tiers, config.models]);
  if (signature === registeredSignature) return;
  registeredSignature = signature;
  registerChatProviders(piRef as ExtensionAPI, config, { vercel: runtime?.vercel });
}

/** Prices follow the credential Pi holds: API-key rows while a provider is on an API key. */
function useBilling(next: ProviderRuntime): void {
  const probe = next.auth as Partial<Pick<FileAuthProbe, "billing">>;
  setBillingResolver(typeof probe.billing === "function" ? (provider) => probe.billing!(provider) : undefined);
}

/**
 * One Workflow per project root: the autopilot timer and its cancel handle live on the instance, so
 * rebuilding it per command would orphan a running timer. Later commands only rebind session/UI hooks,
 * and a changed config file is applied to the existing instance. Throws when the config is invalid.
 */
function workflowFor(root: string, ctx?: CommandContext): Workflow {
  const { config, changed } = refreshConfig(root);
  if (!active || root !== cwd) {
    clearPoll();
    active?.dispose();
    cwd = root;
    runtime = createRuntime(config, root);
    useBilling(runtime);
    active = new Workflow({ cwd: root, config, auth: runtime.auth, deciders: runtime.deciders, github: new GhCli(root), schedule, ticketRunner: childTicketRunner });
    // A watcher that was running before a restart or session reset keeps watching.
    active.resumeAutopilot();
  } else if (changed) {
    runtime = createRuntime(config, root);
    useBilling(runtime);
    active.reconfigure(config, { auth: runtime.auth, deciders: runtime.deciders });
    try {
      syncProviders(config);
    } catch {
      /* provider registration problems show up when the model is used */
    }
  }
  if (ctx) {
    const registry = (ctx as { modelRegistry?: PiRegistryLike }).modelRegistry;
    // A replacement session's ctx brings its own sendUserMessage; the captured pi is stale after a replacement.
    const send = typeof ctx.sendUserMessage === "function" ? ctx.sendUserMessage.bind(ctx) : piRef && typeof piRef.sendUserMessage === "function" ? piRef.sendUserMessage.bind(piRef) : undefined;
    const apiKeyFallback = (provider: string) => active!.config.providers[provider as keyof WorkflowConfig["providers"]]?.apiKeyFallback === true;
    active.bind({
      chat: registry ? createRegistryChat(registry, apiKeyFallback) : undefined,
      status: ctx.hasUI && ctx.ui.setStatus ? (text) => ctx.ui.setStatus("cost-router", text) : undefined,
      planStatus: ctx.hasUI && ctx.ui.setStatus ? (text) => ctx.ui.setStatus("cost-plan", text) : undefined,
      startTurn: send ? (text) => void send(text) : undefined,
      session: sessionFrom(ctx),
      confirm: ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : undefined,
      notify: ctx.hasUI ? (message) => ctx.ui.notify(message, "warning") : undefined,
      progress: ctx.hasUI ? (message) => ctx.ui.notify(message, "info") : undefined,
      report: (markdown) => showPlanMessage(ctx, markdown, "cost-report"),
      review: ctx.hasUI && typeof ctx.ui.custom === "function" ? (input) => reviewPlan(ctx, input) : undefined,
      show: (text) => showPlanMessage(ctx, text),
    });
  }
  return active;
}

type CommandContext = ExtensionContext &
  Parameters<typeof sessionFrom>[0] & {
    sendUserMessage?: (text: string) => Promise<void> | void;
    sendMessage?: (message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean }) => Promise<void> | void;
  };

/**
 * The context a command must use once it has replaced the session (Pi invalidates the old ctx and pi then).
 * Set from `withSession` and read by the command handler after `run` returns.
 */
let replacementCtx: CommandContext | undefined;

/** Posts a plan as a displayed message in the chat. Uses the replacement ctx's sendMessage, else the extension's. */
function showPlanMessage(ctx: CommandContext, text: string, customType = "cost-plan"): void {
  const message = { customType, content: text, display: true };
  try {
    if (typeof ctx.sendMessage === "function") void ctx.sendMessage(message, { triggerTurn: false });
    else if (piRef && typeof (piRef as Partial<ExtensionAPI>).sendMessage === "function") void (piRef as ExtensionAPI).sendMessage(message, { triggerTurn: false });
  } catch {
    /* a stale or headless session: the plan file on disk is still the record */
  }
}

/**
 * The model to put back after a handoff opens a new session (Pi starts it on the default model, which drops
 * cost-opt/auto). Kept on globalThis because the new session may load a fresh copy of this module.
 */
const RESTORE_MODEL = Symbol.for("pi-cost-router.restore-model");
type ModelRef = { provider: string; id: string };
const restoreSlot = globalThis as { [RESTORE_MODEL]?: ModelRef };

/** Re-selects the model the replaced session was using, when the new session started on a different one. */
function restoreModel(pi: Partial<Pick<ExtensionAPI, "setModel">>, ctx: ExtensionContext): void {
  const wanted = restoreSlot[RESTORE_MODEL];
  delete restoreSlot[RESTORE_MODEL];
  if (!wanted) return;
  const current = (ctx as { model?: ModelRef }).model;
  if (current?.provider === wanted.provider && current.id === wanted.id) return;
  const warn = () => {
    if (ctx.hasUI) ctx.ui.notify(`The new session started on ${current ? `${current.provider}/${current.id}` : "the default model"}. Run /model ${wanted.provider}/${wanted.id} to switch back.`, "warning");
  };
  const model = ctx.modelRegistry?.find(wanted.provider, wanted.id);
  if (!model || typeof pi.setModel !== "function") return warn();
  pi.setModel(model as never).then((ok) => (ok ? undefined : warn()), warn);
}

function sessionFrom(ctx: { newSession: ExtensionContext extends never ? never : (options?: { withSession?: (next: CommandContext) => Promise<void> }) => Promise<{ cancelled: boolean }>; compact: (options?: { customInstructions?: string }) => void }): SessionControl {
  return {
    async reset({ boundary, handoff }) {
      const model = (ctx as { model?: ModelRef }).model;
      if (model) restoreSlot[RESTORE_MODEL] = { provider: model.provider, id: model.id };
      try {
        const result = await ctx.newSession({
          withSession: async (next) => {
            // Everything after this point must use `next`: Pi has invalidated the ctx and pi this command captured.
            replacementCtx = next;
            try {
              workflowFor(next.cwd, next);
            } catch {
              /* a config problem is reported by the next command */
            }
            await next.sendMessage!(
              { customType: "cost-handoff", content: handoff, display: true, details: { boundary } },
              { triggerTurn: false },
            );
          },
        });
        // Consumed by the new session's session_start; a cancelled replacement must not leave it for a later one.
        delete restoreSlot[RESTORE_MODEL];
        return { mode: "new-session", cancelled: result.cancelled };
      } catch {
        delete restoreSlot[RESTORE_MODEL];
        ctx.compact({ customInstructions: "Keep .pi-workflows artifacts. Do not drop the durable task files." });
        return { mode: "compact", cancelled: false };
      }
    },
  };
}

/**
 * While /plan runs the model gets read-only tools plus the plan tools; otherwise the plan tools are hidden.
 * Called at every agent start and end and after each command, so a restart or pause cannot leave it stuck.
 */
function syncPlanTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools"> & Partial<Pick<ExtensionAPI, "getAllTools" | "appendEntry">>): void {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const planning = !!(active ?? tryWorkflowFor(cwd))?.planningStage();
  const current = pi.getActiveTools();
  if (planning) {
    if (!toolsBeforePlan) {
      // Plan tools already active with no saved set (a reload lost it): the current set is the restricted one, so add Pi's defaults back.
      toolsBeforePlan = current.some((name) => PLAN_TOOL_NAMES.includes(name)) ? withDefaultTools(pi, current.filter((name) => !PLAN_TOOL_NAMES.includes(name))) : current;
      // Persisted so a reload in the middle of /plan still knows what to give back.
      pi.appendEntry?.(TOOLS_ENTRY, { tools: toolsBeforePlan });
    }
    const base = toolsBeforePlan.filter((name) => !PLANNING_DISABLED_TOOLS.includes(name));
    const next = [...new Set([...base, ...PLANNING_TOOLS])];
    if (next.length !== current.length || next.some((name) => !current.includes(name))) pi.setActiveTools(next);
  } else {
    const remembered = toolsBeforePlan;
    let base = (remembered ?? current).filter((name) => !PLAN_TOOL_NAMES.includes(name));
    // Plan tools still active with no record of the earlier set means the record was lost (a reload): give back the default tools Pi has.
    if (!remembered && current.some((name) => PLAN_TOOL_NAMES.includes(name))) base = withDefaultTools(pi, base);
    if (remembered) pi.appendEntry?.(TOOLS_ENTRY, { tools: null });
    toolsBeforePlan = undefined;
    if (base.length !== current.length || base.some((name) => !current.includes(name))) pi.setActiveTools(base);
  }
}

/** `tools` plus whichever of Pi's default tools (read, bash, edit, write) Pi has registered. */
function withDefaultTools(pi: Partial<Pick<ExtensionAPI, "getAllTools">>, tools: string[]): string[] {
  const known = new Set((typeof pi.getAllTools === "function" ? pi.getAllTools() : []).map((tool) => tool.name));
  return [...new Set([...tools, ...DEFAULT_TOOLS.filter((name) => known.has(name))])];
}

/** Reads the tool set saved when /plan began, from the session's own entries. */
function restoreToolsBeforePlan(ctx: ExtensionContext): void {
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== TOOLS_ENTRY) continue;
      const tools = (entry.data as { tools?: unknown } | undefined)?.tools;
      toolsBeforePlan = Array.isArray(tools) && tools.every((name) => typeof name === "string") ? (tools as string[]) : undefined;
    }
  } catch {
    /* no saved set: syncPlanTools falls back to Pi's default tools */
  }
}

export function registerWorkflow(pi: ExtensionAPI): void {
  for (const spec of COMMANDS) {
    pi.registerCommand(spec.name, {
      description: spec.description,
      getArgumentCompletions: (prefix) => spec.complete(prefix),
      handler: async (args, ctx) => {
        if (args.trim() === "help" || args.trim() === "--help") {
          ctx.ui.notify(spec.description, "info");
          return;
        }
        let result: CommandResult;
        replacementCtx = undefined;
        try {
          const workflow = workflowFor(ctx.cwd, ctx as unknown as CommandContext);
          result = await spec.run(workflow, args, ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : async () => false);
        } catch (error) {
          // An invalid config must reach the user as a failed command, not as an exception inside Pi.
          result = asResult(error);
        }
        // After a session replacement (for example the handoff in /approve-plan) the captured ctx and pi throw on
        // use. The new session's session_start already synced the plan tools, so only the result is shown, through
        // the replacement ctx.
        const live: ExtensionContext = replacementCtx ?? ctx;
        const replaced = !!replacementCtx;
        replacementCtx = undefined;
        if (!replaced) syncPlanTools(pi);
        try {
          if (live.hasUI) {
            live.ui.setStatus("cost-workflow", result.ok ? result.text.split("\n")[0] : undefined);
            live.ui.notify(result.text.slice(0, 1500), result.ok ? "info" : "warning");
          }
        } catch {
          /* the session was replaced again or closed; the result is in the task's event log */
        }
      },
    });
  }
  pi.registerCommand("cost-help", {
    description: "List cost-workflow commands.",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(helpText(), "info");
    },
  });
  piRef = pi;
  pi.on("session_start", (_event, ctx) => {
    // A new session may start with an empty provider registry, so register again.
    registeredSignature = undefined;
    try {
      const workflow = workflowFor(ctx.cwd);
      for (const warning of workflow.config.warnings ?? []) if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    } catch (error) {
      // The router and tools still register; each command reports the config error when it runs.
      if (ctx.hasUI) ctx.ui.notify(`Cost workflow config problem: ${asResult(error).text}`, "warning");
    }
    pi.appendEntry("cost-workflow", { cwd: ctx.cwd });
    // A /plan that was running before a restart resumes with its tools and progress line.
    toolsBeforePlan = undefined;
    restoreToolsBeforePlan(ctx);
    syncPlanTools(pi);
    const progress = active?.planningStatus();
    if (progress && ctx.hasUI) ctx.ui.setStatus("cost-plan", progress);
    registerRouter(pi, { cwd: ctx.cwd, modelRegistry: ctx.modelRegistry });
    // After a handoff's new session, put back the model the previous session used (normally cost-opt/auto).
    try {
      restoreModel(pi, ctx);
    } catch {
      /* the model stays as Pi chose it; /model switches it */
    }
  });
  pi.on("session_shutdown", () => {
    clearPoll();
    active?.dispose();
    active = undefined;
  });
  pi.on("before_agent_start", (event) => {
    syncPlanTools(pi);
    if (event.messageType !== "user") return undefined;
    const prompt = active?.planningPrompt();
    return prompt ? { message: { customType: "plan-interview-context", content: prompt, display: false } } : undefined;
  });
  pi.on("agent_end", () => {
    syncPlanTools(pi);
  });
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("bash", event) && active?.planningStage() && !isReadOnlyCommand(event.input.command, active.cwd)) {
      return { block: true, reason: "Planning is read-only: this command is not on the read-only allowlist. Use read, grep, find, ls, or a plain read-only command." };
    }
    if (isToolCallEventType("bash", event) && isDeniedCommand(event.input.command)) {
      return { block: true, reason: "Blocked destructive command. It stays blocked until a person runs an approved command." };
    }
    if (isToolCallEventType("powershell", event) && isDeniedCommand(event.input.command)) {
      return { block: true, reason: "Blocked destructive command." };
    }
    return undefined;
  });
  pi.on("user_bash", (event) => {
    if (isDeniedCommand(event.command)) {
      return { result: { output: "Blocked destructive command.", exitCode: 126, cancelled: false, truncated: false } };
    }
    return undefined;
  });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || !("usage" in message) || !message.usage) return;
    // A failed attempt that Pi retries (possibly on another model) bills nothing: the retry ledgers its own message.
    const stop = "stopReason" in message ? message.stopReason : undefined;
    if ((stop === "error" || stop === "aborted") && !message.usage.input && !message.usage.output && !message.usage.cacheRead && !message.usage.cacheWrite) return;
    const usage: TokenUsage = {
      input: typeof message.usage.input === "number" ? message.usage.input : null,
      output: typeof message.usage.output === "number" ? message.usage.output : null,
      cacheRead: typeof message.usage.cacheRead === "number" ? message.usage.cacheRead : null,
      cacheWrite: typeof message.usage.cacheWrite === "number" ? message.usage.cacheWrite : null,
      requests: 1,
    };
    // With no workflow yet, build one for the project so the turn still counts toward the daily limit.
    (active ?? tryWorkflowFor(cwd))?.observeUsage({ provider: message.provider, model: message.model, usage });
  });
}

/** The workflow for a project root, or undefined when its config is invalid. */
function tryWorkflowFor(root: string): Workflow | undefined {
  try {
    return workflowFor(root);
  } catch {
    return undefined;
  }
}

/** Where the router resolves config and the workflow: the launch cwd until a session starts, then the session's. */
type RouterHost = { cwd: string; modelRegistry?: ExtensionContext["modelRegistry"] };

function registerRouter(pi: ExtensionAPI, fallback: RouterHost): void {
  try {
    // Foundry, Vercel, and local models must be in Pi's registry before the router can return them.
    syncProviders(refreshConfig(fallback.cwd).config);
  } catch {
    /* a bad config is reported by the commands; it must not stop the session from starting */
  }
  // Reloaded whenever either config file changes, so edits apply without restarting Pi.
  const configFor = (): WorkflowConfig => {
    const { config, changed } = refreshConfig(fallback.cwd);
    if (changed) syncProviders(config);
    return config;
  };
  let limits: { contextWindow?: number; maxTokens?: number } = {};
  try {
    limits = declaredLimits(refreshConfig(fallback.cwd).config, (provider, id) => fallback.modelRegistry?.find(provider, id) as { contextWindow?: number; maxTokens?: number } | undefined);
  } catch {
    /* limits stay unknown */
  }
  pi.registerVirtualModel<RouterState>({
    provider: "cost-opt",
    id: "auto",
    name: "Cost-optimized auto",
    thinkingLevels: [...VIRTUAL_THINKING_LEVELS],
    ...limits,
    async route(request, ctx) {
      type PiModel = (typeof request)["model"];
      const registry = ctx.modelRegistry as unknown as RouterRegistry<PiModel>;
      // Build the workflow if needed so the daily limit applies even before any task exists.
      const workflow = currentWorkflow() ?? tryWorkflowFor(fallback.cwd);
      const result = await routeVirtual<PiModel>(request as unknown as RouterRequest<PiModel>, {
        registry,
        now: () => workflow?.now() ?? new Date(),
        classify: async (text) => (workflow ? workflow.classifyChat(text) : fallbackClassification(text, "virtual_route")),
        async snapshot() {
          const taskId = workflow?.activeTaskId();
          // Provider readiness: the auth probe, with the registry as the truth for account-login providers.
          const availability: Availability = workflow ? await workflow.availability() : {};
          const allowed = configFor().providers;
          for (const provider of ACCOUNT_PROVIDERS) {
            const ok = registry.getAvailable().some((item) => item.provider === provider && (registry.isUsingOAuth?.(item) || allowed[provider]?.apiKeyFallback === true));
            availability[provider] = { ok, detail: "no account login" };
          }
          return {
            config: configFor(),
            table: workflow?.store.readMetrics() ?? {},
            availability,
            budget: workflow ? workflow.checkBudget(taskId) : "ok",
            budgetRemainingUsd: workflow?.budgetRemainingUsd(taskId),
            quota: workflow?.quotaUsage(),
          };
        },
        recordFailure: (input) => workflow?.recordChatFailure(input),
        // The footer shows the routed model natively; chat turns only add a route event to the active task's log.
        onRoute: async (event) => {
          const taskId = workflow?.activeTaskId();
          if (workflow && taskId) await workflow.announce(taskId, event.purpose, event, () => undefined);
        },
        // Pi reads the Vercel token from the env file, so make sure the CLI has refreshed it first.
        apiKeyFallback: (provider) => configFor().providers[provider as keyof WorkflowConfig["providers"]]?.apiKeyFallback === true,
        prepare: async (candidate) => {
          if (candidate.provider === "vercel") await runtime?.vercel?.getToken();
        },
      });
      return result as unknown as ModelRoute<RouterState>;
    },
  });
}

/** Registers web_search and web_fetch. Search is budget-gated and ledgered through the active workflow. */
export function registerExtensionTools(pi: Pick<ExtensionAPI, "registerTool">, overrides: Partial<WebToolsDeps> = {}): void {
  registerPlanTools(pi, currentWorkflow);
  registerWebTools(pi, {
    budgetCheck: () => {
      const workflow = currentWorkflow();
      if (!workflow) return;
      workflow.showStatus(`anthropic/${SEARCH_MODEL} · web_search`);
      if (workflow.checkBudget(workflow.activeTaskId()) === "hard") {
        throw new Error("Task or daily budget is exhausted. web_search was not called. Run /cost for details.");
      }
    },
    onUsage: (record) => {
      currentWorkflow()?.recordWebSearch(record);
    },
    ...overrides,
  });
}

export default function extension(pi: ExtensionAPI): void {
  // A ticket child process loads providers and web tools only (see child-mode.ts).
  if (process.env[CHILD_ENV] === "1") {
    registerChildMode(pi);
    return;
  }
  registerWorkflow(pi);
  registerExtensionTools(pi);
  // Register cost-opt/auto at load time too, so `--model cost-opt/auto`, settings defaults, and `--list-models`
  // resolve it before any session starts. session_start registers it again with the session's cwd and registry.
  try {
    registerRouter(pi, { cwd: process.cwd() });
  } catch {
    /* session_start retries; a bad config is reported by the commands */
  }
}
