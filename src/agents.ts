import { THINKING_LEVELS, WorkflowError, type ThinkingLevel } from "./domain.js";

/** An external coding agent: the argv that starts it in a terminal, and the flag that picks its model. */
export interface AgentDef {
  run: string[];
  modelFlag?: string;
}

/**
 * The agents pi-chef knows. `agents:` in the user config overrides an entry key by key, or adds one; an override's `run`
 * replaces the whole argv, flags below included. Each default lets the agent edit files unattended but still asks for risky
 * things (shell commands, the network): the CLI's own "accept edits" mode where it has one, never a "skip all permissions"
 * flag. Chosen from each CLI's `--help` on 2026-11-08 (docs/configuration.md lists the evidence):
 * - claude `--permission-mode acceptEdits`, grok `--permission-mode acceptEdits`, agy `--mode accept-edits`,
 *   gemini `--approval-mode auto_edit`;
 * - codex `-s workspace-write -a on-request` (its "Auto" preset: edits inside the workspace, asks to go outside it);
 * - cursor-agent `--auto-review` (a classifier auto-runs safe tool calls and prompts for the rest; `--force`/`--yolo` is not used);
 * - opencode has no such mode (`--auto` approves everything not denied), so it runs as it is and follows its own permission config.
 */
export const BUILTIN_AGENTS: Readonly<Record<string, AgentDef>> = {
  claude: { run: ["claude", "--permission-mode", "acceptEdits"], modelFlag: "--model" },
  codex: { run: ["codex", "--no-daemon", "-s", "workspace-write", "-a", "on-request"], modelFlag: "-m" },
  "cursor-agent": { run: ["cursor-agent", "--auto-review"], modelFlag: "--model" },
  grok: { run: ["grok", "--permission-mode", "acceptEdits"], modelFlag: "-m" },
  agy: { run: ["agy", "--mode", "accept-edits"], modelFlag: "--model" },
  gemini: { run: ["gemini", "--approval-mode", "auto_edit"], modelFlag: "-m" },
  opencode: { run: ["opencode"], modelFlag: "--model" },
};

/** The slice of the config these functions read. */
export interface AgentsConfig {
  agents?: Record<string, AgentDef>;
}

/** What a `models.*` value names: a Pi model, or an external agent run in a herdr tab. */
export type TicketModel =
  | { kind: "pi"; provider: string; id: string; thinking?: ThinkingLevel }
  | { kind: "agent"; name: string; model?: string };

export const AGENT_PREFIX = "agent:";
/** The `provider` a ticket run records when an agent built it; its `model` is `<name>[/<model>]`. */
export const AGENT_PROVIDER = "agent";

/** A recorded run's model for messages and tables: `provider/id`, or `agent:<name>[/<model>]` for an agent run. */
export function ranModelText(provider: string, id: string): string {
  return provider === AGENT_PROVIDER ? `${AGENT_PREFIX}${id}` : `${provider}/${id}`;
}
const AGENT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Splits `provider/id` at the first slash. Undefined when either part is empty or there is whitespace. */
export function parseModelRef(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || /\s/.test(value)) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** The built-in agents with the config's overrides applied (an override keeps the built-in `modelFlag` it does not set). */
export function agentTable(config: AgentsConfig): Record<string, AgentDef> {
  const out: Record<string, AgentDef> = { ...BUILTIN_AGENTS };
  for (const [name, def] of Object.entries(config.agents ?? {})) out[name] = { ...out[name], ...def };
  return out;
}

function bad(text: string, why: string): never {
  throw new WorkflowError("CONFIG_INVALID", `"${text}" ${why}`);
}

/**
 * Reads a `models.*` value. `provider/id` is a Pi model, with an optional `:thinking` suffix (`anthropic/claude-opus-5-5:high`)
 * that counts only when it is one of Pi's thinking levels, so an id with a colon (`local/qwen3.5:9b`) stays whole.
 * `agent:<name>` or `agent:<name>/<model>` is an external agent; the name must be built in or defined under `agents`.
 * Throws a `CONFIG_INVALID` WorkflowError for anything else. `anyAgent` checks the shape only, for a file that may name
 * an agent another file defines.
 */
export function parseTicketModel(text: string, config: AgentsConfig = {}, options: { anyAgent?: boolean } = {}): TicketModel {
  const value = text.trim();
  if (value === "") throw new WorkflowError("CONFIG_INVALID", "A model must not be empty. Use provider/id or agent:<name>.");
  if (value.startsWith(AGENT_PREFIX)) {
    const rest = value.slice(AGENT_PREFIX.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const model = slash < 0 ? undefined : rest.slice(slash + 1);
    if (!AGENT_NAME.test(name)) bad(value, "must be agent:<name> or agent:<name>/<model>");
    const known = agentTable(config);
    if (!options.anyAgent && !known[name]) bad(value, `names an unknown agent. Known agents: ${Object.keys(known).join(", ")}; add your own under agents.`);
    if (model !== undefined && (model === "" || /\s/.test(model))) bad(value, "has an empty model or one with whitespace");
    if (!options.anyAgent && model !== undefined && !known[name]!.modelFlag) bad(value, `names a model, but the ${name} agent has no modelFlag`);
    return { kind: "agent", name, ...(model !== undefined ? { model } : {}) };
  }
  let ref = value;
  let thinking: ThinkingLevel | undefined;
  const colon = value.lastIndexOf(":");
  if (colon > 0) {
    const suffix = value.slice(colon + 1);
    if ((THINKING_LEVELS as readonly string[]).includes(suffix)) {
      thinking = suffix as ThinkingLevel;
      ref = value.slice(0, colon);
    }
  }
  const parsed = parseModelRef(ref);
  if (!parsed) bad(value, "must be provider/id (for example anthropic/claude-sonnet-5-5), or agent:<name>");
  return { kind: "pi", provider: parsed.provider, id: parsed.id, ...(thinking ? { thinking } : {}) };
}

/** The `parseTicketModel` error message, or undefined when `text` is a valid model. */
export function ticketModelProblem(text: string, config: AgentsConfig = {}, options: { anyAgent?: boolean } = {}): string | undefined {
  try {
    parseTicketModel(text, config, options);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** How a model reads in messages and tables: `provider/id`, or `agent:<name>[/<model>]`. */
export function modelText(model: TicketModel): string {
  return model.kind === "pi" ? `${model.provider}/${model.id}` : `${AGENT_PREFIX}${model.name}${model.model ? `/${model.model}` : ""}`;
}

/** The argv that starts an agent in a terminal: its `run` plus the model flag and model when one is named. */
export function agentCommand(ref: Extract<TicketModel, { kind: "agent" }>, config: AgentsConfig = {}): string[] {
  const def = agentTable(config)[ref.name];
  if (!def) throw new WorkflowError("CONFIG_INVALID", `Unknown agent "${ref.name}".`);
  if (!ref.model) return [...def.run];
  if (!def.modelFlag) throw new WorkflowError("CONFIG_INVALID", `The ${ref.name} agent has no modelFlag, so agent:${ref.name}/${ref.model} cannot pick a model.`);
  return [...def.run, def.modelFlag, ref.model];
}
