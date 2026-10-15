/**
 * The autopilot timer. `stopGen` is bumped by every stop so a cycle already in flight cannot re-arm
 * after it; `gen` invalidates a timer that has been replaced or cancelled.
 */
export class Poller {
  polling = false;
  stopGen = 0;
  cycleStop = 0;
  private gen = 0;
  private cancel?: () => void;

  constructor(
    private readonly schedule: ((delayMs: number, run: () => void) => () => void) | undefined,
    public pollSeconds: number,
    private readonly onTick: () => Promise<void>,
    /** Called when a tick rejects, so a failed timer poll is reported instead of becoming an unhandled rejection. */
    private readonly onError?: (error: unknown) => void,
  ) {}

  /** True when a stop arrived during the current cycle. */
  get stopped(): boolean {
    return this.stopGen !== this.cycleStop;
  }

  disarm(): void {
    this.gen += 1;
    this.cancel?.();
    this.cancel = undefined;
  }

  /** Invalidates the timer and any in-flight cycle. */
  stop(): void {
    this.stopGen += 1;
    this.disarm();
  }

  arm(backoffSeconds: number): void {
    if (!this.schedule) return;
    // A stop that arrived during this cycle wins over any re-arm.
    if (this.stopped) return;
    this.disarm();
    const generation = this.gen;
    const delay = (backoffSeconds > 0 ? backoffSeconds : this.pollSeconds) * 1000;
    this.cancel = this.schedule(delay, () => {
      void this.fire(generation);
    });
  }

  private async fire(generation: number): Promise<void> {
    if (generation !== this.gen) return;
    this.cancel = undefined;
    try {
      await this.onTick();
    } catch (error) {
      try {
        this.onError?.(error);
      } catch {
        /* reporting must not throw out of a timer */
      }
    }
  }
}
