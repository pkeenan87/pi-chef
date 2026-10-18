import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const script = path.resolve("bin/init.mjs");
const GITIGNORE_COUNT = 7;

function project(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-chef-init-"));
}

// A stand-in `pi` that records its arguments and exits with the given code.
function fakePi(exitCode = 0): { bin: string; log: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-chef-fakepi-"));
  const log = path.join(dir, "calls.log");
  const bin = path.join(dir, "pi");
  writeFileSync(bin, `#!/bin/sh\necho "$PWD|$*" >> "${log}"\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return { bin: dir, log };
}

/** A throwaway HOME, so init never writes the real ~/.pi/agent/chef.yaml. */
const testHome = mkdtempSync(path.join(tmpdir(), "pi-chef-home-"));

async function init(args: string[], cwd: string, pathDir?: string, home = testHome) {
  const env = { ...process.env, HOME: home, PATH: pathDir ? `${pathDir}${path.delimiter}${process.env.PATH}` : "/nonexistent" };
  try {
    const { stdout } = await exec(process.execPath, [script, ...args], { cwd, env });
    return { code: 0, stdout };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout + failed.stderr };
  }
}

describe("pi-chef-init", () => {
  it("writes the commented user config once, and never overwrites one you have", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "pi-chef-home-"));
    const user = path.join(home, ".pi", "agent", "chef.yaml");
    const dry = await init(["--no-install", "--dry-run"], project(), undefined, home);
    expect(dry.stdout).toContain("create ~/.pi/agent/chef.yaml");
    expect(existsSync(user)).toBe(false);
    await init(["--no-install"], project(), undefined, home);
    expect(readFileSync(user, "utf8")).toBe(readFileSync("templates/chef.yaml", "utf8"));
    writeFileSync(user, "budgets: { taskUsd: 50 }\n");
    const again = await init(["--no-install", "--force"], project(), undefined, home);
    expect(again.stdout).toContain("kept it");
    expect(readFileSync(user, "utf8")).toBe("budgets: { taskUsd: 50 }\n");
  });

  it("installs locally from package.json's repository, writes config and .gitignore", async () => {
    const cwd = project();
    const pi = fakePi();
    const result = await init(["init"], cwd, pi.bin);

    expect(result.code).toBe(0);
    const [ranIn, args] = readFileSync(pi.log, "utf8").trim().split("|");
    expect(args).toBe("install -l git:github.com/pkeenan87/pi-chef");
    expect(path.basename(ranIn)).toBe(path.basename(cwd));
    expect(readFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), "utf8")).toBe(readFileSync(".pi-workflows/config.yaml", "utf8"));
    const ignore = readFileSync(path.join(cwd, ".gitignore"), "utf8");
    expect(ignore).toContain(".pi-workflows/reports/");
    expect(ignore).toContain(".pi-workflows/*.local.yaml");
  });

  it("pins a ref, honours --global, and passes --source through", async () => {
    const pi = fakePi();
    await init(["--ref", "v0.1.0", "--no-install"], project(), pi.bin);
    expect(existsSync(pi.log)).toBe(false);

    await init(["--ref", "v0.1.0"], project(), pi.bin);
    await init(["--global", "--source", "git:github.com/acme/pi-chef@v2"], project(), pi.bin);
    await init(["--source", "../pi-chef"], project(), pi.bin);
    const calls = readFileSync(pi.log, "utf8").trim().split("\n").map((line) => line.split("|")[1]);
    expect(calls).toEqual([
      "install -l git:github.com/pkeenan87/pi-chef@v0.1.0",
      "install git:github.com/acme/pi-chef@v2",
      "install -l ../pi-chef",
    ]);
  });

  it("keeps an existing config unless --force, and does not duplicate .gitignore lines", async () => {
    const cwd = project();
    mkdirSync(path.join(cwd, ".pi-workflows"));
    writeFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), "mine: true\n");
    writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n.pi-workflows/tasks/");

    await init(["--no-install"], cwd);
    await init(["--no-install"], cwd);
    expect(readFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), "utf8")).toBe("mine: true\n");
    const lines = readFileSync(path.join(cwd, ".gitignore"), "utf8").split("\n");
    expect(lines.filter((line) => line === ".pi-workflows/tasks/")).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith(".pi-workflows/"))).toHaveLength(GITIGNORE_COUNT);
    expect(lines[0]).toBe("node_modules/");

    await init(["--no-install", "--force"], cwd);
    expect(readFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), "utf8")).toContain("providers:");
  });

  it("changes nothing on --dry-run", async () => {
    const cwd = project();
    const pi = fakePi();
    const result = await init(["--dry-run", "--ref", "v1"], cwd, pi.bin);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pi install -l git:github.com/pkeenan87/pi-chef@v1");
    expect(existsSync(pi.log)).toBe(false);
    expect(existsSync(path.join(cwd, ".pi-workflows"))).toBe(false);
    expect(existsSync(path.join(cwd, ".gitignore"))).toBe(false);
  });

  it("still writes config when pi is missing or fails, and exits non-zero", async () => {
    const missing = project();
    const noPi = await init([], missing);
    expect(noPi.code).toBe(1);
    expect(noPi.stdout).toContain("pi is not on PATH");
    expect(existsSync(path.join(missing, ".pi-workflows", "config.yaml"))).toBe(true);

    const failing = project();
    const broken = await init([], failing, fakePi(3).bin);
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain("pi install exited with 3");
    expect(existsSync(path.join(failing, ".pi-workflows", "config.yaml"))).toBe(true);
  });

  it("rejects unknown flags and --ref on a non-git source", async () => {
    expect((await init(["--bogus"], project())).code).toBe(2);
    const bad = await init(["--source", "npm:x", "--ref", "v1"], project());
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("--ref only applies to a git: source");
  });
});
