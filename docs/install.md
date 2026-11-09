# Installing pi-chef

## Requirements

- Pi (`@earendil-works/pi-coding-agent` 1.2.0 is what this repo was checked against), Node >= 20.
- `/plan`, `/cost` and `/review` with a Pi model need only Pi.
- `/build` needs Pi to run inside a [herdr](https://herdr.dev) terminal with `hc` on the `PATH`; outside herdr it stops before touching git.
- External agents (`claude`, `codex`, ...) must be installed and signed in on their own.

## One command

From the project directory:

```bash
npx github:pkeenan87/pi-chef init
```

It runs `pi install -l git:github.com/pkeenan87/pi-chef`, copies the sample config to `.pi-workflows/config.yaml` (kept unless `--force`), creates `~/.pi/agent/chef.yaml` from `templates/chef.yaml` when you have none (never overwritten), and adds the workflow-state lines to `.gitignore`. If `pi install` fails it still writes the config, prints the command, and exits 1.

| Flag | Meaning |
|---|---|
| `--source <spec>` | Pi package source (`git:host/path`, URL, `npm:name`, or a path). Default: the repository in `package.json`. |
| `--ref <ref>` | Tag or commit to pin, appended as `@<ref>`. |
| `--global` | Install for every project (`~/.pi/agent/settings.json`) instead of `-l`. |
| `--dir <path>` | Target project directory. |
| `--force` | Overwrite an existing `.pi-workflows/config.yaml`. |
| `--no-install` | Only write config and `.gitignore`. |
| `--dry-run` | Print what would happen. |

## By hand

```bash
pi install -l git:github.com/pkeenan87/pi-chef            # this project; omit -l for every project
pi install -l git:github.com/pkeenan87/pi-chef@<tag>     # pinned
git clone https://github.com/pkeenan87/pi-chef.git ~/src/pi-chef && (cd ~/src/pi-chef && npm install)
pi install -l ~/src/pi-chef                               # a local checkout, loaded in place
pi -e git:github.com/pkeenan87/pi-chef                   # one run, nothing written
pi list
pi update git:github.com/pkeenan87/pi-chef
pi remove -l git:github.com/pkeenan87/pi-chef
```

Then copy `.pi-workflows/config.yaml` from a checkout into the project and gitignore the state:

```gitignore
.pi-workflows/tasks/
.pi-workflows/cost/
.pi-workflows/metrics/
.pi-workflows/reports/
.pi-workflows/notifications.jsonl
.pi-workflows/active-task.json
.pi-workflows/*.local.yaml
```

Configuration: [configuration.md](configuration.md).

## Herdr side panel

The `chef-config` mod is a side panel (about 340 px) in the [herdr](https://herdr.dev) app with four sections:

- **Models.** `low`, `medium`, `high`, `review`: each a Pi model (`provider/id`), a local model, or an agent (plus an optional model).
- **Local model.** Server URL with presets (llama.cpp `:8080`, Ollama `:11434`, LM Studio `:1234`), Detect (served ids and context windows), Add, remove.
- **Plans.** The project's tasks with state, tickets done/total and spend; Make active, Close.
- **Costs.** Today against `budgets.dailyUsd`, the active plan against `budgets.taskUsd`, spend by model and phase; both budgets are editable.

It edits `~/.pi/agent/chef.yaml` only (comments survive, the value is validated by the real loader first, secrets are refused). It follows the focused pane's git root and refreshes every 8 seconds.

Install from a checkout of this repo:

```bash
npm install
npm run herdr:install                       # builds, copies herdr/chef-config/ to ~/.config/herdr-app/mods/chef-config/
npm run herdr:install -- --layout mine      # dock into another layout of yours
npm run herdr:install -- --no-dock          # copy the mod only
```

`$HERDR_APP_HOME` overrides `~/.config/herdr-app`. The install writes `install.json` naming this checkout's `bin/chef-config.mjs`; run it again after moving the checkout or pulling changes.

**Docking.** herdr places a mod only the first time it sees it, so the install adds the panel to a layout as its own right-edge column (`{ id: "chef", type: "block", size: { px: 340 }, min: 280, max: 640, content: { mod: "chef-config" } }`). It never edits layouts herdr ships (`main`, `terminals`, `win98`; `--layout main` is refused). By default it makes a layout named `chef` from the one in use (an existing `chef.json` is backed up as `chef.json.bak-<time>` first). It is idempotent. Switch with:

```bash
herdr-app do layout.switch '{"name":"chef"}'
```

Optionally bind a show/hide key in the `global` section of `~/.config/herdr-app/keys.json`:

```json
"ctrl-shift-g": {"command": "layout.toggle", "args": {"id": "chef"}}
```

### The chef-config CLI

The JSON CLI the panel calls. Every command prints one JSON document; a refused request is `{"ok":false,"error":"..."}` with exit 0 (exit 2 is a usage error). Run `npm run build` first.

| Command | Does |
|---|---|
| `show --cwd <dir>` | Models, local server, agents, budgets, plans, costs, warnings, and `files.user.sha256`. |
| `set --cwd <dir> --key <key> --value <v> [--expect <sha256>]` | Writes `models.low\|medium\|high\|review`, `local.baseUrl`, `budgets.taskUsd` or `budgets.dailyUsd` to the user file. An empty value removes the key. |
| `local-add --cwd <dir> --id <id> --context-window <n> [--base-url <url>]` | Saves a served model in `local.models`. |
| `local-remove --cwd <dir> --id <id>` | Drops an id (the last one stays). |
| `local-detect --base-url <url> [--cwd <dir>]` | Lists the server's models and context windows. |
| `plan-activate --cwd <dir> --id <plan id>` | Makes a plan active; does not switch branches. |
| `plan-close --cwd <dir> --id <plan id> [--force]` | Closes a plan; `--force` for unbuilt work. |

`--expect` takes the `sha256` from the last `show`, so an edit made since is not overwritten.

## Develop

```bash
npm install
npm test
npm run typecheck
```

Source layout: [AGENTS.md](../AGENTS.md).
