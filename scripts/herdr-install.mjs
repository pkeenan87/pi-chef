#!/usr/bin/env node
// Copies herdr/chef-config/ into the herdr app's mods folder and writes install.json, which names the CLI
// (an argv array with this checkout's absolute path; `node` is resolved by herdr's own environment) so the mod never hardcodes where the repo lives.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appHome = process.env.HERDR_APP_HOME || path.join(homedir(), ".config", "herdr-app");
const target = path.join(appHome, "mods", "chef-config");

mkdirSync(target, { recursive: true });
cpSync(path.join(repo, "herdr", "chef-config"), target, { recursive: true });
writeFileSync(path.join(target, "install.json"), JSON.stringify({ cli: ["node", path.join(repo, "bin", "chef-config.mjs")] }, null, 2) + "\n");
console.log(`chef-config mod installed in ${target}`);
