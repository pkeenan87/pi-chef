import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import { convertToLlm, isToolCallEventType, serializeConversation } from "@earendil-works/pi-coding-agent";
import { COMMANDS, helpText } from "./commands.js";
import { statSync } from "node:fs";
import { configPaths, DEFAULT_SESSION, loadConfig, parseModelRef, setBillingResolver, type WorkflowConfig } from "./config.js";
import type { FileAuthProbe } from "./providers/auth.js";
import { buildBashBlock, isDeniedCommand } from "./sandbox.js";
import type { BuildDriver, ChunkSession } from "./orchestrator/build.js";
import { createRuntime, registerChatProviders, type ProviderRuntime } from "./providers/runtime.js";
import { createRegistryChat, type PiRegistryLike } from "./providers/pi-chat.js";
import { Workflow } from "./orchestrator/service.js";
import { reviewPlan } from "./tools/plan-review.js";
import { asResult } from "./orchestrator/context.js";
import type { CommandResult, TokenUsage } from "./domain.js";
import { registerPlanTools, registerWebTools, type WebToolsDeps } from "./tools/index.js";
import { isReadOnlyCommand, PLAN_TOOL_NAMES, PLANNING_DISABLED_TOOLS, PLANNING_TOOLS } from "./tools/readonly-bash.js";
import { SEARCH_MODEL } from "./tools/web-search.js";

let active: Workflow | undefined;
let runtime: ProviderRuntime | undefined;
let cwd = process.cwd();
let piRef: Pick<ExtensionAPI, "registerProvider" | "sendUserMessage"> | undefined;
/** Last config read for a project root, keyed by the files' mtime and size. */
let loaded: { root: string; key: string; config: WorkflowConfig } | undefined;
/** Active tools before /plan restricted them, so they can be restored when planning ends. */
let toolsBeforePlan: string[] | undefined;
const TOOLS_ENTRY = "cost-workflow-tools";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
/** Signature of the provider and tier settings last registered with Pi. */
let registeredSignature: string | undefined;

