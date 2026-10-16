import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { redact } from "../redact.js";
import { htmlToMarkdown } from "./html-to-markdown.js";

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 5;
export const FETCH_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS_CAP = 100_000;
const USER_AGENT = "pi-chef-web-fetch/1.0 (+https://github.com/earendil-works/pi; read-only agent fetch)";

export class WebFetchError extends Error {}

// ---------- address guard ----------

function parseIPv4(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.some((n) => !(n >= 0 && n <= 255)) ? undefined : nums;
}

function isBlockedIPv4(o: number[]): boolean {
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && o[2] === 0) || // 192.0.0.0/24
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

function expandIPv6(address: string): number[] | undefined {
  let text = address.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]!);
    if (!v4) return undefined;
    text = text.slice(0, -dotted[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ":" + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : undefined;
}

/** True when the address must never be fetched (non-public). Unparseable input is treated as blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const o = parseIPv4(address);
    return !o || isBlockedIPv4(o);
  }
  if (family !== 6) return true;
  const g = expandIPv6(address);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => isBlockedIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!); // IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!); // NAT64
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  return false;
}

function blockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h === "metadata.google.internal" || h.endsWith(".local");
}

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Validate a URL and resolve it to a vetted IP. DNS rebinding choice: we resolve exactly once per
 * hop, validate EVERY returned address, and the transport connects to that pinned address (custom
 * `lookup` on the http(s) request) so a second, attacker-controlled resolution never happens.
 */
export async function resolveSafe(rawUrl: string, lookup: LookupFn): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebFetchError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebFetchError(`Only http and https URLs are allowed (got ${url.protocol}).`);
  if (url.username || url.password) throw new WebFetchError("URLs with embedded credentials are not allowed.");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (blockedHostname(host)) throw new WebFetchError(`Blocked host: ${host} is not a public address.`);
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new WebFetchError(`Blocked address: ${host} is not a public address.`);
    return { url, address: host, family: net.isIP(host) };
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host);
  } catch (error) {
    throw new WebFetchError(`DNS lookup failed for ${host}: ${(error as Error).message}`);
  }
  if (addresses.length === 0) throw new WebFetchError(`DNS lookup returned no addresses for ${host}.`);
  for (const item of addresses) {
    if (isBlockedAddress(item.address)) throw new WebFetchError(`Blocked: ${host} resolves to non-public address ${item.address}.`);
  }
  return { url, address: addresses[0]!.address, family: addresses[0]!.family };
}

// ---------- transport ----------

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}
export type FetchTransport = (url: URL, opts: { address: string; family: number; signal: AbortSignal; headers: Record<string, string> }) => Promise<TransportResponse>;

/** Default transport: node http(s).request pinned to the pre-validated IP. No cookies, no auth. */
export const nodeTransport: FetchTransport = (url, { address, family, signal, headers }) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers,
        signal,
        agent: false,
        servername: net.isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
        lookup: ((_host: string, options: unknown, cb: (...args: unknown[]) => void) => {
          const callback = typeof options === "function" ? (options as typeof cb) : cb;
          if (typeof options === "object" && options && (options as { all?: boolean }).all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }) as never,
      },
      (res) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 0, headers: out, body: res, destroy: () => res.destroy() });
      },
    );
    req.on("error", reject);
    req.end();
  });

// ---------- fetch core ----------

