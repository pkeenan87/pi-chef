import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Tests never read the developer's own Pi files (~/.pi/agent/chef.yaml, auth.json): HOME is a fresh empty directory.
const home = mkdtempSync(path.join(tmpdir(), "pi-chef-home-"));
process.env.HOME = home;
// Git reads $XDG_CONFIG_HOME/git/config as well as ~/.gitconfig.
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.USERPROFILE = home;
