import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { COMMANDS, helpText } from "./commands.js";
import { loadConfig } from "./config.js";
import { isDeniedCommand } from "./sandbox.js";
import { FileAuthProbe } from "./providers/auth.js";
import { Workflow, type SessionControl } from "./orchestrator/service.js";
import { decideRoute } from "./router/policy.js";
import { fallbackClassification } from "./router/classify.js";
import type { TokenUsage } from "./domain.js";

let active: Workflow | undefined;
let cwd = process.cwd();
let cancelPoll: (() => void) | undefined;

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
  active = workflow;
}

export function currentWorkflow(): Workflow | undefined {
  return active;
}

function workflowFor(root: string, session?: SessionControl): Workflow {
  if (!active || root !== cwd) {
    cwd = root;
    active = new Workflow({ cwd: root, auth: new FileAuthProbe(), session, schedule });
    return active;
  }
  if (session) {
    active = new Workflow({
      cwd: root,
      auth: new FileAuthProbe(),
      session,
      schedule,
      config: active.config,
      store: active.store,
      git: active.git,
    });
  }
  return active;
}

function sessionFrom(ctx: { newSession: ExtensionContext extends never ? never : (options?: { withSession?: (next: { sendMessage: Function }) => Promise<void> }) => Promise<{ cancelled: boolean }>; compact: (options?: { customInstructions?: string }) => void }): SessionControl {
  return {
    async reset({ boundary, handoff }) {
      try {
        const result = await ctx.newSession({
          withSession: async (next) => {
            await next.sendMessage(
              { customType: "cost-handoff", content: handoff, display: true, details: { boundary } },
              { triggerTurn: false },
            );
          },
        });
        return { mode: "new-session", cancelled: result.cancelled };
      } catch {
        ctx.compact({ customInstructions: "Keep .pi-workflows artifacts. Do not drop the durable task files." });
        return { mode: "compact", cancelled: false };
      }
    },
  };
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
        const workflow = workflowFor(ctx.cwd, sessionFrom(ctx));
        const result = await dispatch(workflow, spec.name, args, ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : async () => false);
        if (ctx.hasUI) {
          ctx.ui.setStatus("cost-workflow", result.ok ? result.text.split("\n")[0] : undefined);
          ctx.ui.notify(result.text.slice(0, 1500), result.ok ? "info" : "warning");
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
  pi.on("session_start", (_event, ctx) => {
    workflowFor(ctx.cwd);
    pi.appendEntry("cost-workflow", { cwd: ctx.cwd });
    registerRouter(pi, ctx);
  });
  pi.on("session_shutdown", () => {
    clearPoll();
    active = undefined;
  });
  pi.on("tool_call", (event) => {
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
    const usage: TokenUsage = {
      input: typeof message.usage.input === "number" ? message.usage.input : null,
      output: typeof message.usage.output === "number" ? message.usage.output : null,
      cacheRead: typeof message.usage.cacheRead === "number" ? message.usage.cacheRead : null,
      cacheWrite: typeof message.usage.cacheWrite === "number" ? message.usage.cacheWrite : null,
      requests: 1,
    };
    active?.observeUsage({ provider: message.provider, model: message.model, usage });
  });
}

function registerRouter(pi: ExtensionAPI, fallback: ExtensionContext): void {
  const config = loadConfig(fallback.cwd);
  pi.registerVirtualModel({
    provider: "cost-opt",
    id: "auto",
    name: "Cost-optimized auto",
    async route(request, ctx) {
      if (request.reason !== "user" && request.previous) {
        return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "medium" };
      }
      const text = request.messages.map((message) => ("content" in message && typeof message.content === "string" ? message.content : "")).join("\n");
      const classification = fallbackClassification(text, "virtual_route");
      const decision = decideRoute(classification, config, {}, { purpose: "preview" });
      const registry = ctx.modelRegistry;
      if (decision.provider === "openai" || decision.provider === "anthropic") {
        const exact = registry.find(decision.provider, decision.model);
        const model = exact && registry.isUsingOAuth(exact) ? exact : registry.getAvailable().find((item) => item.provider === decision.provider && registry.isUsingOAuth(item));
        if (!model) {
          throw new Error(`No ${decision.provider} account login is available. Run /login ${decision.provider}. API keys are not accepted.`);
        }
        return { model, thinkingLevel: "medium" as const };
      }
      if (decision.provider === "foundry" || decision.provider === "local") {
        const model = registry.find(decision.provider, decision.model);
        if (!model) throw new Error(`Provider ${decision.provider} is not registered in this Pi session.`);
        return { model, thinkingLevel: "medium" as const };
      }
      throw new Error("Deterministic tier does not select a Pi model. Use /implement for mechanical edits.");
    },
  });
}

async function dispatch(
  workflow: Workflow,
  name: string,
  args: string,
  confirm: (title: string, message: string) => Promise<boolean>,
): Promise<{ ok: boolean; text: string }> {
  switch (name) {
    case "plan":
      return workflow.plan(args);
    case "approve-plan":
      return workflow.approvePlan();
    case "implement":
      return workflow.implement();
    case "review":
      return workflow.review();
    case "push":
      return workflow.push();
    case "autopilot":
      return workflow.autopilot(args);
    case "route":
      return workflow.route(args);
    case "cost":
      return workflow.cost(args);
    case "status":
      return workflow.status();
    case "reset-phase":
      return workflow.resetPhase();
    case "worktrees": {
      const wantsConfirm = args.includes("confirm");
      const confirmed = wantsConfirm ? await confirm("Clean worktrees", "Delete unmerged worktrees that are not part of an active PR?") : false;
      return workflow.worktrees(args.replace(/\s*confirm\s*/g, " ").trim(), confirmed);
    }
    case "auth":
      return workflow.auth(args);
    default:
      return { ok: false, text: "Unknown command." };
  }
}

export default function extension(pi: ExtensionAPI): void {
  registerWorkflow(pi);
}