export function bindWorkflow(workflow: Workflow | undefined): void {
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
 * One Workflow per project root. Later commands only rebind session/UI hooks, and a changed config file is
 * applied to the existing instance. Throws when the config is invalid.
 */
function workflowFor(root: string, ctx?: CommandContext): Workflow {
  const { config, changed } = refreshConfig(root);
  if (!active || root !== cwd) {
    active?.dispose();
    cwd = root;
    runtime = createRuntime(config, root);
    useBilling(runtime);
    active = new Workflow({ cwd: root, config, auth: runtime.auth, deciders: runtime.deciders });
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

type CommandContext = ExtensionContext & {
    newSession: (options?: { withSession?: (next: CommandContext) => Promise<void> }) => Promise<{ cancelled: boolean }>;
    compact?: (options?: { customInstructions?: string }) => void;
    sendUserMessage?: (text: string) => Promise<void> | void;
    waitForIdle?: () => Promise<void>;
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
 * The model /build wants a fresh session to start on (Pi starts it on the default model). Kept on globalThis because the
 * new session may load a fresh copy of this module.
 */
const RESTORE_MODEL = Symbol.for("pi-cost-router.restore-model");
type ModelRef = { provider: string; id: string };

/**
 * Resolves when the model restore started by this session's `session_start` has finished (the driver waits for it before
 * sending to a fresh /build session). On globalThis for the same reason as RESTORE_MODEL.
 */
const RESTORE_DONE = Symbol.for("pi-cost-router.restore-done");
/**
 * `setModel` of the newest extension instance, refreshed by every `session_start`. A command's own `pi` and ctx are dead
 * after /build opens a session, and the replacement ctx has no setModel (only `pi` has), so /build puts the user's model
 * back through this, which always belongs to the live session.
 */
const SET_MODEL = Symbol.for("pi-cost-router.set-model");
/** The last assistant text and abort flag of the run /build is waiting on, filled by the message_end and agent_settled handlers. */
const TURN = Symbol.for("pi-cost-router.turn");
const restoreSlot = globalThis as { [RESTORE_MODEL]?: ModelRef; [RESTORE_DONE]?: Promise<void>; [SET_MODEL]?: (model: never) => Promise<boolean>; [TURN]?: { lastText: string; aborted: boolean } };

/** Re-selects the model the replaced session was using, when the new session started on a different one. */
function restoreModel(pi: Partial<Pick<ExtensionAPI, "setModel">>, ctx: ExtensionContext): Promise<void> | undefined {
  const wanted = restoreSlot[RESTORE_MODEL];
  delete restoreSlot[RESTORE_MODEL];
  if (!wanted) return undefined;
  const current = (ctx as { model?: ModelRef }).model;
  if (current?.provider === wanted.provider && current.id === wanted.id) return undefined;
  const warn = () => {
    if (ctx.hasUI) ctx.ui.notify(`The new session started on ${current ? `${current.provider}/${current.id}` : "the default model"}. Run /model ${wanted.provider}/${wanted.id} to switch back.`, "warning");
  };
  const model = ctx.modelRegistry?.find(wanted.provider, wanted.id);
  if (!model || typeof pi.setModel !== "function") return void warn();
  return pi.setModel(model as never).then((ok) => (ok ? undefined : warn()), warn);
}

/**
 * Puts the session on `session.model` when pinning is on and the session started on another model. Not used while a
 * /build model is pending (that slot wins). One warning when the model is unknown or Pi refuses the switch.
 */
function pinSessionModel(pi: Partial<Pick<ExtensionAPI, "setModel">>, ctx: ExtensionContext): Promise<void> | undefined {
  const session = (active ?? tryWorkflowFor(ctx.cwd))?.config.session ?? DEFAULT_SESSION;
  const wanted = session.pin ? parseModelRef(session.model) : undefined;
  if (!wanted) return undefined;
  const current = (ctx as { model?: ModelRef }).model;
  if (current?.provider === wanted.provider && current.id === wanted.id) return undefined;
  const warn = () => {
    if (ctx.hasUI) ctx.ui.notify(`Could not switch to ${session.model}. Run /model ${session.model}, or set session.pin: false to keep your own model.`, "warning");
  };
  const model = ctx.modelRegistry?.find(wanted.provider, wanted.id);
  if (!model || typeof pi.setModel !== "function") return void warn();
  return pi.setModel(model as never).then((ok) => (ok ? undefined : warn()), warn);
}

/** Set when the soft-budget notice has been shown; reset by `session_start`. */
let softBudgetShown = false;

/**
 * Pi's `session_before_compact` hook: the summary comes from `session.compactionTier` (Haiku by default) instead of the
 * session model. Returns undefined, and so lets Pi compact as usual, on any problem or a hard budget. Never throws.
 */
async function compactWithCheapTier(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<SessionBeforeCompactResult | undefined> {
  try {
    const workflow = active ?? tryWorkflowFor(cwd);
    const registry = ctx.modelRegistry as unknown as PiRegistryLike | undefined;
    if (!workflow || !registry || event.signal?.aborted) return undefined;
    const { preparation } = event;
    const messages = preparation.isSplitTurn ? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages] : preparation.messagesToSummarize;
    const conversation = serializeConversation(convertToLlm(messages));
    if (!conversation.trim()) return undefined;
    const apiKeyFallback = (provider: string) => workflow.config.providers[provider as keyof WorkflowConfig["providers"]]?.apiKeyFallback === true;
    const result = await workflow.summarizeForCompaction(createRegistryChat(registry, apiKeyFallback), {
      conversation,
      previousSummary: preparation.previousSummary,
      customInstructions: event.customInstructions,
      signal: event.signal,
    });
    if (!result) return undefined;
    const { input, output, cacheRead, cacheWrite } = result.usage;
    const [i, o, r, w] = [input ?? 0, output ?? 0, cacheRead ?? 0, cacheWrite ?? 0];
    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        usage: { input: i, output: o, cacheRead: r, cacheWrite: w, totalTokens: i + o + r + w, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.record.actualUsd ?? 0 } },
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Pi's `input` hook, the budget gate. A hard budget stops a prompt before it reaches the model; commands (`/cost`,
 * `/status`, ...) always pass, and so does input an extension sent itself (/build and /plan check the budget on their own).
 * A soft budget shows one notice per session.
 */
function gateInput(event: InputEvent, ctx: ExtensionContext): InputEventResult {
  const proceed = { action: "continue" as const };
  try {
    if (event.source === "extension" || event.text.trimStart().startsWith("/")) return proceed;
    const workflow = active ?? tryWorkflowFor(cwd);
    const status = workflow?.budgetStatus(workflow.activeTaskId());
    if (status === "hard") {
      if (ctx.hasUI) ctx.ui.notify("Task or daily budget is exhausted. Run /cost for details.", "warning");
      return { action: "handled" };
    }
    if (status === "soft" && !softBudgetShown) {
      softBudgetShown = true;
      if (ctx.hasUI) ctx.ui.notify("Budget warning: spend is near the task or daily limit. Run /cost for details.", "warning");
    }
  } catch {
    /* a gate that cannot read the budget must not stop the user typing */
  }
  return proceed;
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

/**
 * The session driver for /build, the only code that opens Pi sessions for tickets. Each chunk gets a fresh session on
 * its routed model: `newSession` from the command ctx (never from a lifecycle handler), then `sendUserMessage` and
 * `waitForIdle` on the replacement ctx handed to `withSession`. After each replacement the old ctx and `pi` are dead,
 * so `live` always holds the newest ctx and the workflow is re-resolved from it on every call.
 */
function buildHost(ctx: CommandContext): { getWorkflow: () => Workflow; driver: BuildDriver } {
  let live: CommandContext = ctx;
  // Plain data captured before the first replacement: the model the user was on.
  const original = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  const getWorkflow = () => workflowFor(live.cwd, live);
  const driver: BuildDriver = {
    async fresh(model, run) {
      restoreSlot[RESTORE_MODEL] = { provider: model.provider, id: model.id };
      let opened = false;
      try {
        const result = await live.newSession({
          withSession: async (next) => {
            opened = true;
            replacementCtx = next;
            live = next;
            try {
              workflowFor(next.cwd, next);
            } catch {
              /* a config problem is reported by the next command */
            }
            // session_start starts the model switch without awaiting it; wait here so the ticket never runs on the wrong model.
            await restoreSlot[RESTORE_DONE];
            delete restoreSlot[RESTORE_DONE];
            const on = (next as { model?: ModelRef }).model;
            if (on && (on.provider !== model.provider || on.id !== model.id)) {
              throw new Error(`The new session is on ${on.provider}/${on.id}, not the routed ${model.provider}/${model.id}, so the ticket was not started. /build resumes it.`);
            }
            if (typeof next.sendUserMessage !== "function") throw new Error("This Pi session cannot send messages, so /build cannot run.");
            const session: ChunkSession = {
              async send(text) {
                restoreSlot[TURN] = { lastText: "", aborted: false };
                await next.sendUserMessage!(text);
                await next.waitForIdle?.();
                const turn = restoreSlot[TURN] ?? { lastText: "", aborted: false };
                delete restoreSlot[TURN];
                return { lastText: turn.lastText, aborted: turn.aborted };
              },
            };
            await run(session);
          },
        });
        if (result.cancelled || !opened) throw new Error("Pi did not open a new session for the next ticket (cancelled), so /build stopped. Run /build to resume.");
      } finally {
        delete restoreSlot[RESTORE_MODEL];
        delete restoreSlot[RESTORE_DONE];
        delete restoreSlot[TURN];
      }
    },
    async finish() {
      // With pinning on the session belongs on session.model; otherwise it goes back to the model the user was on.
      let target = original;
      try {
        const session = getWorkflow().config.session;
        if (session.pin) target = parseModelRef(session.model) ?? original;
      } catch {
        /* an unreadable config: put the user's model back */
      }
      if (!target) return;
      const now = (live as { model?: ModelRef }).model;
      if (now?.provider === target.provider && now.id === target.id) return;
      const model = live.modelRegistry?.find(target.provider, target.id);
      const set = restoreSlot[SET_MODEL];
      const ok = model && set ? await set(model as never).catch(() => false) : false;
      if (!ok && live.hasUI) live.ui.notify(`Run /model ${target.provider}/${target.id} to switch back to your model.`, "warning");
    },
  };
  return { getWorkflow, driver };
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
          if (spec.drive) {
            const host = buildHost(ctx as unknown as CommandContext);
            result = await spec.drive(host.getWorkflow, host.driver);
          } else result = await spec.run(workflow, args, ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : async () => false);
        } catch (error) {
          // An invalid config must reach the user as a failed command, not as an exception inside Pi.
          result = asResult(error);
        }
        // After a session replacement (for example /build opening a session per ticket) the captured ctx and pi throw on
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
    softBudgetShown = false;
    try {
      // Foundry, Vercel, and local models must be in Pi's registry before anything can select them.
      syncProviders(refreshConfig(ctx.cwd).config);
    } catch {
      /* a bad config is reported by the commands; it must not stop the session from starting */
    }
    restoreSlot[SET_MODEL] = typeof pi.setModel === "function" ? (model) => pi.setModel(model) : undefined;
    try {
      // A model /build routed for its ticket wins; otherwise the session goes onto session.model (when pinned).
      restoreSlot[RESTORE_DONE] = restoreSlot[RESTORE_MODEL] ? restoreModel(pi, ctx) : pinSessionModel(pi, ctx);
    } catch {
      /* the model stays as Pi chose it; /model switches it */
    }
  });
  pi.on("session_before_compact", (event, ctx) => compactWithCheapTier(event, ctx));
  pi.on("input", (event, ctx) => gateInput(event, ctx));
  pi.on("session_shutdown", () => {
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
    if (isToolCallEventType("bash", event) && active?.buildingTicket()) {
      const reason = buildBashBlock(event.input.command);
      if (reason) return { block: true, reason };
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
  pi.on("agent_settled", (event) => {
    if (event.aborted && restoreSlot[TURN]) restoreSlot[TURN].aborted = true;
  });
  pi.on("message_end", (event) => {
    const message = event.message;
    const turn = restoreSlot[TURN];
    if (turn && message.role === "assistant") {
      const text = Array.isArray(message.content) ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
      if (text.trim()) turn.lastText = text;
      if ("stopReason" in message && message.stopReason === "aborted") turn.aborted = true;
    }
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
  registerWorkflow(pi);
  registerExtensionTools(pi);
  // Register Foundry, Vercel, and local models at load time too, so `--model` and `--list-models` resolve them
  // before any session starts. session_start registers them again with the session's cwd.
  try {
    syncProviders(refreshConfig(process.cwd()).config);
  } catch {
    /* session_start retries; a bad config is reported by the commands */
  }
}
