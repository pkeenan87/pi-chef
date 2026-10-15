import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, readSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { redactUnknown } from "../redact.js";
import { modelMetricKey, WorkflowError, type CostRecord, type Phase, type TaskState } from "../domain.js";

export interface TaskEvent {
  seq: number;
  at: string;
  type: "transition" | "note" | "route" | "decision";
  from?: Phase;
  to?: Phase;
  reason?: string;
  message?: string;
  /** Full state; only written by create(). Older logs carry it on every event. */
  state?: TaskState;
  /** Changed top-level keys with their new values (compact transition record). */
  patch?: Partial<TaskState>;
  /** Top-level keys removed by the transition. */
  removed?: string[];
  /** Names of the changed top-level keys (readable summary of patch/removed). */
  changed?: string[];
  /** A routing decision (type "route"). Does not change state. */
  route?: RouteEvent;
  /** One interview answer (type "decision"). Does not change state. */
  decision?: DecisionEvent;
}

export interface DecisionEvent {
  round: number;
  questionId: string;
  title: string;
  value: string;
  label: string;
  wasCustom: boolean;
  acceptedRecommendation: boolean;
}

export interface RouteEvent {
  purpose: string;
  tier: string;
  provider: string;
  model: string;
  reason: string;
  considered: string[];
}

export interface LockOptions {
  /** Total time to wait for the file lock before throwing LOCKED. Default 10s. */
  timeoutMs?: number;
  /** Treat locks held by dead pids as stale after this age. Default 1s. */
  staleMs?: number;
}

interface LockRecord {
  pid: number;
  token: string;
  at: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const chains = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockRaw(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Remove a stale lock without racing a new holder: rename it to a unique tombstone
 * (atomic), verify the tombstone still holds the stale content, and put it back
 * with an atomic link if we accidentally grabbed a freshly acquired lock.
 */
function breakStaleLock(lockPath: string, staleMs: number): void {
  const raw = readLockRaw(lockPath);
  if (raw === undefined) return;
  let current: LockRecord;
  try {
    current = JSON.parse(raw) as LockRecord;
  } catch {
    return;
  }
  if (pidAlive(current.pid) || Date.now() - current.at <= staleMs) return;
  const tomb = `${lockPath}.stale.${randomUUID()}`;
  try {
    renameSync(lockPath, tomb);
  } catch {
    return;
  }
  if (readLockRaw(tomb) === raw) {
    rmSync(tomb, { force: true });
    return;
  }
  try {
    linkSync(tomb, lockPath);
  } catch {
    /* someone else already holds a new lock */
  }
  rmSync(tomb, { force: true });
}

async function acquireFile(lockPath: string, options: LockOptions = {}): Promise<() => void> {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const payload = JSON.stringify({ pid: process.pid, token, at: Date.now() } satisfies LockRecord);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  let delay = 5;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, payload);
      } finally {
        closeSync(fd);
      }
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
      breakStaleLock(lockPath, options.staleMs ?? 1000);
      if (Date.now() >= deadline) break;
      await sleep(Math.min(delay, Math.max(1, deadline - Date.now())));
      delay = Math.min(delay * 2, 100);
    }
  }
  throw new WorkflowError("LOCKED", `Could not acquire lock ${lockPath}`);
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T> | T, options?: LockOptions): Promise<T> {
  const previous = chains.get(lockPath) ?? Promise.resolve();
  let releaseChain: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseChain = resolve;
  });
  const tail = previous.then(() => current);
  chains.set(lockPath, tail);
  try {
    await previous.catch(() => undefined);
    const releaseFile = await acquireFile(lockPath, options);
    try {
      return await fn();
    } finally {
      releaseFile();
    }
  } finally {
    releaseChain();
    if (chains.get(lockPath) === tail) chains.delete(lockPath);
  }
}

export function atomicWrite(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
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

/** Make sure a line-oriented file ends in a newline so the next append starts a fresh line. */
function repairTail(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size === 0) return;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    if (buf[0] !== 0x0a) appendFileSync(file, "\n");
  } finally {
    closeSync(fd);
  }
}

interface ReadEvents {
  events: TaskEvent[];
  /** Unparseable lines that are not the final line. */
  corrupt: number;
  /** True when the final line was unparseable (torn write) and skipped. */
  tornTail: boolean;
}

function readEvents(file: string): ReadEvents {
  if (!existsSync(file)) return { events: [], corrupt: 0, tornTail: false };
  const lines = readFileSync(file, "utf8").split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  const events: TaskEvent[] = [];
  let corrupt = 0;
  let tornTail = false;
  for (let i = 0; i <= last; i++) {
    if (!lines[i].trim()) continue;
    try {
      events.push(JSON.parse(lines[i]) as TaskEvent);
    } catch {
      if (i === last) tornTail = true;
      else corrupt++;
    }
  }
  return { events, corrupt, tornTail };
}

