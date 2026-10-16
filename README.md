# Pi Conductor

A Pi extension that plans, builds and reviews coding work with the right model for each job: `/plan` → `/build` → `/review`. A deterministic policy picks the provider, the budget, and the next phase. Models only advise. State stays in the workspace under `.pi-workflows/`. There is no hosted coordinator and no database.

Routing is by role. Opus leads the session and writes the plan. Each ticket is built in its own fresh session on a model chosen by the ticket's difficulty: grok for low, Sonnet for medium, Sol for high. Astra and Fable advise on the plan and the review. Cost-awareness stays a feature: spend is tracked per phase, provider and model against budgets, and the selector ranks models by cost per success. You plan and approve once, and `/review` checks the result and fixes what it finds. You push and open the pull request yourself. OpenAI and Anthropic are used through Pi account login in the same session. Azure AI Foundry uses the Azure CLI. Vercel AI Gateway uses the Vercel CLI. A local OpenAI-compatible server is optional.

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
npx github:pkeenan/pi-conductor init
```

`init` (the `pi-conductor-init` bin) does three things:

1. Runs `pi install -l git:github.com/pkeenan/pi-conductor`. The source comes from `repository` in `package.json`.
2. Copies the sample config to `.pi-workflows/config.yaml`. It keeps an existing file unless you pass `--force`.
3. Adds any missing workflow-state lines to `.gitignore`. Lines already there are not added twice.

If `pi` is missing or `pi install` fails, it still writes the config, prints the install command to run yourself, and exits 1.

Variations:

```bash
# Pin a tag: once for the script npx fetches, once for what Pi installs
npx github:pkeenan/pi-conductor#v0.1.0 init --ref v0.1.0

# Over SSH
npx git+ssh://git@github.com/pkeenan/pi-conductor.git init

# From a fork (--source, or Pi still installs from pkeenan/pi-conductor)
npx github:<owner>/pi-conductor init --source git:github.com/<owner>/pi-conductor

# From a local checkout (no network)
node ~/src/pi-conductor/bin/init.mjs --source ~/src/pi-conductor

# After an npm publish
npx pi-conductor init --source npm:pi-conductor

# Personal install for every project, instead of this project only
npx github:pkeenan/pi-conductor init --global

# Only write the config and .gitignore; skip pi install
npx github:pkeenan/pi-conductor init --no-install

# Show what would change
npx github:pkeenan/pi-conductor init --dry-run
```

Other flags: `--dir <path>` targets another project directory, and `--help` lists them all. npm's `github:` shorthand only works for GitHub, GitLab, and Bitbucket. Other hosts need the full `git+https://` or `git+ssh://` URL. `npx` and `pi install` both run `git clone`, so a private fork needs git credentials on the machine.

The sections below do the same steps by hand.

### Choose a scope

| Flag | Pi writes the package to | Loads in |
|---|---|---|
| (none) | `~/.pi/agent/settings.json` | every project |
| `-l` / `--local` | `.pi/settings.json` in the current directory | this project, after you grant project trust |

Run the commands below from the project directory when you use `-l`. Commit `.pi/settings.json` if the whole team should get the package.

### Install from GitHub

```bash
pi install -l git:github.com/pkeenan/pi-conductor
```

Pin a tag or commit so updates do not move under you:

```bash
pi install -l git:github.com/pkeenan/pi-conductor@<tag-or-commit>
```

Pi also accepts the plain URL and treats it as a git source:

```bash
pi install -l https://github.com/pkeenan/pi-conductor
```

Pi clones with `git`, so the machine needs git access to `github.com`. The repository is public, so no credentials are needed. A read-only mirror exists at origin.cursor.com/pkeenan/pi-conductor. Pi installs `dependencies` (`yaml`) for git sources.

### Install from another git host

Any git host works with the same form. For a fork:

```bash
pi install -l git:github.com/<owner>/pi-conductor@<tag-or-commit>
```

### Install from a local checkout

```bash
git clone https://github.com/pkeenan/pi-conductor.git ~/src/pi-conductor
cd ~/src/pi-conductor && npm install
cd /path/to/your/project
pi install -l ~/src/pi-conductor
```

Pi loads a local path in place without copying it, and it does not install that package's dependencies. Run `npm install` in the checkout first. A relative path resolves from the settings file that contains it.

### Install from npm

Not published yet. `package.json` is `"private": true`. After a publish, the command is:

```bash
pi install -l npm:pi-conductor@<version>
```

### Try it once without installing

```bash
pi -e git:github.com/pkeenan/pi-conductor
```

`-e` loads the package for one run and writes nothing to settings.

### Add the project config

`pi install` does not create workflow config. Copy the sample from a checkout into the target project:

