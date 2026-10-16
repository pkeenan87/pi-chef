import { tierCandidates, type WorkflowConfig } from "../config.js";
import { advisorsFor } from "../review/advisors.js";
import { containsSecret } from "../redact.js";
import { DIFFICULTY_TIER, ticketDifficulty, WorkflowError, type AdvisorOpinion, type PlanAdvisorReview, type PlanDocument, type PlanGroup, type TaskState, type Ticket } from "../domain.js";

/** The human-readable plan in the task folder: the document shown for review and approval. */
export const PLAN_FILE = "plan.md";

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function asGroup(value: unknown, index: number): PlanGroup {
  if (!value || typeof value !== "object") throw new WorkflowError("PLAN_INVALID", "Task group must be an object.");
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `group-${index + 1}`;
  const files = Array.isArray(raw.files) ? raw.files.filter((file): file is string => typeof file === "string") : [];
  const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((dep): dep is string => typeof dep === "string") : [];
  const edits = Array.isArray(raw.edits)
    ? raw.edits
        .filter((edit): edit is { path: string; content: string } => !!edit && typeof edit === "object" && typeof (edit as { path?: unknown }).path === "string" && typeof (edit as { content?: unknown }).content === "string")
        .map((edit) => ({ path: edit.path, content: edit.content }))
    : [];
  for (const edit of edits) {
    if (containsSecret(edit.content) || containsSecret(edit.path)) {
      throw new WorkflowError("SECRET_IN_PLAN", `Edit ${edit.path} contains a secret and was not saved.`);
    }
  }
  return {
    id,
    summary: typeof raw.summary === "string" ? raw.summary : id,
    files: unique(files.map((file) => file.replace(/^\.\//, ""))),
    dependsOn,
    edits,
  };
}

export function parseGroups(request: string): PlanGroup[] {
  const fenced = request.match(/```tasks\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fenced[1]);
    } catch {
      throw new WorkflowError("PLAN_INVALID", "The tasks block is not valid JSON.");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new WorkflowError("PLAN_INVALID", "The tasks block must be a non-empty array.");
    }
    return parsed.map((group, index) => asGroup(group, index));
  }
  const files = unique([...request.matchAll(/(?:^|[\s`'"])([\w./-]+\.(?:ts|tsx|js|jsx|py|go|md))\b/g)].map((match) => match[1] ?? "").filter(Boolean));
  return [{ id: "main", summary: request.slice(0, 160), files, dependsOn: [], edits: [] }];
}

export function applyOverlap(groups: PlanGroup[]): { groups: PlanGroup[]; overlap: string[] } {
  const owner = new Map<string, string>();
  const overlap: string[] = [];
  const next = groups.map((group) => ({ ...group, files: [...group.files], dependsOn: [...group.dependsOn], edits: group.edits.map((edit) => ({ ...edit })) }));
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

export function acceptanceCriteria(request: string): string[] {
  const explicit = [...request.matchAll(/^AC:\s*(.+)$/gm)].map((match) => match[1]?.trim() ?? "").filter(Boolean);
  return unique([...explicit, "Configured checks pass with recorded exit codes", "Review reports no blocking findings"]);
}

export function renderPlan(plan: PlanDocument): string {
  const lines = [
    `# Plan v${plan.version}`,
    "",
    plan.summary,
    "",
    `Security sensitive: ${plan.securitySensitive ? "yes" : "no"}`,
    `Estimated charge: ${plan.estimatedUsd === null ? "unknown" : plan.estimatedUsd}`,
    "",
    "## Acceptance",
    ...plan.acceptance.map((item) => `- ${item}`),
    "",
    "## Risks",
    ...plan.risks.map((item) => `- ${item}`),
    "",
    "## Task graph",
  ];
  if (plan.overlap.length > 0) lines.push("", `File overlap (serialized, not parallel): ${plan.overlap.join(", ")}`);
  for (const group of plan.groups) {
    lines.push("", `### ${group.id}`, group.summary, `Files: ${group.files.join(", ") || "(none)"}`, `Depends on: ${group.dependsOn.join(", ") || "(none)"}`);
  }
  lines.push("", "This draft does not edit the repository. Building waits for plan approval.");
  return `${lines.join("\n")}\n`;
}

function opinionLines(opinion: AdvisorOpinion): string[] {
  if (opinion.error) return [`- ${opinion.provider}/${opinion.model}: did not answer (${opinion.error})`];
  return [
    `- ${opinion.provider}/${opinion.model}: ${opinion.verdict ?? "unsure"}`,
    ...opinion.concerns.map((item) => `  - ${item.severity.toUpperCase()} ${item.file ? `${item.file}: ` : ""}${item.issue}${item.suggestion ? ` (suggestion: ${item.suggestion})` : ""}`),
  ];
}

/** The "Advisor review" section at the top of the plan: each advisor's verdict and concerns, errors, then the resolution. */
export function advisorReviewLines(review: PlanAdvisorReview | undefined): string[] {
  if (!review) return [];
  const lines = ["## Advisor review", ""];
  if (review.note) lines.push(review.note);
  for (const opinion of review.consult?.results ?? []) lines.push(...opinionLines(opinion));
  if (review.reconsultWaived) lines.push("", "The tickets changed after the advisors were consulted; the planning model waived a new consult (see its resolution).");
  if (review.resolution) lines.push("", `Opus resolution: ${review.resolution}`);
  lines.push("", "Advisors advise; approval is yours.", "");
  return lines;
}

/** Who builds a ticket and who advises on it, from the effective config: the first candidate of its difficulty tier. */
export function ticketRouteView(config: WorkflowConfig, ticket: Ticket): { implementer: string; advisors: string } {
  const difficulty = ticketDifficulty(ticket);
  const first = tierCandidates(config, DIFFICULTY_TIER[difficulty])[0];
  const candidates = tierCandidates(config, "advisor").map((item) => ({ provider: item.provider, model: item.model }));
  const picked = advisorsFor({ difficulty, implementerProvider: first?.provider ?? "", implementerModel: first?.model, candidates });
  const advisors = picked.length === 0 ? "—" : picked.length === 1 ? `${picked[0]!.provider}/${picked[0]!.model}` : picked.length === 2 ? "both" : `all ${picked.length}`;
  return { implementer: first ? `${first.provider}/${first.model}` : "(none)", advisors };
}

/** The "Tickets" summary table: number, title, difficulty, implementer, advisors, and what blocks it. */
export function ticketsTableLines(tickets: Ticket[], config: WorkflowConfig): string[] {
  const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  return [
    "| # | Ticket | Difficulty | Implementer | Advisors | Blocked by |",
    "| --- | --- | --- | --- | --- | --- |",
    ...tickets.map((ticket) => {
      const view = ticketRouteView(config, ticket);
      return `| ${cell(ticket.id)} | ${cell(ticket.title)} | ${ticketDifficulty(ticket)} | ${view.implementer} | ${view.advisors} | ${ticket.blockedBy.join(", ") || "none"} |`;
    }),
  ];
}

/**
 * The full plan a person reviews before approval: the technical spec, then every ticket with its implementation
 * notes, acceptance criteria, and dependencies, then the execution order. Plans without tickets use `renderPlan`.
 */
export function renderPlanReview(plan: PlanDocument, spec: string | undefined, config?: WorkflowConfig): string {
  const tickets = plan.tickets ?? [];
  if (tickets.length === 0) return renderPlan(plan);
  const order = waves(plan.groups).map((wave, index) => `${index + 1}. ${wave.map((group) => group.id.split("-")[0]).join(", ")}`);
  const lines = [
    `# Plan v${plan.version}`,
    "",
    `${tickets.length} tickets · estimated charge ${plan.estimatedUsd === null ? "unknown" : `$${plan.estimatedUsd}`} · security sensitive: ${plan.securitySensitive ? "yes" : "no"}`,
    "",
  ];
  lines.push(...advisorReviewLines(plan.advisorReview));
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
 * The run state a task carries into a new plan draft. Attempts start over. A ticket run survives only for a ticket that is
 * the same work (`sameTicket`: same id and group, same text), so a re-approved plan with the same tickets resumes instead of
 * paying for them again, and a stale "done" cannot skip a new ticket that reuses the id.
 */
export function forNewPlan(task: TaskState, draft: PlanDocument): Pick<TaskState, "attempts" | "ticketRuns"> {
  const was = new Map((task.plan?.tickets ?? []).map((ticket) => [ticket.id, ticket]));
  const kept = Object.entries(task.ticketRuns ?? {}).filter(([id]) => {
    const before = was.get(id);
    if (!before) return false;
    const after = (draft.tickets ?? []).find((ticket) => ticket.id === id && ticket.slug === before.slug);
    return after !== undefined && sameTicket(before, after);
  });
  return { attempts: [], ticketRuns: kept.length ? Object.fromEntries(kept) : undefined };
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
