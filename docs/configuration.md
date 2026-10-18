# Configuration

How pi-chef is configured: the files, how a project config layers over yours, every key, the tiers and how a model is chosen, and budgets. Provider sign-in and setup are in [providers.md](providers.md).

## Configuration

**Layering.** `~/.pi/agent/chef.yaml` (user) is the base. `.pi-workflows/config.yaml` (project) layers on top: sections such as `tiers`, `routing`, and `workers` merge field by field with the project winning (except the `routing` fields in the table below), and `pricing` rows merge by provider, model, and date. A project file ships with a cloned repo, so it is untrusted for credentials and policy, as follows.

**User-config-only fields.** `baseUrl`, `endpoint`, `endpointEnv`, `apiKeyEnv`, `audience`, `projectDir`, `envFile`, and `resourceGroup` under `providers.*` are read from the user config only. In a project file they are ignored with a warning (shown by `/status`), unless the user does not define that provider and the value is the built-in default. Remote endpoints must be `https`, including a Foundry endpoint read from the `endpointEnv` variable. Only `local.baseUrl` may be `http`, and only for a loopback address. The top-level `workspaceDir` (where task state, the ledger and metrics live) is user-config-only too.

**Config errors.** Session start always shows a config problem through a warning, redacted, naming the file and the key. A bad section drops only itself, with a warning, and the rest of the file loads: an invalid `tiers.<name>` list or entry (the built-in tier applies), an invalid `session` or `quota` section, and a tier that names a provider the file does not define. A file that cannot be used at all is rejected: unreadable YAML, a secret, `approvals.merge` other than `manual`, an invalid provider, budget, or routing value. The notice then reads "<path> was ignored; built-in tiers are in use, and chef commands stay stopped until it is fixed" plus the reason, because the file also carries your policy (budgets, allowlists) and the commands do not run without it. A provider Pi refuses to register is reported by name and the others still register. `foundry`, `vercel`, and `local` blocks do not need a `type`.

**Policy fields a project can only tighten.**

