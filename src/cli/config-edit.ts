/**
 * Text edits of a pi-chef config file that keep everything outside the edited line as it was.
 * The sample user config (templates/chef.yaml) ships every setting commented out as `#   key: value  # note`
 * under a `# section:` header. Setting such a key uncomments that line and its headers in place and replaces the
 * value; unsetting a key that the sample ships comments it back out. Any other edit goes through the `yaml`
 * Document API, which keeps comments. Pure: no file access.
 */
import { Document, isMap, parseDocument, stringify } from "yaml";

const LINE = "\n";

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A scalar or flow value as one line of YAML. */
export function flowText(value: unknown): string {
  return stringify(value, { lineWidth: 0, collectionStyle: "flow", flowCollectionPadding: false }).trimEnd();
}

interface Found {
  index: number;
  commented: boolean;
}

/** The line of `name` at `depth` (2 spaces per level) between `from` and `to`, live or commented out. */
function findKeyLine(lines: string[], name: string, depth: number, from: number, to: number): Found | undefined {
  const pad = " ".repeat(2 * depth);
  const live = new RegExp(`^${pad}${esc(name)}:(?:\\s|$)`);
  const dead = new RegExp(`^# ${pad}${esc(name)}:(?:\\s|$)`);
  // A live line anywhere in range wins over a commented one, so a section is never opened twice.
  for (let i = from; i < to; i++) if (live.test(lines[i]!)) return { index: i, commented: false };
  for (let i = from; i < to; i++) if (dead.test(lines[i]!)) return { index: i, commented: true };
  return undefined;
}

/** The end (exclusive) of the block under a key line at `depth`: the next key line at the same or a lower level. */
function blockEnd(lines: string[], start: number, depth: number): number {
  const max = 2 * depth;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.startsWith("##")) continue;
    const live = /^( *)[^\s#]/.exec(line);
    if (live && live[1]!.length <= max) return i;
    const dead = /^# ( *)[^\s#]/.exec(line);
    if (dead && dead[1]!.length <= max) return i;
  }
  return lines.length;
}

/** Locates each part of `parts` as a nested key line (live or commented out), outermost first. */
export function locate(text: string, parts: string[]): Found[] | undefined {
  const lines = text.split(LINE);
  const found: Found[] = [];
  let from = 0;
  let to = lines.length;
  for (let depth = 0; depth < parts.length; depth++) {
    const at = findKeyLine(lines, parts[depth]!, depth, from, to);
    if (!at) return undefined;
    found.push(at);
    from = at.index + 1;
    to = blockEnd(lines, at.index, depth);
  }
  return found;
}

/**
 * Sets `parts` to `value` by uncommenting the sample's lines for it, when the file has them (the headers may be
 * commented out or already live). Returns undefined when the file has no such commented line.
 */
