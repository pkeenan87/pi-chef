import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createReviewTabChat, REVIEW_TAB } from "../src/herdr/review-tab.js";
import type { ChildSessionFile } from "../src/herdr/session-file.js";
import { parseTicketVerdict } from "../src/orchestrator/ticket-review.js";
import { ProviderCallError } from "../src/providers/clients.js";
import { HerdrError } from "../src/herdr/client.js";
import { fakeHerdrClient, reviewerWrites, VERDICT, type FakeHerdrClientOptions } from "./herdr-fake.js";
import { checkRunner, sampleTicket, tieredConfig, ticketWorkflow, workflow } from "./helpers.js";

const exec = promisify(execFile);
function setup(client: FakeHerdrClientOptions = {}, options: { final?: string } = {}) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "pi-chef-review-tab-")), ".pi-workflows", "reviews");
  const events: string[] = [];
  const own: { files: readonly ChildSessionFile[]; model?: { provider: string; id: string } }[] = [];
  const progress: string[] = [];
  const fake = fakeHerdrClient({
    onCommand: (_tab, text) => void events.push(text),
    onSend: (tab) => {
      events.push("send");
      reviewerWrites(tab.sessionDir, options.final ?? VERDICT);
    },
    ...client,
  });
  const make = (extra: Partial<Parameters<typeof createReviewTabChat>[0]> = {}) =>
    createReviewTabChat({
      client: fake.client,
      host: { reviewsRoot: () => root, ledgerOwn: (files, model) => void own.push({ files, model }), progress: (t) => void progress.push(t) },
      registry: { find: () => ({}), isUsingOAuth: () => true },
      checkout: () => "/work/tree",
      space: async () => "sp1",
      ticketModePath: "/pi-chef/src/ticket-mode.ts",
      id: (() => {
        let n = 0;
        return () => `r${++n}`;
      })(),
      sleep: async () => undefined,
      ...extra,
    });
  return { root, fake, events, own, progress, make, chat: make() };
}

const opus = { provider: "anthropic" as const, model: "claude-opus-5-5" };
const req = (user = "diff here") => ({ messages: [{ role: "system" as const, content: "You review." }, { role: "user" as const, content: user }], maxTokens: 1500 });