```bash
mkdir -p .pi-workflows
cp ~/src/pi-conductor/.pi-workflows/config.yaml .pi-workflows/config.yaml
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

A user-level file at `~/.pi/agent/conductor.yaml` is the base, and the project file layers on top of it. Keep machine-specific values (endpoints, base URLs, env-var names) in the user file, not the committed project file. The YAML must not contain secrets, API keys, or tokens. `approvals.merge` stays `manual` and a config that sets it otherwise is rejected. Plan approval stays required. Set `checks:` before you expect `/review` to pass (see [Sample workflow](#sample-workflow)).

Task files, the cost ledger, metrics, and reports are gitignored. The config file is not.

### Verify, update, remove

```bash
pi list
pi update git:github.com/pkeenan/pi-conductor
pi update --extensions
pi remove -l git:github.com/pkeenan/pi-conductor
```

`pi update` without a target updates Pi itself, not this package. Inside Pi, `/conductor` lists the commands and `/auth status` checks logins. `-a` / `--approve` trusts project-local files for one command.

### Develop this repo

```bash
npm install
npm test
npm run typecheck
```

## Configuration

**Layering.** `~/.pi/agent/conductor.yaml` (user) is the base. `.pi-workflows/config.yaml` (project) layers on top: sections such as `tiers`, `routing`, and `workers` merge field by field with the project winning, and `pricing` rows merge by provider, model, and date. A project file ships with a cloned repo, so it is untrusted for credentials and policy, as follows.

**User-config-only fields.** `baseUrl`, `endpoint`, `apiKeyEnv`, `audience`, `projectDir`, and `envFile` under `providers.*` are read from the user config only. In a project file they are ignored with a warning (shown by `/status`), unless the user does not define that provider and the value is the built-in default. Remote endpoints must be `https`. Only `local.baseUrl` may be `http`, and only for a loopback address.

**Policy fields a project can only tighten.**

| Field | Layering rule |
|---|---|
| `orgProviderAllowlist` | An empty list means all providers. A project list can restrict that, but once the user names providers the user's list is final |
| `proprietaryCode` | On if either file sets it (OR). It requires `orgProviderAllowlist` |
| `approvals` | Plan approval stays required and merge stays `manual`. `approvals.publish` from an older file is accepted, ignored, and warned about: nothing pushes |
| `budgets` | The lower of the user and project value for each limit (a lower `softWarningRatio` warns earlier). When the user sets none, the project value is compared with the default (`taskUsd` 20, `dailyUsd` 75, `softWarningRatio` 0.8), so a project can only tighten. The exception is `unknownCallUsd`: the higher of the two wins (the user's value, or the default 0.05 when the user sets none), because a lower estimate would loosen the budget |
| `advisors` | A project can only turn `tickets`, `plan` and `summarizeCut` off, never on. `maxDiffChars`, `maxOutputTokens`, `timeoutMs` and `maxPlanConsults` take the lower of the user and project value (the default when the user sets none), because they raise cost or the data sent. `adHocMinLines` takes the higher, since a higher threshold means fewer advisor calls. Anything else is ignored with a warning |
| `session` | `model` and `compactionTier` are user-config-only. A project may only set `pin: false`. Ignored values get a warning in `/status` |

The YAML must not contain secrets, API keys, or tokens.

**Other top-level keys.**

| Key | Meaning |
|---|---|
| `branchPrefix` (default `conductor`) | `/build` names the branch `<branchPrefix>/<task-id>` when they start from the default branch |
| `checks` | Commands `/build` (when a ticket has none of its own) and `/review` run in the repo root. Any command runs except destructive ones (`rm -rf`, force push, `reset --hard`, piping a download into a shell), which are refused |
| `setup` | Same shape as `checks`. Runs once per build before the first ticket's checks, and before the checks of every `/review` |
| `workers.tokenBudget`, `workers.ticketContextTokens` | The token mix the router prices a call at, and the size a ticket must fit (default 150000) |
| `session.model` (default `anthropic/claude-opus-5-5`) | The main chat session's model, as `provider/id`. Set on `session_start` when the session started on another model |
| `session.pin` (default `true`) | Whether `session.model` is set at session start. `false` leaves the model you picked with `/model` alone, and `/build` puts that model back when it finishes |
| `session.compactionTier` (default `cheap`) | Tier that writes compaction summaries (`session_before_compact`). One of `cheap`, `standard`, `premium` |
| `routing.reviewTier` (default `premium`) | Tier of the `/review` model pass. A failed part falls back to `standard` candidates once this tier has none left |
| `routing.maxEscalations` (default 3) | Tier steps a failed ticket may climb from its difficulty tier (low, medium, high, then premium). When they are used up the ticket stays `failed`, `/build` stops with `MAX_ESCALATIONS`, and you fix it in the chat or raise the limit |
| `tiers.ticketLow`, `tiers.ticketMedium`, `tiers.ticketHigh` | Models for tickets of difficulty `low`, `medium`, `high`. A config that lists `tiers` without them runs those tickets on `cheap`, `standard` and `premium`, with a warning in `/status` |
| `routing.attemptOverheadUsd` (default 0.02, at least 0) | Ranking only. Added to each candidate's price before it is divided by its success rate, so a $0 model with a poor record does not always win. Never billed, never in a budget |
| `advisors` | Second opinions: `tickets` (default true; false turns the per-ticket review in `/build` off), `plan` (default true; false skips `plan_consult` and its requirement), `adHocMinLines` (default 400; an ad-hoc branch with more changed lines than this gets one advisor in `/review`), `summarizeCut` (default true; the batch tier writes a one-line summary of each file a diff clip cut), `timeoutMs` (default 180000, per call), `maxDiffChars` (default 40000, the diff sent to advisors), `maxOutputTokens` (default 1500, the visible answer an advisor is asked to stay within), `maxPlanConsults` (default 2; plan consults per draft version, a project can only lower it). Advisors obey the same hard rules as model selection (`orgProviderAllowlist`, `proprietaryCode`, an open circuit, the budget); an excluded advisor is never called and is listed with its reason (`org_allowlist`, `proprietary_code_policy`, `circuit_open`, `over_budget`) in `advisorsSkipped` |
| `review` | The advisory model pass of `/review`: `model` (on by default), `maxDiffChars`, `maxChunks`, `timeoutMs` |

Old keys load with a warning (shown by `/status`) and are otherwise ignored: `commandAllowlist`, `worktrees.*`, `workers.concurrency`, `workers.deadlineMs`, `workers.isolatedWorktrees`, `workers.preserveUntilReviewed`, `autopilot`, `budgets.autopilotPrUsd`, `routing.sessionTier`, `routing.directTier`, `routing.minConfidence`, `providers.*.decisionsPath`, `models.classifier`, `tiers.classifier`, and any tier entry with `api: decisions` (that entry is dropped). An old `worktrees.branchPrefix` still names the branches while `branchPrefix` is unset.

Provider setup: [Azure CLI and Foundry](#azure-cli-and-foundry-deployments) (`endpoint`, `audience: https://ai.azure.com`) and [Vercel CLI and AI Gateway](#vercel-cli-and-ai-gateway) (`vercel login`, `vercel link`, `vercel env pull`, `projectDir`).

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
# ~/.pi/agent/conductor.yaml
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
- ChatGPT sign-in keeps the chat models `gpt-6-luna`, `gpt-6-astra`, and `gpt-6.1-sol`.
- Anthropic's own setting `warnings.anthropicExtraUsage` (default on) warns that subscription auth may bill extra usage. This tool does not turn that off and does not invent a different login.

