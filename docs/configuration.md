# Configuration

Every config file and every setting: where the files live, how a project file layers over yours, and each key with its type, default and layering rule. Then how tiers and models are chosen, and how cost is counted. Commands are in [commands.md](commands.md); provider sign-in and setup are in [providers.md](providers.md).

## Config files

| File | Scope | Notes |
|---|---|---|
| `~/.pi/agent/chef.yaml` | **User config.** Applies to every project | The base. The only file that can raise limits or set credentials, endpoints and the session model |
| `.pi-workflows/config.yaml` | **Project config.** This repo only | Layered on top of the user config. It ships with a cloned repo, so it is trusted only to tighten policy (see [How the files layer](#how-the-files-layer)) |
| `~/.pi/agent/cost-workflow.yaml` | Legacy user config | Read only when `chef.yaml` does not exist, with a warning to rename it |

- **File names and reloading.**
  - Each file may also be named `.yml`. When both exist, `.yaml` wins and a warning names the ignored file.
  - The files are read again whenever one changes, so edits apply to the next command with no restart.
- **When no file exists,** the built-in defaults below apply.
- **Creating the files.** `npx github:pkeenan87/pi-chef init` copies the sample `.pi-workflows/config.yaml` into a project; it is the best starting point because it prices every built-in model. When you have no user config, init also writes `~/.pi/agent/chef.yaml` with every personal setting commented out at its default (the template is `templates/chef.yaml`): uncomment a line and its section header to change it. A file that is empty or all comments loads as an empty config.
- **No secrets.** No file may contain a secret, API key or token: a file that does is rejected. Credentials stay with Pi (`/login`), `az`, the Vercel CLI, or an environment variable you name.

Other files pi-chef reads that are not its config:

- Pi's `~/.pi/agent/auth.json`: account logins, read-only.
- The env file `vercel env pull` writes (`providers.vercel.envFile`).
- The environment variables you name in `providers.foundry.endpointEnv` and `providers.local.apiKeyEnv`.

**Errors.** Session start shows every config problem as a warning, redacted, naming the file and the key. `/status` repeats them under Warnings.

- **Dropped with a warning while the rest of the file loads:**
  - a bad `tiers.<name>` (the built-in list applies);
  - a bad `session` or `quota` section (the defaults apply);
  - a tier that names an undefined provider.
- **The whole file is rejected,** and pi-chef commands stop until it is fixed, for:
  - unreadable YAML or a secret;
  - `approvals.merge` other than `manual`;
  - an invalid provider, budget or routing value;
  - `proprietaryCode` without `orgProviderAllowlist`.

## How the files layer

The user file is the base and the project file is laid over it. Each key below lists its rule:

| Rule | Meaning |
|---|---|
| **project wins** | A value in the project file replaces the user's |
| **merged** | A section merged key by key, the project winning per key. Keys you do not set keep the user's value |
| **replaced** | The project's whole value replaces the user's. Keys the project leaves out take the built-in default, not the user's value |
| **lower wins** / **higher wins** | The stricter of the two. When the user sets nothing, the project is compared with the built-in default |
| **off only** | A project can turn the switch off, never on |
| **user only** | Read from the user file only; a project value is ignored with a warning |

For example, to raise `budgets.taskUsd` you raise it in `~/.pi/agent/chef.yaml` and also raise or remove it in the project file, because the lower of the two wins.

## Settings reference

Every key the loader reads.

- **Types:** `int` is an integer, `USD` a number in dollars, and `ms` milliseconds.
- **"Project"** is the layering rule above.
- **Built-in default:** a key you do not set uses it.

### Top level

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `workspaceDir` | path | `.pi-workflows` | user only | Where task state, the cost ledger, metrics and reports live, relative to the project root |
| `branchPrefix` | branch-name prefix | `chef` | project wins | `/build` creates `<branchPrefix>/<task name>` when it starts from the default branch |
| `orgProviderAllowlist` | list of providers | `[]` (all) | restricts only | Providers any route or advisor may use. Empty means all. A project list can restrict an empty user list; once the user names providers, the user's list is final |
| `proprietaryCode` | bool | `false` | on if either sets it | Marks the code proprietary: only allowlisted providers may see it. Requires `orgProviderAllowlist` |
| `checks` | list of commands | `[]` | replaced | The commands that verify work: run by `/review`, and by `/build` for a ticket with no checks of its own. Each entry is `{ name, command, args }` |
| `setup` | list of commands | `[]` | replaced | Same shape. Runs once per build before the first checks, and before every `/review`'s checks (an install, for example) |
| `schemaVersion` | — | `1` | — | Accepted and ignored |

Each `checks` / `setup` entry:

| Key | Type | What it is |
|---|---|---|
| `name` | string | Label in reports |
| `command` | string | The program, on `PATH` or a path |
| `args` | list of strings | Its arguments |

- **Execution.** Commands run in the repo root with no shell, so `&&`, pipes, redirects and globs do not work.
- **Refused:** destructive commands, such as `rm -rf`, a force push, `reset --hard`, or piping a download into a shell.
- **Limits.** A command is stopped after 30 minutes or 64 MB of output.

### session

The main chat session: a normal Pi model.

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `session.model` | `provider/id` | `anthropic/claude-opus-5-5` | user only | The session's model. Set at session start when `pin` is on |
| `session.pin` | bool | `true` | may only set `false` | Switch the session to `session.model` at session start. `false` leaves the model you chose with `/model`, and `/build` puts that model back when it finishes |
| `session.compactionTier` | `cheap` \| `standard` \| `premium` | `cheap` | user only | Tier that writes compaction summaries. If none can, Pi compacts on the session model |

### localMode

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `localMode.default` | bool | `false` | merged | Make every `/plan` local, unless `--cloud` is passed. The model is `tiers.local`; the ticket limits come from its tag and `contextWindow` ([Local mode](../README.md#local-mode)) |
| `localMode.difficulties` | list of `low`, `medium` | unset (every ticket) | merged | A hybrid local plan: only tickets of these difficulties go to the local model, held to the local ticket rules; the others are written and built as cloud tickets on `ticketLow`/`ticketMedium`/`ticketHigh`. Capped by the model's size (a model under 14B takes `low` only); if the size rules out every listed difficulty, `/plan` plans in the cloud and says so. Fixed for the task at `/plan` |

### workers

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `workers.tokenBudget` | number > 0 | `8000` | merged | The tokens one call is priced at when ranking models (4 input to 1 output) |
| `workers.ticketContextTokens` | int ≥ 20000 | `150000` | merged | The context size one cloud ticket must fit. `plan_tickets` sends back a ticket estimated above it. Local tickets use half the local model's `contextWindow` instead |

### budgets

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `budgets.taskUsd` | USD > 0 | `20` | lower wins | Hard limit on one task's spend. At it, no prompt, ticket or advisor call starts |
| `budgets.dailyUsd` | USD > 0 | `75` | lower wins | Hard limit on all spend today |
| `budgets.softWarningRatio` | 0 to 1 | `0.8` | lower wins | Warn once a budget reaches this share. Above it, advisors and batch summaries are skipped |
| `budgets.unknownCallUsd` | USD ≥ 0 | `0.05` | higher wins | What one call with an unknown cost and nothing to price it from counts as, in budget math only. The ledger keeps it as unknown |

Unknown cost is never counted as $0: a call with token counts but no price is estimated at the provider's dearest configured price.

### approvals

| Key | Allowed | Default | What it does |
|---|---|---|---|
| `approvals.plan` | `required` | `required` | A plan must be approved before `/build`. Cannot be changed |
| `approvals.merge` | `manual` | `manual` | Nothing merges, pushes or opens a PR. Any other value rejects the file |

### routing

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `routing.selection` | `ordered` \| `adaptive` | `ordered` | merged | How a tier picks its model. `ordered`: the first usable entry in the tier's list, so later entries are fallbacks. `adaptive`: the lowest expected cost per success, with Thompson sampling (the choice varies) |
| `routing.maxEscalations` | int ≥ 0 | `3` | merged | Tier steps a failed ticket may climb from its difficulty tier |
| `routing.maxTier` | a tier, not `batch` | `premium` | merged | The highest tier any route may use. A ticket still failing there stops with `MAX_ESCALATIONS` |
| `routing.reviewTier` | `cheap` \| `standard` \| `premium` | `premium` | user only | Tier of the per-ticket review that gates each commit, and of `/review`'s model pass |
| `routing.requirePremiumReviewFor` | list of strings | `auth`, `permissions`, `secrets`, `security-sensitive` | adds to the user's list | Task types and capabilities whose review always runs on premium and that need your confirmation before `/build` |
| `routing.circuitBreakerFailures` | int ≥ 1 | `3` | lower wins | Failures with no success, per task type and tier, that open the tier's circuit: it is skipped and routing moves up |
| `routing.attemptOverheadUsd` | USD ≥ 0 | `0.02` | merged | Ranking only, in `adaptive` selection: added to each model's price before dividing by its success rate. Never billed |

### tiers

Which models serve each job. Each tier is a list of candidates in preference order. A tier you list replaces the built-in list for that tier only (merged per tier: a project's list replaces the user's). Tiers you do not list keep the built-in models (see [Tiers and who serves them](#tiers-and-who-serves-them)).

| Tier | Serves |
|---|---|
| `cheap` | Compaction summaries (`session.compactionTier`) and small in-session jobs |
| `standard` | The fallback for a failed `/review` part, and `routing.reviewTier` if you set it there |
| `premium` | The review gate and `/review` (`routing.reviewTier`), and the last step of the ticket ladder |
| `ticketLow`, `ticketMedium`, `ticketHigh` | `/build` tickets of difficulty low, medium and high |
| `local` | Every ticket of a local-mode task |
| `batch` | Standalone jobs, such as one-line summaries of files cut from a diff. Uses `cheap` when unset |
| `advisor` | Second opinions: `plan_consult`, high tickets' reviews, `/review`, `/advisor` |

Each candidate:

| Key | Type | Required | What it does |
|---|---|---|---|
| `provider` | `openai` \| `anthropic` \| `xai` \| `foundry` \| `vercel` \| `local` | yes | Who serves it. Account providers need a Pi login; the others need their `providers` block |
| `model` | string | yes | The model id (for Foundry, the model name; `providers.foundry.deployments` maps it to a deployment) |
| `label` | string | no | Display name in reports |
| `api` | `openai-responses` \| `openai-completions` \| `azure-openai-responses` | no, Foundry only | The wire API for this deployment, overriding `providers.foundry.api`. When tiers disagree, the first wins with a warning |
| `contextWindow` | int ≥ 4096 | no | The context window Pi is told (default 128000). Set it for local models to what the server runs, for example Ollama's `OLLAMA_CONTEXT_LENGTH` |

### providers

One block per provider, keyed `openai`, `anthropic`, `xai`, `foundry`, `vercel` or `local`.

- **Account providers** (`openai`, `anthropic`, `xai`) need no block: they use Pi's login.
- **`foundry`, `vercel` and `local`** are unavailable without their block.
- **Layering.** Blocks are merged per provider, the project winning per key, except the user-only keys below. A project value for a user-only key is accepted only when you define no block for that provider and the value is the built-in default.

Every provider:

| Key | Type | Default | What it does |
|---|---|---|---|
| `type` | string | filled in for foundry (`azure-foundry`), vercel (`vercel-ai-gateway`), local (`openai-compatible`) | Informational |
| `auth` | string | — | Must be `account-login` for openai, anthropic and xai, `azure-cli` for foundry, `vercel-cli` for vercel. Anything else rejects the file |
| `model` | string | — | Used only by the deprecated `models:` map, below |
| `piProvider` | string | — | Accepted and ignored |

**openai, anthropic, xai**

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `apiKeyFallback` | bool | `false` | user only | Use an API key saved in Pi (`/login` with a key) when no account login is present. Billed per token, so add `billing: api-key` pricing rows; without one the cost is unknown |

**foundry** (Azure AI Foundry; setup in [providers.md](providers.md#azure-cli-and-foundry-deployments))

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `endpoint` | https URL | — | user only | The resource endpoint, for example `https://<resource>.services.ai.azure.com` |
| `endpointEnv` | env var name | — | user only (the sample's `AZURE_AI_ENDPOINT` is allowed when you define no block) | A variable holding the endpoint; wins over `endpoint`. Its value must be https |
| `audience` | https URL | `https://ai.azure.com` | user only | The token audience `az account get-access-token` is asked for |
| `api` | `openai-completions` \| `openai-responses` \| `azure-openai-responses` | `openai-completions` | merged | Default wire API for every deployment |
| `deployments` | map: model → deployment name | — | merged per model | Calls a tier model under your Azure deployment's name. Routing, metrics and pricing keep the model name |
| `routeStyle` | `v1` \| `deployments` | `v1`, or `deployments` when `apiVersion` is set | merged | `v1`: `<endpoint>/openai/v1/…`. `deployments`: the legacy per-deployment route |
| `apiVersion` | string | — | merged | `api-version` for the legacy `deployments` route |
| `resourceGroup` | Azure resource group | — | user only | Lets `/status foundry` list your deployments |

**vercel** (Vercel AI Gateway; setup in [providers.md](providers.md#vercel-cli-and-ai-gateway))

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `projectDir` | path | — (the sample's `.` is allowed when you define no block) | user only | A directory you ran `vercel link` in; `vercel env pull` runs there |
| `envFile` | relative file name | `.env.local` | user only | The file `vercel env pull` writes the token to, and Pi reads it from |
| `baseUrl` | https URL | `https://ai-gateway.vercel.sh/v1` | user only | The gateway URL |

**local** (an OpenAI-compatible server such as Ollama; setup in [providers.md](providers.md#local-inference))

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `baseUrl` | URL | — (required) | user only (a loopback URL is allowed when you define no block) | The server, for example `http://127.0.0.1:11434/v1`. `http` is allowed only for localhost |
| `apiKeyEnv` | env var name | — | user only | A variable holding the server's key, if it needs one |

### review

The model pass of `/review`. Replaced as a whole by a project's `review`: keys it leaves out take the defaults.

| Key | Type | Default | What it does |
|---|---|---|---|
| `review.model` | bool | `true` | Run the advisory model pass |
| `review.maxDiffChars` | int ≥ 1000 | `120000` | The diff size of one review call. A larger diff is split at file boundaries |
| `review.maxChunks` | int ≥ 1 | `6` | At most this many calls; the parts beyond them are listed as not reviewed |
| `review.timeoutMs` | ms ≥ 1000 | `300000` | Per call |

### advisors

| Key | Type | Default | Project | What it does |
|---|---|---|---|---|
| `advisors.tickets` | bool | `true` | off only | The per-ticket review in `/build`. `false` turns the review gate and its advisors off |
| `advisors.plan` | bool | `true` | off only | `plan_consult`: advisors read the draft tickets once per plan version, and `plan_tickets` requires the planner's resolution |
| `advisors.fromDifficulty` | `medium` \| `high` | `high` | can only raise to `high` | The lowest ticket difficulty that gets advisors. `high`: high tickets consult every advisor, others none. `medium`: medium tickets, and ad-hoc branches over `adHocMinLines`, also get one advisor from another vendor |
| `advisors.adHocMinLines` | int ≥ 0 | `400` | higher wins | With `fromDifficulty: medium`, a branch with no plan gets an advisor in `/review` above this many changed lines |
| `advisors.summarizeCut` | bool | `true` | off only | When a diff is clipped for an advisor, the batch tier writes a one-line summary of each cut file |
| `advisors.maxPlanConsults` | int ≥ 1 | `2` | lower wins | Plan consults per draft version |
| `advisors.maxDiffChars` | int ≥ 1000 | `40000` | lower wins | The diff sent to the reviewer and advisors; the rest is listed as cut |
| `advisors.maxOutputTokens` | int ≥ 100 | `1500` | lower wins | The answer length an advisor is asked to stay within |
| `advisors.timeoutMs` | ms ≥ 1000 | `180000` | lower wins | Per advisor or review call |

Advisors never gate: only the review model's verdict counts. They obey `orgProviderAllowlist`, `proprietaryCode`, open circuits and the budget.

### pricing

Prices per million tokens, used for the ledger, budgets and ranking.

- **Missing row:** a model with no row has an unknown cost, and ranks last as `price_unknown` in adaptive selection.
- **Exception:** a `local` model with no row is a known $0.
- **Layering:** rows from both files are combined, keyed by provider, model, date and billing. A project row cheaper than a user row for the same provider, model and billing is ignored with a warning.

| Key | Type | Required | What it does |
|---|---|---|---|
| `provider` | string | yes | |
| `model` | string | yes | For Foundry, a deployment name row wins over the model name row |
| `effectiveFrom` | `YYYY-MM-DD` | yes | The row applies from this date; the latest one on or before a call's date is used |
| `inputPerMillionUsd` | USD ≥ 0 | yes | |
| `outputPerMillionUsd` | USD ≥ 0 | yes | |
| `cacheReadPerMillionUsd` | USD ≥ 0 | no | Defaults to the input rate |
| `cacheWritePerMillionUsd` | USD ≥ 0 | no | Defaults to the input rate |
| `billing` | `api-key` | no | Prices the model while its provider runs on an API key (`apiKeyFallback`). Rows without it price the account (subscription) login, usually at $0 |

Two rows with the same provider, model, date and billing in one file reject it.

### quota

Shadow prices that steer `adaptive` selection away from scarce subscription quota. Ranking only: they never reach the ledger or budgets. The project wins key by key. A bad `quota` section is dropped with a warning.

| Key | Type | Default | What it does |
|---|---|---|---|
| `quota.models` | list of `{ provider, model, perMillionTokensUsd }` | `[]` | A ranking-only price per million tokens for a subscription model; merged by provider and model |
| `quota.providers.<provider>.dailyTokens` | int > 0 | — | A soft daily token cap |
| `quota.providers.<provider>.weeklyTokens` | int > 0 | — | A soft weekly token cap |
| `quota.overCapMultiplier` | number ≥ 1 | `4` | Multiplies a provider's shadow prices once it is at or over a cap. Nothing is blocked |

### Deprecated and removed keys

| Key | What happens |
|---|---|
| `models: { cheap \| standard \| premium: <provider> }` | Becomes a one-model tier from `providers.<provider>.model`, with a warning; use `tiers` |
| `approvals.publish`, `approvals.securitySensitiveFix` | Ignored |
| `commandAllowlist`, `worktrees.*`, `workers.concurrency`, `workers.deadlineMs`, `workers.isolatedWorktrees`, `workers.preserveUntilReviewed`, `autopilot`, `budgets.autopilotPrUsd`, `routing.sessionTier`, `routing.directTier`, `routing.minConfidence`, `providers.*.decisionsPath`, `models.classifier`, `tiers.classifier` | Ignored with a warning. An old `worktrees.branchPrefix` still names branches while `branchPrefix` is unset |
| a tier entry with `api: decisions` | Dropped with a warning |

### Environment variables

pi-chef never reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `XAI_API_KEY`. It reads only:

| Variable | Read when |
|---|---|
| the one named by `providers.foundry.endpointEnv` | Foundry is configured |
| the one named by `providers.local.apiKeyEnv` | Pi calls the local server |
| `VERCEL_OIDC_TOKEN` | Checking the Vercel token (Pi itself reads the token from `envFile`) |
| `GIT_AUTHOR_*`, `GIT_COMMITTER_*` | Deciding whether git has an identity for `/build`'s commits |

## Tiers and who serves them

Each tier lists candidate models under `tiers:` in the config. The runtime picks within a tier; the tier itself is still chosen by the deterministic policy.

| Tier | Candidates (sample config) |
|---|---|
| cheap (`session.compactionTier`) | Claude Haiku `claude-haiku-5-5` (Anthropic account login). Compaction summaries |
| batch | ChatGPT Luna `gpt-6-luna` (OpenAI account login). Standalone jobs the extension runs by itself, outside any conversation: today the one-line summaries of files a diff clip cut. A config without a `batch` list runs them on `cheap` |
| standard | Claude Sonnet `claude-sonnet-5-5`, Sol 6.1 `gpt-6.1-sol`. The fallback for a failed `/review` model part. `/plan` itself runs in your session on `session.model` |
| premium (`routing.reviewTier`) | Claude Opus `claude-opus-5-5`. The `/review` model pass and the last step of the ticket ladder. The main session runs on Opus through `session.model`, not through this tier |
| ticketLow | Grok 4.7 `grok-4.7` through a SuperGrok subscription (`xai`). Tickets of difficulty `low` |
| ticketMedium | Claude Sonnet `claude-sonnet-5-5`. Difficulty `medium` |
| ticketHigh | Sol 6.1 `gpt-6.1-sol`. Difficulty `high` |
| local | Local mode only: `local/qwen3.5:9b` (Ollama), `contextWindow: 65536`. Builds every ticket of a `/plan --local` task; its size (from the tag) and window decide how small the planner makes them. It gets three review rounds; a ticket it cannot pass is finished by `premium` (Opus), and nothing goes past that |
| advisor (on demand) | GPT Astra `gpt-6-astra` (OpenAI, then a Foundry deployment), then Claude Fable `claude-fable-5-1`. Consulted on every plan (`plan_consult`, both), by `/build`'s per-ticket review (high: both; medium: one with `advisors.fromDifficulty: medium`) and by `/review` (by the branch's highest ticket difficulty). Astra is $0 on a ChatGPT subscription; Fable is billed per token on an API key |

**Built-in tiers.** With no `tiers:` in any config, every tier above uses the sample config's candidates, so a bare user config still routes to real model ids (never an empty one). A config's `tiers` replaces the built-in list per tier. The built-in lists carry no prices: the runtime never prices from source. When the effective config has no `pricing` row for a tier's models, `/status` and session start show one warning, "No pricing rows for <models>: their cost is unknown. Copy the sample .pi-workflows/config.yaml (or run the init command) to price them.", and those models rank last as `price_unknown`. A tier with no usable model (an empty model id is dropped) moves up the ladder; if nothing is usable the route stops with "No model configured for tier <tier>; add tiers.<tier> to your config."

Who does what, by default: the main session runs on Opus (`session.model`); Haiku writes compaction summaries and Luna the standalone batch jobs; `/build` tickets go to Grok, Sonnet or Sol by difficulty and climb one step on each failure (Grok, Sonnet, Sol, Opus); `/review` asks Opus.

```yaml
tiers:
  cheap:
    - { provider: anthropic, model: claude-haiku-5-5 }
  batch:
    - { provider: openai, model: gpt-6-luna }
```

The old `models: { cheap: openai, ... }` map is deprecated and loads with a warning. A `models` entry becomes a one-candidate tier only when `providers.<name>.model` names the model (never for `foundry`, which has no single model) and `tiers` does not list that tier; otherwise it is dropped with a warning. There are no built-in `models` defaults any more, so adding a provider never invalidates a file. Use `tiers` instead.

How a candidate is picked. With `routing.selection: ordered` (the default) step 1 filters, then the first remaining candidate in the tier's listed order wins: the list is a fallback chain, and the route reason names each entry it passed over and why (`fallback 1 in the tier's order (openai/gpt-6.1-sol not signed in)`). Scores are still computed and shown in the `route` event, but they do not pick. With `routing.selection: adaptive` steps 2 and 3 pick:

1. Filter out candidates that the org allowlist or `proprietaryCode` excludes, whose own circuit breaker is open, whose expected cost exceeds the remaining task or daily budget, and whose provider is not signed in. A local candidate is also excluded while its server does not answer (a cached `GET <baseUrl>/models` with a short timeout). If no provider is signed in for a tier, the choice ignores sign-in so the usual "run /login" pause appears instead of a silent escalation to a dearer tier.
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
- **Ranking only.** Shadow prices (and `routing.attemptOverheadUsd`) never reach the ledger's `actualUsd`, the task or daily budget, or the over-budget filter. A $0 subscription model stays eligible when the budget is spent, whatever its shadow price. A model still needs a `pricing` row: a quota weight does not make an unpriced model priced.
- **Soft caps.** Quota use per provider is the sum of the reported tokens (input, output, cache read, and cache write) in the ledger, for the budget day (UTC, like `dailyUsd`) and for the rolling seven days. Unknown token counts add nothing. At or over a provider's `dailyTokens` or `weeklyTokens`, its shadow prices are multiplied by `overCapMultiplier`, which pushes work to the other provider or to metered models. A cap never blocks a call, and the decision reason notes "over quota cap" when an over-cap model still wins.
- **Tier choice is unchanged.** Hard and security-sensitive work still goes to `premium` by policy. The shadow price only decides which premium model serves it, for example Sol over Opus when Anthropic is over its cap.
- **Layering.** `quota` is a ranking preference, not a policy field, so a project file overrides the user file per model row and per provider cap.
- `/cost` lists quota use per provider (tokens today and this week, against any caps), apart from billed spend. `/cost json` includes it as `quota`. Each `route` event shows the shadow part of each candidate's score.

### Why a model is skipped

Route events, `/status` (Routing check), and the stop message of `/build` use the same wording for each skipped candidate:

| Message | What to do |
| --- | --- |
| `provider foundry is not registered (no providers.foundry in ~/.pi/agent/chef.yaml)` | Add a `providers.foundry` block to the user config. Same form for `vercel` and `local` |
| `provider foundry is not registered (providers.foundry has no endpoint; set endpoint in ~/.pi/agent/chef.yaml)` | Set `endpoint` (or export the `endpointEnv` variable) |
| `provider openai has no login (run /login openai)` | Sign in with the account. Same form for `anthropic` and `xai`; `login has expired` when the session ran out |
| `provider foundry has no Azure login (run az login)` | Run `az login` |
| `model gpt-6.1-sol is not among the foundry provider's registered models` | Pi does not know that model id. Check the tier entry |
| `deployment my-sol (mapped from gpt-6.1-sol) is not among the foundry provider's registered models` | The mapped deployment is not registered. Check `providers.foundry.deployments` and run `/status foundry` |

Routing checks every candidate the way the `/build` preflight does: Pi's model registry must know the model and hold credentials for it (`find` and `hasConfiguredAuth`), in addition to the login the auth probe sees. A candidate that fails is skipped and the next one in the tier is tried, then the next tier up the ladder. `/build` stops only when nothing is usable, and the stop lists every candidate with its own reason. A provider the config never names is still checked: an account provider needs a Pi login, and `foundry`, `vercel`, and `local` need their block.

### Showing the chosen model

Every routing decision (each `/build` ticket and escalation, `/review`, `/advisor`) adds a `route` event to the task's `events.jsonl` with the tier, model, reason and the score or exclusion of each candidate. `/status` shows each tier with the jobs it serves and the model that would run now; `/cost` shows per-model spend and success counts. Planning picks no model: it runs on `session.model`.

### The main session

The main session is a normal Pi model, not a router. There is no virtual model: `/model` lists the models Pi has, and the one you chat with is the one Pi shows in its footer.

- **Pinned model.** On `session_start`, when `session.pin` is on (the default), the extension sets `session.model` (default `anthropic/claude-opus-5-5`) if the session started on another model, through `pi.setModel(registry.find(...))`. If the model cannot be found, or Pi refuses the switch (no login), you get one warning and the session stays as it is. With `session.pin: false` the extension never changes your model. A model that `/build` has set for a ticket's fresh session takes precedence, and `/build` puts `session.model` back when it finishes (with pinning off: the model you were on before it started).
- **Compaction on a cheap tier.** A `session_before_compact` hook sends the messages Pi is about to discard to a model of `session.compactionTier` (default `cheap`, Haiku in the sample) through Pi's model registry, and returns that summary to Pi. The prompt asks for the goal, decisions, file paths, open tasks and errors, folds in the earlier summary, and follows `/compact <instructions>` when you give any. The call is ledgered with reason `compaction`. If no candidate is signed in, the call fails, the reply is empty, or the budget is hard, the hook returns nothing and Pi compacts with the session model as usual. It never throws.
- **Budget gate.** An `input` hook checks the budget before a prompt reaches the model. On a hard budget (task or daily) a prompt is refused with "Task or daily budget is exhausted. Run /cost for details." and never sent. Commands (a first word like `/cost` or `/skill:name`) always pass, so `/cost`, `/status` and the rest still work, and so does input an extension sent itself (`/build` and `/plan` check the budget on their own). A prompt that starts with a path (`/tmp/app.log shows ...`) is not a command and is refused like any other prompt. On a soft budget you get one warning per session and the prompt goes through. Spend of the main session is ledgered from each assistant message (`message_end`), as before.

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

## Cost

Every model call the workflow records goes to `.pi-workflows/cost/ledger.jsonl`: provider, model, input, output, cache tokens, requests, estimated and actual charge, phase, retries, and outcome.

Prices live only in `pricing:` rows with `effectiveFrom`. There is no price table in source. A missing price or missing token count is an unknown charge (`actualUsd: null`, `usageKnown: false`), not zero. A deterministic step that made no model call is a known zero.

Budgets in the sample (`taskUsd: 20`, `dailyUsd: 75`) are operator limits, not prices. Known spend at or above the limit is a hard stop. Known spend at or above `softWarningRatio` (default 0.8) is a warning. Unknown rows are never added in as zero: a row with token counts is estimated at the provider's dearest configured price, and a row with nothing to price it from (for example a call whose usage was lost) counts as `budgets.unknownCallUsd` (default 0.05, at least 0; a project can only raise it). The estimate lives in budget math only: the ledger keeps `actualUsd: null` and `/cost` still lists those rows as unknown, with a count. An unknown row no longer makes the budget soft by itself.

`/cost` also names models seen in the ledger that have no pricing row: their spend is unknown and estimated at the provider's dearest row for its current billing (subscription rows while on account login), which keeps the budget "soft", so add a row for each. Failures before any model request (a git error, a plan cycle) are ledgered as a known $0 and do not count against the model. Nothing classifies by model: the request gets a keyword scan and the planner rates the task.

`/cost json` is the dashboard source. `compareBaseline` in `src/cost/ledger.ts` diffs this workflow against a Cursor Auto sample you supply (cost per merged PR, time to merge-ready, success rate, retries, regressions, interventions). The repo does not invent a Cursor Auto number.

**Review and advisor cost.** Each ticket costs its implementer turns plus one Opus review call, a second Opus call when advisors answered, and the advisors. Prices come from `pricing` rows like every other call, and an unknown price stays unknown. Astra is $0 on a ChatGPT subscription (a Foundry deployment of it is billed per token); Fable is billed per token on an Anthropic API key (it needs `providers.anthropic.apiKeyFallback: true` in the user config and a `billing: api-key` row), so high tickets, which always consult both advisors, are where the advisor spend shows up. The split is in the build table, `/status` and `tickets.jsonl`.

Routing keeps a rolling success table in `.pi-workflows/metrics/success.json`. `/build` starts each ticket at its difficulty tier and climbs one step per failure, at most `routing.maxEscalations` steps (default 3, so the full ladder fits), never past `routing.maxTier`. Three failures and zero successes in a task class open the circuit breaker.
