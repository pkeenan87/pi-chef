import { modelText } from "../agents.js";
import type { WorkflowConfig } from "../config.js";
import { ticketDifficulty, WorkflowError, type PlanDocument, type PlanGroup, type TaskState, type Ticket } from "../domain.js";
import { modelFor } from "./routing.js";

/** The human-readable plan in the task folder: the document shown for review and approval. */
export const PLAN_FILE = "plan.md";

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function applyOverlap(groups: PlanGroup[]): { groups: PlanGroup[]; overlap: string[] } {
  const owner = new Map<string, string>();
  const overlap: string[] = [];
  const next = groups.map((group) => ({ ...group, files: [...group.files], dependsOn: [...group.dependsOn] }));
  for (const group of next) {
    for (const file of group.files) {
      const previous = owner.get(file);
      if (previous && previous !== group.id) {
        overlap.push(file);
        if (!group.dependsOn.includes(previous)) group.dependsOn.push(previous);
      } else {
        owner.set(file, group.id);
      }
    }
  }
  return { groups: next, overlap: unique(overlap) };
}

/** Who builds a ticket, from the effective config: the model of its difficulty (`models.<difficulty>`). */
export function ticketRouteView(config: WorkflowConfig, ticket: Ticket): { implementer: string } {
  return { implementer: modelText(modelFor(config, ticketDifficulty(ticket))) };
}

/** The "Tickets" summary table: number, title, difficulty, implementer, and what blocks it. */
export function ticketsTableLines(tickets: Ticket[], config: WorkflowConfig): string[] {
  const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  return [
    "| # | Ticket | Difficulty | Implementer | Blocked by |",
    "| --- | --- | --- | --- | --- |",
    ...tickets.map((ticket) => {
      const view = ticketRouteView(config, ticket);
      return `| ${cell(ticket.id)} | ${cell(ticket.title)} | ${ticketDifficulty(ticket)} | ${view.implementer} | ${ticket.blockedBy.join(", ") || "none"} |`;
    }),
  ];
}

/**
 * The full plan a person reviews before approval: the technical spec, then every ticket with its implementation
 * notes, acceptance criteria, and dependencies, then the execution order. Plans without tickets use `renderPlan`.
 */
export function renderPlanReview(plan: PlanDocument, spec: string | undefined, config?: WorkflowConfig): string {
  const tickets = plan.tickets ?? [];
  // A plan from before tickets (an old task file): its summary only. /build asks for a re-plan.
  if (tickets.length === 0) return `# Plan v${plan.version}\n\n${plan.summary}\n\nThis plan has no tickets. Run /plan to re-plan it.\n`;
  const order = waves(plan.groups).map((wave, index) => `${index + 1}. ${wave.map((group) => group.id.split("-")[0]).join(", ")}`);
  const lines = [
    `# Plan v${plan.version}`,
    "",
    `${tickets.length} tickets · security sensitive: ${plan.securitySensitive ? "yes" : "no"}`,
    "",
  ];
  // The spec's own title is replaced by the plan title; its sections follow as they are.
  const body = (spec ?? "").replace(/^# Spec\s*\n/, "").trim();
  lines.push(body ? `## Summary\n\n${body}` : `## Summary\n\n${plan.summary}`, "", "## Tickets");
  if (config) lines.push("", ...ticketsTableLines(tickets, config));
  for (const ticket of tickets) {
    const meta = [`Blocked by: ${ticket.blockedBy.join(", ") || "none"}`, `~${Math.round(ticket.estimatedContextTokens / 1000)}K tokens`];
    lines.push("", `### ${ticket.id} · ${ticketDifficulty(ticket)} · ${ticket.title}`, "", meta.join(" · "));
    if (ticket.files?.length) lines.push(`Files: ${ticket.files.map((file) => `\`${file}\``).join(", ")}`);
    lines.push("", "**What to build**", "", ticket.whatToBuild);
    if (ticket.implementation) lines.push("", "**Implementation**", "", ticket.implementation);
    lines.push("", "**Acceptance criteria**", "", ...ticket.acceptanceCriteria.map((item) => `- [ ] ${item}`));
    if (ticket.checks?.length) lines.push("", `Checks: ${ticket.checks.map((check) => `\`${check}\``).join(", ")}`);
  }
  lines.push("", "## Execution order", "", ...order);
  if (plan.overlap.length > 0) lines.push("", `File overlap (serialized, not parallel): ${plan.overlap.join(", ")}`);
  lines.push("", "## Policy", "", ...plan.risks.map((item) => `- ${item}`), "- This draft does not edit the repository. Building waits for plan approval.");
  return `${lines.join("\n")}\n`;
}

/** Rejects duplicate group ids, missing dependencies, and cycles before any work starts. */
/**
 * The run state a task carries into a new plan draft. A ticket run survives only for a ticket that is
 * the same work (`sameTicket`: same id and group, same text), so a re-approved plan with the same tickets resumes instead of
 * paying for them again, and a stale "done" cannot skip a new ticket that reuses the id.
 */
export function forNewPlan(task: TaskState, draft: PlanDocument): Pick<TaskState, "ticketRuns"> {
  const was = new Map((task.plan?.tickets ?? []).map((ticket) => [ticket.id, ticket]));
  const kept = Object.entries(task.ticketRuns ?? {}).filter(([id]) => {
    const before = was.get(id);
    if (!before) return false;
    const after = (draft.tickets ?? []).find((ticket) => ticket.id === id && ticket.slug === before.slug);
    return after !== undefined && sameTicket(before, after);
  });
  return { ticketRuns: kept.length ? Object.fromEntries(kept) : undefined };
}

/** True when two versions of a ticket ask for the same work (the fields a build acts on). */
export function sameTicket(a: Ticket, b: Ticket): boolean {
  const view = (ticket: Ticket) => JSON.stringify([ticket.title, ticket.whatToBuild, ticket.implementation ?? "", ticket.acceptanceCriteria, ticket.checks ?? [], ticket.files ?? [], ticket.blockedBy]);
  return view(a) === view(b);
}

export function assertGraph(groups: PlanGroup[]): void {
  const ids = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.id)) throw new WorkflowError("PLAN_INVALID", `Duplicate task group id ${group.id}.`);
    ids.add(group.id);
  }
  waves(groups);
}

export function waves(groups: PlanGroup[]): PlanGroup[][] {
  const pending = groups.map((group) => ({ ...group }));
  const done = new Set<string>();
  const ordered: PlanGroup[][] = [];
  while (pending.length > 0) {
    const ready = pending.filter((group) => group.dependsOn.every((dep) => done.has(dep)));
    if (ready.length === 0) throw new WorkflowError("PLAN_CYCLE", "The task graph contains a cycle or a missing dependency.");
    ordered.push(ready);
    for (const group of ready) {
      done.add(group.id);
      const index = pending.findIndex((item) => item.id === group.id);
      pending.splice(index, 1);
    }
  }
  return ordered;
}
