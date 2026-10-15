# Pi Cost-Optimized Coding Agent

Local Pi extension and TypeScript modules that keep a coding task cheap without dropping the review. A deterministic policy picks the provider, the budget, and the next phase. Models only advise. State stays in the workspace under `.pi-workflows/`. There is no hosted coordinator and no database.

The workload this is shaped for is maintenance of Neo, a security-operations agent: plan, implement, review, publish, then watch the pull request. OpenAI and Anthropic are used through Pi account login in the same session. Azure AI Foundry uses the Azure CLI. Vercel AI Gateway uses the Vercel CLI. A local OpenAI-compatible server is optional.

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
npx git+https://origin.cursor.com/pkeenan/pi-cost-router.git init
```

`init` (the `pi-cost-init` bin) does three things:

1. Runs `pi install -l git:origin.cursor.com/pkeenan/pi-cost-router`. The source comes from `repository` in `package.json`.
2. Copies the sample config to `.pi-workflows/config.yaml`. It keeps an existing file unless you pass `--force`.
3. Adds any missing workflow-state lines to `.gitignore`. Lines already there are not added twice.

If `pi` is missing or `pi install` fails, it still writes the config, prints the install command to run yourself, and exits 1.

Variations:

```bash
# Pin a tag: once for the script npx fetches, once for what Pi installs
npx git+https://origin.cursor.com/pkeenan/pi-cost-router.git#v0.1.0 init --ref v0.1.0

# Over SSH
npx git+ssh://git@origin.cursor.com/pkeenan/pi-cost-router.git init

# From a GitHub mirror (--source, or Pi still installs from origin)
npx github:<owner>/pi-cost-router init --source git:github.com/<owner>/pi-cost-router

# From a local checkout (no network)
node ~/src/pi-cost-router/bin/init.mjs --source ~/src/pi-cost-router

# After an npm publish
npx pi-cost-optimized-agent init --source npm:pi-cost-optimized-agent

# Personal install for every project, instead of this project only
npx git+https://origin.cursor.com/pkeenan/pi-cost-router.git init --global

# Only write the config and .gitignore; skip pi install
npx git+https://origin.cursor.com/pkeenan/pi-cost-router.git init --no-install

# Show what would change
npx git+https://origin.cursor.com/pkeenan/pi-cost-router.git init --dry-run
```

Other flags: `--dir <path>` targets another project directory, and `--help` lists them all. npm's `github:` shorthand only works for GitHub, GitLab, and Bitbucket. Other hosts need the full `git+https://` or `git+ssh://` URL. `npx` and `pi install` both run `git clone`, so a private repo needs git credentials on the machine.

The sections below do the same steps by hand.

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

## Configuration

**Layering.** `~/.pi/agent/cost-workflow.yaml` (user) is the base. `.pi-workflows/config.yaml` (project) layers on top: sections such as `tiers`, `routing`, `workers`, and `autopilot` merge field by field with the project winning, and `pricing` rows merge by provider, model, and date. A project file ships with a cloned repo, so it is untrusted for credentials and policy, as follows.

**User-config-only fields.** `baseUrl`, `endpoint`, `apiKeyEnv`, `audience`, `projectDir`, `envFile`, and `decisionsPath` under `providers.*` are read from the user config only. In a project file they are ignored with a warning (shown by `/status`), unless the user does not define that provider and the value is the built-in default. Remote endpoints must be `https`. Only `local.baseUrl` may be `http`, and only for a loopback address.

**Policy fields a project can only tighten.**

| Field | Layering rule |
|---|---|
| `commandAllowlist` | A project entry is kept only if the user list covers it. With no user list, the built-in defaults are the ceiling. So the result is an intersection, and a project cannot grant itself new commands |
| `orgProviderAllowlist` | An empty list means all providers. A project list can restrict that, but once the user names providers the user's list is final |
| `proprietaryCode` | On if either file sets it (OR). It requires `orgProviderAllowlist` |
| `approvals` | Plan approval stays required, merge stays `manual`, and publish is `auto` only if the user config says so |
| `budgets` | The lower of the user and project value for each limit (a lower `softWarningRatio` warns earlier) |

The YAML must not contain secrets, API keys, or tokens. `autopilot.autoMerge: true` is rejected.

