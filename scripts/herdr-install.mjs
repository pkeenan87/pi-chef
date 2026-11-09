#!/usr/bin/env node
// Copies herdr/chef-config/ into the herdr app's mods folder, writes install.json (which names the CLI as an argv array
// with this checkout's absolute path, so the mod never hardcodes where the repo lives), and docks the panel in the
// layout: herdr applies a mod's mod.json "place" only the first time it sees the mod, so an already-seen mod needs a
// column in a layout. herdr rewrites its shipped layouts (main, terminals, win98) on every start, so the column goes in
// a layout of your own: "chef" (made from the layout in use) unless --layout names another. A shipped one is refused.
//   node scripts/herdr-install.mjs [--layout <name>] [--no-dock]
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appHome = process.env.HERDR_APP_HOME || path.join(homedir(), ".config", "herdr-app");
const target = path.join(appHome, "mods", "chef-config");
const args = process.argv.slice(2);
const layoutAt = args.indexOf("--layout");
const layout = layoutAt >= 0 ? args[layoutAt + 1] : undefined;
if (layoutAt >= 0 && (!layout || layout.startsWith("--") || !/^[\w.-]+$/.test(layout))) {
  console.error("herdr-install: --layout needs a layout name (the file in layouts/ without .json)");
  process.exit(2);
}

mkdirSync(target, { recursive: true });
// The mod is a few files: copy them over a clean folder so a file removed from the repo does not linger.
// gpui-kit.d.ts and jsconfig.json are editor types for working on the mod; the installed mod does not need them (an older install may hold them).
const editorOnly = ["gpui-kit.d.ts", "jsconfig.json"];
for (const name of ["main.js", "lib.js", "edit.js", "mod.json", ...editorOnly]) rmSync(path.join(target, name), { force: true });
cpSync(path.join(repo, "herdr", "chef-config"), target, { recursive: true, filter: (source) => !editorOnly.includes(path.basename(source)) });
writeFileSync(path.join(target, "install.json"), JSON.stringify({ cli: ["node", path.join(repo, "bin", "chef-config.mjs")] }, null, 2) + "\n");
console.log(`chef-config mod installed in ${target}`);

if (!args.includes("--no-dock")) {
  const { dockLayoutFile } = await import(pathToFileURL(path.join(repo, "dist", "cli", "herdr-layout.js")).href);
  const report = dockLayoutFile(appHome, layout ? { layout } : {});
  for (const line of report.lines) console.log(line);
}
