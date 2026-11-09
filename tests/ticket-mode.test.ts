import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ticketMode, type TicketStatus } from "../src/ticket-mode.js";
import { TURN_GRACE } from "../src/orchestrator/turn-budget.js";

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/ticket-mode.ts");
const KEYS = ["PI_CHEF_MAX_TURNS", "PI_CHEF_STATUS", "PI_CHEF_TICKET"] as const;

// A real Pi session on pi-ai's faux provider, with ticket mode loaded the way `pi -ne -e <file>` loads it.
describe("ticket mode on Pi's SDK", () => {
  const priorHome = process.env.HOME;
  const priorEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  let cwd: string;
  let statusFile: string;
  beforeEach(() => {
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    cwd = mkdtempSync(path.join(tmpdir(), "ticket-"));
    // Outside the worktree, like the runner passes it.
    statusFile = path.join(mkdtempSync(path.join(tmpdir(), "status-")), "nested", "ticket.json");
  });
  afterEach(() => {
    process.env.HOME = priorHome;
    for (const key of KEYS) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
  });

  async function open(extension: { path: string } | { factory: (pi: never) => void }) {
    const runtime = await ModelRuntime.create({ authPath: path.join(process.env.HOME!, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const provider = fauxProvider({ provider: "faux", models: [{ id: "m", reasoning: true }] });
    runtime.registerNativeProvider(provider.provider);
    const model = new ModelRegistry(runtime).find("faux", "m");
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      ...("path" in extension ? { additionalExtensionPaths: [extension.path] } : { noExtensions: true, extensionFactories: [extension.factory as never] }),
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: model as never, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
    return { session, provider };
  }

  const status = (): TicketStatus => JSON.parse(readFileSync(statusFile, "utf8"));
  const toolResults = (session: Awaited<ReturnType<typeof open>>["session"]) => JSON.stringify(session.messages.filter((message) => message.role === "toolResult"));

  it("loads from its file path, registers no command, and blocks a push and a destructive command", async () => {
    const { session, provider } = await open({ path: ENTRY });
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "git push origin main" }, { id: "a" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf /" }, { id: "b" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    await session.prompt("Build it.");
    await session.waitForIdle();
    session.dispose();
    const results = toolResults(session);
    expect(results).toContain("do not push");
    expect(results).toContain("Blocked destructive command");
    expect(session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toEqual([]);
  });

  it("with no env vars, has no budget and writes no status file", async () => {
    for (const key of KEYS) delete process.env[key];
    const { session, provider } = await open({ path: ENTRY });
    provider.setResponses([fauxAssistantMessage(fauxText("Done."))]);
    await session.prompt("Build it.");
    await session.waitForIdle();
    session.dispose();
    expect(existsSync(statusFile)).toBe(false);
  });

  it("writes the status after each assistant turn, steers at the limit and aborts TURN_GRACE turns later", async () => {
    process.env.PI_CHEF_MAX_TURNS = "2";
    process.env.PI_CHEF_STATUS = statusFile;
    process.env.PI_CHEF_TICKET = "01";
    const { session, provider } = await open({ path: ENTRY });
    const seen: string[] = [];
    provider.setResponses(
      Array.from({ length: 2 + TURN_GRACE + 5 }, (_, index) => (context: { messages: unknown[] }) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxToolCall("ls", { path: "." }, { id: `call-${index}` }), { stopReason: "toolUse" });
      }),
    );
    await session.prompt("Build it.");
    await session.waitForIdle();
    session.dispose();
    // The abort lands at turn 2 + TURN_GRACE; a turn already streaming may still end after it.
    expect(status()).toMatchObject({ turnLimit: true, aborted: true });
    expect(status().turns).toBeGreaterThanOrEqual(2 + TURN_GRACE);
    expect(status().turns).toBeLessThanOrEqual(2 + TURN_GRACE + 1);
    expect(seen.some((text) => text.includes("budget of 2 turns"))).toBe(true);
    expect(provider.state.callCount).toBeLessThanOrEqual(2 + TURN_GRACE + 1);
  });

  it("reports a normal finish under the limit as not limited and not aborted", async () => {
    const { session, provider } = await open({ factory: (pi) => ticketMode(pi, { env: { PI_CHEF_MAX_TURNS: "10", PI_CHEF_STATUS: statusFile }, cwd }) });
    provider.setResponses([fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Done."))]);
    await session.prompt("Build it.");
    await session.waitForIdle();
    session.dispose();
    expect(status()).toEqual({ turns: 2, turnLimit: false, aborted: false });
  });

  it("resets aborted for each run, and an interrupt during a tool still reports aborted (agent_settled is final)", async () => {
    const { session, provider } = await open({ factory: (pi) => ticketMode(pi, { env: { PI_CHEF_STATUS: statusFile }, cwd }) });
    provider.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("never"))]);
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") void session.abort();
    });
    await session.prompt("Build it.");
    await session.waitForIdle();
    expect(status().aborted).toBe(true);
    // A retry on the same session starts clean.
    provider.setResponses([fauxAssistantMessage(fauxText("Done."))]);
    await session.prompt("Try again.");
    await session.waitForIdle();
    session.dispose();
    expect(status().aborted).toBe(false);
  }, 20_000);

  it("reports a config error in the status file at load and in every later write", async () => {
    mkdirSync(path.join(cwd, ".pi-workflows"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi-workflows", "config.yaml"), "providers: [\n", "utf8");
    const { session, provider } = await open({ factory: (pi) => ticketMode(pi, { env: { PI_CHEF_STATUS: statusFile }, cwd }) });
    expect(typeof JSON.parse(readFileSync(statusFile, "utf8")).error).toBe("string");
    provider.setResponses([fauxAssistantMessage(fauxText("Done."))]);
    await session.prompt("Build it.");
    await session.waitForIdle();
    session.dispose();
    expect(status()).toMatchObject({ turns: 1, turnLimit: false, aborted: false });
    expect(status().error).toBeTruthy();
  });
});

// Handlers called directly on a stub of Pi's extension API.
describe("ticket mode hooks", () => {
  type Handler = (event: never, ctx: never) => unknown;
  function stub(throwOnRegister?: string) {
    const handlers = new Map<string, Handler[]>();
    const pi = {
      on: (name: string, handler: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerProvider: () => {
        if (throwOnRegister) throw new Error(throwOnRegister);
      },
      registerCommand: () => {
        throw new Error("no commands");
      },
    };
    const fire = async (name: string, event: unknown, ctx: unknown = {}) => {
      for (const handler of handlers.get(name) ?? []) {
        const result = await handler(event as never, ctx as never);
        if (result) return result;
      }
      return undefined;
    };
    return { pi: pi as never, fire };
  }
  const dir = () => mkdtempSync(path.join(tmpdir(), "mode-"));
  /** A user config with a `local` section, in a HOME of its own for the duration of `body`. */
  async function withLocalConfig<T>(body: () => Promise<T>): Promise<T> {
    const prior = process.env.HOME;
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    try {
      // `local` is user-only: it comes from the user's chef.yaml, never the project's.
      mkdirSync(path.join(process.env.HOME, ".pi", "agent"), { recursive: true });
      writeFileSync(path.join(process.env.HOME, ".pi", "agent", "chef.yaml"), "local:\n  baseUrl: http://127.0.0.1:9/v1\n  models:\n    - { id: qwen, contextWindow: 8000 }\n", "utf8");
      return await body();
    } finally {
      process.env.HOME = prior;
    }
  }

  it("registers the local provider from the user's config, so --model local/<id> resolves in the child", async () => {
    await withLocalConfig(async () => {
      const registered: { name: string; config: { baseUrl: string; models: { id: string; contextWindow: number }[] } }[] = [];
      const pi = { on: () => undefined, registerProvider: (name: string, config: never) => void registered.push({ name, config }) };
      ticketMode(pi as never, { env: {}, cwd: dir() });
      expect(registered).toHaveLength(1);
      expect(registered[0]!.name).toBe("local");
      expect(registered[0]!.config.baseUrl).toBe("http://127.0.0.1:9/v1");
      expect(registered[0]!.config.models.map((model) => [model.id, model.contextWindow])).toEqual([["qwen", 8000]]);
    });
  });

  it("refuses a destructive command in user_bash and in powershell, like the main session", async () => {
    const { pi, fire } = stub();
    ticketMode(pi, { env: {}, cwd: dir() });
    expect(await fire("user_bash", { command: "rm -rf /" })).toMatchObject({ result: { exitCode: 126 } });
    expect(await fire("user_bash", { command: "ls" })).toBeUndefined();
    expect(await fire("tool_call", { toolName: "powershell", toolCallId: "1", input: { command: "rm -rf /" } })).toMatchObject({ block: true });
    expect(await fire("tool_call", { toolName: "powershell", toolCallId: "2", input: { command: "Get-Date" } })).toBeUndefined();
  });

  it("starts a new count and a clean status on every session start (a /new in the ticket tab)", async () => {
    const { pi, fire } = stub();
    const file = path.join(dir(), "status.json");
    ticketMode(pi, { env: { PI_CHEF_MAX_TURNS: "1", PI_CHEF_STATUS: file }, cwd: dir() });
    const read = () => JSON.parse(readFileSync(file, "utf8"));
    let aborts = 0;
    const ctx = { abort: () => void (aborts += 1) };
    const turn = () => fire("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
    for (let i = 0; i < 1 + TURN_GRACE; i++) await turn();
    expect(aborts).toBe(1);
    expect(read()).toMatchObject({ turns: 1 + TURN_GRACE, turnLimit: true, aborted: true });
    await fire("session_start", { reason: "new" });
    expect(read()).toEqual({ turns: 0, turnLimit: false, aborted: false });
    await turn();
    expect(read()).toEqual({ turns: 1, turnLimit: false, aborted: false });
    for (let i = 0; i < TURN_GRACE; i++) await turn();
    expect(aborts).toBe(2); // the second session was cut at its own limit, not at the first one's leftovers
  });

  it("with no status file, warns once at session start; a registration failure is redacted in the status file", async () => {
    await withLocalConfig(async () => {
      const where = dir();
      const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
      const quiet = stub(`refused ${secret}`);
      ticketMode(quiet.pi, { env: {}, cwd: where });
      const notices: string[] = [];
      await quiet.fire("session_start", {}, { ui: { notify: (message: string) => void notices.push(message) } });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("pi-chef ticket mode");
      expect(notices[0]).not.toContain(secret);

      const file = path.join(mkdtempSync(path.join(tmpdir(), "status-")), "s.json");
      const loud = stub(`refused ${secret}`);
      ticketMode(loud.pi, { env: { PI_CHEF_STATUS: file }, cwd: where });
      const written = readFileSync(file, "utf8");
      expect(JSON.parse(written).error).toContain("local");
      expect(written).not.toContain(secret);
    });
  });
});
