/**
 * A /build ticket in its own in-process Pi session (the "ticket subagent"), instead of replacing the user's session.
 *
 * pi-chef creates the session with Pi's SDK (`createAgentSession`) on the routed model and thinking level, with no
 * extensions loaded (so pi-chef does not load itself again) but with the project's context files and skills. Its tools
 * are Pi's own read/edit/write/grep/find/ls, plus a bash whose `execute` applies the same rules the main session's
 * `tool_call` hook does: the deny rules, and no push, branch switch or worktree change during a ticket. Every assistant
 * message is handed to `onMessage` for the ledger, and the turn budget is counted here.
 *
 * Everything Pi-specific comes in through `ChildSdk`, so tests drive this with fakes.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { buildBashBlock, isDeniedCommand } from "../sandbox.js";
import { checkSyntax, syntaxNote, type SyntaxCheck } from "./syntax.js";
import { redact } from "../redact.js";
import { turnBudget, type ChunkLimits, type ChunkReply } from "../orchestrator/build.js";
import type { ThinkingLevel } from "../domain.js";

/** The tool names a ticket session has. No `task` or other extension tools: the ticket cannot spawn more agents. */
export const TICKET_TOOLS = ["read", "edit", "write", "grep", "find", "ls", "bash"] as const;

/** A message as the child session reports it (Pi's AgentMessage, the fields pi-chef reads). */
export interface ChildMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

/** The child session events pi-chef listens to. */
export type ChildEvent =
  | { type: "message_end"; message: ChildMessage }
  | { type: "tool_execution_start"; toolName: string; args?: unknown }
  | { type: "agent_settled"; aborted: boolean }
  | { type: string; [key: string]: unknown };

/** The part of Pi's AgentSession a ticket uses. */
export interface ChildSession {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void> | void;
  abort(): Promise<void> | void;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: ChildEvent) => void): () => void;
  dispose(): void;
  readonly sessionManager?: { getEntries(): unknown[]; getSessionId(): string };
}

/** A tool definition as Pi's create*ToolDefinition returns it: pi-chef only wraps `execute`. */
export interface ChildTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>, ...rest: unknown[]): Promise<unknown>;
  [key: string]: unknown;
}

/** What pi-chef needs from Pi's SDK to open a ticket session. */
export interface ChildSdk {
  /** Opens the session. `tools` are the definitions to register; built-in tools are off (`noTools: "builtin"`). */
  open(options: { cwd: string; model: unknown; thinking?: ThinkingLevel; tools: ChildTool[]; systemPrompt?: string }): Promise<ChildSession>;
  /** Pi's tool definitions for `cwd`, by name. */
  tools(cwd: string): ChildTool[];
}

/** Why bash may not run this command during a ticket, or undefined when it may. */
export function ticketBashProblem(command: string): string | undefined {
  if (isDeniedCommand(command)) return "Blocked destructive command. It stays blocked until a person runs an approved command.";
  return buildBashBlock(command);
}

/**
 * A tool whose changes are checked for syntax (`syntax.ts`): a file that parsed before the change (or did not exist)
 * and does not parse after it gets the parser's message appended to the tool result. Never fails the tool.
 */
function syntaxChecked(tool: ChildTool, cwd: string, check: SyntaxCheck): ChildTool {
  return {
    ...tool,
    async execute(toolCallId: string, params: Record<string, unknown>, ...rest: unknown[]) {
      const relative = typeof params?.path === "string" ? params.path : undefined;
      const file = relative ? path.resolve(cwd, relative) : undefined;
      const before = file && existsSync(file) ? await check(file, cwd).catch(() => "unknown") : undefined;
      const result = await tool.execute(toolCallId, params, ...rest);
      if (!file || before !== undefined) return result;
      const after = await check(file, cwd).catch(() => undefined);
      if (!after) return result;
      const shaped = result as { content?: unknown };
      if (!shaped || typeof shaped !== "object" || !Array.isArray(shaped.content)) return result;
      return { ...shaped, content: [...shaped.content, { type: "text", text: syntaxNote(relative!, redact(after)) }] };
    },
  };
}

/**
 * The tools of a ticket session: Pi's own, with bash refusing what a ticket may not run and edit/write reporting a
 * file they broke. Unknown names are dropped.
 */
export function ticketTools(all: ChildTool[], options: { cwd?: string; syntax?: SyntaxCheck | false } = {}): ChildTool[] {
  const byName = new Map(all.map((tool) => [tool.name, tool]));
  const syntax = options.syntax === false ? undefined : (options.syntax ?? checkSyntax);
  return TICKET_TOOLS.flatMap((name) => {
    const tool = byName.get(name);
    if (!tool) return [];
    if ((name === "edit" || name === "write") && syntax && options.cwd) return [syntaxChecked(tool, options.cwd, syntax)];
    if (name !== "bash") return [tool];
    return [
      {
        ...tool,
        async execute(toolCallId: string, params: Record<string, unknown>, ...rest: unknown[]) {
          const command = typeof params?.command === "string" ? params.command : "";
          const problem = ticketBashProblem(command);
          // A thrown error is the tool's error result: the model reads why and carries on.
          if (problem) throw new Error(problem);
          return tool.execute(toolCallId, params, ...rest);
        },
      },
    ];
  });
}

