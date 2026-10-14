import { WorkflowError, type ProviderId, type TokenUsage } from "../domain.js";
import type { AuthProbe } from "./auth.js";
import { assertCallable } from "./auth.js";
import { redact } from "../redact.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  usage: TokenUsage;
  provider: string;
  model: string;
}

export interface ChatClient {
  readonly id: ProviderId;
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export class ProviderCallError extends Error {
  readonly kind: "expired" | "rate_limit" | "outage" | "bad_response" | "config";

  constructor(kind: ProviderCallError["kind"], message: string) {
    super(message);
    this.name = "ProviderCallError";
    this.kind = kind;
  }
}

export function createAccountClient(options: {
  provider: "openai" | "anthropic";
  auth: AuthProbe;
  transport?: (request: ChatRequest) => Promise<ChatResponse>;
}): ChatClient {
  return {
    id: options.provider,
    async complete(request) {
      const view = await options.auth.inspect(options.provider);
      assertCallable(view);
      if (!options.transport) {
        throw new ProviderCallError(
          "config",
          `Live ${options.provider} calls are disabled in this process. Account login is ${view.status}, and API keys are not used.`,
        );
      }
      return options.transport(request);
    },
  };
}

export interface FoundryConfig {
  endpoint: string;
  apiVersion?: string;
  audience: string;
  api: "openai-responses" | "openai-completions" | "azure-openai-responses";
}

export function createFoundryClient(options: {
  auth: AuthProbe;
  config: () => Promise<FoundryConfig>;
  token: (audience: string) => Promise<{ token: string; expiresOn?: string }>;
  fetchImpl?: typeof fetch;
}): ChatClient {
  return {
    id: "foundry",
    async complete(request) {
      const view = await options.auth.inspect("foundry");
      assertCallable(view);
      const config = await options.config();
      let token: string;
      try {
        token = (await options.token(config.audience)).token;
      } catch (error) {
        const message = redact((error as Error).message);
        if (/az login|expired|AADSTS/i.test(message)) {
          throw new ProviderCallError("expired", message);
        }
        throw new ProviderCallError("outage", message);
      }
      if (!token) throw new ProviderCallError("expired", "Azure CLI returned an empty token.");
      const fetchImpl = options.fetchImpl ?? fetch;
      const url = foundryUrl(config, request.model);
      const body = foundryBody(config.api, request);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        throw new ProviderCallError("outage", redact((error as Error).message));
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderCallError("expired", "Foundry rejected the Azure CLI token.");
      }
      if (response.status === 429) throw new ProviderCallError("rate_limit", "Foundry rate limit.");
      if (!response.ok) throw new ProviderCallError("bad_response", `Foundry HTTP ${response.status}`);
      const payload = (await response.json()) as Record<string, unknown>;
      return {
        text: readText(payload),
        usage: readUsage(payload),
        provider: "foundry",
        model: request.model,
      };
    },
  };
}

function foundryUrl(config: FoundryConfig, deployment: string): string {
  const base = config.endpoint.replace(/\/$/, "");
  const version = config.apiVersion ? `?api-version=${encodeURIComponent(config.apiVersion)}` : "";
  if (config.api === "openai-responses" || config.api === "azure-openai-responses") {
    return `${base}/openai/deployments/${encodeURIComponent(deployment)}/responses${version}`;
  }
  return `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions${version}`;
}

function foundryBody(api: FoundryConfig["api"], request: ChatRequest): Record<string, unknown> {
  if (api === "openai-completions") {
    return { messages: request.messages, model: request.model };
  }
  return {
    model: request.model,
    input: request.messages.map((message) => ({ role: message.role, content: message.content })),
  };
}

export function createLocalClient(options: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  reachable?: () => Promise<boolean>;
}): ChatClient {
  return {
    id: "local",
    async complete(request) {
      if (options.reachable && !(await options.reachable())) {
        throw new ProviderCallError("outage", "Local endpoint is not reachable.");
      }
      const fetchImpl = options.fetchImpl ?? fetch;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
      let response: Response;
      try {
        response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: request.model, messages: request.messages }),
          signal: request.signal,
        });
      } catch (error) {
        throw new ProviderCallError("outage", redact((error as Error).message));
      }
      if (response.status === 429) throw new ProviderCallError("rate_limit", "Local endpoint rate limit.");
      if (!response.ok) throw new ProviderCallError("bad_response", `Local HTTP ${response.status}`);
      const payload = (await response.json()) as Record<string, unknown>;
      return { text: readText(payload), usage: readUsage(payload), provider: "local", model: request.model };
    },
  };
}

function readText(payload: Record<string, unknown>): string {
  const choices = payload.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    if (typeof message?.content === "string") return message.content;
  }
  const output = payload.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const text = content.find((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") as
          | { text: string }
          | undefined;
        if (text) return text.text;
      }
    }
  }
  if (typeof payload.output_text === "string") return payload.output_text;
  throw new ProviderCallError("bad_response", "Provider response did not include text.");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function readUsage(payload: Record<string, unknown>): TokenUsage {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object") {
    return { input: null, output: null, cacheRead: null, cacheWrite: null, requests: 1 };
  }
  const raw = usage as Record<string, unknown>;
  return {
    input: numberOrNull(raw.prompt_tokens ?? raw.input_tokens),
    output: numberOrNull(raw.completion_tokens ?? raw.output_tokens),
    cacheRead: numberOrNull(raw.cache_read_input_tokens ?? raw.cache_read_tokens),
    cacheWrite: numberOrNull(raw.cache_creation_input_tokens ?? raw.cache_write_tokens),
    requests: 1,
  };
}

export function parseAzureToken(stdout: string): { token: string; expiresOn?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new WorkflowError("AUTH_MISSING", "Azure CLI token response was not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { accessToken?: unknown }).accessToken !== "string") {
    throw new WorkflowError("AUTH_MISSING", "Azure CLI token response did not include accessToken.");
  }
  const record = parsed as { accessToken: string; expiresOn?: string };
  if (!record.accessToken) throw new WorkflowError("AUTH_EXPIRED", "Azure CLI returned an empty access token. Run az login.");
  return { token: record.accessToken, expiresOn: record.expiresOn };
}
