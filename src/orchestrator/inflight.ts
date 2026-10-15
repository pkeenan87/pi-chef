/** One running child's spend that is not in the ledger yet, with the way to stop it. */
export interface InFlightRun {
  readonly taskId: string;
  /** Spend so far in micro-USD. */
  micro: number;
  /** Stops the child. Called with the reason when a budget would be exceeded. */
  readonly abort: (reason: string) => void;
  tripped?: string;
}

/**
 * Spend by ticket children that are still running, shared by every concurrent ticket in a workflow. The ledger only
 * learns about a child's cost when it exits, so budget checks add this on top of the ledger.
 */
export class InFlightSpend {
  private readonly runs = new Set<InFlightRun>();

  begin(taskId: string, abort: (reason: string) => void): InFlightRun {
    const run: InFlightRun = { taskId, micro: 0, abort };
    this.runs.add(run);
    return run;
  }

  /** Forget a run once its usage is in the ledger (or it never ran). */
  release(run: InFlightRun): void {
    this.runs.delete(run);
  }

  taskMicro(taskId: string): number {
    let sum = 0;
    for (const run of this.runs) if (run.taskId === taskId) sum += run.micro;
    return sum;
  }

  totalMicro(): number {
    let sum = 0;
    for (const run of this.runs) sum += run.micro;
    return sum;
  }

  /** Stops every running child of `taskId` (or all of them when omitted), once each. */
  tripAll(reason: string, taskId?: string): void {
    for (const run of [...this.runs]) {
      if (run.tripped || (taskId !== undefined && run.taskId !== taskId)) continue;
      run.tripped = reason;
      run.abort(reason);
    }
  }
}
