# Pi compatibility

Inspected on 2026-10-14 from the published npm tarballs, not from memory and not from the stale Mintlify mirror.

| Package | Version | Published | Repository |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | **1.2.0** | 2026-10-12 | `earendil-works/pi` |
| `@earendil-works/pi-ai` | **1.2.0** | 2026-10-12 | same monorepo |
| `@mariozechner/pi-coding-agent` | 0.73.1 | 2026-05-07 | `badlogic/pi-mono` (frozen) |

This extension targets `@earendil-works/pi-coding-agent` 1.2.0. The Mario package is the predecessor. Docs that import `@mariozechner/pi-coding-agent` or describe an `Extension.init(context)` lifecycle are older than the API shipped in 1.2.0.

Pi's own docs in the 1.2.0 tarball (`package/docs/extensions.md`, `providers.md`, `models.md`, `virtual-models.md`, `packages.md`, `slash-commands.md`) and the `.d.ts` files are the source of truth below. A test imports the installed providers and checks the auth objects without calling them.

## Account login (OpenAI and Anthropic)

Pi implements both account logins. This project does not implement either OAuth flow and does not fall back to API keys.

### OpenAI

`openaiProvider()` in `@earendil-works/pi-ai` 1.2.0 (`dist/providers/openai.js`) registers:

- `auth.apiKey` — `OPENAI_API_KEY` prompt. **Rejected by this extension.**
- `auth.oauth` — name `OpenAI (ChatGPT subscription)`, `isSubscription: true`, `loginLabel: "Sign in with ChatGPT"`, loader `loadOpenAIChatGPTOAuth`.

The ChatGPT flow (`dist/auth/oauth/openai-chatgpt.js`) is a public client. Its comment says the user access token is sent to `api.openai.com`. Scope includes `chatgpt.tokens.use.direct`. The provider filters classifier models out when the credential type is `oauth`, and `docs/models.md` says ChatGPT sign-in does not work with the Decisions API (`gpt-6-luna`).

A second provider, `openai-codex` (`dist/providers/openai-codex.js`), is named `OpenAI Codex (legacy)`. It has **oauth only** (no `apiKey`): `OpenAI (ChatGPT Plus/Pro)`, `isSubscription: true`, API `openai-codex-responses`, base URL `https://chatgpt.com/backend-api`.

Built-in command: `/login` and `/login [provider]` (`docs/slash-commands.md`). Credentials land in `~/.pi/agent/auth.json`. There is no `ExtensionAPI.login()`.

**Assumption this project does not make:** a ChatGPT or Codex subscription grants API quota. Pi labels the method `isSubscription` and then sends the token to an API. Entitlement has to be verified by a real request after `/login`, which this repo's tests do not perform.

### Anthropic

`anthropicProvider()` registers:

- `auth.apiKey` — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, and workload-identity env vars. **Rejected by this extension.**
- `auth.oauth` — name `Anthropic (Claude Pro/Max)`, `isSubscription: true`, loader `loadAnthropicOAuth`.

The flow (`dist/auth/oauth/anthropic.js`) uses `https://claude.ai/oauth/authorize` and `https://platform.claude.com/v1/oauth/token`. Scopes include `user:inference`. `docs/settings.md` has `warnings.anthropicExtraUsage` (default true): "Warn when Anthropic subscription authentication may use paid extra usage."

**Assumption this project does not make:** Claude Pro/Max includes free third-party harness usage. Pi ships the login and also warns that it may bill extra usage. This extension will use that login when an oauth credential is present, and it will not substitute an API key. A live call is required to confirm the account's entitlement. Tests do not make one.

### What "callable" means here

| Check | OpenAI | Anthropic |
|---|---|---|
| Account-login implementation present in Pi 1.2.0 | Yes (`openai` ChatGPT oauth and legacy `openai-codex`) | Yes (Claude Pro/Max oauth) |
| API-key path also present | Yes, and **disabled by this extension** | Yes, and **disabled by this extension** |
| Extension API to start the browser flow | **No.** User runs Pi's `/login`. `/auth login` only explains that and re-reads status | Same |
| Proven by a live completion in this environment | **No.** No interactive login and no paid calls in tests | **No.** Same |

`/auth status` reads credential **metadata** only (`type`, `expires`). It never copies `access`, `refresh`, or `key` into task files, logs, or prompts. `type: "api_key"` or an `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` environment with no oauth credential is `blocked`, not a fallback. An oauth credential past `expires` is `expired` and the workflow pauses.