export interface WebFetchDeps {
  lookup?: LookupFn;
  transport?: FetchTransport;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchedPage {
  title: string;
  finalUrl: string;
  content: string;
  contentType: string;
}

const TEXT_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/x-markdown", "application/json", "application/xml", "text/xml"]);

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.replace(/["']/g, "") ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function fetchOnce(rawUrl: string, deps: Required<Pick<WebFetchDeps, "lookup" | "transport" | "timeoutMs" | "maxBytes">>, outer?: AbortSignal): Promise<FetchedPage> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.timeoutMs);
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      const target = await resolveSafe(current, deps.lookup);
      const res = await deps.transport(target.url, {
        address: target.address,
        family: target.family,
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,text/markdown,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1", "accept-encoding": "identity" },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        res.destroy();
        const location = res.headers.location;
        if (!location) throw new WebFetchError(`Redirect (${res.status}) without a Location header.`);
        if (hop === FETCH_MAX_REDIRECTS) throw new WebFetchError(`Too many redirects (max ${FETCH_MAX_REDIRECTS}).`);
        current = new URL(location, target.url).toString();
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.destroy();
        throw new WebFetchError(`HTTP ${res.status} fetching ${target.url.toString()}.`);
      }
      const contentType = (res.headers["content-type"] ?? "").toLowerCase();
      const mime = contentType.split(";")[0]!.trim();
      if (mime === "application/pdf") {
        res.destroy();
        throw new WebFetchError("PDF not supported.");
      }
      if (!TEXT_TYPES.has(mime)) {
        res.destroy();
        throw new WebFetchError(`Unsupported content type "${mime || "unknown"}". Only html, plain text, markdown, JSON and XML are supported.`);
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > deps.maxBytes) {
        res.destroy();
        throw new WebFetchError(`Response too large (${declared} bytes; limit ${deps.maxBytes}).`);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > deps.maxBytes) {
          res.destroy();
          throw new WebFetchError(`Response too large (exceeded ${deps.maxBytes} bytes while downloading).`);
        }
        chunks.push(chunk);
      }
      const text = decode(Buffer.concat(chunks), contentType);
      const finalUrl = target.url.toString();
      if (mime === "text/html" || mime === "application/xhtml+xml") {
        const { title, markdown } = htmlToMarkdown(text, finalUrl);
        return { title, finalUrl, content: markdown, contentType: mime };
      }
      return { title: "", finalUrl, content: text.trim(), contentType: mime };
    }
    throw new WebFetchError(`Too many redirects (max ${FETCH_MAX_REDIRECTS}).`);
  } catch (error) {
    if (error instanceof WebFetchError) throw error;
    if (timedOut) throw new WebFetchError(`Timed out after ${deps.timeoutMs} ms.`);
    if (outer?.aborted) throw new WebFetchError("Fetch aborted.");
    throw new WebFetchError(`Fetch failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

export interface WebFetchResult {
  title: string;
  finalUrl: string;
  total: number;
  start: number;
  slice: string;
  truncated: boolean;
  nextStart?: number;
  cached: boolean;
}

export function createWebFetcher(deps: WebFetchDeps = {}) {
  const cache = new Map<string, { at: number; page: FetchedPage }>();
  const now = deps.now ?? Date.now;
  const resolved = {
    lookup: deps.lookup ?? defaultLookup,
    transport: deps.transport ?? nodeTransport,
    timeoutMs: deps.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxBytes: deps.maxBytes ?? FETCH_MAX_BYTES,
  };
  return async function fetchPage(url: string, options: { maxChars?: number; startChar?: number; signal?: AbortSignal } = {}): Promise<WebFetchResult> {
    const maxChars = Math.min(Math.max(Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS), 1), MAX_CHARS_CAP);
    const start = Math.max(Math.floor(options.startChar ?? 0), 0);
    const hit = cache.get(url);
    let page: FetchedPage;
    let cached = false;
    if (hit && now() - hit.at < FETCH_CACHE_TTL_MS) {
      page = hit.page;
      cached = true;
    } else {
      const fetched = await fetchOnce(url, resolved, options.signal);
      // Redact the whole document before slicing so a secret straddling a page boundary is still caught.
      page = { ...fetched, title: redact(fetched.title), content: redact(fetched.content) };
      const entry = { at: now(), page };
      cache.set(url, entry);
      cache.set(page.finalUrl, entry);
    }
    const slice = page.content.slice(start, start + maxChars);
    const end = start + slice.length;
    const truncated = end < page.content.length;
    return { title: page.title, finalUrl: page.finalUrl, total: page.content.length, start, slice, truncated, nextStart: truncated ? end : undefined, cached };
  };
}

export function createWebFetchTool(deps: WebFetchDeps = {}) {
  const fetchPage = createWebFetcher(deps);
  return defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a public http(s) URL and return readable markdown (HTML) or text. Private/internal addresses are blocked. Max 2 MB, 15s. Use start_char to page through long documents.",
    promptSnippet: "web_fetch: read a public web page as markdown",
    parameters: Type.Object({
      url: Type.String({ description: "Public http or https URL" }),
      max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CHARS_CAP, description: `Characters to return (default ${DEFAULT_MAX_CHARS}, max ${MAX_CHARS_CAP})` })),
      start_char: Type.Optional(Type.Integer({ minimum: 0, description: "Offset to start from, for paging" })),
    }),
    async execute(_id, params, signal) {
      const result = await fetchPage(params.url, { maxChars: params.max_chars, startChar: params.start_char, signal });
      const lines = [
        result.title ? `Title: ${result.title}` : undefined,
        `URL: ${result.finalUrl}`,
        `Total length: ${result.total} chars; showing ${result.start}-${result.start + result.slice.length}${result.cached ? " (cached)" : ""}`,
        "",
        result.slice,
      ];
      if (result.truncated) lines.push("", `[truncated — call again with start_char=${result.nextStart}]`);
      return { content: [{ type: "text" as const, text: lines.filter((l) => l !== undefined).join("\n") }], details: { url: result.finalUrl, total: result.total, truncated: result.truncated } };
    },
  });
}
