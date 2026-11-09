/**
 * The workflow side of the ticket runners: where a tab's session files live, how a child's or an agent's spend is ledgered,
 * and the git moves an agent ticket needs. One adapter for both runners, over a getter because Pi may replace the
 * Workflow with the session. `changed` runs after anything is ledgered (the host redraws its status line).
 */
import type { Workflow } from "../orchestrator/service.js";
import type { AgentTicketHost } from "./agent-ticket.js";
import type { HerdrTicketHost } from "./pi-ticket.js";

export function ticketHost(getWorkflow: () => Workflow, changed: () => void = () => undefined): HerdrTicketHost & AgentTicketHost {
  return {
    sessionsRoot: () => getWorkflow().ticketSessionsRoot(),
    taskName: () => getWorkflow().ticketSessionsName(),
    ledger: (files, id, launched) => {
      getWorkflow().ledgerChildSession(files, { ticketId: id, model: launched });
      changed();
    },
    sweep: (id, launched) => void getWorkflow().sweepTicketSessions(id, { model: launched }),
    ledgerAgent: (entries, id) => {
      const agent = entries[0]?.agent ?? "agent";
      getWorkflow().recordAgentUsage({ reason: `agent ${agent}`, entries, ticketId: id });
      changed();
    },
    agentLogRead: (file, offset) => getWorkflow().advanceAgentLog(file, offset),
    head: () => getWorkflow().git.head().catch(() => undefined),
    branch: () => getWorkflow().git.currentBranch().catch(() => undefined),
    buildBranch: () => getWorkflow().buildBranch(),
    resetSoft: (sha) => getWorkflow().git.resetSoft(sha),
    progress: (text) => getWorkflow().progress(text),
  };
}
