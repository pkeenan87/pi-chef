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

const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

/**
 * Anthropic Messages body. System messages become blocks and the last one carries
 * cache_control so the stable prefix is cached. Pass `promptCache: false` to opt out.
 */
export function buildAnthropicBody(request: ChatRequest): Record<string, unknown> {
  const system = request.messages.filter((message) => message.role === "system");
  const rest = request.messages.filter((message) => message.role !== "system");
  const cache = request.promptCache !== false;
  const blocks = system.map((message, index) => ({
    type: "text",
    text: message.content,
    ...(cache && index === system.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    ...(blocks.length > 0 ? { system: blocks } : {}),
    messages: rest.map((message) => ({ role: message.role, content: message.content })),
  };
}

/**
 * OpenAI-compatible chat body. OpenAI caches shared prefixes automatically, so the only
 * addition is prompt_cache_key, and only when `openaiProper` is set (other servers may reject it).
 */
export function buildOpenAiBody(request: ChatRequest, options: { openaiProper?: boolean } = {}): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(options.openaiProper && request.promptCache !== false && request.promptCacheKey
      ? { prompt_cache_key: request.promptCacheKey }
      : {}),
  };
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
  /** "v1" is `<endpoint>/openai/v1/...` with the deployment in `model` and no api-version. Omitted means the legacy deployments route. */
  style?: "v1" | "deployments";
}

export function createFoundryClient(options: {
  auth: AuthProbe;
  config: () => Promise<FoundryConfig>;
  token: (audience: string) => Promise<{ token: string; expiresOn?: string }>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): ChatClient {
  const tokens = createTokenCache(options.token, options.now);
  return {
    id: "foundry",
    async complete(request) {
      const view = await options.auth.inspect("foundry");
      assertCallable(view);
      const config = await options.config();
      let token: string;
      try {
        token = (await tokens(config.audience)).token;
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

/** Azure tokens are reused until 5 minutes before expiry. Tokens without a parseable expiry are not cached. */
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export function createTokenCache(
  fetchToken: (audience: string) => Promise<{ token: string; expiresOn?: string }>,
  now: () => number = Date.now,
): (audience: string) => Promise<{ token: string; expiresOn?: string }> {
  const cache = new Map<string, { value: { token: string; expiresOn?: string }; validUntil: number }>();
  return async (audience) => {
    const hit = cache.get(audience);
    if (hit && now() < hit.validUntil) return hit.value;
    const value = await fetchToken(audience);
    const expires = value.expiresOn ? Date.parse(value.expiresOn) : Number.NaN;
    if (value.token && !Number.isNaN(expires) && expires - TOKEN_EXPIRY_MARGIN_MS > now()) {
      cache.set(audience, { value, validUntil: expires - TOKEN_EXPIRY_MARGIN_MS });
    } else {
      cache.delete(audience);
    }
    return value;
  };
}

/** `<resource>/openai/v1` for the current Foundry route (the endpoint may already end with it). */
export function foundryV1Base(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return /\/openai\/v1$/.test(base) ? base : `${base}/openai/v1`;
}

function foundryUrl(config: FoundryConfig, deployment: string): string {
  if (config.style === "v1") {
    const wire = config.api === "openai-responses" || config.api === "azure-openai-responses" ? "responses" : "chat/completions";
    return `${foundryV1Base(config.endpoint)}/${wire}`;
  }
  const base = config.endpoint.replace(/\/$/, "");
  const version = config.apiVersion ? `?api-version=${encodeURIComponent(config.apiVersion)}` : "";
  if (config.api === "openai-responses" || config.api === "azure-openai-responses") {
    return `${base}/openai/deployments/${encodeURIComponent(deployment)}/responses${version}`;
  }
  return `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions${version}`;
}

function foundryBody(api: FoundryConfig["api"], request: ChatRequest): Record<string, unknown> {
  if (api === "openai-completions") {
    return buildOpenAiBody(request);
  }
  return {
    model: request.model,
    input: request.messages.map((message) => ({ role: message.role, content: message.content })),
    ...(request.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
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
          body: JSON.stringify(buildOpenAiBody(request)),
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

/**
 * OpenAI style (prompt_tokens, or Responses input_tokens with input_tokens_details): input already
 * includes cached tokens, so cached is subtracted from input and reported as cacheRead.
 * Anthropic style (input_tokens with cache_* fields): input excludes cache tokens, mapped as-is.
 */
export function readUsage(payload: Record<string, unknown>): TokenUsage {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object") {
    return { input: null, output: null, cacheRead: null, cacheWrite: null, requests: 1 };
  }
  const raw = usage as Record<string, unknown>;
  const details = (raw.prompt_tokens_details ?? raw.input_tokens_details) as Record<string, unknown> | undefined;
  const anthropic = raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined;
  const output = numberOrNull(raw.completion_tokens ?? raw.output_tokens);
  if (!anthropic && (raw.prompt_tokens !== undefined || details !== undefined)) {
    const total = numberOrNull(raw.prompt_tokens ?? raw.input_tokens);
    const cached = numberOrNull(details?.cached_tokens) ?? 0;
    return {
      input: total === null ? null : Math.max(0, total - cached),
      output,
      cacheRead: cached,
      cacheWrite: 0,
      requests: 1,
    };
  }
  return {
    input: numberOrNull(raw.prompt_tokens ?? raw.input_tokens),
    output,
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

export interface DecisionQuestion {
  type: "choice" | "predicate" | "score";
  name: string;
  instructions: string;
  choices?: { value: string; description?: string }[];
  levels?: { label: string; description?: string }[];
}

export type DecisionAnswer =
  | { type: "choice"; name: string; choice: string; confidence?: number; probabilities?: { value: string; probability: number }[] }
  | { type: "predicate"; name: string; probability: number }
  | { type: "score"; name: string; score: number; confidence?: number; probabilities?: { label?: string; value?: string; probability: number }[] }
  | { type: "refusal"; name: string };

export interface DecisionsRequest {
  model: string;
  /** Text only. Decision models have a small context window, so callers truncate. */
  input: string;
  questions: DecisionQuestion[];
  signal?: AbortSignal;
}

export interface DecisionsResult {
  model: string;
  answers: DecisionAnswer[];
  usage: TokenUsage;
  provider: string;
  /** Gateway-reported cost in USD, when the response carries one. */
  costUsd?: number;
}

export interface DecisionsClient {
  readonly id: ProviderId;
  decide(request: DecisionsRequest): Promise<DecisionsResult>;
}

/** Joins a base URL and the Decisions path (default /decisions). */
export function decisionsUrl(base: string, path = "/decisions"): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function parseAnswers(payload: unknown): DecisionAnswer[] {
  const raw = (payload as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(raw)) throw new ProviderCallError("bad_response", "Decisions response had no answers.");
  return raw.map((item) => {
    const answer = item as Record<string, unknown> | null;
    if (!answer || typeof answer.name !== "string") throw new ProviderCallError("bad_response", "Decisions answer had no name.");
    switch (answer.type) {
      case "choice":
        if (typeof answer.choice !== "string") throw new ProviderCallError("bad_response", `Decisions choice answer ${answer.name} had no choice.`);
        return answer as unknown as DecisionAnswer;
      case "predicate":
        if (typeof answer.probability !== "number") throw new ProviderCallError("bad_response", `Decisions predicate answer ${answer.name} had no probability.`);
        return answer as unknown as DecisionAnswer;
      case "score":
        if (typeof answer.score !== "number") throw new ProviderCallError("bad_response", `Decisions score answer ${answer.name} had no score.`);
        return answer as unknown as DecisionAnswer;
      case "refusal":
        return { type: "refusal", name: answer.name };
      default:
        throw new ProviderCallError("bad_response", `Unknown Decisions answer type for ${answer.name}.`);
    }
  });
}

/**
 * Client for the OpenAI-style Decisions API: one POST with several questions, one answer each.
 * `url` and `token` are lazy so a Foundry endpoint or a Vercel token can be resolved per call.
 * Auth failures are not retried here; the token is never logged or stored.
 */
export function createDecisionsClient(options: {
  id: ProviderId;
  url: () => Promise<string>;
  token: () => Promise<string>;
  auth?: AuthProbe;
  fetchImpl?: typeof fetch;
}): DecisionsClient {
  return {
    id: options.id,
    async decide(request) {
      if (options.auth) assertCallable(await options.auth.inspect(options.id));
      let token: string;
      try {
        token = await options.token();
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        throw new ProviderCallError("outage", redact((error as Error).message));
      }
      if (!token) throw new ProviderCallError("expired", `${options.id} returned an empty token.`);
      const fetchImpl = options.fetchImpl ?? fetch;
      let response: Response;
      try {
        response = await fetchImpl(await options.url(), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: request.model, input: request.input, questions: request.questions }),
          signal: request.signal,
        });
      } catch (error) {
        throw new ProviderCallError("outage", redact((error as Error).message));
      }
      if (response.status === 401 || response.status === 403) throw new ProviderCallError("expired", `${options.id} rejected the token.`);
      if (response.status === 429) throw new ProviderCallError("rate_limit", `${options.id} rate limit.`);
      if (!response.ok) throw new ProviderCallError("bad_response", `${options.id} Decisions HTTP ${response.status}`);
      const payload = (await response.json()) as Record<string, unknown>;
      const gateway = (payload.provider_metadata as { gateway?: { cost?: unknown } } | undefined)?.gateway;
      const cost = typeof gateway?.cost === "string" ? Number(gateway.cost) : typeof gateway?.cost === "number" ? gateway.cost : undefined;
      return {
        model: typeof payload.model === "string" ? payload.model : request.model,
        answers: parseAnswers(payload),
        usage: readUsage(payload),
        provider: options.id,
        ...(cost !== undefined && Number.isFinite(cost) ? { costUsd: cost } : {}),
      };
    },
  };
}