describe("createReviewTabChat", () => {
  it("starts one review tab on first use with the labels, tools, env and session dir", async () => {
    const t = setup();
    let packet = "";
    const original = t.fake.client.send;
    t.fake.client.send = async (tab, text, o) => {
      packet = readFileSync(text.match(/read (\S+\.md)/)![1]!, "utf8");
      return original(tab, text, o);
    };
    const reply = await t.chat(opus, req("THE DIFF"));
    expect(t.fake.tabs).toHaveLength(1);
    const tab = t.fake.tabs[0]!;
    expect(tab.options.argv.slice(0, 3)).toEqual(["env", `PI_CHEF_STATUS=${path.join(path.dirname(t.root), "reviews.status.json")}`, "PI_CHEF_MAX_TURNS=8"]);
    expect(tab.options.argv.slice(3, 8)).toEqual(["pi", "-ne", "-e", "/pi-chef/src/ticket-mode.ts", "--model"]);
    expect(tab.model).toBe("anthropic/claude-opus-5-5");
    expect(tab.options.argv.slice(tab.options.argv.indexOf("--tools"), tab.options.argv.indexOf("--tools") + 2)).toEqual(["--tools", "read,grep,find,ls"]);
    expect(tab.sessionDir).toBe(t.root);
    expect(tab.options).toMatchObject({ name: REVIEW_TAB, outliveParent: true, cwd: "/work/tree", labels: { "herdr.space": "sp1", "herdr.tab": "chef-review", "pi-chef.role": "review", "pi-chef.model": "anthropic/claude-opus-5-5", "pi-chef.checkout": "/work/tree", "pi-chef.workspace": path.dirname(t.root) } });
    expect(tab.options.notify).toBeFalsy();
    expect(t.events).toEqual(["/new", "send"]);
    expect(tab.sends[0]).toMatch(/^Review request r1: read .*r1\.md and answer exactly as it asks\.$/);
    expect(packet).toContain("Read files only under /work/tree");
    expect(packet).toContain("You review.");
    expect(packet).toContain("THE DIFF");
    expect(existsSync(path.join(t.root, "r1.md"))).toBe(false);
    expect(reply.provider).toBe("anthropic");
    expect(reply.model).toBe("claude-opus-5-5");
  });

  it("sums usage over the turns of the request and returns the prose-wrapped verdict that parseTicketVerdict reads", async () => {
    const t = setup();
    const reply = await t.chat(opus, req());
    expect(reply.usage).toMatchObject({ input: 30, output: 12, requests: 2, listPriceUsd: 0.03 });
    expect(reply.text).toContain("That is my review.");
    expect(parseTicketVerdict(reply.text)).toMatchObject({ verdict: "pass", summary: "criteria met" });
    // Pi's own entries go to the ledger helper; the assistant messages are the caller's to ledger, so they are not passed on as theirs.
    expect(t.own).toHaveLength(1);
    expect(t.own[0]!.model).toEqual({ provider: "anthropic", id: "claude-opus-5-5" });
  });

  it("reuses the tab, sends /new before each review, and only counts the new request's messages", async () => {
    const t = setup();
    const first = await t.chat(opus, req());
    const second = await t.chat(opus, req());
    expect(t.fake.tabs).toHaveLength(1);
    expect(t.events).toEqual(["/new", "send", "/new", "send"]);
    expect(t.fake.tabs[0]!.commands).toEqual(["/new", "/new"]);
    expect(second.usage).toMatchObject({ input: 30, output: 12, requests: 2 });
    expect(first.usage.input).toBe(30);
    // A new process finds the same tab by its labels instead of starting another.
    const again = t.make();
    await again(opus, req());
    expect(t.fake.tabs).toHaveLength(1);
    expect(t.events.filter((e) => e === "/new")).toHaveLength(3);
  });

  it("replaces the terminal when the model differs, under the same herdr.tab label", async () => {
    const t = setup();
    await t.chat(opus, req());
    await t.chat({ provider: "anthropic", model: "claude-sonnet-5-5" }, req());
    expect(t.fake.tabs).toHaveLength(2);
    expect(t.fake.tabs[0]!.killed).toBe(true);
    expect(t.fake.tabs[1]!.killed).toBe(false);
    expect(t.fake.tabs[1]!.model).toBe("anthropic/claude-sonnet-5-5");
    expect(t.fake.tabs[1]!.options.labels).toMatchObject({ "herdr.tab": "chef-review", "pi-chef.role": "review", "pi-chef.model": "anthropic/claude-sonnet-5-5" });
    expect(t.fake.tabs.flatMap((tab) => tab.commands).every((c) => c === "/new")).toBe(true);
    // Back to the first model: replaced again, still one live review tab.
    await t.chat(opus, req());
    expect(t.fake.tabs.filter((tab) => !tab.killed)).toHaveLength(1);
  });

  it("replaces the terminal when the checkout (a later build's worktree) or the workspace differs, keeping the one tab name", async () => {
    const t = setup();
    let tree = "/work/tree-a";
    const chat = t.make({ checkout: () => tree });
    await chat(opus, req());
    await chat(opus, req());
    expect(t.fake.tabs).toHaveLength(1);
    tree = "/work/tree-b";
    await chat(opus, req());
    expect(t.fake.tabs).toHaveLength(2);
    expect(t.fake.tabs[0]!.killed).toBe(true);
    expect(t.fake.tabs[1]!.options).toMatchObject({ cwd: "/work/tree-b", name: REVIEW_TAB, labels: { "herdr.tab": "chef-review", "pi-chef.checkout": "/work/tree-b" } });
    expect(t.fake.tabs[1]!.options.cwd).toBe("/work/tree-b");
    // The packet of the second build names the second tree.
    // Another workspace (a second repository in the same space): replaced the same way, still one live tab.
    const other = path.join(mkdtempSync(path.join(tmpdir(), "pi-chef-review-tab-")), ".pi-workflows", "reviews");
    const elsewhere = t.make({ checkout: () => tree, host: { reviewsRoot: () => other, ledgerOwn: () => undefined, progress: () => undefined } });
    await elsewhere(opus, req());
    expect(t.fake.tabs.filter((tab) => !tab.killed)).toHaveLength(1);
    expect(t.fake.tabs[2]!.options.labels).toMatchObject({ "pi-chef.workspace": path.dirname(other), "herdr.tab": "chef-review" });
    expect(t.fake.tabs[2]!.sessionDir).toBe(other);
  });

  it("does not interrupt the person's own turn when the request is stopped before the review; it does once reviewing", async () => {
    let interrupted = 0;
    const hang = () => new Promise(() => undefined) as never;
    const before = setup({ waitIdle: (_tab, n) => (n === 1 ? { status: "idle", exitCode: null, timedOut: false } : hang()) });
    before.fake.client.interrupt = async () => void (interrupted += 1);
    const controller = new AbortController();
    const pending = before.chat(opus, { ...req(), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow(/review was stopped/);
    expect(interrupted).toBe(0);
    expect(before.events).toEqual([]); // nothing was typed into the busy tab

    const during = setup({ waitIdle: (_tab, n) => (n <= 2 ? { status: "idle", exitCode: null, timedOut: false } : hang()) });
    during.fake.client.interrupt = async () => void (interrupted += 1);
    const second = new AbortController();
    const running = during.chat(opus, { ...req(), signal: second.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    second.abort();
    await expect(running).rejects.toThrow(/review was stopped/);
    expect(interrupted).toBe(1);
  });

  it("treats hc's status_mismatch (nothing typed: the tab is busy) as busy: waits for idle and tries again", async () => {
    const busy = () => new HerdrError("send failed: terminal is working", "hc send", "", "status_mismatch");
    let commandFails = 2;
    let sendFails = 1;
    const t = setup({
      onCommand: (_tab, text) => {
        if (commandFails-- > 0) throw busy();
        t.events.push(text);
      },
      onSend: (tab) => {
        if (sendFails-- > 0) throw busy();
        t.events.push("send");
        reviewerWrites(tab.sessionDir, VERDICT);
      },
    });
    const reply = await t.chat(opus, req());
    expect(parseTicketVerdict(reply.text)?.verdict).toBe("pass");
    expect(t.events.filter((e) => e === "/new" || e === "send")).toEqual(["/new", "send"]);
    expect(t.fake.tabs[0]!.commands).toHaveLength(3);
    // Other hc errors are not retried.
    const broken = setup({ onCommand: () => { throw new HerdrError("no such terminal", "hc send", "", "not_found"); } });
    await expect(broken.chat(opus, req())).rejects.toThrow(/no such terminal/);
    expect(broken.fake.tabs[0]!.commands).toHaveLength(1);
  });

  it("gives up on a tab that stays busy once the request's time is spent", async () => {
    let clock = 0;
    const t = setup({ onCommand: () => { clock += 600_000; throw new HerdrError("busy", "hc send", "", "status_mismatch"); } });
    const chat = t.make({ now: () => clock, requestTimeoutMs: 1_000_000 });
    await expect(chat(opus, req())).rejects.toThrow(/stayed busy; nothing was typed/);
    expect(t.fake.tabs[0]!.commands).toHaveLength(2);
  });

  it("removes the packet whether the review answered or failed", async () => {
    const ok = setup();
    await ok.chat(opus, req());
    const failed = setup({ onSend: () => undefined });
    await expect(failed.chat(opus, req())).rejects.toThrow();
    for (const t of [ok, failed]) expect(existsSync(path.join(t.root, "r1.md"))).toBe(false);
  });

  it("gives Pi's own entries the current model only for the newest session file, and skips files older than the request", async () => {
    const t = setup();
    const old = reviewerWrites(t.root, VERDICT).getSessionFile()!; // a session from before this request
    const { utimesSync } = await import("node:fs");
    utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await t.chat(opus, req());
    const calls = t.own.map((c) => ({ files: c.files.map((f) => f.file), model: c.model }));
    expect(calls.every((c) => c.files.length === 1 && c.files[0] !== old)).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)!.model).toEqual({ provider: "anthropic", id: "claude-opus-5-5" });
  });

  it("uses a Foundry deployment id for --model", async () => {
    const t = setup({}, {});
    const chat = t.make({ piModelId: (provider, model) => (provider === "foundry" ? "grok-4-6" : model) });
    await chat({ provider: "foundry", model: "grok-4-7" }, req());
    expect(t.fake.tabs[0]!.model).toBe("foundry/grok-4-6");
  });

  it("never runs two reviews in the tab at once", async () => {
    const order: string[] = [];
    const t = setup({
      onSend: async (tab) => {
        order.push("start");
        await new Promise((resolve) => setTimeout(resolve, 15));
        reviewerWrites(tab.sessionDir, VERDICT);
        order.push("end");
      },
    });
    await Promise.all([t.chat(opus, req()), t.chat(opus, req()), t.chat(opus, req())]);
    expect(order).toEqual(["start", "end", "start", "end", "start", "end"]);
  });

  it("throws when the tab dies, carrying the usage already spent", async () => {
    const t = setup({ waitIdle: (_tab, n) => (n === 3 ? { status: "ended", exitCode: 1, timedOut: false } : { status: "idle", exitCode: null, timedOut: false }) });
    const error = (await t.chat(opus, req()).catch((e: unknown) => e)) as ProviderCallError;
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error.message).toMatch(/ended \(exit 1\)/);
    expect(error.usage).toMatchObject({ input: 30, output: 12 });
  });

  it("throws on a status error, an aborted run, no answer, and a timeout", async () => {
    const statusFile = (t: ReturnType<typeof setup>) => path.join(path.dirname(t.root), "reviews.status.json");
    const withStatus = setup({ onSend: (tab) => (reviewerWrites(tab.sessionDir, VERDICT), writeFileSync(tab.statusFile!, JSON.stringify({ error: "Provider foundry: bad endpoint" }))) });
    await expect(withStatus.chat(opus, req())).rejects.toThrow(/review tab reported: Provider foundry: bad endpoint/);
    expect(statusFile(withStatus)).toBe(withStatus.fake.tabs[0]!.statusFile);

    const aborted = setup({ onSend: (tab) => (reviewerWrites(tab.sessionDir, VERDICT), writeFileSync(tab.statusFile!, JSON.stringify({ turns: 10, turnLimit: true, aborted: true }))) });
    await expect(aborted.chat(opus, req())).rejects.toThrow(/turn limit/);

    const silent = setup({ onSend: () => undefined });
    await expect(silent.chat(opus, req())).rejects.toThrow(/gave no answer/);

    let waits = 0;
    const slow = setup({ waitIdle: () => (++waits <= 2 ? { status: "idle", exitCode: null, timedOut: false } : { status: "timeout", exitCode: null, timedOut: true }) });
    await expect(slow.chat(opus, req())).rejects.toThrow(/still working/);
  });

  it("stops and interrupts the tab when the request's signal aborts", async () => {
    let interrupted = 0;
    const t = setup({ waitIdle: (_tab, n) => (n <= 2 ? { status: "idle", exitCode: null, timedOut: false } : (new Promise(() => undefined) as never)) });
    t.fake.client.interrupt = async () => void (interrupted += 1);
    const controller = new AbortController();
    const pending = t.chat(opus, { ...req(), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow(/review was stopped/);
    expect(interrupted).toBeGreaterThan(0);
  });

  it("does not use a model the registry refuses, and starts no tab for it", async () => {
    const t = setup();
    const chat = t.make({ registry: { find: () => undefined } });
    await expect(chat(opus, req())).rejects.toThrow(/not registered/);
    expect(t.fake.tabs).toHaveLength(0);
  });

  it("throws, starting nothing, when herdr is not available", async () => {
    const t = setup();
    const chat = t.make({ space: async () => ({ problem: "no hc" }) });
    await expect(chat(opus, req())).rejects.toThrow(/herdr is not available: no hc/);
    expect(t.fake.tabs).toHaveLength(0);
  });

  it("fails with hc's message when the review tab cannot be started (duplicate name)", async () => {
    const t = setup({ failRun: (run) => (run.name === REVIEW_TAB ? "name 'chef-review' is already in use" : undefined) });
    await expect(t.chat(opus, req())).rejects.toThrow(/already in use/);
  });
});

describe("the review tab in the workflow", () => {
  it("runs /review's model pass through the tab and returns its findings", async () => {
    const cwd = await (await import("./helpers.js")).tempRepo();
    await exec("git", ["switch", "-c", "fix/retry"], { cwd });
    writeFileSync(path.join(cwd, "retry.ts"), "export const retry = 3;\n");
    await exec("git", ["add", "."], { cwd });
    await exec("git", ["commit", "-m", "Add retry"], { cwd });
    const requests: string[] = [];
    const fake = fakeHerdrClient({
      onSend: (tab, text) => {
        requests.push(text);
        reviewerWrites(tab.sessionDir, 'Looked at it.\n[{"severity":"medium","message":"retry has no backoff","file":"retry.ts","line":1}]');
      },
    });
    const app = workflow(cwd, { config: tieredConfig(), runner: checkRunner(async () => ({ code: 0, stdout: "ok", stderr: "" })) });
    const reviewChat = createReviewTabChat({
      client: fake.client,
      host: { reviewsRoot: () => app.reviewsRoot(), ledgerOwn: () => undefined, progress: () => undefined },
      registry: { find: () => ({}), isUsingOAuth: () => true },
      checkout: () => cwd,
      space: async () => "sp1",
      ticketModePath: "/pi-chef/src/ticket-mode.ts",
      sleep: async () => undefined,
    });
    let plainCalls = 0;
    app.bind({ chat: async () => (plainCalls++, { text: "[]", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 }, provider: "anthropic", model: "x" }), reviewChat });
    const result = await app.review();
    expect(result.ok, result.text).toBe(true);
    expect(requests).toHaveLength(1);
    expect(fake.tabs).toHaveLength(1);
    expect(plainCalls).toBe(0);
    expect(JSON.stringify(readFileSync(path.join(app.store.root, "cost", "ledger.jsonl"), "utf8"))).toContain("model review");
  });

  it("leaves reviewChat unset unless it is bound, and a later bind without it unbinds it", async () => {
    const { app } = await ticketWorkflow([sampleTicket("01")]);
    const ctx = (app as unknown as { ctx: { reviewChat?: unknown } }).ctx;
    expect(ctx.reviewChat).toBeUndefined();
    app.bind({ reviewChat: async () => { throw new Error("x"); } });
    expect(ctx.reviewChat).toBeDefined();
    app.bind({});
    expect(ctx.reviewChat).toBeUndefined();
  });
});

describe("Pi's own entries are ledgered once across Workflow instances", () => {
  it("a second instance that loaded the ledger earlier does not record an id the first one wrote", async () => {
    const { tempRepo } = await import("./helpers.js");
    const cwd = await tempRepo();
    const a = workflow(cwd, { config: tieredConfig() });
    const b = workflow(cwd, { config: tieredConfig() });
    const entry = { id: "e1", type: "usage", kind: "cache_warm", timestamp: new Date().toISOString(), provider: "anthropic", model: "claude-opus-5-5", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } };
    expect(b.recordPiUsage({ sessionId: "s", entries: [] })).toEqual([]); // b loads its seen-set now
    expect(a.recordPiUsage({ sessionId: "s", entries: [entry] })).toHaveLength(1);
    expect(b.recordPiUsage({ sessionId: "s", entries: [entry] })).toHaveLength(0);
    expect(a.store.readLedger().filter((row) => row.id === "pi-s-e1")).toHaveLength(1);
  });
});