### Session renewal

An oauth credential with `expires` in the past is `expired`. `/build` moves the task to `PAUSED` and tells you to run `/login` again. It does not try an API key. After you sign in, run `/auth status`, then `/build` again. The approved plan and the commits so far are still there.

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
```

The current Foundry route is the OpenAI-compatible v1 API at `https://<resource>.services.ai.azure.com/openai/v1/` (also `<resource>.openai.azure.com/openai/v1/`). The deployment name goes in `model`, there is no `api-version`, and the Entra token audience is `https://ai.azure.com`. A `tiers` entry for Foundry names a deployment, for example `{ provider: foundry, model: grok-4-7 }`.

Configs written for the legacy deployments route keep working: set `apiVersion` (and the `cognitiveservices` audience) and omit `routeStyle`, and requests go to `/openai/deployments/<name>/chat/completions?api-version=...` as before. Set `routeStyle: v1` to opt in.

`az account get-access-token` supplies the bearer for a call. Chat models registered with Pi read it through an `!az account get-access-token ...` command. Do not set `AZURE_OPENAI_API_KEY` for this workflow.

Foundry serves chat models only (for example a `gpt-6-astra` deployment as an advisor).

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

The gateway authenticates with `Authorization: Bearer <VERCEL_OIDC_TOKEN>`. The token comes from the `VERCEL_OIDC_TOKEN` environment variable or from `envFile` inside `projectDir`. The expiry is read from the token's `exp` claim (not verified; Vercel verifies it). If the token is missing or has less than 10 minutes left, the extension runs `vercel env pull .env.local --yes` in `projectDir` (an argument array, no shell) and reads the file again. Tokens last about 12 hours. The token is cached in memory until it nears expiry and is never logged, written to config, or put in a task file. Model ids are `creator/model`, for example `anthropic/claude-haiku-5-5`.

`/auth status` reports Vercel. `/auth login vercel` prints `vercel login && vercel link`. The ignore rules should already cover `.env.local`; check that yours do.

## Tiers and who serves them

Each tier lists candidate models under `tiers:` in the config. The runtime picks within a tier; the tier itself is still chosen by the deterministic policy.

| Tier | Candidates (sample config) |
|---|---|
| deterministic | Local OpenAI-compatible model (`qwen2.5-coder:7b`) if configured and reachable; otherwise the plan's literal edits with no model |
| cheap (`session.compactionTier`) | Claude Haiku `claude-haiku-5-5` (Anthropic account login). Compaction summaries |
| batch | ChatGPT Luna `gpt-6-luna` (OpenAI account login). Standalone jobs the extension runs by itself, outside any conversation: today the one-line summaries of files a diff clip cut. A config without a `batch` list runs them on `cheap` |
| standard | Claude Sonnet `claude-sonnet-5-5`, Sol 6.1 `gpt-6.1-sol`. `/plan` and `/route` previews |
| premium (`routing.reviewTier`) | Claude Opus `claude-opus-5-5`. The `/review` model pass and the last step of the ticket ladder. The main session runs on Opus through `session.model`, not through this tier |
| ticketLow | Grok 4.7 `grok-4.7` through a SuperGrok subscription (`xai`). Tickets of difficulty `low` |
| ticketMedium | Claude Sonnet `claude-sonnet-5-5`. Difficulty `medium` |
| ticketHigh | Sol 6.1 `gpt-6.1-sol`. Difficulty `high` |
| advisor (on demand) | GPT Astra `gpt-6-astra` (OpenAI, then a Foundry deployment), then Claude Fable `claude-fable-5-1`. Consulted on every plan (`plan_consult`, both), by `/build`'s per-ticket review (medium: one, high: both) and by `/review` (by the branch's highest ticket difficulty). Astra is $0 on a ChatGPT subscription; Fable is billed per token on an API key |

**Built-in tiers.** With no `tiers:` in any config, every tier above uses the sample config's candidates, so a bare user config still routes to real model ids (never an empty one). A config's `tiers` replaces the built-in list per tier. For `cheap`, `standard` and `premium`, a legacy `models:` entry whose provider names a `model` still wins over the built-in list. The built-in lists carry no prices: the runtime never prices from source. When the effective config has no `pricing` row for a tier's models, `/status` and session start show one warning, "No pricing rows for <models>: their cost is unknown. Copy the sample .pi-workflows/config.yaml (or run the init command) to price them.", and those models rank last as `price_unknown`. A tier with no usable model (an empty model id is dropped) moves up the ladder; if nothing is usable the route stops with "No model configured for tier <tier>; add tiers.<tier> to your config."

