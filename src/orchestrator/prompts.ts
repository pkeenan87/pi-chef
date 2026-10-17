/** System-prompt text injected while /plan is running. Kept short: it is paid for on every planning turn. */

export const MAX_INTERVIEW_QUESTIONS = 7;

/** What a plan must contain. Shared by the interview, no-questions, and revision rules. */
const TECHNICAL_PLAN = `The spec is a technical implementation plan, like an engineer's plan mode, not a product brief. Read the code that will change first. In plan_spec:
- context: what the code does today in that area, naming the files and functions you read.
- approach: the design. Components, data flow, new types and function signatures, error handling, config.
- changes: every file to create or modify, each with the concrete change (functions added or edited, fields, exports).
- reuse: existing functions and utilities to build on, with their paths.
- verification: the tests to add and the commands to run to prove it works end to end.
- complexity, risk (low, medium or high), securitySensitive (true when it touches authentication, authorization, secrets, credentials, permissions or production deployment) and classificationReason (one short sentence): you rate the task. They pick the models and the review depth. A keyword scan can raise securitySensitive but never lower it.`;

export const INTERVIEW_RULES = `[PLAN INTERVIEW]
You are planning, not building. Edit and write tools are off; use read, grep, find, ls, safe bash, web_search and web_fetch.
1. Look up FACTS yourself with tools. Ask the user only DECISIONS (scope, trade-offs, preferences) that tools cannot answer.
2. Ask in rounds with plan_questions. A round holds every question whose prerequisites are settled. A question that depends on another answer sets dependsOn and waits for the next round.
3. Ask 3-${MAX_INTERVIEW_QUESTIONS} questions in TOTAL across all rounds. Fewer for small tasks. Never more than ${MAX_INTERVIEW_QUESTIONS}; the tool rejects a round that would exceed it.
4. Every question has 2-4 options, exactly one recommended option, and a one-line reason. Word each question so accepting the recommendation is the easy path.
5. Stop when no open decision remains or the cap is reached. Then call plan_spec once.
6. After plan_spec, draft the tickets, call plan_consult with 2-3 specific questions about the riskiest parts, resolve the advisors' answers yourself, then call plan_tickets with \`advisorResolution\`. Do not write code or edit files.
${TECHNICAL_PLAN}`;

export const NO_QUESTIONS_RULES = `[PLAN WITHOUT QUESTIONS]
The user chose --no-questions. Do not call plan_questions. Explore with read-only tools, then call plan_spec. Record each decision you would have asked about as an assumption (the choice you recommend and why). Then draft the tickets, call plan_consult with 2-3 specific questions about the riskiest parts, resolve the answers, and call plan_tickets with \`advisorResolution\`.
${TECHNICAL_PLAN}`;

export const REVISION_RULES = `[PLAN REVISION]
The user reviewed the drafted plan and asked for changes (below). Do not call plan_questions. Re-read code where the changes need it, then call plan_spec with the full revised spec (not a diff), then plan_consult for the revised draft, then plan_tickets with the full revised ticket list and \`advisorResolution\`. Keep what the user did not ask to change.
${TECHNICAL_PLAN}`;

export const TICKET_RULES = (target: number) => `[PLAN TICKETS]
The spec is saved. Break the work into tickets, consult the advisors on the draft, then call plan_tickets.
- Vertical tracer-bullet slices: each ticket delivers one end-to-end behavior and is independently demoable and testable. Never slice layer by layer.
- Each ticket must fit ONE fresh context window. Soft target: ${target} tokens (estimatedContextTokens counts the ticket text, the files it touches, and about 20K of system and tool overhead). The tool rejects a ticket estimated above the target; split it.
- For wide refactors use expand-contract: add the new path, migrate callers in small tickets, then remove the old path.
- whatToBuild states the end-to-end behavior. implementation is the technical how: the files to create or change, the functions, types and signatures to add (with names), how they wire into existing code, and the tests to write. Name real paths and symbols from the code you read.
- List "files" for every file the ticket will touch (ownership hints; overlapping tickets are serialized).
- id is a two-digit ordinal ("01"). blockedBy lists ids of tickets that must finish first. No cycles. Every ticket needs at least one acceptance criterion.
- difficulty (low, medium or high) picks the model that builds the ticket: low = mechanical or small and well specified; medium = typical feature work; high = cross-cutting, tricky logic, concurrency, or a large blast radius. Rate a ticket high when it touches auth, secrets, untrusted input, or egress; the difficulty picks the implementer. Set it on every ticket. A failed ticket is retried on the next stronger model.
- checks is optional: command lines /build runs in the repo root after the ticket, one command per entry with plain space-separated arguments. There is no shell: no &&, |, ;, redirects, quotes, $VARS or globs (use two entries instead of &&). Destructive commands are refused. Verification steps that are not a command belong in implementation.
- Before plan_tickets, call plan_consult with the draft \`tickets\` and 2-3 specific \`questions\` about the riskiest parts (design risks, ordering, missing cases). Every advisor answers in parallel. Resolve any disagreement yourself, then call plan_tickets with the final tickets and \`advisorResolution\`: what you accepted, what you rejected, and why. plan_tickets refuses without it. plan_consult runs once per draft.
plan_tickets shows the user the full plan (spec and tickets) for review. If they request changes, revise and call plan_tickets again. Once saved, end your turn with a short summary; the user approves on the review screen (or later with /show-plan) and then runs /build. Do not implement anything.`;

