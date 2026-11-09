#!/usr/bin/env node
// Thin shim: runs the compiled CLI (npm run build writes dist/cli/chef-config.js).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A closed pipe (| head) is not an error.
process.stdout.on("error", (error) => process.exit(error.code === "EPIPE" ? 0 : 1));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "cli", "chef-config.js");

if (!existsSync(entry)) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: `run npm run build in ${root}` })}\n`);
} else {
  const { main } = await import(pathToFileURL(entry).href);
  process.exitCode = await main(process.argv.slice(2));
}
