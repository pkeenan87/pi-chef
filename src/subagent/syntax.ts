/**
 * Does a file still parse? The ticket subagent's edit and write tools ask before and after each change, and a change
 * that breaks a file that parsed (or writes a new file that does not) gets the parser's message added to the tool
 * result, so the model fixes it on its next turn instead of finding out from the checks. Borrowed from oh-my-pi's edit
 * auto-repair, without the extra model call: the ticket's own model repairs it.
 *
 * Only languages pi-chef can parse without new dependencies: JSON and YAML in process, JavaScript with `node --check`,
 * TypeScript with the project's own `typescript` package when it has one, Python with `ast`. Anything else, a missing
 * tool, or a parser that times out is "unknown" and adds nothing. Processes run through execFile with argv arrays.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseDocument } from "yaml";

/** `undefined`: parses or cannot be checked; a string: the parser's message (first lines, with the location). */
export type SyntaxCheck = (file: string, cwd: string) => Promise<string | undefined>;

const TIMEOUT_MS = 5_000;
const firstLines = (text: string, lines = 3) => text.trim().split("\n").slice(0, lines).join("\n");

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; stderr: string } | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve({ code: 0, stderr: "" });
      const failed = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      // Not installed, or killed by the timeout: no verdict.
      if (failed.code === "ENOENT" || failed.killed) return resolve(undefined);
      resolve({ code: typeof failed.code === "number" ? failed.code : 1, stderr: String(stderr ?? "") });
    });
  });
}

function checkTypeScript(file: string, cwd: string): string | undefined {
  let ts: { createSourceFile: (...args: unknown[]) => { parseDiagnostics?: { start?: number; messageText: unknown }[]; getLineAndCharacterOfPosition: (pos: number) => { line: number; character: number } }; ScriptTarget: { Latest: unknown }; ScriptKind: Record<string, unknown> };
  try {
    ts = createRequire(path.join(cwd, "package.json"))("typescript");
  } catch {
    return undefined;
  }
  const text = readFileSync(file, "utf8");
  const kind = /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const first = source.parseDiagnostics?.[0];
  if (!first) return undefined;
  const where = source.getLineAndCharacterOfPosition(first.start ?? 0);
  const message = typeof first.messageText === "string" ? first.messageText : String((first.messageText as { messageText?: unknown })?.messageText ?? "syntax error");
  return `line ${where.line + 1}, column ${where.character + 1}: ${message}`;
}

/** The real check, by file extension. */
export const checkSyntax: SyntaxCheck = async (file, cwd) => {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === ".json") {
      JSON.parse(readFileSync(file, "utf8"));
      return undefined;
    }
    if (ext === ".yaml" || ext === ".yml") {
      const doc = parseDocument(readFileSync(file, "utf8"));
      return doc.errors[0] ? firstLines(doc.errors[0].message) : undefined;
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const result = await run(process.execPath, ["--check", "--", file], cwd);
      return result && result.code !== 0 ? firstLines(result.stderr, 5) : undefined;
    }
    if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") return checkTypeScript(file, cwd);
    if (ext === ".py") {
      const result = await run("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])", file], cwd);
      return result && result.code !== 0 ? firstLines(result.stderr.split("\n").slice(-4).join("\n"), 4) : undefined;
    }
  } catch (error) {
    // JSON.parse and the TypeScript reader throw; a file that cannot be read has no verdict.
    if (ext === ".json" && error instanceof SyntaxError) return error.message;
    return undefined;
  }
  return undefined;
};

/** The note added to a tool result when a change broke a file. */
export function syntaxNote(relative: string, problem: string): string {
  return `\n\nWarning: after this change ${relative} no longer parses:\n${problem}\nFix the syntax before you go on; the checks will fail on it.`;
}
