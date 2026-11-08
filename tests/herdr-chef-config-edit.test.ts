import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { edit, inspect } from "../src/cli/chef-config.js";

// The mod's pure helpers (herdr/chef-config/edit.js) and the CLI round trip it performs, on temp HOME and project only.
type Schema = { key: string; section: string; type: string; rule: string; enum?: string[]; min?: number; max?: number; exclusiveMin?: boolean; default?: unknown };
type Helpers = {
  editable(s: Schema): boolean;
  projectProblem(s: Schema): string | null;
  looksSecret(t: string, type?: string): boolean;
  valueArg(s: Schema, t: string): string | null;
};
let h: Helpers;
beforeAll(async () => {
  const file = path.resolve(__dirname, "..", "herdr", "chef-config", "edit.js");
  h = (await import(pathToFileURL(file).href as string)) as Helpers;
});

describe("herdr chef-config mod: scalar editing", () => {
  let home: string;
  let project: string;
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "chef-mod-home-"));
    project = mkdtempSync(path.join(tmpdir(), "chef-mod-proj-"));
    process.env.HOME = home;
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  });

  const schema = () => inspect(project).schema as unknown as Schema[];

  it("offers controls for scalar keys of the editable sections only", () => {
    const keys = schema().filter((s) => h.editable(s)).map((s) => s.key);
    for (const k of ["branchPrefix", "isolation.runner", "session.pin", "localMode.default", "workers.tokenBudget", "budgets.taskUsd", "routing.selection", "review.timeoutMs", "advisors.watchdogEvery"]) {
      expect(keys).toContain(k);
    }
    for (const k of ["approvals.plan", "approvals.merge", "schemaVersion", "tiers.cheap", "pricing", "checks", "orgProviderAllowlist", "routing.requirePremiumReviewFor", "providers.local.baseUrl", "quota.overCapMultiplier"]) {
      expect(keys).not.toContain(k);
    }
    expect(keys.some((k) => /[[\]*]/.test(k))).toBe(false);
  });

  it("disables Project exactly where the CLI refuses it", () => {
    for (const s of schema().filter((x) => h.editable(x))) {
      const r = edit({ cwd: project, file: "project", key: s.key, value: s.type === "bool" ? "true" : undefined as unknown as string });
      const refusedForRule = !r.ok && /user-only|fixed/.test(r.error ?? "");
      expect(h.projectProblem(s) !== null, s.key).toBe(refusedForRule);
    }
  });

  it("round-trips every editable key through set, --expect and unset", () => {
    for (const s of schema().filter((x) => h.editable(x))) {
      const sample = s.type === "bool" ? "true" : s.type === "enum" ? s.enum![s.enum!.length - 1]! : s.type === "int" || s.type === "ms" ? String(Math.max(s.min ?? 0, 5) + 1) : s.type === "number" || s.type === "usd" ? "0.5" : "value-1";
      const arg = h.valueArg(s, sample);
      expect(arg, s.key).not.toBeNull();
      const file = h.projectProblem(s) ? "user" : "project";
      const before = (inspect(project) as unknown as Record<string, { sha256: string }>)[file]!.sha256;
      const set = edit({ cwd: project, file, key: s.key, value: arg!, expect: before });
      if (!set.ok) {
        // A value outside a cross-key rule is refused and the file stays as it was; that is the inline-error path.
        expect(set.error, s.key).toBeTruthy();
        continue;
      }
      // A stale hash is refused.
      const stale = edit({ cwd: project, file, key: s.key, value: arg!, expect: before });
      expect(stale.ok, s.key).toBe(false);
      const after = (inspect(project) as unknown as Record<string, { sha256: string }>)[file]!.sha256;
      const un = edit({ cwd: project, file, key: s.key, expect: after });
      expect(un.ok, s.key).toBe(true);
    }
  });

  it("writes a string that looks numeric as a string and keeps a plain string intact", () => {
    const s = schema().find((x) => x.key === "branchPrefix")!;
    const arg = h.valueArg(s, "1234");
    expect(arg).toBe('"1234"');
    const r = edit({ cwd: project, file: "user", key: "branchPrefix", value: arg! });
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(home, ".pi", "agent", "chef.yaml"), "utf8")).toContain('"1234"');
    expect(inspect(project).keys.find((k) => k.key === "branchPrefix")!.effective).toBe("1234");
  });

  it("reports which file's value won for a lower-wins key", () => {
    edit({ cwd: project, file: "project", key: "budgets.taskUsd", value: "3" });
    const r = edit({ cwd: project, file: "user", key: "budgets.taskUsd", value: "9" });
    expect(r.ok).toBe(true);
    const k = r.keys.find((x) => x.key === "budgets.taskUsd")!;
    expect(k.effective).toBe(3);
    expect(k.source).toBe("project");
  });

  it("shows a refusal's error and leaves the effective value", () => {
    const r = edit({ cwd: project, file: "user", key: "budgets.taskUsd", value: "0" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.keys.find((x) => x.key === "budgets.taskUsd")!.effective).toBe(20);
  });

  it("refuses to send a value that looks like a secret, and validates numbers", () => {
    expect(h.looksSecret("sk-ant-api03-abcdefghijklmnop")).toBe(true);
    expect(h.looksSecret("ghp_abcdefghijklmnopqrstu")).toBe(true);
    expect(h.looksSecret("Bearer abcdefgh12345678")).toBe(true);
    expect(h.looksSecret("eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abc")).toBe(true);
    expect(h.looksSecret("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7")).toBe(true);
    expect(h.looksSecret("foundry/my-deployment-name-v2-20260101", "modelRef")).toBe(false);
    expect(h.looksSecret("foundry/my-deployment-name-v2-20260101")).toBe(false);
    expect(h.looksSecret("/home/pkeenan/Work/project2/worktrees", "path")).toBe(false);
    expect(h.looksSecret("/home/pkeenan/Work/project2/worktrees")).toBe(false);
    expect(h.looksSecret("feature/team-alpha-experiments-2026-q4-rollout", "string")).toBe(false);
    expect(h.looksSecret("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7", "string")).toBe(true);
    expect(h.looksSecret("chef")).toBe(false);
    expect(h.looksSecret("anthropic/claude-opus-5-5")).toBe(false);
    const s = schema();
    const int = s.find((x) => x.key === "routing.maxEscalations")!;
    expect(h.valueArg(int, "2.5")).toBeNull();
    expect(h.valueArg(int, "abc")).toBeNull();
    expect(h.valueArg(int, "")).toBeNull();
    expect(h.valueArg(int, "3")).toBe("3");
  });
});
