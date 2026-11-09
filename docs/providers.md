# Providers

How the models named in `models` are set up. Which model does which job: [configuration.md](configuration.md#models).

## Pi logins

A model written `provider/id` is a Pi model, and Pi owns its sign-in. pi-chef implements no login and never reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `XAI_API_KEY`.

| Provider | Run in Pi |
|---|---|
| OpenAI | `/login openai`, then Sign in with ChatGPT |
| Anthropic | `/login anthropic` (Claude Pro/Max) |
| xAI | `/login xai`, then Sign in with SuperGrok or X Premium |
| Any other | Whatever Pi's `/login` says |

- Before a ticket starts, `/build` asks Pi's registry whether it knows the model and holds credentials. If not, the build stops with the reason (for example `run /login anthropic`).
- A subscription login has no per-token cost; a key stored in Pi does. Add a [`pricing`](configuration.md#pricing) row, or the cost is unknown and counts against budgets.
- A subscription login is not proof of free API use. Confirm the account with a real request.
- An expired login fails the call. Run `/login` again, then `/build`; the plan and earlier commits are kept.

## Local server

One OpenAI-compatible server (llama.cpp's `llama-server`, Ollama, LM Studio) is registered with Pi as provider `local`. Describe it in your user config and use its models as `local/<id>`:

```yaml
# ~/.pi/agent/chef.yaml
models:
  low: local/Qwen3.8-27B
local:
  baseUrl: http://127.0.0.1:8081/v1
  apiKeyEnv: LOCAL_API_KEY        # only if the server needs a key
  models:
    - { id: Qwen3.8-27B, contextWindow: 131072, maxTokens: 16384 }
```

- You start the server; pi-chef does not.
- `contextWindow` must equal what the server runs. The planner keeps tickets for a local model to half of it. Before the first local ticket of a build, pi-chef asks the server (`/props` on llama-server, `/api/ps` on Ollama) and warns on a mismatch; it never blocks.
- A local model with no `pricing` row costs $0.
- Choose a model that calls tools well: tickets use Pi's read, edit and bash tools.
- The `baseUrl` of other servers: LM Studio is `http://127.0.0.1:1234/v1`.

**llama.cpp.** `id` is the server's `--alias`; `contextWindow` equals `--ctx-size`; tool calls need `--jinja`:

```bash
llama-server --model <gguf> --alias Qwen3.8-27B --host 127.0.0.1 --port 8081 --ctx-size 131072 --jinja -ngl 999
```

Qwen 3.8 27B is a known model: pi-chef fills reasoning on, 32768 output tokens and no developer role (a field you set on the entry wins). With one slot (`--parallel 1`) a ticket and other chat on the same server wait for each other.

**Ollama.** Its default context is too small and truncates silently, so set it:

```bash
ollama pull qwen3.5:9b
OLLAMA_CONTEXT_LENGTH=65536 ollama serve
```

```yaml
models:
  low: local/qwen3.5:9b
local:
  baseUrl: http://127.0.0.1:11434/v1
  models:
    - { id: "qwen3.5:9b", contextWindow: 65536 }   # equal to OLLAMA_CONTEXT_LENGTH
```

Use the tag `ollama list` shows. A colon in the id is fine; a `:thinking` suffix counts only when it is one of Pi's thinking levels.

## External agents

`models.*` can name a coding agent: `agent:claude`, or `agent:claude/opus` to pick the agent's own model. Built in: `claude`, `codex`, `cursor-agent`, `grok`, `agy`, `gemini`, `opencode` ([defaults](configuration.md#agents)). Override or add one under `agents` in your user config.

An agent runs in a herdr tab in the repo with its own login; pi-chef never sees its credentials. Pi must run inside herdr. Claude Code and Codex are metered from their session logs; the others show as "not metered".

## Web tools

- `web_search` runs Anthropic's server-side search through Claude Haiku 5.5, using your Anthropic login (`/login anthropic`; API keys are not accepted). It is refused when a budget is spent, and each call is ledgered. Anthropic's per-search fee is not priced, only tokens.
- `web_fetch` runs locally and fetches public http(s) pages only (private, loopback and link-local addresses are refused), converts HTML to markdown, and caps size, redirects and time (see `src/tools/web-fetch.ts`).
