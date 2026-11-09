import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dockChefPanel, dockLayoutFile } from "../src/cli/herdr-layout.js";

// The shape of herdr's shipped `main` layout, trimmed to what the transform reads.
const fixture = (): any => ({
  id: "root",
  type: "row",
  divider: { width: 1, color: "border" },
  children: [
    { id: "sidebar", type: "column", children: [{ id: "spaces", type: "block", content: { mod: "spaces" } }] },
    {
      id: "work",
      type: "column",
      children: [
        { id: "tabs", type: "block", content: { mod: "tabs" } },
        {
          id: "work-body",
          type: "row",
          children: [
            { id: "main", type: "block", content: { tab: "active" } },
            {
              id: "panel",
              type: "column",
              hidden: true,
              children: [
                {
                  id: "panel-body",
                  type: "stack",
                  active: "files",
                  children: [
                    { id: "files", type: "block", content: { mod: "files" } },
                    { id: "changes", type: "block", content: { mod: "changes" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const column = { id: "chef", type: "block", size: { px: 340 }, min: 280, max: 640, content: { mod: "chef-config" } };

describe("dockChefPanel", () => {
  it("adds the chef column to the right edge of the root row, and nothing else changes", () => {
    const input = fixture();
    const r = dockChefPanel(input);
    expect(r.status).toBe("added");
    const out = r.layout as any;
    expect(out.children.map((c: any) => c.id)).toEqual(["sidebar", "work", "chef"]);
    expect(out.children[2]).toEqual(column);
    expect(out.children[2].hidden).toBeUndefined();
    const expected = fixture();
    expected.children.push(column);
    expect(out).toEqual(expected);
    expect(input).toEqual(fixture());
  });

  it("is idempotent", () => {
    const once = dockChefPanel(fixture());
    const twice = dockChefPanel(once.layout);
    expect(twice.status).toBe("present");
    expect(twice.layout).toEqual(once.layout);
    expect((twice.layout as any).children).toHaveLength(3);
  });

  it("counts the mod anywhere in the layout as docked", () => {
    const layout = fixture();
    layout.children[0].children.push({ id: "mine", type: "block", content: { mod: "chef-config" } });
    expect(dockChefPanel(layout).status).toBe("present");
  });

  it("does nothing when the root is not a row, or the id is taken", () => {
    const col = { ...fixture(), type: "column" };
    expect(dockChefPanel(col).status).toBe("no-row");
    expect(dockChefPanel(col).layout).toEqual(col);
    expect(dockChefPanel(null).status).toBe("no-row");
    const taken = fixture();
    taken.children[0].children.push({ id: "chef", type: "block", content: { mod: "other" } });
    expect(dockChefPanel(taken).status).toBe("id-taken");
  });
});

describe("dockLayoutFile", () => {
  const home = (shared: unknown = { layout: "main" }) => {
    const dir = mkdtempSync(path.join(tmpdir(), "chef-herdr-home-"));
    mkdirSync(path.join(dir, "layouts"));
    writeFileSync(path.join(dir, "layouts", "main.json"), `${JSON.stringify(fixture(), null, 2)}\n`);
    writeFileSync(path.join(dir, "shared.json"), JSON.stringify(shared));
    return dir;
  };
  const read = (dir: string, name: string) => JSON.parse(readFileSync(path.join(dir, "layouts", `${name}.json`), "utf8"));

  it("makes the chef layout from the layout in use, leaves main alone, and prints the switch and key commands", () => {
    const dir = home();
    const mainBefore = readFileSync(path.join(dir, "layouts", "main.json"), "utf8");
    const report = dockLayoutFile(dir);
    expect(report.status).toBe("created");
    expect(report.file).toBe(path.join(dir, "layouts", "chef.json"));
    const expected = fixture();
    expected.children.push(column);
    expect(read(dir, "chef")).toEqual(expected);
    expect(readFileSync(path.join(dir, "layouts", "main.json"), "utf8")).toBe(mainBefore);
    const text = report.lines.join("\n");
    expect(text).toContain(`herdr-app do layout.switch '{"name":"chef"}'`);
    expect(text).toContain(`"ctrl-shift-g": {"command": "layout.toggle", "args": {"id": "chef"}}`);
    expect(readdirSync(path.join(dir, "layouts")).sort()).toEqual(["chef.json", "main.json"]);
  });

  it("clones the shown layout when it is a user layout of its own", () => {
    const dir = home({ layout: "mine" });
    writeFileSync(path.join(dir, "layouts", "mine.json"), JSON.stringify({ ...fixture(), titlebar: "none" }));
    expect(dockLayoutFile(dir).status).toBe("created");
    expect(read(dir, "chef").titlebar).toBe("none");
    // A shown layout that is missing falls back to main.
    const other = home({ layout: "gone" });
    expect(dockLayoutFile(other).status).toBe("created");
  });

  it("still writes the chef layout when the layout in use already shows the panel, so the layout it names exists", () => {
    const dir = home({ layout: "mine" });
    const shows = fixture();
    shows.children.push(column);
    writeFileSync(path.join(dir, "layouts", "mine.json"), JSON.stringify(shows));
    const report = dockLayoutFile(dir);
    expect(report.status).toBe("created");
    expect(read(dir, "chef")).toEqual(shows);
    expect(report.lines.join("\n")).toContain("already shows the chef-config panel");
    expect(dockLayoutFile(dir).status).toBe("present");
  });

  it("a second run changes nothing and makes no backup; an existing chef layout is backed up before it is edited", () => {
    const dir = home();
    dockLayoutFile(dir);
    const before = readFileSync(path.join(dir, "layouts", "chef.json"), "utf8");
    expect(dockLayoutFile(dir).status).toBe("present");
    expect(readFileSync(path.join(dir, "layouts", "chef.json"), "utf8")).toBe(before);
    expect(readdirSync(path.join(dir, "layouts")).filter((f) => f.includes(".bak-"))).toEqual([]);

    writeFileSync(path.join(dir, "layouts", "custom.json"), JSON.stringify(fixture()));
    const report = dockLayoutFile(dir, { layout: "custom", now: new Date("2026-11-08T12:00:00.000Z") });
    expect(report.status).toBe("added");
    expect(path.basename(report.backup!)).toBe("custom.json.bak-2026-11-08T12-00-00-000Z");
    expect(JSON.parse(readFileSync(report.backup!, "utf8"))).toEqual(fixture());
    expect(read(dir, "custom").children.map((c: any) => c.id)).toEqual(["sidebar", "work", "chef"]);
    expect(readdirSync(path.join(dir, "layouts")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("refuses the layouts herdr ships, writing nothing", () => {
    const dir = home();
    const before = readFileSync(path.join(dir, "layouts", "main.json"), "utf8");
    for (const name of ["main", "terminals", "win98"]) {
      const report = dockLayoutFile(dir, { layout: name });
      expect(report.status, name).toBe("refused");
      expect(report.lines.join("\n")).toContain("ships it");
    }
    expect(readFileSync(path.join(dir, "layouts", "main.json"), "utf8")).toBe(before);
    expect(readdirSync(path.join(dir, "layouts"))).toEqual(["main.json"]);
  });

  it("leaves a layout whose root is not a row alone, and reports an unreadable source", () => {
    const dir = home();
    writeFileSync(path.join(dir, "layouts", "col.json"), JSON.stringify({ ...fixture(), type: "column" }));
    const before = readFileSync(path.join(dir, "layouts", "col.json"), "utf8");
    expect(dockLayoutFile(dir, { layout: "col" }).status).toBe("no-row");
    expect(readFileSync(path.join(dir, "layouts", "col.json"), "utf8")).toBe(before);
    const empty = mkdtempSync(path.join(tmpdir(), "chef-herdr-home-"));
    expect(dockLayoutFile(empty).status).toBe("unreadable");
    expect(existsSync(path.join(empty, "layouts"))).toBe(false);
  });
});