Provider setup: [Azure CLI and Foundry](#azure-cli-and-foundry-deployments) (`endpoint`, `audience: https://ai.azure.com`, `decisionsPath`) and [Vercel CLI and AI Gateway](#vercel-cli-and-ai-gateway) (`vercel login`, `vercel link`, `vercel env pull`, `projectDir`).

## Account login

This extension does not implement OAuth. It uses Pi's account login, and uses a key stored in Pi only for a provider you opt in (below).

| Provider | What to run | What this extension accepts |
|---|---|---|
| OpenAI | Pi `/login openai`, then **Sign in with ChatGPT** | An `oauth` credential on `openai` or legacy `openai-codex`. `OPENAI_API_KEY` is rejected |
| Anthropic | Pi `/login anthropic` (Claude Pro/Max) | An `oauth` credential, or a key saved in Pi when `apiKeyFallback` is on (below). `ANTHROPIC_API_KEY` and the other Anthropic key env vars are never read |
| xAI | Pi `/login xai`, then **Sign in with SuperGrok or X Premium** | An `oauth` credential (Grok subscription). `XAI_API_KEY` is never read |
| Foundry | `az login` (below) | An Azure CLI token for one request, audience `https://ai.azure.com`. Pi's built-in `azure` provider is API-key only and is not used |
| Vercel AI Gateway | `vercel login && vercel link` (below) | A `VERCEL_OIDC_TOKEN` from the environment or the pulled env file. No AI Gateway API key |
| Local | Start your own server | `baseUrl` in config. A bearer is sent only if you set `apiKeyEnv` |

### API-key fallback

If you can only sign in to a provider with an API key (saved through Pi's `/login`), allow it in your user config. A project config cannot turn this on.

```yaml
# ~/.pi/agent/cost-workflow.yaml
providers:
  anthropic:
    apiKeyFallback: true
```

The key is billed per token, so pricing switches to the `billing: api-key` rows for that provider (the shipped config has Anthropic's API rates). A model with no such row has unknown cost, which the budget treats as spend; it is never priced at the subscription's $0. `web_search` still needs an Anthropic subscription login.

`/auth status` prints provider, status, method, and a short detail. It reads `type` and `expires` from `~/.pi/agent/auth.json`. It does not copy access tokens, refresh tokens, or keys into the task, the prompt, or the log.

`/auth login openai` (and `anthropic`, `foundry`, `local`) explains the login command. There is no `ExtensionAPI.login()`, so the browser flow stays Pi's `/login`.

### Entitlement

A subscription login is not proof of free API usage.

- Pi marks both ChatGPT and Claude Pro/Max as `isSubscription: true`, then sends the token to an API. Confirm the account with a real request after `/login`. Tests in this repo do not make that call.
- ChatGPT sign-in keeps the chat models `gpt-6-luna`, `gpt-6-astra`, and `gpt-6.1-sol`. Pi filters out only classifier-type models for oauth credentials, which is why the classifier tier uses Foundry or Vercel instead.
- Anthropic's own setting `warnings.anthropicExtraUsage` (default on) warns that subscription auth may bill extra usage. This tool does not turn that off and does not invent a different login.

### Session renewal

An oauth credential with `expires` in the past is `expired`. `/implement` moves the task to `PAUSED` and tells you to run `/login` again. It does not try an API key. After you sign in, run `/auth status`, then `/implement` again. The approved plan and the worktrees are still on disk.

## Azure CLI and Foundry deployments

```bash
az login
export AZURE_AI_ENDPOINT="https://<resource>.services.ai.azure.com"
```

In `.pi-workflows/config.yaml`:

```yaml
providers:
  foundry:
    type: azure-foundry
    auth: azure-cli
    endpointEnv: AZURE_AI_ENDPOINT
    routeStyle: v1                    # <endpoint>/openai/v1/..., deployment name in `model`, no api-version
    audience: https://ai.azure.com    # az account get-access-token --resource https://ai.azure.com
    api: openai-completions           # or openai-responses
    # decisionsPath: /decisions       # Decisions API path under <endpoint>/openai/v1 (unverified, see below)
```

The current Foundry route is the OpenAI-compatible v1 API at `https://<resource>.services.ai.azure.com/openai/v1/` (also `<resource>.openai.azure.com/openai/v1/`). The deployment name goes in `model`, there is no `api-version`, and the Entra token audience is `https://ai.azure.com`. A `tiers` entry for Foundry names a deployment, for example `{ provider: foundry, model: grok-4-7 }`.

Configs written for the legacy deployments route keep working: set `apiVersion` (and the `cognitiveservices` audience) and omit `routeStyle`, and requests go to `/openai/deployments/<name>/chat/completions?api-version=...` as before. Set `routeStyle: v1` to opt in.

`az account get-access-token` supplies the bearer for a call. The decisions client keeps it in memory until five minutes before expiry; chat models registered with Pi read it through an `!az account get-access-token ...` command. Do not set `AZURE_OPENAI_API_KEY` for this workflow.

`Microsoft-Decision-1` is in the Foundry catalog (Direct from Azure, preview). It is a Decisions-API model, not a chat model, so the classifier tier calls `POST <endpoint>/openai/v1/decisions`. That path is an assumption: if your deployment exposes it elsewhere, set `providers.foundry.decisionsPath`. Decision-1 takes text only and has a 32K context, so the classifier input is truncated.

## Vercel CLI and AI Gateway

```bash
vercel login
vercel link          # once, in the directory named by providers.vercel.projectDir
```

```yaml
providers:
  vercel:
    type: vercel-ai-gateway
    auth: vercel-cli
    baseUrl: https://ai-gateway.vercel.sh/v1   # default
    projectDir: .                               # linked project; relative paths resolve from the repo root
    envFile: .env.local                         # default
```

The gateway authenticates with `Authorization: Bearer <VERCEL_OIDC_TOKEN>`. The token comes from the `VERCEL_OIDC_TOKEN` environment variable or from `envFile` inside `projectDir`. The expiry is read from the token's `exp` claim (not verified; Vercel verifies it). If the token is missing or has less than 10 minutes left, the extension runs `vercel env pull .env.local --yes` in `projectDir` (an argument array, no shell) and reads the file again. Tokens last about 12 hours. The token is cached in memory until it nears expiry and is never logged, written to config, or put in a task file. Model ids are `creator/model`, for example `typesafe-ai/jev`.

`/auth status` reports Vercel. `/auth login vercel` prints `vercel login && vercel link`. The ignore rules should already cover `.env.local`; check that yours do.

## Tiers and who serves them

Each tier lists candidate models under `tiers:` in the config. The runtime picks within a tier; the tier itself is still chosen by the deterministic policy.

| Tier | Candidates (sample config) |
|---|---|
| deterministic / mechanical | Local OpenAI-compatible model (`qwen2.5-coder:7b`) if configured and reachable; otherwise the plan's literal edits with no model |
| classifier | `Microsoft-Decision-1` deployed in Azure Foundry, or `typesafe-ai/jev` on Vercel AI Gateway. Both use the Decisions API |
| cheap | ChatGPT Luna `gpt-6-luna` (OpenAI account login), or Claude Haiku `claude-haiku-5-5` (Anthropic account login) |
| standard | Claude Sonnet `claude-sonnet-5-5` (Anthropic), Grok 4.7 through a SuperGrok subscription (`xai`), or Grok 4.7 deployed in Foundry |
| premium | Claude Opus `claude-opus-5-5` (Anthropic), or Sol 6.1 `gpt-6.1-sol` (OpenAI) |
| advisor (on demand) | Claude Fable `claude-fable-5-1` (Anthropic), or GPT Astra `gpt-6-astra` (OpenAI and/or a Foundry deployment) |

```yaml
tiers:
  cheap:
    - { provider: openai, model: gpt-6-luna }
    - { provider: anthropic, model: claude-haiku-5-5 }
  classifier:
    - { provider: foundry, model: Microsoft-Decision-1, api: decisions }
    - { provider: vercel, model: "typesafe-ai/jev", api: decisions }
```

The old `models: { classifier: local, cheap: foundry, ... }` map still works. Each entry becomes a one-candidate tier. A tier listed under `tiers` replaces its `models` entry. `deterministic` and `advisor` exist only under `tiers`.

How a candidate is picked:

1. Filter out candidates that the org allowlist or `proprietaryCode` excludes, whose own circuit breaker is open, whose expected cost exceeds the remaining task or daily budget, and whose provider is not signed in. For the deterministic tier an unreachable local server also excludes it (a cached `GET <baseUrl>/models` with a short timeout). If no provider is signed in for a tier, the choice ignores sign-in so the usual "run /login" pause appears instead of a silent escalation to a dearer tier.
2. Score each remaining candidate as expected cost per success: its price times the expected token mix (`workers.tokenBudget`, 4:1 input to output), plus its quota shadow price (below), divided by its success probability. The probability is a Thompson sample from Beta(1 + successes, 1 + failures) for that task type and model, so a new or unlucky model still gets tried now and then.
3. The lowest score wins. Ties go to config order. A candidate with no `pricing` row ranks after priced ones and the decision is flagged `price_unknown`.
4. If every candidate is excluded, the policy moves to the next tier, or stops with a clear reason (`/implement` blocks the task with `NO_CANDIDATE`; it never falls back to literal edits for a model tier).

Successes and failures are recorded per task type, tier, and model next to the old per-tier counters, which still drive the circuit breaker. A classifier call counts as a success when its answer reaches `routing.minConfidence`.

Subscription models (ChatGPT, Claude) are priced at 0 in the sample, because they have no per-token marginal cost. Every price in the sample config is a placeholder to replace from your rate cards.

### Subscription quota (shadow prices)

At $0 a subscription Opus call and a subscription Haiku call cost the same to the ledger, but they use up very different quota. The `quota:` block gives each subscription model a ranking-only shadow price, so the selector sends easy work to quota-cheap or metered-cheap candidates and keeps Opus, Sol, and Fable quota for hard tasks:

```yaml
quota:
  models:                      # USD per million tokens, used for ranking only
    - { provider: openai, model: gpt-6-luna, perMillionTokensUsd: 0.4 }
    - { provider: anthropic, model: claude-haiku-5-5, perMillionTokensUsd: 1 }
    - { provider: anthropic, model: claude-opus-5-5, perMillionTokensUsd: 10 }
    - { provider: openai, model: "gpt-6.1-sol", perMillionTokensUsd: 8 }
  providers:                   # optional soft caps, in tokens
    anthropic: { dailyTokens: 20000000, weeklyTokens: 100000000 }
  overCapMultiplier: 4         # default 4
```

- **Shadow cost.** For one task the shadow cost is `workers.tokenBudget` tokens at `perMillionTokensUsd`. It is added to the real expected cost when the selector scores candidates within a tier, and when the policy compares proven tiers for `/implement`. When a soft budget keeps only the cheapest candidate of a chat tier, the real price decides and the shadow price only breaks ties. A model without a `quota.models` row has no shadow cost.
- **Ranking only.** Shadow prices never reach the ledger's `actualUsd`, the task or daily budget, or the over-budget filter. A $0 subscription model stays eligible when the budget is spent, whatever its shadow price. `expectedUsd` in a routing decision is the real cost. A model still needs a `pricing` row: a quota weight does not make an unpriced model priced.
- **Soft caps.** Quota use per provider is the sum of the reported tokens (input, output, cache read, and cache write) in the ledger, for the budget day (UTC, like `dailyUsd`) and for the rolling seven days. Unknown token counts add nothing. At or over a provider's `dailyTokens` or `weeklyTokens`, its shadow prices are multiplied by `overCapMultiplier`, which pushes work to the other provider or to metered models. A cap never blocks a call, and the decision reason notes "over quota cap" when an over-cap model still wins.
- **Tier choice is unchanged.** Hard and security-sensitive work still goes to `premium` by policy. The shadow price only decides which premium model serves it, for example Sol over Opus when Anthropic is over its cap.
- **Layering.** `quota` is a ranking preference, not a policy field, so a project file overrides the user file per model row and per provider cap.
- `/cost` lists quota use per provider (tokens today and this week, against any caps), apart from billed spend. `/cost json` includes it as `quota`. Each `route` event shows the shadow part of each candidate's score.

### Showing the chosen model

Every routing decision (`/plan`, `/implement` and each escalation, `/review`, `/autopilot`, `/route`, `/advisor`) sets a status line, for example `standard → foundry/grok-4-7 · lowest expected cost per success ...`, adds a `route` event to the task's `events.jsonl` with the tier, model, reason and the score or exclusion of each candidate, and shows up in `/status` and `/cost` with per-model spend and success counts.

Chat turns on `cost-opt/auto` set no status line of their own: Pi's footer already shows `auto • level → model`. While a task is active they still add a `route` event to its log.

### Chat routing (`cost-opt/auto`)

`auto` is a stateful, cache-aware router (`src/router/virtual.ts`). Switching models mid-conversation loses the provider's prompt cache, so it moves as rarely as it can.

- **First user turn.** The message is classified once, with the same selector-chosen Decisions classifier that planning uses (keyword fallback if it is unavailable or not confident). The policy picks a tier (budget, availability, circuit breakers, and the org allowlist apply) and the selector picks a model in it. A model the session already uses is kept if it is a candidate of that tier. The choice is stored as router state (`tier`, model, `phase`, classification, `switches`) on the session branch.
- **Later turns and tool follow-ups.** They stay on the stored model. It is re-evaluated only when a message is longer than 2000 characters or contains an escalation cue ("this is hard", "think harder", "use a stronger model"), or when the thinking level rises to `high` or `xhigh`. Tiers only go up this way, never down.
- **One switch to build.** If the first model is `standard` or `premium` (the plan phase) and a successful `edit` or `write` tool result appears, the router switches once to the `cheap` tier's candidate and the phase becomes `build`. It does not switch when the classification is security-sensitive or high complexity, and never twice in one user turn. A later escalation starts a new plan phase.
- **Retries.** After an overload, rate-limit, 5xx, or auth error the router moves to another candidate of the same tier and counts a failure against the failed model (feeding the circuit breaker). After a context overflow it picks a candidate with a larger context window in the same or a higher tier. Other errors retry on the same model.
- **Compaction and other direct calls** go to the `cheap` tier.
- **Budget.** A hard limit stops routing with an error. A soft limit prefers the cheapest candidate in a tier and never moves up a tier.
- Every returned model must be registered in Pi with credentials (OpenAI and Anthropic only through account login); unusable candidates are skipped, and the error names the tier if none is left.

Thinking levels offered: `low`, `medium`, `high`, `xhigh`. They pass through as the physical thinking level (Pi clamps it to the model) and also steer the tier:

| Level | Effect |
|---|---|
| `low` | Prefer cheaper: one tier below the classifier's choice, never below `cheap`, never for security-sensitive work |
| `medium` | The classifier's choice |
| `high` | At least `standard` |
| `xhigh` | `premium` |

The declared context window and max output are the smallest known across the configured chat candidates.

### Advisor

`/advisor <question>` asks the advisor tier one question. It checks the budget first, builds a redacted context of at most 8,000 characters (task request, plan summary, classification, last failure, diff stat), picks a candidate with the same selector, ledgers the call with reason `advisor`, and prints the answer. It never changes the task phase and never edits files. Pi only suggests it: after a security-sensitive plan, and when `/implement` runs out of escalations. The suggestion is a notification ("Consider /advisor ..."); the model is never called without the command.

### Classifier

The classifier tier sends one Decisions request with five questions (`task_type`, `complexity`, `risk`, `recommended_tier`, and a `security_sensitive` predicate). Answer confidences and probabilities become the classification confidence (the weakest of the first three). A refusal, a missing answer, or a confidence below `routing.minConfidence` uses the keyword fallback. Strong security keywords in the request still force a security classification when the model says otherwise. With no usable decisions candidate, the older chat classifier option, or the keyword fallback, applies.

### Where model calls come from

OpenAI, Anthropic, Foundry, Vercel, and local chat models are called through Pi's model registry, which owns authentication. OpenAI and Anthropic calls are refused unless the registry is using an account login. Foundry, Vercel, and local models are registered with `pi.registerProvider` at session start, with credentials from `!command` values (the Azure CLI token, or a read of the pulled Vercel env file), so no token is held in config.

`/implement` calls the selected model only for plan groups that have no literal `edits`. The model returns whole-file edits for the group's own files, which are written through the same owned-file check as literal edits. Groups with approved literal edits keep applying exactly those edits.

## Local inference

```yaml
providers:
  local:
    type: openai-compatible
    baseUrl: http://127.0.0.1:11434/v1
    model: qwen2.5-coder:7b
```

Point `baseUrl` at Ollama, vLLM, or llama.cpp's OpenAI-compatible server. This process does not start that server. The deterministic tier uses it only while `<baseUrl>/models` answers.

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

`/plan <request>` runs in your normal Pi session on the virtual auto model, with read-only tools (read, grep, find, ls, allowlisted bash, `web_search`, `web_fetch`) plus three plan tools. It does not create a worktree and does not edit the repo.

1. **Interview.** The model looks up facts itself and asks you only decisions, through `plan_questions`, in rounds. A round holds every question whose prerequisites are settled (`dependsOn` answered); dependent questions wait for the next round. There are 3 to 7 questions in total (fewer for small tasks), and the tool rejects a round that would pass 7. Each question has 2 to 4 options, one marked `★ Recommended — <reason>` and preselected, and an `Other (type answer)` choice. Press `a` to accept every recommendation in the round. With no UI the recommendations are recorded as the answers. Answers go to `.pi-workflows/tasks/<id>/interview.json` with one `decision` event each, and the interview resumes after a restart (run `/plan` again). The status line reads `plan · interview round N (k/7 questions)`.
2. **Spec.** The model reads the code that will change, then saves `spec.md` with `plan_spec`: a technical implementation plan in the style of an engineer's plan mode (summary, current context, approach with types and signatures, every file to change and how, what to reuse, decisions, assumptions, out of scope, risks, and verification steps). Code rejects a spec without an approach, file changes, or verification.
3. **Tickets.** The model submits vertical, independently testable slices with `plan_tickets`. Code validates unique ids, existing blockers, no cycles, at least one acceptance criterion, and that each ticket fits `workers.ticketContextTokens` (default 150000; the larger of the model's estimate and a code estimate of chars/4 plus listed file sizes plus 20K overhead). An oversize ticket is sent back to be split. Each ticket carries technical `implementation` steps (files, functions, signatures, tests) beside its behavior and acceptance criteria. You then see the full plan (spec and every ticket) in a scrollable review and choose: save it for approval, request changes (typed feedback goes back to the model), or edit the tickets. The saved plan is also posted in the chat and written to `tasks/<id>/plan.md`; `/show-plan` shows it again. Each ticket is written to `tasks/<id>/tickets/NN-slug.md`, and each becomes a plan group (`NN-slug`, `dependsOn` from `blockedBy`) so the plan still goes through `/approve-plan`.

`/plan --no-questions <request>` skips the interview: the model records the choices it would have recommended as assumptions in the spec. A request that contains a literal ```` ```tasks ```` block is drafted directly as before (`plan.md`, `plan.json`, no model turn).

Ticket plans have no literal edits. In Pi, `/implement` runs each ticket in a child `pi` process (see Implement). Outside Pi, a workflow built without a `ticketRunner` fails with "ticket runner not configured" and applies nothing.

`/approve-plan` shows the full plan again and asks you to approve it, request changes (the plan goes back to the model with your feedback, without new interview questions, and returns for approval), or wait. Approving freezes `plan.vN.approved.json`. That file is write-once. A material scope change needs a new approval. The command then writes a handoff and asks Pi for a new session (`newSession`). If the host cannot do that, it compacts, and the handoff file remains either way.

`/implement` refuses while the plan is still a draft. It creates one worktree and branch per independent group (`cost/<task-id>/<group>`), records the base SHA, and runs up to `workers.concurrency` (default 2) at once. Overlapping files are serialized. Groups integrate one at a time onto `cost/<task-id>/integration`. A conflict aborts that merge. Security-sensitive plans (auth, permissions, secrets, production) wait for a person before any edit.

**Tickets run in child pi processes.** For a plan with tickets, each ticket attempt starts a fresh `pi --mode json -p --no-session --no-approve --model <provider>/<id> --tools read,bash,edit,write,grep,find,ls,web_search,web_fetch --no-extensions -e <this package's extension> --append-system-prompt <file> @<ticket prompt file>` with the ticket's worktree as its working directory (argv array, no shell). `--no-approve` keeps the child from loading the worktree's own Pi files (`.pi/settings.json` packages, extensions, skills): the worktree is model-written, and a listed git package would otherwise be cloned at startup without credentials. A child that exits before any model request is recorded at $0 and does not count against the model's success rate. Tickets follow `blockedBy` in waves, at most `workers.concurrency` at once; each ticket's worktree branches from its blockers, and integration is unchanged. Per ticket:

1. The ticket is routed with purpose `implement`. `suggestedTier` is a hint: it is capped by `routing.maxTier`, and a security-sensitive classification still forces the policy tier. The selector picks the model; the status line reads `ticket 01 → provider/model` and a `route` event is logged.
2. The prompt holds the ticket (what to build, acceptance criteria), the spec with its decisions, the final summaries of the tickets it is blocked by (truncated), the repo's `AGENTS.md` (truncated), and the instruction to implement only this ticket, add tests, run the checks, and close with each criterion marked met or not met plus the files changed.
3. When the child exits, its changes are committed, then the configured checks and the ticket's own `checks` run through the caching runner and the command allowlist. The ticket is `done` only if the child exited cleanly and every check passed. The ticket file's `## Status:` goes `in-progress`, then `done` or `failed`, and criteria checkboxes are ticked from the child's summary (best effort).
4. A failed ticket is retried in a fresh child on the same worktree at the next tier, up to `routing.maxEscalations`. After that the task is `BLOCKED` with an `/advisor` suggestion. Finished tickets stay done, and a later `/implement` runs only the rest.
5. The budget is checked before every ticket attempt. A hard budget starts no new tickets and blocks the task.

`workers.ticketContextTokens` (150K) is a soft target at run time. The child's own compaction continues. If a child's context crosses it, `/implement` warns, the ticket file gets a warning line, and `/status` marks it ("consider splitting"). `workers.deadlineMs` bounds each child attempt (SIGTERM, then SIGKILL after 5 seconds). Cancelling kills the child the same way.

The parent ledgers each ticket attempt once from the child's JSON events: provider and model from the route, cost from Pi's `cost.total` when positive, otherwise priced from config, otherwise unknown. `/status` shows each ticket's state, model, tokens, cost and peak context; the status line shows `ticket 01 · turn 3 · ~52k ctx` while a child runs.

**Child mode.** The child sets `PI_COST_ROUTER_CHILD=1` (plus `PI_COST_ROUTER_TASK`, `PI_COST_ROUTER_TICKET`, `PI_COST_ROUTER_ROOT`) and loads only this package's extension in a minimal form: our chat providers (foundry, vercel, local), `web_search` / `web_fetch`, and the bash deny hook below. No commands, no virtual router, no poller, no plan tools, no `message_end` ledgering. `web_search` checks the parent's task and daily budget from the parent's `.pi-workflows/` and ledgers under the parent task. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are removed from the child's environment; the child uses Pi's account login.

Limitations: the child's `bash` tool is not allowlisted, because a ticket must run builds and tests, so a child can still run other commands in its worktree. The `tool_call` hook that refuses `git push`, `gh` writes, and the sandbox deny rules is defense in depth only (see Limitations below). The real controls are the child's allowlisted environment and git config, the `--tools` list, and the post-run checks. Review the diff. The child gets its prompt from a file in the system temp directory that is deleted after the run.

`/review` diffs each worktree and the integration branch against the plan. Blocking findings (failed checks, secrets, auth bypass, `eval`) are separate from suggestions. `passed` is true only when every configured check exited 0 and nothing blocking was found.

`/push` requires that review and a publish confirmation. It pushes the integration branch and opens or updates one pull request through `gh`. It does not merge.

`/route <task>` previews tier, provider, and expected cost and writes nothing. `/status` shows phase, approval, worktrees, the PR, budget, and auth. `/cost`, `/cost json`, and `/cost csv` show the ledger. `/reset-phase` writes a manual handoff and resets context without deleting artifacts. `/worktrees status|list|cleanup` reconciles git worktrees. Cleanup of unmerged work asks first, and it refuses while a PR is active.

## Cost

Every model call the workflow records goes to `.pi-workflows/cost/ledger.jsonl`: provider, model, input, output, cache tokens, requests, estimated and actual charge, phase, retries, and outcome.

Prices live only in `pricing:` rows with `effectiveFrom`. There is no price table in source. A missing price or missing token count is an unknown charge (`actualUsd: null`, `usageKnown: false`), not zero. A deterministic step that made no model call is a known zero.

Budgets in the sample (`taskUsd: 20`, `autopilotPrUsd: 10`, `dailyUsd: 75`) are operator limits, not prices. Known spend at or above the limit is a hard stop. Known spend at or above `softWarningRatio` (default 0.8) is a warning. Unknown rows are not added in as zero.

`/cost json` is the dashboard source. `compareBaseline` in `src/cost/ledger.ts` diffs this workflow against a Cursor Auto sample you supply (cost per merged PR, time to merge-ready, success rate, retries, regressions, interventions). The repo does not invent a Cursor Auto number.

Routing keeps a rolling success table in `.pi-workflows/metrics/success.json`. Implementation starts at the cheapest proven tier, or at deterministic for mechanical work, and escalates at most `maxEscalations` times (default 2), never past `maxTier`. The classifier tier is for decisions, so a failed deterministic step escalates to `cheap`, not to the classifier. Three failures and zero successes in a task class open the circuit breaker.

## Web tools

The extension registers two tools for the model to call.

- `web_search` runs Anthropic's server-side `web_search_20250305` tool through Claude Haiku 5.5 (`claude-haiku-5-5`), using your Anthropic account login (`/login anthropic`). API keys are not accepted. It is refused when the task or daily budget is exhausted. Each call is written to the cost ledger (tier `web_search`, no query text) and the status line shows `anthropic/claude-haiku-5-5 · web_search`. Anthropic's per-search fee is not priced: `pricing:` rows only hold token prices, so only token cost is computed.
- `web_fetch` runs locally. It fetches public http(s) pages only (private, loopback, and link-local addresses are refused), converts HTML to markdown, and caps response size, redirects, and time. See `src/tools/web-fetch.ts` for the exact limits.

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
| `/plan [--no-questions] <request>` | Interview (3-7 decisions with recommendations), spec, tickets, then a draft plan. No edits |
| `/show-plan` | Show the full plan (technical spec and tickets) |
| `/approve-plan` | Review the full plan, then freeze a version and reset context, or request changes |
| `/implement` | Approved plan only. Worktrees, tests, handoff |
| `/review` | Independent diff and checks |
| `/push` | Branch, commit is already on the integration branch, push, open or update the PR |
| `/autopilot [stop\|status]` | One watch cycle, then a local poll |
| `/route <task>` | Preview routing |
| `/advisor <question>` | One question to the advisor tier. Costs money, never changes the phase |
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
src/providers/            account-login gate, Foundry, Vercel, Decisions client, Pi registry chat
src/router/               classifier schema, policy, and per-tier candidate selector
src/agents/               worker pool
src/review/               diff and check evidence
src/github/               gh client and autopilot cycle
src/cost/                 ledger, budgets, baseline compare
src/storage/              lock, journal, snapshots
src/git/                  worktrees
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
  handoffs/
  reports/
```

## Limitations

- No paid provider call is made by the tests. OpenAI and Anthropic transports throw unless a test injects one. Account login is verified by reading Pi 1.2.0's provider objects, not by completing a prompt.
- The autopilot poll does not outlive the Pi process. There is no detached daemon.
- Pi's `/login` still offers an API-key prompt. This extension treats that credential as blocked unless the user config sets `apiKeyFallback` for that provider.
- Ticket children never pick a provider that is not signed in: when no model in the chosen tier is usable, the ticket moves up a tier instead of failing on a login error.
- The ticket child's bash hook is defense in depth, not a boundary: it normalizes wrappers (`env`, `command`, `sudo`, `nohup`, ...), looks inside `sh -c` and `eval`, and refuses `git push` and `gh` writes, but shell can always hide a command (a script file, an alias, an encoded string). The real controls are (a) an environment allowlist, so the child never sees `GITHUB_TOKEN`, `GH_TOKEN`, `*_TOKEN`, `*_KEY`, `*_SECRET`, `AWS_*`, `VERCEL_OIDC_TOKEN`, `ANTHROPIC_*`, or `OPENAI_*`, and (b) git config injected through `GIT_CONFIG_COUNT` that disables pushing for every remote and any URL, turns credential helpers and hooks off, and sets `GIT_TERMINAL_PROMPT=0`. A child can still use credentials stored in files under your home directory (for example `~/.ssh` or a `gh` config file) for non-git tools, so run tickets from an account that holds nothing you would not give the model.
- Ticket children run in their own process group. They are stopped with SIGTERM then SIGKILL on cancel, deadline, a budget stop, `session_shutdown`, and Pi exiting. A running child's spend is tracked as its messages arrive, and every concurrent child is stopped when ledger plus in-flight spend passes the task or daily limit (the overshoot is at most one model call).
- Interactive Pi bash is denied for destructive commands (`rm -rf`, force push, piping a download into a shell, and similar). It is not a full allowlist of every other command, because that would break the host agent. Worker checks are allowlisted.
- `cost-opt/auto` classifies once per session (and again only on a long or escalating message), and a Decisions classifier call is ledgered to the active task. It picks models with the same selector as the commands. In `/implement`, groups with literal `edits` apply exactly those edits; only groups without them are written by the selected model. The worker pool does not spawn further agents.
- The `gh` client is argument-array `gh` with no shell. Tests use an in-memory GitHub client. A live `gh auth status` is still required before `/push` against GitHub.
- Context reset uses `newSession` from a command, then `compact` if that throws. Both leave the files in `.pi-workflows`. Whether the new session is empty of the old transcript depends on Pi; the handoff file is the durable copy.