## Azure AI Foundry

Pi's built-in `azure` provider (`dist/providers/azure.js`) is **API-key only**: `AZURE_OPENAI_API_KEY`, plus `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`, optional `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` and `AZURE_OPENAI_API_VERSION` (`docs/providers.md`). `auth.oauth` is absent. The provider serves OpenAI models through Responses and other Foundry models through Chat Completions.

This extension does **not** use that API key. Foundry calls go through an isolated client:

- Token source: `az account get-access-token` (Azure CLI / Entra). The token is held in memory for the request and is never written to YAML, prompts, events, or git.
- Endpoint: environment variable named by `endpointEnv` (default `AZURE_AI_ENDPOINT`).
- Deployment, API version, audience, and wire shape (`openai-responses`, `openai-completions`, or `azure-openai-responses`) come from config. One shape is not assumed.

`az` is not invoked by the test suite. A missing CLI or an `az login` failure pauses the Foundry provider.

## Local inference

Documented Pi options (`docs/models.md`, `docs/llama-cpp.md`):

- llama.cpp router via `/login llama.cpp` and `/llama` (Pi's own provider; not reimplemented here).
- OpenAI-compatible endpoints (Ollama, vLLM, LM Studio) via `models.json` with `api: "openai-completions"`. Pi's Ollama example uses a dummy non-secret `apiKey` because the client requires a field. This extension's local client talks to `baseUrl` and sends a bearer only when `apiKeyEnv` is set. The key value is never copied into the repo.

No local server is started in tests. The client is injected.

## Documented extension APIs this project uses

From `dist/core/extensions/types.d.ts` and `docs/extensions.md` in coding-agent 1.2.0:

| Need | Documented API | How we use it |
|---|---|---|
| Load the extension | Default export `(pi: ExtensionAPI) => void` | `src/extension.ts` |
| Slash commands | `pi.registerCommand(name, { description, handler, getArgumentCompletions })` | Every command in the spec. Completions are the documented tab-completion hook |
| Help text | `description` on the command, shown in Pi's `/` menu | Plus an in-command `help` argument |
| Session start / stop | `pi.on("session_start")`, `pi.on("session_shutdown")` | Bind cwd. `session_shutdown` clears the in-process autopilot poll. The factory does not start a timer (docs forbid that). `/autopilot` arms a `setTimeout` for `pollSeconds` or the cycle backoff, and `/autopilot stop` clears it. The timer does not outlive the Pi process; the cursor on disk does |
| Fresh context | `ExtensionCommandContext.newSession({ withSession })` | Command-only. Used for the three boundaries. `docs/extensions.md`: session replacement invalidates the old context; keep only plain data and continue in `withSession` |
| Compact | `ctx.compact()` | Used when `newSession` is cancelled or the host has no command context. Compact does not delete our files |
| Runtime model switch | `pi.setModel(model): Promise<boolean>` | False when the provider has no auth. Also `pi.registerVirtualModel` (`docs/virtual-models.md`) under provider id `cost-opt`, which is always listed because it is not a physical provider |
| Nested / sub-agent calls | `ctx.modelRegistry.streamSimple`, `find`, `hasConfiguredAuth`, `isUsingOAuth`, `getProviderAuthStatus` | OpenAI and Anthropic session calls only when `isUsingOAuth` is true |
| Observe usage | `pi.on("message_end")` | Record token metadata. Message text is not copied |
| Block a tool | `pi.on("tool_call")` returning `{ block: true, reason }` | Destructive shell commands. `user_bash` is the documented hook for commands typed by the user |
| Durable session notes | `pi.appendEntry` | Pointer to the active task id. Task truth lives in `.pi-workflows`, not in the transcript |
| UI | `ctx.ui.notify`, `ctx.ui.confirm`, `ctx.ui.setStatus` | `ctx.hasUI` guards dialogs. Non-interactive mode fails closed when a required confirmation has no UI |
| Package layout | `package.json` `"pi": { "extensions", "skills" }` and `"pi-package"` keyword | Host packages (`pi-coding-agent`, `pi-ai`, `typebox`) are optional peers, not dependencies (`docs/packages.md`) |

Events we deliberately do not subscribe to: `before_provider_headers` (would be a place to inject secrets), `context` / `context_with_system` (would let us rewrite the transcript into a fake reset).

## Documented APIs we considered and did not pretend to have

| Idea | Finding |
|---|---|
| Programmatic `/login` from an extension | Not on `ExtensionAPI`. `/auth login` prints the exact `/login` command and re-reads status |
| Unregister a tool | Docs: tools cannot be unregistered; re-register with `exposure: "hidden"` if needed. We do not hide Pi's tools |
| Auto-merge | Not implemented. `approvals.merge` is `manual`. The GitHub client has no merge method |
| Reset that deletes the transcript in place | `newSession` starts a new session file. `compact` summarizes. Neither deletes `.pi-workflows` artifacts |
| A hook that swaps providers per tool call inside one assistant turn | `registerVirtualModel` routes **per request**. Sub-agents use isolated clients so a worker call does not change `pi.setModel` under the user and so Foundry's Azure CLI token never becomes a Pi `apiKey` |
| Forking Pi | Not required. Stop condition in the spec is not hit |

## Runtime model switching

Pi supports it.

- `pi.setModel` changes the session model and returns false when auth is missing.
- `registerVirtualModel` routes each request to a physical model. Assistant messages record the physical model. State returned from `route` is stored on the session branch.
- `docs/virtual-models.md` says a virtual model cannot route to another virtual model, and routing to a model without credentials ends the request with an error.

The `cost-opt/auto` route therefore:

1. Keeps the previous physical model on `continuation` and `retry` (documented cache guidance).
2. On `user` requests, asks this package's deterministic policy which **tier** to use.
3. Resolves that tier only to a physical model whose provider is account-oauth (OpenAI or Anthropic), or to a Foundry/local model this extension registered.
4. Throws a clear error when the chosen provider is not logged in. It does not select an API-key model.

Isolated clients still exist for sub-agents and for tests. That is additional to switching, not a substitute invented because switching was missing.

## Assumptions that still need a live Pi session

These are labeled assumptions. Unit tests cover the code around them; they do not boot the TUI.

1. `newSession()` from a command handler leaves the new session empty of the previous transcript. The type says "Start a new session". If a host build ever no-ops it, handoff files are still written and `/reset-phase` reports `handoff-only`.
2. `getArgumentCompletions` is what Tab calls. The field exists on `RegisteredCommand`. A live TUI check is still the way to see the menu.
3. `isUsingOAuth(model)` matches the credential Pi will actually send. We also read `auth.json` `type` ourselves when outside a session.
4. `message_end` usage objects are the provider's counts. Missing fields stay unknown in our ledger. Pi's own `Usage.cost` type requires numbers, so a Pi transcript is not our ledger. Our ledger uses `null` for unknown charge.
5. `az account get-access-token` output shape (`accessToken`, `expiresOn`) matches current Azure CLI. The parser accepts that JSON and fails closed otherwise.
6. `gh` is installed and already authenticated for publish. Tests use an in-memory GitHub client. The real client shells `gh` with an argument array and never prints the environment.
7. Anthropic extra-usage billing and ChatGPT token-sharing entitlement can change without a Pi release. Re-read Pi's provider docs before relying on a subscription.

## Implementation plan

Shipped as library modules plus `src/extension.ts`. No hosted coordinator, database, or forked runtime. Policy and transitions are code. Models only fill a validated classification or edit schema.

| Milestone | Slice |
|---|---|
| M1 | Config, redaction, locked journal, auth gate for the four providers, `/status`, `/cost`, `/auth`. Compatibility test asserts Pi's oauth objects exist and Azure's does not |
| M2 | `/plan`, `/route`, classifier schema, deterministic fallback, approval freeze, versioned plans |
| M3 | `/implement` refuses without approval. Worktree allocation, concurrency 2, file ownership, serial integration, restart rebuild |
| M4 | `/review` with tool evidence, security and failing-check fixtures, `/push` gated on confirm + checks, context handoffs |
| M5 | `/autopilot` stepped loop: dedupe, bounded verified fix, no duplicate replies, stop at `MERGE_READY`, no merge. Pause on security, scope change, and human review |
| M6 | Expected cost-to-success, escalation cap, circuit breaker, budget hard stop, CSV/JSON export, baseline comparison fields |

Context boundaries, in order: after plan approval (immutable plan + handoff), after implementation (diff, tests, decisions, open issues), after publish (PR ids, branch, head SHA, checks, findings). Each one writes a file under `handoffs/` and then calls `newSession` when the command context provides it. A reset never deletes artifacts.
