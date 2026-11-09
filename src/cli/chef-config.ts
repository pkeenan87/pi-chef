/**
 * chef-config: the bridge between pi-chef and the herdr side panel. Every command prints one JSON document on stdout.
 * A refused request is data (`{ ok: false, error }`, exit 0); the exit status is nonzero only for a usage error.
 * The panel shows four things (models, the local server, plans, costs), so this is a small purpose-built CLI, not a
 * generic config editor. Edits go to the user file (`~/.pi/agent/chef.yaml`) through the `yaml` Document API so its
 * comments survive, are validated by the real loader before anything is written, and never carry a secret.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isMap, isScalar, parse, parseDocument, type Document } from "yaml";
import { agentTable, parseTicketModel, ticketModelProblem } from "../agents.js";
import { MODEL_KEYS, configPaths, displayPath, loadConfig, parseConfig, type LocalModelConfig, type WorkflowConfig } from "../config.js";
import { budgetStatusFor, makeDayKey, recordsForDay, summarize, unpricedModels, type SpendBucket } from "../cost/ledger.js";
import type { CostRecord, TaskState } from "../domain.js";
import type { WorkflowContext } from "../orchestrator/context.js";
import { closeTask, displayName, isClosed, listTasks, stateText, unfinishedTasks } from "../orchestrator/tasks.js";
import { contextMismatch, probeLocalContext, serverOrigin } from "../providers/local-context.js";
import { containsSecret, redact } from "../redact.js";
import { TaskStore, atomicWrite } from "../storage/store.js";

const execFileAsync = promisify(execFile);

/** Servers the panel offers as presets for `local.baseUrl`. */
export const LOCAL_PRESETS = [
  { name: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
  { name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
] as const;

const SET_KEYS = ["models.low", "models.medium", "models.high", "models.review", "local.baseUrl", "budgets.taskUsd", "budgets.dailyUsd"] as const;
const PHASE_LABELS: Record<string, string> = { PLANNING: "plan", AWAITING_PLAN_APPROVAL: "plan", IMPLEMENTING: "build", REVIEWING: "review" };
const RECENT_CLOSED = 8;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function messageOf(error: unknown): string {
  return redact(error instanceof Error && error.message ? error.message : String(error));
}

function refuse(error: string, extra: Json = {}): Json {
  return { ok: false, error: redact(error), ...extra };
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/** The YAML mapping of a config file, or undefined when it is missing, unreadable or not a mapping. */
function readRaw(file: string): Json | undefined {
  try {
    const parsed = parse(readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface Effective {
  config: WorkflowConfig;
  errors: string[];
  /** Raw mappings of the two files (undefined when missing or unreadable). */
  user?: Json;
  project?: Json;
}

/** The config as the loader gives it. A rejected file does not stop the panel: the defaults (plus what the user file says) are shown with the error. */
function effective(cwd: string): Effective {
  const { userPath, projectPath } = configPaths(cwd);
  const user = existsSync(userPath) ? readRaw(userPath) : undefined;
  const project = existsSync(projectPath) ? readRaw(projectPath) : undefined;
  try {
    return { config: loadConfig(cwd), errors: [], user, project };
  } catch (error) {
    const config = parseConfig("");
    config.models = { ...config.models };
    config.budgets = { ...config.budgets };
    // What the user file says, as far as it goes, so the person sees (and can fix) the value that was refused.
    if (isRecord(user?.models)) for (const key of MODEL_KEYS) if (typeof user.models[key] === "string") config.models[key] = user.models[key];
    if (isRecord(user?.budgets)) for (const key of ["taskUsd", "dailyUsd"] as const) if (typeof user.budgets[key] === "number") config.budgets[key] = user.budgets[key];
    if (isRecord(user?.agents)) config.agents = user.agents as WorkflowConfig["agents"];
    if (isRecord(user?.local) && typeof user.local.baseUrl === "string") {
      const models = Array.isArray(user.local.models) ? (user.local.models as unknown[]).filter((m): m is LocalModelConfig => isRecord(m) && typeof m.id === "string" && typeof m.contextWindow === "number") : [];
      config.local = { baseUrl: user.local.baseUrl, models };
    }
    return { config, errors: [messageOf(error)], user, project };
  }
}

function fileView(file: string): Json {
  const view: Json = { path: file, display: displayPath(file), exists: existsSync(file), sha256: sha256("") };
  if (view.exists) {
    try {
      view.sha256 = sha256(readFileSync(file, "utf8"));
    } catch (error) {
      view.readError = messageOf(error);
    }
  }
  return view;
}

/** A minimal context for the orchestrator helpers that only read the store, the clock and the config. */
function contextFor(cwd: string, config: WorkflowConfig): WorkflowContext {
  return { cwd, config, store: new TaskStore(path.join(cwd, config.workspaceDir)), now: () => new Date() } as unknown as WorkflowContext;
}

// ---------------------------------------------------------------- models

function modelRow(key: (typeof MODEL_KEYS)[number], eff: Effective): Json {
  const { config } = eff;
  const value = config.models[key];
  const userModels = isRecord(eff.user?.models) ? eff.user.models : undefined;
  const projectModels = isRecord(eff.project?.models) ? eff.project.models : undefined;
  const source = projectModels ? (key in projectModels ? "project" : "default") : userModels && key in userModels ? "user" : "default";
  const row: Json = { value, source, kind: "pi" };
  let problem = ticketModelProblem(value, config);
  try {
    const parsed = parseTicketModel(value, config);
    if (parsed.kind === "agent") {
      row.kind = "agent";
      row.agent = parsed.name;
      if (parsed.model) row.agentModel = parsed.model;
    } else if (parsed.provider === "local") {
      row.kind = "local";
      row.id = parsed.id;
      if (!problem && !(config.local?.models ?? []).some((m) => m.id === parsed.id)) {
        problem = config.local ? `The local server config does not list ${parsed.id}. Add it under Local model.` : "No local server is configured. Set one up under Local model.";
      }
    } else {
      row.provider = parsed.provider;
      row.id = parsed.id;
    }
  } catch {
    if (value.startsWith("agent:")) row.kind = "agent";
  }
  if (problem) row.problem = problem;
  return row;
}

// ---------------------------------------------------------------- plans

interface PlanView {
  id: string;
  name: string;
  state: string;
  phase: string;
  closed: boolean;
  active: boolean;
  ticketsDone: number;
  ticketsTotal: number;
  ticketsFailed: number;
  branch?: string;
  updatedAt: string;
  /** Known spend plus the estimate for calls of unknown cost. */
  spendUsd: number;
  knownUsd: number;
  unknown: number;
}

function planView(task: TaskState, active: string | undefined, spend: SpendBucket | undefined): PlanView {
  const runs = Object.values(task.ticketRuns ?? {});
  const total = (task.plan?.tickets ?? []).length || runs.length;
  const known = spend?.knownUsd ?? 0;
  return {
    id: task.taskId,
    name: displayName(task),
    state: stateText(task),
    phase: task.phase,
    closed: isClosed(task),
    active: task.taskId === active,
    ticketsDone: runs.filter((run) => run.status === "done").length,
    ticketsTotal: total,
    ticketsFailed: runs.filter((run) => run.status === "failed").length,
    ...(task.build?.branch ? { branch: task.build.branch } : {}),
    updatedAt: task.updatedAt,
    spendUsd: round(known + (spend?.estimatedUnknownUsd ?? 0)),
    knownUsd: known,
    unknown: spend?.unknown ?? 0,
  };
}

// ---------------------------------------------------------------- costs

function bucketRow(name: string, bucket: SpendBucket): Json {
  return { name, knownUsd: bucket.knownUsd, unknown: bucket.unknown, estimatedUnknownUsd: bucket.estimatedUnknownUsd ?? 0, spendUsd: round(bucket.knownUsd + (bucket.estimatedUnknownUsd ?? 0)) };
}

function breakdown(records: CostRecord[], config: WorkflowConfig): { byModel: Json[]; byPhase: Json[] } {
  const options = { pricing: config.pricing, unknownCallUsd: config.budgets.unknownCallUsd };
  const groups = new Map<string, CostRecord[]>();
  for (const record of records) {
    const key = `${record.provider}/${record.model}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const byModel = [...groups].map(([name, rows]) => {
    const total = summarize(rows, options);
    return bucketRow(name, { knownUsd: total.knownUsd, unknown: total.unknownRecords, estimatedUnknownUsd: total.estimatedUnknownUsd });
  });
  const phases: Record<string, SpendBucket> = {};
  for (const [phase, bucket] of Object.entries(summarize(records, options).byPhase)) {
    const label = PHASE_LABELS[phase] ?? "other";
    const into = phases[label] ?? { knownUsd: 0, unknown: 0, estimatedUnknownUsd: 0 };
    phases[label] = { knownUsd: round(into.knownUsd + bucket.knownUsd), unknown: into.unknown + bucket.unknown, estimatedUnknownUsd: round((into.estimatedUnknownUsd ?? 0) + (bucket.estimatedUnknownUsd ?? 0)) };
  }
  const byPhase = ["plan", "build", "review", "other"].filter((label) => label in phases).map((label) => bucketRow(label, phases[label]!));
  return { byModel: byModel.sort((a, b) => (b.spendUsd as number) - (a.spendUsd as number)), byPhase };
}

function scopeView(records: CostRecord[], limitUsd: number, config: WorkflowConfig): Json {
  const summary = summarize(records, { pricing: config.pricing, unknownCallUsd: config.budgets.unknownCallUsd });
  return {
    knownUsd: summary.knownUsd,
    estimatedUnknownUsd: summary.estimatedUnknownUsd,
    spendUsd: round(summary.knownUsd + summary.estimatedUnknownUsd),
    // Calls whose cost is unknown: a model with no pricing row, or an agent that is not metered.
    unknown: summary.unknownRecords,
    limitUsd,
    status: budgetStatusFor(summary, limitUsd, config.budgets.softWarningRatio),
    ...breakdown(records, config),
  };
}

// ---------------------------------------------------------------- show

/** Everything the panel draws. */
export function show(cwd: string): Json {
  const eff = effective(cwd);
  const { config } = eff;
  const paths = configPaths(cwd);
  const ctx = contextFor(cwd, config);
  // The stored pointer, not `activeTask`: that one reads git and may write the pointer, and a read must not.
  const stored = ctx.store.readActive();
  const tasks = listTasks(ctx);
  const records = ctx.store.readLedger();
  const spendByTask = summarize(records, { pricing: config.pricing, unknownCallUsd: config.budgets.unknownCallUsd }).byTask;
  const plans = [...tasks.filter((task) => !isClosed(task)), ...tasks.filter(isClosed).slice(0, RECENT_CLOSED)].map((task) => planView(task, stored, spendByTask[task.taskId]));
  const active = plans.find((plan) => plan.active && !plan.closed);
  const agents = agentTable(config);

  return {
    ok: true,
    cwd,
    models: Object.fromEntries(MODEL_KEYS.map((key) => [key, modelRow(key, eff)])),
    modelsShadowedByProject: isRecord(eff.project?.models),
    local: {
      configured: !!config.local,
      baseUrl: config.local?.baseUrl ?? "",
      ...(config.local?.apiKeyEnv ? { apiKeyEnv: config.local.apiKeyEnv } : {}),
      models: config.local?.models ?? [],
      presets: LOCAL_PRESETS,
    },
    agents: Object.keys(agents),
    agentsWithModelFlag: Object.entries(agents).filter(([, def]) => !!def.modelFlag).map(([name]) => name),
    budgets: { taskUsd: config.budgets.taskUsd, dailyUsd: config.budgets.dailyUsd, shadowedByProject: isRecord(eff.project?.budgets) },
    plans,
    costs: {
      today: scopeView(recordsForDay(records, new Date(), makeDayKey()), config.budgets.dailyUsd, config),
      plan: active ? { id: active.id, name: active.name, ...scopeView(records.filter((record) => record.taskId === active.id), config.budgets.taskUsd, config) } : null,
      // provider/model pairs in the ledger with no pricing row (a local model is a known $0).
      unpriced: unpricedModels(records, config.pricing).filter((name) => !name.startsWith("local/")),
    },
    warnings: (config.warnings ?? []).map(redact),
    errors: eff.errors,
    files: {
      user: fileView(paths.userPath),
      project: { path: paths.projectPath, display: displayPath(paths.projectPath), exists: existsSync(paths.projectPath) },
      workspace: path.join(cwd, config.workspaceDir),
    },
  };
}

// ---------------------------------------------------------------- editing the user file

/** The file's indentation step (its smallest indent on a live line), 2 for a flat file. */
function indentOf(text: string): number {
  let min: number | undefined;
  for (const line of text.split("\n")) {
    const m = /^( +)[^\s#]/.exec(line);
    if (m && (min === undefined || m[1]!.length < min)) min = m[1]!.length;
  }
  return min ?? 2;
}

/** A section written as a bare `key:` is a null scalar; setIn would throw below it. Make it a mapping. */
function ensureMap(doc: Document, key: string): void {
  const node = doc.get(key, true);
  if (isScalar(node) && (node.value === null || node.value === undefined)) doc.set(key, doc.createNode({}));
}

/** Removes a key, and the section holding it when that leaves it empty. The comment above a removed section moves to the next key. */
function unsetKey(doc: Document, parts: string[]): void {
  doc.deleteIn(parts);
  const parent = doc.getIn(parts.slice(0, -1), true);
  if (parts.length === 1 || !isMap(parent) || parent.items.length > 0 || !isMap(doc.contents)) return;
  const items = doc.contents.items;
  const at = items.findIndex((pair) => isScalar(pair.key) && pair.key.value === parts[0]);
  const above = (items[at]?.key as { commentBefore?: string } | undefined)?.commentBefore;
  doc.deleteIn(parts.slice(0, -1));
  if (!above) return;
  const next = items[at]?.key as { commentBefore?: string } | undefined;
  if (next && typeof next === "object") next.commentBefore = next.commentBefore ? `${above}\n${next.commentBefore}` : above;
  else doc.commentBefore = doc.commentBefore ? `${doc.commentBefore}\n${above}` : above;
}

/** `[ a ]` and `{ a }` (padded) or `[a]` and `{a}`: whichever the file already uses most, so untouched lines keep their look. */
function paddedFlow(text: string): boolean {
  return (text.match(/[[{] \S/g) ?? []).length >= (text.match(/[[{][^\s\]}]/g) ?? []).length;
}

type Apply = (doc: Document) => string | undefined;

/**
 * Applies one change to the user file. Refuses (and writes nothing) when the file changed since `expect`, when it is
 * not a YAML mapping, or when the loader would reject the result; that includes any secret.
 */
function editUserFile(cwd: string, expect: string | undefined, apply: Apply): Json {
  const file = configPaths(cwd).userPath;
  const display = displayPath(file);
  try {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (expect !== undefined && expect !== sha256(before)) return refuse(`${display} changed since it was read; refresh and try again`);
    const crlf = before.includes("\r\n");
    const work = crlf ? before.replace(/\r\n/g, "\n") : before;
    const doc = parseDocument(work);
    if (doc.errors.length > 0) return refuse(`${display} cannot be edited: ${doc.errors[0]!.message.split("\n")[0]}`);
    if (doc.contents !== null && !isMap(doc.contents)) return refuse(`${display} is not a YAML mapping`);
    let note: string | undefined;
    try {
      note = apply(doc);
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
    const text = doc.toString({ lineWidth: 0, indent: indentOf(work), flowCollectionPadding: paddedFlow(work) });
    if (containsSecret(text)) return refuse("That would put a secret in the config file; pi-chef config never holds secrets. Nothing was written.");
    try {
      parseConfig(text, display);
    } catch (error) {
      return refuse(`${display} would be rejected: ${messageOf(error)}`);
    }
    const after = crlf ? text.replace(/\n/g, "\r\n") : text;
    const changed = after !== before;
    if (changed) atomicWrite(file, after);
    return { ok: true, changed, ...(note ? { note } : {}) };
  } catch (error) {
    return refuse(messageOf(error));
  }
}

/** A successful edit answers with the fresh `show`, so the panel redraws from one document. */
function withShow(cwd: string, result: Json): Json {
  return result.ok === true ? { ...show(cwd), ...result } : result;
}

/** `set`: one of the keys the panel edits. An empty value removes the key (the default applies again). */
export function setKey(cwd: string, key: string, value: string, expect?: string): Json {
  if (!(SET_KEYS as readonly string[]).includes(key)) return refuse(`${key} is not a setting this tool edits (${SET_KEYS.join(", ")})`);
  const parts = key.split(".");
  const text = value.trim();
  let parsed: string | number | undefined;
  if (key.startsWith("models.")) {
    if (text !== "") {
      const problem = ticketModelProblem(text, effective(cwd).config);
      if (problem) return refuse(`${key}: ${problem}`);
      parsed = text;
    }
  } else if (key.startsWith("budgets.")) {
    if (text !== "") {
      const n = Number(text);
      if (!Number.isFinite(n) || n <= 0) return refuse(`${key} must be a number greater than 0`);
      parsed = n;
    }
  } else {
    if (text === "") return refuse("local.baseUrl cannot be empty");
    parsed = text;
  }
  const result = editUserFile(cwd, expect, (doc) => {
    if (parsed === undefined) {
      unsetKey(doc, parts);
      return undefined;
    }
    if (key === "local.baseUrl" && !isMap(doc.get("local", true))) throw new Error("There is no local server config yet: use Detect, then Add a model, which creates it with this URL.");
    ensureMap(doc, parts[0]!);
    doc.setIn(parts, parsed);
    return undefined;
  });
  return withShow(cwd, result);
}

function localModelItems(doc: Document): unknown[] {
  const models = doc.getIn(["local", "models"], true) as { items?: unknown[] } | null;
  return Array.isArray(models?.items) ? models.items : [];
}

/** `local-add`: saves a served model into `local.models` (updating its contextWindow when the id is there). Creates `local` from `baseUrl` when the file has none. */
export function localAdd(cwd: string, id: string, contextWindow: number, expect?: string, baseUrl?: string): Json {
  if (id.trim() === "" || /\s/.test(id)) return refuse("The model id must be a non-empty string without spaces");
  if (!Number.isInteger(contextWindow) || contextWindow < 4096) return refuse("contextWindow must be a whole number of at least 4096 (what the server runs the model with)");
  const result = editUserFile(cwd, expect, (doc) => {
    if (!isMap(doc.get("local", true))) {
      if (!baseUrl) throw new Error("There is no local server config yet: enter the server URL first.");
      doc.set("local", doc.createNode({ baseUrl, models: [{ id, contextWindow }] }));
      return undefined;
    }
    const list = localModelItems(doc);
    const at = list.findIndex((item) => isMap(item) && item.get("id") === id);
    if (at >= 0) doc.setIn(["local", "models", at, "contextWindow"], contextWindow);
    else if (list.length > 0) doc.addIn(["local", "models"], doc.createNode({ id, contextWindow }));
    else doc.setIn(["local", "models"], doc.createNode([{ id, contextWindow }]));
    return undefined;
  });
  return withShow(cwd, result);
}

/** `local-remove`: drops an id from `local.models`. The last one stays: the loader needs a non-empty list. */
export function localRemove(cwd: string, id: string, expect?: string): Json {
  const result = editUserFile(cwd, expect, (doc) => {
    const list = localModelItems(doc);
    const at = list.findIndex((item) => isMap(item) && item.get("id") === id);
    if (at < 0) throw new Error(`${id} is not in local.models`);
    if (list.length === 1) throw new Error("local.models cannot be empty; edit the local section in the file to remove the server");
    doc.deleteIn(["local", "models", at]);
    const models = effective(cwd).config.models;
    const used = MODEL_KEYS.filter((key) => models[key] === `local/${id}`);
    return used.length > 0 ? `models.${used.join(", models.")} still names local/${id}` : undefined;
  });
  return withShow(cwd, result);
}

// ---------------------------------------------------------------- local server

export interface DetectedModel {
  id: string;
  contextWindow?: number;
  /** The contextWindow saved in local.models for this id, when it is there. */
  configured?: number;
  mismatch?: string;
}

async function getModels(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<string[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  try {
    const response = await fetchImpl(`${url}/models`, { signal: controller.signal });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return undefined;
    return body.data.map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : "")).filter(Boolean);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks a server what it serves: `GET <baseUrl>/models` (the OpenAI-compatible list; a URL with no `/v1` is retried
 * with it), then the context probe of each id (llama-server `/props`, Ollama `/api/ps`). An unreachable server is a
 * result (`reachable: false`), not an error.
 */
export async function localDetect(baseUrl: string, options: { fetchImpl?: typeof fetch; configured?: LocalModelConfig[]; timeoutMs?: number } = {}): Promise<Json> {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return refuse("That is not a URL (for example http://127.0.0.1:8080/v1)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return refuse("The URL must start with http:// or https://");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;
  const given = url.toString().replace(/\/+$/, "");
  const candidates = /\/v1$/.test(given) ? [given] : [given, `${given}/v1`];
  for (const candidate of candidates) {
    const ids = await getModels(fetchImpl, candidate, timeoutMs);
    if (!ids) continue;
    const configured = options.configured ?? [];
    const models: DetectedModel[] = await Promise.all(
      [...new Set(ids)].slice(0, 30).map(async (id) => {
        const contextWindow = await probeLocalContext(candidate, id, { fetchImpl, timeoutMs });
        const have = configured.find((m) => m.id === id);
        const mismatch = have ? contextMismatch(id, have.contextWindow, contextWindow) : undefined;
        return { id, ...(contextWindow ? { contextWindow } : {}), ...(have ? { configured: have.contextWindow } : {}), ...(mismatch ? { mismatch } : {}) };
      }),
    );
    return { ok: true, reachable: true, baseUrl: candidate, origin: serverOrigin(candidate), models };
  }
  return { ok: true, reachable: false, baseUrl: given, models: [], error: `No answer from ${candidates.map((c) => `${c}/models`).join(" or ")}` };
}

// ---------------------------------------------------------------- plans

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    return (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `/plans <name>` without the checkout: points `active-task.json` at the task and records the branch that is checked
 * out now, as `/plans` does last, so the task stays active until the branch changes. It never switches branches: a
 * click in a panel should not change the working tree. The result says so when the task's branch is not the one out.
 */
export async function planActivate(cwd: string, id: string): Promise<Json> {
  const ctx = contextFor(cwd, effective(cwd).config);
  const task = listTasks(ctx).find((item) => item.taskId === id);
  if (!task) return refuse(`No plan with id ${id}`);
  const name = displayName(task);
  if (isClosed(task)) return refuse(`${name} is closed. Its files stay on disk; /plan <request> starts a new one.`);
  const branch = await currentBranch(cwd);
  ctx.store.setActive(task.taskId, branch);
  const note = task.build?.branch && branch && task.build.branch !== branch ? `${name} is active. Its branch ${task.build.branch} is not checked out (you are on ${branch}); /plans ${name} in Pi switches to it.` : undefined;
  return { ...show(cwd), ok: true, ...(note ? { note } : {}) };
}

/** `/plans close <name>`. A plan with tickets not built, or a build that has not passed review, needs `force` (the prompt of /plans close). */
export async function planClose(cwd: string, id: string, force = false): Promise<Json> {
  const ctx = contextFor(cwd, effective(cwd).config);
  const task = listTasks(ctx).find((item) => item.taskId === id);
  if (!task) return refuse(`No plan with id ${id}`);
  const name = displayName(task);
  if (isClosed(task)) return { ...show(cwd), ok: true, note: `${name} is already closed.` };
  const unbuilt = (task.plan?.tickets ?? []).filter((ticket) => task.ticketRuns?.[ticket.id]?.status !== "done").length;
  const unreviewed = !!task.build && !task.review?.passed;
  if ((unbuilt > 0 || unreviewed) && !force) {
    const what = [...(unbuilt > 0 ? [`${unbuilt} ticket(s) not built`] : []), ...(unreviewed ? ["a build that has not passed review"] : [])].join(" and ");
    return refuse(`${name} has ${what}.`, { needsForce: true });
  }
  await closeTask(ctx, task.taskId, "closed by user");
  if (ctx.store.readActive() === task.taskId) {
    const next = unfinishedTasks(listTasks(ctx))[0];
    if (next) ctx.store.setActive(next.taskId);
    else ctx.store.clearActive();
  }
  return { ...show(cwd), ok: true };
}

// ---------------------------------------------------------------- command line

const USAGE = `Usage:
  chef-config show          --cwd <dir>
  chef-config set           --cwd <dir> --key <${SET_KEYS.join("|")}> --value <v> [--expect <sha256 of the user file>]
  chef-config local-add     --cwd <dir> --id <model id> --context-window <n> [--base-url <url>] [--expect <sha256>]
  chef-config local-remove  --cwd <dir> --id <model id> [--expect <sha256>]
  chef-config local-detect  --base-url <url> [--cwd <dir>]
  chef-config plan-activate --cwd <dir> --id <plan id>
  chef-config plan-close    --cwd <dir> --id <plan id> [--force]

Prints one JSON document on stdout: { "ok": true, ... } or { "ok": false, "error": "..." }.
A refused request is reported inside it (exit 0); the exit status is nonzero only for a usage error.`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function dirOf(cwd: string): string {
  return path.resolve(cwd.startsWith("~/") ? path.join(homedir(), cwd.slice(2)) : cwd);
}

/** The server key named by local.apiKeyEnv, but only for the configured server itself: never for a URL typed into the panel. */
function authFetch(cwd: string, baseUrl: string): typeof fetch | undefined {
  const local = effective(cwd).config.local;
  const key = local?.apiKeyEnv ? process.env[local.apiKeyEnv] : undefined;
  if (!local || !key) return undefined;
  try {
    if (new URL(local.baseUrl).origin !== new URL(baseUrl).origin) return undefined;
  } catch {
    return undefined;
  }
  return (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${key}` } });
}

const COMMANDS = ["show", "set", "local-add", "local-remove", "local-detect", "plan-activate", "plan-close"];

/** Runs the CLI. Returns the exit code; output goes through `out` / `err` so tests need no process. */
export async function main(argv: string[], out: (text: string) => void = (t) => process.stdout.write(t), err: (text: string) => void = (t) => process.stderr.write(t)): Promise<number> {
  const [command, ...rest] = argv;
  const usage = (message: string): number => {
    err(`chef-config: ${message}\n${USAGE}\n`);
    return 2;
  };
  const print = (result: Json): number => {
    out(`${JSON.stringify(result)}\n`);
    return 0;
  };
  if (!command || !COMMANDS.includes(command)) return usage(command ? `unknown command "${command}"` : "no command");
  const cwdArg = flag(rest, "--cwd");
  if (command !== "local-detect" && (!cwdArg || cwdArg.startsWith("--"))) return usage(`${command} needs --cwd <dir>`);
  const cwd = cwdArg && !cwdArg.startsWith("--") ? dirOf(cwdArg) : "";
  const expect = flag(rest, "--expect");
  if (rest.includes("--expect") && (expect === undefined || expect.startsWith("--"))) return usage("--expect needs a sha256");
  const id = flag(rest, "--id");
  try {
    switch (command) {
      case "show":
        return print(show(cwd));
      case "set": {
        const key = flag(rest, "--key");
        const value = flag(rest, "--value");
        if (!key) return usage("set needs --key");
        if (value === undefined) return usage("set needs --value");
        return print(setKey(cwd, key, value, expect));
      }
      case "local-add": {
        const window = flag(rest, "--context-window");
        if (!id) return usage("local-add needs --id");
        if (window === undefined) return usage("local-add needs --context-window");
        return print(localAdd(cwd, id, Number(window), expect, flag(rest, "--base-url")));
      }
      case "local-remove":
        if (!id) return usage("local-remove needs --id");
        return print(localRemove(cwd, id, expect));
      case "local-detect": {
        const baseUrl = flag(rest, "--base-url");
        if (!baseUrl) return usage("local-detect needs --base-url");
        const configured = cwd ? effective(cwd).config.local?.models : undefined;
        const fetchImpl = cwd ? authFetch(cwd, baseUrl) : undefined;
        return print(await localDetect(baseUrl, { ...(configured ? { configured } : {}), ...(fetchImpl ? { fetchImpl } : {}) }));
      }
      case "plan-activate":
      case "plan-close":
        if (!id) return usage(`${command} needs --id`);
        return print(command === "plan-activate" ? await planActivate(cwd, id) : await planClose(cwd, id, rest.includes("--force")));
    }
  } catch (error) {
    return print(refuse(messageOf(error)));
  }
  return 0;
}
