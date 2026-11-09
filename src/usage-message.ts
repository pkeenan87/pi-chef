import type { TokenUsage } from "./domain.js";

/**
 * The ledger entry of one finished assistant message (the session's own turn or a /build ticket child's), or
 * undefined for a message that bills nothing: not an assistant turn, no usage, or a failed attempt with no tokens
 * (Pi retries it, possibly on another model, and the retry ledgers its own message).
 */
export function usageOfMessage(message: { role: string; usage?: unknown; stopReason?: unknown; provider?: unknown; model?: unknown }): { provider: string; model: string; usage: TokenUsage } | undefined {
  if (message.role !== "assistant" || !message.usage || typeof message.usage !== "object") return undefined;
  const raw = message.usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } };
  const stop = message.stopReason;
  if ((stop === "error" || stop === "aborted") && !raw.input && !raw.output && !raw.cacheRead && !raw.cacheWrite) return undefined;
  const usage: TokenUsage = {
    input: typeof raw.input === "number" ? raw.input : null,
    output: typeof raw.output === "number" ? raw.output : null,
    cacheRead: typeof raw.cacheRead === "number" ? raw.cacheRead : null,
    cacheWrite: typeof raw.cacheWrite === "number" ? raw.cacheWrite : null,
    requests: 1,
  };
  // Pi's own price for the call: stored beside ours, and the estimate when no pricing row prices it.
  const listed = raw.cost?.total;
  if (typeof listed === "number" && Number.isFinite(listed)) usage.listPriceUsd = listed;
  return { provider: String(message.provider ?? ""), model: String(message.model ?? ""), usage };
}
