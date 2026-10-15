import { WorkflowError, type TokenUsage, type WorkerArtifact } from "../domain.js";

export interface WorkerJob {
  id: string;
  files: string[];
  summary: string;
  tokenBudget: number;
  deadlineMs: number;
}

export interface PoolArtifact {
  id: string;
  artifact?: WorkerArtifact;
  error?: string;
  /** Additive: "failed" (ran and failed), "skipped" (never started because the pool stopped), "cancelled". */
  status?: "ok" | "failed" | "skipped" | "cancelled";
}

export interface PoolResult {
  artifacts: PoolArtifact[];
  stopped: "completed" | "cancelled" | "budget" | "repeated-failure";
}

export interface PoolRunContext {
  /** Remaining shared token budget at start, or undefined when no budgetRemaining callback was supplied. */
  budgetRemaining?: number;
}

function isArtifact(value: unknown): value is WorkerArtifact {
  if (!value || typeof value !== "object") return false;
  const raw = value as WorkerArtifact;
  return typeof raw.summary === "string" && Array.isArray(raw.changedFiles) && Array.isArray(raw.testResults) && Array.isArray(raw.unresolvedIssues) && !!raw.usage;
}

export async function runWorkerPool(options: {
  jobs: WorkerJob[];
  concurrency: number;
  run: (job: WorkerJob, signal: AbortSignal, context?: PoolRunContext) => Promise<unknown>;
  signal?: AbortSignal;
  maxAttempts?: number;
  budgetRemaining?: () => number;
}): Promise<PoolResult> {
  const concurrency = Math.max(1, options.concurrency);
  const maxAttempts = options.maxAttempts ?? 2;
  const pending = [...options.jobs];
  const artifacts: PoolResult["artifacts"] = [];
  const failures = new Map<string, number>();
  let stopped: PoolResult["stopped"] = "completed";
  const inFlight = new Set<Promise<void>>();
  const owned = new Set<string>();

  async function runOne(job: WorkerJob): Promise<void> {
    // The scheduler has already claimed job.files in `owned`.
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (options.signal?.aborted) {
        stopped = "cancelled";
        artifacts.push({ id: job.id, error: "Cancelled.", status: "cancelled" });
        return;
      }
      const remaining = options.budgetRemaining?.();
      if (remaining !== undefined && remaining <= 0) {
        stopped = "budget";
        artifacts.push({ id: job.id, error: "Budget exhausted before the worker started.", status: "failed" });
        return;
      }
      // Rejects on deadline or external abort so a worker that ignores the signal cannot overrun.
      const interrupted = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new WorkflowError("DEADLINE", `Worker ${job.id} exceeded its deadline.`));
        }, job.deadlineMs);
        onAbort = () => {
          controller.abort();
          reject(new WorkflowError("CANCELLED", `Worker ${job.id} was cancelled.`));
        };
        options.signal?.addEventListener("abort", onAbort);
      });
      interrupted.catch(() => undefined);
      const running = Promise.resolve().then(() => options.run(job, controller.signal, { budgetRemaining: remaining }));
      running.catch(() => undefined);
      const raw = await Promise.race([running, interrupted]);
      if (!isArtifact(raw)) {
        throw new WorkflowError("BAD_ARTIFACT", `Worker ${job.id} returned an invalid artifact.`);
      }
      const usage: TokenUsage = raw.usage;
      const total = (usage.input ?? 0) + (usage.output ?? 0);
      const overJob = usage.input !== null && usage.input > job.tokenBudget;
      const overShared = remaining !== undefined && usage.input !== null && total > remaining;
      if (overJob || overShared) {
        artifacts.push({ id: job.id, error: "Token budget exhausted.", artifact: raw, status: "failed" });
        stopped = "budget";
        return;
      }
      artifacts.push({ id: job.id, artifact: raw, status: "ok" });
    } catch (error) {
      if (timedOut) {
        artifacts.push({ id: job.id, error: "deadline", status: "failed" });
        return;
      }
      if (options.signal?.aborted) {
        stopped = "cancelled";
        artifacts.push({ id: job.id, error: "Cancelled.", status: "cancelled" });
        return;
      }
      const count = (failures.get(job.id) ?? 0) + 1;
      failures.set(job.id, count);
      if (count >= maxAttempts) {
        stopped = "repeated-failure";
        artifacts.push({ id: job.id, error: (error as Error).message, status: "failed" });
        return;
      }
      pending.push(job);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      for (const file of job.files) owned.delete(file);
    }
  }

  function startRunnable(): void {
    // Files of earlier jobs that are still waiting; later jobs may not jump ahead of them on the same files.
    const reserved = new Set<string>();
    let index = 0;
    while (index < pending.length && inFlight.size < concurrency && stopped === "completed") {
      const job = pending[index]!;
      const blocked = job.files.some((file) => owned.has(file) || reserved.has(file));
      if (blocked) {
        for (const file of job.files) reserved.add(file);
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      for (const file of job.files) owned.add(file);
      const promise: Promise<void> = runOne(job).finally(() => inFlight.delete(promise));
      inFlight.add(promise);
    }
  }

  while ((pending.length > 0 || inFlight.size > 0) && stopped === "completed") {
    startRunnable();
    if (inFlight.size === 0) break;
    await Promise.race(inFlight);
  }
  await Promise.all([...inFlight]);
  // Surface jobs that never ran so callers can see them.
  const finalStop = stopped as PoolResult["stopped"];
  const status = finalStop === "cancelled" ? "cancelled" : "skipped";
  for (const job of pending.splice(0)) {
    artifacts.push({ id: job.id, error: finalStop === "completed" ? "Skipped." : `Skipped: pool stopped (${finalStop}).`, status });
  }
  return { artifacts, stopped };
}
