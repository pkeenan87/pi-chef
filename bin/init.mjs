#!/usr/bin/env node
// Scaffold the chef workflow into a project: register the Pi
// package, copy the sample config, and gitignore runtime state.
// Plain JavaScript on purpose: npx runs this with no build step.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GITIGNORE_LINES = [
  ".pi-workflows/tasks/",
  ".pi-workflows/cost/",
  ".pi-workflows/metrics/",
  ".pi-workflows/reports/",
  ".pi-workflows/notifications.jsonl",
  ".pi-workflows/active-task.json",
  ".pi-workflows/*.local.yaml",
];

const USAGE = `Usage: pi-chef-init [init] [options]

Options:
  --source <spec>  Pi package source (git:host/path, https URL, npm:name, or a path).
                   Default: the repository in this package's package.json.
  --ref <ref>      Tag or commit to pin, appended as @<ref> to a git source.
  --global         Install for every project (~/.pi/agent/settings.json) instead of -l.
  --dir <path>     Target project directory. Default: current directory.
  --force          Overwrite an existing .pi-workflows/config.yaml.
                   (~/.pi/agent/chef.yaml is written only when you have no user config, never overwritten.)
  --no-install     Skip "pi install"; only write config and .gitignore.
  --dry-run        Print what would happen and change nothing.
  -h, --help       Show this help.`;

export function parseArgs(argv) {
  const opts = { source: undefined, ref: undefined, global: false, dir: process.cwd(), force: false, install: true, dryRun: false, help: false };
  const args = [...argv];
  if (args[0] === "init") args.shift();
  while (args.length > 0) {
    const arg = args.shift();
    const value = () => {
      const next = args.shift();
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case "--source": opts.source = value(); break;
      case "--ref": opts.ref = value(); break;
      case "--dir": opts.dir = path.resolve(value()); break;
      case "--global": opts.global = true; break;
      case "--force": opts.force = true; break;
      case "--no-install": opts.install = false; break;
      case "--dry-run": opts.dryRun = true; break;
      case "-h": case "--help": opts.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

// "git+https://host/owner/repo.git" -> "git:host/owner/repo"
export function sourceFromRepository(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) return undefined;
  const match = /^(?:git\+)?(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return match ? `git:${match[1]}/${match[2]}` : undefined;
}

export function withRef(source, ref) {
  if (!ref) return source;
  if (!source.startsWith("git:")) throw new Error("--ref only applies to a git: source");
  return `${source.replace(/@[^/@]+$/, "")}@${ref}`;
}

function resolveSource(opts) {
  if (opts.source) return withRef(opts.source, opts.ref);
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const source = sourceFromRepository(pkg.repository);
  if (!source) throw new Error("No repository in package.json; pass --source");
  return withRef(source, opts.ref);
}

function installPackage(source, opts, log) {
  const args = ["install", ...(opts.global ? [] : ["-l"]), source];
  log(`pi ${args.join(" ")}`);
  if (opts.dryRun) return true;
  const result = spawnSync("pi", args, { cwd: opts.dir, stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    log("pi is not on PATH. Install Pi, then run the command above in this project.");
    return false;
  }
  if (result.status !== 0) {
    log(`pi install exited with ${result.status ?? result.signal}. Config is still written; rerun the command above.`);
    return false;
  }
  return true;
}

function writeConfig(opts, log) {
  const target = path.join(opts.dir, ".pi-workflows", "config.yaml");
  const rel = path.relative(opts.dir, target);
  if (existsSync(target) && !opts.force) {
    log(`${rel} exists; kept it (use --force to overwrite)`);
    return;
  }
  log(`${existsSync(target) ? "overwrite" : "create"} ${rel}`);
  if (opts.dryRun) return;
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(packageRoot, ".pi-workflows", "config.yaml"), target);
}

// The commented user config: every personal setting as an example, nothing active. Never overwritten.
function writeUserConfig(opts, log) {
  const dir = path.join(homedir(), ".pi", "agent");
  const target = path.join(dir, "chef.yaml");
  const shown = "~/.pi/agent/chef.yaml";
  if (["chef.yaml", "chef.yml", "cost-workflow.yaml", "cost-workflow.yml"].some((name) => existsSync(path.join(dir, name)))) {
    log(`${shown} (or an older user config) exists; kept it`);
    return;
  }
  log(`create ${shown} (every setting commented out; uncomment what you want to change)`);
  if (opts.dryRun) return;
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(packageRoot, "templates", "chef.yaml"), target);
}

function updateGitignore(opts, log) {
  const target = path.join(opts.dir, ".gitignore");
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0) {
    log(".gitignore already has the workflow entries");
    return;
  }
  log(`add ${missing.length} line(s) to .gitignore`);
  if (opts.dryRun) return;
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  const header = current === "" ? "" : "\n";
  writeFileSync(target, `${current}${prefix}${header}# pi chef workflow state\n${missing.join("\n")}\n`);
}

export function run(argv, log = console.log) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  if (!existsSync(opts.dir)) throw new Error(`No such directory: ${opts.dir}`);
  if (opts.dryRun) log("dry run: nothing will change");

  let installed = true;
  if (opts.install) installed = installPackage(resolveSource(opts), opts, log);
  writeConfig(opts, log);
  writeUserConfig(opts, log);
  updateGitignore(opts, log);

  log(`
Next:
  1. Edit .pi-workflows/config.yaml: set checks:, setup:, and pricing rows.
  2. Your own settings (budgets, models, endpoints) go in ~/.pi/agent/chef.yaml: uncomment and edit.
  3. In Pi: /login openai, /login anthropic (and az login for Foundry), then /auth status.
  4. Grant project trust when Pi asks, so it reads .pi/settings.json.`);
  return installed ? 0 : 1;
}

// npx runs this through a node_modules/.bin symlink, so compare real paths.
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(`pi-chef-init: ${error.message}`);
    process.exitCode = 2;
  }
}
