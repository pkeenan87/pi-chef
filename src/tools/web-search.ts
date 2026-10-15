import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { redact } from "../redact.js";

export const SEARCH_MODEL = "claude-haiku-5-5";
export const SEARCH_TOOL_TYPE = "web_search_20250305"; // basic variant; _20260209 is Opus/Sonnet 4.6+ only
const DEFAULT_BASE_URL = "https://api.anthropic.com";
// Same identity pi-ai sends for oauth tokens (anthropic-messages.js createClient/getBetaFeatures/buildParams).
const CLAUDE_CODE_VERSION = "2.1.280";
const OAUTH_BETAS = "claude-code-20250219,oauth-2025-04-20";

export interface SearchUsageRecord {
  provider: "anthropic";
  model: string;
  purpose: "web_search";
  inputTokens: number;
  outputTokens: number;
  webSearchRequests: number;
  query: string;
}

export interface SearchRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}
export type SearchTransport = (req: SearchRequest) => Promise<{ status: number; body: unknown }>;

export interface SearchAuth {
  accessToken: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface WebSearchDeps {
  /** Resolves the subscription (oauth) credential. Must throw when none is available; never an API key. */
  getAuth(ctx: unknown): Promise<SearchAuth>;
  /** Throws (or rejects) when the budget is hard-exhausted. */
  budgetCheck?(): void | Promise<void>;
  onUsage?(record: SearchUsageRecord): void | Promise<void>;
  transport?: SearchTransport;
}

const defaultTransport: SearchTransport = async ({ url, headers, body, signal }) => {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: res.status, body: parsed };
};

export interface SearchParams {
  query: string;
  max_results?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

interface Block {
  type?: string;
  text?: string;
  content?: unknown;
  citations?: { type?: string; url?: string; title?: string; cited_text?: string }[];
  [key: string]: unknown;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
  pageAge?: string;
}
export interface SearchOutcome {
  hits: SearchHit[];
  summary: string;
  errors: string[];
  refused: boolean;
  usage: { inputTokens: number; outputTokens: number; webSearchRequests: number };
}

const SYSTEM = [
  "You are a web search relay. Use the web_search tool to answer the query, then reply with a concise numbered list of the most relevant results.",
  "For each result give: title, URL, and a one or two sentence snippet relevant to the query. No preamble and no extra commentary.",
].join(" ");

export function buildSearchBody(params: SearchParams, maxUses: number, messages: unknown[]): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: SEARCH_TOOL_TYPE, name: "web_search", max_uses: maxUses };
  if (params.allowed_domains?.length) tool.allowed_domains = params.allowed_domains;
  else if (params.blocked_domains?.length) tool.blocked_domains = params.blocked_domains;
  return {
    model: SEARCH_MODEL,
    max_tokens: 2000,
    // oauth tokens require the Claude Code identity as the first system block (as pi-ai does).
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: SYSTEM },
    ],
    tools: [tool],
    messages,
  };
}

function absorb(content: Block[], outcome: SearchOutcome, snippets: Map<string, string>): void {
  for (const block of content) {
    if (block.type === "web_search_tool_result") {
      const inner = block.content;
      if (Array.isArray(inner)) {
        for (const item of inner as Block[]) {
          if (item.type === "web_search_result" && typeof item.url === "string") {
            outcome.hits.push({ title: String(item.title ?? item.url), url: item.url, pageAge: typeof item.page_age === "string" ? item.page_age : undefined });
          }
        }
      } else if (inner && typeof inner === "object") {
        const err = inner as { type?: string; error_code?: string };
        outcome.errors.push(err.error_code ?? err.type ?? "unknown_error");
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      outcome.summary += (outcome.summary ? "\n" : "") + block.text;
      for (const c of block.citations ?? []) {
        if (c.url && c.cited_text && !snippets.has(c.url)) snippets.set(c.url, c.cited_text);
      }
    }
  }
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const message = (body as { error?: { message?: string } }).error?.message;
    if (message) return message;
  }
  return typeof body === "string" ? body.slice(0, 300) : "unknown error";
}

