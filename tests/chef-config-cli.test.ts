import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localAdd, localDetect, localRemove, main, planActivate, planClose, setKey, show } from "../src/cli/chef-config.js";
import { loadConfig } from "../src/config.js";
import type { CostRecord, TaskState } from "../src/domain.js";
import { TaskStore } from "../src/storage/store.js";

type Doc = Record<string, any>;

describe("chef-config CLI", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "chef-cli-home-"));
    project = mkdtempSync(path.join(tmpdir(), "chef-cli-proj-"));
    process.env.HOME = home;
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(path.join(project, ".pi-workflows"), { recursive: true });
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });
  const userFile = () => path.join(home, ".pi", "agent", "chef.yaml");
  const user = (yaml: string) => writeFileSync(userFile(), yaml);
  const readUser = () => readFileSync(userFile(), "utf8");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  describe("show", () => {
    it("with no files: the defaults, no plans, the presets", () => {
      const r = show(project) as Doc;
      expect(r.ok).toBe(true);
      expect(r.models.low).toMatchObject({ value: "xai/grok-4.7", source: "default", kind: "pi", provider: "xai", id: "grok-4.7" });
      expect(r.models.review.value).toBe("anthropic/claude-opus-5-5");
      expect(r.local).toMatchObject({ configured: false, baseUrl: "", models: [] });
      expect(r.local.presets.map((p: Doc) => p.baseUrl)).toEqual(["http://127.0.0.1:8080/v1", "http://127.0.0.1:11434/v1", "http://127.0.0.1:1234/v1"]);
      expect(r.agents).toEqual(["claude", "codex", "cursor-agent", "grok", "agy", "gemini", "opencode"]);
      expect(r.agentsWithModelFlag).toContain("claude");
      expect(r.budgets).toEqual({ taskUsd: 20, dailyUsd: 75, shadowedByProject: false });
      expect(r.plans).toEqual([]);
      expect(r.costs.plan).toBeNull();
      expect(r.costs.today).toMatchObject({ spendUsd: 0, limitUsd: 75, status: "ok", unknown: 0 });
      expect(r.files.user).toMatchObject({ path: userFile(), exists: false, sha256: sha("") });
      expect(r.errors).toEqual([]);
    });

    it("classifies local, agent and Pi models, and flags what is wrong with them", () => {
      user("models:\n  low: local/Qwen3.8-27B\n  medium: agent:claude/opus\n  high: agent:nope\n  review: openai/gpt-6.1-sol:high\nlocal:\n  baseUrl: http://127.0.0.1:8080/v1\n  models: [{ id: Qwen3.8-27B, contextWindow: 131072 }]\n");
      const bad = show(project) as Doc;
      // agent:nope is not a known agent, so the loader rejects the file as a whole: the panel still shows what the file says.
      expect(bad.errors[0]).toContain("agent:nope");
      expect(bad.models.high.problem).toContain("unknown agent");
      expect(bad.models.low).toMatchObject({ kind: "local", id: "Qwen3.8-27B", source: "user" });
      expect(bad.models.low.problem).toBeUndefined();
      user("models:\n  low: local/Qwen3.8-27B\n  medium: agent:claude/opus\n  high: local/missing\n  review: openai/gpt-6.1-sol:high\nlocal:\n  baseUrl: http://127.0.0.1:8080/v1\n  models: [{ id: Qwen3.8-27B, contextWindow: 131072 }]\n");
      const r = show(project) as Doc;
      expect(r.errors).toEqual([]);
      expect(r.models.medium).toMatchObject({ kind: "agent", agent: "claude", agentModel: "opus" });
      expect(r.models.high).toMatchObject({ kind: "local", id: "missing" });
      expect(r.models.high.problem).toContain("does not list missing");
      expect(r.models.review).toMatchObject({ kind: "pi", provider: "openai", id: "gpt-6.1-sol", value: "openai/gpt-6.1-sol:high" });
    });

    it("says when a project file's section hides what the user file sets", () => {
      user("budgets:\n  taskUsd: 7\n");
      writeFileSync(path.join(project, ".pi-workflows", "config.yaml"), "budgets:\n  dailyUsd: 9\nmodels:\n  low: xai/grok-5\n");
      const r = show(project) as Doc;
      expect(r.budgets).toEqual({ taskUsd: 20, dailyUsd: 9, shadowedByProject: true });
      expect(r.modelsShadowedByProject).toBe(true);
      expect(r.models.low).toMatchObject({ value: "xai/grok-5", source: "project" });
      expect(r.models.medium.source).toBe("default");
    });
  });

  describe("set", () => {
    it("on the commented template keeps every comment and the result loads", () => {
      const template = readFileSync(path.join(__dirname, "..", "templates", "chef.yaml"), "utf8");
      user(template);
      const r = setKey(project, "models.low", "local/Qwen3.8-27B") as Doc;
      // The template has no local section, so the model is accepted by the loader but flagged by show.
      expect(r.ok).toBe(true);
      expect(r.changed).toBe(true);
      const text = readUser();
      for (const line of template.split("\n")) expect(text).toContain(line);
      expect(text).toContain("models:\n  low: local/Qwen3.8-27B");
      expect(loadConfig(project).models.low).toBe("local/Qwen3.8-27B");
      expect(r.models.low.problem).toContain("No local server is configured");
    });

    it("edits in place: other keys, comments and quoting stay", () => {
      user("# mine\nmodels:\n  low: xai/grok-4.7   # cheap\n  high: 'openai/gpt-6.1-sol'\nbudgets: { taskUsd: 5 }\nchecks:\n  - { name: unit, command: npm, args: [test] }\n");
      const r = setKey(project, "models.low", "agent:claude/haiku") as Doc;
      expect(r.ok).toBe(true);
      expect(readUser()).toBe("# mine\nmodels:\n  low: agent:claude/haiku # cheap\n  high: 'openai/gpt-6.1-sol'\nbudgets: { taskUsd: 5 }\nchecks:\n  - { name: unit, command: npm, args: [ test ] }\n");
      expect((setKey(project, "budgets.dailyUsd", "12.5") as Doc).ok).toBe(true);
      expect(loadConfig(project).budgets).toMatchObject({ taskUsd: 5, dailyUsd: 12.5 });
      expect(readUser()).toContain("budgets: { taskUsd: 5, dailyUsd: 12.5 }");
    });

    it("fills a bare section and creates the file and its folder", () => {
      user("models:\nbudgets:\n");
      expect((setKey(project, "models.review", "openai/gpt-6.1-sol") as Doc).ok).toBe(true);
      expect(loadConfig(project).models.review).toBe("openai/gpt-6.1-sol");
      const fresh = mkdtempSync(path.join(tmpdir(), "chef-cli-home2-"));
      process.env.HOME = fresh;
      expect((setKey(project, "budgets.taskUsd", "3") as Doc).ok).toBe(true);
      expect(readFileSync(path.join(fresh, ".pi", "agent", "chef.yaml"), "utf8")).toBe("budgets:\n  taskUsd: 3\n");
    });

    it("an empty value removes the key and the section it empties", () => {
      user("# top\nmodels:\n  low: xai/grok-5\nbudgets:\n  taskUsd: 3\n");
      expect((setKey(project, "models.low", "") as Doc).ok).toBe(true);
      expect(readUser()).toBe("# top\nbudgets:\n  taskUsd: 3\n");
    });

    it("refuses bad values and writes nothing", () => {
      user("budgets:\n  taskUsd: 3\n");
      const before = readUser();
      for (const [key, value, message] of [
        ["models.low", "grok", "provider/id"],
        ["models.low", "agent:nope", "unknown agent"],
        ["models.low", "agent:claude/", "empty model"],
        ["budgets.taskUsd", "-1", "greater than 0"],
        ["budgets.dailyUsd", "abc", "greater than 0"],
        ["routing.maxTicketTurns", "9", "not a setting"],
        ["local.baseUrl", "http://127.0.0.1:8080/v1", "no local server config"],
        ["local.baseUrl", "", "cannot be empty"],
      ] as const) {
        const r = setKey(project, key, value) as Doc;
        expect(r.ok, `${key}=${value}`).toBe(false);
        expect(r.error, `${key}=${value}`).toContain(message);
      }
      expect(readUser()).toBe(before);
    });

    it("never writes a secret", () => {
      user("budgets:\n  taskUsd: 3\n");
      const before = readUser();
      const r = setKey(project, "models.low", "agent:claude/sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123") as Doc;
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
      expect(readUser()).toBe(before);
    });

    it("keeps the sha256 stale-write guard", () => {
      user("budgets:\n  taskUsd: 3\n");
      const seen = (show(project) as Doc).files.user.sha256;
      expect(seen).toBe(sha(readUser()));
      writeFileSync(userFile(), "budgets:\n  taskUsd: 4\n");
      const stale = setKey(project, "budgets.taskUsd", "9", seen) as Doc;
      expect(stale.ok).toBe(false);
      expect(stale.error).toContain("changed since it was read");
      expect(readUser()).toBe("budgets:\n  taskUsd: 4\n");
      expect((setKey(project, "budgets.taskUsd", "9", sha(readUser())) as Doc).ok).toBe(true);
      expect((show(project) as Doc).budgets.taskUsd).toBe(9);
    });

    it("refuses a file it cannot parse or that is not a mapping", () => {
      user("budgets: [unclosed\n");
      expect((setKey(project, "budgets.taskUsd", "9") as Doc).error).toContain("cannot be edited");
      user("- a\n- b\n");
      expect((setKey(project, "budgets.taskUsd", "9") as Doc).error).toContain("not a YAML mapping");
    });

    it("keeps CRLF line endings", () => {
      user("budgets:\r\n  taskUsd: 3\r\n");
      expect((setKey(project, "budgets.dailyUsd", "8") as Doc).ok).toBe(true);
      expect(readUser()).toBe("budgets:\r\n  taskUsd: 3\r\n  dailyUsd: 8\r\n");
    });
  });

  describe("local models", () => {
    it("local-add creates the local section from the URL, then adds and updates ids", () => {
      user("# mine\nbudgets:\n  taskUsd: 3\n");
      const noUrl = localAdd(project, "Qwen3.8-27B", 131072) as Doc;
      expect(noUrl.error).toContain("enter the server URL");
      const made = localAdd(project, "Qwen3.8-27B", 131072, undefined, "http://127.0.0.1:8080/v1") as Doc;
      expect(made.ok).toBe(true);
      expect(made.local).toMatchObject({ configured: true, baseUrl: "http://127.0.0.1:8080/v1", models: [{ id: "Qwen3.8-27B", contextWindow: 131072 }] });
      expect(readUser().startsWith("# mine\n")).toBe(true);
      expect((localAdd(project, "llama3", 8192) as Doc).local.models.map((m: Doc) => m.id)).toEqual(["Qwen3.8-27B", "llama3"]);
      expect((localAdd(project, "llama3", 16384) as Doc).local.models[1]).toMatchObject({ id: "llama3", contextWindow: 16384 });
      expect(loadConfig(project).local?.models).toHaveLength(2);
    });

    it("local-add works on a flow list and rejects bad ids and windows", () => {
      user("local:\n  baseUrl: http://127.0.0.1:8080/v1\n  models: [{ id: a, contextWindow: 8192 }]\n");
      expect((localAdd(project, "b", 8192) as Doc).ok).toBe(true);
      expect(readUser()).toContain("models: [ { id: a, contextWindow: 8192 }, { id: b, contextWindow: 8192 } ]");
      expect((localAdd(project, "has space", 8192) as Doc).ok).toBe(false);
      expect((localAdd(project, "c", 100) as Doc).error).toContain("at least 4096");
      expect((localAdd(project, "c", Number.NaN) as Doc).ok).toBe(false);
    });

    it("local.baseUrl can be changed once local exists", () => {
      user("local:\n  baseUrl: http://127.0.0.1:8080/v1\n  models:\n    - { id: a, contextWindow: 8192 }\n");
      expect((setKey(project, "local.baseUrl", "http://127.0.0.1:11434/v1") as Doc).local.baseUrl).toBe("http://127.0.0.1:11434/v1");
      expect((setKey(project, "local.baseUrl", "http://example.com/v1") as Doc).error).toContain("https URL");
    });

    it("local-remove drops an id, keeps the last, and says when a model still names it", () => {
      user("models:\n  low: local/a\nlocal:\n  baseUrl: http://127.0.0.1:8080/v1\n  models:\n    - { id: a, contextWindow: 8192 }\n    - { id: b, contextWindow: 8192 }\n");
      const r = localRemove(project, "a") as Doc;
      expect(r.ok).toBe(true);
      expect(r.note).toContain("models.low still names local/a");
      expect(r.local.models).toEqual([{ id: "b", contextWindow: 8192 }]);
      expect((localRemove(project, "b") as Doc).error).toContain("cannot be empty");
      expect((localRemove(project, "zzz") as Doc).error).toContain("not in local.models");
    });
  });

  describe("local-detect", () => {
    const reply = (routes: Record<string, unknown>): typeof fetch => (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url in routes) return new Response(JSON.stringify(routes[url]), { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    it("lists served ids with the context the server reports, against what is configured", async () => {
      const fetchImpl = reply({
        "http://127.0.0.1:8080/v1/models": { data: [{ id: "Qwen3.8-27B" }, { id: "other" }] },
        "http://127.0.0.1:8080/props": { default_generation_settings: { n_ctx: 65536 } },
      });
      const r = (await localDetect("http://127.0.0.1:8080/v1/", { fetchImpl, configured: [{ id: "Qwen3.8-27B", contextWindow: 131072 }] })) as Doc;
      expect(r).toMatchObject({ ok: true, reachable: true, baseUrl: "http://127.0.0.1:8080/v1" });
      expect(r.models[0]).toMatchObject({ id: "Qwen3.8-27B", contextWindow: 65536, configured: 131072 });
      expect(r.models[0].mismatch).toContain("65536");
      expect(r.models[1]).toEqual({ id: "other", contextWindow: 65536 });
    });

    it("asks Ollama's /api/ps and retries a URL without /v1 with it", async () => {
      const fetchImpl = reply({
        "http://127.0.0.1:11434/v1/models": { data: [{ id: "qwen3:8b" }, { id: "idle" }] },
        "http://127.0.0.1:11434/api/ps": { models: [{ name: "qwen3:8b", context_length: 32768 }] },
      });
      const r = (await localDetect("http://127.0.0.1:11434", { fetchImpl })) as Doc;
      expect(r.baseUrl).toBe("http://127.0.0.1:11434/v1");
      expect(r.models).toEqual([{ id: "qwen3:8b", contextWindow: 32768 }, { id: "idle" }]);
    });

    it("an unreachable server is a result, not an error; a bad URL is refused", async () => {
      const down = (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const r = (await localDetect("http://127.0.0.1:9/v1", { fetchImpl: down })) as Doc;
      expect(r).toMatchObject({ ok: true, reachable: false, models: [] });
      expect(r.error).toContain("http://127.0.0.1:9/v1/models");
      expect(((await localDetect("not a url")) as Doc).ok).toBe(false);
      expect(((await localDetect("file:///etc/passwd")) as Doc).error).toContain("http");
    });
  });

  describe("plans and costs", () => {
    const at = "2026-10-14T12:00:00.000Z";
    const task = (name: string, extra: Partial<TaskState> = {}): TaskState => ({
      taskId: `task-${name}`,
      name,
      phase: "PLANNING",
      createdAt: at,
      updatedAt: at,
      phaseEnteredAt: at,
      request: `Request for ${name}`,
      ...extra,
    });
    const ticket = (id: string) => ({ id, title: id, description: "d", acceptance: ["ok"], files: [], checks: [], difficulty: "low" }) as never;
    const run = (status: "done" | "failed" | "in-progress") => ({ status, attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false }) as never;
    const entry = (n: number, extra: Partial<CostRecord>): CostRecord => ({
      id: `c${n}`, at: new Date().toISOString(), taskId: "task-alpha", phase: "IMPLEMENTING", provider: "anthropic", model: "claude-sonnet-5-5", tier: "medium", requests: 1,
      inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, actualUsd: 1, usageKnown: true, outcome: "success", retries: 0, reason: "t", ...extra,
    });
    let store: TaskStore;
    beforeEach(async () => {
      store = new TaskStore(path.join(project, ".pi-workflows"));
      await store.create(task("alpha", { phase: "IMPLEMENTING", updatedAt: "2026-10-15T12:00:00.000Z", plan: { version: 1, tickets: [ticket("t1"), ticket("t2")] } as never, ticketRuns: { t1: run("done"), t2: run("failed") } }));
      await store.create(task("beta"));
      await store.create(task("gamma", { phase: "COMPLETE" }));
      store.setActive("task-alpha");
      store.appendLedger(entry(1, { actualUsd: 1.5 }));
      store.appendLedger(entry(2, { phase: "PLANNING", provider: "openai", model: "gpt-6.1-sol", actualUsd: 0.5 }));
      store.appendLedger(entry(3, { actualUsd: null, provider: "xai", model: "grok-4.7", inputTokens: null, outputTokens: null }));
      store.appendLedger(entry(4, { taskId: "task-beta", phase: "REVIEWING", actualUsd: 2 }));
      store.appendLedger(entry(5, { at: "2026-01-01T00:00:00.000Z", actualUsd: 100 }));
    });

    it("lists plans with state, tickets, spend and the active mark", () => {
      const r = show(project) as Doc;
      expect(r.plans.map((p: Doc) => p.name)).toEqual(["alpha", "beta", "gamma"]);
      const alpha = r.plans[0];
      expect(alpha).toMatchObject({ id: "task-alpha", active: true, closed: false, phase: "IMPLEMENTING", ticketsDone: 1, ticketsTotal: 2, ticketsFailed: 1, unknown: 1 });
      expect(alpha.knownUsd).toBe(102);
      expect(alpha.spendUsd).toBeGreaterThan(102);
      expect(r.plans[1]).toMatchObject({ active: false, ticketsTotal: 0, spendUsd: 2 });
      expect(r.plans[2]).toMatchObject({ closed: true });
    });

    it("costs: today against the daily budget, the active plan against the task budget, by model and phase", () => {
      const costs = (show(project) as Doc).costs;
      // 1.5 + 0.5 + 2 known today, one unknown call, the January entry is not today's.
      expect(costs.today).toMatchObject({ knownUsd: 4, unknown: 1, limitUsd: 75, status: "ok" });
      expect(costs.today.spendUsd).toBe(4.05);
      expect(costs.today.byPhase.map((p: Doc) => [p.name, p.spendUsd])).toEqual([["plan", 0.5], ["build", 1.55], ["review", 2]]);
      expect(costs.today.byModel[0]).toMatchObject({ name: "anthropic/claude-sonnet-5-5", knownUsd: 3.5 });
      expect(costs.plan).toMatchObject({ id: "task-alpha", name: "alpha", knownUsd: 102, limitUsd: 20, status: "hard" });
      expect(costs.unpriced).toEqual(expect.arrayContaining(["anthropic/claude-sonnet-5-5", "xai/grok-4.7"]));
    });

    it("plan-activate points at the plan and records the branch, without switching", async () => {
      const r = (await planActivate(project, "task-beta")) as Doc;
      expect(r.ok).toBe(true);
      expect(r.plans.find((p: Doc) => p.active).name).toBe("beta");
      expect(store.readActive()).toBe("task-beta");
      expect(((await planActivate(project, "task-gamma")) as Doc).error).toContain("closed");
      expect(((await planActivate(project, "nope")) as Doc).error).toContain("No plan");
    });

    it("plan-close needs force for unbuilt work, closes, and moves the active pointer on", async () => {
      const refused = (await planClose(project, "task-alpha")) as Doc;
      expect(refused).toMatchObject({ ok: false, needsForce: true });
      expect(refused.error).toContain("1 ticket(s) not built");
      expect(store.load("task-alpha")?.phase).toBe("IMPLEMENTING");
      const r = (await planClose(project, "task-alpha", true)) as Doc;
      expect(r.ok).toBe(true);
      expect(store.load("task-alpha")?.phase).toBe("COMPLETE");
      expect(store.readActive()).toBe("task-beta");
      // beta has no plan and no build: nothing to confirm.
      const last = (await planClose(project, "task-beta")) as Doc;
      expect(last.ok).toBe(true);
      expect(store.readActiveFile().taskId).toBeUndefined();
      expect(((await planClose(project, "task-beta")) as Doc).note).toContain("already closed");
    });
  });

  describe("command line", () => {
    const run = async (...argv: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = await main(argv, (t) => (stdout += t), (t) => (stderr += t));
      return { code, stdout, stderr };
    };

    it("prints one JSON document for each command", async () => {
      user("budgets:\n  taskUsd: 3\n");
      const shown = await run("show", "--cwd", project);
      expect(shown.code).toBe(0);
      expect(JSON.parse(shown.stdout).budgets.taskUsd).toBe(3);
      const sha256 = JSON.parse(shown.stdout).files.user.sha256;
      const set = JSON.parse((await run("set", "--cwd", project, "--key", "budgets.taskUsd", "--value", "8", "--expect", sha256)).stdout);
      expect(set).toMatchObject({ ok: true, changed: true });
      expect(set.budgets.taskUsd).toBe(8);
      const stale = await run("set", "--cwd", project, "--key", "budgets.taskUsd", "--value", "9", "--expect", sha256);
      expect(stale.code).toBe(0);
      expect(JSON.parse(stale.stdout)).toMatchObject({ ok: false });
      const add = JSON.parse((await run("local-add", "--cwd", project, "--id", "m", "--context-window", "8192", "--base-url", "http://127.0.0.1:8080/v1")).stdout);
      expect(add.local.models).toEqual([{ id: "m", contextWindow: 8192 }]);
      expect(JSON.parse((await run("local-remove", "--cwd", project, "--id", "m")).stdout).ok).toBe(false);
    });

    it("exits nonzero only for a usage error", async () => {
      for (const argv of [[], ["bogus"], ["show"], ["set", "--cwd", project, "--key", "models.low"], ["set", "--cwd", project, "--value", "x"], ["local-add", "--cwd", project, "--id", "a"], ["local-remove", "--cwd", project], ["local-detect"], ["plan-close", "--cwd", project], ["show", "--cwd", project, "--expect"]]) {
        const r = await run(...argv);
        expect(r.code, argv.join(" ")).toBe(2);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("Usage:");
      }
    });

    it("a refused request is exit 0 with ok:false", async () => {
      const r = await run("set", "--cwd", project, "--key", "models.low", "--value", "bad");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
      expect(existsSync(userFile())).toBe(false);
    });
  });
});