export function foldEvents(events: TaskEvent[]): TaskState | undefined {
  let state: TaskState | undefined;
  for (const event of events) {
    if (event.state) {
      state = event.state;
    } else if (state && (event.patch || event.removed)) {
      const next = { ...state, ...(event.patch ?? {}) } as Record<string, unknown>;
      for (const key of event.removed ?? []) delete next[key];
      state = next as unknown as TaskState;
    }
  }
  return state;
}

function diffState(before: TaskState, after: TaskState): { patch: Partial<TaskState>; removed: string[]; changed: string[] } {
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const key of Object.keys(b)) {
    if (b[key] === undefined) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) patch[key] = b[key];
  }
  for (const key of Object.keys(a)) {
    if (a[key] !== undefined && b[key] === undefined) removed.push(key);
  }
  return { patch: patch as Partial<TaskState>, removed, changed: [...Object.keys(patch), ...removed] };
}

type Metrics = Record<string, Record<string, { success: number; failure: number; recent?: { at: string; ok: boolean }[] }>>;

const RECENT_ATTEMPTS = 20;

interface FileSig {
  mtimeMs: number;
  size: number;
  ino: number;
}

function fileSig(file: string): FileSig | undefined {
  try {
    const st = statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
  } catch {
    return undefined;
  }
}

function sameSig(a: FileSig | undefined, b: FileSig | undefined): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

export class TaskStore {
  private ledgerCache?: { sig: FileSig; records: CostRecord[] };
  private metricsCache?: { sig: FileSig; metrics: Metrics };
  private seqCache = new Map<string, { size: number; seq: number }>();

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

  /** Number of corrupt (non-tail) lines in a task's event log. */
  corruptEventLines(taskId: string): number {
    return readEvents(path.join(this.taskDir(taskId), "events.jsonl")).corrupt;
  }

  /** state.json is the source of truth; the event log is replayed only if it is missing or corrupt. */
  load(taskId: string): TaskState | undefined {
    const dir = this.taskDir(taskId);
    const snapshotPath = path.join(dir, "state.json");
    if (existsSync(snapshotPath)) {
      try {
        const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as TaskState;
        if (parsed && typeof parsed === "object" && typeof parsed.taskId === "string") return parsed;
      } catch {
        /* fall back to replay */
      }
    }
    const folded = foldEvents(readEvents(path.join(dir, "events.jsonl")).events);
    if (!folded) return undefined;
    atomicWrite(snapshotPath, JSON.stringify(folded, null, 2));
    return folded;
  }

  private nextSeq(eventsPath: string): number {
    const size = existsSync(eventsPath) ? statSync(eventsPath).size : 0;
    const cached = this.seqCache.get(eventsPath);
    if (cached && cached.size === size) return cached.seq + 1;
    const { events } = readEvents(eventsPath);
    return events.reduce((max, event) => (typeof event.seq === "number" && event.seq > max ? event.seq : max), 0) + 1;
  }

  private appendEvent(eventsPath: string, event: TaskEvent): void {
    repairTail(eventsPath);
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
    this.seqCache.set(eventsPath, { size: statSync(eventsPath).size, seq: event.seq });
  }

  async update(taskId: string, reason: string, mutate: (current: TaskState) => TaskState): Promise<TaskState> {
    return withLock(this.lockPath(taskId), async () => {
      const dir = this.taskDir(taskId);
      const eventsPath = path.join(dir, "events.jsonl");
      const current = this.load(taskId);
      if (!current) throw new WorkflowError("NO_TASK", `Task ${taskId} does not exist`);
      const next = redactUnknown(mutate(structuredClone(current))) as TaskState;
      next.updatedAt = next.updatedAt || current.updatedAt;
      const cleanReason = redactUnknown(reason);
      const diff = diffState(current, next);
      const event: TaskEvent = {
        seq: this.nextSeq(eventsPath),
        at: next.updatedAt,
        type: "transition",
        from: current.phase,
        to: next.phase,
        reason: typeof cleanReason === "string" ? cleanReason : reason,
        changed: diff.changed,
        patch: diff.patch,
        ...(diff.removed.length ? { removed: diff.removed } : {}),
      };
      mkdirSync(dir, { recursive: true });
      this.appendEvent(eventsPath, event);
      atomicWrite(path.join(dir, "state.json"), JSON.stringify(next, null, 2));
      return next;
    });
  }