export interface TicketPromptInput {
  ticket: { id: string; title: string; whatToBuild: string; implementation?: string; acceptanceCriteria: string[]; files?: string[]; checks?: string[] };
  /** Saved spec text (summary and decisions). */
  spec?: string;
  /** Completion summaries of the tickets this one is blocked by. */
  blockers: { id: string; title: string; summary: string }[];
  /** The target repo's AGENTS.md, if any. */
  repoRules?: string;
  /** Why the previous attempt failed, when this is an escalation. */
  previousFailure?: string;
  /** Earlier work from a previous version of this ticket is already on the branch (the plan was revised). */
  priorWork?: boolean | string;
}

export const TICKET_PROMPT_LIMITS = { spec: 12000, blocker: 1500, rules: 6000, failure: 4000 };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text);

/** The prompt for one /build ticket. Pure: callers pass already-redacted text. */
export function ticketPrompt(input: TicketPromptInput): string {
  const { ticket } = input;
  const parts = [
    `# Ticket ${ticket.id}: ${ticket.title}`,
    "",
    "## What to build",
    "",
    ticket.whatToBuild,
    ...(ticket.implementation ? ["", "## Implementation", "", ticket.implementation] : []),
    "",
    "## Acceptance criteria",
    "",
    ...ticket.acceptanceCriteria.map((item) => `- [ ] ${item}`),
  ];
  if (ticket.files?.length) parts.push("", "## Files (ownership hints)", "", ...ticket.files.map((file) => `- ${file}`));
  if (ticket.checks?.length) parts.push("", "## Checks to run", "", ...ticket.checks.map((check) => `- ${check}`));
  if (input.spec) parts.push("", "## Spec (technical plan and decisions)", "", clip(input.spec, TICKET_PROMPT_LIMITS.spec));
  if (input.blockers.length) {
    parts.push("", "## Completed blocking tickets (already on the branch)", "");
    for (const blocker of input.blockers) parts.push(`### ${blocker.id}: ${blocker.title}`, clip(blocker.summary || "(no summary recorded)", TICKET_PROMPT_LIMITS.blocker), "");
  }
  if (input.previousFailure) parts.push("", "## Previous attempt failed", "", "A cheaper model already tried this ticket. Build on its changes where they are sound.", "", clip(input.previousFailure, TICKET_PROMPT_LIMITS.failure));
  else if (input.priorWork) parts.push("", "## Earlier work on this branch", "", typeof input.priorWork === "string" ? input.priorWork : "An earlier version of this ticket already made changes here (see `git log`). The ticket was revised since: build on what still fits the ticket as written above, and change or remove what no longer does.");
  if (input.repoRules) parts.push("", "## Repo rules (AGENTS.md)", "", clip(input.repoRules, TICKET_PROMPT_LIMITS.rules));
  parts.push(
    "",
    "## Instructions",
    "",
    "Implement only this ticket and keep changes scoped. Write or adjust tests for the acceptance criteria and run the checks.",
    'Finish with a summary that lists each acceptance criterion as "- [x]" (met) or "- [ ]" (not met), then the files you changed.',
  );
  return parts.join("\n");
}
