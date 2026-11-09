/**
 * Every /build ticket runs in its own herdr tab. `runTicket` picks the runner by what the model is: a Pi model runs as
 * `pi -ne -e ticket-mode.ts` in the tab (`pi-ticket.ts`), an `agent:<name>` ticket runs that coding agent (`agent-ticket.ts`).
 * `herdrFor` is the check both need first: pi-chef must itself be inside herdr, and `hc` must work.
 */
import { agentCommand, type AgentsConfig } from "../agents.js";
import type { ChunkLimits, ChunkSession, ModelRef } from "../orchestrator/build.js";
import type { HerdrClient } from "../herdr/client.js";
import { messageOf, type TabTimings } from "./tab.js";
import { runAgentTicket, type AgentTicketHost } from "./agent-ticket.js";
import { runPiTicket, type HerdrTicketHost } from "./pi-ticket.js";

/** The stop message when /build is not running inside herdr (or `hc` is missing). No ticket is started. */
export const NEEDS_HERDR = "/build runs each ticket in a herdr tab; start Pi inside herdr and run /build again.";

/** Why this process cannot open ticket tabs, or the space to open them in. Never throws. */
export async function herdrSpace(client: HerdrClient | undefined): Promise<{ space: string } | { problem: string }> {
  if (!client) return { problem: "no herdr client" };
  try {
    const self = await client.self();
    return "problem" in self ? { problem: self.problem } : { space: self.space };
  } catch (error) {
    return { problem: messageOf(error) };
  }
}

export interface TicketRunInput extends TabTimings {
  client: HerdrClient;
  host: HerdrTicketHost & AgentTicketHost;
  /** The herdr space of pi-chef's own terminal. */
  space: string;
  cwd: string;
  ticketId: string;
  /** The ticket's attempt number, for an agent tab's name. */
  attempt: number;
  model: ModelRef;
  limits?: ChunkLimits;
  /** The config's agents, for the argv of an agent ticket. */
  config: AgentsConfig;
  /** Absolute path of this install's `src/ticket-mode.ts`. */
  ticketModePath: string;
  /** Replaces the home directory an agent's usage log is read under (tests). */
  home?: string;
}

/** Runs one ticket attempt in a herdr tab. Never throws: a failure is `{ stopped }`. */
export async function runTicket(input: TicketRunInput, run: (session: ChunkSession) => Promise<void>): Promise<void | { stopped: string }> {
  const { model } = input;
  if (!model.agent) return runPiTicket(input, run);
  let argv: string[];
  try {
    argv = agentCommand({ kind: "agent", ...model.agent }, input.config);
  } catch (error) {
    return { stopped: `Ticket ${input.ticketId} cannot start: ${messageOf(error)}` };
  }
  return runAgentTicket({ ...input, agent: model.agent, argv }, run);
}
