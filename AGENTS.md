# AGENTS.md

pi-chef is a Pi extension for `/plan` → `/build` → `/review`: a model per ticket difficulty, a per-ticket review, and cost tracking. User docs: `README.md` and `docs/` (`commands.md`, `configuration.md`, `providers.md`, `install.md`, `COMPATIBILITY.md`). This file is for agents and people changing the repo.

## Commands

```bash
npm test            # vitest, no network
npm run typecheck   # src and tests
npm run build       # tsc to dist/ (the chef-config CLI and herdr:install run from it)
```

Run tests with `TMPDIR=~/.cache/pi-chef-rework-tmp npm test` if the default temp dir is unsuitable. Tests and typecheck must be green before a change is done. There is no lint script. Keep `docs/` in step with `src/config.ts` (`KNOWN_KEYS`, defaults) and `templates/chef.yaml`.

## Layout

Entry and shared
- `src/index.ts`: package exports.
- `src/extension.ts`: Pi entry point. Registers commands, session hooks (`session_start`, `message_end` ledgering, `tool_call` blocks), the `local` provider and tools; keeps one `Workflow` per cwd; holds the `/build` driver (`buildHost`: herdr preflight, Pi model preflight, `runTicket`). `bindHerdrClient` is the test seam for the herdr client.
- `src/commands.ts`: the command table (name, description, completions; `drive` for `/build`).
- `src/config.ts`: YAML loading, validation, whole-section layering (`layerConfigs`), pricing lookup.
- `src/agents.ts`: built-in external agents, `parseTicketModel`, `agentCommand`.
- `src/domain.ts`: shared types (task state, phases, tickets, cost records) and `WorkflowError`.
- `src/redact.ts`: secret detection and redaction.
- `src/sandbox.ts`: command walker behind the deny rules (`assertCommandSafe`, `isDeniedCommand`) and the `/build` bash block (`buildBashBlock`).
- `src/usage-message.ts`: turns a Pi assistant message into a ledger entry.
- `src/ticket-mode.ts`: the extension a Pi ticket child loads with `-e` (turn budget, bash rules, `local` provider, status file); never listed in `package.json`.

Orchestrator (`src/orchestrator/`)
- `service.ts`: the `Workflow` facade over a shared `WorkflowContext` (`context.ts`).
- `machine.ts`: phase transitions. `types.ts`: shared callback types. `format.ts`: progress and report formatting.
- `planning.ts`: new tasks, `/plan`. `interview.ts`: the interview and spec. `prompts.ts`: planning prompts. `plan.ts`: `plan.md`. `present-plan.ts`: posting a saved plan and the approval picker. `classification.ts`: the planner's rating.
- `tickets.ts`, `ticket-plan.ts`: ticket validation, context sizing, ticket files.
- `tasks.ts`: names, listing, active task, closing. `plans.ts`: `/plans`.
- `build.ts`: `/build` (`startBuild`, `nextChunk`, `finishChunk`, `runBuild`), pure over a `BuildDriver`. `routing.ts`: model per difficulty and escalation. `turn-budget.ts`: ticket turn limit. `ticket-review.ts`: the per-ticket review gate.
- `review.ts`: `/review`. `review-report.ts`: its report and numbered findings. `agent-review.ts`: `/review` run by an external agent.
- `budget.ts`: usage recording and budget checks. `reports.ts`: `/cost`. `exec.ts`: running checks.

