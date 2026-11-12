# Pi and herdr compatibility

The Pi and herdr surface pi-chef uses, and what has not been run live. Read from the published `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 1.2.0 packages (`dist/*.d.ts` and `docs/`). The herdr checks of 2026-11-08 ran against Pi 1.5.0. `@mariozechner/pi-coding-agent` is the frozen predecessor; its docs do not match.

## Pi extension API

| Need | API | Where |
|---|---|---|
| Load | default export `(pi: ExtensionAPI) => void`; `package.json` `"pi": { "extensions", "skills" }` and the `pi-package` keyword; host packages are optional peers | `src/extension.ts` |
| Commands | `pi.registerCommand(name, { description, handler, getArgumentCompletions })` | `src/commands.ts`, `extension.ts` |
| Tools | `pi.registerTool` (`web_search`, `web_fetch`, `plan_questions`, `plan_spec`, `plan_tickets`); `pi.getActiveTools`, `getAllTools`, `setActiveTools` to limit tools during `/plan` | `src/tools/` |
| Local provider | `pi.registerProvider("local", { name, baseUrl, api: "openai-completions", apiKey, models })` at load, at `session_start`, and when the `local` section changes | `src/providers/runtime.ts` |
| Lifecycle | `session_start`, `session_shutdown`, `session_tree`, `session_compact`, `before_agent_start`, `agent_end`, `agent_settled` | `extension.ts` |
| Usage | `message_end` (token counts for the ledger; message text is not copied); `ctx.sessionManager.getEntries()` and `getSessionId()` to sweep Pi's own usage entries into the ledger once per entry | `extension.ts`, `orchestrator/budget.ts` |
| Block a tool | `pi.on("tool_call")` returning `{ block, reason }` (destructive bash; non-read-only bash during `/plan`; `git push`, branch switches and worktree changes in a Pi ticket child); `user_bash` for commands you type | `extension.ts`, `src/sandbox.ts` |
| Model calls | `ctx.modelRegistry.find`, `hasConfiguredAuth`, `complete` for the review calls; the model must be known with credentials | `src/providers/` |
| Session | `pi.appendEntry` (active task pointer), `pi.sendMessage` (reports), `pi.sendUserMessage` (fix requests) | `extension.ts` |
| UI | `ctx.ui.notify`, `confirm`, `select`, `editor`, `setStatus`, guarded by `ctx.hasUI` | `extension.ts` |
| Ticket child | `pi -ne -e <repo>/src/ticket-mode.ts --model provider/id[:thinking] --session-dir <dir>`; `ctx.abort`, `agent_start` | `src/ticket-mode.ts`, `src/runner/pi-ticket.ts` |

Not subscribed on purpose: `before_provider_headers`, `context`. Pi has no extension call for `/login`; the user runs it. pi-chef never calls `pi.setModel`.

Pi 1.2.0 declares `node >= 22.19.0`; this package typechecks on Node 20.

### Local server registration

From `ProviderConfig` and Pi's `docs/models.md`: `apiKey` is a literal, `$ENV_VAR`, or `!command`, and is required when defining models. pi-chef passes `$<apiKeyEnv>` when named, else the placeholder `local`. `models` replaces the provider's models; each entry carries `id`, `name`, `input`, `reasoning`, `cost`, `contextWindow` and `maxTokens`. A repeat `registerProvider` for a name takes effect at once.

## Pi session files

`src/herdr/session-file.ts` reads the files a Pi ticket child writes in its `--session-dir` (Pi 1.2.0 `SessionManager`):

- One `<timestamp>_<sessionId>.jsonl` per session, appended; the file appears once the session holds a message, so a reader can meet a missing file or a half-written last line.
- Line 1 is `{type: "session", version: 3, id, timestamp, cwd}`. Other entries have `type`, `id`, `parentId`, `timestamp`.
- `{type: "message", message}`: an assistant message has `provider`, `model`, `usage` `{input, output, cacheRead, cacheWrite, totalTokens, cost: {...}}` and `stopReason`.
- `{type: "usage", kind, provider, model, usage}` records Pi's own calls.
- The ledger id is `pi-<sessionId>-<entryId>`; entry ids repeat across sessions, so the session id is part of the key.

## herdr (`hc`)

`src/herdr/client.ts` runs `hc` with argv arrays, never a shell: `run --bg --json --no-notify [--name] [--cwd] [--label k=v] -- argv`, `send --json --wait --timeout <s> <t> -- text`, `wait <t> --json --timeout`, `read <t> --json --lines N`, `get <t> --json` (to find its own space), `kill`. Pi must itself run in herdr (the client asks herdr which terminal and space it is in).

Checked live on 2026-11-08 (herdr mechanics only, not a `/build`): env reaches a child `pi`; `waitIdle` returns `idle` once Pi is up and `done` after a turn; a tab reads `working` about a second after `send`; the session file is complete at idle; the deny hook blocks `git push` in the child; `kill` removes the tab.

`hc wait --json` on an idle Claude Code tab returned `{ended: true, reason: "status", status: "idle", turn, ...}`. `hc send --if idle` refuses a tab that reads `done` (an agent finished a turn and nobody looked), so sends do not use it. Before a send the runner waits until the tab is neither `working` nor `blocked`; `send --wait` then waits for the turn that send started, and a check-in that finds the tab still working is followed by `hc wait`, up to the wall-clock limit. `idle` and `done` both count as finished, `blocked` is waited for, `error` or a dead tab stops the ticket. The shape of `send --wait --json` is read like `wait --json`; an answer with no status is treated as a check-in.

## External agent logs

`src/runner/agent-usage.ts` snapshots the agent's log directory before its tab opens and reads only new or grown files afterwards.

- **Claude Code:** `~/.claude/projects/<cwd with every non-alphanumeric character replaced by "-">/<session>.jsonl` (sub-agents in `<session>/subagents/*.jsonl`). `type: "assistant"` lines carry `message.id`, `message.model` and `message.usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`). One message repeats per content block, so each id is counted once.
- **Codex:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Line 1 is `session_meta` with `payload.cwd`; `turn_context` carries `payload.model`; `event_msg` lines with `payload.type: "token_count"` carry the session's cumulative `payload.info.total_token_usage`. `output_tokens` includes reasoning and `input_tokens` includes cached.
- Other agents (Cursor, Antigravity, Grok, Gemini, opencode) are recorded as "not metered".
- Default agent commands were chosen from each CLI's `--help` on 2026-11-08 (claude 2.1.319, codex-cli 0.167.0, cursor-agent 2026.10.01, grok 1.0.77, agy 1.5.3, gemini, opencode).

## Verified live (2026-11-08, Claude Code on Haiku in a herdr tab)

- `hc send --wait --json` prints `{started, status, turn, wait: {status, turn, reason, ended, exit_code}}`. The top-level `status` is the terminal's state before the send; the turn's outcome is `wait`. The client reads `wait`.
- A send with `--wait` into a tab that reads `done` is accepted and waits for the new turn (`--if` takes only `idle`/`working`, so it is not used).
- Claude Code's first-run "trust this folder?" dialog reports no status at all (not `blocked`). The runner never types before a ready report, and after 20 s tells the person the tab needs them. Pressing Enter there would pick "No, exit".
- The Claude Code meter: a snapshot, one turn, then `collect()` gave exactly one call (`anthropic/claude-haiku-5-5`) with its cache tokens; a second `collect()` gave nothing.
- Fix all in a tab with an agent (2026-11-09, `agent:claude/haiku`): the tab opened, a Bash approval showed the tab as blocked until answered, the fix finished, the reply came back, one "review fix" row was ledgered from Claude Code's log, the tab closed, and nothing was committed. A new folder asks "trust this folder?" even when its parent is trusted.
- Tab commands on macOS (2026-11-09): herdr's server runs under launchd with only the system PATH, so every tab is started as `env PATH=<pi-chef's PATH> …`. A ticket's commit works when `.pi-workflows` is in the repo's `.gitignore`.

## Unverified live

Unit tests cover the code around these with fakes; none ran against a live service.

- The whole `/build` loop: a herdr tab per ticket, Pi children and agents, `send --wait` and the check-in loop. If it deadlocks, run one ticket per `/build`.
- `PI_CHEF_MAX_TURNS` biting, and the steer and `ctx.abort()` at the turn limit in a live child.
- A ticket child's session file after an aborted or retried turn, and whether an assistant message can carry `stopReason` `pending` or `deferred`.
- That `hc send` of a long multi-line prompt pastes cleanly into each agent (it did for Pi), and that each agent reports `blocked` when it asks for approval.
- That the Codex rollout is flushed by the time the agent reports idle (a late flush lands on the next read or is missed on the last), and that Claude Code's `output_tokens` is final on long multi-block turns (the meter takes the largest per field).
- The outside-chef sweep against real Claude Code and Codex logs: that line timestamps and `message.id` repeats behave as the fixtures assume, and that a session running while `/cost` reads is counted once and completely on the next read.
- Each built-in agent's default command against a real ticket.
- The `local` registration (including the Qwen 3.8 27B preset) against a live llama-server through `registerProvider`.
- `getArgumentCompletions` in the live TUI menu.
- That the `ctx` Pi passes to `message_end` can draw the footer (`ui.setStatus`) mid-run, and that `message_end` usage fields (and `usage.cost.total`) are the provider's counts.
- Account entitlement: ChatGPT and Claude subscription logins, and Anthropic's extra-usage billing, can change without a Pi release.
- The herdr side panel's rendering and the layout docking in a live herdr app.
- Fix all in a tab (`review-fix.ts`) on a live Pi child, and the undo of a commit a live fixer makes.
- The idle warning in a live Pi session: the `input` hook's select prompt, and the cache-write estimate.
