import type { TokenUsage } from "../domain.js";

/** Request and response shapes for model calls. All chat goes through Pi's model registry (pi-chat.ts). */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatRequest {
  model: string;
  /** Put the stable prefix (system prompt, instructions) first and the volatile task text last so provider prompt caches hit. */
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** Cap on generated tokens. */
  maxTokens?: number;
  /** Prompt caching is on by default; set false to opt out. */
  promptCache?: boolean;
  /** Stable key that groups requests sharing a prefix. Sent only to OpenAI proper. */
  promptCacheKey?: string;
}

export interface ChatResponse {
  text: string;
  usage: TokenUsage;
  provider: string;
  model: string;
}

export class ProviderCallError extends Error {
  readonly kind: "expired" | "rate_limit" | "outage" | "bad_response" | "config";

  constructor(kind: ProviderCallError["kind"], message: string) {
    super(message);
    this.name = "ProviderCallError";
    this.kind = kind;
  }
}

export interface FoundryConfig {
  endpoint: string;
  apiVersion?: string;
  audience: string;
  api: "openai-responses" | "openai-completions" | "azure-openai-responses";
  /** "v1" is `<endpoint>/openai/v1/...` with the deployment in `model` and no api-version. Omitted means the legacy deployments route. */
  style?: "v1" | "deployments";
}

/** `<resource>/openai/v1` for the current Foundry route (the endpoint may already end with it). */
export function foundryV1Base(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return /\/openai\/v1$/.test(base) ? base : `${base}/openai/v1`;
}