  async create(state: TaskState): Promise<TaskState> {
    const clean = redactUnknown(state) as TaskState;
    return withLock(this.lockPath(clean.taskId), async () => {
      const dir = this.taskDir(clean.taskId);
      mkdirSync(dir, { recursive: true });
      const eventsPath = path.join(dir, "events.jsonl");
      if (existsSync(eventsPath)) {
        throw new WorkflowError("TASK_EXISTS", `Task ${clean.taskId} already exists`);
      }
      const event: TaskEvent = {
        seq: 1,
        at: clean.updatedAt,
        type: "transition",
        from: "IDLE",
        to: clean.phase,
        reason: "create",
        state: clean,
      };
      writeFileSync(eventsPath, `${JSON.stringify(event)}\n`, { flag: "wx" });
      this.seqCache.set(eventsPath, { size: statSync(eventsPath).size, seq: 1 });
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

  /** Writes `files` (name to content) under a task subfolder and removes any other file left there by an earlier draft. */
  replaceTextDir(taskId: string, relative: string, files: Record<string, string>): string[] {
    const dir = path.join(this.taskDir(taskId), relative);
    mkdirSync(dir, { recursive: true });
    for (const [name, data] of Object.entries(files)) atomicWrite(path.join(dir, name), data);
    for (const name of readdirSync(dir)) if (!(name in files)) rmSync(path.join(dir, name), { force: true });
    return Object.keys(files).map((name) => path.join(dir, name));
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
    repairTail(file);
    appendFileSync(file, `${JSON.stringify(clean)}\n`);
  }

  readLedger(): CostRecord[] {
    const file = path.join(this.root, "cost", "ledger.jsonl");
    const sig = fileSig(file);
    if (!sig) {
      this.ledgerCache = undefined;
      return [];
    }
    if (this.ledgerCache && sameSig(this.ledgerCache.sig, sig)) return this.ledgerCache.records.slice();
    const records: CostRecord[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as CostRecord);
      } catch {
        /* ignore a torn line */
      }
    }
    this.ledgerCache = { sig, records };
    return records.slice();
  }

  readMetrics(): Metrics {
    const file = path.join(this.root, "metrics", "success.json");
    const sig = fileSig(file);
    if (!sig) {
      this.metricsCache = undefined;
      return {};
    }
    if (this.metricsCache && sameSig(this.metricsCache.sig, sig)) return structuredClone(this.metricsCache.metrics);
    try {
      const metrics = JSON.parse(readFileSync(file, "utf8")) as Metrics;
      this.metricsCache = { sig, metrics };
      return structuredClone(metrics);
    } catch {
      return {};
    }
  }

  writeMetrics(metrics: Metrics): void {
    atomicWrite(path.join(this.root, "metrics", "success.json"), JSON.stringify(metrics, null, 2));
  }

  /** Locked read-modify-write of one success/failure counter; also keeps the last attempts for the time-windowed circuit breaker. */
  async bumpMetric(taskType: string, tier: string, success: boolean, at: Date = new Date(), candidate?: { provider: string; model: string }): Promise<void> {
    await withLock(path.join(this.root, "metrics", ".lock"), () => {
      const metrics = this.readMetrics();
      const row = metrics[taskType] ?? {};
      // The per-tier cell feeds the circuit breaker; the per-model cell feeds candidate selection.
      const keys = candidate ? [tier, modelMetricKey(tier, candidate.provider, candidate.model)] : [tier];
      for (const key of keys) {
        const cell = row[key] ?? { success: 0, failure: 0 };
        if (success) cell.success += 1;
        else cell.failure += 1;
        cell.recent = [...(cell.recent ?? []), { at: at.toISOString(), ok: success }].slice(-RECENT_ATTEMPTS);
        row[key] = cell;
      }
      metrics[taskType] = row;
      this.writeMetrics(metrics);
    });
  }

  /** Appends a `route` event to the task log without touching state.json. */
  async appendRoute(taskId: string, route: RouteEvent, at: string): Promise<void> {
    await withLock(this.lockPath(taskId), async () => {
      const dir = this.taskDir(taskId);
      if (!existsSync(dir)) return;
      const eventsPath = path.join(dir, "events.jsonl");
      const clean = redactUnknown(route) as RouteEvent;
      this.appendEvent(eventsPath, { seq: this.nextSeq(eventsPath), at, type: "route", route: clean });
    });
  }

  /** Appends a `decision` event (one interview answer) to the task log without touching state.json. */
  async appendDecision(taskId: string, decision: DecisionEvent, at: string): Promise<void> {
    await withLock(this.lockPath(taskId), async () => {
      const dir = this.taskDir(taskId);
      if (!existsSync(dir)) return;
      const eventsPath = path.join(dir, "events.jsonl");
      const clean = redactUnknown(decision) as DecisionEvent;
      this.appendEvent(eventsPath, { seq: this.nextSeq(eventsPath), at, type: "decision", decision: clean });
    });
  }

  notify(message: string): void {
    const file = path.join(this.root, "notifications.jsonl");
    mkdirSync(this.root, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), message })}\n`, { flag: "a" });
  }

  statAgeMs(file: string): number | undefined {
    if (!existsSync(file)) return undefined;
    return Date.now() - statSync(file).mtimeMs;
  }
}
