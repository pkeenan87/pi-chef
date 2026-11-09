# Rework: back to plan → build → review

Goal: a simple plan → build → review workflow that produces quality work and is cost effective.
Everything else is configuration in service of that: which model builds low / medium / high tickets,
easy local models, plans, and costs.

Branch `rework/slim`, cut from `claude/herdr-config-and-runner`.

## Decisions (from the owner, 2026-11-08)

| Question | Answer |
|---|---|
| Foundry / Vercel providers | Drop both. Replace with **external build agents** (Claude Code, Codex, Antigravity, Gemini, opencode…) run in herdr tabs. |
| Worktrees | Plain branch in the current checkout. |
| Per-ticket review gate in /build | Keep, one reviewer model, no advisors. |
| /plan interview | Keep as-is. |
| Config panel | Herdr **side panel** (not a tab): models per difficulty, local model, plans, costs. |
| /review | Each finding rated 1-10 for likelihood and severity; drop it when likelihood × severity < 5. |

## What a ticket's "model" can be

```yaml
models:
  low: local/Qwen3.8-27B          # a Pi model: provider/id (Pi login, or the local server below)
  medium: anthropic/claude-sonnet-5-5
  high: agent:claude              # an external agent, run in a herdr tab
  review: anthropic/claude-opus-5-5
local:
  baseUrl: http://127.0.0.1:8081/v1
  models: [{ id: Qwen3.8-27B, contextWindow: 131072 }]
agents:                           # optional overrides; built in: claude, codex, cursor-agent, grok, agy, gemini, opencode
                                  # `agent:<name>/<model>` adds that CLI's model flag (claude/cursor-agent/agy/opencode
                                  # --model, codex/grok/gemini -m); `grok models` / `agy models` list ids
  claude: { run: [claude, --permission-mode, acceptEdits] }
```

- **Every ticket runs in its own herdr tab** (owner, 2026-11-08). One runner; /build requires herdr.
  The in-process subagent runner (`ticket-agent.ts`, `pi-sdk.ts`) is removed.
- **Pi model** → `pi --model <provider/id>` with the ticket-mode extension in a tab (restore `herdr-runner.ts`,
  `ticket-mode.ts`, `herdr/session-file.ts` from `claude/herdr-config-and-runner`); its session file is ledgered,
  so Pi tickets stay metered.
- **`agent:<name>`** → `hc run` opens a herdr tab with that CLI in the repo, the ticket prompt is sent, `hc wait`
  waits until the agent goes idle.
- A passed ticket's tab is closed; a failed one stays open to read.
- **Metering external agents:** snapshot the agent's own session-log dir before the tab opens; after the ticket,
  read only new files, sum tokens, price with `pricing`, ledger as "API-equivalent" cost under the ticket.
  Readers now: Claude Code (`~/.claude/projects/<cwd-slug>/*.jsonl`, `message.usage`), Codex
  (`~/.codex/sessions/**/rollout-*.jsonl`, `token_count` events). Cursor (`~/.cursor/chats`, sqlite), Antigravity
  (`~/.gemini/antigravity-cli/conversations`), Grok: "not metered" until their formats are checked. pi-chef then does what it does for every ticket: runs the checks, the ticket
  review, retries/escalates, commits. Cost of external agents is recorded as *not metered* (they bill their own
  subscription); the ledger still shows the attempt.
- Failed ticket escalates low → medium → high, then stops (no hidden "premium" rung).

## Reviews

- **Build review (per ticket):** one background model call on the ticket's diff, after its checks pass. Findings
  use the same 1-10 likelihood × severity scores as /review; the ticket fails only on a finding scoring ≥ 20, lower
  ones carry into the final report. Model: `models.review`, or `models.high` when review names an agent.
- **/review:** runs in the main session; the report and "Fix all" land in the conversation.
  `models.review` may be a Pi model (one-shot call on the diff) or `agent:<name>/<model>` (a herdr tab where the
  agent reads the repo and writes findings JSON to a file pi-chef reads, filters and reports).
  `/review --with <model|agent:…>` overrides it for one run.

## Delete (scope creep)

- Runners: session-replacement runner, Pi-in-herdr runner (`ticket-mode.ts`, `herdr/session-file.ts`), review tab
  (`herdr/review-tab.ts`). `herdr/client.ts` stays for the agent runner.
- Advisors everywhere: `/advisor`, plan consult, review advisors + resolve step, ticket advisors, watchdog,
  cut-file summaries, `advisor-agent.ts`.
- Providers: Foundry, Vercel, auth probing, `status-foundry`, quota, known-models presets beyond local.
- Router: adaptive / Thompson sampling, success stats, circuit breaker, shadow prices → `modelFor(difficulty)` +
  `escalate()`.
- Session extras: compaction on a cheap tier, session model pinning, input budget gate, syntax-check wrapper, progress widget, state-label, worktrees, `/status`, `/auth`, `/chef`.
- Config: ~90 keys → ~15. Legacy `cost-workflow.yaml`, per-key layering rules, `localMode`.
- Generic per-key config editor (schema table, inspect/KeyView, comment-toggling editor) → a purpose-built CLI.

## Keep

`/plan` (interview as-is), `/plans`, `/show-plan`, `/build`, `/review`, `/cost`; the task store and ledger; pricing;
budgets (task + daily); web search/fetch tools (owner: useful); redaction; the check runner and its destructive-command guard; the per-ticket review gate.

## Suggestions (not done here)

1. **Measure before adding.** Most deleted features were added to fix a feeling, not a number. The ledger already
   has per-ticket cost and pass/fail; a `/cost tickets` view of "cost per passed ticket by model" would tell you
   whether the low tier is actually saving money once retries and escalations are counted.
2. **Meter external agents later.** Claude Code `-p --output-format json` and `codex exec --json` both report
   usage. If you want their costs in the ledger, a non-interactive mode for agents is the way, at the price of
   not being able to type into the tab.
3. **Keep the plan small.** Ticket count is the biggest cost lever: every ticket pays checks + a review call.
   Ask the planner for the fewest tickets that keep each one reviewable.
4. **Tests leak temp dirs.** Tests `mkdtemp` and rely on vitest's globalSetup teardown to remove the root; a run
   that is killed (a timed-out check during /build, ctrl-c) never tears down. On 2026-11-08 /tmp ran out of inodes
   with 20k+ `pi-chef-*`, `pi-home-*`, `pi-proj-*`, `chef-set-*` dirs from that day.
