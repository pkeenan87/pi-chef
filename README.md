# Pi Cost-Optimized Coding Agent

Local Pi extension and TypeScript modules that keep a coding task cheap without dropping the review. A deterministic policy picks the provider, the budget, and the next phase. Models only advise. State stays in the workspace under `.pi-workflows/`. There is no hosted coordinator and no database.

The workload this is shaped for is maintenance of Neo, a security-operations agent: plan, implement, review, publish, then watch the pull request. OpenAI and Anthropic are used through Pi account login in the same session. Azure AI Foundry uses the Azure CLI. A local OpenAI-compatible server is optional.

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

### Choose a scope

| Flag | Pi writes the package to | Loads in |
|---|---|---|
| (none) | `~/.pi/agent/settings.json` | every project |
| `-l` / `--local` | `.pi/settings.json` in the current directory | this project, after you grant project trust |

Run the commands below from the project directory when you use `-l`. Commit `.pi/settings.json` if the whole team should get the package.

### Install from origin (git over HTTPS)

```bash
pi install -l git:origin.cursor.com/pkeenan/pi-cost-router
```

Pin a tag or commit so updates do not move under you:

```bash
pi install -l git:origin.cursor.com/pkeenan/pi-cost-router@<tag-or-commit>
```

Pi also accepts the plain URL and treats it as a git source:

```bash
pi install -l https://origin.cursor.com/pkeenan/pi-cost-router
```

Pi clones with `git`, so the machine needs git credentials for `origin.cursor.com` (a credential helper or a token). Pi does not ask for them. Pi installs `dependencies` (`yaml`) for git sources.

### Install from another git host

Any git host works with the same form. For a GitHub mirror:

```bash
pi install -l git:github.com/<owner>/pi-cost-router@<tag-or-commit>
```

### Install from a local checkout

```bash
git clone https://origin.cursor.com/pkeenan/pi-cost-router.git ~/src/pi-cost-router
cd ~/src/pi-cost-router && npm install
cd /path/to/your/project
pi install -l ~/src/pi-cost-router
```

Pi loads a local path in place without copying it, and it does not install that package's dependencies. Run `npm install` in the checkout first. A relative path resolves from the settings file that contains it.

### Install from npm

Not published yet. `package.json` is `"private": true`. After a publish, the command is:

```bash
pi install -l npm:pi-cost-optimized-agent@<version>
```

### Try it once without installing

```bash
pi -e git:origin.cursor.com/pkeenan/pi-cost-router
```

`-e` loads the package for one run and writes nothing to settings.

### Add the project config

`pi install` does not create workflow config. Copy the sample from a checkout into the target project:

```bash
mkdir -p .pi-workflows
cp ~/src/pi-cost-router/.pi-workflows/config.yaml .pi-workflows/config.yaml
```

Then add these lines to the project's `.gitignore`:

```gitignore
.pi-workflows/tasks/
.pi-workflows/cost/
.pi-workflows/autopilot/
.pi-workflows/metrics/
.pi-workflows/worktrees/
.pi-workflows/notifications.jsonl
.pi-workflows/active-task.json
.pi-workflows/*.local.yaml
```

