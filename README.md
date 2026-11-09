# pi-chef

A Pi extension that plans, builds and reviews coding work: `/plan` → `/build` → `/review`. You plan and approve once; each ticket is built on the model for its difficulty, checked, reviewed and committed; `/review` checks the result and fixes what it finds. You push and open the pull request yourself.

Which model does what is configuration. Your own session plans, on whatever you pick with `/model`. Tickets are rated `low`, `medium` or `high` when planned, and each difficulty has a model. A model is a Pi model (`provider/id`, through your Pi login or a local server) or an external coding agent such as Claude Code or Codex (`agent:claude`). A failed ticket climbs low, medium, high, then stops. Spend is tracked against budgets. State lives in `.pi-workflows/`; there is no hosted service or database.

`/build` runs every ticket in its own [herdr](https://herdr.dev) tab, so Pi must run inside herdr. `/plan`, `/review` and `/cost` need only Pi.

## Install

From the project directory:

```bash
npx github:pkeenan87/pi-chef init
```

This runs `pi install -l`, writes `.pi-workflows/config.yaml`, creates `~/.pi/agent/chef.yaml` (a commented template) if you have none, and gitignores the workflow state. Other methods and flags: [docs/install.md](docs/install.md).

## Configure

Everything is optional. The four settings you will touch first, in `~/.pi/agent/chef.yaml`:

```yaml
models:
  low: xai/grok-4.7                       # a Pi model
  medium: anthropic/claude-sonnet-5-5
  high: agent:claude                      # an external agent, run in a herdr tab
  review: anthropic/claude-opus-5-5
```

Those are the defaults except `high`. Also configurable: a local model server, agents, budgets, pricing, and the `checks` that verify work. Set `checks` in the project's `.pi-workflows/config.yaml` before expecting `/review` to pass:

```yaml
checks:
  - { name: test, command: npm, args: [test] }
```

Every setting: [docs/configuration.md](docs/configuration.md). Pi logins and local servers: [docs/providers.md](docs/providers.md).

## Daily workflow

```text
/plan Harden the ingest parser: reject empty events. AC: empty input throws
/build
/review
```

then push and open the pull request yourself:

```bash
git push -u origin HEAD
gh pr create
```

1. **`/plan <request>`** interviews you on a few decisions (3 to 7 questions, each with a recommendation; `--no-questions` skips them), writes a spec, and splits the work into tickets. Nothing is edited. You approve, request changes, edit the tickets, or save a draft. Approval is always required.
2. **`/build`** creates a branch `chef/<task name>` and builds the tickets one at a time, each in a fresh herdr tab. After a ticket's checks pass, the review model reads its diff; the ticket is committed unless a finding is serious. Run `/build` again to resume or after fixing a failed ticket.
3. **`/review`** runs the checks, a static scan and a model pass over the branch diff, lists findings by risk, and offers to fix them in your session. It never commits or pushes.
4. **`/cost`** shows spend by model, job and task; `/plans` lists and switches tasks; `/show-plan` re-reads the plan.

Each command in detail: [docs/commands.md](docs/commands.md).

## Side panel

With herdr, `npm run herdr:install` adds a side panel for the things you change most: the model for each difficulty and review, the local model server, your plans, and costs against the daily and task budgets. It edits `~/.pi/agent/chef.yaml` and keeps its comments. See [docs/install.md](docs/install.md#herdr-side-panel).

## Limits

- Tickets run in your checkout, not a sandbox. Pi's bash tool blocks destructive commands (`rm -rf`, force push, piping a download into a shell) and, during a ticket, `git push` and branch switches. The block is a hook and a script or command substitution can hide a command, so read the diff.
- While `/plan` runs, bash is limited to a read-only allowlist.
- Nothing pushes, opens a pull request, or merges.
- The `/build` loop has only been run against fakes, not a live herdr; see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md#unverified-live).
- The tests make no paid provider calls.

## Documentation

| Doc | Contents |
|---|---|
| [docs/install.md](docs/install.md) | Install methods, the herdr panel and its CLI |
| [docs/configuration.md](docs/configuration.md) | Every setting with type and default |
| [docs/commands.md](docs/commands.md) | Each command in detail |
| [docs/providers.md](docs/providers.md) | Pi logins, local servers, external agents, web tools |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | Pi and herdr APIs used, and what is unverified live |
| [AGENTS.md](AGENTS.md) | Guide for agents and people changing this repo |
