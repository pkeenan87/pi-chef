import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Workflow } from "../orchestrator/service.js";
import { createPlanConsultTool, createPlanSpecTool, createPlanTicketsTool } from "./plan-flow.js";
import { createPlanQuestionsTool } from "./plan-questions.js";
import { createWebFetchTool, type WebFetchDeps } from "./web-fetch.js";
import { createWebSearchTool, getAnthropicOAuth, type SearchUsageRecord, type SearchTransport, type SearchAuth } from "./web-search.js";

export interface WebToolsDeps {
  /** Throw when the budget is hard-exhausted (called before every web_search). */
  budgetCheck?: () => void | Promise<void>;
  /** Receives token and server-side search counts for the cost ledger (provider anthropic, purpose web_search). */
  onUsage?: (record: SearchUsageRecord) => void | Promise<void>;
  /** Override credential lookup (default: ctx.modelRegistry anthropic oauth login). */
  getAuth?: (ctx: unknown) => Promise<SearchAuth>;
  searchTransport?: SearchTransport;
  fetch?: WebFetchDeps;
}

export function registerWebTools(pi: Pick<ExtensionAPI, "registerTool">, deps: WebToolsDeps = {}): void {
  pi.registerTool(
    createWebSearchTool({ getAuth: deps.getAuth ?? getAnthropicOAuth, budgetCheck: deps.budgetCheck, onUsage: deps.onUsage, transport: deps.searchTransport }),
  );
  pi.registerTool(createWebFetchTool(deps.fetch));
}

/** Registers plan_questions, plan_spec, plan_consult, and plan_tickets. They only work while /plan is running. */
export function registerPlanTools(pi: Pick<ExtensionAPI, "registerTool">, getWorkflow: () => Workflow | undefined): void {
  pi.registerTool(createPlanQuestionsTool(getWorkflow));
  pi.registerTool(createPlanSpecTool(getWorkflow));
  pi.registerTool(createPlanConsultTool(getWorkflow));
  pi.registerTool(createPlanTicketsTool(getWorkflow));
}

export type { SearchUsageRecord } from "./web-search.js";