/** The text of an assistant message. */
function textOf(message: ChildMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("");
}

/** A short label for a tool call on the progress line: `edit src/x.ts`, `bash npm test`. */
export function toolActivity(toolName: string, args: unknown): string {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const detail = typeof input.path === "string" ? input.path : typeof input.command === "string" ? input.command : typeof input.pattern === "string" ? input.pattern : "";
  const flat = redact(detail).replace(/\s+/g, " ").trim();
  return flat ? `${toolName} ${flat.length > 60 ? `${flat.slice(0, 59)}…` : flat}` : toolName;
}

export interface TicketAgentOptions {
  sdk: ChildSdk;
  cwd: string;
  /** The model object from Pi's registry. */
  model: unknown;
  thinking?: ThinkingLevel;
  limits?: ChunkLimits;
  /** Each finished message of the child (assistant turns carry usage): the caller ledgers it. */
  onMessage?: (message: ChildMessage) => void;
  /** One line per tool call and turn, for the progress line. */
  onActivity?: (text: string) => void;
  /** The syntax check of edit and write (default `checkSyntax`); false turns it off. */
  syntax?: SyntaxCheck | false;
  /**
   * The watchdog: after every `every` assistant turns, `look(turn)` runs in the background (one at a time, never
   * blocking the ticket); a text it returns is steered into the ticket while it is still running.
   */
  watchdog?: { every: number; look: (turn: number) => Promise<string | undefined> };
}

export interface TicketAgent {
  send(text: string): Promise<ChunkReply>;
  /** Pi's own entries of the child session (compaction and the like), for `recordPiUsage`. */
  entries(): { sessionId: string; entries: unknown[] } | undefined;
  dispose(): void;
}

/**
 * Opens a ticket session. The turn budget covers every `send` of the attempt: at `limits.maxTurns` the model is steered
 * to finish, and TURN_GRACE turns later the run is aborted and the reply says `turnLimit`. Callbacks never throw into Pi.
 */
export async function openTicketAgent(options: TicketAgentOptions): Promise<TicketAgent> {
  const session = await options.sdk.open({ cwd: options.cwd, model: options.model, thinking: options.thinking, tools: ticketTools(options.sdk.tools(options.cwd), { cwd: options.cwd, syntax: options.syntax }) });
  let lastText = "";
  let aborted = false;
  let turns = 0;
  // A watchdog look in flight, and whether a send is running (a note that arrives after the run is dropped).
  let watching = false;
  let running = false;
  const budget = turnBudget(options.limits, (text) => session.steer(text), () => session.abort());
  const quietly = (action: () => unknown) => {
    try {
      const result = action();
      if (result && typeof (result as Promise<unknown>).catch === "function") (result as Promise<unknown>).catch(() => undefined);
    } catch {
      /* the child keeps running; the next event tries again */
    }
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end") {
      const message = (event as { message: ChildMessage }).message;
      quietly(() => options.onMessage?.(message));
      if (message.role !== "assistant") return;
      const text = textOf(message);
      if (text.trim()) lastText = text;
      if (message.stopReason === "aborted") aborted = true;
      turns += 1;
      quietly(() => options.onActivity?.(`turn ${turns}`));
      budget.count();
      const watchdog = options.watchdog;
      if (watchdog && watchdog.every > 0 && turns % watchdog.every === 0 && !watching && running && !budget.stopped()) {
        watching = true;
        const turn = turns;
        void watchdog
          .look(turn)
          .then((note) => {
            if (note && running && !budget.stopped()) quietly(() => session.steer(note));
          })
          .catch(() => undefined)
          .finally(() => {
            watching = false;
          });
      }
    } else if (event.type === "tool_execution_start") {
      const call = event as { toolName: string; args?: unknown };
      // The tool belongs to the turn that asked for it, which has just been counted.
      quietly(() => options.onActivity?.(`turn ${turns} · ${toolActivity(call.toolName, call.args)}`));
    } else if (event.type === "agent_settled" && (event as { aborted?: boolean }).aborted) {
      aborted = true;
    }
  });
  return {
    async send(text) {
      lastText = "";
      aborted = false;
      running = true;
      try {
        await session.prompt(text);
        await session.waitForIdle();
      } finally {
        running = false;
      }
      return { lastText, aborted: aborted || budget.stopped(), ...(budget.stopped() ? { turnLimit: true } : {}) };
    },
    entries() {
      try {
        const manager = session.sessionManager;
        return manager ? { sessionId: manager.getSessionId(), entries: manager.getEntries() } : undefined;
      } catch {
        return undefined;
      }
    },
    dispose() {
      quietly(unsubscribe);
      quietly(() => session.dispose());
    },
  };
}
