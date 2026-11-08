/**
 * chef-config: the bridge between pi-chef's config files and a UI that shows or edits them (the herdr panel).
 * Every command prints one JSON document on stdout. Config problems are data (`errors`), not exit codes:
 * the exit status is nonzero only for a usage error. Nothing here spawns a process or prints a secret.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ConfigFileError, checkConfigText, configPaths, displayPath, loadConfig, parseModelRef, type WorkflowConfig } from "../config.js";
import { CONFIG_SCHEMA, schemaFor, type SchemaKey, type SchemaRule } from "../config-schema.js";
import { redact, redactUnknown } from "../redact.js";
import { atomicWrite } from "../storage/store.js";
import { docDelete, docSet, hasLive, inTemplate, insertKey, recomment, removeKey, replaceLive, uncommentSet } from "./config-edit.js";

export interface ConfigFileView {
  path: string;
  /** `~/…` form, for display. */
  display: string;
  exists: boolean;
  /** SHA-256 of the file's text (of the empty text when the file is missing): pass it to `set --expect`. */
  sha256: string;
  /** The file's text, redacted. Absent when the file does not exist or cannot be read. */
  text?: string;
  /** The parsed YAML (redacted); absent when the file is missing or its YAML cannot be read. */
  parsed?: Record<string, unknown>;
  /** Why the file could not be read or parsed. */
  readError?: string;
}

export type KeySource = "default" | "user" | "project" | "merged";

export interface KeyView {
  /** The concrete dotted path (`providers.foundry.api`). */
  key: string;
  /** The schema entry it comes from (`providers.*.type` for `providers.foundry.type`). */
  schemaKey: string;
  section: string;
  rule: SchemaRule;
  user?: unknown;
  project?: unknown;
  default?: unknown;
  effective?: unknown;
  source: KeySource;
}

export interface ConfigProblem {
  /** The rejected file (absolute path), when the problem names one. */
  file?: string;
  /** `~/…` form of `file`, for display. */
  display?: string;
  message: string;
}

