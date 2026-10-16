import type { PlanReviewAction } from "./types.js";
import { active, type WorkflowContext } from "./context.js";
import { assertGraph } from "./plan.js";
import { requestPlanChanges } from "./interview.js";
import { freezeApproval, planMarkdown } from "./planning.js";
import { checkTickets, redraftTickets } from "./ticket-plan.js";
import { parseTicketsMarkdown, renderTicketsMarkdown } from "./tickets.js";

const ACTIONS: PlanReviewAction[] = [
  { value: "approve", label: "Approve plan" },
  { value: "revise", label: "Request changes", input: "What should change in the plan? (spec or tickets)" },
  { value: "edit", label: "Edit tickets" },
  { value: "save", label: "Save as draft" },
];

/**
 * Shows a plan that `plan_tickets` just saved, once the planning turn has settled: the plan goes into the chat as
 * markdown (Pi is idle, so it appears at once), then a compact picker asks for the decision. The flag is cleared first,
 * so a plan is presented once; an aborted turn never gets here, and `/show-plan` still offers the draft. Without a UI
 * (no `ctx.review`) nothing happens and the flag stays.
 */
export async function presentPendingPlan(ctx: WorkflowContext): Promise<void> {
  const post = ctx.report ?? ctx.show;
  if (!ctx.review || !post) return;
  const task = active(ctx);
  const plan = task?.plan;
  if (!task || !plan || task.presentPlan?.version !== plan.version || task.phase !== "AWAITING_PLAN_APPROVAL" || task.approvedVersion === plan.version) return;
  await ctx.store.update(task.taskId, "plan presented", (current) => ({ ...current, presentPlan: undefined }));
  const tell = (text: string) => (ctx.progress ?? ctx.notify)?.(text);
  post(planMarkdown(ctx, task));
  for (;;) {
    const current = active(ctx);
    if (!current?.plan) return;
    const version = current.plan.version;
    const choice = await ctx.review({ title: `Review the plan · ${current.plan.tickets?.length ?? 0} tickets`, markdown: "", alreadyShown: true, actions: ACTIONS });
    if (!choice || choice.value === "save") return tell(`Plan v${version} is a draft. /show-plan to approve later.`);
    if (choice.value === "approve") {
      assertGraph(current.plan.groups);
      await freezeApproval(ctx, current);
      return tell(`Approved plan v${version}. Run /build.`);
    }
    if (choice.value === "revise") {
      // The revision turn is started through startTurn; Pi runs a prompt issued while settling right after it.
      const result = await requestPlanChanges(ctx, current, choice.text ?? "");
      return tell(result.text);
    }
    const changed = await ctx.edit?.("Edit the tickets (titles, implementation, criteria, Blocked by)", renderTicketsMarkdown(current.plan.tickets ?? []));
    if (changed === undefined) continue;
    const check = checkTickets(ctx, parseTicketsMarkdown(changed));
    if (check.errors.length) {
      ctx.notify?.(`Edited tickets are invalid, keeping the previous version:\n- ${check.errors.join("\n- ")}`);
      continue;
    }
    await redraftTickets(ctx, check.tickets);
    const updated = active(ctx);
    if (updated) post(planMarkdown(ctx, updated));
  }
}
