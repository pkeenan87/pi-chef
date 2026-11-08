import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FOUNDRY_AUDIENCE, DEFAULT_VERCEL_GATEWAY_URL, loadConfig } from "../src/config.js";
import { CONFIG_SCHEMA, schemaFor } from "../src/config-schema.js";

const root = path.resolve(__dirname, "..");
const DOC_KEYS = 101;
const TEMPLATE_KEYS = 73;
const keys = new Set(CONFIG_SCHEMA.map((k) => k.key));

/** Maps a key as the docs write it to the schema's spelling. */
function docKey(section: string, label: string, cell: string): string[] {
  const cells = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/<provider>/g, "*"));
  if (section === "Top level") {
    if (label === "entry") return cells.flatMap((c) => [`checks[].${c}`, `setup[].${c}`]);
    return cells;
  }
  if (section === "tiers") return cells.map((c) => (label === "tier" ? `tiers.${c}` : `tiers.*[].${c}`));
  if (section === "providers") {
    if (label === "every") return cells.map((c) => `providers.*.${c}`);
    return cells.flatMap((c) => label.split(",").map((p) => `providers.${p}.${c}`));
  }
  if (section === "pricing") return cells.map((c) => `pricing[].${c}`);
  return cells;
}

function docKeys(): string[] {
  const out: string[] = [];
  let section = "";
  let label = "";
  for (const line of readFileSync(path.join(root, "docs", "configuration.md"), "utf8").split("\n")) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      // The settings reference ends where the deprecated keys begin.
      if (heading[1] === "Deprecated and removed keys") break;
      section = heading[1]!;
      label = "";
      continue;
    }
    if (/^## /.test(line)) section = "";
    if (section === "" || section === "Deprecated and removed keys") continue;
    if (/^Each `checks` \/ `setup` entry/.test(line)) label = "entry";
    else if (/^Every provider:/.test(line)) label = "every";
    else if (/^Each candidate:/.test(line)) label = "candidate";
    else if (/^\*\*openai, anthropic, xai\*\*/.test(line)) label = "openai,anthropic,xai";
    else if (/^\*\*(foundry|vercel|local)\*\*/.test(line)) label = /^\*\*(\w+)\*\*/.exec(line)![1]!;
    const row = /^\| (`[^|]+`) \|/.exec(line);
    if (!row) continue;
    let eff = label;
    if (section === "tiers" && label === "") eff = "tier";
    if (section === "tiers" && label === "candidate") eff = "candidate";
    out.push(...docKey(section, eff, row[1]!));
  }
  return out;
}

/** The commented `#   key:` lines of the user template, as dotted paths (nested by indentation). */
function templateKeys(): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (const line of readFileSync(path.join(root, "templates", "chef.yaml"), "utf8").split("\n")) {
    const m = /^# ( *)([A-Za-z]\w*):/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 2;
    stack.length = depth;
    stack[depth] = m[2]!;
    out.push(stack.join("."));
  }
  return out;
}

describe("config schema", () => {
  it("has unique keys, each with a description", () => {
    expect(keys.size).toBe(CONFIG_SCHEMA.length);
    for (const k of CONFIG_SCHEMA) expect(k.description.length).toBeGreaterThan(0);
  });

  it("has an enum for every enum type and bounds only on numbers", () => {
    for (const k of CONFIG_SCHEMA) {
      if (k.type === "enum") expect(k.enum?.length, k.key).toBeGreaterThan(0);
      if (k.min !== undefined || k.max !== undefined) expect(["int", "number", "usd", "ms"], k.key).toContain(k.type);
    }
  });

  it("covers every key in the tables of docs/configuration.md", () => {
    const found = docKeys();
    expect(found.length).toBeGreaterThanOrEqual(DOC_KEYS - 3);
    const missing = found.filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it("has no key the docs tables do not describe", () => {
    const documented = new Set(docKeys());
    // Only the quota.models[] row fields have no docs row of their own (the docs describe them in the quota.models cell).
    const extra = CONFIG_SCHEMA.filter((k) => !documented.has(k.key) && !k.key.startsWith("quota.models[].") && !([...documented].some((d) => d.startsWith(`${k.key}[]`)))).map((k) => k.key);
    expect(extra).toEqual([]);
  });

  it("resolves concrete paths through the wildcards", () => {
    expect(schemaFor("tiers.ticketLow[].model")?.key).toBe("tiers.*[].model");
    expect(schemaFor("tiers.ticketLow")?.key).toBe("tiers.ticketLow");
    expect(schemaFor("quota.providers.anthropic.dailyTokens")?.key).toBe("quota.providers.*.dailyTokens");
    expect(schemaFor("providers.xai.apiKeyFallback")?.key).toBe("providers.xai.apiKeyFallback");
    expect(schemaFor("checks[].command")?.key).toBe("checks[].command");
    expect(schemaFor("tiers.ticketLow[].nope")).toBeUndefined();
    expect(schemaFor("providers.foundry.api")?.key).toBe("providers.foundry.api");
    expect(schemaFor("pricing[].billing")?.key).toBe("pricing[].billing");
    expect(schemaFor("nope")).toBeUndefined();
  });

  it("offers only values the loader accepts for routing.maxTier", () => {
    expect(schemaFor("routing.maxTier")?.enum).toEqual(["cheap", "standard", "premium", "ticketLow", "ticketMedium", "ticketHigh", "local"]);
  });

  it("pins the defaults the loaded config does not carry", () => {
    expect(schemaFor("providers.vercel.baseUrl")?.default).toBe(DEFAULT_VERCEL_GATEWAY_URL);
    expect(schemaFor("providers.foundry.audience")?.default).toBe(DEFAULT_FOUNDRY_AUDIENCE);
  });

  it("covers every commented key of templates/chef.yaml", () => {
    const found = templateKeys();
    expect(found.length).toBeGreaterThanOrEqual(TEMPLATE_KEYS - 3);
    // A section header (`budgets`, `providers.foundry`) is a container: it only needs a key under it.
    const missing = found.filter((k) => !schemaFor(k) && ![...keys].some((s) => s.startsWith(`${k}.`)));
    expect(missing).toEqual([]);
  });

  describe("defaults", () => {
    let priorHome: string | undefined;
    beforeEach(() => {
      priorHome = process.env.HOME;
      process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-schema-home-"));
    });
    afterEach(() => {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    });

    it("equal what loadConfig produces with no config files", () => {
      const config = loadConfig(mkdtempSync(path.join(tmpdir(), "pi-schema-proj-"))) as unknown as Record<string, unknown>;
      const get = (dotted: string): unknown => dotted.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], config);
      const checked = CONFIG_SCHEMA.filter((k) => k.inConfig !== false && k.default !== undefined);
      expect(checked.length).toBeGreaterThan(40);
      // Loader -> schema: every leaf of the default config is a schema key or a container of one.
      const leaves: string[] = [];
      const walk = (value: unknown, at: string): void => {
        if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
          for (const [k, v] of Object.entries(value)) walk(v, at ? `${at}.${k}` : k);
        } else leaves.push(at);
      };
      walk(config, "");
      expect(leaves.length).toBeGreaterThan(25);
      expect(leaves.filter((l) => !keys.has(l) && ![...keys].some((s) => s.startsWith(`${l}.`)))).toEqual([]);
      for (const k of checked) expect(get(k.key), k.key).toEqual(k.default);
      // A key with no default and in the loaded config must not appear there with a value.
      for (const k of CONFIG_SCHEMA.filter((k) => k.inConfig !== false && k.default === undefined)) expect(get(k.key), k.key).toBeUndefined();
    });
  });
});
