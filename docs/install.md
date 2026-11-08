# Installing pi-chef

The quick path is `npx github:pkeenan87/pi-chef init` (see the [README](../README.md#one-command-setup)). This page does the same steps by hand and covers the other install methods.

## Choose a scope

| Flag | Pi writes the package to | Loads in |
|---|---|---|
| (none) | `~/.pi/agent/settings.json` | every project |
| `-l` / `--local` | `.pi/settings.json` in the current directory | this project, after you grant project trust |

Run the commands below from the project directory when you use `-l`. Commit `.pi/settings.json` if the whole team should get the package.

## Install from GitHub

```bash
pi install -l git:github.com/pkeenan87/pi-chef
```

Pin a tag or commit so updates do not move under you:

```bash
pi install -l git:github.com/pkeenan87/pi-chef@<tag-or-commit>
```

Pi also accepts the plain URL and treats it as a git source:

```bash
pi install -l https://github.com/pkeenan87/pi-chef
```

Pi clones with `git`, so the machine needs git access to `github.com`. The repository is public, so no credentials are needed. A read-only mirror exists at origin.cursor.com/pkeenan/pi-chef. Pi installs `dependencies` (`yaml`) for git sources.

## Install from another git host

Any git host works with the same form. For a fork:

```bash
pi install -l git:github.com/<owner>/pi-chef@<tag-or-commit>
```

## Install from a local checkout

```bash
git clone https://github.com/pkeenan87/pi-chef.git ~/src/pi-chef
cd ~/src/pi-chef && npm install
cd /path/to/your/project
pi install -l ~/src/pi-chef
```

Pi loads a local path in place without copying it, and it does not install that package's dependencies. Run `npm install` in the checkout first. A relative path resolves from the settings file that contains it.

## Install from npm

Not published yet. `package.json` is `"private": true`. After a publish, the command is:

```bash
pi install -l npm:pi-chef@<version>
```

## Try it once without installing

```bash
pi -e git:github.com/pkeenan87/pi-chef
```

`-e` loads the package for one run and writes nothing to settings.

## Develop this repo

```bash
npm install
npm test
npm run typecheck
```

## The chef-config CLI

`chef-config` reads the two config files and prints, as one JSON document, everything a settings UI needs: both file paths and whether each exists, their text and parsed values (redacted), and for every key its user value, project value, built-in default, effective value, source and layering rule, plus the loader's `warnings` and `errors` and the key schema. It is the bridge for the herdr `chef-config` mod; it spawns nothing and never prints a secret.

It runs from compiled output, so build it once in the checkout (and again after pulling changes):

```bash
npm install
npm run build
node bin/chef-config.mjs inspect --cwd /path/to/project
```

Without `dist/`, the command prints `{"ok":false,"error":"run npm run build in <dir>"}`. A config problem (a rejected file, a bad value) is reported inside the JSON under `errors` and the exit status stays 0; the status is nonzero only for a usage error. When the project file is rejected, `effectiveFrom` is `user` and the values shown are the user file's alone.

### Editing: `set` and `unset`

```bash
node bin/chef-config.mjs set   --cwd /path/to/project --file user|project --key budgets.taskUsd --value 7 [--expect <sha256>]
node bin/chef-config.mjs unset --cwd /path/to/project --file user|project --key budgets.taskUsd [--expect <sha256>]
```

`--value` is YAML: a scalar (`7`, `true`, `premium`, `"1234"` to force a string) or a flow list (`[auth, secrets]`). Both commands print the new `inspect` JSON. A refused edit prints it too, with `"ok": false` and an `"error"`, writes nothing and exits 0; the status is 2 only for a usage error. A successful one adds `edit` (`{file, path, key, action, changed}`); `unset` of a key that is not in the file changes nothing.

- **Comments survive.** The edit is made on the key's own line (and, for a new key, the lines it adds), so blank lines, comments and trailing notes keep their bytes, and CRLF files stay CRLF. Each edit is checked: the file must parse to exactly what the edit should produce (that key set or gone, nothing else changed). When the line editor cannot do that (a file indented by something other than 2 spaces, or a layout it cannot read safely) the `yaml` Document API makes the edit instead, which keeps comment text but may change spacing, blank lines and the position of some comments; the result then has `edit.reflowed: true`.
- **The sample config is understood.** If the file has the commented sample line for the key (`#   taskUsd: 20   # one task's spend` under `# budgets:`), `set` uncomments that line and its section header in place, replacing the value and keeping the note. `unset` of a key in the user file whose line is still the sample's (it keeps the sample's trailing note) puts the sample's own commented line back, and comments the header out again once nothing else under it is live. A hand-written line (no sample note), and anything in the project file, is simply deleted, along with a header it empties; no comment is left behind. Any other key is added under its section (a commented sample header is uncommented in place; a missing section is created at the end of the file) and deleted on `unset`, along with a section it empties.
- **Refused:** a value that does not fit the key (type, enum, minimum or maximum: `budgets.taskUsd` 0), a structured key (tiers, pricing rows, quota rows: edit the file), an unknown key, a secret, any result `loadConfig` would reject the whole file for (its lenient path: a bad tier, session or quota section is only a warning, so it does not block an edit elsewhere), a user-only or fixed key in `--file project` (except a provider location field when the user file has no block for that provider, as the loader allows), and a stale `--expect`.
- **Rolled back:** some rules only show once both files are loaded (`proprietaryCode: true` needs `orgProviderAllowlist`). After a write, `inspect` is compared with its state before; if the edit caused a new error, the file is restored (or removed, if it was new) and the edit comes back `ok: false` with that error. An error that was already there does not block an unrelated edit.
- **`--expect`** is the `sha256` that `inspect` reports for each file (`user.sha256`, `project.sha256`: of the file text, or of the empty text when missing). Pass it back so an edit made since the panel read the file is not overwritten.
- **Where it writes:** the user file is `~/.pi/agent/chef.yaml` (or `.yml`; the legacy `cost-workflow.yaml` when it is the only one), the project file `.pi-workflows/config.yaml` (or `.yml`); a missing file is created. Writes are atomic (a temp file in the same folder, then a rename).
- **Layering still applies.** Raising a lower-wins key in the user file while the project file sets a lower value writes fine; `inspect` then shows the project's value as effective.

## The herdr panel

The `chef-config` mod for the [herdr](https://herdr.dev) app shows every setting with its user, project and built-in default value, the effective value, where it came from (default, user, project) and the layering rule that picked it, plus both file paths (exists or missing), the loader's warnings and any file-level error.

Scalar settings can be edited in place: top level, `isolation.*`, `session`, `localMode`, `workers`, `budgets`, `routing`, `review` and `advisors` (a switch for booleans, option buttons for enums, a number input with its minimum and maximum, a text input for strings, paths and `provider/id`, and a Reset button that runs `unset`). Lists, tiers, providers, pricing and quota rows are still read-only, and `approvals.*` and `schemaVersion` cannot be edited at all.

- **User or Project.** Each row has a *write to* choice, User by default. Project is disabled, with the reason shown, for user-only and fixed keys (the same rule the CLI applies).
- **Every write goes through the CLI** (`set` / `unset` with `--expect` set to that file's `sha256` from the last `inspect`); the mod never writes a config file itself. A refusal (bad value, stale file, a rule only visible with both files loaded) shows the CLI's error under that row and the control goes back to the effective value. A success re-renders from the CLI's new `inspect`, says that pi-chef applies it on the next command, warns when the file was reflowed, and, for lower-wins, higher-wins, off-or-raise and restricts-only keys, says which file's value is in effect when it is not the one just written.
- **No secrets.** A value that looks like a key or token is not sent, and no value is logged.
- Text and number inputs are sent on Enter or when they lose focus, and only when the text changed.

```bash
npm run herdr:install
```

This builds the CLI, copies `herdr/chef-config/` to `~/.config/herdr-app/mods/chef-config/` (`$HERDR_APP_HOME` if set) and writes `install.json` there, naming `[node, <this checkout>/bin/chef-config.mjs]` so the mod never hardcodes the repo path. Run it again after moving the checkout or pulling changes.

Open it with `ctrl-shift-g` after adding this to the `global` section of `~/.config/herdr-app/keys.json`:

```json
"ctrl-shift-g": {"command": "tab.new", "args": {"mod": "chef-config", "name": "chef config"}}
```

or with `herdr-app do tab.new --mod chef-config --name "chef config" --props '{"folder":"/path/to/project"}'`. The project is `props().folder`, else the focused pane's folder, walked up to its git root. Herdr's command palette lists only app commands, not a mod's own, so the panel has no palette entry; use the key or the command above. The panel refreshes when either config file changes, every 10 seconds as a fallback, and with its Refresh button. When opened with the key it has no folder of its own, so it uses the active space's folder.

## Layout

```text
src/extension.ts          Pi commands, the session hooks (model pin, compaction, input budget gate), and the /build session driver
src/commands.ts           the command table
src/orchestrator/         state machine, plans, workflow; build.ts (/build), review.ts (/review)
src/providers/            account-login gate, Foundry, Vercel, Pi registry chat
src/router/               keyword classification, policy, and per-tier candidate selector
src/review/               static scan, checks, the advisory model pass, and the advisor client
src/cost/                 ledger, budgets, quota, baseline compare
src/storage/              lock, journal, snapshots
src/git/workspace.ts      branch, diff, and commit helpers for the checkout
src/tools/                web_search, web_fetch, and the plan tools
bin/init.mjs              npx setup: pi install, sample config, .gitignore
bin/chef-config.mjs       shim for the chef-config CLI (src/cli/chef-config.ts, built to dist/)
src/config-schema.ts      the table of every config key, its type, default and layering rule
herdr/chef-config/        the herdr panel (a herdr mod: main.js, mod.json)
scripts/herdr-install.mjs npm run herdr:install: copies the mod to herdr's mods/ and writes install.json
tests/                    unit and integration, mocks only
```

Artifacts for a task:

```text
.pi-workflows/tasks/<task-id>/
  plan.md
  plan.json
  plan.vN.approved.json
  state.json
  events.jsonl
  tickets/
  spec.md
  interview.json
  reports/
```