| Field | Layering rule |
|---|---|
| `orgProviderAllowlist` | An empty list means all providers. A project list can restrict that, but once the user names providers the user's list is final |
| `proprietaryCode` | On if either file sets it (OR). It requires `orgProviderAllowlist` |
| `approvals` | Plan approval stays required and merge stays `manual`. `approvals.publish` from an older file is accepted, ignored, and warned about: nothing pushes |
| `budgets` | The lower of the user and project value for each limit (a lower `softWarningRatio` warns earlier). When the user sets none, the project value is compared with the default (`taskUsd` 20, `dailyUsd` 75, `softWarningRatio` 0.8), so a project can only tighten. The exception is `unknownCallUsd`: the higher of the two wins (the user's value, or the default 0.05 when the user sets none), because a lower estimate would loosen the budget |
| `advisors` | A project can only turn `tickets`, `plan` and `summarizeCut` off, never on, and can only raise `fromDifficulty` to `high`. `maxDiffChars`, `maxOutputTokens`, `timeoutMs` and `maxPlanConsults` take the lower of the user and project value (the default when the user sets none), because they raise cost or the data sent. `adHocMinLines` takes the higher, since a higher threshold means fewer advisor calls. Anything else is ignored with a warning |
| `session` | `model` and `compactionTier` are user-config-only. A project may only set `pin: false`. Ignored values get a warning in `/status` |
| `routing` | `reviewTier` (the tier of the review that gates every ticket commit and of `/review`) is user-config-only. A project's `requirePremiumReviewFor` adds to the user's list (or the default), never replaces it. `circuitBreakerFailures` takes the lower value. The other routing fields merge with the project winning |
| `pricing` | A project row cheaper than a user row for the same provider, model and billing (any token rate lower; a missing cache rate counts as the input rate) is ignored with a warning, because a lower price would loosen your budgets. A project may add rows for models you do not price, and raise prices |

The YAML must not contain secrets, API keys, or tokens.

**Other top-level keys.**

| Key | Meaning |
|---|---|
| `branchPrefix` (default `chef`) | `/build` names the branch `<branchPrefix>/<task name>` (for example `chef/retry-ingest-parser`) when they start from the default branch. A task that already has a build branch keeps it |
| `checks` | Commands `/build` (when a ticket has none of its own) and `/review` run in the repo root, without a shell. Any command runs except destructive ones (`rm -rf`, force push, `reset --hard`, piping a download into a shell), which are refused. A check that runs longer than 30 minutes or prints more than 64 MB is stopped and fails, with a note saying which |
| `setup` | Same shape as `checks`. Runs once per build before the first ticket's checks, and before the checks of every `/review` |
| `workers.tokenBudget`, `workers.ticketContextTokens` | The token mix the router prices a call at, and the size a ticket must fit (default 150000) |
| `session.model` (default `anthropic/claude-opus-5-5`) | The main chat session's model, as `provider/id`. Set on `session_start` when the session started on another model |
| `session.pin` (default `true`) | Whether `session.model` is set at session start. `false` leaves the model you picked with `/model` alone, and `/build` puts that model back when it finishes |
| `session.compactionTier` (default `cheap`) | Tier that writes compaction summaries (`session_before_compact`). One of `cheap`, `standard`, `premium` |
| `routing.reviewTier` (default `premium`) | Tier of the per-ticket review that gates each `/build` commit and of the `/review` model pass (user config only). A failed `/review` part falls back to `standard` candidates once this tier has none left |
| `routing.maxEscalations` (default 3) | Tier steps a failed ticket may climb from its difficulty tier (low, medium, high, then premium). Only a failure of the checks or the review climbs; a check that cannot run or a failed setup keeps the ticket on its tier. When the steps are used up, or the ticket fails on premium (the top of the ladder), it stays `failed` and `/build` stops with `MAX_ESCALATIONS`. The message says what works: fix it in the chat (a checks failure), edit the ticket or plan (a review failure), or raise the limit |
| `tiers.ticketLow`, `tiers.ticketMedium`, `tiers.ticketHigh` | Models for tickets of difficulty `low`, `medium`, `high`. A config that lists `tiers` without them runs those tickets on `cheap`, `standard` and `premium`, with a warning in `/status` |
| `routing.maxTier` (default `premium`) | The highest tier any route may use. Escalation stops there: a ticket still failing on it stops with `MAX_ESCALATIONS` |
| `routing.requirePremiumReviewFor` (default `auth`, `permissions`, `secrets`, `security-sensitive`) | Task types and capabilities whose review always runs on premium, and which need your confirmation before `/build`. A project can add to the list, never remove from it |
| `routing.circuitBreakerFailures` (default 3) | Failures with no success, for one task type and tier, that open its circuit breaker: the tier is skipped and routing moves up. A project can only lower it |
| `routing.selection` (default `ordered`) | How a tier picks its model. `ordered`: the first usable candidate in the tier's listed order, so the same model runs every time and later entries are fallbacks. `adaptive`: the lowest expected cost per success, with Thompson sampling over each model's record (it explores, so the choice varies) |
| `routing.attemptOverheadUsd` (default 0.02, at least 0) | Ranking only. Added to each candidate's price before it is divided by its success rate, so a $0 model with a poor record does not always win. Never billed, never in a budget |
| `advisors` | Second opinions: `tickets` (default true; false turns the per-ticket review in `/build` off), `plan` (default true; false skips `plan_consult` and its requirement), `fromDifficulty` (default `high`; the lowest ticket difficulty that gets advisors in the per-ticket review and `/review`. `medium` adds one advisor from another vendor for medium tickets and for ad-hoc branches over `adHocMinLines`; a project can only raise it to `high`), `adHocMinLines` (default 400; with `fromDifficulty: medium`, an ad-hoc branch with more changed lines than this gets one advisor in `/review`), `summarizeCut` (default true; the batch tier writes a one-line summary of each file a diff clip cut), `timeoutMs` (default 180000, per call), `maxDiffChars` (default 40000, the diff sent to advisors), `maxOutputTokens` (default 1500, the visible answer an advisor is asked to stay within), `maxPlanConsults` (default 2; plan consults per draft version, a project can only lower it). Advisors obey the same hard rules as model selection (`orgProviderAllowlist`, `proprietaryCode`, an open circuit, the budget); an excluded advisor is never called and is listed with its reason (`org_allowlist`, `proprietary_code_policy`, `circuit_open`, `over_budget`) in `advisorsSkipped` |
| `review` | The advisory model pass of `/review`: `model` (on by default), `maxDiffChars`, `maxChunks`, `timeoutMs` |

Old keys load with a warning (shown by `/status`) and are otherwise ignored: `commandAllowlist`, `worktrees.*`, `workers.concurrency`, `workers.deadlineMs`, `workers.isolatedWorktrees`, `workers.preserveUntilReviewed`, `autopilot`, `budgets.autopilotPrUsd`, `routing.sessionTier`, `routing.directTier`, `routing.minConfidence`, `providers.*.decisionsPath`, `models.classifier`, `tiers.classifier`, and any tier entry with `api: decisions` (that entry is dropped). An old `worktrees.branchPrefix` still names the branches while `branchPrefix` is unset.

Provider setup: [Azure CLI and Foundry](providers.md#azure-cli-and-foundry-deployments) (`endpoint`, `audience: https://ai.azure.com`) and [Vercel CLI and AI Gateway](providers.md#vercel-cli-and-ai-gateway) (`vercel login`, `vercel link`, `vercel env pull`, `projectDir`).

## Tiers and who serves them

Each tier lists candidate models under `tiers:` in the config. The runtime picks within a tier; the tier itself is still chosen by the deterministic policy.

| Tier | Candidates (sample config) |
|---|---|
| deterministic | Local OpenAI-compatible model (`qwen2.5-coder:7b`) if configured and reachable; otherwise the plan's literal edits with no model |
| cheap (`session.compactionTier`) | Claude Haiku `claude-haiku-5-5` (Anthropic account login). Compaction summaries |
| batch | ChatGPT Luna `gpt-6-luna` (OpenAI account login). Standalone jobs the extension runs by itself, outside any conversation: today the one-line summaries of files a diff clip cut. A config without a `batch` list runs them on `cheap` |
| standard | Claude Sonnet `claude-sonnet-5-5`, Sol 6.1 `gpt-6.1-sol`. `/route` previews and the fallback for a failed `/review` model part. `/plan` itself runs in your session on `session.model` |
| premium (`routing.reviewTier`) | Claude Opus `claude-opus-5-5`. The `/review` model pass and the last step of the ticket ladder. The main session runs on Opus through `session.model`, not through this tier |
| ticketLow | Grok 4.7 `grok-4.7` through a SuperGrok subscription (`xai`). Tickets of difficulty `low` |
| ticketMedium | Claude Sonnet `claude-sonnet-5-5`. Difficulty `medium` |
| ticketHigh | Sol 6.1 `gpt-6.1-sol`. Difficulty `high` |
| advisor (on demand) | GPT Astra `gpt-6-astra` (OpenAI, then a Foundry deployment), then Claude Fable `claude-fable-5-1`. Consulted on every plan (`plan_consult`, both), by `/build`'s per-ticket review (medium: one, high: both) and by `/review` (by the branch's highest ticket difficulty). Astra is $0 on a ChatGPT subscription; Fable is billed per token on an API key |

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

Every routing decision (`/plan`, each `/build` ticket and escalation, `/review`, `/route`, `/advisor`) adds a `route` event to the task's `events.jsonl` with the tier, model, reason and the score or exclusion of each candidate, and shows up in `/status` and `/cost` with per-model spend and success counts.

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
