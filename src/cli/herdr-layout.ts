/**
 * Docks the chef-config panel into a herdr layout as its own column on the right edge of the root row. herdr applies a
 * mod's `place` only the first time it sees the mod, and rewrites its shipped layouts (`main`, `terminals`, `win98`) on
 * every start, so the panel lives in a layout of the user's own (default name `chef`, made from the layout in use).
 * `dockChefPanel` is the pure transform; `dockLayoutFile` reads, backs up and writes the files.
 * `scripts/herdr-install.mjs` calls the second from `dist/`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

type Node = { id?: unknown; type?: unknown; children?: unknown; content?: { mod?: unknown } } & Record<string, unknown>;

export const CHEF_MOD = "chef-config";
export const CHEF_ID = "chef";
/** The layout the installer makes and docks into unless told otherwise. */
export const DEFAULT_LAYOUT = "chef";
/** Layouts herdr ships and rewrites on every start: never edited. */
export const SHIPPED_LAYOUTS = ["main", "terminals", "win98"];
export const CHEF_COLUMN = { id: CHEF_ID, type: "block", size: { px: 340 }, min: 280, max: 640, content: { mod: CHEF_MOD } } as const;

export type DockStatus = "added" | "present" | "no-row" | "id-taken";

export interface DockResult {
  /** The layout with the column added (a copy; the input is never changed). Same content as the input unless `status` is `added`. */
  layout: unknown;
  status: DockStatus;
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function childrenOf(node: Node): Node[] {
  return Array.isArray(node.children) ? node.children.filter(isNode) : [];
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of childrenOf(node)) walk(child, visit);
}

/**
 * Appends `{ id: "chef", type: "block", size: { px: 340 }, min, max, content: { mod: "chef-config" } }` to the root row,
 * so the panel is a column on the right edge. Idempotent: a layout that already shows the mod anywhere is returned as
 * it is. Nothing is added when the root is not a row or the id `chef` belongs to something else.
 */
export function dockChefPanel(layout: unknown): DockResult {
  const copy = structuredClone(layout);
  if (!isNode(copy)) return { layout: copy, status: "no-row" };
  let present = false;
  let taken = false;
  walk(copy, (node) => {
    if (isNode(node.content) && node.content.mod === CHEF_MOD) present = true;
    else if (node.id === CHEF_ID) taken = true;
  });
  if (present) return { layout: copy, status: "present" };
  if (copy.type !== "row") return { layout: copy, status: "no-row" };
  if (taken) return { layout: copy, status: "id-taken" };
  copy.children = [...childrenOf(copy), structuredClone(CHEF_COLUMN)];
  return { layout: copy, status: "added" };
}

export interface DockOptions {
  /** The layout file to edit or create, without `.json`. Default: `chef`. A shipped layout name is refused. */
  layout?: string;
  now?: Date;
}

export interface DockReport {
  status: DockStatus | "created" | "refused" | "unreadable";
  file?: string;
  backup?: string;
  /** What to tell the person, line by line. */
  lines: string[];
}

function shownLayout(appHome: string): string {
  try {
    const shared = JSON.parse(readFileSync(path.join(appHome, "shared.json"), "utf8")) as { layout?: unknown };
    if (typeof shared.layout === "string" && /^[\w.-]+$/.test(shared.layout)) return shared.layout;
  } catch {
    /* no shared.json yet */
  }
  return "main";
}

function readLayout(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The commands to use the layout, printed after every successful run (and when it was already docked). */
function usage(name: string): string[] {
  return [
    `Switch to it: herdr-app do layout.switch '{"name":"${name}"}'   (ctrl-shift-l cycles layouts)`,
    `Toggle the panel with a key: add this to the "global" section of ~/.config/herdr-app/keys.json (this tool does not edit it):`,
    `  "ctrl-shift-g": {"command": "layout.toggle", "args": {"id": "${CHEF_ID}"}}`,
  ];
}

/**
 * Docks the panel into `<appHome>/layouts/<name>.json`. A shipped layout is refused. When the file does not exist it is
 * made from the layout in use (`shared.json`, else `main`) with the panel column added; an existing file is backed up
 * first and only written when something changes.
 */
export function dockLayoutFile(appHome: string, options: DockOptions = {}): DockReport {
  const name = options.layout ?? DEFAULT_LAYOUT;
  const file = path.join(appHome, "layouts", `${name}.json`);
  if (SHIPPED_LAYOUTS.includes(name)) {
    return { status: "refused", file, lines: [`Did not edit the ${name} layout: herdr ships it and rewrites it on every start (an edited copy is moved to ${name}-edited.json).`, `Dock into a layout of your own instead: leave out --layout (it makes "${DEFAULT_LAYOUT}" from the layout in use), or name one.`] };
  }
  let created = false;
  let parsed: unknown;
  let sourceName = name;
  try {
    if (existsSync(file)) {
      parsed = readLayout(file);
    } else {
      sourceName = shownLayout(appHome);
      if (!existsSync(path.join(appHome, "layouts", `${sourceName}.json`))) sourceName = "main";
      parsed = readLayout(path.join(appHome, "layouts", `${sourceName}.json`));
      created = true;
    }
  } catch (error) {
    return { status: "unreadable", file, lines: [`Could not read a layout to dock into (${created || !existsSync(file) ? sourceName : name}): ${error instanceof Error ? error.message : String(error)}`, "Not docked. Add the column yourself (see docs/install.md)."] };
  }
  const result = dockChefPanel(parsed);
  if (result.status === "no-row") return { status: "no-row", file, lines: [`Did not edit ${file}: its root is not a row, so there is no right edge to add a column to.`, `Add ${JSON.stringify(CHEF_COLUMN)} to a row you choose (docs/install.md), or use --layout <name>.`] };
  if (result.status === "id-taken") return { status: "id-taken", file, lines: [`Did not edit ${file}: a node with id "${CHEF_ID}" already exists that does not show ${CHEF_MOD}.`, "Add the column yourself with another id (docs/install.md)."] };
  // A layout of that name that exists and shows the panel is left alone. One made from a layout that already shows it still has to be written, or `name` would not exist to switch to.
  if (result.status === "present" && !created) return { status: "present", file, lines: [`The ${name} layout already shows the ${CHEF_MOD} panel; nothing changed.`, ...usage(name)] };
  let backup: string | undefined;
  if (!created) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backup = `${file}.bak-${stamp}`;
    copyFileSync(file, backup);
  }
  writeJson(file, result.layout);
  return {
    status: created ? "created" : "added",
    file,
    ...(backup ? { backup } : {}),
    lines: [
      created ? (result.status === "present" ? `Made the ${name} layout from ${sourceName}, which already shows the ${CHEF_MOD} panel (${file}).` : `Made the ${name} layout from ${sourceName} with the panel as a ${CHEF_COLUMN.size.px}px column on the right edge (${file}).`) : `Docked the panel in the ${name} layout as a ${CHEF_COLUMN.size.px}px column on the right edge (${file}).`,
      ...(backup ? [`Backup: ${backup}`] : []),
      ...usage(name),
    ],
  };
}
