import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { COMMANDS } from "./commands.js";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { contextMismatch, probeLocalContext } from "./providers/local-context.js";
import { ConfigFileError, configPaths, displayPath, loadConfig, type WorkflowConfig } from "./config.js";
import { isDeniedCommand } from "./sandbox.js";
import type { BuildDriver } from "./orchestrator/build.js";
import { createHerdrClient, type HerdrClient } from "./herdr/client.js";
import { ticketHost } from "./runner/host.js";
import { herdrSpace, NEEDS_HERDR, runTicket } from "./runner/ticket.js";
import { registerLocalProvider } from "./providers/runtime.js";
import { createRegistryChat, type PiRegistryLike } from "./providers/pi-chat.js";
import { registryProblem, type UsableRegistry } from "./providers/usable.js";
import { Workflow } from "./orchestrator/service.js";
import { presentForDecision } from "./tools/plan-review.js";
import { asResult } from "./orchestrator/context.js";
import { redact } from "./redact.js";
import { WorkflowError, type CommandResult } from "./domain.js";
import { usageOfMessage } from "./usage-message.js";
import { registerPlanTools, registerWebTools, type WebToolsDeps } from "./tools/index.js";
import { isReadOnlyCommand, PLAN_TOOL_NAMES, PLANNING_DISABLED_TOOLS, PLANNING_TOOLS } from "./tools/readonly-bash.js";
import { SEARCH_MODEL } from "./tools/web-search.js";

let active: Workflow | undefined;
let cwd = process.cwd();
let piRef: Pick<ExtensionAPI, "registerProvider" | "sendUserMessage"> | undefined;
/** Last config read for a project root, keyed by the files' mtime and size. */
let loaded: { root: string; key: string; config: WorkflowConfig } | undefined;
/** Active tools before /plan restricted them, so they can be restored when planning ends. */
let toolsBeforePlan: string[] | undefined;
const TOOLS_ENTRY = "chef-tools";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
/**
 * Where provider registration goes: the live session's `pi.registerProvider`, and the signature of the `local` section
 * last registered there. On globalThis because Pi may load a fresh copy of this module for each session, and
 * the copy running /build would otherwise register with a replaced session's pi, whose registry nothing reads.
 */
const PROVIDERS_SLOT = Symbol.for("pi-chef.providers");
const providerSlot = globalThis as { [PROVIDERS_SLOT]?: { register: (name: string, config: unknown) => void; signature?: string } };

/** Tests bind a fake herdr client here; unset, the real `hc` is used. */
let herdrClientFactory: (() => HerdrClient) | undefined;
export function bindHerdrClient(factory: (() => HerdrClient) | undefined): void {
  herdrClientFactory = factory;
}

/** The herdr client for ticket tabs and agent reviews. Creating it runs nothing; `hc` is called when a tab is opened. */
function herdrClient(): HerdrClient {
  return (herdrClientFactory ?? (() => createHerdrClient()))();
}

/** Points registration at `pi` (a new session's registry starts empty, so nothing counts as registered yet). */
function registerWith(pi: Partial<Pick<ExtensionAPI, "registerProvider">>): void {
  if (typeof pi.registerProvider === "function") providerSlot[PROVIDERS_SLOT] = { register: pi.registerProvider.bind(pi) as (name: string, config: unknown) => void };
}

export function bindWorkflow(workflow: Workflow | undefined): void {
  active = workflow;
  loaded = undefined;
  const slot = providerSlot[PROVIDERS_SLOT];
  if (slot) slot.signature = undefined;
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
  // Every candidate (.yaml and .yml) is stamped, so adding, removing, or editing whichever file is used reloads.
  const key = configPaths(root).watch.map(stamp).join("|");
  if (loaded && loaded.root === root && loaded.key === key) return { config: loaded.config, changed: false };
  const config = loadConfig(root);
  const changed = !!loaded && loaded.root === root;
  loaded = { root, key, config };
  return { config, changed };
}

/** Registers the `local` section with Pi as provider "local", once per distinct `local` configuration. */
function syncProviders(config: WorkflowConfig): void {
  const slot = providerSlot[PROVIDERS_SLOT];
  if (!slot) return;
  const signature = JSON.stringify(config.local ?? null);
  if (signature === slot.signature) return;
  slot.signature = signature;
  const errors: string[] = [];
  registerLocalProvider({ registerProvider: slot.register }, config.local, errors);
  // Each provider is tried on its own; what Pi refused is reported, never swallowed.
  if (errors.length > 0) throw new Error(errors.join("; "));
}

