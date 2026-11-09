import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// One temp root per run: tests mkdtemp under os.tmpdir() and rarely clean up, so point TMPDIR at a root that teardown removes.
// Env set here is inherited by the workers, which start after globalSetup. An existing TMPDIR is the parent.
let root = "";

export function setup(): void {
  root = mkdtempSync(path.join(tmpdir(), "pi-chef-run-"));
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
}

export function teardown(): void {
  if (root) rmSync(root, { recursive: true, force: true });
}
