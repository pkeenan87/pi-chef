# Providers

How each provider signs in and is set up: account login for OpenAI, Anthropic and xAI, Azure AI Foundry, Vercel AI Gateway, a local server, and the web tools. Which provider serves which job is in [configuration.md](configuration.md#tiers-and-who-serves-them).

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
# ~/.pi/agent/chef.yaml
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

The current Foundry route is the OpenAI-compatible v1 API at `https://<resource>.services.ai.azure.com/openai/v1/` (also `<resource>.openai.azure.com/openai/v1/`). The deployment name goes in `model`, there is no `api-version`, and the Entra token audience is `https://ai.azure.com`. A `tiers` entry for Foundry names a model, for example `{ provider: foundry, model: grok-4-7 }`; `providers.foundry.deployments` maps that model to your Azure deployment name when they differ (next section).

Configs written for the legacy deployments route keep working: set `apiVersion` (and the `cognitiveservices` audience) and omit `routeStyle`, and requests go to `/openai/deployments/<name>/chat/completions?api-version=...` as before. Set `routeStyle: v1` to opt in.

`az account get-access-token` supplies the bearer for a call. Chat models registered with Pi read it through an `!az account get-access-token ...` command. Do not set `AZURE_OPENAI_API_KEY` for this workflow.

Foundry serves chat models only (for example a `gpt-6-astra` deployment as an advisor).

### Deployments with different names

`providers.foundry.deployments` maps a Foundry `model` value used in the tiers (including the built-in ones) to your Azure deployment name. A model with no entry is called by its own name.

```yaml
providers:
  foundry:
    endpoint: https://<resource>.services.ai.azure.com
    resourceGroup: my-rg              # optional, user config only; /status foundry uses it to list deployments
    deployments:
      gpt-6.1-sol: my-sol
      grok-4-7: grok-4-6
```

Pi is registered with the deployment name (`my-sol`). Route events, labels, `/status`, and stop messages show `foundry/gpt-6.1-sol → my-sol`; metrics keep the model name. Pricing tries a row for the deployment name first, then the model name, so add a `pricing` row for `foundry` / `my-sol` when its price differs. If a deployment name reads like a different model or version than its key (different version digits, as with `grok-4-7` mapped to `grok-4-6`), the load warns that a pricing row for the deployment is recommended; this is a warning only. `deployments` may be set in a project config as well as the user config (it only renames Foundry targets). The old `deployments.cheap`, `reasoning`, and `classifier` keys are ignored with a warning; name the models under `tiers` instead.

### Foundry as the fallback for OpenAI and xAI

The built-in tiers and the sample config list a Foundry deployment after each OpenAI or xAI entry (ticketLow: `xai/grok-4.7` then `foundry/grok-4-7`; ticketHigh and standard: `openai/gpt-6.1-sol` then `foundry/gpt-6.1-sol`; batch: `openai/gpt-6-luna` then `foundry/gpt-6-luna`; advisor: Astra on OpenAI, Fable, then `foundry/gpt-6-astra`). The router tries a tier's candidates by cost per success and skips any whose provider is unavailable. A Foundry candidate with no endpoint configured, or no `az login`, is unavailable, so nothing changes for you without Foundry. The `model` values assume deployments named like the models: rename them to your own deployment names in your config (a tier list in your config replaces the built-in one).

Foundry is billed per token, not by subscription, so its pricing rows are real list prices (the sample config has Azure list prices; verify them against your Azure rate card) and it has no `quota.models` rows. The medium-ticket advisor rule compares vendors by model name, so a Foundry Astra counts as OpenAI's model and a Foundry Grok as xAI's.

`providers.foundry.api` sets the wire API for every Foundry deployment (default `openai-completions`). A Foundry tier entry may override it for one deployment with `api`. `gpt-6.1-sol` supports tool calling only through the Responses API, so give it `openai-responses`:

```yaml
tiers:
  ticketHigh:
    - { provider: openai, model: gpt-6.1-sol }
    - { provider: foundry, model: gpt-6.1-sol, api: openai-responses }
```

If the same deployment appears in several tiers with different `api` values, the first one wins and `/status` shows a warning. `api` is accepted only on `provider: foundry` entries. Pi's Responses client posts to `<baseUrl>/responses`, and the Foundry base is `<endpoint>/openai/v1`, so a Sol request goes to `<endpoint>/openai/v1/responses` with no `api-version`.

Put `endpoint` (or `endpointEnv`) and `audience` in your user config, `~/.pi/agent/chef.yaml`: a project config cannot set `endpoint`, `endpointEnv` (except the sample's `AZURE_AI_ENDPOINT` when you define no Foundry block) or `audience`, and the endpoint must be `https`. `az` must be on the PATH of the Pi process, because Pi runs `az account get-access-token` for each request.

### Enterprise ChatGPT or no SuperGrok

If your ChatGPT Enterprise login does not work in Pi for OpenAI, or you have no SuperGrok login for xAI:

1. Deploy the models in Azure AI Foundry (for example `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`, `grok-4-7`) and note each deployment name.
2. Run `az login`, and make sure `az` is on the PATH Pi runs with.
3. In `~/.pi/agent/chef.yaml`, define the provider:

   ```yaml
   providers:
     foundry:
       type: azure-foundry
       auth: azure-cli
       endpoint: https://<resource>.services.ai.azure.com
       routeStyle: v1
       audience: https://ai.azure.com
   ```

4. If your deployment names differ from the model names, add a `deployments:` map under `providers.foundry` (see above). Run `/status foundry` to list your deployments and see which tier entries have none.
5. Copy the Foundry `pricing` rows (check them against your Azure rate card), run `/auth status` to see `foundry: ready`, then `/status`.

OpenAI and xAI candidates stay in the lists; with no working login they are unavailable and the Foundry entry that follows each one is used.

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

The gateway authenticates with `Authorization: Bearer <VERCEL_OIDC_TOKEN>`. The token comes from the `VERCEL_OIDC_TOKEN` environment variable or from `envFile` inside `projectDir`. The expiry is read from the token's `exp` claim (not verified; Vercel verifies it). If the token is missing or has less than 10 minutes left when routing checks Vercel (the auth probe, also behind `/auth status` and `/status`), the extension runs `vercel env pull .env.local --yes` in `projectDir` (an argument array, no shell) and reads the file again; Pi then reads the fresh token from that file. A failed pull marks Vercel not signed in, with the error. Tokens last about 12 hours. The token is cached in memory until it nears expiry and is never logged, written to config, or put in a task file. Model ids are `creator/model`, for example `anthropic/claude-haiku-5-5`.

`/auth status` reports Vercel. `/auth login vercel` prints `vercel login && vercel link`. The ignore rules should already cover `.env.local`; check that yours do.

## Local inference

```yaml
providers:
  local:
    type: openai-compatible
    baseUrl: http://127.0.0.1:11434/v1
    model: qwen2.5-coder:7b
```

Point `baseUrl` at Ollama, vLLM, or llama.cpp's OpenAI-compatible server. This process does not start that server. The deterministic tier uses it only while `<baseUrl>/models` answers.

### Ollama for local mode

[Local mode](../README.md#local-mode) runs every ticket on the one model in `tiers.local`, through `providers.local` above:

```bash
ollama pull qwen3.5:9b
# Ollama's default context is far smaller than a coding session needs, and it truncates silently:
OLLAMA_CONTEXT_LENGTH=65536 ollama serve
```

To use another model, name it with the tag `ollama list` shows, and keep `contextWindow` equal to the context Ollama runs it with:

```yaml
tiers:
  local: [{ provider: local, model: "gemma3:27b", contextWindow: 65536 }]
```

The size in the tag (`9b`, `27b`) tells the planner how small to make the tickets; a tag with no size gets the strictest ones. Pick a model that calls tools well: the ticket session uses Pi's read, edit and bash tools. `/auth status` shows whether `<baseUrl>/models` answers, and `/status` shows the local model and its ticket limits. A local ticket can still call `web_search` (Anthropic) and `web_fetch`; its per-ticket review runs on the review tier (Opus).

## Web tools

The extension registers two tools for the model to call.

- `web_search` runs Anthropic's server-side `web_search_20250305` tool through Claude Haiku 5.5 (`claude-haiku-5-5`), using your Anthropic account login (`/login anthropic`). API keys are not accepted. It is refused when the task or daily budget is exhausted. Each call is written to the cost ledger (tier `web_search`, no query text), including a billed first request when the follow-up request fails; its spend shows in the status line's task total. Anthropic's per-search fee is not priced: `pricing:` rows only hold token prices, so only token cost is computed.
- `web_fetch` runs locally. It fetches public http(s) pages only (private, loopback, and link-local addresses are refused, including IPv4 hidden in IPv6 forms such as IPv4-mapped, NAT64, 6to4 and Teredo), converts HTML to markdown, and caps response size, redirects, and time. See `src/tools/web-fetch.ts` for the exact limits.
