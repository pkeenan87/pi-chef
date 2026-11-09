/**
 * Asks a local server what context window it actually runs a model with, so a `contextWindow` in the config that does
 * not match can be pointed out before a ticket overflows it. llama-server reports `n_ctx` on `GET /props`; Ollama
 * reports `context_length` for loaded models on `GET /api/ps`. Best effort: any failure is "unknown", never an error.
 */

const PROBE_TIMEOUT_MS = 2_000;

/** The server's origin: `http://127.0.0.1:11434/v1` becomes `http://127.0.0.1:11434`. */
export function serverOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** The window the server runs `model` with, or undefined when it does not say (not loaded yet, another server, down). */
export async function probeLocalContext(baseUrl: string, model: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<number | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const origin = serverOrigin(baseUrl);
  const props = (await getJson(fetchImpl, `${origin}/props`, timeoutMs)) as { n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } } | undefined;
  const llama = positive(props?.default_generation_settings?.n_ctx) ?? positive(props?.n_ctx);
  if (llama) return llama;
  const ps = (await getJson(fetchImpl, `${origin}/api/ps`, timeoutMs)) as { models?: { name?: unknown; model?: unknown; context_length?: unknown }[] } | undefined;
  const wanted = model.toLowerCase();
  const loaded = ps?.models?.find((entry) => [entry.name, entry.model].some((name) => typeof name === "string" && name.toLowerCase() === wanted));
  return positive(loaded?.context_length);
}

/** The warning for a window that does not match the config, or undefined when they agree or the server does not say. */
export function contextMismatch(model: string, configured: number | undefined, actual: number | undefined): string | undefined {
  if (actual === undefined) return undefined;
  const told = configured ?? 128_000;
  if (told === actual) return undefined;
  const where = configured === undefined ? `no contextWindow is set for it, so Pi assumes ${told}` : `local.models says contextWindow: ${told}`;
  const risk = told > actual ? "Pi may send more than the server keeps, which silently drops the start of the conversation" : "tickets are planned smaller than the server could take";
  return `The local server runs ${model} with a ${actual}-token context window, but ${where}: ${risk}. Set contextWindow: ${actual} on its local.models entry.`;
}