Runners, providers, review, storage
- `src/runner/ticket.ts`: dispatch (Pi model or agent) and the herdr requirement. `tab.ts`: the one open/send/wait/close loop (tab names, `send --wait`, blocked handling). `pi-ticket.ts` and `agent-ticket.ts`: how each starts its program and what it collects after a turn (a Pi child's session files; an agent's usage log, branch check and summary file). `host.ts`: session dirs, ledgering, git moves. `agent-usage.ts`: metering from agent logs.
- `src/herdr/client.ts`: typed wrapper over `hc` (self, run, send, waitIdle, read, kill). `session-file.ts`: reads a Pi child's session files for usage.
- `src/providers/`: `runtime.ts` (registers `local`), `known-models.ts` (presets), `local-context.ts` (served context probe), `clients.ts` and `pi-chat.ts` (model calls through Pi's registry), `usable.ts` (`registryProblem`).
- `src/review/`: `review.ts` (checks and static scan), `model-review.ts` (the `/review` model pass), `risk.ts` (scoring shared by all reviews), `scored-json.ts` (reading, deduping and filtering scored findings, shared by the model pass, agent review and ticket review).
- `src/cost/ledger.ts`: summaries and budget status. `src/storage/store.ts`: task state, event log, ledger, ticket log, locks. `src/git/workspace.ts`: git over `execFile`.
- `src/tools/`: `web-search.ts`, `web-fetch.ts` (with `html-to-markdown.ts`), `readonly-bash.ts` (the `/plan` allowlist), and the plan tools (`index.ts`, `plan-flow.ts`, `plan-questions.ts`, `plan-review.ts`).
- `src/cli/chef-config.ts` (with `bin/chef-config.mjs`): JSON CLI for the herdr panel. `src/cli/herdr-layout.ts`: docks the panel in a layout.

Elsewhere: `bin/init.mjs` (npx setup), `scripts/herdr-install.mjs`, `herdr/chef-config/` (the panel mod), `templates/chef.yaml` (user config template), `.pi-workflows/config.yaml` (project sample), `skills/chef-workflow/`, `tests/` (mocks only; `helpers.ts`, `herdr-fake.ts`).

## Rules

- **Cloud providers use whatever login or key Pi holds.** pi-chef checks `modelRegistry.find` and `hasConfiguredAuth` (`registryProblem`) and never reads provider key variables. Prices come from `pricing` rows; a model with no row is an unknown cost, never $0 (except `local`). Do not name a config field so it ends in a secret word (`apiKey`, `token`): `containsSecret` rejects it.
- **No secrets in config or state.** `assertNoSecrets` enforces it. The local server's key is a variable name (`local.apiKeyEnv`) that Pi resolves. Never log secrets or write them to state, the ledger or prompts.
- **Policy is deterministic; models only fill validated schemas.** Plan approval is always required. Nothing pushes, opens a PR or merges.
- **Layering is one rule:** a project section replaces the user's whole section (`layerConfigs`). `local`, `agents`, `pricing` and `workspaceDir` are user-only; a project value is ignored with a warning. Remote `local.baseUrl` must be https; only loopback may be http. An agent's `run` comes from the user file only.
- **Unknown config keys are ignored with one warning** (`KNOWN_KEYS` in `config.ts`). Any invalid value, secret or bad YAML rejects the whole file (`ConfigFileError`); it is surfaced at session start, never swallowed, and never crashes the session.
- **Routing:** a ticket starts on `models.<difficulty>` (`modelFor`), climbs low, medium, high on failure (a rung naming the same model is skipped) and stops above `high`. `routing.maxEscalations` counts rungs climbed to the next rung with another model. Resume keeps the rung (`TicketRun.tier`); review rounds are counted per rung.
- **Every `/build` ticket runs in its own herdr tab, in the current checkout.** Without herdr, `runBuild` returns `NEEDS_HERDR` before `startBuild`, so no branch is made. The driver never throws; `runTicket` returns `{ stopped }`. A fresh build gets `<branchPrefix>/<name>` from the default branch; `startBuild` claims the task by pid.
- **A Pi ticket child is a `pi` of its own** (`pi -ne -e ticket-mode.ts --model … --session-dir …`, environment through an `env` wrapper); its session files are ledgered. **An agent ticket is a CLI in a tab and pi-chef owns the commit:** a commit the agent makes anyway is undone with `git reset --soft`, but only while the checkout is still on the build branch (else the ticket stops and HEAD is left alone). The agent writes its summary and criteria checklist to a file under the task's `sessions/`; that file, not the screen, feeds the ticket's summary and ticked criteria.
- **Agent usage comes from the agent's log or is recorded as not metered** (`createAgentMeter`). Claude Code and Codex are metered; others get one `meter: "not-metered"` row per attempt.
- **Every model call reaches the ledger.** Session turns come from `message_end`; calls pi-chef makes record themselves; Pi's own calls are swept from the session file by `sweepPiUsage` into `recordPiUsage`, once per entry id. A failed call ledgers what the provider reported, else unknown. Only the runners' own ledgering tags rows ` · ticket <id>`; the main session's turns never are.
- **Unknown cost is never zero.** Record `actualUsd: null`; budgets count an estimate from tokens and the dearest price, else `budgets.unknownCallUsd`. The estimate lives in `summarize`, never in a ledger row. Money math is integer micro-USD.
- **Review findings are scored 1-10 for likelihood and severity; risk is the product** (`src/review/risk.ts`). Below `MIN_RISK` (5) or unscored is dropped; never default a score. The per-ticket review gates (`TICKET_FAIL_RISK` 20 fails the ticket) and its lower findings are carried into the first `/review` after it (newer than the last saved report); the `/review` model pass advises and never changes `passed`.
- **Checks are command lines, never prose, and run without a shell.** Every check and setup command passes `assertCommandSafe`. `validateTickets` rejects shell syntax and commands not on `PATH`. A check that cannot run (`ran: false`) fails the ticket without counting against the model.
- **Spawn with `execFile` and argv arrays, never a shell.** Put `--` before user-derived refs.
- **Writes to `.pi-workflows/` go through `atomicWrite`, `withLock`, or append-only files.** Never truncate `events.jsonl` or the ledger.
- **Phase changes go through `transition`** (`machine.ts`). Commands return results through `guard` and do not throw to Pi. A command result is plain text; markdown escapes belong only inside table cells.
- **The active task resolves from the checked-out branch, then from `active-task.json`** (`activeTask` in `tasks.ts`), reacting to branch changes only.
- **Commits:** `GitWorkspace` uses `pi-chef <pi-chef@localhost>` only for a name or email git lacks, and sets `commit.gpgsign=false`. `commitAll` runs with `core.hooksPath=/dev/null` and `--no-verify`, and excludes `.pi-workflows` paths and new untracked files under an agent's directory (`.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.grok/`). The ticket child's `tool_call` hook (`ticket-mode.ts`) blocks `git push`, branch switches and worktree changes; the main session has no such hook, so an agent ticket is checked after each turn instead (branch, HEAD). No command of this extension pushes.
- **The chat trail is part of the product.** `ctx.progress` posts one-line events and `ctx.report` posts markdown blocks; keep per-ticket lines, the `/build` table and the `/review` stage lines. Timings come from `ctx.now()`, never `Date.now()`.
- **One status line:** `refreshStatus` draws the `chef` footer from `Workflow.statusLine()` using the stored active task, never git.
- **Price every new model** in the user `pricing`, or session start warns once (`unpricedConfigModels`).
- **Tests use fakes** for transports, clocks, Pi and herdr; never a real network call or a real herdr client. `tests/setup.ts` deletes `HC_TERMINAL_ID` and `HC_SCOPE`; tests that reach `/build` or an agent `/review` inject `fakeHerdrClient`. Shared fixtures go in `tests/helpers.ts`.

## Unverified against live services

The `/build` loop has only run against fakes (the fake herdr client, check runners). The full list is in `docs/COMPATIBILITY.md#unverified-live`.
