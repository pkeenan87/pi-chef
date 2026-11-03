import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkSyntax, syntaxNote } from "../src/subagent/syntax.js";
import { ticketTools, type ChildTool } from "../src/subagent/ticket-agent.js";

const REPO = path.resolve(__dirname, "..");
const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

function file(name: string, body: string): { dir: string; full: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "syntax-"));
  const full = path.join(dir, name);
  writeFileSync(full, body);
  return { dir, full };
}

describe("checkSyntax", () => {
  it("JSON and YAML in process", async () => {
    expect(await checkSyntax(file("a.json", '{"a": 1}').full, REPO)).toBeUndefined();
    expect(await checkSyntax(file("a.json", '{"a": 1,}').full, REPO)).toMatch(/JSON|position|token/i);
    expect(await checkSyntax(file("a.yaml", "a: 1\nb: [2\n").full, REPO)).toBeTruthy();
    expect(await checkSyntax(file("a.yml", "a: 1\n").full, REPO)).toBeUndefined();
  });

  it("JavaScript with node --check", async () => {
    expect(await checkSyntax(file("a.js", "const a = 1;\n").full, REPO)).toBeUndefined();
    expect(await checkSyntax(file("a.mjs", "const a = (1;\n").full, REPO)).toMatch(/SyntaxError/);
  });

  it("TypeScript with the project's own typescript, with line and column", async () => {
    expect(await checkSyntax(file("a.ts", "const a: number = 1;\n").full, REPO)).toBeUndefined();
    expect(await checkSyntax(file("a.ts", "const a: number = 1;\nfunction f( {\n").full, REPO)).toMatch(/^line \d+, column \d+: /);
  });

  it.runIf(hasPython)("Python with ast", async () => {
    expect(await checkSyntax(file("a.py", "x = 1\n").full, REPO)).toBeUndefined();
    expect(await checkSyntax(file("a.py", "def f(:\n").full, REPO)).toMatch(/SyntaxError/);
  });

  it("has no verdict for other files or a missing file", async () => {
    expect(await checkSyntax(file("a.rs", "fn main( {").full, REPO)).toBeUndefined();
    expect(await checkSyntax(path.join(tmpdir(), "missing-file.json"), REPO)).toBeUndefined();
  });
});

describe("edit and write in a ticket report a file they broke", () => {
  const fake = (name: string, onRun: () => void = () => undefined): ChildTool => ({ name, execute: async () => (onRun(), { content: [{ type: "text", text: "Successfully wrote" }] }) });
  const verdicts = (map: Record<string, (string | undefined)[]>) => async (full: string) => map[path.basename(full)]!.shift();

  it("adds the parser's message when a file that parsed stops parsing", async () => {
    const { dir } = file("a.json", "{}");
    const [, write] = ticketTools([fake("read"), fake("write")], { cwd: dir, syntax: verdicts({ "a.json": [undefined, "Unexpected token } at 7"] }) });
    const result = (await write!.execute("1", { path: "a.json" })) as { content: { text: string }[] };
    expect(result.content.at(-1)!.text).toBe(syntaxNote("a.json", "Unexpected token } at 7"));
  });

  it("checks a new file after it is written", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "new-"));
    const [write] = ticketTools([fake("write", () => writeFileSync(path.join(dir, "n.json"), "{"))], { cwd: dir, syntax: verdicts({ "n.json": ["broken"] }) });
    const result = (await write!.execute("1", { path: "n.json" })) as { content: { text: string }[] };
    expect(result.content.at(-1)!.text).toContain("n.json no longer parses");
  });

  it("says nothing when the file was already broken, still parses, or cannot be checked", async () => {
    const { dir } = file("a.json", "{");
    for (const sequence of [["already", "still"], [undefined, undefined]]) {
      const [edit] = ticketTools([fake("edit")], { cwd: dir, syntax: verdicts({ "a.json": [...sequence] }) });
      const result = (await edit!.execute("1", { path: "a.json" })) as { content: unknown[] };
      expect(result.content).toHaveLength(1);
    }
    const [off] = ticketTools([fake("edit")], { cwd: dir, syntax: false });
    expect(((await off!.execute("1", { path: "a.json" })) as { content: unknown[] }).content).toHaveLength(1);
  });
});
