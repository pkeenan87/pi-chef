# Plan: a herdr mod for pi-chef's config

A herdr panel (`chef-config`) that shows and edits every pi-chef setting in
`~/.pi/agent/chef.yaml` (user) and `<project>/.pi-workflows/config.yaml`
(project), with the layering made visible: for each key, the user value, the
project value, the built-in default, the effective value, and the rule that
picked it.

Read first: `AGENTS.md` and `docs/configuration.md` (this repo),
`~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts` (herdr).

## Architecture: two halves, one bridge

A herdr mod is JavaScript with no npm, no TypeScript and no YAML parser. All
reading, validating and writing of config therefore lives in pi-chef, behind a
CLI; the mod is only UI and calls it with herdr's `exec(cmd, args)`.

```
herdr mod (UI)  --exec-->  chef-config CLI (pi-chef, Node)  -->  chef.yaml / config.yaml
                <--JSON--                                     uses config.ts: parseConfig,
                                                              layerConfigs, assertNoSecrets
```

1. **`src/config-schema.ts`** (new). One table of every key the loader reads:
   `key` (dotted path), `section`, `type` (`bool`, `int`, `usd`, `ms`, `enum`,
   `string`, `path`, `modelRef`, `list`, `object-list`, `map`), `enum` values,
   `min`/`max`, `default`, `rule` (`project-wins`, `merged`, `replaced`,
   `lower-wins`, `higher-wins`, `off-only`, `user-only`, `restricts-only`,
   `adds-to`, `fixed`), and a one-line `description`, all taken from
   `docs/configuration.md`. No such table exists today.
2. **`src/cli/chef-config.ts`** (new), built to `dist/` and run through a thin
   `bin/chef-config.mjs` (listed in `bin` and `files`). Commands, all printing
   JSON on stdout, exit 0 with `{ok:false, error}` for config problems and
   nonzero only for usage errors:
   - `inspect --cwd <dir>`: paths of both files (and whether each exists), raw
     text, parsed values, per-key `{user, project, default, effective, source,
     rule}`, `warnings` and `errors` exactly as `loadConfig` reports them
     (redacted), and the schema.
   - `set --cwd <dir> --file user|project --key a.b.c --value <yaml scalar or
     flow value> [--expect <sha256 of current text>]`: edit with the `yaml`
     Document API so comments survive, run `parseConfig` on the result (which
     includes the secret check), refuse if the whole file would be rejected,
     refuse a stale `--expect`, then write atomically. Prints the new `inspect`.
   - `unset` (same args minus `--value`): remove the key, so the default or
     the other file applies again.
   - `validate --cwd <dir> --file user|project --text-file <tmp>`: for the raw
     editor (P4).
   Spawn nothing; argv only; never print a secret.
3. **herdr mod `~/.config/herdr-app/mods/chef-config/`**: `main.js`,
   `mod.json` (`{"place":"none"}`). Opened with
   `tab.new {mod: "chef-config", props: {folder}}` or `pane.split`. The project
   is `props().folder`, else the focused pane's `cwd`, walked up to the git
   root. The CLI path is a setting stored with `setShared("chef-config.cli",
   …)`, defaulting to `node <pi-chef>/bin/chef-config.mjs`; never hardcode
   `~/Work/pi-chef` in logic.
4. **Source of the mod** lives in this repo at `herdr/chef-config/` (herdr's own
   folder is not under version control). `npm run herdr:install` copies it to
   `~/.config/herdr-app/mods/chef-config/`. Document it in `docs/install.md`.

## Decisions (settled here, not left to the builder)

- **How the CLI runs.** Node cannot run `src/*.ts` directly (imports use `.js`
  specifiers, no `rewriteRelativeImportExtensions`), and `jiti` is only a
  transitive dependency. So the CLI is compiled: `npm run build` emits
  `dist/cli/chef-config.js`; `bin/chef-config.mjs` imports it and, if `dist/`
  is missing, prints `{ok:false, error:"run npm run build in <dir>"}`.
- **Commented-out keys.** `templates/chef.yaml` ships every user setting as
  `#   key: value` under a `# section:` header. Setting such a key uncomments
  that exact line and its section header in place (keeping its trailing
  comment, replacing the value). If no such line exists, fall back to
  `Document.setIn`. `unset` of a key that came from the template comments it
  back out rather than deleting it.
- **Which file an edit goes to.** The user picks, per edit, User or Project.
  The UI disables Project for `user-only` keys (`workspaceDir`, `isolation.*`,
  `session.model`, `session.compactionTier`, `routing.reviewTier`, every
  credential/location field: `baseUrl`, `endpoint`, `endpointEnv`,
  `apiKeyEnv`, `audience`, `projectDir`, `envFile`, `resourceGroup`,
  `apiKeyFallback`) and for `fixed` keys (`approvals.*`). For `lower-wins` /
  `higher-wins` / `off-only` keys it shows both values and the effective one,
  with a note when a raise in one file is beaten by the other.
- **Writes go only through the CLI.** The mod never calls `writeTextFile` on a
  config file. One path for validation, secrets, staleness and atomic write.
- **No secrets, ever.** The CLI's `parseConfig` already rejects them; the mod
  also refuses to send a value to a key whose name or value looks secret, and
  shows CLI output redacted. No field accepts a key or token.
