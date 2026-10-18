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