Who does what, by default: the main session runs on Opus (`session.model`); Haiku writes compaction summaries and Luna the standalone batch jobs; `/build` tickets go to Grok, Sonnet or Sol by difficulty and climb one step on each failure (Grok, Sonnet, Sol, Opus); `/review` asks Opus.

```yaml
tiers:
  cheap:
    - { provider: anthropic, model: claude-haiku-5-5 }
  batch:
    - { provider: openai, model: gpt-6-luna }
```

The old `models: { cheap: foundry, ... }` map still works. Each entry becomes a one-candidate tier. A tier listed under `tiers` replaces its `models` entry. `deterministic` and `advisor` exist only under `tiers`; `batch` falls back to `cheap` when it is not listed.

How a candidate is picked:

1. Filter out candidates that the org allowlist or `proprietaryCode` excludes, whose own circuit breaker is open, whose expected cost exceeds the remaining task or daily budget, and whose provider is not signed in. For the deterministic tier an unreachable local server also excludes it (a cached `GET <baseUrl>/models` with a short timeout). If no provider is signed in for a tier, the choice ignores sign-in so the usual "run /login" pause appears instead of a silent escalation to a dearer tier.
2. Score each remaining candidate as expected cost per success: its price times the expected token mix (`workers.tokenBudget`, 4:1 input to output), plus its quota shadow price (below) and `routing.attemptOverheadUsd` (default 0.02, ranking only: the time and retry cost of a failed attempt, so a $0 model with a poor record does not always win), divided by its success probability (floored at 0.05). The probability is a Thompson sample from Beta(1 + successes, 1 + failures) for that task type and model, so a new or unlucky model still gets tried now and then.
3. The lowest score wins. Ties go to config order. A candidate with no `pricing` row ranks after priced ones and the decision is flagged `price_unknown`.
4. If every candidate is excluded, the policy moves to the next tier, or stops with a clear reason (`/build` stops with `NO_CANDIDATE`).

Successes and failures are recorded per task type, tier, and model next to the old per-tier counters, which still drive the circuit breaker. The advisory model pass of `/review` is recorded under its own task type (`review:<task type>`), so review failures never count against a model's record for implementation work.

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

- **Shadow cost.** For one task the shadow cost is `workers.tokenBudget` tokens at `perMillionTokensUsd`. It is added to the real expected cost when the selector scores candidates within a tier, and when the policy compares proven tiers for `/build`. When a soft budget keeps only the cheapest candidate of a chat tier, the real price decides and the shadow price only breaks ties. A model without a `quota.models` row has no shadow cost.
- **Ranking only.** Shadow prices (and `routing.attemptOverheadUsd`) never reach the ledger's `actualUsd`, the task or daily budget, or the over-budget filter. A $0 subscription model stays eligible when the budget is spent, whatever its shadow price. `expectedUsd` in a routing decision is the real cost. A model still needs a `pricing` row: a quota weight does not make an unpriced model priced.
- **Soft caps.** Quota use per provider is the sum of the reported tokens (input, output, cache read, and cache write) in the ledger, for the budget day (UTC, like `dailyUsd`) and for the rolling seven days. Unknown token counts add nothing. At or over a provider's `dailyTokens` or `weeklyTokens`, its shadow prices are multiplied by `overCapMultiplier`, which pushes work to the other provider or to metered models. A cap never blocks a call, and the decision reason notes "over quota cap" when an over-cap model still wins.
- **Tier choice is unchanged.** Hard and security-sensitive work still goes to `premium` by policy. The shadow price only decides which premium model serves it, for example Sol over Opus when Anthropic is over its cap.
- **Layering.** `quota` is a ranking preference, not a policy field, so a project file overrides the user file per model row and per provider cap.
- `/cost` lists quota use per provider (tokens today and this week, against any caps), apart from billed spend. `/cost json` includes it as `quota`. Each `route` event shows the shadow part of each candidate's score.

### Showing the chosen model

Every routing decision (`/plan`, each `/build` ticket and escalation, `/review`, `/route`, `/advisor`) sets a status line, for example `standard → foundry/grok-4-7 · lowest expected cost per success ...`, adds a `route` event to the task's `events.jsonl` with the tier, model, reason and the score or exclusion of each candidate, and shows up in `/status` and `/cost` with per-model spend and success counts.

### The main session

The main session is a normal Pi model, not a router. There is no virtual model: `/model` lists the models Pi has, and the one you chat with is the one Pi shows in its footer.

- **Pinned model.** On `session_start`, when `session.pin` is on (the default), the extension sets `session.model` (default `anthropic/claude-opus-5-5`) if the session started on another model, through `pi.setModel(registry.find(...))`. If the model cannot be found, or Pi refuses the switch (no login), you get one warning and the session stays as it is. With `session.pin: false` the extension never changes your model. A model that `/build` has set for a ticket's fresh session takes precedence, and `/build` puts `session.model` back when it finishes (with pinning off: the model you were on before it started).
- **Compaction on a cheap tier.** A `session_before_compact` hook sends the messages Pi is about to discard to a model of `session.compactionTier` (default `cheap`, Haiku in the sample) through Pi's model registry, and returns that summary to Pi. The prompt asks for the goal, decisions, file paths, open tasks and errors, folds in the earlier summary, and follows `/compact <instructions>` when you give any. The call is ledgered with reason `compaction`. If no candidate is signed in, the call fails, the reply is empty, or the budget is hard, the hook returns nothing and Pi compacts with the session model as usual. It never throws.
- **Budget gate.** An `input` hook checks the budget before a prompt reaches the model. On a hard budget (task or daily) a prompt is refused with "Task or daily budget is exhausted. Run /cost for details." and never sent. Commands that start with `/` always pass, so `/cost`, `/status` and the rest still work, and so does input an extension sent itself (`/build` and `/plan` check the budget on their own). On a soft budget you get one warning per session and the prompt goes through. Spend of the main session is ledgered from each assistant message (`message_end`), as before.