export function uncommentSet(text: string, parts: string[], value: unknown): string | undefined {
  const found = locate(text, parts);
  if (!found || !found[found.length - 1]!.commented) return undefined;
  const lines = text.split(LINE);
  for (const at of found) if (at.commented) lines[at.index] = lines[at.index]!.slice(2);
  const leaf = found[found.length - 1]!.index;
  const replaced = replaceValue(lines[leaf]!, value);
  if (replaced === undefined) return undefined;
  lines[leaf] = replaced;
  // A sample list written as block items under the key: drop the commented items the new value replaces.
  let next = leaf + 1;
  while (next < lines.length && /^#\s+-\s/.test(lines[next]!)) next++;
  lines.splice(leaf + 1, next - leaf - 1);
  return lines.join(LINE);
}


/** Where a value ends on a key line: after a quoted string, else before the first ` #`. -1 when it cannot be told. */
function valueEnd(rest: string): number {
  const quoted = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/.exec(rest);
  if (quoted) return quoted[0].length;
  if (/^\s*["'|>&!]/.test(rest)) return -1;
  const open = rest.replace(/#.*/, "");
  if (/^\s*[[{]/.test(rest) && !/^\s*(\[.*\]|\{.*\})\s*$/.test(open)) return -1;
  const at = rest.search(/(?<=^|\s)#/);
  return at < 0 ? rest.length : at;
}

/** The trailing note of a key line (`# …`), or "". */
function noteOf(line: string): string {
  const m = /^(\s*[^:\s][^:]*:)(.*)$/.exec(line);
  if (!m) return "";
  const end = valueEnd(m[2]!);
  return end < 0 ? "" : m[2]!.slice(end).trim();
}

/** True when the live header line is the sample's header line uncommented. */
function isSampleHeader(template: string, parts: string[], live: string): boolean {
  const f = locate(template, parts);
  return !!f && f[f.length - 1]!.commented && template.split(LINE)[f[f.length - 1]!.index]!.slice(2) === live;
}

/** A key line with its value replaced, spacing and trailing note kept. Undefined when the line is not a one-line value. */
function replaceValue(line: string, value: unknown): string | undefined {
  const m = /^(\s*[^:\s][^:]*:)(.*)$/.exec(line);
  if (!m) return undefined;
  const rest = m[2]!;
  const end = valueEnd(rest);
  if (end < 0) return undefined;
  const field = rest.slice(0, end);
  const note = rest.slice(end);
  if (note !== "" && !note.startsWith("#")) return undefined;
  let core = ` ${flowText(value)}`;
  if (note) core = core.length + 2 > field.length ? `${core}  ` : core.padEnd(field.length);
  return `${m[1]}${core}${note}`;
}

/** The last live (uncommented, non-blank) line index in lines[from, to), or -1. */
function lastLive(lines: string[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (/^ *[^\s#]/.test(lines[i]!)) return i;
  return -1;
}

/** Sets a key that is live in the file by replacing its one-line value in place. */
export function replaceLive(text: string, parts: string[], value: unknown): string | undefined {
  const found = locate(text, parts);
  if (!found || found.some((f) => f.commented)) return undefined;
  const lines = text.split(LINE);
  const leaf = found[found.length - 1]!.index;
  if (lastLive(lines, leaf + 1, blockEnd(lines, leaf, parts.length - 1)) >= 0) return undefined;
  const replaced = replaceValue(lines[leaf]!, value);
  if (replaced === undefined || /^\s*[^:]*:\s*(#.*)?$/.test(lines[leaf]!)) return undefined;
  lines[leaf] = replaced;
  return lines.join(LINE);
}

/**
 * Adds a key that is not in the file under its deepest parent that is there, live or commented out (a commented
 * sample header is uncommented in place), else at the end. Undefined when unsure.
 */
export function insertKey(text: string, parts: string[], value: unknown): string | undefined {
  const lines = text.split(LINE);
  let depth = -1;
  let at = -1;
  let from = 0;
  let to = lines.length;
  const uncomment: number[] = [];
  for (let d = 0; d < parts.length - 1; d++) {
    const f = findKeyLine(lines, parts[d]!, d, from, to);
    if (!f) break;
    if (f.commented) uncomment.push(f.index);
    else if (uncomment.length > 0) return undefined;
    depth = d;
    at = f.index;
    from = f.index + 1;
    to = blockEnd(lines, f.index, d);
  }
  const fresh: string[] = [];
  for (let d = depth + 1; d < parts.length - 1; d++) fresh.push(`${"  ".repeat(d)}${parts[d]}:`);
  fresh.push(`${"  ".repeat(parts.length - 1)}${parts[parts.length - 1]}: ${flowText(value)}`);
  if (depth < 0) {
    const body = text === "" ? [] : text.endsWith(LINE) ? text.slice(0, -1).split(LINE) : lines;
    return [...body, ...fresh, ""].join(LINE);
  }
  for (const i of uncomment) lines[i] = lines[i]!.slice(2);
  if (!new RegExp(`^ *${esc(parts[depth]!)}:\\s*(#.*)?$`).test(lines[at]!)) return undefined;
  const last = lastLive(lines, at + 1, to);
  lines.splice((last < 0 ? at : last) + 1, 0, ...fresh);
  return lines.join(LINE);
}

/**
 * Removes a live key (and the live lines under it), and each parent header left empty: a header the sample ships is
 * commented back out, any other is dropped. Undefined when unsure.
 */
export function removeKey(text: string, parts: string[], template?: string): string | undefined {
  const found = locate(text, parts);
  if (!found || found.some((f) => f.commented)) return undefined;
  const lines = text.split(LINE);
  const leaf = found[found.length - 1]!.index;
  const last = lastLive(lines, leaf + 1, blockEnd(lines, leaf, parts.length - 1));
  const drop = new Set<number>();
  const comment = new Set<number>();
  for (let i = leaf; i <= Math.max(leaf, last); i++) drop.add(i);
  for (let d = found.length - 2; d >= 0; d--) {
    const head = found[d]!.index;
    const stop = blockEnd(lines, head, d);
    let live = false;
    for (let i = head + 1; i < stop; i++) if (!drop.has(i) && !comment.has(i) && /^ *[^\s#]/.test(lines[i]!)) live = true;
    if (live) break;
    // A sample header is commented back only while the sample's own commented lines remain under it.
    if (template !== undefined && isSampleHeader(template, parts.slice(0, d + 1), lines[head]!) && lines.slice(head + 1, stop).some((l) => new RegExp(`^# {${2 * d + 3},}[^\\s#]`).test(l))) comment.add(head);
    else drop.add(head);
  }
  return lines.flatMap((l, i) => (drop.has(i) ? [] : [comment.has(i) ? `# ${l}` : l])).join(LINE);
}

/** True when the sample text has a commented-out line for `parts` (so `unset` should comment it back out). */
export function inTemplate(template: string, parts: string[]): boolean {
  const found = locate(template, parts);
  return !!found && found[found.length - 1]!.commented;
}

/**
 * Puts the sample's own commented line for `parts` back in place of its live line (and the sample's commented list
 * items after it), and comments out each header above it that is left with nothing live. Undefined when the key is
 * not a plain one-line entry or the sample has no line for it.
 */
export function recomment(text: string, parts: string[], template: string): string | undefined {
  const found = locate(text, parts);
  const sample = locate(template, parts);
  if (!found || found.some((f) => f.commented) || !sample || !sample[sample.length - 1]!.commented) return undefined;
  const lines = text.split(LINE);
  const tplLines = template.split(LINE);
  const leaf = found[found.length - 1]!.index;
  const depth = parts.length - 1;
  const end = blockEnd(lines, leaf, depth);
  // Only a one-line entry: anything live under it (a block list, a nested map) is not commented out here.
  for (let i = leaf + 1; i < end; i++) if (/^ *[^\s#]/.test(lines[i]!)) return undefined;
  const at = sample[sample.length - 1]!.index;
  // The live line is the sample's only if it still has the sample's trailing note; a hand-written line is deleted.
  if (noteOf(lines[leaf]!) !== noteOf(tplLines[at]!)) return undefined;
  const heads = found.slice(0, -1).map((f, d) => isSampleHeader(template, parts.slice(0, d + 1), lines[f.index]!));
  let next = at + 1;
  while (next < tplLines.length && /^#\s+-\s/.test(tplLines[next]!)) next++;
  lines.splice(leaf, 1, ...tplLines.slice(at, next));
  const dropHeads = new Set<number>();
  for (let d = found.length - 2; d >= 0; d--) {
    const head = found[d]!.index;
    const stop = blockEnd(lines, head, d);
    let live = false;
    for (let i = head + 1; i < stop; i++) if (!dropHeads.has(i) && /^ *[^\s#]/.test(lines[i]!)) live = true;
    if (live) break;
    if (heads[d]) lines[head] = `# ${lines[head]}`;
    else dropHeads.add(head);
  }
  return lines.filter((_, i) => !dropHeads.has(i)).join(LINE);
}

/** Sets a key with the Document API (comments outside the edited node survive). */
export function docSet(text: string, parts: string[], value: unknown, indent = 2): string {
  const doc = parseDocument(text);
  doc.setIn(parts, value);
  return out(doc, indent);
}

/** Deletes a key with the Document API, and the sections it leaves empty. */
export function docDelete(text: string, parts: string[], indent = 2): string {
  const doc = parseDocument(text);
  if (!doc.hasIn(parts)) return text;
  doc.deleteIn(parts);
  for (let i = parts.length - 1; i >= 1; i--) {
    const parent = doc.getIn(parts.slice(0, i), true);
    if (isMap(parent) && parent.items.length === 0) doc.deleteIn(parts.slice(0, i));
    else break;
  }
  if (isMap(doc.contents) && doc.contents.items.length === 0) doc.contents = null;
  return out(doc, indent);
}

function out(doc: Document, indent: number): string {
  const text = doc.toString({ lineWidth: 0, indent });
  return text.trim() === "null" ? "" : text;
}

/** Whether `parts` is a live key of the file's own YAML. */
export function hasLive(text: string, parts: string[]): boolean {
  try {
    return parseDocument(text).hasIn(parts);
  } catch {
    return false;
  }
}