/** Notices from places with no UI (extension load, a command with no ctx); shown by the next session_start. */
const deferredNotices: string[] = [];

/**
 * What to tell the user about a config or registration failure: redacted, and naming the file when one was rejected.
 * A rejected file stops chef commands (policy fields such as budgets and allowlists come from it), so the notice says so.
 */
function problemNotice(error: unknown): string {
  if (error instanceof ConfigFileError) {
    const reason = error.reason.split(homedir()).join("~");
    return `${displayPath(error.file)} was ignored; built-in defaults are in use, and chef commands stay stopped until it is fixed. ${reason}`;
  }
  const text = asResult(error).text;
  return error instanceof WorkflowError ? `Chef config problem: ${text}` : `Chef could not register its models with Pi: ${text}`;
}

function tell(ctx: ExtensionContext | undefined, text: string): void {
  try {
    if (ctx?.hasUI) ctx.ui.notify(text, "warning");
    else deferredNotices.push(text);
  } catch {
    deferredNotices.push(text);
  }
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
    active = new Workflow({ cwd: root, config });
  } else if (changed) {
    active.reconfigure(config);
    try {
      syncProviders(config);
    } catch (error) {
      tell(ctx, problemNotice(error));
    }
  }
  if (ctx) {
    const registry = (ctx as { modelRegistry?: PiRegistryLike }).modelRegistry;
    const send = typeof ctx.sendUserMessage === "function" ? ctx.sendUserMessage.bind(ctx) : piRef && typeof piRef.sendUserMessage === "function" ? piRef.sendUserMessage.bind(piRef) : undefined;
    const plainChat = registry ? createRegistryChat(registry) : undefined;
    active.bind({
      registry: registry as unknown as UsableRegistry | undefined,
      chat: plainChat,
      // Routes and planning stages redraw the one status line; its text is derived from the task, not passed in.
      status: ctx.hasUI ? () => refreshStatus(ctx) : undefined,
      planStatus: ctx.hasUI ? () => refreshStatus(ctx) : undefined,
      startTurn: send ? (text) => void send(text) : undefined,
      herdr: herdrClient(),
      ticketModePath: fileURLToPath(new URL("./ticket-mode.ts", import.meta.url)),
      confirm: ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : undefined,
      notify: ctx.hasUI ? (message) => ctx.ui.notify(message, "warning") : undefined,
      progress: ctx.hasUI ? (message) => ctx.ui.notify(message, "info") : undefined,
      report: (markdown) => showPlanMessage(ctx, markdown, "chef-report"),
      // Commands run while Pi is idle, so sendMessage shows the plan at once; there is no popup.
      review: ctx.hasUI && typeof ctx.ui.select === "function" ? (input) => presentForDecision(ctx, input, (markdown) => showPlanMessage(ctx, markdown, "chef-report")) : undefined,
      edit: ctx.hasUI && typeof ctx.ui.editor === "function" ? (title, prefill) => ctx.ui.editor(title, prefill) : undefined,
      show: (text) => showPlanMessage(ctx, text),
    });
  }
  return active;
}

type CommandContext = ExtensionContext & {
    compact?: (options?: { customInstructions?: string }) => void;
    sendUserMessage?: (text: string) => Promise<void> | void;
    sendMessage?: (message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }) => Promise<void> | void;
  };

/**
 * Redraws the one persistent `chef` status line (task · state and next step · running model · task spend · today's
 * spend), with today's spend alone when no task is open. Runs after commands, routes and planning stages, and after
 * each model turn and compaction so the spend keeps up. Uses the stored active task, never git; a failure leaves the line as it was.
 */
function refreshStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !ctx.ui.setStatus) return;
  try {
    ctx.ui.setStatus("chef", active?.statusLine());
  } catch {
    /* a closed session or an unreadable state file: the next command redraws it */
  }
}

/** Posts a plan as a displayed message in the chat. Uses the ctx's sendMessage, else the extension's. */
function showPlanMessage(ctx: CommandContext, text: string, customType = "chef-plan"): void {
  const message = { customType, content: text, display: true };
  try {
    if (typeof ctx.sendMessage === "function") void ctx.sendMessage(message, { triggerTurn: false });
    else if (piRef && typeof (piRef as Partial<ExtensionAPI>).sendMessage === "function") void (piRef as ExtensionAPI).sendMessage(message, { triggerTurn: false });
  } catch {
    /* a stale or headless session: the plan file on disk is still the record */
  }
}

