# Commands

`help` or `--help` after any command prints its description. Tab completion covers `--no-questions`, `/plans` task names, `--with` models and agents, and `json`/`csv`.

| Command | Effect |
|---|---|
| `/plan [--no-questions] <request>` | Interview, spec, tickets, then approve. Edits nothing. |
| `/plans [--all]`, `/plans <name>`, `/plans close <name>` | List, switch, or close tasks. |
| `/show-plan` | Show the active task's plan; a draft reopens the approval picker. |
| `/build` | Build the approved plan, one ticket at a time, one commit each. |
| `/review [--with <model>]` | Checks, static scan and a model pass on the branch diff; offers to fix findings. |
| `/cost [json\|csv]` | Spend by model, job and task against the budgets. |

Nothing here pushes, opens a pull request or merges. Do that yourself.

## /plan

`/plan <request>` runs in your session on the model you picked with `/model`, with read-only tools (read, grep, find, ls, read-only bash, `web_search`, `web_fetch`) and the plan tools `plan_questions`, `plan_spec`, `plan_tickets`. Every `/plan <request>` starts a new task: a finished active task is closed, an unfinished one is parked (`/plans <name>` brings it back). With no request, an interrupted interview resumes.

1. **Interview.** The model reads the code and asks only decisions, in rounds, 3 to 7 questions in total. Each has 2 to 4 options, one marked recommended, plus "Other". Press `a` to accept every recommendation in a round. With no UI the recommendations are recorded. `--no-questions` skips the interview and records the recommended choices as assumptions in the spec.
2. **Spec.** A technical plan saved with `plan_spec`, including the planner's rating of complexity and risk.
3. **Tickets.** Vertical slices saved with `plan_tickets`, each with a difficulty (`low`, `medium`, `high`), implementation steps, acceptance criteria and `checks`. The tool rejects duplicate ids, missing blockers, cycles, a ticket without acceptance criteria, a ticket too big for its model's context (150000 tokens, or half the `contextWindow` of a local model), and a check that has shell syntax, is destructive, or is not a command on `PATH`.
4. **Approval.** The full plan is posted in the chat, then a picker offers Approve plan, Request changes (your feedback goes back to the model), Edit tickets, or Save as draft (Esc also saves a draft). Approving freezes `plan.vN.approved.json`. A material scope change needs a new approval.

Files go under `.pi-workflows/tasks/<id>/`: `plan.md`, `spec.md`, `interview.json`, `tickets/NN-slug.md`.

## /plans and /show-plan

One request is one task, named from the request (`retry-ingest-parser`). The active task is the one whose build branch is checked out; otherwise the last one you created or switched to.

- `/plans` lists open tasks, newest first, with the active one marked. `--all` adds closed ones.
- `/plans <name>` (a name, id or unique prefix) makes it active, checks out its branch when the tree is clean, and posts its plan.
- `/plans close <name>` closes a task after a confirmation when work is unbuilt. Files and branches are kept.
- `/show-plan` prints the active task's plan under its name and state.

## /build

Runs the approved tickets in dependency order. It refuses an unapproved plan, a plan with no tickets, and a spent budget. Run it again to resume: done tickets are skipped.