- **Reload.** pi-chef already re-reads changed config on the next command; the
  mod says so after a save. The mod re-runs `inspect` after each write and when
  `watchFolder` reports a change to either file's folder (with a 10 s timer
  fallback for `~/.pi/agent`).

## The panel

- Header: project path (click to pick another with `pickFolder`), the two file
  paths with exists/missing, a Warnings count, and a Raw YAML button.
- Left: sections in the order of `docs/configuration.md`: Top level,
  session, localMode, workers, budgets, approvals, routing, tiers, providers,
  review, advisors, pricing, quota.
- Right: one row per key: name, effective value, source chip
  (default / user / project), rule chip, and the control. Controls: `Switch`
  for `bool`; option buttons for `enum` (a real `Select` needs a hand-built popup and key handling; revisit with tier names in P3); `NumberInput` for numbers
  (min/max from the schema); `Input` for strings, paths and `provider/id`;
  a Reset button that runs `unset`. Description below in `muted`.
- Errors: a rejected `set` shows the CLI's error inline on that row; nothing is
  written. File-level errors (whole file rejected) show as a banner.
- Theme colors only (`theme()`), `InputState.new` in `init`, async work in
  `cx.spawn`, no stored `cx`, no animation timers.

## Phases and tickets

Each ticket is built by the **builder** tab, then checked by the **reviewer**
tab before the next one starts. Done for every ticket: `npm test` and
`npm run typecheck` green; for mod tickets also
`herdr-app check ~/.config/herdr-app/mods/chef-config` passes and the panel
opens in a tab on this repo and shows the real files.

### P1: read-only view

1. **Schema table** (`src/config-schema.ts`, `tests/config-schema.test.ts`).
   Every key from `docs/configuration.md`'s tables. Test: every key in those
   tables and every `#   key:` line in `templates/chef.yaml` is in the schema,
   and every schema `default` equals what `loadConfig` produces with no files.
2. **CLI `inspect`** (`src/cli/chef-config.ts`, `bin/chef-config.mjs`,
   `package.json` `bin`/`files`, tests with temp HOME and project dirs).
   Covers: no files, user only, both, a rejected project file, a `.yml` name,
   the legacy `cost-workflow.yaml`, a user-only key set in the project (shows
   the warning, effective = user). Docs: `docs/install.md`.
3. **Mod, read-only** (`herdr/chef-config/`, `npm run herdr:install`). Adds the `ctrl-shift-g` key and a palette entry (see Decided). Sections,
   rows with all four values, source and rule chips, warnings, errors.

### P2: edit scalar settings

4. **CLI `set` / `unset`** with the template-aware uncomment, `--expect`, and
   refusal of rejected results. Tests: comments preserved byte-for-byte outside
   the edited line; uncomment of a template key; a secret value refused; a
   budget set to 0 refused; a stale `--expect` refused; user-only key to the
   project file refused.
5. **Mod controls** for `bool`, `enum`, numbers and strings across top level,
   session, localMode, workers, budgets, routing, review, advisors, isolation.
   User/Project picker per edit, disabled per the rules above.

### P3: structured settings

6. **`checks` / `setup` and other plain lists** (`orgProviderAllowlist`,
   `routing.requirePremiumReviewFor`, `localMode.difficulties`): add, remove,
   reorder rows.
7. **Tiers**: per tier, an ordered list of `{provider, model, …}` entries;
   provider is a `Select`, model offers `KNOWN_LOCAL_MODELS` /
   `KNOWN_FOUNDRY_MODELS` presets; shows which models lack a pricing row
   (`unpricedTierModels`).
8. **Providers**: per provider block, credential/location fields user-file
   only; never a secret field.
9. **Pricing and quota rows**: tables with add/edit/remove; `effectiveFrom`
   validated by `normalizeEffectiveFrom`.

### P4: raw YAML

10. **Raw editor**: `Editor` with YAML highlighting on either file; Save runs
    CLI `validate`, then writes through the CLI with `--expect`. Shows the
    error and keeps the buffer when rejected.

## Decided

- **Opening it:** a key and the command palette. The key is `ctrl-shift-g` in
  the `global` section of `~/.config/herdr-app/keys.json`, bound to
  `{"command": "tab.new", "args": {"mod": "chef-config", "name": "chef config"}}`
  (free today; any edit makes `keys.json` the user's, so later herdr default
  keys must be added by hand). Ticket 3 finds out how a mod gets a palette
  entry (`herdr-app commands`, the shipped `help`/`picker` mods) and adds one;
  if herdr has no way, it says so instead of faking it.
- **Personal:** no RECIPE.md, preview or publishing for now.
- **Scope:** P1 and P2 (tickets 1-5). P3 and P4 stay in this plan for later.

## Status (2026-11-08)

Tickets 1-5 built by the builder tab, each passed review in the reviewer tab
(fix rounds: T1 1, T2 1, T3 2, T4 2 + follow-ups, T5 small fixes). Uncommitted.
Not done: a look at the panel on screen (herdr was off-screen the whole run);
P3 (lists, tiers, providers, pricing, quota) and P4 (raw YAML). No palette
entry: herdr has no API for one. Enum controls are option buttons, not Select.
