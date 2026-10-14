import { WorkflowError, type TokenUsage, type WorkerArtifact } from "../domain.js";

export interface WorkerJob {
  id: string;
  files: string[];
  summary: string;
  tokenBudget: number;
  deadlineMs: number;
}

export interface PoolResult {
  artifacts: { id: string; artifact?: WorkerArtifact; error?: string }[];
  stopped: "completed" | "cancelled" | "budget" | "repeated-failure";
}

function isArtifact(value: unknown): value is WorkerArtifact {
  if (!value || typeof value !== "object") return false;
  const raw = value as WorkerArtifact;
  return typeof raw.summary === "string" && Array.isArray(raw.changedFiles) && Array.isArray(raw.testResults) && Array.isArray(raw.unresolvedIssues) && !!raw.usage;
}

export async function runWorkerPool(options: {
  jobs: WorkerJob[];
  concurrency: number;
  run: (job: WorkerJob, signal: AbortSignal) => Promise<unknown>;
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
    const overlap = job.files.filter((file) => owned.has(file));
    if (overlap.length > 0) {
      pending.unshift(job);
      return;
    }
    for (const file of job.files) owned.add(file);
    let acquired = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), job.deadlineMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);
    try {
      if (options.signal?.aborted) {
        stopped = "cancelled";
        return;
      }
      if (options.budgetRemaining && options.budgetRemaining() <= 0) {
        stopped = "budget";
        artifacts.push({ id: job.id, error: "Budget exhausted before the worker started." });
        return;
      }
      const raw = await options.run(job, controller.signal);
      if (!isArtifact(raw)) {
        throw new WorkflowError("BAD_ARTIFACT", `Worker ${job.id} returned an invalid artifact.`);
      }
      const usage: TokenUsage = raw.usage;
      if (usage.input !== null && usage.input > job.tokenBudget) {
        artifacts.push({ id: job.id, error: "Token budget exhausted.", artifact: raw });
        stopped = "budget";
        return;
      }
      artifacts.push({ id: job.id, artifact: raw });
    } catch (error) {
      const count = (failures.get(job.id) ?? 0) + 1;
      failures.set(job.id, count);
      if (controller.signal.aborted && options.signal?.aborted) {
        stopped = "cancelled";
        artifacts.push({ id: job.id, error: "Cancelled." });
        return;
      }
      if (count >= maxAttempts) {
        stopped = "repeated-failure";
        artifacts.push({ id: job.id, error: (error as Error).message });
        return;
      }
      pending.push(job);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (acquired) {
        for (const file of job.files) owned.delete(file);
      }
    }
  }

  while ((pending.length > 0 || inFlight.size > 0) && stopped === "completed") {
    while (pending.length > 0 && inFlight.size < concurrency && stopped === "completed") {
      const job = pending.shift();
      if (!job) break;
      const busy = job.files.some((file) => owned.has(file));
      if (busy) {
        pending.push(job);
        break;
      }
      const promise = runOne(job).finally(() => inFlight.delete(promise));
      inFlight.add(promise);
    }
    if (inFlight.size === 0) break;
    await Promise.race(inFlight);
  }
  await Promise.all([...inFlight]);
  return { artifacts, stopped };
}
