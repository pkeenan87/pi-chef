import { containsSecret } from "../redact.js";
import { WorkflowError, type PlanDocument, type PlanGroup } from "../domain.js";

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
  lines.push("", "This draft does not edit the repository. Implementation waits for /approve-plan.");
  return `${lines.join("\n")}\n`;
}

export function materialChange(left: PlanDocument, right: PlanDocument): boolean {
  const signature = (plan: PlanDocument) =>
    JSON.stringify({
      groups: plan.groups.map((group) => ({ id: group.id, files: [...group.files].sort(), dependsOn: [...group.dependsOn].sort() })),
      acceptance: plan.acceptance,
      securitySensitive: plan.securitySensitive,
    });
  return signature(left) !== signature(right);
}

/** Rejects duplicate group ids, missing dependencies, and cycles before any work starts. */
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
