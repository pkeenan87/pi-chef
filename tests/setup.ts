import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Tests never read the developer's own Pi files (~/.pi/agent/chef.yaml, auth.json): HOME is a fresh empty directory.
const home = mkdtempSync(path.join(tmpdir(), "pi-chef-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
