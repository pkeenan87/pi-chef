# Plan: run /build tickets and reviews in herdr tabs

A third ticket runner, `isolation.runner: herdr`. Each `/build` ticket runs as
its own `pi` process in a herdr tab you can watch and type into, and every
review (per-ticket and `/review`) goes through **one** long-lived review tab.
pi-chef keeps everything it owns today: planning, routing and escalation,
budgets and the ledger, the bash rules, checks, the review gate, and commits.
Only *where the model runs* changes.

Read first: `AGENTS.md`, `docs/configuration.md`, `~/.config/herdr-app/AGENTS.md`,
`hc --help` and `hc run --help`.

## What exists today (the seams)

- `BuildDriver` (`src/orchestrator/build.ts:903`): `fresh(model, run, ticketId,
  limits)` hands `run` a `ChunkSession` with one method, `send(text) →
  {lastText, aborted, turnLimit?}`. `runBuild` sends the ticket prompt, then up
  to two retries (check failures, a first review fail) **into the same
  session**. `fresh` never throws; it returns `{stopped}`. Checks, review and
  commit run in pi-chef's process, in the build's checkout.
- `buildHost` (`src/extension.ts`) picks `runInSubagent` (Pi SDK child sharing
  the parent's model runtime) or the session-replacement path.
- The subagent gets the bash rules from wrapped tools (`ticketTools`,
  `ticketBashProblem`), its turn budget from `turnBudget`, and ledgers each
  assistant message through `usageOfMessage` → `observeUsage`.
- `reviewTicket` (`src/orchestrator/ticket-review.ts`) and `/review`'s model pass
  (`src/review/model-review.ts`) call the model only through a `ChatFn`
  (`ctx.chat`): single-shot, JSON answer, usage returned and ledgered by the
  caller.

## Facts about herdr that the design rests on

- `hc run --bg --label herdr.space=<id> --label herdr.tab=<id> -- pi …` puts a
  terminal in that space as a tab. `HC_TERMINAL_ID` tells pi-chef its own
  terminal; `hc get $HC_TERMINAL_ID --json` gives its `herdr.space` label.
- Pi reports its status to herdr (`app: pi`, `working`/`idle`), so `hc wait`
  works on a Pi tab. `hc wait` returns on its `--timeout` (180 s default) while
  still `working`; the caller must loop until the status is not `working`.
- `hc send <t> <text>` pastes and presses Enter; `hc interrupt <t>` presses stop;
  `hc kill <t>` ends it. Not yet known: whether a message sent while Pi works
  is queued or interleaved (see Unverified), so pi-chef only sends to an idle
  tab.
- **Checked in this session:** `hc send` from inside a terminal wraps the text
  as `<hc from="t4">…</hc>`, so a slash command sent that way arrives as a chat
  message, not a command (a `/clear` sent to Claude did nothing). Typing it key
  by key works: `hc keys <t> / c l e a r enter`. So the client sends prompts
  with `hc send` (the wrapper is harmless, or `notes = false` in
  `~/.config/herdr-core/config.toml` drops it) and slash commands (`/new`,
  `/model …`) with `hc keys`.
- `pi -ne -e <file>` loads only that extension; `--model provider/id:thinking`,
  `--session-dir <dir>` make the model and the session file deterministic.

## Design

### 1. The herdr client (`src/herdr/client.ts`)

A small interface, injected like `ChildSdk`, over `execFile("hc", argv)`:
`self()` (own terminal and space, or why not in herdr), `run({argv, cwd, name,
labels})`, `send(t, text)`, `waitIdle(t, {timeoutMs})` (loops `hc wait`),
`interrupt(t)`, `kill(t)`, `find({labels})`. Every call uses argv arrays and `--`
where user-derived; nothing goes through a shell. Tests use a fake.

### 2. Ticket mode: one extension for the child (`src/ticket-mode.ts`)

The child runs `pi -ne -e <pi-chef>/src/ticket-mode.ts`. A second, small Pi
entry point that registers **no commands**, and only:

- **Providers**: `registerChatProviders` for foundry, vercel and local, so the
  child can use every model the router can pick (a `-ne` child does not get the
  parent's runtime the way the subagent does).
- **The bash rules**: a `tool_call` hook that refuses what `ticketBashProblem`
  refuses (`isDeniedCommand` + `buildBashBlock`, always on), and the syntax
  notes on edit/write. AGENTS.md's rule becomes: anything the main session's
  hook enforces on a ticket must be in `ticketBashProblem`, which both the
  subagent and ticket mode call.
- **The turn budget**: counts its own assistant turns (`message_end`), steers
  once at `maxTurns`, aborts at `maxTurns + TURN_GRACE`, and writes
  `turnLimit` into a small status file the parent reads. Passed in through env
  (`PI_CHEF_TICKET=<id>`, `PI_CHEF_MAX_TURNS=<n>`, `PI_CHEF_STATUS=<file>`), never
  secrets. The status file lives under the main checkout's workspace dir
  (beside the child's session dir), never in the worktree, or `commitAll` would
  stage it.

`ticket-mode.ts` imports only what it needs, so loading it never registers
`/plan`, `/build` or any session hook.

### 3. The herdr ticket runner (`runInHerdr` in `src/subagent/herdr-runner.ts`)

Called from `buildHost().fresh` when `isolation.runner: herdr`:

1. **Preflight** as today (`registryProblem`), plus `client.self()`. If pi-chef is
   not inside herdr or `hc` is missing, fall back to the subagent with a notice
   (`herdr not available: <reason>; running the ticket in a subagent`).
2. **Start** one tab per ticket attempt: `hc run --bg --no-notify --name chef-<task>-<ticket>
   --cwd <build checkout> --label herdr.space=<own space> --label
   herdr.tab=<new id> --label pi-chef.ticket=<id> -- pi -ne -e <ticket-mode> --model <p/id:thinking>
   --session-dir <ws>/tasks/<task>/sessions/<ticket>-<attempt>`. Tab name:
   `ticket 01`.
3. **send(text)**: `hc send`, then `waitIdle`. Then read the child's session
   file: new assistant `message` entries → `usageOfMessage` → `observeUsage`
   (dedupe by entry id, since the file is read after every send); Pi's own
   entries → `recordPiUsage`; `lastText` = the last assistant message; `aborted`
   and `turnLimit` from the status file.
4. Retries reuse the same tab (`send` again), as `runBuild` expects.
5. **End**: ticket committed → `hc kill` the tab. Failed or stopped → leave the
   tab open so you can read it; the next attempt opens a new tab. Ticket tabs
   die with the parent Pi (no `--outlive-parent`), like the subagent.
   `--no-notify` keeps herdr-core from typing notes about the child into
   pi-chef's own Pi session, which would read them as prompts. Naming the tab
   (`tab.rename`) and settling it are `herdr-app do` commands, not `hc`; the
   client may wrap `herdr-app` for these, else v1 skips them.
6. **Resume sweeps old child sessions.** Before a new attempt, `runInHerdr`
   reads every session dir under `<ws>/tasks/<task>/sessions/` for that ticket
   and ledgers entries not yet in the ledger (dedupe by session and entry id),
   so a pi-chef crash mid-ticket never loses the child's spend.
7. Never throws (same contract as `runInSubagent`).

**Worktree:** reuse today's `enter` unchanged: it moves the main session into
the worktree with `switchSession` for every runner, and that is what makes
`finishChunk`'s git and checks land there. The child tab starts with the
worktree as its cwd. H1 only confirms this works for herdr; a no-switch variant
is built only if a concrete reason appears.

**Spend while a ticket runs:** read after each `send`, so the footer updates
per turn-batch, not per message. The turn limit bounds a runaway. A live budget
cut-off inside the child is a later step.

**Watchdog:** off for herdr in the first cut (it needs mid-turn steering from
outside). Later: the parent reads the session file every N turns and sends the
note with `hc send`.

### 4. One review tab for every review

A `ChatFn` backed by a tab (`src/herdr/review-tab.ts`), passed as `ctx.chat` for
review calls when the runner is herdr. `reviewTicket`, the resolve call, and
`/review`'s model pass are unchanged.

- **One tab, `chef review`**, per herdr space, found by label
  `pi-chef.role=review` and reused across tickets and builds; started on first
  use: `pi -ne -e <review-mode> --model <routed review model> --tools
  read,grep,find,ls --session-dir <ws>/reviews`, with `--no-notify` and
  `--outlive-parent` (it outlives one Pi session and is found again by label).
- **Which tree it reads**: the packet names the build checkout (the worktree)
  and tells the reviewer to read files only there; the diff is in the packet
  too. The tab's own cwd does not matter.
- **Contract**: mirror `createAgentChat` (`advisors.tools`): one answer per
  request, usage summed over all turns of that request, capped at
  `ADVISOR_MAX_TURNS`. The answer is the last assistant message; the verdict is
  parsed from it with `parseTicketVerdict` as today, which must handle prose
  around the JSON (tested on a multi-turn session file, not just a clean one).
- **Each review**: write the packet (system prompt, user prompt) to
  `<ws>/reviews/<id>.md`; `hc send` `/new`
  (fresh context per review, so tickets never leak into each other), then a
  short message: "Review request <id>: read <file> and answer as it asks".
  `waitIdle`, then take the answer from the last assistant message in the
  session file and its usage from the same entries. The `ChatFn` returns
  `{text, usage}` like `createRegistryChat`.
- **Model per review**: if the routed candidate differs from the tab's current
  model (premium for security, the fallback candidate on retry), send `/model
  <provider/id>` first. One tab, reviews in order; they are already serial.
- **Reviewer can look at the code**: read-only tools in the checkout, as
  `advisors.tools` already does for advisors. Its verdict format is unchanged.
- **You can talk to it**: between reviews, typing into the tab is yours; pi-chef
  waits for idle before each review and starts it with `/new`.
- Advisors stay in-process for now (they can be tabs later).
- If the tab dies mid-review, the `ChatFn` throws, and `reviewTicket` already
  turns that into a retry on the second candidate, then `unavailable`.

### 5. Config

`isolation.runner: subagent | session | herdr` (user only, already enforced by
the `isolation` rule). One new key, `isolation.herdrCommand` (default `hc`). Not
`…Path`/`…Token`; it passes `assertCommandSafe`. Update `src/config.ts`
(type, default, validation message), `src/config-schema.ts`,
`docs/configuration.md`, `templates/chef.yaml`, `docs/commands.md` (/build's
Session step), README, and AGENTS.md (the runner bullets and the Unverified
list).

## Tickets

Each goes builder → reviewer, the next only after a pass. Done for each:
`npm test` and `npm run typecheck` green, docs updated in the same ticket.

- **H1. Confirm today's `enter` serves a herdr runner.** Trace `enter`,
  `followBuild`, `workflowFor` and `finishChunk`'s checkout; write a test that a
  worktree build with a driver whose `fresh` does its work in the worktree from
  outside (as a child tab would) commits there. Change code only if the test
  shows a real gap.
- **H2. Herdr client** + fake + tests (argv shapes, the wait loop past a
  timeout, `self()` outside herdr).
- **H3. Ticket-mode extension**: providers, bash rules, syntax notes, turn
  budget, status file. Tested on Pi's real SDK with the faux provider, like
  `tests/ticket-agent.test.ts` (load the extension, check a blocked `git push`,
  steer and abort at the limit).
- **H4. Session-file reader**: assistant usage (dedupe by session and entry
  id, persisted so a re-read never double-counts), `lastText`, Pi's own
  entries, and the resume sweep of old session dirs. First confirm the JSONL `message` entry shape against Pi 1.2.0's
  `SessionManager` and record it in `docs/COMPATIBILITY.md`.
- **H5. `runInHerdr`** + config value + fallback + docs. A `/build` test in
  `tests/session.test.ts` with `runner: "herdr"` and the fake client: the fake
  writes the session file and the working-tree change, so the real checks,
  review and commit run; ledger rows carry `ticket 01`; a failed ticket leaves
  its tab, a committed one kills it.
- **H6. Review tab `ChatFn`**: find-or-start, `/new` per review, `/model` when
  the candidate differs, answer and usage from the session file. Wire it for the
  per-ticket review and `/review` when the runner is herdr. Tests with the fake
  client.
- **H7. Live check** (by hand, not CI): one small task built with
  `runner: herdr` in this herdr window, on a throwaway git repo in the
  scratchpad (never on pi-chef itself, which holds uncommitted work). Record in AGENTS.md's Unverified
  section what was confirmed and what was not.

Later, not in this plan: parallel tickets (one worktree each, merge order),
advisors as tabs, the watchdog over `hc send`, a live budget cut-off in the
child.

## Unverified (to state in the PR and AGENTS.md)

- That `pi -ne -e <file>` loads a `.ts` extension from pi-chef's install path
  with providers working, and that Pi reports `working`/`idle` to herdr through
  a whole multi-turn ticket.
- That `/new` and `/model` sent with `hc send` behave in a running Pi TUI as
  typed, and that the session file's last assistant message is the full answer.
- That a message `hc send` delivers while Pi works is queued, not interleaved.

## Status (2026-11-08)

H1-H6 built and passed review (fix rounds: H2 1, H3 1, H4 1, H5 1, H6 1).
H7 narrowed to a live check of the herdr mechanics (real `pi -ne -e
ticket-mode.ts` child on Haiku in a tab: env wrapper, waitIdle, session file
complete at idle, `/new` via untagged `command()`, `git push` blocked); results
in docs/COMPATIBILITY.md. Not done: a full `/build` with `runner: herdr` (needs
`isolation.runner: herdr` in the user's chef.yaml). Still unverified: see
AGENTS.md's Unverified section. Possible follow-up: `hc send --wait` instead of
the 5 x 1 s settle loops in the runner and the review tab. Also fixed on the
way: the test suite leaked temp dirs (tests/global-setup.ts).