/**
 * Warns when the local server runs `model` with a different context window than its `local.models` entry tells Pi
 * (`probeLocalContext`). Never blocks or throws: the server may not say, and the ticket starts either way.
 */
export async function warnLocalContext(config: WorkflowConfig, model: string, ctx: Pick<ExtensionContext, "hasUI" | "ui">, fetchImpl?: typeof fetch): Promise<void> {
  try {
    const baseUrl = config.local?.baseUrl;
    if (!baseUrl) return;
    const entry = config.local?.models.find((candidate) => candidate.id === model);
    const warning = contextMismatch(model, entry?.contextWindow, await probeLocalContext(baseUrl, model, { fetchImpl }));
    if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");
  } catch {
    /* best effort */
  }
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
 * The driver for /build, the only code that opens ticket tabs. Every ticket attempt runs in its own herdr tab beside the
 * user's session, which is never replaced, so `ctx` stays valid for the whole build. A Pi model runs as `pi -ne -e
 * ticket-mode.ts` in the tab (`runner/pi-ticket.ts`), an `agent:<name>` as that coding agent (`runner/agent-ticket.ts`).
 */
function buildHost(ctx: CommandContext, client: HerdrClient = herdrClient()): { getWorkflow: () => Workflow; driver: BuildDriver } {
  const live: CommandContext = ctx;
  // Local models whose served context window was compared with its local.models entry in this build (once each).
  const contextChecked = new Set<string>();
  const getWorkflow = () => workflowFor(live.cwd, live);
  const needsHerdr = (problem: string) => `${NEEDS_HERDR} (${redact(problem)})`;
  const driver: BuildDriver = {
    // Before the build touches git: /build outside herdr (or without `hc`) starts no ticket and makes no branch.
    async preflight() {
      const where = await herdrSpace(client);
      return "problem" in where ? needsHerdr(where.problem) : undefined;
    },
    async fresh(model, run, ticketId, limits, attempt = 1) {
      // Preflight: a Pi child on a model Pi does not know, or has no login for, cannot be undone cleanly. Routing applies the
      // same test (registryProblem) to every candidate, so this only trips when Pi changed since. An agent is not a Pi model.
      if (!model.agent) {
        let preflight: string | undefined;
        try {
          preflight = live.modelRegistry ? registryProblem(live.modelRegistry as unknown as UsableRegistry, model.provider, model.id) : `model ${model.id} cannot be checked: this Pi session has no model registry`;
          if (preflight) preflight = `${model.provider}/${model.id}: ${preflight}`;
        } catch (error) {
          preflight = `${model.provider}/${model.id} could not be checked: ${redact(error instanceof Error ? error.message : String(error))}`;
        }
        if (preflight) {
          return { stopped: `Ticket ${ticketId} cannot start on ${preflight}. Fix the models config or sign in, then /build again.` };
        }
        if (model.provider === "local" && !contextChecked.has(model.id)) {
          contextChecked.add(model.id);
          await warnLocalContext(getWorkflow().config, model.id, live);
        }
      }
      const where = await herdrSpace(client);
      if ("problem" in where) return { stopped: needsHerdr(where.problem) };
      const workflow = getWorkflow();
      return runTicket(
        {
          client,
          space: where.space,
          cwd: live.cwd,
          ticketId,
          attempt,
          model,
          limits,
          config: workflow.config,
          ticketModePath: fileURLToPath(new URL("./ticket-mode.ts", import.meta.url)),
          host: ticketHost(getWorkflow, () => refreshStatus(live)),
        },
        run,
      );
    },
  };
  return { getWorkflow, driver };
}

/** Since when this extension has watched each session: Pi's own calls from before then are not this run's to ledger. */
const watchedSince = new Map<string, Date>();

/**
 * Ledgers the calls Pi made on its own that never reach `message_end` (cache-warming refreshes, Pi's own compaction and
 * branch summaries), from the session file, once each. Runs after each settled turn, compaction, tree move, command,
 * and at shutdown. Never throws: a stale ctx or an unreadable session is caught up by the next sweep.
 */
function sweepPiUsage(ctx: ExtensionContext): void {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const since = watchedSince.get(sessionId);
    if (!since) return;
    const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
    (active ?? tryWorkflowFor(ctx.cwd))?.recordPiUsage({ sessionId, entries: ctx.sessionManager.getEntries(), since, ...(model ? { model } : {}) });
  } catch {
    /* caught up by the next sweep */
  }
}

export function registerWorkflow(pi: ExtensionAPI): void {
  for (const spec of COMMANDS) {
    pi.registerCommand(spec.name, {
      description: spec.description,
      getArgumentCompletions: (prefix) => spec.complete(prefix, active),
      handler: async (args, ctx) => {
        if (args.trim() === "help" || args.trim() === "--help") {
          ctx.ui.notify(spec.description, "info");
          return;
        }
        let result: CommandResult;
        // /cost should see every call Pi made on its own so far.
        sweepPiUsage(ctx);
        try {
          const workflow = workflowFor(ctx.cwd, ctx as unknown as CommandContext);
          if (spec.drive) {
            const host = buildHost(ctx as unknown as CommandContext);
            result = await spec.drive(host.getWorkflow, host.driver);
          } else result = await spec.run!(workflow, args, ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : async () => false);
        } catch (error) {
          // An invalid config must reach the user as a failed command, not as an exception inside Pi.
          result = asResult(error);
        }
        try {
          syncPlanTools(pi);
          if (ctx.hasUI) {
            refreshStatus(ctx);
            ctx.ui.notify(result.text.slice(0, 1500), result.ok ? "info" : "warning");
          }
        } catch {
          /* the session was closed; the result is in the task's event log */
        }
      },
    });
  }
  piRef = pi;
  registerWith(pi);
  pi.on("session_start", (_event, ctx) => {
    // A new session may start with an empty provider registry, so register again, with this session's pi.
    registerWith(pi);
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!watchedSince.has(sessionId)) watchedSince.set(sessionId, new Date());
    } catch {
      /* no session file: nothing of Pi's own to ledger */
    }
    // Every failure below is shown (once per distinct text), whichever step finds it; the session itself never crashes.
    const shown = new Set<string>();
    const show = (text: string) => {
      if (shown.has(text)) return;
      shown.add(text);
      if (ctx.hasUI) ctx.ui.notify(text, "warning");
    };
    for (const text of deferredNotices.splice(0)) show(text);
    try {
      const workflow = workflowFor(ctx.cwd);
      for (const warning of workflow.config.warnings ?? []) show(warning);
    } catch (error) {
      // The router and tools still register; each command reports the config error when it runs.
      show(problemNotice(error));
    }
    pi.appendEntry("chef-workflow", { cwd: ctx.cwd });
    // A /plan that was running before a restart resumes with its tools and progress line.
    toolsBeforePlan = undefined;
    restoreToolsBeforePlan(ctx);
    syncPlanTools(pi);
    // A /plan resumed after a restart shows where the task stands.
    refreshStatus(ctx);
    try {
      // The local models must be in Pi's registry before anything can select them.
      syncProviders(refreshConfig(ctx.cwd).config);
    } catch (error) {
      // A bad config or a refused registration must not stop the session from starting, but it is always shown.
      show(problemNotice(error));
    }
  });
  pi.on("session_compact", (_event, ctx) => {
    sweepPiUsage(ctx);
    refreshStatus(ctx);
  });
  pi.on("session_tree", (_event, ctx) => sweepPiUsage(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    sweepPiUsage(ctx);
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
      return { block: true, reason: "Planning is read-only: this command is not on the read-only allowlist. Use read, grep, find, ls, or a plain read-only command. If you need its output, ask the user to run it with !<command> and paste what you need. Do not ask them to change the extension." };
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
  pi.on("agent_settled", async (event, ctx) => {
    sweepPiUsage(ctx);
    refreshStatus(ctx);
    // plan_tickets saved a draft during this turn: post it as markdown now that Pi is idle, then ask. An aborted turn keeps
    // the flag, and /show-plan still offers the draft. Only this handler's live ctx is used; any failure is shown, never thrown.
    if (event.aborted || !ctx.hasUI || !active?.hasPendingPlan()) return;
    try {
      const workflow = workflowFor(ctx.cwd, ctx as CommandContext);
      await workflow.presentPendingPlan();
    } catch (error) {
      tell(ctx as CommandContext, problemNotice(error));
    }
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    const call = usageOfMessage(message);
    if (!call) return;
    // With no workflow yet, build one for the project so the turn still counts toward the daily limit.
    (active ?? tryWorkflowFor(cwd))?.observeUsage(call);
    // The footer's spend follows each turn, not just the next command.
    refreshStatus(ctx);
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
  // Register the local models at load time too, so `--model` and `--list-models` resolve them
  // before any session starts. session_start registers them again with the session's cwd.
  try {
    syncProviders(refreshConfig(process.cwd()).config);
  } catch (error) {
    // No UI yet: session_start retries, and shows this if it is still true then.
    deferredNotices.push(problemNotice(error));
  }
}
