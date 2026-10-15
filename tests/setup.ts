import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Tests never read the developer's own Pi files (~/.pi/agent/cost-workflow.yaml, auth.json): HOME is a fresh empty directory.
const home = mkdtempSync(path.join(tmpdir(), "pi-cost-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