export interface InspectResult {
  /** False only for a refused `set` or `unset`, with `error` saying why; nothing was written then. */
  ok: boolean;
  error?: string;
  /** What a successful `set` or `unset` did. */
  edit?: { file: "user" | "project"; path: string; key: string; action: "set" | "unset"; changed: boolean; reflowed?: true };
  cwd: string;
  user: ConfigFileView;
  project: ConfigFileView;
  /** The legacy `cost-workflow.yaml`; `user` is this file when it is the only user config. */
  legacy: ConfigFileView;
  /**
   * Where `effective` came from: `loaded` (both files applied), `user` (the project file was rejected, so only the
   * user file is shown), or `defaults` (the user file was rejected as well).
   */
  effectiveFrom: "loaded" | "user" | "defaults";
  keys: KeyView[];
  warnings: string[];
  errors: ConfigProblem[];
  schema: readonly SchemaKey[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getPath(root: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((o, p) => (isRecord(o) ? o[p] : undefined), root);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function viewOf(file: string): ConfigFileView {
  const view: ConfigFileView = { path: file, display: displayPath(file), exists: existsSync(file), sha256: sha256("") };
  if (!view.exists) return view;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    view.readError = redact(error instanceof Error ? error.message : String(error));
    return view;
  }
  view.sha256 = sha256(text);
  view.text = redact(text);
  try {
    const parsed = parse(text);
    if (parsed === null || parsed === undefined) view.parsed = {};
    else if (isRecord(parsed)) view.parsed = redactUnknown(parsed) as Record<string, unknown>;
    else view.readError = "the file is not a YAML mapping";
  } catch (error) {
    view.readError = redact((error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unreadable");
  }
  return view;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Provider credential and location fields: a project may set them when the user defines no block for the provider. */
const PROVIDER_LOCATION_FIELDS = new Set(["baseUrl", "endpoint", "endpointEnv", "apiKeyEnv", "audience", "projectDir", "envFile", "resourceGroup"]);

function projectMaySet(key: string, rule: SchemaRule, userRoot: unknown): boolean {
  if (rule !== "user-only" && rule !== "fixed") return true;
  // The loader's exception: with no user block for that provider, the project's built-in default value is accepted.
  const m = /^providers\.([^.]+)\.([^.]+)$/.exec(key);
  return !!m && PROVIDER_LOCATION_FIELDS.has(m[2]!) && getPath(userRoot, `providers.${m[1]}`) === undefined;
}

function sourceOf(user: unknown, project: unknown, effective: unknown, dflt: unknown, projectCounts: boolean): KeySource {
  if (!projectCounts) {
    if (user !== undefined && same(user, effective)) return "user";
    return "default";
  }
  if (project !== undefined && same(project, effective) && !same(project, user)) return "project";
  if (user !== undefined && same(user, effective)) return "user";
  if (project !== undefined && same(project, effective)) return "project";
  if (user !== undefined || project !== undefined) return same(effective, dflt) ? "default" : "merged";
  return "default";
}

/** The concrete keys a schema entry stands for. `*` expands to the names present in a file or the loaded config. */
function expand(entry: SchemaKey, roots: unknown[]): string[] {
  if (entry.key.includes("[]")) return [];
  const star = entry.key.indexOf("*");
  if (star < 0) return [entry.key];
  const parent = entry.key.slice(0, star).replace(/\.$/, "");
  const names = new Set<string>();
  for (const root of roots) {
    const at = parent === "" ? root : getPath(root, parent);
    if (isRecord(at)) for (const name of Object.keys(at)) names.add(name);
  }
  return [...names].map((name) => entry.key.replace("*", name));
}

function problemOf(error: unknown): ConfigProblem {
  const message = redact(error instanceof Error && error.message ? error.message : String(error));
  return error instanceof ConfigFileError ? { file: error.file, display: displayPath(error.file), message } : { message };
}

/** The user file the loader reads: chef.yaml, else the legacy cost-workflow.yaml when only that exists. */
function userFileView(paths: ReturnType<typeof configPaths>): ConfigFileView {
  const chef = viewOf(paths.userPath);
  const legacy = viewOf(paths.legacyUserPath);
  return !chef.exists && legacy.exists ? legacy : chef;
}

/** Everything a UI needs to show the two config files and the layering of every key. */
export function inspect(cwd: string): InspectResult {
  const paths = configPaths(cwd);
  const legacy = viewOf(paths.legacyUserPath);
  // loadConfig reads the legacy file only when chef.yaml does not exist.
  const user = userFileView(paths);
  const project = viewOf(paths.projectPath);

  const errors: ConfigProblem[] = [];
  let config: WorkflowConfig | undefined;
  let effectiveFrom: InspectResult["effectiveFrom"] = "loaded";
  let warnings: string[] = [];
  try {
    config = loadConfig(cwd);
    warnings = config.warnings ?? [];
  } catch (error) {
    errors.push(problemOf(error));
    // Show what the user file alone gives, then the defaults, so the panel still has values to display.
    // An empty directory of our own, so no planted .pi-workflows/config.yaml can be read.
    const nowhere = mkdtempSync(path.join(tmpdir(), "chef-config-"));
    try {
      config = loadConfig(nowhere);
      warnings = config.warnings ?? [];
      effectiveFrom = "user";
    } catch (second) {
      if (!errors.some((e) => e.message === problemOf(second).message)) errors.push(problemOf(second));
      config = undefined;
      effectiveFrom = "defaults";
    } finally {
      rmSync(nowhere, { recursive: true, force: true });
    }
  }
  const userRoot = user.parsed;
  const projectRoot = project.parsed;
  const keys: KeyView[] = [];
  for (const entry of CONFIG_SCHEMA) {
    for (const key of expand(entry, [userRoot, projectRoot, config])) {
      const u = getPath(userRoot, key);
      const p = getPath(projectRoot, key);
      const dflt = entry.default;
      const eff = (config ? getPath(config, key) : undefined) ?? dflt;
      const view: KeyView = { key, schemaKey: entry.key, section: entry.section, rule: entry.rule, source: sourceOf(u, p, eff, dflt, projectMaySet(key, entry.rule, userRoot)) };
      if (u !== undefined) view.user = u;
      if (p !== undefined) view.project = p;
      if (dflt !== undefined) view.default = dflt;
      if (eff !== undefined) view.effective = eff;
      keys.push(view);
    }
  }

  return {
    ok: true,
    cwd,
    user,
    project,
    legacy,
    effectiveFrom,
    keys,
    warnings: warnings.map((w) => redact(w)),
    errors,
    schema: CONFIG_SCHEMA,
  };
}

function boundsProblem(entry: SchemaKey, n: number): string | undefined {
  if (entry.min !== undefined && (entry.exclusiveMin ? n <= entry.min : n < entry.min)) return `must be ${entry.exclusiveMin ? "greater than" : "at least"} ${entry.min}`;
  if (entry.max !== undefined && n > entry.max) return `must be at most ${entry.max}`;
  return undefined;
}

/** Why `value` does not fit the schema entry (type, enum, bounds), or undefined when it does. */
export function valueProblem(entry: SchemaKey, value: unknown): string | undefined {
  switch (entry.type) {
    case "bool":
      return typeof value === "boolean" ? undefined : "must be true or false";
    case "int":
    case "ms":
    case "number":
    case "usd": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if ((entry.type === "int" || entry.type === "ms") && !Number.isInteger(value)) return "must be a whole number";
      return boundsProblem(entry, value);
    }
    case "enum":
      return typeof value === "string" && (entry.enum ?? []).includes(value) ? undefined : `must be one of: ${(entry.enum ?? []).join(", ")}`;
    case "string":
    case "path":
      return typeof value === "string" && value !== "" ? undefined : "must be a non-empty string (quote it if it looks like a number or a boolean)";
    case "modelRef":
      return typeof value === "string" && parseModelRef(value) ? undefined : "must be provider/model";
    case "list": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return "must be a list of strings";
      const bad = entry.enum ? (value as string[]).filter((v) => !entry.enum!.includes(v)) : [];
      return bad.length > 0 ? `has values outside: ${entry.enum!.join(", ")}` : undefined;
    }
    default:
      return "is a structured setting; edit the file directly";
  }
}

/** The sample user config that ships beside this package, if it can be read. */
function sampleTemplate(): string | undefined {
  try {
    return readFileSync(fileURLToPath(new URL("../../templates/chef.yaml", import.meta.url)), "utf8");
  } catch {
    return undefined;
  }
}

/** What the file's parsed content must be after the edit: the value set at `parts`, or the key gone (and emptied parents). */
function expectedAfter(base: Record<string, unknown>, parts: string[], value: unknown): Record<string, unknown> {
  const root = structuredClone(base);
  if (value !== undefined) {
    let at: Record<string, unknown> = root;
    for (const part of parts.slice(0, -1)) {
      if (!isRecord(at[part])) at[part] = {};
      at = at[part] as Record<string, unknown>;
    }
    at[parts[parts.length - 1]!] = value;
    return root;
  }
  const chain: Record<string, unknown>[] = [root];
  for (const part of parts.slice(0, -1)) {
    const next = chain[chain.length - 1]![part];
    if (!isRecord(next)) return root;
    chain.push(next);
  }
  delete chain[chain.length - 1]![parts[parts.length - 1]!];
  for (let i = chain.length - 1; i >= 1; i--) if (Object.keys(chain[i]!).length === 0) delete chain[i - 1]![parts[i - 1]!];
  return root;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** True when the candidate text parses to exactly `expected` (so it changed that key and nothing else). */
function resolves(text: string, expected: Record<string, unknown>): boolean {
  try {
    return deepEqual(parse(text) ?? {}, expected);
  } catch {
    return false;
  }
}

/** The file's indentation step (its smallest indent on a live line), or undefined for a flat file. */
function indentOf(text: string): number | undefined {
  let min: number | undefined;
  for (const line of text.split("\n")) {
    const m = /^( +)[^\s#]/.exec(line);
    if (m && (min === undefined || m[1]!.length < min)) min = m[1]!.length;
  }
  return min;
}

export interface EditArgs {
  cwd: string;
  file: "user" | "project";
  key: string;
  /** The value as YAML text; absent for `unset`. */
  value?: string;
  /** SHA-256 of the file text the caller last saw. */
  expect?: string;
}

function refused(cwd: string, error: string): InspectResult {
  return { ...inspect(cwd), ok: false, error: redact(error) };
}

/** Sets (or, with no `value`, unsets) one key in the user or project file. Never throws; a refusal is `ok: false`. */
export function edit(args: EditArgs): InspectResult {
  const { cwd, file, key, value, expect } = args;
  const action = value === undefined ? "unset" : "set";
  try {
    const entry = schemaFor(key);
    if (!entry || entry.key.includes("[]")) return refused(cwd, `${key} is not a setting this tool can edit`);
    if (action === "set" && (entry.type === "object-list" || entry.type === "map")) return refused(cwd, `${key} is a structured setting; edit the file directly`);
    const paths = configPaths(cwd);
    const userView = userFileView(paths);
    if (file === "project" && !projectMaySet(key, entry.rule, userView.parsed)) {
      return refused(cwd, `${key} is ${entry.rule === "fixed" ? "fixed" : "user-only"}: set it in the user file, not the project file`);
    }
    const target = file === "user" ? userView.path : paths.projectPath;
    const existed = existsSync(target);
    const before = existed ? readFileSync(target, "utf8") : "";
    if (expect !== undefined && expect !== sha256(before)) return refused(cwd, `${displayPath(target)} changed since it was read; refresh and try again`);

    const parts = key.split(".");
    let parsedValue: unknown;
    if (action === "set") {
      try {
        parsedValue = parse(value!);
      } catch {
        return refused(cwd, `the value for ${key} is not valid YAML`);
      }
      if (parsedValue === null || parsedValue === undefined) return refused(cwd, `${key} needs a value; use unset to remove it`);
      const problem = valueProblem(entry, parsedValue);
      if (problem) return refused(cwd, `${key} ${problem}`);
    }

    // Work on LF text; the file's line endings are put back at the end.
    const crlf = before.includes("\r\n");
    const work = crlf ? before.replace(/\r\n/g, "\n") : before;
    let base: unknown;
    try {
      base = parse(work) ?? {};
    } catch (error) {
      return refused(cwd, `${displayPath(target)} cannot be edited: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    }
    if (!isRecord(base)) return refused(cwd, `${displayPath(target)} is not a YAML mapping`);
    const expected = expectedAfter(base, parts, action === "set" ? parsedValue : undefined);
    const unit = indentOf(work);

    // Line-level edits first (they keep every other byte). Each candidate is checked against what the edit must
    // produce; one that does not match (an odd layout) is passed over for the Document API, which may reflow.
    const candidates: { text: string | undefined; reflowed: boolean }[] = [];
    try {
      if (unit === undefined || unit === 2) {
        if (action === "set") {
          const text = hasLive(work, parts) ? replaceLive(work, parts, parsedValue) : (uncommentSet(work, parts, parsedValue) ?? insertKey(work, parts, parsedValue));
          candidates.push({ text, reflowed: false });
        } else {
          // Only the user file is the sample's; a project file never gets sample lines put back.
          const template = file === "user" ? sampleTemplate() : undefined;
          const text = (template !== undefined && inTemplate(template, parts) ? recomment(work, parts, template) : undefined) ?? removeKey(work, parts, template);
          candidates.push({ text, reflowed: false });
        }
      }
      candidates.push({ text: action === "set" ? docSet(work, parts, parsedValue, unit ?? 2) : docDelete(work, parts, unit ?? 2), reflowed: true });
    } catch (error) {
      return refused(cwd, `${displayPath(target)} cannot be edited: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    }
    let chosen: { text: string; reflowed: boolean } | undefined;
    for (const c of candidates) {
      if (c.text !== undefined && resolves(c.text, expected)) {
        chosen = { text: c.text, reflowed: c.reflowed };
        break;
      }
    }
    if (!chosen) return refused(cwd, `${displayPath(target)}: could not edit ${key} safely; edit the file directly`);
    // The Document API leaves a file alone when nothing changes.
    const after = crlf ? chosen.text.replace(/\n/g, "\r\n") : chosen.text;
    const changed = after !== before;
    if (changed) {
      try {
        // What loadConfig does with a file: only a problem that rejects the whole file refuses the edit.
        checkConfigText(chosen.text, displayPath(target));
      } catch (error) {
        return refused(cwd, `the file would be rejected: ${error instanceof ConfigFileError ? error.reason : error instanceof Error ? error.message : String(error)}`);
      }
      const prior = new Set(inspect(cwd).errors.map((e) => e.message));
      atomicWrite(target, after);
      // Rules that span both files (proprietaryCode needs orgProviderAllowlist) only show once loaded: undo a write that causes a new error.
      const fresh = inspect(cwd).errors.find((e) => !prior.has(e.message));
      if (fresh) {
        if (existsSync(target) && before === "" && !existed) rmSync(target, { force: true });
        else atomicWrite(target, before);
        return refused(cwd, `the config would be rejected: ${fresh.message} (the file was left as it was)`);
      }
    }
    const reflowed = changed && chosen.reflowed;
    return { ...inspect(cwd), edit: { file, path: target, key, action, changed, ...(reflowed ? { reflowed: true } : {}) } };
  } catch (error) {
    return refused(cwd, error instanceof Error && error.message ? error.message : String(error));
  }
}

const USAGE = `Usage:
  chef-config inspect --cwd <dir>
  chef-config set     --cwd <dir> --file user|project --key a.b.c --value <yaml> [--expect <sha256>]
  chef-config unset   --cwd <dir> --file user|project --key a.b.c [--expect <sha256>]

Prints one JSON document on stdout. Config problems and refused edits are reported inside it ("errors", "ok": false);
the exit status is nonzero only for a usage error.`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function dirOf(cwd: string): string {
  return path.resolve(cwd.startsWith("~/") ? path.join(homedir(), cwd.slice(2)) : cwd);
}

/** Runs the CLI. Returns the exit code; output goes through `out` / `err` so tests need no process. */
export function main(argv: string[], out: (text: string) => void = (t) => process.stdout.write(t), err: (text: string) => void = (t) => process.stderr.write(t)): number {
  const [command, ...rest] = argv;
  const cwd = flag(rest, "--cwd");
  if (command === "inspect" || command === "set" || command === "unset") {
    if (!cwd || cwd.startsWith("--")) {
      err(`chef-config: ${command} needs --cwd <dir>\n${USAGE}\n`);
      return 2;
    }
    if (command === "inspect") {
      out(`${JSON.stringify(inspect(dirOf(cwd)))}\n`);
      return 0;
    }
    const file = flag(rest, "--file");
    const key = flag(rest, "--key");
    const value = flag(rest, "--value");
    const expect = flag(rest, "--expect");
    if (file !== "user" && file !== "project") {
      err(`chef-config: ${command} needs --file user|project\n${USAGE}\n`);
      return 2;
    }
    if (!key || key.startsWith("--")) {
      err(`chef-config: ${command} needs --key <a.b.c>\n${USAGE}\n`);
      return 2;
    }
    if (command === "set" && value === undefined) {
      err(`chef-config: set needs --value <yaml>\n${USAGE}\n`);
      return 2;
    }
    if (command === "unset" && value !== undefined) {
      err(`chef-config: unset takes no --value\n${USAGE}\n`);
      return 2;
    }
    if (rest.includes("--expect") && (expect === undefined || expect.startsWith("--"))) {
      err(`chef-config: --expect needs a sha256\n${USAGE}\n`);
      return 2;
    }
    const result = edit({ cwd: dirOf(cwd), file, key, ...(command === "set" ? { value } : {}), ...(expect !== undefined ? { expect } : {}) });
    out(`${JSON.stringify(result)}\n`);
    return 0;
  }
  err(`chef-config: ${command ? `unknown command "${command}"` : "no command"}\n${USAGE}\n`);
  return 2;
}