**Needs herdr.** Pi must run inside [herdr](https://herdr.dev) with `hc` on the `PATH`; otherwise `/build` stops before touching git. Every ticket runs in its own herdr tab beside your session.

**Branch.** A fresh build creates `<branchPrefix>/<task name>` in the current checkout, from the default branch (`origin/HEAD`, else `main` or `master`). Uncommitted changes are offered a separate "Changes before /build" commit first; declining (or no UI) refuses with `DIRTY_TREE`. One Pi process builds a task at a time (`BUILD_RUNNING`).

**Per ticket:**

1. **Route.** The ticket goes to `models.low`, `models.medium` or `models.high` by its difficulty. A Pi model must be known to Pi and have credentials, or the build stops with the reason.
2. **Run.** A Pi model runs as a `pi` of its own in a tab (with a ticket extension that applies the turn limit, the bash rules and your `local` provider). An agent (`agent:claude`) is that CLI opened in the tab: pi-chef types the ticket in with "do not commit" and a file to write its summary and acceptance-criteria checklist to, waits for the turn, and waits while it is blocked on an approval from you. pi-chef reads the summary file (else the tail of the screen). A commit the agent makes anyway is undone (`git reset --soft`); an agent that switched to another branch stops the ticket, and HEAD is left as it is. New files an agent leaves under `.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.opencode/` or `.grok/` are not committed. A passed ticket's tab is closed; a failed one stays open. A Pi ticket's tab blocks `git push`, branch switches and `git worktree` changes in its bash tool.
3. **Checks.** `setup` runs once per build, then the ticket's `checks` (else `config.checks`). A failure sends the output tail back to the same tab for one retry. A check that cannot run fails the ticket without blaming the model.
4. **Review.** With `review.tickets` on, `models.review` (or `models.high` when review is an agent) reads the ticket and its diff. Each finding is rated 1 to 10 for likelihood and severity; risk is the product, shown as `L7×S8=56`. Risk below 5 is dropped. A finding with risk 20 or more fails the ticket (one fix round, then it fails); lower ones are saved and listed as "carried from build" in the first `/review` after the ticket was built. A review call that errors or times out is recorded as unavailable and the ticket is committed with a warning.
5. **Commit.** The whole tree is committed as `<id>: <title>` and the ticket file is marked done. A ticket with no checks is committed with a warning.

A failed ticket climbs to the next rung with a different model (a rung naming the same model is skipped but counts as climbed; up to `routing.maxEscalations` rungs) and stops the build when none is left. A hand fix in the chat is re-checked and reviewed on the next `/build` and committed if it passes. Esc in a Pi ticket's tab aborts it; `/build` resumes on the same rung.

Spend is ledgered per ticket. Claude Code and Codex are metered from their own logs as API-equivalent cost; other agents show as "not metered" in `/cost`. One line per finished ticket is appended to `.pi-workflows/metrics/tickets.jsonl`. The chat gets a line per ticket and a table at the end.

## /review

Reviews what differs from the base (the build's recorded base, else the default branch): commits ahead of the merge-base plus uncommitted and untracked changes. Works after `/build`, after chat fixes, or with no task (the report goes under `.pi-workflows/reports/`). With nothing changed it says so and stops.

With an active task, Claude Code and Codex use in the repo that pi-chef did not start is counted first (see `/cost`).

1. `setup`, then the checks (`config.checks`, else the plan's ticket checks).
2. A static scan of the added lines (secrets, auth bypass, `eval`, TODO/FIXME).
3. A model pass (`models.review`, off with `review.model: false`): findings rated like the ticket review, those below risk 5 dropped. A diff over `review.maxDiffChars` is split by file into up to `review.maxChunks` calls.

`passed` means at least one check ran, all exited 0, and the scan found nothing blocking; the model pass is advisory and never changes it. The report (also saved as `reports/review.md`) has the stage table, checks, findings, and the plan's tickets. With a UI and at least one finding, a picker offers Fix all in a tab (first, only inside herdr), Fix all, Fix... (type which numbers and/or instructions), or Close. Fix all in a tab runs `models.medium` (a Pi model or an agent) in its own herdr tab: it fixes the findings in your working tree, then its tab closes and the chat shows what it reported. Its spend is ledgered as "review fix" (an agent not metered shows as such), so the main session never pays for it. Nothing is committed: a commit the fixer makes anyway is undone with `git reset --soft`, and a branch switch is left alone and reported; a failed fix leaves its tab open. Fix all and Fix... send the findings to your session instead.

`/review --with <provider/id | agent:name[/model]>` reviews with another model for this run (it also runs the model pass when `review.model` is false). An agent gets a herdr tab, reads the repo, and writes findings to a JSON file pi-chef reads and filters.

## /cost

Spend by model, job and task against the budgets. Claude Code and Codex use in this repo that pi-chef did not start (for example `hc run claude` from the chat) is counted first, under the job "outside chef"; it starts counting when the task is created, or at the first `/cost`, `/review` or `/build` of a task that predates this. A cost that could not be priced shows as unknown, never $0. `/cost json` and `/cost csv` write the ledger to `.pi-workflows/reports/`.

**Idle warning.** A prompt cache lapses after a while, so the first message into a big chat that sat idle re-writes the whole context. When you type a message (not a `/` command) after `budgets.idleWarnMinutes` idle minutes (default 60) with at least `budgets.idleWarnTokens` of context (default 100000), pi-chef asks first: Send anyway, or Don't send. The question says the cache has probably expired (the provider's TTL is not known) and, when the model has a `pricing` row, what re-sending costs at its cache-write price. It asks once per idle period. `/new` starts a fresh session and the task resumes from the branch. Set either value to `0` to turn it off.

## Status line

One footer line: `chef · <task> · <state> · $spent of $budget · today $spent of $daily budget`. While `/plan` runs it shows the interview stage. `≈` marks an amount that includes unknown cost counted at its estimate.

## Setup commands

- `npx github:pkeenan87/pi-chef init` — see [install.md](install.md).
- `node bin/chef-config.mjs` — the JSON CLI behind the herdr panel; see [install.md](install.md#herdr-side-panel).

## Model tools

`plan_questions`, `plan_spec` and `plan_tickets` work only during `/plan`. `web_search` (Anthropic account, Haiku) and `web_fetch` (public pages only) are always available; see [providers.md](providers.md#web-tools).
