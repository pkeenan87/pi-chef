# AGENTS.md

Pi extension that routes coding work across providers to cut cost per successful task. See README.md for user-facing behavior. This file is for agents working on this repo.

## Commands

```bash
npm test            # vitest, no network
npm run typecheck   # src and tests
```

Both must be green before you call a change done. There is no lint script.

## Layout

- `src/extension.ts`: Pi entry point. Registers commands, the virtual "auto" model, providers, and web tools. Keeps one `Workflow` per cwd.
- `src/commands.ts`: the command table (name, description, `run`).
- `src/orchestrator/`: `service.ts` is the `Workflow` facade. Each command lives in its own module (`planning`, `interview` (the `/plan` interview and spec), `ticket-plan`/`tickets` (ticket validation, files, group mapping), `prompts`, `implementation`/`waves`, `publish`, `autopilot-service`, `advisor`, `reports`, `worktrees`) as a function over `WorkflowContext` (`context.ts`). Phase rules are in `machine.ts`.
- `src/router/`: `virtual.ts` (the stateful `cost-opt/auto` router: `routeVirtual`, pure and tested with fakes), `classify.ts` (Decisions classifier plus keyword fallback), `policy.ts` (tier choice, escalation), `select.ts` (picks the model within a tier: cost per success with Thompson sampling), `stats.ts`.
- `src/providers/`: `auth.ts` (account-login, az, vercel status), `clients.ts` (chat and Decisions clients, usage parsing), `runtime.ts` (registers foundry, vercel, and local with Pi), `vercel.ts` (OIDC token via the Vercel CLI), `pi-chat.ts`.
- `src/cost/ledger.ts`: spend summaries and budget status. `src/cost/quota.ts`: subscription quota use per provider (ranking only). `src/config.ts`: YAML layering, validation, and pricing.
- `src/storage/store.ts`: task state, the event log, the ledger, metrics, and locks.
- `src/git/`, `src/github/`: worktrees, the `gh` GraphQL client, and the autopilot cycle.
- `src/agents/`: the worker pool, the model executor, and `pi-runner.ts` (spawns a child `pi` per ticket and parses its JSON events). `src/child-mode.ts`: what the extension registers inside such a child. `src/orchestrator/ticket-run.ts` runs one ticket (route, child, commit, checks, ledger, escalation). `src/review/`: checks and static review.
- `src/tools/`: `web_search` (Anthropic subscription, Haiku), `web_fetch` (local, public-only), and the plan tools `plan_questions` / `plan_spec` / `plan_tickets` (`plan-questions.ts`, `plan-flow.ts`, `plan-review.ts` (the scrollable full-plan review used by `plan_tickets` and `/approve-plan`); `readonly-bash.ts` is the planning bash allowlist).
- `src/sandbox.ts`: the command allowlist and deny rules. `src/redact.ts`: secret redaction.

## Rules that are not obvious from the code

- **No API-key fallback for OpenAI or Anthropic.** Only Pi account login (oauth) is allowed. Do not read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- **No secrets in config.** `assertNoSecrets` enforces this. Tokens (az, vercel, oauth) live in memory only. Never log them or write them to state, the ledger, or prompts.
- **Policy is deterministic; models only advise.** Plan approval stays required. `autopilot.autoMerge` stays false and merge stays manual. A project config can never loosen the user's policy fields (allowlists, `proprietaryCode`, approvals, budgets).
- **Credential and location fields are user-config-only.** `baseUrl`, `endpoint`, `apiKeyEnv`, `audience`, `projectDir`, `envFile`, and `decisionsPath` from a project config are ignored with a warning (`config.warnings`, shown by `/status`), unless the user does not define that provider and the value is the built-in default. Remote endpoints must be https; only `local.baseUrl` may be http, and only for loopback.
- **Unknown cost is never treated as zero.** Record `actualUsd: null` and let the budget treat it as spend or a warning. Do money math in integer micro-USD (`toMicroUsd` and `fromMicroUsd`).
- **Spawn processes with `execFile` and argv arrays, never a shell.** Put `--` before user-derived refs. Every command must pass `assertCommandAllowed`.
- **Writes to `.pi-workflows/` go through `atomicWrite`, `withLock`, or append-only files.** Never truncate `events.jsonl` or the ledger.
- **Never touch a command's `ctx` or the captured `pi` after the session is replaced.** `/approve-plan` opens a new session (`newSession`); Pi then invalidates the old ctx and pi, and any use throws. Post-replacement work goes through the ctx passed to `withSession` (`replacementCtx` in `extension.ts`).
- **Phase changes go through `transition`, which checks `machine.ts`.** Commands return results through `guard` and do not throw to Pi.
- **Price every new model.** Add a row to `pricing` in `.pi-workflows/config.yaml`, or the selector ranks it last as `price_unknown`.
- **Quota shadow prices rank; they never bill.** `quota.models` weights and the `quota.providers` caps (`src/cost/quota.ts`, `shadowCost`/`rankingCost` in `src/router/stats.ts`) only change scores. Never add them to `actualUsd`, `budgetStatus`, `budgetRemainingUsd`, the over-budget filter, or `expectedUsd`. Give a new subscription model a `quota.models` row as well as its $0 `pricing` row.
- **Child mode must stay minimal; the parent ledgers child usage.** When `PI_COST_ROUTER_CHILD=1`, `extension.ts` calls `registerChildMode` and returns: providers, web tools, and one `tool_call` hook that denies destructive `bash` (sandbox deny rules) and `git push`. It does not apply the command allowlist, because tickets run builds and tests. Do not add commands, other hooks, or `message_end` ledgering there. The parent records each ticket attempt from the child's JSON events (`recordTicketUsage`), so a second record in the child would double count. The child environment is an allowlist (`childEnvironment`): never add a pass-through of the parent env, and never pass `GITHUB_TOKEN`, `GH_TOKEN`, `*_TOKEN`, `*_KEY`, `*_SECRET`, `AWS_*`, `VERCEL_OIDC_TOKEN`, `ANTHROPIC_*`, or `OPENAI_*`. Pushing is disabled at the git level, not by regex: `GitWorkspace.childGitEnv` sets `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (pushurl for every remote, `url.*.pushInsteadOf` for all URLs, empty `credential.helper`, `core.hooksPath=/dev/null`) and `GIT_TERMINAL_PROMPT=0`. The `childBashBlock` hook is only defense in depth. `commitAll` runs with `core.hooksPath=/dev/null` and `--no-verify` so hooks a child wrote never run in the parent. Children are spawned detached in their own process group and killed as a group; live children are tracked so `Workflow.dispose` and process exit stop them, and running spend is charged to `ctx.inflight` so concurrent tickets stop together at the budget.
- **Tests use fakes for transports, clocks, rng, `gh`, `az`, and `vercel`.** Never make a real network call. Put shared fixtures in `tests/helpers.ts`.

## Unverified against live services

The `pi` CLI flags used by `pi-runner.ts` and child-mode loading are verified (see the comment in `pi-runner.ts`). Still unverified: the JSON event names (`message_end` usage fields, `compaction_end`), the `modelRegistry.complete` call shape, `web_search` over oauth, Foundry `decisionsPath` for Microsoft-Decision-1, and Vercel `!command` key resolution in Pi. When you change these, say so in the PR. Do not claim they work without a live check.