A user-level file at `~/.pi/agent/cost-workflow.yaml` is the base, and the project file layers on top of it. Keep machine-specific values (endpoints, base URLs, env-var names) in the user file, not the committed project file. The YAML must not contain secrets, API keys, or tokens. `autopilot.autoMerge: true` is rejected. `approvals.merge` stays `manual`. Plan approval stays required. Set `checks:` before you expect `/review` to pass (see [Sample workflow](#sample-workflow)).

Task files, the cost ledger, autopilot cursors, and worktrees are gitignored. The config file is not.

### Verify, update, remove

```bash
pi list
pi update git:origin.cursor.com/pkeenan/pi-cost-router
pi update --extensions
pi remove -l git:origin.cursor.com/pkeenan/pi-cost-router
```

`pi update` without a target updates Pi itself, not this package. Inside Pi, `/cost-help` lists the commands and `/auth status` checks logins. `-a` / `--approve` trusts project-local files for one command.

### Develop this repo

```bash
npm install
npm test
npm run typecheck
```

## Account login

This extension does not implement OAuth and does not fall back to an API key.

| Provider | What to run | What this extension accepts |
|---|---|---|
| OpenAI | Pi `/login openai`, then **Sign in with ChatGPT** | An `oauth` credential on `openai` or legacy `openai-codex`. `OPENAI_API_KEY` is rejected |
| Anthropic | Pi `/login anthropic` (Claude Pro/Max) | An `oauth` credential. `ANTHROPIC_API_KEY` and the other Anthropic key env vars are rejected |
| Foundry | `az login` (below) | An Azure CLI token for one request. Pi's built-in `azure` provider is API-key only and is not used |
| Local | Start your own server | `baseUrl` in config. A bearer is sent only if you set `apiKeyEnv` |

`/auth status` prints provider, status, method, and a short detail. It reads `type` and `expires` from `~/.pi/agent/auth.json`. It does not copy access tokens, refresh tokens, or keys into the task, the prompt, or the log.

`/auth login openai` (and `anthropic`, `foundry`, `local`) explains the login command. There is no `ExtensionAPI.login()`, so the browser flow stays Pi's `/login`.

### Entitlement

A subscription login is not proof of free API usage.

- Pi marks both ChatGPT and Claude Pro/Max as `isSubscription: true`, then sends the token to an API. Confirm the account with a real request after `/login`. Tests in this repo do not make that call.
- ChatGPT sign-in does not work with the Decisions API (`gpt-6-luna`). Pi filters those models out for oauth credentials.
- Anthropic's own setting `warnings.anthropicExtraUsage` (default on) warns that subscription auth may bill extra usage. This tool does not turn that off and does not invent a different login.

### Session renewal

An oauth credential with `expires` in the past is `expired`. `/implement` moves the task to `PAUSED` and tells you to run `/login` again. It does not try an API key. After you sign in, run `/auth status`, then `/implement` again. The approved plan and the worktrees are still on disk.

## Azure CLI and Foundry deployments

```bash
az login
export AZURE_AI_ENDPOINT="https://<resource>.openai.azure.com"
```

In `.pi-workflows/config.yaml`:

```yaml
providers:
  foundry:
    type: azure-foundry
    auth: azure-cli
    endpointEnv: AZURE_AI_ENDPOINT
    apiVersion: 2024-10-21
    audience: https://cognitiveservices.azure.com
    api: openai-completions   # or openai-responses, or azure-openai-responses
    deployments:
      classifier: classifier
      reasoning: reasoning
      cheap: classifier
```

`az account get-access-token` supplies the bearer for a single call. The token stays in memory. Endpoint, deployment name, API version, audience, and wire shape all come from config. Do not set `AZURE_OPENAI_API_KEY` for this workflow.

`/auth status` reports Foundry as unavailable until an Azure probe is configured in-process. A failed `az login` pauses Foundry calls.

## Local inference

```yaml
providers:
  local:
    type: openai-compatible
    baseUrl: http://127.0.0.1:11434/v1
    model: qwen2.5-coder:7b
```

Point `baseUrl` at Ollama, vLLM, or llama.cpp's OpenAI-compatible server. This process does not start that server. The classifier tier defaults to `local`.

## Sample workflow

Configure at least one check before you expect `/review` to pass. The sample config ships `checks: []` on purpose: a review with no tool evidence cannot claim a pass, and `/push` then refuses.

```yaml
checks:
  - name: unit
    command: npm
    args: ["test"]
```

The command must also be on `commandAllowlist` (prefix or exact). Destructive commands stay blocked even if someone adds them to the allowlist, unless that call is explicitly approved.

```text
/plan Harden Neo ingest: reject empty events. AC: empty input throws
/approve-plan
/implement
/review
/push
/autopilot
/autopilot status
/autopilot stop
```

`/plan` classifies the request, writes a draft (`plan.md`, `plan.json`), and names parallel groups, file overlap, and a worktree allocation. It does not create a worktree and does not edit the repo.

`/approve-plan` freezes `plan.vN.approved.json`. That file is write-once. A material scope change needs a new approval. The command then writes a handoff and asks Pi for a new session (`newSession`). If the host cannot do that, it compacts, and the handoff file remains either way.

`/implement` refuses while the plan is still a draft. It creates one worktree and branch per independent group (`cost/<task-id>/<group>`), records the base SHA, and runs up to `workers.concurrency` (default 2) at once. Overlapping files are serialized. Groups integrate one at a time onto `cost/<task-id>/integration`. A conflict aborts that merge. Security-sensitive plans (auth, permissions, secrets, production) wait for a person before any edit.

`/review` diffs each worktree and the integration branch against the plan. Blocking findings (failed checks, secrets, auth bypass, `eval`) are separate from suggestions. `passed` is true only when every configured check exited 0 and nothing blocking was found.

`/push` requires that review and a publish confirmation. It pushes the integration branch and opens or updates one pull request through `gh`. It does not merge.

`/route <task>` previews tier, provider, and expected cost and writes nothing. `/status` shows phase, approval, worktrees, the PR, budget, and auth. `/cost`, `/cost json`, and `/cost csv` show the ledger. `/reset-phase` writes a manual handoff and resets context without deleting artifacts. `/worktrees status|list|cleanup` reconciles git worktrees. Cleanup of unmerged work asks first, and it refuses while a PR is active.

## Cost

Every model call the workflow records goes to `.pi-workflows/cost/ledger.jsonl`: provider, model, input, output, cache tokens, requests, estimated and actual charge, phase, retries, and outcome.

Prices live only in `pricing:` rows with `effectiveFrom`. There is no price table in source. A missing price or missing token count is an unknown charge (`actualUsd: null`, `usageKnown: false`), not zero. A deterministic step that made no model call is a known zero.

Budgets in the sample (`taskUsd: 20`, `autopilotPrUsd: 10`, `dailyUsd: 75`) are operator limits, not prices. Known spend at or above the limit is a hard stop. Known spend at or above `softWarningRatio` (default 0.8) is a warning. Unknown rows are not added in as zero.

`/cost json` is the dashboard source. `compareBaseline` in `src/cost/ledger.ts` diffs this workflow against a Cursor Auto sample you supply (cost per merged PR, time to merge-ready, success rate, retries, regressions, interventions). The repo does not invent a Cursor Auto number.

Routing keeps a rolling success table in `.pi-workflows/metrics/success.json`. Implementation starts at the cheapest proven tier, or at deterministic for mechanical work, and escalates at most `maxEscalations` times (default 2), never past `maxTier`. The classifier tier is for decisions, so a failed deterministic step escalates to `cheap`, not to the classifier. Three failures and zero successes in a task class open the circuit breaker.

## Autopilot safety

`/autopilot` runs inside the Pi process. Each cycle refreshes the head SHA, review threads, and checks. It dedupes by comment or check id plus SHA. Actionable items get one bounded fix and a reply only when the fix was verified. Informational notes are ignored. Ambiguous comments, security comments, and out-of-scope requests pause for a person. A force-push or a base change stops the watcher.

`MERGE_READY` requires completed successful checks, an approval, a mergeable branch, branch protection, and no unresolved actionable thread. The reason string says the PR was not merged. There is no merge method on the GitHub client. `autoMerge: true` cannot be configured.

Limits: `maxFixCycles` (5), `budgets.autopilotPrUsd`, `maxRuntimeMs`, and exponential backoff. The next poll is a `setTimeout` of `pollSeconds` (90) or the backoff, cleared by `/autopilot stop` and by Pi `session_shutdown`. Killing Pi stops the timer. The cursor remains in the task state, so the next `/autopilot` continues without repeating a reply for the same thread and SHA.

## Recovery

Task state is `state.json` plus an append-only `events.jsonl`. On startup the store rebuilds from the log if the snapshot is missing or torn, then rewrites the snapshot. Writes go through a temp file and rename, under a lock file. A reset never deletes `plan.md`, the approved snapshot, handoffs, or reports.

Worktrees are normal git worktrees. After a crash, `/worktrees list` reconciles them with `git worktree list`. `/worktrees cleanup` removes only merged or abandoned trees, and it asks before deleting unmerged work. It will not delete a tree while the PR is `PUBLISHED`, `AUTOPILOT`, `MERGE_READY`, or waiting for publish approval.

A failed check escalates within the cap and records the unknown or known charge. A conflict leaves the integration merge aborted. An expired login pauses. Rate-limit and outage errors from the Foundry and local clients surface as provider errors and do not rewrite policy.

## Commands

| Command | Effect |
|---|---|
| `/plan <request>` | Draft plan, risks, tests, cost, acceptance. No edits |
| `/approve-plan` | Freeze a version and reset context |
| `/implement` | Approved plan only. Worktrees, tests, handoff |
| `/review` | Independent diff and checks |
| `/push` | Branch, commit is already on the integration branch, push, open or update the PR |
| `/autopilot [stop\|status]` | One watch cycle, then a local poll |
| `/route <task>` | Preview routing |
| `/cost [json\|csv]` | Ledger versus budgets |
| `/status` | Phase, auth, worktrees, budget |
| `/reset-phase` | Handoff and context reset. Files stay |
| `/worktrees status\|list\|cleanup` | Reconcile or clean trees |
| `/auth status` and `/auth login <provider>` | Credential metadata, or how to sign in |

`help` or `--help` on a command prints its description. Tab completion uses Pi's `getArgumentCompletions` for `/auth`, `/autopilot`, `/cost`, and `/worktrees`.

Phases: `IDLE → PLANNING → AWAITING_PLAN_APPROVAL → IMPLEMENTING → REVIEWING → AWAITING_PUBLISH_APPROVAL → PUBLISHED → AUTOPILOT → MERGE_READY → COMPLETE`. Fixes return to `IMPLEMENTING`. Active phases can enter `BLOCKED`, `PAUSED`, or `FAILED`. A draft never becomes implementation on its own.

## Layout

```text
src/extension.ts          Pi commands and the virtual model cost-opt/auto
src/orchestrator/         state machine, plans, workflow
src/providers/            account-login gate, Foundry, local
src/router/               classifier schema and policy
src/agents/               worker pool
src/review/               diff and check evidence
src/github/               gh client and autopilot cycle
src/cost/                 ledger, budgets, baseline compare
src/storage/              lock, journal, snapshots
src/git/                  worktrees
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
  handoffs/
  reports/
```

## Limitations

- No paid provider call is made by the tests. OpenAI and Anthropic transports throw unless a test injects one. Account login is verified by reading Pi 1.2.0's provider objects, not by completing a prompt.
- The autopilot poll does not outlive the Pi process. There is no detached daemon.
- Pi's `/login` still offers an API-key prompt. This extension treats that credential as blocked.
- Interactive Pi bash is denied for destructive commands (`rm -rf`, force push, piping a download into a shell, and similar). It is not a full allowlist of every other command, because that would break the host agent. Worker checks are allowlisted.
- `cost-opt/auto` uses the deterministic classifier, not a live local model, so a virtual route cannot spend money by accident. Sub-agent edits in `/implement` come from the approved plan's edit list. The worker pool does not spawn further agents.
- The `gh` client is argument-array `gh` with no shell. Tests use an in-memory GitHub client. A live `gh auth status` is still required before `/push` against GitHub.
- Context reset uses `newSession` from a command, then `compact` if that throws. Both leave the files in `.pi-workflows`. Whether the new session is empty of the old transcript depends on Pi; the handoff file is the durable copy.
