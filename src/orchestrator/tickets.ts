import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { isTier, type PlanGroup, type Ticket } from "../domain.js";
import { assertCommandSafe } from "../sandbox.js";
import { assertGraph } from "./plan.js";

/** Fixed allowance for the system prompt and tool definitions in a fresh worker context. */
export const CONTEXT_OVERHEAD_TOKENS = 20_000;

const ID = /^\d{2,3}$/;
/** Lines that would be read back as ticket structure: a title or section heading, or the ticket separator. */
const STRUCTURAL_LINE = /^[ \t]*(#{1,2}[ \t]|<!--[ \t]*ticket)/m;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TICKET_BREAK = "<!-- ticket -->";

export function groupId(ticket: Pick<Ticket, "id" | "slug">): string {
  return `${ticket.id}-${ticket.slug}`;
}

/** Size in bytes of a file inside `cwd`, or undefined when it is missing, a directory, or outside the project. */
export function projectFileSize(cwd: string, file: string): number | undefined {
  const root = path.resolve(cwd);
  const full = path.resolve(root, file);
  if (full !== root && !full.startsWith(root + path.sep)) return undefined;
  try {
    const stat = statSync(full);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/** Code-side estimate: ticket text and the listed files at 4 chars per token, plus fixed overhead. */
export function estimateTicketTokens(ticket: Ticket, fileSize: (file: string) => number | undefined): number {
  const text = ticket.title.length + ticket.whatToBuild.length + (ticket.implementation?.length ?? 0) + ticket.acceptanceCriteria.reduce((sum, item) => sum + item.length, 0);
  const files = (ticket.files ?? []).reduce((sum, file) => sum + (fileSize(file) ?? 0), 0);
  return Math.ceil(text / 4) + Math.ceil(files / 4) + CONTEXT_OVERHEAD_TOKENS;
}

export interface TicketCheck {
  tickets: Ticket[];
  errors: string[];
}

/** A ticket check line as the parent runs it: whitespace-split, first token the command (no shell). */
export function splitCheckLine(line: string): { command: string; args: string[] } {
  const [command = "", ...args] = line.trim().split(/\s+/);
  return { command, args };
}

/** True when `command` is a path, or an executable file on PATH (PATHEXT too on Windows). */
export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!command) return false;
  if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) return true;
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        accessSync(path.join(dir, command + ext), constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

/** Why a ticket check cannot run (deny rules, or a first word that is not a command), or undefined when it can. */
export function checkLineProblem(line: string, onPath: (command: string) => boolean = commandOnPath): string | undefined {
  const { command, args } = splitCheckLine(line);
  try {
    assertCommandSafe(command, args);
  } catch (error) {
    return (error as Error).message;
  }
  if (!onPath(command)) return `"${command}" is not a command on PATH; describe manual steps in implementation, not checks`;
  return undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

/** Coerces untrusted tool input into tickets, collecting every problem rather than stopping at the first. */
export function validateTickets(input: unknown, options: { target: number; fileSize: (file: string) => number | undefined; commandExists?: (command: string) => boolean }): TicketCheck {
  const errors: string[] = [];
  const tickets: Ticket[] = [];
  if (!Array.isArray(input) || input.length === 0) return { tickets, errors: ["tickets must be a non-empty array."] };
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = id || `#${index + 1}`;
    if (!ID.test(id)) errors.push(`Ticket ${label}: id must be a 2 or 3 digit ordinal such as "01" (digits only, matching ^\\d{2,3}$).`);
    else if (seen.has(id)) errors.push(`Ticket ${id}: duplicate id.`);
    seen.add(id);
    const slug = typeof item.slug === "string" ? item.slug.trim() : "";
    if (!SLUG.test(slug) || /[\r\n]/.test(String(item.slug))) errors.push(`Ticket ${label}: slug must be lowercase kebab-case on one line.`);
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) errors.push(`Ticket ${label}: title is required.`);
    else if (/[\r\n]/.test(title)) errors.push(`Ticket ${label}: title must be a single line (no newlines).`);
    const whatToBuild = typeof item.whatToBuild === "string" ? item.whatToBuild.trim() : "";
    if (!whatToBuild) errors.push(`Ticket ${label}: whatToBuild is required.`);
    else if (STRUCTURAL_LINE.test(whatToBuild)) errors.push(`Ticket ${label}: whatToBuild has a line starting with "# ", "## ", or "<!-- ticket", which would corrupt the ticket file. Reword it or use "###" headings.`);
    const implementation = typeof item.implementation === "string" ? item.implementation.trim() : "";
    if (implementation && STRUCTURAL_LINE.test(implementation)) errors.push(`Ticket ${label}: implementation has a line starting with "# ", "## ", or "<!-- ticket", which would corrupt the ticket file. Use "###" headings or lists.`);
    const acceptanceCriteria = strings(item.acceptanceCriteria);
    for (const criterion of acceptanceCriteria) {
      if (/[\r\n]/.test(criterion)) errors.push(`Ticket ${label}: each acceptance criterion must be a single line (no newlines).`);
      else if (STRUCTURAL_LINE.test(criterion)) errors.push(`Ticket ${label}: an acceptance criterion starts with "# ", "## ", or "<!-- ticket", which would corrupt the ticket file.`);
    }
    if (acceptanceCriteria.length === 0) errors.push(`Ticket ${label}: at least one acceptance criterion is required.`);
    const model = typeof item.estimatedContextTokens === "number" && Number.isFinite(item.estimatedContextTokens) && item.estimatedContextTokens > 0 ? item.estimatedContextTokens : undefined;
    if (model === undefined) errors.push(`Ticket ${label}: estimatedContextTokens must be a positive number.`);
    const tier = typeof item.suggestedTier === "string" ? item.suggestedTier : undefined;
    if (tier !== undefined && !isTier(tier)) errors.push(`Ticket ${label}: suggestedTier "${tier}" is not a tier.`);
    const files = strings(item.files).map((file) => file.replace(/^\.\//, ""));
    for (const file of files) {
      if (path.isAbsolute(file) || /^[A-Za-z]:|^~|\0/.test(file) || file.split(/[\\/]/).includes("..")) {
        errors.push(`Ticket ${label}: files must be relative paths inside the project (no absolute paths or ".."): ${file}`);
      }
    }
    const checks = strings(item.checks);
    for (const check of checks) {
      const problem = checkLineProblem(check, options.commandExists);
      if (problem === undefined) continue;
      errors.push(
        `Ticket ${label}: check "${check}" cannot run (${problem}). Checks are shell command lines the parent runs after the ticket, one command per entry; destructive commands are refused. Put prose verification steps in implementation instead.`,
      );
    }
    tickets.push({
      id,
      slug,
      title,
      whatToBuild,
      ...(implementation ? { implementation } : {}),
      acceptanceCriteria,
      blockedBy: strings(item.blockedBy),
      ...(tier && isTier(tier) ? { suggestedTier: tier } : {}),
      ...(files.length ? { files } : {}),
      estimatedContextTokens: model ?? 0,
      ...(checks.length ? { checks } : {}),
    });
  }
  const ids = new Set(tickets.map((ticket) => ticket.id));
  for (const ticket of tickets) {
    for (const dep of ticket.blockedBy) {
      if (dep === ticket.id) errors.push(`Ticket ${ticket.id}: cannot be blocked by itself.`);
      else if (!ids.has(dep)) errors.push(`Ticket ${ticket.id}: blockedBy ${dep} does not exist.`);
    }
  }
  if (errors.length === 0) {
    try {
      assertGraph(ticketsToGroups(tickets));
    } catch (error) {
      errors.push(`Ticket graph: ${(error as Error).message}`);
    }
  }
  if (errors.length === 0) {
    for (const ticket of tickets) {
      const code = estimateTicketTokens(ticket, options.fileSize);
      const worst = Math.max(ticket.estimatedContextTokens, code);
      if (worst > options.target) {
        errors.push(`Ticket ${ticket.id} (${ticket.title}) is estimated at ${worst} tokens (model ${ticket.estimatedContextTokens}, code-side ${code}), above the ${options.target} target. Split it into smaller vertical slices and call plan_tickets again.`);
      }
    }
  }
  return { tickets, errors };
}

/** Maps tickets to plan groups so plan.ts `waves` can order them. */
export function ticketsToGroups(tickets: Ticket[]): PlanGroup[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  return tickets.map((ticket) => ({
    id: groupId(ticket),
    summary: [ticket.title, "", ticket.whatToBuild, "", "Acceptance criteria:", ...ticket.acceptanceCriteria.map((item) => `- ${item}`)].join("\n"),
    files: [...(ticket.files ?? [])],
    dependsOn: ticket.blockedBy.map((dep) => {
      const blocker = byId.get(dep);
      return blocker ? groupId(blocker) : dep;
    }),
    edits: [],
  }));
}

export function ticketFileName(ticket: Pick<Ticket, "id" | "slug">): string {
  return `${groupId(ticket)}.md`;
}

/** One ticket in the to-tickets local format, with a frontmatter-like metadata block. */
export function renderTicket(ticket: Ticket): string {
  const meta = [
    "---",
    `id: ${ticket.id}`,
    `slug: ${ticket.slug}`,
    ...(ticket.suggestedTier ? [`suggestedTier: ${ticket.suggestedTier}`] : []),
    `estimatedContextTokens: ${ticket.estimatedContextTokens}`,
    ...(ticket.files?.length ? [`files: ${JSON.stringify(ticket.files)}`] : []),
    ...(ticket.checks?.length ? [`checks: ${JSON.stringify(ticket.checks)}`] : []),
    "---",
  ];
  return [
    ...meta,
    "",
    `# ${ticket.id}: ${ticket.title}`,
    "",
    "## What to build",
    "",
    ticket.whatToBuild,
    "",
    ...(ticket.implementation ? ["## Implementation", "", ticket.implementation, ""] : []),
    "## Acceptance criteria",
    "",
    ...ticket.acceptanceCriteria.map((item) => `- [ ] ${item}`),
    "",
    "## Blocked by",
    "",
    ...(ticket.blockedBy.length ? ticket.blockedBy.map((dep) => `- ${dep}`) : ["None"]),
    "",
    "## Status: ready-for-agent",
    "",
  ].join("\n");
}

export function renderTicketsMarkdown(tickets: Ticket[]): string {
  return tickets.map(renderTicket).join(`\n${TICKET_BREAK}\n\n`);
}

function section(body: string, heading: string): string {
  const match = body.match(new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return match?.[1]?.trim() ?? "";
}

function jsonList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    return strings(JSON.parse(value));
  } catch {
    return [];
  }
}

/** Parses the output of `renderTicketsMarkdown` (after a person edits it). Unparseable input yields no tickets. */
export function parseTicketsMarkdown(markdown: string): unknown[] {
  return markdown
    .split(TICKET_BREAK)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const front = part.match(/^---\n([\s\S]*?)\n---\n?/);
      const meta = new Map<string, string>();
      for (const line of (front?.[1] ?? "").split("\n")) {
        const at = line.indexOf(":");
        if (at > 0) meta.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      const body = front ? part.slice(front[0].length) : part;
      const heading = body.match(/^# (\S+?):\s*(.*)$/m);
      const blocked = section(body, "Blocked by");
      return {
        id: meta.get("id") ?? heading?.[1] ?? "",
        slug: meta.get("slug") ?? "",
        title: heading?.[2]?.trim() ?? "",
        whatToBuild: section(body, "What to build"),
        implementation: section(body, "Implementation") || undefined,
        acceptanceCriteria: section(body, "Acceptance criteria")
          .split("\n")
          .map((line) => line.replace(/^\s*-\s*\[[ xX]\]\s*/, "").trim())
          .filter(Boolean),
        blockedBy: /^none$/i.test(blocked) ? [] : blocked.split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim()).filter(Boolean),
        suggestedTier: meta.get("suggestedTier"),
        estimatedContextTokens: Number(meta.get("estimatedContextTokens")),
        files: jsonList(meta.get("files")),
        checks: jsonList(meta.get("checks")),
      };
    });
}

export type TicketStatus = "ready-for-agent" | "in-progress" | "done" | "failed";

const norm = (text: string) => text.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();

/**
 * Best-effort read of a ticket's closing summary: for each acceptance criterion, true when a line that
 * mentions it is ticked ("- [x]") or says "met" (and not "not met"/"unmet"). Unmatched criteria are not met.
 */
export function parseCriteriaMet(finalText: string, criteria: string[]): boolean[] {
  const lines = finalText.split("\n").map((line) => ({ raw: line, text: norm(line) }));
  return criteria.map((criterion) => {
    const key = norm(criterion).slice(0, 50);
    const hit = key ? lines.find((line) => line.text.includes(key)) : undefined;
    if (!hit) return false;
    if (/\[ \]|\bnot met\b|\bunmet\b|\bnot done\b|\bfailed\b/i.test(hit.raw)) return false;
    return /\[x\]/i.test(hit.raw) || /\bmet\b|\bdone\b|\bpass(ed)?\b|✅|✓/i.test(hit.raw);
  });
}

/** Sets the canonical `## Status:` heading of a ticket file (the last one, which `renderTicket` writes at the end), adding it when a person removed it. */
export function setTicketStatus(markdown: string, status: TicketStatus): string {
  const last = [...markdown.matchAll(/^## Status:.*$/gm)].at(-1);
  if (!last || last.index === undefined) return `${markdown.trimEnd()}\n\n## Status: ${status}\n`;
  return `${markdown.slice(0, last.index)}## Status: ${status}${markdown.slice(last.index + last[0].length)}`;
}

/** Ticks the checkbox of each acceptance criterion that is met, in order. Never unticks. */
export function tickCriteria(markdown: string, met: boolean[]): string {
  const start = markdown.search(/^## Acceptance criteria/m);
  if (start < 0) return markdown;
  const next = markdown.slice(start + 1).search(/^## /m);
  const end = next < 0 ? markdown.length : start + 1 + next;
  let index = 0;
  const block = markdown.slice(start, end).replace(/^(\s*-\s*)\[([ xX])\]/gm, (whole, lead: string, mark: string) => {
    const done = met[index++];
    return done ? `${lead}[x]` : `${lead}[${mark}]`;
  });
  return markdown.slice(0, start) + block + markdown.slice(end);
}

/** Adds a one-line warning block under the title area once (idempotent on the exact text). */
export function addTicketWarning(markdown: string, warning: string): string {
  const line = `> Warning: ${warning}`;
  if (markdown.includes(line)) return markdown;
  return markdown.replace(/^(# .*\n)/m, `$1\n${line}\n`);
}