### Advisor

`/advisor <question>` asks the advisor tier one question. It checks the budget first, builds a redacted context of at most 8,000 characters (task request, plan summary, classification, last failure, diff stat), picks a candidate with the same selector, ledgers the call with reason `advisor`, and prints the answer. It never changes the task phase and never edits files. Pi only suggests it, after a security-sensitive plan. The suggestion is a notification ("Consider /advisor ..."); the model is never called without the command.

### Classification

No model classifies a task. The classification (`task_type`, `complexity`, `risk`, security flag) decides premium review, human approval and where a ticket starts, and it is built from two deterministic parts:

- **Keyword scan.** `classifyKeywords` reads text for security signals (one strong keyword such as authentication, secrets, credentials or production deployment, or two weaker ones such as token plus session). A hit gives a security-sensitive, high-risk task; otherwise a general, medium one. The request gets this scan when `/plan` starts. `/route` uses it alone and says that the planner sets complexity during `/plan`.
- **The planner's rating.** `plan_spec` carries `complexity`, `risk` (low, medium or high), `securitySensitive` and a one-sentence `classificationReason`, which the planning model (Opus) fills. When the spec is saved they become the task's classification with source `planner`, and the plan's route is recomputed. `securitySensitive` is the planner's value OR a strong-keyword scan of the request and the spec (summary, approach, file changes and risks); weak keywords alone (token, session, production) do not overrule the planner. The scan can only raise the flag: if it finds a strong hit, the task is security-sensitive and high risk whatever the planner said, and `plan_spec` says so in its reply. A spec saved without a rating keeps the classification the task has.

`/status` shows who rated the task and how. `/advisor` and the review route read the same classification.

### Where model calls come from

OpenAI, Anthropic, Foundry, Vercel, and local chat models are called through Pi's model registry, which owns authentication. OpenAI and Anthropic calls are refused unless the registry is using an account login. Foundry, Vercel, and local models are registered with `pi.registerProvider` at session start, with credentials from `!command` values (the Azure CLI token, or a read of the pulled Vercel env file), so no token is held in config.

`/build` does not call a model itself. It picks the model for each ticket, switches a fresh Pi session to it, and the session's normal turn does the work, so Pi's tools and your login apply. `/review` calls the review-tier model once (in parts for a large diff) through the registry for the advisory pass.

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

Any command runs except destructive ones (`rm -rf`, force push, `reset --hard`, piping a download into a shell), which are refused. There is no allowlist.

```text
/plan Harden the ingest parser: reject empty events. AC: empty input throws
/build
/review
# then push and open the PR yourself:
git push -u origin HEAD
origin pr create   # or: gh pr create
```

Three commands. `/show-plan` re-reads the plan, and approves a draft you saved earlier.

### /plan

`/plan <request>` runs in your normal Pi session on the session model (Opus by default), with read-only tools (read, grep, find, ls, read-only bash, `web_search`, `web_fetch`) plus the plan tools (`plan_questions`, `plan_spec`, `plan_consult`, `plan_tickets`). It edits nothing. If the active task is finished (every ticket built, or an old file in `PUBLISHED`, `AUTOPILOT`, or `MERGE_READY`), a new `/plan` closes it first with a `Closed <task>.` chat line. A task with unfinished tickets is revised instead.

