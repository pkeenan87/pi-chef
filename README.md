# pi-chef

A Pi extension that plans, builds and reviews coding work with the right model for each job: `/plan` → `/build` → `/review`. A deterministic policy picks the provider, the budget, and the next phase. Models only advise. State stays in the workspace under `.pi-workflows/`. There is no hosted coordinator and no database.

Routing is by role. Opus leads the session and writes the plan. Each ticket is built in its own fresh session on a model chosen by the ticket's difficulty: grok for low, Sonnet for medium, Sol for high. Astra and Fable advise on the plan and the review. Cost-awareness stays a feature: spend is tracked per phase, provider and model against budgets, and the selector ranks models by cost per success. You plan and approve once, and `/review` checks the result and fixes what it finds. You push and open the pull request yourself. OpenAI and Anthropic are used through Pi account login in the same session. Azure AI Foundry uses the Azure CLI. Vercel AI Gateway uses the Vercel CLI. A local OpenAI-compatible server is optional.

This page covers installing and the daily workflow. Configuration, provider sign-in and the source layout are in [docs/](#documentation).

## Supported Pi version

| Package | Version this repo was checked against |
|---|---|
| `@earendil-works/pi-coding-agent` | 1.2.0 (published 2026-10-12, `earendil-works/pi`) |
| `@earendil-works/pi-ai` | 1.2.0 |

`@mariozechner/pi-coding-agent` stopped at 0.73.1. Docs that import that name, or that describe `Extension.init()`, do not match 1.2.0. See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the hooks this extension actually calls.

Pi 1.2.0 declares `node >= 22.19.0`. This package typechecks on Node 20 and the tests here ran on Node 22.14. Install Pi's packages with `--ignore-scripts` on older 22.x if `photon-node` refuses to build; that native extra is not used by this extension.

## Install

This repo is a Pi package. `package.json` has the `pi-package` keyword and:

```json
"pi": { "extensions": ["./src/extension.ts"], "skills": ["./skills"] }
```

Host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`) are optional peers. Pi provides them. They are not bundled here.

### One-command setup

From the project directory:

```bash
npx github:pkeenan87/pi-chef init
```

`init` (the `pi-chef-init` bin) does three things:

1. Runs `pi install -l git:github.com/pkeenan87/pi-chef`. The source comes from `repository` in `package.json`.
2. Copies the sample config to `.pi-workflows/config.yaml`. It keeps an existing file unless you pass `--force`.
3. Adds any missing workflow-state lines to `.gitignore`. Lines already there are not added twice.

If `pi` is missing or `pi install` fails, it still writes the config, prints the install command to run yourself, and exits 1.

Variations:

```bash
# Pin a tag: once for the script npx fetches, once for what Pi installs
npx github:pkeenan87/pi-chef#v0.1.0 init --ref v0.1.0

# Over SSH
npx git+ssh://git@github.com/pkeenan87/pi-chef.git init

# From a fork (--source, or Pi still installs from pkeenan87/pi-chef)
npx github:<owner>/pi-chef init --source git:github.com/<owner>/pi-chef

# From a local checkout (no network)
node ~/src/pi-chef/bin/init.mjs --source ~/src/pi-chef

# After an npm publish
npx pi-chef init --source npm:pi-chef

# Personal install for every project, instead of this project only
npx github:pkeenan87/pi-chef init --global

# Only write the config and .gitignore; skip pi install
npx github:pkeenan87/pi-chef init --no-install

# Show what would change
npx github:pkeenan87/pi-chef init --dry-run
```

Other flags: `--dir <path>` targets another project directory, and `--help` lists them all. npm's `github:` shorthand only works for GitHub, GitLab, and Bitbucket. Other hosts need the full `git+https://` or `git+ssh://` URL. `npx` and `pi install` both run `git clone`, so a private fork needs git credentials on the machine.

Other ways to install (scope, other git hosts, a local checkout, npm, a one-off run) and the repo layout are in [docs/install.md](docs/install.md).

### Add the project config

`pi install` does not create workflow config. Copy the sample from a checkout into the target project:

```bash
mkdir -p .pi-workflows
cp ~/src/pi-chef/.pi-workflows/config.yaml .pi-workflows/config.yaml
```

Then add these lines to the project's `.gitignore`:

```gitignore
.pi-workflows/tasks/
.pi-workflows/cost/
.pi-workflows/metrics/
.pi-workflows/reports/
.pi-workflows/notifications.jsonl
.pi-workflows/active-task.json
.pi-workflows/*.local.yaml
```

A user-level file at `~/.pi/agent/chef.yaml` (or `chef.yml`) is the base, and the project file `.pi-workflows/config.yaml` (or `config.yml`) layers on top of it. If both extensions exist the `.yaml` file is used and a warning names the `.yml` file that was ignored. The legacy `~/.pi/agent/cost-workflow.yaml` (or `.yml`) is still read when it is the only user file. Keep machine-specific values (endpoints, base URLs, env-var names) in the user file, not the committed project file. The YAML must not contain secrets, API keys, or tokens. `approvals.merge` stays `manual` and a config that sets it otherwise is rejected. Plan approval stays required. Set `checks:` before you expect `/review` to pass (see [Sample workflow](#sample-workflow)).

Task files, the cost ledger, metrics, and reports are gitignored. The config file is not.

### Verify, update, remove

```bash
pi list
pi update git:github.com/pkeenan87/pi-chef
pi update --extensions
pi remove -l git:github.com/pkeenan87/pi-chef
```

`pi update` without a target updates Pi itself, not this package. Inside Pi, `/chef` lists the commands and `/auth status` checks logins. `-a` / `--approve` trusts project-local files for one command.

## Sample workflow

Configure at least one check before you expect `/review` to pass. The sample config ships `checks: []` on purpose: a review with no tool evidence cannot claim a pass. With `checks: []`, `/review` falls back to the distinct `checks` of the plan's tickets (validated at plan time); with neither, it fails and says so ("no checks ran, so there is no evidence of a test pass") rather than reporting zero findings.

```yaml
setup:
  - name: install
    command: npm
    args: ["ci"]
checks:
  - name: unit
    command: npm
    args: ["test"]
```

Any command runs except destructive ones (`rm -rf`, force push, `reset --hard`, piping a download into a shell), which are refused. There is no allowlist. Each check is one command and its arguments, run without a shell: `&&`, pipes, redirects, quotes, `$VARS` and globs do not work, so use two entries instead of `a && b`.

```text
/plan Harden the ingest parser: reject empty events. AC: empty input throws
/build
/review
# then push and open the PR yourself:
git push -u origin HEAD
origin pr create   # or: gh pr create
```

Three commands. `/show-plan` re-reads the plan, and approves a draft you saved earlier. `/plans` lists your tasks and switches between them.

### /plan

`/plan <request>` runs in your normal Pi session on the session model (Opus by default), with read-only tools (read, grep, find, ls, read-only bash, `web_search`, `web_fetch`) plus the plan tools (`plan_questions`, `plan_spec`, `plan_consult`, `plan_tickets`). It edits nothing. Every `/plan <request>` starts a new task (see Tasks and /plans below). If the active task is finished (every ticket built and its review passed, or an old file in `PUBLISHED`, `AUTOPILOT`, or `MERGE_READY`), it is closed first with a `Closed <name>.` chat line. An unfinished task is parked, untouched: `Parked <name> (<state>). /plans <name> switches back.` To change the plan you already have, use Request changes in the review picker or in `/show-plan`.

1. **Interview.** The model looks up facts itself and asks you only decisions, through `plan_questions`, in rounds. A round holds every question whose prerequisites are settled (`dependsOn` answered); dependent questions wait for the next round. There are 3 to 7 questions in total (fewer for small tasks), and the tool rejects a round that would pass 7. Each question has 2 to 4 options, one marked `★ Recommended — <reason>` and preselected, and an `Other (type answer)` choice. Press `a` to accept every recommendation in the round. With no UI the recommendations are recorded as the answers. Answers go to `.pi-workflows/tasks/<id>/interview.json` with one `decision` event each, and the interview resumes after a restart (run `/plan` with no request, or with the same request again). The status line reads `chef · <task> · plan · interview round N (k/7 questions) · $spent of $budget`.
2. **Spec.** The model reads the code that will change, then saves `spec.md` with `plan_spec`: a technical implementation plan (summary, current context, approach with types and signatures, every file to change and how, what to reuse, decisions, assumptions, out of scope, risks, and verification steps) and rates the task (`complexity`, `risk`, `securitySensitive`, `classificationReason`; see [Classification](docs/configuration.md#classification)). Code rejects a spec without an approach, file changes, or verification.
3. **Tickets.** The model submits vertical, independently testable slices with `plan_tickets`. Code validates unique ids, existing blockers, no cycles, at least one acceptance criterion, and that each ticket fits `workers.ticketContextTokens` (the larger of the model's estimate and a code estimate of chars/4 plus listed file sizes plus 20K overhead). An oversize ticket is sent back to be split. A ticket's `checks` are command lines, one command per entry with plain arguments, never prose. `plan_tickets` rejects a check the deny rules would refuse, one with shell syntax (`&&`, `|`, `;`, redirects, quotes, `$`, globs; checks run without a shell), and one whose first word is not a command on `PATH`, so the planner rewrites it. Each ticket carries technical `implementation` steps beside its behavior and acceptance criteria. Before submitting, the model drafts the tickets and calls `plan_consult` (next step).
4. **Advisor consult.** `plan_consult` takes the draft `tickets` (same schema as `plan_tickets`, validated the same way) and 2-3 specific `questions` about the riskiest parts. It puts them to every available advisor, one per provider (Astra and Fable in the sample config), in parallel. Each advisor sees the saved spec (clipped), the draft tickets rendered compactly and the questions, never the session transcript, and answers with a verdict, answers and concerns. The answers are stored on the task (`planning.consult`) and returned to the model, which must resolve any disagreement itself and then call `plan_tickets` with the final tickets and `advisorResolution`: what it accepted, what it rejected, and why. The consult stores a sha256 of the spec and the canonical draft tickets. A second call with the same hash returns the stored answers with no model calls; one with changed tickets runs a new, deliberately paid consult, at most `advisors.maxPlanConsults` (default 2) per plan version, after which the latest stored answers are returned with a note. Parallel calls pay once. `plan_tickets` refuses tickets whose hash differs from the consult's ("The tickets changed since plan_consult; call plan_consult again...") unless the model sets `reconsultWaived: true` and says in `advisorResolution` why the change needs no new advice; the waiver is recorded on the plan and shown in the Advisor review section. A revision after **Request changes** is a new draft that may consult again. When advisors are available (`advisors.plan`, default true), `plan_tickets` refuses with "Call plan_consult first" until a consult exists and requires a non-empty `advisorResolution`; with no advisor available, or when the budget skipped them, it requires neither and the plan notes that. Advisors advise and never gate; the plan is still yours to approve.
5. **Review.** `plan_tickets` saves the draft and the model ends its turn with a one-line summary. When that turn settles, the full plan (spec and every ticket) is posted in the chat as markdown, with no popup, and then a compact picker asks what to do. An aborted turn (Esc) skips this; `/show-plan` offers the draft later. The Tickets section opens with a summary table (`#`, `Ticket`, `Difficulty`, `Implementer`, `Advisors`, `Blocked by`): the implementer is the first model of the ticket's difficulty tier and the advisors are those the per-ticket review will consult (none for low, one other-provider advisor for medium, both for high). Each ticket heading carries its difficulty (`### 01 · medium · Title`), and the `plan_tickets` result the model summarizes from includes the same table. The picker offers **Approve plan**, **Request changes** (typed feedback goes back to the model, which starts the revision turn), **Edit tickets** (the edited plan is posted again and the picker returns), or **Save as draft**. Esc also saves a draft. The plan opens with an **Advisor review** section: each advisor's verdict and concerns (labelled by model), any errors, then `Opus resolution: ...`. Approving freezes `plan.vN.approved.json` (write-once). The plan is posted once, before the picker, and written to `tasks/<id>/plan.md`, and each ticket to `tasks/<id>/tickets/NN-slug.md`. A material scope change needs a new approval.

`/show-plan` prints the plan of the active task under a header with its name and state line. For a draft it opens the same review (Approve plan, Request changes, Close), so you can approve later.

`/plan --no-questions <request>` skips the interview: the model records the choices it would have recommended as assumptions in the spec. A request that contains a literal ```` ```tasks ```` block is drafted directly (`plan.md`, `plan.json`, no model turn). Such a plan has no tickets, so `/build` asks you to run `/plan` again.

### Tasks and /plans

One request is one task. A task has a short readable **name** made from the request (`retry-ingest-parser`: lowercase, the first few meaningful words, at most 32 characters, `-2`, `-3` when taken), its plan, tickets, build branch, spend and review. The directory under `.pi-workflows/tasks/` keeps the long id, so tasks from older versions work unchanged; one without a name shows a name derived from its request, or its id. `/status` shows `name (id)`.

- **`/plan <request>` never revises another task.** It makes a new one and makes it active. A finished active task is closed; an unfinished one is parked as it is (phase, tickets and branch untouched) and `/plans <name>` brings it back.
- **The active task follows the branch.** If the branch you have checked out is the build branch of an open task, that task is active, whatever you used last. Otherwise (the default branch, a branch no task owns, a detached HEAD) the last task you created or switched to is active (`.pi-workflows/active-task.json`). Only a branch *change* moves it: `active-task.json` remembers the branch seen at the last command, so starting a task with `/plan` or picking one with `/plans <name>` keeps it active even while you sit on another task's branch, until you check out a different branch. The branch is read once per command, and usage is ledgered to the stored task without asking git.
- **`/plans`** lists open tasks, newest first, with the active one marked `●` (name, state line, tickets done/total, branch, updated). `/plans --all` adds closed ones.
- **`/plans <name>`** (a name, an id, or a unique prefix) makes that task active, checks out its build branch when the working tree is clean (otherwise it says the branch was not changed and that `/build` needs a clean tree), and posts its plan; a draft gets the approve picker.
- **`/plans close <name>`** closes a task: it moves to `COMPLETE` with `closedAt` and `closedReason: closed by user`. It asks first if tickets are unbuilt or the build has not passed review. Files and branches are kept and git is never touched. If it was the active task, the most recently updated unfinished task becomes active, or none.
- **`/build`** on a task whose branch exists but is not checked out switches to it when the tree is clean, and says so; with uncommitted changes it stops and names the branch.

### /build

`/build` runs the approved tickets one at a time. It refuses a plan that is not approved, a plan with no tickets, a budget that is already spent, and (for a security-sensitive plan) asks you to confirm first. It does not run in the background: it holds the Pi command until it finishes or stops.

**Branch.** On the default branch (`origin/HEAD`, else `main` or `master`) it creates `<branchPrefix>/<task name>` (the task id for a task from an older version) and switches to it. On any other branch it builds there. The branch, base, and base SHA are recorded in the task. A fresh build with uncommitted changes (outside `.pi-workflows/`) lists them and asks whether to commit them first as a separate "Changes before /build" commit on the build branch, so they do not land in ticket 01's commit. Answer no (or run without a UI) and it refuses with `DIRTY_TREE`. Commits are authored with your git identity; `pi-chef <pi-chef@localhost>` is used only when git has no name or email configured. Running `/build` from a different branch than the recorded one switches to the recorded branch when the tree is clean, and refuses (naming the branch) when it is not.

**Per ticket**, in dependency order (`blockedBy`):

1. **Route.** The ticket is routed with purpose `implement` to the tier of its `difficulty` (`low` to `ticketLow`, `medium` to `ticketMedium`, `high` to `ticketHigh`). The planner sets `difficulty` on each ticket: low is mechanical or small and well specified, medium is typical feature work, high is cross-cutting, tricky logic, concurrency, or a large blast radius, and includes anything that touches auth, secrets, untrusted input, or egress. An old plan with only `suggestedTier` maps deterministic and cheap to low, standard to medium, premium to high, and none to medium; `difficulty` wins when both are present. The difficulty alone picks the implementer: a security-sensitive plan does not raise a ticket above its own tier (the planner is told to rate security-heavy tickets high). Security still asks you to confirm before `/build` and keeps `/review` and the per-ticket review on Opus. After a failure the ticket moves one step up the ladder `ticketLow`, `ticketMedium`, `ticketHigh`, `premium`. The selector picks the model within the tier, and a tier with no usable model, an open circuit, or a provider that is not signed in moves up the same ladder. A `route` event is logged with the choice and why, and the status line shows the ticket and its model while it runs.
2. **Fresh session.** `/build` opens a new Pi session on that model, so each ticket starts with an empty context. The first message holds the chunk rules (one ticket only, no commit, push, or branch switch), the ticket (what to build, implementation steps, acceptance criteria), the spec with its decisions, the final summaries of the tickets it is blocked by, and the repo's `AGENTS.md`. The model works in your checkout with Pi's normal tools. While a ticket runs, a `git push` and a branch switch are blocked.
3. **Checks.** When the model stops, `setup` runs once per build, then the ticket's `checks` (else `config.checks`), in the repo root. A failure sends the output tail back to the same session for one retry turn. If it fails again the ticket is `failed`.
4. **Review.** Once the checks pass and before the commit, the review tier (`routing.reviewTier`, Opus) reads the ticket (title, what to build, implementation, acceptance criteria) and the ticket's own diff (working tree against `HEAD`, new files included; redacted, lockfiles reduced to one line, cut to `advisors.maxDiffChars` with a note naming what was cut) and answers `pass` or `fail` with findings. For medium and high tickets it also writes 2-3 questions, and advisors answer them in parallel, each seeing only the ticket, the same diff and those questions, never the session. Low tickets have no advisors; a medium ticket gets one advisor from a provider other than the implementer's (Sonnet gets Astra, Sol gets Fable); a high ticket gets every advisor, one per provider. Each advisor is capped at about 1,500 visible tokens (`advisors.maxOutputTokens`; the request also leaves 2,048 tokens of room for reasoning models) and `advisors.timeoutMs`. Advisors are skipped when the budget is soft or exhausted. When any advisor answered, a second Opus call weighs their answers and concerns against the diff and gives the final verdict with a rationale, which is stored. **Only Opus's final verdict counts.** Advisors never gate on their own, and a failed advisor is recorded as an error while the others still count.
   - **Pass** commits. **First fail** sends Opus's findings and rationale to the same session ("fix these; do not commit; the checks and the review run again"). The check retry and the review retry are counted separately. **Second fail** at that tier fails the ticket, strikes the implementer's record, and stops the build; the next `/build` escalates one tier.
   - A review call that errors or times out, after one retry on the next review candidate, is recorded as `unavailable`. The ticket is **committed with a warning** (a chat line, and a note under the final table), because infrastructure must not block work.
   - Every review is stored on the ticket's run (`ticketRuns[id].reviews`: attempt, tier, implementer, verdict, findings, each advisor's verdict and concerns, rationale, cost). `advisors.tickets: false` turns all of it off.
5. **Commit.** On a pass, the whole tree is committed as `<id>: <title>`, the ticket file's `## Status:` becomes `done`, criteria are ticked from the model's closing checklist (best effort), and the model's success is recorded. `/build` then moves on to the next ticket by itself. A ticket with no checks anywhere is committed with a warning that nothing verified it.
6. **Trail.** The chat gets a line per ticket (difficulty, implementer, time, cost split into implementer, review and advisors, checks, review such as `pass (2nd) · Astra`, commit) and a table at the end. Spend is ledgered as it happens, with the ticket id in the reason (`ticket review ticket 01`, `ticket review resolve ticket 01`, `advisor ticket review ticket 01`, and the implementer's turns), so `/cost` can show it per ticket. When a ticket finishes, done or failed, one line is appended to `.pi-workflows/metrics/tickets.jsonl` (difficulty, the implementers tried, review counts, advisors that answered, the final verdict and rationale, the cost split with `null` where unknown, elapsed time). The file is append-only. `/status` shows each ticket's difficulty, implementer and review outcome.

A check that cannot run (no such command, a denied command, or a failing `setup`) stops the ticket as `failed` with the reason. It does not count against the model, because a stronger model cannot fix a plan.

**Esc** during a ticket stops the build after that turn. Nothing is checked or committed, and the ticket stays in progress. When the last ticket is done, the session model is put back (`session.model` when pinned, else the model you were on) and `/build` points you at `/review`.

**Resume.** Run `/build` again at any time. Done tickets are skipped. A `failed` ticket with changes in the tree has its checks re-run first: if you fixed it by hand in the chat and they pass, the same per-ticket review runs on the change (with no implementer, so no model is credited or struck), and it is committed without a model turn only if that review passes. A hand fix the review fails stays `failed`, and the next model attempt, one tier up, gets the findings. A ticket you aborted (an `in-progress` ticket) resumes on the tier it was on: it never escalates or restarts at its difficulty tier, and `routing.maxEscalations` and the review's two rounds are counted per tier, so aborting and resuming cannot buy more of either. A ticket whose review failed is not committed this way: it goes one tier up. A ticket stopped because a check could not run or setup failed stays on its tier once you fix the plan. Otherwise it goes to a model again, one tier up, until `routing.maxEscalations` is used up or it has failed on premium. A hard budget starts no new ticket and says so.

### /review

`/review` reviews what differs from the base branch, lists the findings, and offers to fix them in the current session. It never commits, pushes, switches branches, or opens a pull request: you do that with git and the `origin` CLI (or `gh`). It works after `/build`, after ad-hoc fixes made in the chat, with uncommitted edits, and with no task at all (the report goes under `.pi-workflows/reports/` and spend under task `session`).

- **Base and diff.** The base is the build's recorded base, else the default branch. The diff is the commits ahead of the merge-base plus uncommitted and untracked changes. On the base branch itself it is the uncommitted changes plus any commits ahead of `origin/<base>` (just the uncommitted changes when that ref does not exist). With nothing changed it says "Nothing to review" and stops.
- **Review**, in the repo root: `setup`, then the checks (`config.checks`, else the plan's ticket checks), then a static scan (secrets, auth bypass, `eval`, TODO/FIXME) of the lines the diff adds (removing an `eval(` does not block; the scan reads the raw diff and the report stores it redacted), then an advisory model pass.
- **Verdict.** `passed` is true only when at least one check ran, every check exited 0, and the scan found nothing blocking. The model pass (the review-tier model, same choice `/route` shows for review) reads the plan and the diff and returns findings for a person to judge. Lockfiles are sent as one placeholder line each, and text redacted for secrets shows as `[REDACTED]`. A diff over `review.maxDiffChars` (120,000) is split at file boundaries into up to `review.maxChunks` (6) calls, each stopping at `review.timeoutMs` (5 minutes). A part whose call fails (a dropped stream, a transport error, a timeout, or an answer that is not a JSON list of findings) is retried once on the next review-tier candidate, another provider first, and the pass goes on with the remaining parts; the report says which model reviewed each part and lists any part that still failed. Every call is ledgered with reason `model review` and counted against its own model's metrics; a failed call's cost is unknown, so the pass's cost is too. The pass is budget-gated before each call and never changes `passed`. `review.model: false` turns the pass off.
- **Advisors.** The branch's plan decides who is consulted (`advisors` in the config table). If any ticket has difficulty `high`: both advisors. Otherwise, if the highest is `medium`: one advisor from a different vendor than the reviewer (Opus is Anthropic, so Astra). With only `low` tickets: none. With no plan (an ad-hoc branch): Astra when the diff has more than `advisors.adHocMinLines` changed lines (default 400, lockfiles not counted), else none. When advisors will be consulted the Opus pass also returns 2-3 questions (for a diff in several parts, the questions of the parts, at most 3). Each advisor gets Opus's findings, the changed files with `+/-` stats, the diff clipped to `advisors.maxDiffChars` (lockfiles omitted, redacted, a note saying what was cut; with `advisors.summarizeCut` the batch tier writes one line per cut file from its hunks, clipped to about 2K characters, ledgered as `batch summary`, skipped on a soft budget) and the questions, never the session. One Opus resolve call then returns the final findings, each `accepted` or `rejected` with a short rationale, who raised it (`source`) and who agrees (`agreedBy`). All of it is stored in the report (`modelReview.advisors`, `modelReview.resolution`). Advisors advise and Opus resolves; `passed` still comes from the checks and the static findings only. If the resolve call fails, Opus's findings are shown with the advisor concerns as unresolved.
- **Chat trail.** A line per stage with elapsed time, then one block (also saved as `reports/review.md` under the task), laid out as tables like the `/build` report: a header with the verdict, time and cost, a stage table (setup, checks, static scan, model review, advisors, each with its time and cost), a table of the checks with the output tail of each failed one below it, a table of the findings, the plan's tickets when the branch has a plan, and what to do next. A cost the ledger could not price shows as `unknown` (the header total then reads `≥ $x (some unknown)`), never as $0. A check that failed for want of a tool gets a hint to list the install under `setup:`. The report is stored as `state.review`; the phase does not change. Long finding text is clipped in the table; the saved JSON has all of it.

```
## Review passed · 2m48s · $0.19

| Stage | Result | Time | Cost |
| --- | --- | --- | --- |
| Setup | 1 step ok | 12.0s | — |
| Checks | 2 of 2 passed | 2.5s | — |
| Static scan | 0 blocking, 0 suggestions | — | — |
| Model review | anthropic/claude-opus-5-5 · 2 parts · 3 findings | 1m10s | $0.14 |
| Advisors | openai/gpt-6-astra, anthropic/claude-fable-5-1 (branch has a high ticket) | 40.0s | $0.05 |

### Findings
| # | Severity | Where | Finding | Raised by | Decision |
| --- | --- | --- | --- | --- | --- |
| 1 | HIGH | package.json | tsx is not in devDependencies | Opus | kept · Astra agrees |
| 2 | MEDIUM | tests/evidence.test.ts | SSRF tests cover 127.0.0.1 only | Fable | kept (Fable's finding) |
| – | LOW | tsconfig.json | tests/ not type-checked | Astra | dropped: tests run under tsx |

Decision = the reviewer's call after the advisors; dropped findings are not sent by Fix all.
```

- **Live progress line.** While `/review` works, one line above the editor shows what is running and for how long, for example `⠹ Review · model review part 2/3 · anthropic/claude-opus-5-5 · 1m12s` (Pi's own spinner only shows while a model streams). It follows setup, each check, the static scan, each model-review part and retry, the advisors, the resolve step and the cut-file summaries, and goes away when the report is posted. `/build` shows the same line between a ticket's turns (`Build · ticket 02 · checks`, `· Opus review`, `· advisors · Astra`, `· resolving`, `· committing`) and hides it while the ticket's own session streams. Without a UI there is no line.
- **Findings and fixes.** With a UI and at least one finding, the report above carries the Findings table, and a compact picker titled `Review · N finding(s)` follows it (the report is not posted twice). The table numbers are the ones Fix all uses: static blocking findings, failed checks (Where is the command), static suggestions, then the model findings. The accepted model findings are the numbered ones, with who raised each and the reviewer's call in the Decision column (`kept · Astra agrees`, `kept`, `kept (Astra's finding)`). Findings Opus rejected, and advisor concerns it could not weigh, are rows numbered `–` (`dropped: <reason>`); **Fix…** can still refer to them by text. Choose **Fix all** to send the numbered findings to the model in this session, **Fix…** to type which to fix (numbers like `1, 3` and/or your own instructions; the full list, rejected findings included, goes along for reference), or **Close**. The message tells the model to keep changes scoped, run the checks, not commit, push, or switch branches, and report one line per finding. Run `/review` again when it is done. With no UI you get the report only. With no findings and a pass, there is no picker.

### Other commands

`/route <task>` previews tier, provider, and expected cost, plus who serves the session, compaction, batch jobs, review and each ticket difficulty, and writes nothing. `/status` shows the same routing summary as tables; see below. `/cost`, `/cost json`, and `/cost csv` show the ledger.

**The status line.** One persistent footer line, `chef`, always shows where you are: `chef · <task> · <state and next step> · <model of the running ticket> · $spent of $budget` (`+?` when some spend is unknown), for example `chef · retry-counter · Building · ticket 02 of 4 · anthropic/claude-sonnet-5-5 · $1.24 of $10`. While `/plan` runs it shows the interview stage instead. It is redrawn after every command, every planning stage, and each ticket's new session, and is cleared when no task is open.

**`/status <ticket>`** (for example `/status 02`) shows one ticket's trail: difficulty, current tier and model, time, cost, commit, every attempt (tier, model, time, cost, outcome and why it failed) and every review (reviewer, verdict, findings, reasoning). A stopped build's state line points at it.

A ticket committed without its checks (none configured) or without its review (unavailable) shows `unverified <sha> (no checks)` instead of `done` in the tables.

**`/status`** posts a chat block of tables and returns only the state line, so nothing is clipped. It is cheap: no model call, no `az` (except `/status foundry`), and git only for HEAD and the commits-ahead count. The heading is the **state line**, derived from the plan, tickets and review rather than the raw phase (which stays in the Task row):

```
## Status · Reviewed · passed 14:32 · push and open the PR (a new /plan closes this task)

| | |
| --- | --- |
| Task | retry-ingest-parser (task-20261014-ab12) |
| Plan | v2 approved 12:25 |
| Branch | chef/retry-ingest-parser (base main) · 3 commits ahead |
| Review | passed 14:32 · 2 kept, 1 dropped |
| Next | push and open the PR (a new /plan closes this task) |
| Budget | task $1.92 / $20 · daily $3.10 / $75 · ok |
| Session model | anthropic/claude-opus-5-5 (pinned) |

### Tickets
| # | Ticket | Difficulty | Implementer | Review | Cost | Status |
...
### Routing
| Tier | Runs | Skipped |
...
### Logins
| Provider | Status | Detail |
...
```

The states: `No active task`, `Planning · interview` or `writing tickets`, `Draft v3 · waiting for approval`, `Approved v2 · run /build`, `Building · ticket 02 of 5`, `Stopped · ticket 02: <reason> · /build resumes (/status 02 shows its attempts)`, `Built · 5 of 5 tickets done · run /review`, `Reviewed · passed HH:MM` or `Reviewed · N finding(s) to fix`, `Complete`, and the reason for a blocked or paused task. A review made before a later commit gets ` · review is out of date (commits since) · /review again` (the review records the git HEAD it ran at; an older review without one is never flagged). Tasks from the removed publish flow show `Published (older task)`. When other unfinished tasks exist, a line under the overview says `Also open: <n> task(s) — /plans`. A `Warnings` section appears only when there is something to say (config warnings, corrupt event lines, models with no pricing row). Without a chat UI the command returns the whole markdown.

## Recovery

Task state is `state.json` plus an append-only `events.jsonl`. On startup the store rebuilds from the log if the snapshot is missing or torn, then rewrites the snapshot. Writes go through a temp file and rename, under a lock file. Nothing here deletes `plan.md`, the approved snapshot, or reports.

- **Esc during `/build`.** The build stops after the current turn. The ticket stays in progress and nothing is committed. Run `/build` to continue.
- **A failed ticket.** `/build` stops and says why. Fix it in the chat (the working tree keeps the failed attempt), then run `/build`: the checks run again, and if they pass your fix is committed and the build goes on. If you change nothing, the ticket goes to a model one step up the ticket ladder. A new plan version keeps the runs of tickets whose text is unchanged and builds the rest again.
- **A failed `/review`.** Choose Fix all (or Fix…) in the picker under the report, or fix by hand, then run `/review` again. `/review` commits and pushes nothing.
- **A crash or closed Pi.** Commits already made stay on the branch. `/build` resumes from the first ticket that is not done. It switches to the recorded branch if the tree is clean, and says so; with uncommitted changes it stops and names the branch.
- **An expired login** pauses the task. Rate-limit and outage errors from the Foundry and local clients surface as provider errors and do not rewrite policy.
- **The wrong task is active.** `/plans` shows which one is (`●`) and `/plans <name>` switches. The checked-out branch wins when it is an open task's build branch. If `active-task.json` is lost or points at nothing, `/plans <name>` repairs it; the tasks themselves are never in it.
- **A task you no longer want.** `/plans close <name>` closes it and keeps its files and branch; delete the branch yourself with git if you want it gone.
- **Old task files** that still have worktree, integration, or autopilot fields, or a retired phase, still load; those fields are ignored.

## Commands

| Command | Effect |
|---|---|
| `/plan [--no-questions] <request>` | Interview (3-7 decisions with recommendations), spec, tickets, then a review screen to approve, change, edit, or save as a draft. No edits |
| `/show-plan` | Show the active task's full plan under its name and state. A draft opens the review so you can approve it |
| `/plans [--all]`, `/plans <name>`, `/plans close <name>` | List tasks (the active one marked), switch to one (checks out its branch when clean, shows its plan), or close one (files and branches kept). `/plan` always starts a new task and parks an unfinished one |
| `/build` | Approved plan only. Each ticket in a fresh session on a routed model, then checks, then an Opus review (with advisors for medium and high tickets), then a commit, on one branch. Run again to resume |
| `/review` | Review the changes against the base branch (setup, checks, static scan, advisory model pass, advisors by ticket difficulty), list the findings, and offer to fix them in this session. Never commits or pushes |
| `/route <task>` | Preview routing |
| `/advisor <question>` | One question to the advisor tier. Costs money, never changes the phase |
| `/cost [json\|csv]` | Ledger versus budgets |
| `/status [foundry \| <ticket>]` | The task's state and next step, then tables for the plan, branch, review, budget, tickets, routing per tier (what runs and each skipped model with its reason), and logins. `/status foundry` also runs `az cognitiveservices account deployment list` (only when you ask) and tabulates the deployments, flagging tier entries that have none. `/status <ticket>` shows one ticket's attempts and reviews |
| `/auth status` and `/auth login <provider>` | Credential metadata, or how to sign in |
| `/chef` | List the commands |

`help` or `--help` on a command prints its description. Tab completion uses Pi's `getArgumentCompletions` for `/auth`, `/cost`, `/plan`, `/plans` (task names and `close`, `--all`), and `/status`.

Phases: `IDLE → PLANNING → AWAITING_PLAN_APPROVAL → IMPLEMENTING → COMPLETE` (a new `/plan` closes a task whose build passed review and parks any other; `/plans close` closes any task). `/review` does not change the phase. `PUBLISHED` is no longer entered; a task loaded from an old file in it can still be built on (`/build` returns it to `IMPLEMENTING`) or closed. Active phases can enter `BLOCKED`, `PAUSED`, or `FAILED`. A draft never becomes a build on its own. The retired phases `REVIEWING`, `PUBLISHED`, `AWAITING_PUBLISH_APPROVAL`, `AUTOPILOT`, and `MERGE_READY` stay in the enum only so old task files load.

## Documentation

| Doc | What is in it |
|---|---|
| [docs/configuration.md](docs/configuration.md) | Config files and layering, what a project config can and cannot change, every key, the tiers and who serves them, routing and model selection, budgets and cost |
| [docs/providers.md](docs/providers.md) | Account login (OpenAI, Anthropic, xAI) and the API-key fallback, Azure AI Foundry, Vercel AI Gateway, local inference, and the web tools |
| [docs/install.md](docs/install.md) | Every install method (scope, GitHub, other git hosts, a local checkout, npm, a one-off run) and the source layout for working on this repo |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | The Pi hooks and APIs this extension calls, and which are unverified against a live Pi |
| [AGENTS.md](AGENTS.md) | Rules for agents (and people) changing this repo |

## Limitations

- No paid provider call is made by the tests. OpenAI and Anthropic transports throw unless a test injects one. Account login is verified by reading Pi 1.2.0's provider objects, not by completing a prompt.
- The `/build` loop (a fresh Pi session per ticket, the model set through `session_start`, waiting for each run to finish, Esc while the command waits) is tested with fakes only. It has not been run against a live Pi. If it deadlocks there, the fallback is one ticket per `/build`.
- `/build` runs the model in your checkout with Pi's normal tools, not in a sandbox or worktree. The `git push` and branch-switch block during a ticket is a hook on Pi's `bash` tool. It follows wrappers (`timeout`, `env -S`, `xargs`), `sh -c`, `eval`, `find -exec` and inline `git -c alias.*`, but a script file or command substitution can still hide a command from it, so review the diff. Tickets run one at a time, never in parallel.
- Pi's `/login` still offers an API-key prompt. This extension treats that credential as blocked unless the user config sets `apiKeyFallback` for that provider.
- Interactive Pi bash is denied for destructive commands (`rm -rf`, force push, piping a download into a shell, and similar). Other commands are not restricted, because that would break the host agent. Checks and setup run any non-destructive command. While `/plan` runs, bash is limited to a read-only allowlist: listing and reading commands on paths inside the project, with no redirects, chaining, `$` expansion (including `$'..'`), brace expansion, or globs outside the project, and only the listing forms of `git branch` and `git remote`.
- The compaction hook, the pinned session model and the input budget gate use Pi hooks (`session_before_compact`, `session_start` with `setModel`, `input`) that have been run against fakes only; see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).
- Nothing here pushes, opens a pull request, or merges. Do that yourself with git and the `origin` CLI (or `gh`).
- A plan made only of literal edits (a ```` ```tasks ```` block) has no tickets, so `/build` cannot run it.
