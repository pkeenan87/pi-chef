import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspect, main, type InspectResult } from "../src/cli/chef-config.js";
import { CONFIG_SCHEMA } from "../src/config-schema.js";

describe("chef-config inspect", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "chef-cli-home-"));
    project = mkdtempSync(path.join(tmpdir(), "chef-cli-proj-"));
    process.env.HOME = home;
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(path.join(project, ".pi-workflows"), { recursive: true });
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });
  const user = (name: string, yaml: string) => writeFileSync(path.join(home, ".pi", "agent", name), yaml);
  const proj = (name: string, yaml: string) => writeFileSync(path.join(project, ".pi-workflows", name), yaml);
  const key = (r: InspectResult, k: string) => r.keys.find((x) => x.key === k)!;

  it("with no files: defaults everywhere, both files missing", () => {
    const r = inspect(project);
    expect(r.user.exists).toBe(false);
    expect(r.project.exists).toBe(false);
    expect(r.user.text).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.effectiveFrom).toBe("loaded");
    expect(r.schema).toBe(CONFIG_SCHEMA);
    const b = key(r, "budgets.taskUsd");
    expect(b).toMatchObject({ default: 20, effective: 20, source: "default", rule: "lower-wins", schemaKey: "budgets.taskUsd" });
    expect(b.user).toBeUndefined();
    expect(b.project).toBeUndefined();
    expect(r.user.path).toBe(path.join(home, ".pi", "agent", "chef.yaml"));
    expect(r.project.path).toBe(path.join(project, ".pi-workflows", "config.yaml"));
  });

  it("with a user file only: shows its text, parsed values and source user", () => {
    user("chef.yaml", "# mine\nbudgets:\n  taskUsd: 7\nbranchPrefix: me\n");
    const r = inspect(project);
    expect(r.user.exists).toBe(true);
    expect(r.user.text).toContain("# mine");
    expect(r.user.parsed).toEqual({ budgets: { taskUsd: 7 }, branchPrefix: "me" });
    expect(key(r, "budgets.taskUsd")).toMatchObject({ user: 7, effective: 7, default: 20, source: "user" });
    expect(key(r, "branchPrefix")).toMatchObject({ effective: "me", source: "user" });
    expect(key(r, "budgets.dailyUsd").source).toBe("default");
  });

  it("with both files: lower budget wins, project wins branchPrefix", () => {
    user("chef.yaml", "budgets:\n  taskUsd: 7\n  dailyUsd: 50\nbranchPrefix: me\n");
    proj("config.yaml", "budgets:\n  taskUsd: 5\n  dailyUsd: 90\nbranchPrefix: team\n");
    const r = inspect(project);
    expect(key(r, "budgets.taskUsd")).toMatchObject({ user: 7, project: 5, effective: 5, source: "project" });
    expect(key(r, "budgets.dailyUsd")).toMatchObject({ user: 50, project: 90, effective: 50, source: "user" });
    expect(key(r, "branchPrefix")).toMatchObject({ user: "me", project: "team", effective: "team", source: "project" });
  });

  it("a rejected project file is an error, with the user file's values still shown", () => {
    user("chef.yaml", "budgets:\n  taskUsd: 7\n");
    proj("config.yaml", "approvals:\n  merge: auto\n");
    const r = inspect(project);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.file).toBe(path.join(project, ".pi-workflows", "config.yaml"));
    expect(r.errors[0]!.display).toBe(r.project.display);
    expect(r.errors[0]!.message).toMatch(/merge/);
    expect(r.effectiveFrom).toBe("user");
    expect(key(r, "budgets.taskUsd")).toMatchObject({ effective: 7, source: "user" });
    expect(r.project.text).toContain("merge: auto");
  });

  it("an error names its file by absolute path and by display path, also under HOME", () => {
    const inHome = mkdtempSync(path.join(home, "proj-"));
    mkdirSync(path.join(inHome, ".pi-workflows"));
    writeFileSync(path.join(inHome, ".pi-workflows", "config.yaml"), "approvals:\n  merge: auto\n");
    const e = inspect(inHome).errors[0]!;
    expect(e.file).toBe(path.join(inHome, ".pi-workflows", "config.yaml"));
    expect(e.display).toBe(`~/${path.relative(home, e.file!)}`);
    expect(e.display).not.toBe(e.file);
  });

  it("does not credit the project for user-only and fixed keys it sets to their default", () => {
    proj("config.yaml", "routing:\n  reviewTier: premium\nsession:\n  model: anthropic/claude-opus-5-5\napprovals:\n  plan: required\n  merge: manual\n");
    const r = inspect(project);
    for (const k of ["routing.reviewTier", "session.model", "approvals.plan", "approvals.merge"]) {
      expect(key(r, k), k).toMatchObject({ source: "default" });
      expect(key(r, k).project, k).toBeDefined();
    }
  });

  it("still credits the project for a provider location field when the user has no block", () => {
    proj("config.yaml", "providers:\n  vercel:\n    envFile: .env.local\n");
    expect(key(inspect(project), "providers.vercel.envFile")).toMatchObject({ project: ".env.local", source: "project" });
    user("chef.yaml", "providers:\n  vercel:\n    projectDir: .\n");
    expect(key(inspect(project), "providers.vercel.envFile").source).toBe("default");
  });

  it("a rejected user file falls back to the defaults", () => {
    user("chef.yaml", "approvals:\n  merge: auto\n");
    const r = inspect(project);
    expect(r.effectiveFrom).toBe("defaults");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(key(r, "budgets.taskUsd")).toMatchObject({ effective: 20, source: "default" });
  });

  it("unreadable YAML is reported, not thrown", () => {
    proj("config.yaml", "budgets: [unclosed\n");
    const r = inspect(project);
    expect(r.project.readError).toBeTruthy();
    expect(r.project.parsed).toBeUndefined();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("reads .yml names", () => {
    user("chef.yml", "branchPrefix: fromyml\n");
    proj("config.yml", "advisors:\n  plan: false\n");
    const r = inspect(project);
    expect(r.user.path.endsWith("chef.yml")).toBe(true);
    expect(r.project.path.endsWith("config.yml")).toBe(true);
    expect(key(r, "branchPrefix")).toMatchObject({ effective: "fromyml", source: "user" });
    expect(key(r, "advisors.plan")).toMatchObject({ project: false, effective: false, source: "project" });
  });

  it("reads the legacy cost-workflow.yaml when chef.yaml is missing, and warns", () => {
    user("cost-workflow.yaml", "branchPrefix: legacy\n");
    const r = inspect(project);
    expect(r.user.path.endsWith("cost-workflow.yaml")).toBe(true);
    expect(r.legacy.exists).toBe(true);
    expect(key(r, "branchPrefix")).toMatchObject({ effective: "legacy", source: "user" });
    expect(r.warnings.join("\n")).toMatch(/Rename .*cost-workflow\.yaml to chef\.yaml/);
  });

  it("a user-only key set in the project: warning, effective stays the user's", () => {
    user("chef.yaml", "workspaceDir: .mine\n");
    proj("config.yaml", "workspaceDir: .theirs\n");
    const r = inspect(project);
    expect(key(r, "workspaceDir")).toMatchObject({ user: ".mine", project: ".theirs", effective: ".mine", source: "user", rule: "user-only" });
    expect(r.warnings.join("\n")).toMatch(/workspaceDir/);
    expect(r.errors).toEqual([]);
  });

  it("a user-only key set only in the project is ignored: effective stays the default", () => {
    proj("config.yaml", "isolation:\n  worktree: false\n");
    const r = inspect(project);
    expect(key(r, "isolation.worktree")).toMatchObject({ project: false, effective: true, source: "default" });
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("expands provider names found in a file", () => {
    user("chef.yaml", "providers:\n  local:\n    baseUrl: http://127.0.0.1:11434/v1\n");
    const r = inspect(project);
    expect(key(r, "providers.local.baseUrl")).toMatchObject({ user: "http://127.0.0.1:11434/v1", source: "user" });
    expect(key(r, "providers.local.type").schemaKey).toBe("providers.*.type");
    expect(r.keys.some((k) => k.key.includes("*") || k.key.includes("[]"))).toBe(false);
  });

  it("never prints a secret", () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    proj("config.yaml", `branchPrefix: ${secret}\n`);
    const text = JSON.stringify(inspect(project));
    expect(text).not.toContain(secret);
    expect(inspect(project).errors.length).toBeGreaterThan(0);
  });

  describe("main", () => {
    const run = (argv: string[]) => {
      let out = "";
      let err = "";
      const code = main(argv, (t) => (out += t), (t) => (err += t));
      return { code, out, err };
    };

    it("prints one JSON document and exits 0", () => {
      const { code, out } = run(["inspect", "--cwd", project]);
      expect(code).toBe(0);
      const doc = JSON.parse(out) as InspectResult;
      expect(doc.ok).toBe(true);
      expect(doc.cwd).toBe(project);
      expect(doc.schema.length).toBe(CONFIG_SCHEMA.length);
    });

    it("exits 2 on a usage error", () => {
      expect(run([]).code).toBe(2);
      expect(run(["nope"]).code).toBe(2);
      const noCwd = run(["inspect"]);
      expect(noCwd.code).toBe(2);
      expect(noCwd.out).toBe("");
      expect(noCwd.err).toMatch(/--cwd/);
    });
  });

  it("the bin shim says to build when dist is missing", () => {
    const fake = mkdtempSync(path.join(tmpdir(), "chef-cli-shim-"));
    mkdirSync(path.join(fake, "bin"));
    copyFileSync(path.resolve(__dirname, "..", "bin", "chef-config.mjs"), path.join(fake, "bin", "chef-config.mjs"));
    const run = spawnSync(process.execPath, [path.join(fake, "bin", "chef-config.mjs"), "inspect", "--cwd", project], { encoding: "utf8" });
    expect(JSON.parse(run.stdout)).toEqual({ ok: false, error: `run npm run build in ${fake}` });
  });
});
