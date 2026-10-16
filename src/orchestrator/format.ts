/** Small formatting helpers for progress lines and reports. */

/** "0.8s", "12.3s", "4m21s", "1h02m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** "$0.1234", or "cost unknown" for null. */
export function formatUsd(usd: number | null | undefined): string {
  return usd === null || usd === undefined ? "cost unknown" : `$${usd.toFixed(4)}`;
}

/** "1.7M", "82k", "512". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

/** Plain one-line text: newlines and runs of space collapsed, clipped to `max` characters with an ellipsis. No markdown escapes. */
export function flat(text: string, max?: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return max !== undefined && one.length > max ? `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…` : one;
}

/**
 * Text for one markdown table cell: `flat` text with `|` escaped (the clip happens first, so it never splits an escape).
 * Escape only here, at the table; text for a notify or a result stays plain.
 */
export function cell(text: string, max?: number): string {
  return flat(text, max).replace(/\|/g, "\\|");
}

/** "$0.19", "<$0.01" for a positive amount under a cent, "$0.00" for none. For report tables; the ledger keeps full precision. */
export function formatUsdShort(usd: number): string {
  return usd > 0 && usd < 0.005 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** A markdown table: pass cells through `cell` so a `|` cannot split a row. */
export const mdTable = (head: string[], rows: string[][]): string[] => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)];
