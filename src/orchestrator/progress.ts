/**
 * A one-line live progress indicator for work that runs while no model is streaming (/review, and /build between
 * ticket turns). Pi's own spinner only shows while a model streams, so these would look frozen.
 *
 * It uses `ctx.ui.setWidget(key, [line])`, a widget above the editor: unlike `setStatus` it is not squeezed into the
 * footer next to the other status entries, and a plain string array needs no TUI component. The line is
 * `<spinner> <label> · <stage> · <elapsed>`; a timer redraws the frame and the elapsed time. Without a UI there is no
 * sink and every call is a no-op.
 */

export interface Indicator {
  /** Shows the line with this label (for example "Review"); the elapsed time restarts. */
  start(label: string): void;
  /** Sets what is happening now (for example "checks 1 of 2 running: npm test"). Ignored when not started. */
  stage(text: string): void;
  /** Hides the line and clears the timer. Safe to call when not started, and more than once. */
  stop(): void;
}

/** Where the line goes: the live Pi UI. `owner` identifies the Pi context behind it, so a rebind to the same one is not a change. */
export interface IndicatorSink {
  readonly owner: unknown;
  /** Draws the line, or removes it with undefined. May throw once its Pi context is stale. */
  render(line: string | undefined): void;
}

/** Injectable timer, so tests never run a real interval. */
export interface IndicatorTimer {
  every(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 120;

/** The default timer; unref'd so a forgotten indicator never keeps the process alive. */
export const realTimer: IndicatorTimer = {
  every(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** "12s", "1m12s", "1h02m": whole seconds, for a line that redraws every frame. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export class ProgressIndicator implements Indicator {
  private sink: IndicatorSink | undefined;
  private handle: unknown;
  private label: string | undefined;
  private stageText: string | undefined;
  private startedAt = 0;
  private frame = 0;

  constructor(
    private readonly now: () => Date,
    private readonly timer: IndicatorTimer = realTimer,
  ) {}

  /**
   * Points the indicator at the UI of the live Pi context (undefined without a UI). Called on every rebind: a new
   * context takes over a running line, and the old sink is cleared if it still can be.
   */
  attach(sink: IndicatorSink | undefined): void {
    if (sink?.owner === this.sink?.owner && !!sink === !!this.sink) return;
    const old = this.sink;
    this.sink = sink;
    if (old) {
      try {
        old.render(undefined);
      } catch {
        /* the old context is gone */
      }
    }
    if (this.label !== undefined) {
      if (sink) this.draw();
      else this.clearTimer();
    }
  }

  start(label: string): void {
    this.stop();
    this.label = label;
    this.stageText = undefined;
    this.startedAt = this.now().getTime();
    this.frame = 0;
    if (!this.sink) return;
    this.draw();
  }

  stage(text: string): void {
    if (this.label === undefined) return;
    this.stageText = text;
    if (this.sink) this.draw();
  }

  stop(): void {
    this.clearTimer();
    const wasShown = this.label !== undefined;
    this.label = undefined;
    this.stageText = undefined;
    if (wasShown) this.hide();
  }

  /** The line as drawn now. */
  line(): string | undefined {
    if (this.label === undefined) return undefined;
    const elapsed = formatClock(this.now().getTime() - this.startedAt);
    return `${SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]} ${[this.label, ...(this.stageText ? [this.stageText] : []), elapsed].join(" · ")}`;
  }

  private draw(): void {
    try {
      this.sink?.render(this.line());
      this.handle ??= this.timer.every(() => this.tick(), FRAME_MS);
    } catch {
      // A stale or closed UI: stop quietly rather than throw into the command.
      this.clearTimer();
    }
  }

  private tick(): void {
    this.frame++;
    try {
      this.sink?.render(this.line());
    } catch {
      this.clearTimer();
    }
  }

  private hide(): void {
    try {
      this.sink?.render(undefined);
    } catch {
      /* the context is gone */
    }
  }

  private clearTimer(): void {
    if (this.handle !== undefined) this.timer.clear(this.handle);
    this.handle = undefined;
  }
}