1. **Interview.** The model looks up facts itself and asks you only decisions, through `plan_questions`, in rounds. A round holds every question whose prerequisites are settled (`dependsOn` answered); dependent questions wait for the next round. There are 3 to 7 questions in total (fewer for small tasks), and the tool rejects a round that would pass 7. Each question has 2 to 4 options, one marked `★ Recommended — <reason>` and preselected, and an `Other (type answer)` choice. Press `a` to accept every recommendation in the round. With no UI the recommendations are recorded as the answers. Answers go to `.pi-workflows/tasks/<id>/interview.json` with one `decision` event each, and the interview resumes after a restart (run `/plan` again). The status line reads `plan · interview round N (k/7 questions)`.
2. **Spec.** The model reads the code that will change, then saves `spec.md` with `plan_spec`: a technical implementation plan (summary, current context, approach with types and signatures, every file to change and how, what to reuse, decisions, assumptions, out of scope, risks, and verification steps) and rates the task (`complexity`, `risk`, `securitySensitive`, `classificationReason`; see [Classification](#classification)). Code rejects a spec without an approach, file changes, or verification.
3. **Tickets.** The model submits vertical, independently testable slices with `plan_tickets`. Code validates unique ids, existing blockers, no cycles, at least one acceptance criterion, and that each ticket fits `workers.ticketContextTokens` (the larger of the model's estimate and a code estimate of chars/4 plus listed file sizes plus 20K overhead). An oversize ticket is sent back to be split. A ticket's `checks` are command lines, one command per entry, never prose. `plan_tickets` rejects a check the deny rules would refuse, and one whose first word is not a command on `PATH`, so the planner rewrites it. Each ticket carries technical `implementation` steps beside its behavior and acceptance criteria. Before submitting, the model drafts the tickets and calls `plan_consult` (next step).
4. **Advisor consult.** `plan_consult` takes the draft `tickets` (same schema as `plan_tickets`, validated the same way) and 2-3 specific `questions` about the riskiest parts. It puts them to every available advisor, one per provider (Astra and Fable in the sample config), in parallel. Each advisor sees the saved spec (clipped), the draft tickets rendered compactly and the questions, never the session transcript, and answers with a verdict, answers and concerns. The answers are stored on the task (`planning.consult`) and returned to the model, which must resolve any disagreement itself and then call `plan_tickets` with the final tickets and `advisorResolution`: what it accepted, what it rejected, and why. The consult stores a sha256 of the spec and the canonical draft tickets. A second call with the same hash returns the stored answers with no model calls; one with changed tickets runs a new, deliberately paid consult, at most `advisors.maxPlanConsults` (default 2) per plan version, after which the latest stored answers are returned with a note. Parallel calls pay once. `plan_tickets` refuses tickets whose hash differs from the consult's ("The tickets changed since plan_consult; call plan_consult again...") unless the model sets `reconsultWaived: true` and says in `advisorResolution` why the change needs no new advice; the waiver is recorded on the plan and shown in the Advisor review section. A revision after **Request changes** is a new draft that may consult again. When advisors are available (`advisors.plan`, default true), `plan_tickets` refuses with "Call plan_consult first" until a consult exists and requires a non-empty `advisorResolution`; with no advisor available, or when the budget skipped them, it requires neither and the plan notes that. Advisors advise and never gate; the plan is still yours to approve.
5. **Review screen.** You see the full plan (spec and every ticket) in a scrollable review. The Tickets section opens with a summary table (`#`, `Ticket`, `Difficulty`, `Implementer`, `Advisors`, `Blocked by`): the implementer is the first model of the ticket's difficulty tier and the advisors are those the per-ticket review will consult (none for low, one other-provider advisor for medium, both for high). Each ticket heading carries its difficulty (`### 01 · medium · Title`), and the `plan_tickets` result the model summarizes from includes the same table. The review is scrollable and choose **Approve plan**, **Request changes** (typed feedback goes back to the model), **Edit tickets**, or **Save as draft**. Esc also saves a draft. The plan opens with an **Advisor review** section: each advisor's verdict and concerns (labelled by model), any errors, then `Opus resolution: ...`. Approving freezes `plan.vN.approved.json` (write-once). The plan is also posted in the chat and written to `tasks/<id>/plan.md`, and each ticket to `tasks/<id>/tickets/NN-slug.md`. A material scope change needs a new approval.

`/show-plan` prints the plan. For a draft it opens the same review (Approve plan, Request changes, Close), so you can approve later.

`/plan --no-questions <request>` skips the interview: the model records the choices it would have recommended as assumptions in the spec. A request that contains a literal ```` ```tasks ```` block is drafted directly (`plan.md`, `plan.json`, no model turn). Such a plan has no tickets, so `/build` asks you to run `/plan` again.

### /build

`/build` runs the approved tickets one at a time. It refuses a plan that is not approved, a plan with no tickets, a budget that is already spent, and (for a security-sensitive plan) asks you to confirm first. It does not run in the background: it holds the Pi command until it finishes or stops.

**Branch.** On the default branch (`origin/HEAD`, else `main` or `master`) it creates `<branchPrefix>/<task-id>` and switches to it. On any other branch it builds there. The branch, base, and base SHA are recorded in the task. A fresh build with uncommitted changes (outside `.pi-workflows/`) lists them and asks whether to commit them first as a separate "Changes before /build" commit on the build branch, so they do not land in ticket 01's commit. Answer no (or run without a UI) and it refuses with `DIRTY_TREE`. Commits are authored with your git identity; `pi-conductor <pi-conductor@localhost>` is used only when git has no name or email configured. Running `/build` from a different branch than the recorded one is refused with the `git switch` to run.

**Per ticket**, in dependency order (`blockedBy`):

1. **Route.** The ticket is routed with purpose `implement` to the tier of its `difficulty` (`low` to `ticketLow`, `medium` to `ticketMedium`, `high` to `ticketHigh`). The planner sets `difficulty` on each ticket: low is mechanical or small and well specified, medium is typical feature work, high is cross-cutting, tricky logic, concurrency, or a large blast radius, and includes anything that touches auth, secrets, untrusted input, or egress. An old plan with only `suggestedTier` maps deterministic and cheap to low, standard to medium, premium to high, and none to medium; `difficulty` wins when both are present. The difficulty alone picks the implementer: a security-sensitive plan does not raise a ticket above its own tier (the planner is told to rate security-heavy tickets high). Security still asks you to confirm before `/build` and keeps `/review` and the per-ticket review on Opus. After a failure the ticket moves one step up the ladder `ticketLow`, `ticketMedium`, `ticketHigh`, `premium`. The selector picks the model within the tier, and a tier with no usable model, an open circuit, or a provider that is not signed in moves up the same ladder. The status line shows the choice and a `route` event is logged.
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

**Resume.** Run `/build` again at any time. Done tickets are skipped. A `failed` ticket with changes in the tree has its checks re-run first: if you fixed it by hand in the chat and they pass, the same per-ticket review runs on the change (with no implementer, so no model is credited or struck), and it is committed without a model turn only if that review passes. A hand fix the review fails stays `failed`, and the next model attempt, one tier up, gets the findings. A ticket you aborted (an `in-progress` ticket) resumes on the tier it was on: it never escalates or restarts at its difficulty tier, and `routing.maxEscalations` and the review's two rounds are counted per tier, so aborting and resuming cannot buy more of either. A ticket whose review failed is not committed this way: it goes one tier up. Otherwise it goes to a model again, one tier up, until `routing.maxEscalations` is used up. A hard budget starts no new ticket and says so.

### /review

`/review` reviews what differs from the base branch, lists the findings, and offers to fix them in the current session. It never commits, pushes, switches branches, or opens a pull request: you do that with git and the `origin` CLI (or `gh`). It works after `/build`, after ad-hoc fixes made in the chat, with uncommitted edits, and with no task at all (the report goes under `.pi-workflows/reports/` and spend under task `session`).

- **Base and diff.** The base is the build's recorded base, else the default branch. The diff is the commits ahead of the merge-base plus uncommitted and untracked changes. On the base branch itself it is the uncommitted changes plus any commits ahead of `origin/<base>` (just the uncommitted changes when that ref does not exist). With nothing changed it says "Nothing to review" and stops.
- **Review**, in the repo root: `setup`, then the checks (`config.checks`, else the plan's ticket checks), then a static scan (secrets, auth bypass, `eval`, TODO/FIXME), then an advisory model pass.
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
| # | Severity | Where | Finding | Raised by | Opus |
| --- | --- | --- | --- | --- | --- |
| 1 | HIGH | package.json | tsx is not in devDependencies | Opus | Astra agrees |
| 2 | MEDIUM | tests/evidence.test.ts | SSRF tests cover 127.0.0.1 only | Fable | accepts |
| – | LOW | tsconfig.json | tests/ not type-checked | Astra | rejects: tests run under tsx |
```

- **Live progress line.** While `/review` works, one line above the editor shows what is running and for how long, for example `⠹ Review · model review part 2/3 · anthropic/claude-opus-5-5 · 1m12s` (Pi's own spinner only shows while a model streams). It follows setup, each check, the static scan, each model-review part and retry, the advisors, the resolve step and the cut-file summaries, and goes away when the report is posted. `/build` shows the same line between a ticket's turns (`Build · ticket 02 · checks`, `· Opus review`, `· advisors · Astra`, `· resolving`, `· committing`) and hides it while the ticket's own session streams. Without a UI there is no line.
- **Findings and fixes.** With a UI and at least one finding, a scrollable dialog titled `Review · N finding(s)` shows the same Findings table with the same numbers: static blocking findings, failed checks (Where is the command), static suggestions, then the model findings. The accepted model findings are the numbered ones, with who raised each and what Opus or the advisors said (`Astra agrees`, `accepts`). Findings Opus rejected, and advisor concerns it could not weigh, are rows numbered `–` (`rejects: <reason>`); **Fix…** can still refer to them by text. Choose **Fix all** to send the numbered findings to the model in this session, **Fix…** to type which to fix (numbers like `1, 3` and/or your own instructions; the full list, rejected findings included, goes along for reference), or **Close**. The message tells the model to keep changes scoped, run the checks, not commit, push, or switch branches, and report one line per finding. Run `/review` again when it is done. With no UI you get the report only. With no findings and a pass, there is no dialog.

### Other commands

`/route <task>` previews tier, provider, and expected cost, plus who serves chat, direct calls, review and each ticket difficulty, and writes nothing. `/status` shows the same routing summary, phase, approval, the build branch and ticket progress, budget, auth, and config warnings. `/cost`, `/cost json`, and `/cost csv` show the ledger.

## Cost

Every model call the workflow records goes to `.pi-workflows/cost/ledger.jsonl`: provider, model, input, output, cache tokens, requests, estimated and actual charge, phase, retries, and outcome.

Prices live only in `pricing:` rows with `effectiveFrom`. There is no price table in source. A missing price or missing token count is an unknown charge (`actualUsd: null`, `usageKnown: false`), not zero. A deterministic step that made no model call is a known zero.

Budgets in the sample (`taskUsd: 20`, `dailyUsd: 75`) are operator limits, not prices. Known spend at or above the limit is a hard stop. Known spend at or above `softWarningRatio` (default 0.8) is a warning. Unknown rows are never added in as zero: a row with token counts is estimated at the provider's dearest configured price, and a row with nothing to price it from (for example a call whose usage was lost) counts as `budgets.unknownCallUsd` (default 0.05, at least 0; a project can only raise it). The estimate lives in budget math only: the ledger keeps `actualUsd: null` and `/cost` still lists those rows as unknown, with a count. An unknown row no longer makes the budget soft by itself.

`/cost` also names models seen in the ledger that have no pricing row: their spend is unknown and estimated at the provider's dearest row for its current billing (subscription rows while on account login), which keeps the budget "soft", so add a row for each. Failures before any model request (a git error, a plan cycle) are ledgered as a known $0 and do not count against the model, and the classifier never calls a provider that is not signed in (keywords are used instead).

`/cost json` is the dashboard source. `compareBaseline` in `src/cost/ledger.ts` diffs this workflow against a Cursor Auto sample you supply (cost per merged PR, time to merge-ready, success rate, retries, regressions, interventions). The repo does not invent a Cursor Auto number.

**Review and advisor cost.** Each ticket costs its implementer turns plus one Opus review call, a second Opus call when advisors answered, and the advisors. Prices come from `pricing` rows like every other call, and an unknown price stays unknown. Astra is $0 on a ChatGPT subscription (a Foundry deployment of it is billed per token); Fable is billed per token on an Anthropic API key (it needs `providers.anthropic.apiKeyFallback: true` in the user config and a `billing: api-key` row), so high tickets, which always consult both advisors, are where the advisor spend shows up. The split is in the build table, `/status` and `tickets.jsonl`.

Routing keeps a rolling success table in `.pi-workflows/metrics/success.json`. `/build` starts each ticket at its difficulty tier and climbs one step per failure, at most `routing.maxEscalations` steps (default 3, so the full ladder fits), never past `maxTier`. Three failures and zero successes in a task class open the circuit breaker.

## Web tools

The extension registers two tools for the model to call.

- `web_search` runs Anthropic's server-side `web_search_20250305` tool through Claude Haiku 5.5 (`claude-haiku-5-5`), using your Anthropic account login (`/login anthropic`). API keys are not accepted. It is refused when the task or daily budget is exhausted. Each call is written to the cost ledger (tier `web_search`, no query text) and the status line shows `anthropic/claude-haiku-5-5 · web_search`. Anthropic's per-search fee is not priced: `pricing:` rows only hold token prices, so only token cost is computed.
- `web_fetch` runs locally. It fetches public http(s) pages only (private, loopback, and link-local addresses are refused), converts HTML to markdown, and caps response size, redirects, and time. See `src/tools/web-fetch.ts` for the exact limits.

## Recovery

Task state is `state.json` plus an append-only `events.jsonl`. On startup the store rebuilds from the log if the snapshot is missing or torn, then rewrites the snapshot. Writes go through a temp file and rename, under a lock file. Nothing here deletes `plan.md`, the approved snapshot, or reports.

- **Esc during `/build`.** The build stops after the current turn. The ticket stays in progress and nothing is committed. Run `/build` to continue.
- **A failed ticket.** `/build` stops and says why. Fix it in the chat (the working tree keeps the failed attempt), then run `/build`: the checks run again, and if they pass your fix is committed and the build goes on. If you change nothing, the ticket goes to a model one step up the ticket ladder. A new plan version keeps the runs of tickets whose text is unchanged and builds the rest again.
- **A failed `/review`.** Choose Fix all (or Fix…) in the findings dialog, or fix by hand, then run `/review` again. `/review` commits and pushes nothing.
- **A crash or closed Pi.** Commits already made stay on the branch. `/build` resumes from the first ticket that is not done. It needs you on the recorded branch, and says which `git switch` to run if you are not.
- **An expired login** pauses the task. Rate-limit and outage errors from the Foundry and local clients surface as provider errors and do not rewrite policy.
- **Old task files** that still have worktree, integration, or autopilot fields, or a retired phase, still load; those fields are ignored.

## Commands

| Command | Effect |
|---|---|
| `/plan [--no-questions] <request>` | Interview (3-7 decisions with recommendations), spec, tickets, then a review screen to approve, change, edit, or save as a draft. No edits |
| `/show-plan` | Show the full plan. A draft opens the review so you can approve it |
| `/build` | Approved plan only. Each ticket in a fresh session on a routed model, then checks, then an Opus review (with advisors for medium and high tickets), then a commit, on one branch. Run again to resume |
| `/review` | Review the changes against the base branch (setup, checks, static scan, advisory model pass, advisors by ticket difficulty), list the findings, and offer to fix them in this session. Never commits or pushes |
| `/route <task>` | Preview routing |
| `/advisor <question>` | One question to the advisor tier. Costs money, never changes the phase |
| `/cost [json\|csv]` | Ledger versus budgets |
| `/status` | Phase, build progress, auth, budget |
| `/auth status` and `/auth login <provider>` | Credential metadata, or how to sign in |
| `/conductor` | List the commands |

`help` or `--help` on a command prints its description. Tab completion uses Pi's `getArgumentCompletions` for `/auth`, `/cost`, and `/plan`.

Phases: `IDLE → PLANNING → AWAITING_PLAN_APPROVAL → IMPLEMENTING → COMPLETE` (a new `/plan` closes a finished task). `/review` does not change the phase. `PUBLISHED` is no longer entered; a task loaded from an old file in it can still be built on (`/build` returns it to `IMPLEMENTING`) or closed. Active phases can enter `BLOCKED`, `PAUSED`, or `FAILED`. A draft never becomes a build on its own. The retired phases `REVIEWING`, `PUBLISHED`, `AWAITING_PUBLISH_APPROVAL`, `AUTOPILOT`, and `MERGE_READY` stay in the enum only so old task files load.

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

## Limitations

- No paid provider call is made by the tests. OpenAI and Anthropic transports throw unless a test injects one. Account login is verified by reading Pi 1.2.0's provider objects, not by completing a prompt.
- The `/build` loop (a fresh Pi session per ticket, the model set through `session_start`, waiting for each run to finish, Esc while the command waits) is tested with fakes only. It has not been run against a live Pi. If it deadlocks there, the fallback is one ticket per `/build`.
- `/build` runs the model in your checkout with Pi's normal tools, not in a sandbox or worktree. The `git push` and branch-switch block during a ticket is a hook on Pi's `bash` tool, and shell can hide a command from it, so review the diff. Tickets run one at a time, never in parallel.
- Pi's `/login` still offers an API-key prompt. This extension treats that credential as blocked unless the user config sets `apiKeyFallback` for that provider.
- Interactive Pi bash is denied for destructive commands (`rm -rf`, force push, piping a download into a shell, and similar). Other commands are not restricted, because that would break the host agent. Checks and setup run any non-destructive command. While `/plan` runs, bash is limited to a read-only allowlist.
- The compaction hook, the pinned session model and the input budget gate use Pi hooks (`session_before_compact`, `session_start` with `setModel`, `input`) that have been run against fakes only; see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).
- Nothing here pushes, opens a pull request, or merges. Do that yourself with git and the `origin` CLI (or `gh`).
- A plan made only of literal edits (a ```` ```tasks ```` block) has no tickets, so `/build` cannot run it.
