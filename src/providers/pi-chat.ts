import { WorkflowError, type ProviderId } from "../domain.js";
import { ProviderCallError, type ChatRequest, type ChatResponse } from "./clients.js";

/** The slice of Pi's ModelRegistry that chat calls need. Structural so tests can fake it. */
export interface PiRegistryLike {
  find(provider: string, modelId: string): unknown;
  isUsingOAuth?(model: never): boolean;
  complete(
    model: never,
    context: { systemPrompt?: string; messages: { role: "user"; content: string; timestamp: number }[] },
    options?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<{
    content: { type: string; text?: string }[];
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    stopReason: string;
    errorMessage?: string;
  }>;
}

/** Calls one configured candidate and returns text plus usage. */
export type ChatFn = (candidate: { provider: ProviderId; model: string }, request: Omit<ChatRequest, "model">) => Promise<ChatResponse>;

/**
 * Chat through Pi's model registry, which owns authentication. OpenAI and Anthropic calls are refused
 * unless the registry is using an account login for that model, so there is no API-key fallback.
 */
export function createRegistryChat(registry: PiRegistryLike): ChatFn {
  return async (candidate, request) => {
    const model = registry.find(candidate.provider, candidate.model);
    if (!model) {
      throw new ProviderCallError("config", `Model ${candidate.provider}/${candidate.model} is not registered in this Pi session.`);
    }
    if ((candidate.provider === "openai" || candidate.provider === "anthropic") && !registry.isUsingOAuth?.(model as never)) {
      throw new WorkflowError("API_KEY_REJECTED", `No ${candidate.provider} account login is available. Run /login ${candidate.provider}. API keys are not accepted.`);
    }
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const result = await registry.complete(
      model as never,
      {
        ...(system ? { systemPrompt: system } : {}),
        messages: request.messages.filter((message) => message.role !== "system").map((message) => ({ role: "user" as const, content: message.content, timestamp: Date.now() })),
      },
      { maxTokens: request.maxTokens, signal: request.signal },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new ProviderCallError("outage", result.errorMessage ?? `${candidate.provider} call ${result.stopReason}.`);
    }
    const text = result.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
    return {
      text,
      usage: { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite, requests: 1 },
      provider: candidate.provider,
      model: candidate.model,
    };
  };
}
