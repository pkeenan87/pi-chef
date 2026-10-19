# Commands

Every command pi-chef adds to Pi, with its arguments, what it reads and changes, and what it prints. Settings named here are in [configuration.md](configuration.md).

All commands:

- run in your Pi session and never push, open a pull request, or merge;
- return one line in the chat, and post longer reports (tables, plans) as a separate block that stays in the transcript;
- redraw the [status line](#the-status-line) when they finish;
- print their description with `help` or `--help` as the argument, for example `/plan help`.

Tab completion covers `/plan` flags, `/plans` task names and `close`/`--all`, `/cost` formats, `/status foundry`, and `/auth status` / `/auth login <provider>`.

| Command | What it does |
|---|---|
| [`/plan`](#plan) | Start a task: interview, spec, tickets, approval |
| [`/show-plan`](#show-plan) | Show the active task's plan; approve a draft |
| [`/plans`](#plans) | List, switch between, or close tasks |
| [`/build`](#build) | Build the approved tickets, one fresh session and one commit each |
| [`/review`](#review) | Check the branch, list findings, and fix them in this session |
| [`/status`](#status) | Where the task stands, and what to do next |
| [`/cost`](#cost) | Spend against budgets, from the ledger |
| [`/route`](#route) | Preview which tier and model a request would get |
| [`/advisor`](#advisor) | Ask the advisor tier one question |
| [`/auth`](#auth) | Login status, or how to sign in to a provider |
| [`/chef`](#chef) | List these commands |

Also: [the status line](#the-status-line), [the init command](#the-init-command-pi-chef-init) that installs pi-chef, the [Pi commands](#pi-commands-you-use-with-pi-chef) you need alongside it, and the [tools the models call](#tools-the-models-call).

## /plan

```text
/plan [--no-questions] [--local | --cloud] <request>
/plan                      # resume the plan that is running
```

Plans one request as a new task, on your session model (`session.model`, Opus by default). It never edits the repo: while it runs, the edit and write tools are off and bash is limited to a read-only allowlist.

| Argument | Meaning |
|---|---|
| `<request>` | What to build, in your words. Acceptance criteria may follow (`AC: empty input throws`) |
| `--no-questions` | Skip the interview. The planner records the choices it would have recommended as assumptions in the spec |
| `--local` | Local mode: every ticket is written for, and built by, the model in `tiers.local`, sized from its tag (`9b`, `27b`). With `localMode.difficulties` set, only those tickets go local and the rest to the cloud tiers. See [Local mode](../README.md#local-mode) |
| `--cloud` | Plan for the cloud tiers even when `localMode.default` is true |

Steps:

1. **Interview.** 3 to 7 questions in total, in rounds, each with a recommended option. Press `a` to accept every recommendation in a round.
2. **Spec.** A technical implementation plan, saved as `spec.md`, with the planner's rating of the task: complexity, risk, and whether it is security-sensitive.
3. **Advisor consult.** The draft tickets go to the advisors once per plan version (`advisors.plan`).
4. **Tickets.** Each ticket is validated and must fit `workers.ticketContextTokens`; in local mode it must also fit the local model's limits.
5. **Review.** The whole plan is posted, then a picker:

| Choice | Effect |
|---|---|
| **Approve plan** | The plan becomes approved; run `/build` |
| **Request changes** | Your text goes back to the planner, which revises the spec and tickets and asks again |
| **Edit tickets** | Opens the tickets as markdown to edit; the edit is validated like the planner's |
| **Save as draft** | Keeps the draft unapproved; approve it later with `/show-plan` |

What it changes:

- **The task:** it creates a new task under `.pi-workflows/tasks/<id>/` and makes it active.
- **The task that was active:** a finished one (built, review passed) is closed. Any other is parked untouched; `/plans <name>` brings it back.
- **The interview:** answers are saved, so a plan interrupted by a restart resumes when you run `/plan` with no request, or with the same request.

A request containing a literal ```` ```tasks ```` block is drafted directly, with no model turn. Such a plan has no tickets, so `/build` cannot run it.

It refuses to start when the task or daily budget is exhausted.

## /show-plan

```text
/show-plan
```

Prints the active task's full plan (spec and tickets) under its name and state line. For a draft it opens the review picker (Approve plan, Request changes, Close), so you can approve a plan you saved earlier. It changes nothing unless you pick an action.

## /plans

```text
/plans                    # open tasks, newest first; the active one marked ●
/plans --all              # also closed tasks
/plans <name>             # switch to a task (name, id, or unique prefix)
/plans close <name>       # close a task
```

| Form | Effect |
|---|---|
| `/plans`, `/plans --all` | A table of tasks: name, state, tickets done/total, branch, last update. Changes nothing |
| `/plans <name>` | Makes the task active and posts its plan; a draft gets the approve picker. If the working tree is clean, it also checks out the task's build branch. If not, it says the branch was not changed |
| `/plans close <name>` | Moves the task to `COMPLETE` (`closedReason: closed by user`). It asks first when tickets are unbuilt or the review has not passed. Files, branches and git are never touched. If it was the active task, the most recently updated open task becomes active |

**Which task is active.** It follows the branch you check out: the build branch of an open task makes that task active. Otherwise the last task you created or switched to stays active.

## /build

```text
/build
```

Builds the active task's approved tickets one at a time, in dependency order, on one branch. Run it again at any time to resume. It holds the Pi command until it finishes or stops; Esc stops it after the current turn.

It refuses:

- a plan that is not approved, or one with no tickets;
- an exhausted budget;
- a dirty tree it cannot switch branches with.

For a security-sensitive plan it asks you to confirm first.

**Branch.**

- **On the default branch** it creates and switches to `<branchPrefix>/<task name>`. On any other branch it builds there.
- **Uncommitted changes** at the start of a fresh build are listed, and it offers to commit them first as a separate "Changes before /build" commit.
- **Commits use your git identity.** `pi-chef <pi-chef@localhost>` is used only when git has none configured.

**Per ticket:**

1. **Route.** The ticket goes to the tier of its difficulty: `ticketLow`, `ticketMedium` or `ticketHigh`, or `tiers.local` for a local ticket (every ticket in local mode, or those of `localMode.difficulties`). Within the tier the model is picked by `routing.selection`.
2. **Session.** It opens a fresh Pi session on that model and sends the ticket. While the ticket runs, `git push` and branch switches are blocked.
3. **Checks.** It runs `setup` (once per build), then the ticket's `checks`, else the config's `checks`. A failure gets one retry turn in the same session.
4. **Review.** The review tier (`routing.reviewTier`) reviews the ticket's diff; high tickets also get advisors. A first fail sends the findings back for a fix; a second fail fails the ticket at that tier.
5. **Commit.** It commits the tree as `<id>: <title>`, then moves on.

**When a ticket fails:**

- **It moves up a tier** on the next `/build`: `ticketLow`, then `ticketMedium`, `ticketHigh`, `premium`, at most `routing.maxEscalations` steps and never past `routing.maxTier`. In local mode the local model gets three review rounds, and a ticket it could not pass goes straight to `premium` (Opus) in the same `/build`, which finishes it from the local model's changes; that is the only step.
- **A check that cannot run, or a failed setup,** does not move it up.
- **A ticket you fixed by hand** is re-checked and reviewed, then committed with no model turn.
- **When nothing is left to try,** it stops with `MAX_ESCALATIONS` and says what to do.

**Output.** One line per ticket (model, time, cost, checks, review, commit) and a table at the end. `/status <ticket>` shows any ticket's full trail. When the build finishes, the session model is put back.

**Stop codes** in the result:

| Code | Meaning |
|---|---|
| `CHECKS_FAILED` | Checks failed after a retry |
| `REVIEW_FAILED` | The review failed it twice at that tier |
| `CHECKS_UNRUNNABLE` | A check or setup command could not run |
| `MAX_ESCALATIONS` | No tier left to try |
| `NO_CANDIDATE` | No usable model for the tier |
| `BUDGET` | The task or daily budget is spent |
| `DIRTY_TREE`, `WRONG_BRANCH` | Branch or working-tree problems |
| `BUILD_STOPPED` | Esc, or Pi could not open the session |

## /review

```text
/review
```

Reviews the branch against its base: the build's base for a task, else the default branch. With no task, it reviews the current branch, or only your uncommitted changes on the base branch. The changes it reads are the branch's commits plus staged, unstaged and untracked files; `.pi-workflows/` is left out.

Stages:

1. **`setup` and checks.** It runs `setup`, then `checks`, else the plan's ticket checks.
2. **Static scan** of the lines the diff adds: secrets, auth bypass, `eval(`, TODO/FIXME.
3. **Model pass.** `review.model` turns it on; it runs on `routing.reviewTier`.
4. **Advisors**, by the branch's highest ticket difficulty (`advisors.fromDifficulty`).

**The verdict.** `passed` comes only from the checks and the static scan; model findings advise.

**Where the report goes.** It is posted with a time and cost per stage, and saved under `.pi-workflows/reports/`. It is also stored on the task, but the phase does not change.

When there are findings, a picker offers:

| Choice | Effect |
|---|---|
| **Fix all** | Starts a turn in this session that fixes every numbered finding |
| **Fix…** | Starts a turn with your text, for example `1, 3` or your own instructions |
| **Close** | Does nothing |

It never commits or pushes. Run `/review` again after fixing.

## /status

```text
/status                    # state, next step, and tables
/status <ticket>           # one ticket's trail, for example /status 02 or /status 2
/status foundry            # also list your Azure deployments (runs az)
```

`/status` returns the task's state line and posts tables:

- **Overview:**
  - task, local mode, plan, branch and commits ahead;
  - review, next step, budget;
  - session model, rating, last route.
- **Tickets:** difficulty, implementer, review, cost, status. A ticket committed without checks or review shows as `unverified`.
- **Routing:** for each tier, what would run now and each skipped model with its reason.
- **Logins:** each provider's sign-in status.
- **Warnings:** config values that were ignored, models with no pricing row, a corrupt event log.

It makes no model call and runs no `az`.

`/status <ticket>` shows:

- difficulty, current tier and model, time, cost and commit;
- every attempt: tier, model, time, cost, and outcome with why it failed;
- every review: reviewer, verdict, findings and reasoning.

`/status foundry` adds a table of the deployments in `providers.foundry.resourceGroup`, and flags tier entries that have no deployment. It is the only place pi-chef runs `az` for diagnostics.

## /cost

```text
/cost                      # summary
/cost json                 # summary, quota use, and every ledger row as JSON
/cost csv                  # every ledger row as CSV
```

Reads `.pi-workflows/cost/` and shows:

- known spend, and the number of records whose cost is unknown;
- the task and daily budgets, with their status;
- spend by phase, provider and model, with success counts;
- subscription quota use (ranking only) and the last route.

Unknown cost is never shown as $0. Budgets count it at an estimate. Changes nothing.

## /route

```text
/route <request>
```

Previews, without changing anything:

- the tier, provider and model this request would get, and why (the reason and each candidate considered);
- who serves the session, compaction, batch jobs, the review, and each ticket difficulty.

It uses the keyword scan only; during `/plan` the planner rates complexity and risk itself. It records a `route` event when a task is active.

## /advisor

```text
/advisor <question>
```

Asks the advisor tier (`tiers.advisor`: Astra, then Fable in the sample) one question about the active task. It costs money, runs only when you ask, and never changes the phase. It refuses when no advisor is configured or the budget is exhausted, and obeys `orgProviderAllowlist` and `proprietaryCode`.

## /auth

```text
/auth status               # same as /auth with no argument
/auth login <provider>     # openai | anthropic | xai | foundry | vercel | local
```

`/auth status` prints each provider's sign-in status, method and detail. For Vercel it refreshes a missing or expiring token with `vercel env pull` first.

`/auth login <provider>` explains how to sign in:

- **openai, anthropic, xai:** Pi's `/login <provider>`, with an account and not an API key. A key is used only with `providers.<name>.apiKeyFallback: true`.
- **foundry:** `az login`.
- **vercel:** `vercel login && vercel link`.
- **local:** start your server.

pi-chef never asks for or stores a key.

## /chef

```text
/chef
```

Lists every command with its description.

## The status line

The one-line `chef` footer looks like:

```text
chef · <task> · [local ·] <state and next step> · [<model of the running ticket> ·] $<spent> of $<task budget>
```

- **Spend:** `+?` after the amount means some spend is unknown.
- **While `/plan` runs**, the planning stage replaces the state, for example `plan · interview round 2 (3/7 questions)`.
- **When it updates:** after every command, planning stage and route, and at each ticket's new session.
- **Cleared** when no task is open.

## The init command (pi-chef-init)

```bash
npx github:pkeenan87/pi-chef init [options]
```

What it does:

1. Runs `pi install` for this package.
2. Copies the sample config to `.pi-workflows/config.yaml`.
3. Creates `~/.pi/agent/chef.yaml` when you have no user config: every personal setting commented out with its default, ready to uncomment and edit. It never overwrites one you have.
4. Adds the workflow-state lines to `.gitignore`.

| Option | Meaning |
|---|---|
| `--source <spec>` | Pi package source: `git:host/path`, an https URL, `npm:name`, or a path. Default: this package's repository |
| `--ref <ref>` | Tag or commit to pin, appended as `@<ref>` to a git source |
| `--global` | Install for every project (`~/.pi/agent/settings.json`) instead of this project only |
| `--dir <path>` | Target project directory. Default: the current directory |
| `--force` | Overwrite an existing `.pi-workflows/config.yaml` (never `~/.pi/agent/chef.yaml`) |
| `--no-install` | Skip `pi install`; only write the config and `.gitignore` |
| `--dry-run` | Print what would happen and change nothing, for both files |
| `-h`, `--help` | Show the options |

If `pi` is missing or `pi install` fails, it still writes the config, prints the install command, and exits 1. More install methods are in [install.md](install.md).

## Pi commands you use with pi-chef

These are Pi's own commands, not pi-chef's:

- `/login <provider>` signs in an account provider; pi-chef reads that login.
- `/model` picks a model by hand; with `session.pin: false` pi-chef leaves your pick alone.
- Esc stops a running turn, including a `/build` ticket.

## Tools the models call

You do not type these; the planner and the ticket sessions call them. They are listed so the trail in your chat makes sense.

| Tool | Used by | What it does |
|---|---|---|
| `plan_questions` | the planner, during `/plan` | Asks you one round of interview questions with a recommended option each |
| `plan_spec` | the planner | Saves the technical spec and the planner's rating of the task |
| `plan_consult` | the planner | Puts the draft tickets and 2-3 questions to the advisors (`advisors.plan`) |
| `plan_tickets` | the planner | Validates and saves the tickets, then shows you the plan for approval |
| `web_search` | any session | Searches the web through Claude Haiku on your Anthropic account login; ledgered as `web_search`; refused on a hard budget |
| `web_fetch` | any session | Fetches a public http(s) page as markdown, locally; private and loopback addresses are refused |