export async function runSearch(params: SearchParams, auth: SearchAuth, transport: SearchTransport, signal?: AbortSignal): Promise<SearchOutcome> {
  if (params.allowed_domains?.length && params.blocked_domains?.length) {
    throw new Error("Specify allowed_domains or blocked_domains, not both.");
  }
  if (!auth.accessToken.includes("sk-ant-oat")) {
    throw new Error("web_search needs an Anthropic subscription (oauth) login. Run /login anthropic. API keys are not accepted.");
  }
  const maxUses = Math.min(Math.max(Math.floor(params.max_results ?? 3), 1), 5);
  const headers: Record<string, string> = {
    ...(auth.headers ?? {}),
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${auth.accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": OAUTH_BETAS,
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
    "x-app": "cli",
  };
  const url = `${(auth.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/messages`;
  const messages: unknown[] = [{ role: "user", content: `Search the web for: ${params.query}` }];
  const outcome: SearchOutcome = { hits: [], summary: "", errors: [], refused: false, usage: { inputTokens: 0, outputTokens: 0, webSearchRequests: 0 } };
  const snippets = new Map<string, string>();

  for (let turn = 0; turn < 2; turn++) {
    const res = await transport({ url, headers, body: buildSearchBody(params, maxUses, messages), signal });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`web_search failed (HTTP ${res.status}): ${redact(errorMessage(res.body))}`);
    }
    const body = (res.body ?? {}) as { content?: Block[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number; server_tool_use?: { web_search_requests?: number } } };
    outcome.usage.inputTokens += body.usage?.input_tokens ?? 0;
    outcome.usage.outputTokens += body.usage?.output_tokens ?? 0;
    outcome.usage.webSearchRequests += body.usage?.server_tool_use?.web_search_requests ?? 0;
    const content = Array.isArray(body.content) ? body.content : [];
    absorb(content, outcome, snippets);
    if (body.stop_reason === "refusal") {
      outcome.refused = true;
      break;
    }
    if (body.stop_reason === "pause_turn" && turn === 0) {
      messages.push({ role: "assistant", content });
      continue; // continue once; a second pause_turn returns what we have
    }
    break;
  }

  const seen = new Set<string>();
  outcome.hits = outcome.hits
    .filter((hit) => (seen.has(hit.url) ? false : (seen.add(hit.url), true)))
    .map((hit) => ({ ...hit, snippet: snippets.get(hit.url) }));
  return outcome;
}

export function formatOutcome(outcome: SearchOutcome, limit: number): string {
  const lines: string[] = [];
  if (outcome.refused) lines.push("The search model declined to process this query (refusal).");
  outcome.hits.slice(0, limit).forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title}`, `   ${hit.url}${hit.pageAge ? ` (${hit.pageAge})` : ""}`);
    if (hit.snippet) lines.push(`   ${hit.snippet.replace(/\s+/g, " ").trim()}`);
  });
  if (outcome.hits.length === 0 && !outcome.refused) lines.push("No results.");
  if (outcome.summary.trim()) lines.push("", "Summary:", outcome.summary.trim());
  if (outcome.errors.length) lines.push("", `errors: ${[...new Set(outcome.errors)].join(", ")}`);
  return redact(lines.join("\n"));
}

export function createWebSearchTool(deps: WebSearchDeps) {
  const transport = deps.transport ?? defaultTransport;
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web (Anthropic server-side web search via Claude Haiku, using the Anthropic subscription login). Returns numbered results with title, URL and snippet.",
    promptSnippet: "web_search: search the web for current information",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Max searches the search model may run (1-5, default 3)" })),
      allowed_domains: Type.Optional(Type.Array(Type.String(), { description: "Only these domains (cannot combine with blocked_domains)" })),
      blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains (cannot combine with allowed_domains)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      await deps.budgetCheck?.();
      const auth = await deps.getAuth(ctx);
      const outcome = await runSearch(params, auth, transport, signal);
      await deps.onUsage?.({ provider: "anthropic", model: SEARCH_MODEL, purpose: "web_search", query: redact(params.query), ...outcome.usage });
      return { content: [{ type: "text" as const, text: formatOutcome(outcome, 10) }], details: { results: outcome.hits.length, errors: outcome.errors, refused: outcome.refused } };
    },
  });
}

interface RegistryLike {
  find(provider: string, id: string): unknown;
  getAvailable(): unknown[];
  isUsingOAuth(model: never): boolean;
  getApiKeyAndHeaders(model: never): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; baseUrl?: string; error?: string }>;
}

/** Default credential path: the Pi model registry's anthropic oauth login. Never reads ANTHROPIC_API_KEY. */
export async function getAnthropicOAuth(ctx: unknown): Promise<SearchAuth> {
  const registry = (ctx as { modelRegistry?: RegistryLike }).modelRegistry;
  if (!registry) throw new Error("Pi model registry is unavailable.");
  const isAnthropicOAuth = (m: unknown) => (m as { provider?: string }).provider === "anthropic" && registry.isUsingOAuth(m as never);
  const exact = registry.find("anthropic", SEARCH_MODEL);
  const model = exact && isAnthropicOAuth(exact) ? exact : registry.getAvailable().find(isAnthropicOAuth);
  if (!model) throw new Error("No Anthropic account login is available. Run /login anthropic. API keys are not accepted.");
  const auth = await registry.getApiKeyAndHeaders(model as never);
  if (!auth.ok || !auth.apiKey) throw new Error(`Anthropic login could not be resolved${auth.error ? `: ${auth.error}` : ""}.`);
  return { accessToken: auth.apiKey, baseUrl: auth.baseUrl ?? (model as { baseUrl?: string }).baseUrl, headers: auth.headers };
}
