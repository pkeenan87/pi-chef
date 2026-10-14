import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { redactUnknown } from "../redact.js";
import { WorkflowError, type CostRecord, type Phase, type TaskState } from "../domain.js";

export interface TaskEvent {
  seq: number;
  at: string;
  type: "transition" | "note";
  from?: Phase;
  to?: Phase;
  reason?: string;
  message?: string;
  state?: TaskState;
}

interface LockRecord {
  pid: number;
  token: string;
  at: number;
}

const chains = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireFile(lockPath: string): Promise<() => void> {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = JSON.stringify({ pid: process.pid, token, at: Date.now() } satisfies LockRecord);
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, payload);
      closeSync(fd);
      return () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
          if (current.token === token) unlinkSync(lockPath);
        } catch {
          /* already released */
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const current = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
        const age = Date.now() - current.at;
        if (!pidAlive(current.pid) && age > 1000) unlinkSync(lockPath);
      } catch {
        /* raced with the holder */
      }
      await sleep(10);
    }
  }
  throw new WorkflowError("LOCKED", `Could not acquire lock ${lockPath}`);
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = chains.get(lockPath) ?? Promise.resolve();
  let releaseChain: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseChain = resolve;
  });
  chains.set(lockPath, previous.then(() => current));
  await previous.catch(() => undefined);
  const releaseFile = await acquireFile(lockPath);
  try {
    return await fn();
  } finally {
    releaseFile();
    releaseChain();
  }
}

export function atomicWrite(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function writeOnce(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "wx");
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function readEvents(file: string): TaskEvent[] {
  if (!existsSync(file)) return [];
  const events: TaskEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TaskEvent);
    } catch {
      /* truncated tail after a crash */
    }
  }
  return events;
}

export function foldEvents(events: TaskEvent[]): TaskState | undefined {
  let state: TaskState | undefined;
  for (const event of events) {
    if (event.state) state = event.state;
  }
  return state;
}

export class TaskStore {
  constructor(readonly root: string) {}

  taskDir(taskId: string): string {
    return path.join(this.root, "tasks", taskId);
  }

  private lockPath(taskId: string): string {
    return path.join(this.taskDir(taskId), ".lock");
  }

  listTaskIds(): string[] {
    const dir = path.join(this.root, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => existsSync(path.join(dir, name, "events.jsonl")));
  }

  readActive(): string | undefined {
    const file = path.join(this.root, "active-task.json");
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { taskId?: string };
      return parsed.taskId;
    } catch {
      return undefined;
    }
  }

  setActive(taskId: string): void {
    atomicWrite(path.join(this.root, "active-task.json"), JSON.stringify({ taskId }, null, 2));
  }

  load(taskId: string): TaskState | undefined {
    const events = readEvents(path.join(this.taskDir(taskId), "events.jsonl"));
    const folded = foldEvents(events);
    if (!folded) return undefined;
    const snapshotPath = path.join(this.taskDir(taskId), "state.json");
    if (!existsSync(snapshotPath)) {
      atomicWrite(snapshotPath, JSON.stringify(folded, null, 2));
    }
    return folded;
  }

  async update(taskId: string, reason: string, mutate: (current: TaskState) => TaskState): Promise<TaskState> {
    return withLock(this.lockPath(taskId), async () => {
      const dir = this.taskDir(taskId);
      const eventsPath = path.join(dir, "events.jsonl");
      const events = readEvents(eventsPath);
      const current = foldEvents(events);
      if (!current) throw new WorkflowError("NO_TASK", `Task ${taskId} does not exist`);
      const next = redactUnknown(mutate(structuredClone(current))) as TaskState;
      next.updatedAt = next.updatedAt || current.updatedAt;
      const event: TaskEvent = {
        seq: events.length + 1,
        at: next.updatedAt,
        type: "transition",
        from: current.phase,
        to: next.phase,
        reason: typeof redactUnknown(reason) === "string" ? (redactUnknown(reason) as string) : reason,
        state: next,
      };
      mkdirSync(dir, { recursive: true });
      appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
      atomicWrite(path.join(dir, "state.json"), JSON.stringify(next, null, 2));
      return next;
    });
  }

  async create(state: TaskState): Promise<TaskState> {
    const clean = redactUnknown(state) as TaskState;
    return withLock(this.lockPath(clean.taskId), async () => {
      const dir = this.taskDir(clean.taskId);
      mkdirSync(dir, { recursive: true });
      const event: TaskEvent = {
        seq: 1,
        at: clean.updatedAt,
        type: "transition",
        from: "IDLE",
        to: clean.phase,
        reason: "create",
        state: clean,
      };
      writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
      atomicWrite(path.join(dir, "state.json"), JSON.stringify(clean, null, 2));
      this.setActive(clean.taskId);
      return clean;
    });
  }

  writeText(taskId: string, relative: string, data: string): string {
    const file = path.join(this.taskDir(taskId), relative);
    atomicWrite(file, data);
    return file;
  }

  writeOnceText(taskId: string, relative: string, data: string): string {
    const file = path.join(this.taskDir(taskId), relative);
    if (existsSync(file)) {
      throw new WorkflowError("IMMUTABLE", `${relative} is already frozen and cannot be overwritten.`);
    }
    writeOnce(file, data);
    return file;
  }

  readText(taskId: string, relative: string): string | undefined {
    const file = path.join(this.taskDir(taskId), relative);
    if (!existsSync(file)) return undefined;
    return readFileSync(file, "utf8");
  }

  appendLedger(record: CostRecord): void {
    const file = path.join(this.root, "cost", "ledger.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    const clean = redactUnknown(record) as CostRecord;
    writeFileSync(file, `${JSON.stringify(clean)}\n`, { flag: "a" });
  }

  readLedger(): CostRecord[] {
    const file = path.join(this.root, "cost", "ledger.jsonl");
    if (!existsSync(file)) return [];
    const records: CostRecord[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as CostRecord);
      } catch {
        /* ignore a torn line */
      }
    }
    return records;
  }

  readMetrics(): Record<string, Record<string, { success: number; failure: number }>> {
    const file = path.join(this.root, "metrics", "success.json");
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, { success: number; failure: number }>>;
    } catch {
      return {};
    }
  }

  writeMetrics(metrics: Record<string, Record<string, { success: number; failure: number }>>): void {
    atomicWrite(path.join(this.root, "metrics", "success.json"), JSON.stringify(metrics, null, 2));
  }

  notify(message: string): void {
    const file = path.join(this.root, "notifications.jsonl");
    mkdirSync(this.root, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), message })}\n`, { flag: "a" });
  }

  removeWorktreeDir(dir: string): void {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  statAgeMs(file: string): number | undefined {
    if (!existsSync(file)) return undefined;
    return Date.now() - statSync(file).mtimeMs;
  }
}
