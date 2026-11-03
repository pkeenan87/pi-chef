/**
 * The real `ChildSdk`: ticket sessions through Pi 1.2.0's SDK. The child shares the parent's model runtime, so it sees
 * the providers pi-chef registered (Foundry, Vercel, local) and the user's logins, and no second token refresher runs.
 * It loads no extensions (pi-chef must not load itself into its own ticket), keeps the project's context files and
 * skills, and lives in memory: the ticket's work lands in the checkout, its usage in the ledger.
 */
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ChildSdk, ChildSession, ChildTool } from "./ticket-agent.js";

/**
 * The model runtime behind a Pi `ModelRegistry`. Pi keeps it in a TypeScript-private field, so this reads it by name
 * and checks its shape; undefined means this Pi build is laid out differently and the session driver is used.
 */
export function runtimeOf(registry: unknown): unknown {
  const runtime = registry && typeof registry === "object" ? (registry as { runtime?: unknown }).runtime : undefined;
  if (!runtime || typeof runtime !== "object") return undefined;
  const shape = runtime as { getModel?: unknown; hasConfiguredAuth?: unknown; streamSimple?: unknown };
  return typeof shape.getModel === "function" && typeof shape.hasConfiguredAuth === "function" && typeof shape.streamSimple === "function" ? runtime : undefined;
}

export function piChildSdk(runtime: unknown): ChildSdk {
  return {
    tools(cwd) {
      return [
        createReadToolDefinition(cwd),
        createEditToolDefinition(cwd),
        createWriteToolDefinition(cwd),
        createGrepToolDefinition(cwd),
        createFindToolDefinition(cwd),
        createLsToolDefinition(cwd),
        createBashToolDefinition(cwd),
      ] as unknown as ChildTool[];
    },
    async open({ cwd, model, thinking, tools, systemPrompt }) {
      const agentDir = getAgentDir();
      // A session with its own system prompt (an advisor) gets that prompt alone: no context files or skills.
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, ...(systemPrompt ? { systemPrompt, noContextFiles: true, noSkills: true, noPromptTemplates: true } : {}) });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime as never,
        model: model as never,
        ...(thinking ? { thinkingLevel: thinking as never } : {}),
        // Pi's built-in tools are off; the ticket gets the definitions pi-chef passes, its bash wrapped.
        noTools: "builtin",
        customTools: tools as never,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
      });
      return session as unknown as ChildSession;
    },
  };
}
