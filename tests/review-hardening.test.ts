import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { bindWorkflow } from "../src/extension.js";
import { GitWorkspace } from "../src/git/workspace.js";
import type { InterviewQuestion } from "../src/orchestrator/interview.js";
import { parseTicketsMarkdown, renderTicketsMarkdown, setTicketStatus, validateTickets } from "../src/orchestrator/tickets.js";
import { createPlanQuestionsTool } from "../src/tools/plan-questions.js";
import { isReadOnlyCommand } from "../src/tools/readonly-bash.js";
import { tempRepo, workflow } from "./helpers.js";

// ---- H1d: commits never run a model-written hook -----------------------------------------------------------

describe("commitAll", () => {
  it("does not run hooks written during a ticket", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    const marker = path.join(cwd, "hook-ran");
    mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
    for (const name of ["pre-commit", "commit-msg", "post-commit"]) {
      const file = path.join(cwd, ".git", "hooks", name);
      writeFileSync(file, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
      chmodSync(file, 0o755);
    }
    // A hook installed through config, as a model with shell access could do.
    mkdirSync(path.join(cwd, "evil-hooks"));
    writeFileSync(path.join(cwd, "evil-hooks", "pre-commit"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(path.join(cwd, "evil-hooks", "pre-commit"), 0o755);
    execFileSync("git", ["config", "core.hooksPath", path.join(cwd, "evil-hooks")], { cwd });
    writeFileSync(path.join(cwd, "feature.txt"), "x\n");
    const before = await git.head();
    const after = await git.commitAll(cwd, "ticket");
    expect(after).not.toBe(before);
    expect(existsSync(marker)).toBe(false);
  });
});

// ---- H2: interview cap --------------------------------------------------------------------------------------------

const question = (id: string): InterviewQuestion => ({ id, title: id, prompt: `Which ${id}?`, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], recommended: "a", reason: "simplest" });
type Exec = (id: string, params: never, signal: undefined, onUpdate: undefined, ctx: never) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
const call = (tool: { execute: unknown }, params: unknown, ctx: unknown) => (tool.execute as Exec)("1", params as never, undefined, undefined, ctx as never);

describe("interview pending round", () => {
  async function planning() {
    const cwd = await tempRepo();
    const app = workflow(cwd, { startTurn: () => undefined });
    expect((await app.startPlan("Add retry to the Neo ingest parser")).ok).toBe(true);
    return { app, cwd, tool: createPlanQuestionsTool(() => app) };
  }
  const seven = (prefix: string) => Array.from({ length: 7 }, (_, i) => question(`${prefix}${i}`));

  it("runs the tool sequentially", async () => {
    const { tool } = await planning();
    expect((tool as { executionMode?: string }).executionMode).toBe("sequential");
  });

  it("rejects a second concurrent round of 7 questions while the first is pending", async () => {
    const { tool, app } = await planning();
    let release: (value: unknown) => void = () => undefined;
    const dialog = new Promise((resolve) => (release = resolve));
    const ui = { hasUI: true, ui: { custom: () => dialog, notify: () => undefined } };
    const first = call(tool, { round: 1, questions: seven("a") }, ui);
    const second = call(tool, { round: 1, questions: seven("b") }, ui);
    await expect(second).rejects.toThrow(/still waiting|one round at a time/);
    // A different round number is refused as well.
    await expect(call(tool, { round: 2, questions: [question("z")] }, ui)).rejects.toThrow(/still waiting/);
    release({ cancelled: false, answers: seven("a").map((q) => ({ id: q.id, value: "a", label: "A", wasCustom: false, acceptedRecommendation: true })) });
    const done = await first;
    expect(JSON.stringify(done.details)).toContain('"asked":7');
    // 7 asked in total, never 14.
    await expect(call(tool, { round: 2, questions: [question("c")] }, { hasUI: false, ui: {} })).rejects.toThrow(/cap/);
    expect(app.store.load(app.activeTaskId()!)!.phase).toBe("PLANNING");
  });

  it("allows the same round to be asked again after a dismissal, and recordAnswers re-checks round and cap", async () => {
    const { tool, app } = await planning();
    const dismissed = { hasUI: true, ui: { custom: async () => ({ cancelled: true, answers: [] }), notify: () => undefined } };
    await call(tool, { round: 1, questions: [question("a")] }, dismissed);
    const again = await call(tool, { round: 1, questions: [question("a")] }, { hasUI: false, ui: {} });
    expect(again.content[0]!.text).toContain("1/7");
    await expect(app.recordInterviewAnswers(2, [question("q")], [], true)).rejects.toThrow(/not the pending round/);
    await app.beginQuestionRound({ round: 2, questions: [question("b")] });
    await expect(app.recordInterviewAnswers(2, seven("x"), [], true)).rejects.toThrow(/cap/);
    await expect(app.recordInterviewAnswers(3, [question("b")], [], true)).rejects.toThrow(/not the pending round/);
  });

  it("lets a new process re-ask the same pending round after a restart, but not another round", async () => {
    const { cwd, app } = await planning();
    await app.beginQuestionRound({ round: 1, questions: [question("a")] });
    const restarted = workflow(cwd, { startTurn: () => undefined });
    await restarted.startPlan("");
    await expect(restarted.beginQuestionRound({ round: 2, questions: [question("b")] })).rejects.toThrow(/Ask round 1 again/);
    await expect(restarted.beginQuestionRound({ round: 1, questions: [question("a")] })).resolves.toMatchObject({ round: 1 });
  });
});

// ---- H3: planning bash --------------------------------------------------------------------------------------------

describe("read-only bash argument checks", () => {
  const root = "/work/project";
  it("denies file-writing and program-running options", () => {
    const denied = [
      "sort -o out.txt file", "sort --output=out.txt file", "sort -ro out file", "sort --output out file", "uniq in.txt out.txt", "uniq -c in out", "tree -o out.txt", "tree -a -o out",
      "find . -fprint out", "find . -fprintf out x", "find . -fls out", "find . -exec rm {} ;", "find . -execdir ls {}", "find . -ok rm {}", "find . -okdir x", "find . -delete",
      "rg --pre cat foo", "rg --pre=cat foo", "rg --pre-glob '*.x' foo", "git log --output=out", "git diff --output out", "ls --output=x", "date -s 2020-01-01", "date --set=x", "date -us x",
      "sort --compress-program=sh x",
      "git branch newbranch", "git branch -d x", "git branch -D x", "git branch -m a b", "git branch -c a b", "git branch --set-upstream-to=origin/x", "git branch -u origin/x", "git branch --delete x", "git branch foo HEAD",
      "git remote add x y", "git remote remove x", "git remote set-url origin y", "git remote rename a b", "git remote update",
    ];
    for (const command of denied) expect(isReadOnlyCommand(command, root), command).toBe(false);
  });

  it("still allows the listing forms", () => {
    const allowed = [
      "sort file", "sort -u file | uniq -c", "uniq file", "uniq -c file", "uniq -f 1 file", "tree -L 2", "find . -name '*.ts' -type f", "rg foo src", "rg -n --glob '*.ts' foo",
      "git branch", "git branch -a", "git branch -r", "git branch -l", "git branch --list", "git branch --list 'feat*'", "git branch -v", "git branch -vv", "git branch --show-current", "git branch --contains abc123", "git branch --merged main", "git branch --no-merged main", "git branch -a --contains abc",
      "git remote", "git remote -v", "git remote show origin", "git remote get-url origin", "date", "date -u", "ls src", "cat package.json",
    ];
    for (const command of allowed) expect(isReadOnlyCommand(command, root), command).toBe(true);
  });

  it("treats absolute-looking patterns as patterns, not paths", () => {
    const allowed = ["grep /api/users src", "rg \"/v1/foo\"", "grep -rn /api/users src | head -5", "rg -n '/v1/foo' src", "grep -e /api/users src", "find . -name /x -type f", "echo /not/a/path", "grep /nonexistent/outside src"];
    for (const command of allowed) expect(isReadOnlyCommand(command, root), command).toBe(true);
    // still denied: operands that name a path outside the root, `~`, variables, and `..` escapes
    for (const command of ["grep foo /etc/passwd", "grep -e foo /etc/passwd", "cat /nonexistent/outside", "ls /nonexistent/outside", "cd /nonexistent/outside", "grep /api ~/x", "grep $HOME src", "grep foo ../x", "rg x --ignore-file=/etc/hosts"]) {
      expect(isReadOnlyCommand(command, root), command).toBe(false);
    }
  });

  it("denies absolute paths outside the project, home references, and escapes", () => {
    for (const command of ["cat /etc/passwd", "ls /", "cat ~/.ssh/id_rsa", "cat ~", "cat $HOME/.npmrc", "cat ${HOME}/.npmrc", "grep -r x /etc", "cat ../secret", "ls ../..", "rg x --ignore-file=/etc/hosts", "find /etc -name x", "cat /work/project/../other/x"]) {
      expect(isReadOnlyCommand(command, root), command).toBe(false);
    }
    for (const command of ["cat /work/project/src/a.ts", "ls /work/project", "grep -r x /work/project/src", "cat src/../README.md"]) expect(isReadOnlyCommand(command, root), command).toBe(true);
  });
});

// ---- M6: ticket markdown round trip --------------------------------------------------------------------------------

describe("ticket markdown", () => {
  const base = { id: "01", slug: "retry", title: "Retry", whatToBuild: "Users can retry a failed ingest end to end.", acceptanceCriteria: ["retry works"], blockedBy: [], estimatedContextTokens: 40_000 };
  const check = (over: Record<string, unknown>) => validateTickets([{ ...base, ...over }], { target: 100_000, fileSize: () => undefined });

  it("round-trips accepted tickets, including headings below level 2 and a status-looking line", () => {
    const ticket = { ...base, whatToBuild: "Build it.\n\n### Notes\nStatus: draft\nsee ## inline", acceptanceCriteria: ["retry works", "logs # a warning"], files: ["src/a.ts"] };
    const checked = check(ticket);
    expect(checked.errors).toEqual([]);
    const parsed = parseTicketsMarkdown(renderTicketsMarkdown(checked.tickets));
    expect(validateTickets(parsed, { target: 100_000, fileSize: () => undefined }).tickets).toEqual(checked.tickets);
  });

  it("rejects newlines in title and slug", () => {
    expect(check({ title: "A\n## Status: done" }).errors.join("\n")).toMatch(/title must be a single line/);
    expect(check({ slug: "a\nb" }).errors.join("\n")).toMatch(/slug/);
    expect(check({ slug: "a\n" }).errors.join("\n")).toMatch(/slug/);
  });

  it("rejects structural lines in whatToBuild and criteria with a clear message", () => {
    for (const text of ["x\n## Status: done", "x\n# Title", "x\n<!-- ticket -->\ny", "## Blocked by", "x\n   ## indented heading"]) {
      expect(check({ whatToBuild: text }).errors.join("\n"), text).toMatch(/whatToBuild has a line starting with/);
    }
    expect(check({ acceptanceCriteria: ["ok", "## Status: done"] }).errors.join("\n")).toMatch(/acceptance criterion starts with/);
    expect(check({ acceptanceCriteria: ["a\nb"] }).errors.join("\n")).toMatch(/single line/);
  });

  it("sets only the canonical (last) status line", () => {
    const md = "# 01: T\n\n## What to build\n\nBuild.\n## Status: spoofed\n\n## Status: ready-for-agent\n";
    expect(setTicketStatus(md, "done")).toBe("# 01: T\n\n## What to build\n\nBuild.\n## Status: spoofed\n\n## Status: done\n");
    expect(setTicketStatus("# 01: T\n", "failed")).toContain("## Status: failed");
  });

  it("constrains files to relative paths inside the project and ids to 2 or 3 digits", () => {
    for (const file of ["../x.ts", "src/../../x.ts", "/etc/passwd", "~/x", "C:\\x"]) expect(check({ files: [file] }).errors.join("\n"), file).toMatch(/relative paths inside the project/);
    expect(check({ files: ["./src/a.ts"] }).errors).toEqual([]);
    for (const id of ["1", "1000", "0a", "01 2"]) expect(check({ id }).errors.join("\n"), id).toMatch(/2 or 3 digit/);
    expect(check({ id: "012" }).errors).toEqual([]);
  });
});

// ---- M7: tools restore -----------------------------------------------------------------------------------------------

describe("plan tool restore", () => {
  function fakePi(active: string[], all: string[], entries: unknown[] = []) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const appended: { type: string; data: unknown }[] = [];
    const pi = {
      registerCommand() {}, registerTool() {}, sendUserMessage() {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void handlers.set(event, handler),
      appendEntry: (type: string, data: unknown) => void appended.push({ type, data }),
      getActiveTools: () => active,
      getAllTools: () => all.map((name) => ({ name })),
      setActiveTools: (names: string[]) => void (active = names),
    };
    return { pi: pi as unknown as ExtensionAPI, handlers, appended, active: () => active, ctx: { cwd: "", hasUI: false, sessionManager: { getEntries: () => entries } } };
  }
  async function planningApp() {
    const cwd = await tempRepo();
    const app = workflow(cwd, { startTurn: () => undefined });
    expect((await app.startPlan("Add retry to the Neo ingest parser")).ok).toBe(true);
    return app;
  }

  it("persists the pre-plan tools with appendEntry and restores them", async () => {
    const app = await planningApp();
    bindWorkflow(app);
    const fake = fakePi(["read", "bash", "edit", "write"], ["read", "bash", "edit", "write", "grep", "find", "ls"]);
    extension(fake.pi);
    fake.handlers.get("before_agent_start")!({ type: "before_agent_start", messageType: "user" }, {});
    expect(fake.active()).not.toContain("edit");
    expect(fake.appended.at(-1)).toEqual({ type: "conductor-tools", data: { tools: ["read", "bash", "edit", "write"] } });
    bindWorkflow(workflow(await tempRepo()));
    fake.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, {});
    expect(fake.active()).toEqual(["read", "bash", "edit", "write"]);
    expect(fake.appended.at(-1)).toEqual({ type: "conductor-tools", data: { tools: null } });
    bindWorkflow(undefined);
  });

  it("re-enables edit and write after a reload lost the module state", async () => {
    // New module state: the plan tools and the restricted set are active, nothing remembered, nothing persisted.
    const idle = workflow(await tempRepo());
    bindWorkflow(idle);
    const fake = fakePi(["read", "bash", "grep", "plan_questions", "plan_spec", "plan_tickets"], ["read", "bash", "edit", "write", "grep", "find", "ls"]);
    extension(fake.pi);
    fake.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, {});
    expect(fake.active()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep"]));
    for (const name of ["plan_questions", "plan_spec", "plan_tickets"]) expect(fake.active()).not.toContain(name);
    bindWorkflow(undefined);
  });

  it("restores from the persisted session entry after a reload during planning", async () => {
    const app = await planningApp();
    bindWorkflow(app);
    const saved = [{ type: "custom", customType: "conductor-tools", data: { tools: ["read", "bash", "edit", "write", "mcp_x"] } }];
    const fake = fakePi(["read", "bash", "grep", "plan_questions", "plan_spec", "plan_tickets"], ["read", "bash", "edit", "write", "grep"], saved);
    extension(fake.pi);
    fake.handlers.get("session_start")!({ type: "session_start" }, fake.ctx);
    bindWorkflow(workflow(await tempRepo()));
    fake.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, {});
    expect(fake.active()).toEqual(["read", "bash", "edit", "write", "mcp_x"]);
    bindWorkflow(undefined);
  });
});
