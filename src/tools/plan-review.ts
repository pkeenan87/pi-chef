import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanReviewAction, PlanReviewRequest } from "../orchestrator/types.js";

/**
 * Presents a plan or a review for a decision, inline: the markdown goes into the transcript (unless it is already
 * there), then a compact `ui.select` lists the actions. No dialog takes over the screen. An action with `input` asks
 * for text in Pi's editor before it resolves; leaving that editor empty returns to the choice. Esc resolves undefined,
 * which callers treat as "dismissed" (a plan is saved as a draft, a review is closed).
 *
 * `post` puts the markdown in the transcript and must show it now, so call this only while Pi is idle (a command, or
 * `agent_settled`): during a turn `sendMessage` is held until the turn ends, after the choice.
 */
export async function presentForDecision(
  ctx: Pick<ExtensionContext, "ui">,
  request: PlanReviewRequest,
  post: (markdown: string) => void,
): Promise<{ value: string; text?: string } | undefined> {
  if (!request.alreadyShown) post(request.markdown);
  for (;;) {
    const label = await ctx.ui.select(request.title, request.actions.map((item) => item.label));
    const action: PlanReviewAction | undefined = request.actions.find((item) => item.label === label);
    if (!action) return undefined;
    if (!action.input) return { value: action.value };
    const text = await ctx.ui.editor(action.input, "");
    if (text?.trim()) return { value: action.value, text: text.trim() };
  }
}
