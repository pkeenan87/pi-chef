/** The ticket turn budget: a leaf module, so ticket mode can use it without loading the orchestrator. */

/** Limits on one ticket attempt, its retry turns included. */
export interface ChunkLimits {
  /** Assistant turns before the model is told to wrap up (`routing.maxTicketTurns`); the run stops TURN_GRACE turns later. */
  maxTurns: number;
}

/** Turns a model gets to finish after it is told the turn budget is spent. */
export const TURN_GRACE = 5;

/** The steer sent when a ticket reaches its turn budget. */
export function turnLimitNotice(maxTurns: number): string {
  return `You have used this ticket's budget of ${maxTurns} turns. Stop exploring and finish now: complete the change you are making, then reply with the closing checklist. After ${TURN_GRACE} more turns the run is stopped and the ticket fails.`;
}

/**
 * Counts a ticket attempt's assistant turns. At `maxTurns` it steers the model to wrap up, once; TURN_GRACE turns later
 * it aborts the run, and `stopped()` says so. Steering and aborting never throw out of a message_end handler.
 */
export function turnBudget(limits: ChunkLimits | undefined, steer: (text: string) => unknown, abort: () => void): { count: () => void; stopped: () => boolean } {
  let turns = 0;
  let stopped = false;
  const safely = (action: () => unknown) => {
    try {
      const result = action();
      if (result && typeof (result as Promise<unknown>).catch === "function") (result as Promise<unknown>).catch(() => undefined);
    } catch {
      /* the next turn tries again: the limit check is >= */
    }
  };
  return {
    count() {
      if (!limits || stopped) return;
      turns += 1;
      if (turns === limits.maxTurns) safely(() => steer(turnLimitNotice(limits.maxTurns)));
      if (turns >= limits.maxTurns + TURN_GRACE) {
        stopped = true;
        safely(abort);
      }
    },
    stopped: () => stopped,
  };
}
