import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PlanReviewAction, PlanReviewRequest } from "../orchestrator/types.js";

interface Theme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

type Tui = { requestRender(): void; terminal?: { rows?: number } } & Record<string, unknown>;

/** Lines of chrome around the plan body: borders, title, scroll line, actions, hint. */
const CHROME_LINES = 9;

/** Light markdown styling for the terminal: headings stand out, everything else is plain wrapped text. */
function styleLine(line: string, theme: Theme): string {
  if (/^#{1,2} /.test(line)) return theme.fg("accent", theme.bold(line.replace(/^#+ /, "")));
  if (/^#{3,} /.test(line)) return theme.bold(line.replace(/^#+ /, ""));
  if (/^\*\*.+\*\*$/.test(line)) return theme.fg("muted", line.slice(2, -2));
  return line;
}

/**
 * Scrollable full-plan view with a row of actions underneath. ↑↓ and PgUp/PgDn scroll, ←→ or Tab pick an
 * action, Enter chooses it, Esc dismisses. Resolves with the action value, or undefined when dismissed.
 */
export function planReviewDialog(request: PlanReviewRequest, tui: Tui, theme: Theme, done: (value: string | undefined) => void) {
  let offset = 0;
  let selected = 0;
  let body: string[] = [];
  let bodyWidth = -1;
  let cached: string[] | undefined;

  const viewport = () => Math.max(6, (tui.terminal?.rows ?? 40) - CHROME_LINES);
  const maxOffset = () => Math.max(0, body.length - viewport());
  const refresh = () => {
    cached = undefined;
    tui.requestRender();
  };
  const scroll = (delta: number) => {
    offset = Math.min(maxOffset(), Math.max(0, offset + delta));
    refresh();
  };

  function handleInput(data: string): void {
    const count = request.actions.length;
    if (matchesKey(data, Key.up) || data === "k") return scroll(-1);
    if (matchesKey(data, Key.down) || data === "j") return scroll(1);
    if (matchesKey(data, Key.pageUp)) return scroll(-viewport() + 1);
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) return scroll(viewport() - 1);
    if (matchesKey(data, Key.home) || data === "g") return scroll(-body.length);
    if (matchesKey(data, Key.end) || data === "G") return scroll(body.length);
    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
      selected = (selected - 1 + count) % count;
      return refresh();
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      selected = (selected + 1) % count;
      return refresh();
    }
    const digit = Number(data);
    if (Number.isInteger(digit) && digit >= 1 && digit <= count) return done(request.actions[digit - 1]!.value);
    if (matchesKey(data, Key.enter)) return done(request.actions[selected]?.value);
    if (matchesKey(data, Key.escape)) return done(undefined);
  }

  function render(width: number): string[] {
    if (cached) return cached;
    const w = Math.max(10, width);
    if (bodyWidth !== w) {
      bodyWidth = w;
      body = request.markdown
        .replace(/\n+$/, "")
        .split("\n")
        .flatMap((line) => (line ? wrapTextWithAnsi(styleLine(line, theme), w - 2).map((part) => ` ${part}`) : [""]));
      offset = Math.min(offset, maxOffset());
    }
    const height = viewport();
    const lines = [theme.fg("accent", "─".repeat(w)), ` ${theme.fg("accent", theme.bold(request.title))}`, ""];
    const shown = body.slice(offset, offset + height);
    lines.push(...shown);
    // Keep the dialog a steady height so the actions do not jump while scrolling.
    for (let i = shown.length; i < Math.min(height, body.length); i += 1) lines.push("");
    const end = Math.min(body.length, offset + height);
    const more = body.length > height ? ` · ${end < body.length ? "↓ more below" : "end of plan"}` : "";
    lines.push(theme.fg("dim", ` lines ${body.length ? offset + 1 : 0}-${end} of ${body.length}${more}`), "");
    const buttons = request.actions.map((action, index) => {
      const text = ` ${index + 1}. ${action.label} `;
      return index === selected ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg("muted", text);
    });
    const row = ` ${buttons.join("  ")}`;
    lines.push(...(visibleWidth(row) > w ? wrapTextWithAnsi(row, w) : [row]));
    lines.push(theme.fg("dim", " ↑↓/PgUp/PgDn scroll • ←→ choose • Enter confirm • 1-9 pick • Esc close"), theme.fg("accent", "─".repeat(w)));
    cached = lines;
    return lines;
  }

  return {
    render,
    invalidate: () => {
      cached = undefined;
      bodyWidth = -1;
    },
    handleInput,
  };
}

/**
 * Shows the plan for review. An action with `input` asks for text in Pi's editor before it resolves; leaving
 * that editor empty returns to the plan. Resolves undefined when the person dismisses the dialog.
 */
export async function reviewPlan(ctx: Pick<ExtensionContext, "ui">, request: PlanReviewRequest): Promise<{ value: string; text?: string } | undefined> {
  for (;;) {
    const raw = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => planReviewDialog(request, tui as unknown as Tui, theme as unknown as Theme, done));
    // Tests (and older hosts) may hand back the whole result object rather than the action value.
    const result = typeof raw === "object" && raw !== null ? (raw as { value?: string; text?: string }) : { value: raw };
    const action: PlanReviewAction | undefined = request.actions.find((item) => item.value === result.value);
    if (!action) return undefined;
    if (!action.input) return { value: action.value };
    const text = result.text ?? (await ctx.ui.editor(action.input, ""));
    if (text?.trim()) return { value: action.value, text: text.trim() };
  }
}
