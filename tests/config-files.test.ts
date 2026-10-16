import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPaths, loadConfig } from "../src/config.js";

describe("config file names", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    project = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    process.env.HOME = home;
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(path.join(project, ".pi-workflows"), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });
  const user = (name: string, yaml: string) => writeFileSync(path.join(home, ".pi", "agent", name), yaml);
  const proj = (name: string, yaml: string) => writeFileSync(path.join(project, ".pi-workflows", name), yaml);

  it("picks up chef.yml", () => {
    user("chef.yml", "branchPrefix: fromyml\n");
    const config = loadConfig(project);
    expect(config.branchPrefix).toBe("fromyml");
    expect(configPaths(project).userPath).toBe(path.join(home, ".pi", "agent", "chef.yml"));
  });

  it("prefers chef.yaml over chef.yml and warns which file is ignored", () => {
    user("chef.yaml", "branchPrefix: fromyaml\n");
    user("chef.yml", "branchPrefix: fromyml\n");
    const config = loadConfig(project);
    expect(config.branchPrefix).toBe("fromyaml");
    expect(config.warnings?.join("\n")).toContain("~/.pi/agent/chef.yml is ignored because ~/.pi/agent/chef.yaml exists");
  });

  it("picks up the project config.yml, and prefers config.yaml with a warning", () => {
    proj("config.yml", "branchPrefix: projyml\n");
    expect(loadConfig(project).branchPrefix).toBe("projyml");
    proj("config.yaml", "branchPrefix: projyaml\n");
    const config = loadConfig(project);
    expect(config.branchPrefix).toBe("projyaml");
    expect(config.warnings?.join("\n")).toMatch(/config\.yml is ignored because .*config\.yaml exists/);
  });

  it("reads a legacy cost-workflow.yml and says to rename it", () => {
    user("cost-workflow.yml", "branchPrefix: legacyyml\n");
    const config = loadConfig(project);
    expect(config.branchPrefix).toBe("legacyyml");
    expect(config.warnings).toContain("Rename ~/.pi/agent/cost-workflow.yml to chef.yaml");
  });

  it("watches every candidate file so the cache follows whichever one is used", () => {
    const { watch } = configPaths(project);
    for (const name of ["chef.yaml", "chef.yml", "cost-workflow.yaml", "cost-workflow.yml", "config.yaml", "config.yml"]) {
      expect(watch.some((file) => path.basename(file) === name)).toBe(true);
    }
  });
});
