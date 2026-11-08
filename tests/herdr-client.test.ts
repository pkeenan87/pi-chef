import { describe, expect, it } from "vitest";
import { createHerdrClient, execFileExec, HerdrError, slashKeys } from "../src/herdr/client.js";
import { fail, fakeHerdr, ok } from "./herdr-fake.js";

const wait = (status: string, extra: object = {}) => ok({ children: [], ended: true, exit_code: null, reason: "status", signal: null, status, terminal: "t5", turn: 1, ...extra });

describe("herdr client errors", () => {
  it("surfaces hc's error kind (status_mismatch: --if idle typed nothing)", async () => {
    const { exec } = fakeHerdr({ send: [{ stdout: JSON.stringify({ error: { kind: "status_mismatch", message: "terminal is working", hint: "nothing was typed" } }), stderr: "", code: 10 }] });
    const error = (await createHerdrClient({ exec }).send("t5", "hi", { ifIdle: true }).catch((e: unknown) => e)) as HerdrError;
    expect(error).toBeInstanceOf(HerdrError);
    expect(error.kind).toBe("status_mismatch");
  });
});

describe("herdr client argv", () => {
  it("run: bg, json, no-notify, labels repeated, -- before argv", async () => {
    const { exec, calls } = fakeHerdr({ run: [ok({ address: "t9" })] });
    const client = createHerdrClient({ exec });
    const t = await client.run({ argv: ["pi", "-ne", "--model", "a/b:high"], cwd: "/w", name: "chef-x", labels: { "herdr.space": "sp1", "pi-chef.ticket": "01" } });
    expect(t).toBe("t9");
    expect(calls[0].file).toBe("hc");
    expect(calls[0].args).toEqual(["run", "--bg", "--json", "--no-notify", "--name", "chef-x", "--cwd", "/w", "--label", "herdr.space=sp1", "--label", "pi-chef.ticket=01", "--", "pi", "-ne", "--model", "a/b:high"]);
  });

  it("run: notify and outliveParent flags, custom command", async () => {
    const { exec, calls } = fakeHerdr({ run: [ok({ address: "t9" })] });
    await createHerdrClient({ exec, command: "/opt/hc" }).run({ argv: ["pi"], notify: true, outliveParent: true });
    expect(calls[0].file).toBe("/opt/hc");
    expect(calls[0].args).toEqual(["run", "--bg", "--json", "--outlive-parent", "--", "pi"]);
  });

  it("run: refuses bad labels, empty argv, and a missing address", async () => {
    const { exec } = fakeHerdr({ run: [ok({})] });
    const client = createHerdrClient({ exec });
    await expect(client.run({ argv: ["pi"], labels: { "bad key": "v" } })).rejects.toBeInstanceOf(HerdrError);
    await expect(client.run({ argv: ["pi"], labels: { k: "a\nb" } })).rejects.toBeInstanceOf(HerdrError);
    await expect(client.run({ argv: [] })).rejects.toBeInstanceOf(HerdrError);
    await expect(client.run({ argv: ["pi"] })).rejects.toThrow(/no terminal address/);
  });

  it("label values with spaces, quotes and = stay one argv entry", async () => {
    const { exec, calls } = fakeHerdr({ ls: [ok({ terminals: [] })] });
    await createHerdrClient({ exec }).find({ labels: { "pi-chef.role": `re view "x"=y` } });
    expect(calls[0].args).toEqual(["ls", "--json", "--label", `pi-chef.role=re view "x"=y`]);
  });

  it("send, keys, interrupt, kill, get", async () => {
    const { exec, calls } = fakeHerdr({ get: [ok({ address: "t3", status: { state: "idle" }, labels: { a: "b" }, cwd: "/c" })] });
    const client = createHerdrClient({ exec });
    await client.send("t3", "--force; $(rm -rf /)");
    await client.keys("t3", ["/", "n", "enter"]);
    await client.interrupt("t3");
    await client.kill("t3");
    const info = await client.get("t3");
    expect(calls.map((c) => c.args)).toEqual([
      ["send", "--json", "t3", "--", "--force; $(rm -rf /)"],
      ["keys", "--json", "t3", "/", "n", "enter"],
      ["interrupt", "t3", "--json"],
      ["kill", "t3", "--json"],
      ["get", "t3", "--json"],
    ]);
    expect(info).toMatchObject({ address: "t3", status: "idle", labels: { a: "b" }, cwd: "/c" });
  });

  it("refuses a terminal that looks like a flag", async () => {
    const { exec, calls } = fakeHerdr();
    await expect(createHerdrClient({ exec }).send("--force", "x")).rejects.toBeInstanceOf(HerdrError);
    expect(calls).toHaveLength(0);
  });

  it("find reads terminals and skips malformed rows", async () => {
    const { exec } = fakeHerdr({ ls: [ok({ terminals: [{ address: "t1", labels: { r: "x" } }, { nope: 1 }, "str"] })] });
    const found = await createHerdrClient({ exec }).find({ labels: { r: "x" } });
    expect(found.map((t) => t.address)).toEqual(["t1"]);
  });
});

describe("errors", () => {
  it("failure carries the command and redacted stderr, never the sent text", async () => {
    const { exec } = fakeHerdr({ send: [fail("no terminal", "token=sk-abcdefgh12345678 boom")] });
    const err = await createHerdrClient({ exec }).send("t3", "my secret prompt").catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.command).toBe("hc send t3 (text omitted)");
    expect(err.message).not.toContain("my secret prompt");
    expect(err.stderr).not.toContain("sk-abcdefgh12345678");
  });

  it("a missing binary and garbage output are typed errors", async () => {
    const missing = createHerdrClient({ exec: async () => ({ stdout: "", stderr: "", code: null, spawnError: "ENOENT" }) });
    await expect(missing.kill("t1")).rejects.toThrow(/not installed/);
    const garbage = createHerdrClient({ exec: async () => ({ stdout: "<html>", stderr: "", code: 0 }) });
    await expect(garbage.get("t1")).rejects.toBeInstanceOf(HerdrError);
    await expect(garbage.waitIdle("t1", { timeoutMs: 5000 })).rejects.toBeInstanceOf(HerdrError);
  });

  it("the command goes through assertCommandSafe", async () => {
    const { exec, calls } = fakeHerdr();
    await expect(createHerdrClient({ exec, command: "rm -rf /" }).kill("t1")).rejects.toBeInstanceOf(HerdrError);
    expect(calls).toHaveLength(0);
  });
});

describe("self", () => {
  it("outside herdr", async () => {
    const { exec, calls } = fakeHerdr();
    expect(await createHerdrClient({ exec, env: {} }).self()).toEqual({ problem: expect.stringMatching(/HC_TERMINAL_ID/) });
    expect(calls).toHaveLength(0);
  });
  it("reads the space label", async () => {
    const { exec, calls } = fakeHerdr({ get: [ok({ address: "t4", labels: { "herdr.space": "sp9" } })] });
    expect(await createHerdrClient({ exec, env: { HC_TERMINAL_ID: "t4" } }).self()).toEqual({ terminal: "t4", space: "sp9" });
    expect(calls[0].args).toEqual(["get", "t4", "--json"]);
  });
  it("no space label, hc failing", async () => {
    expect(await createHerdrClient({ exec: fakeHerdr({ get: [ok({ address: "t4", labels: {} })] }).exec, env: { HC_TERMINAL_ID: "t4" } }).self()).toEqual({ problem: expect.stringMatching(/herdr\.space/) });
    expect(await createHerdrClient({ exec: fakeHerdr({ get: [fail("gone")] }).exec, env: { HC_TERMINAL_ID: "t4" } }).self()).toEqual({ problem: expect.stringMatching(/gone/) });
    const missing = createHerdrClient({ exec: async () => ({ stdout: "", stderr: "", code: null, spawnError: "ENOENT" }), env: { HC_TERMINAL_ID: "t4" } });
    expect(await missing.self()).toEqual({ problem: expect.stringMatching(/not installed/) });
  });
});

describe("waitIdle", () => {
  it("continues past timeout and message returns, stops on idle", async () => {
    const { exec, calls } = fakeHerdr({ wait: [wait("working", { reason: "timeout", ended: false }), wait("working", { reason: "message" }), wait("idle")] });
    const result = await createHerdrClient({ exec }).waitIdle("t5", { timeoutMs: 600_000 });
    expect(result).toMatchObject({ status: "idle", timedOut: false });
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toEqual(["wait", "t5", "--json", "--timeout", "180"]);
  });

  it.each(["done", "blocked", "error"])("stops on %s", async (status) => {
    const { exec, calls } = fakeHerdr({ wait: [wait(status)] });
    expect((await createHerdrClient({ exec }).waitIdle("t5", { timeoutMs: 60_000 })).status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it("stops when the terminal ended", async () => {
    const { exec } = fakeHerdr({ wait: [wait("working", { exit_code: 1 })] });
    expect(await createHerdrClient({ exec }).waitIdle("t5", { timeoutMs: 60_000 })).toMatchObject({ status: "ended", exitCode: 1 });
    const killed = fakeHerdr({ wait: [wait("working", { signal: 1 })] });
    expect((await createHerdrClient({ exec: killed.exec }).waitIdle("t5", { timeoutMs: 60_000 })).status).toBe("ended");
  });

  it("honours the overall deadline and shrinks the slice", async () => {
    let clock = 0;
    const { exec, calls } = fakeHerdr({
      wait: [
        () => {
          clock += 50_000;
          return wait("working", { reason: "timeout", ended: false });
        },
      ],
    });
    const result = await createHerdrClient({ exec, now: () => clock }).waitIdle("t5", { timeoutMs: 120_000 });
    expect(result).toMatchObject({ status: "timeout", timedOut: true });
    expect(calls.map((c) => c.args[4])).toEqual(["120", "70", "20"]);
  });

  it("an expired deadline makes no call", async () => {
    const { exec, calls } = fakeHerdr();
    expect((await createHerdrClient({ exec }).waitIdle("t5", { timeoutMs: 0 })).timedOut).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("a failed wait is a typed error", async () => {
    const { exec } = fakeHerdr({ wait: [fail('no terminal "t5"')] });
    await expect(createHerdrClient({ exec }).waitIdle("t5", { timeoutMs: 60_000 })).rejects.toBeInstanceOf(HerdrError);
  });
});

describe("slashKeys", () => {
  it("turns text into key names", () => {
    expect(slashKeys("/new")).toEqual(["/", "n", "e", "w", "enter"]);
    expect(slashKeys("/model a/b")).toEqual(["/", "m", "o", "d", "e", "l", "space", "a", "/", "b", "enter"]);
    expect(slashKeys("/x", false)).toEqual(["/", "x"]);
  });
  it("shifts uppercase and throws on characters hc has no name for", () => {
    expect(slashKeys("aB")).toEqual(["a", "shift+b", "enter"]);
    for (const bad of ["a:b", "a_b", "a@b", "a+b", "a(b", "é"]) expect(() => slashKeys(bad)).toThrow(HerdrError);
  });
});

describe("command, untagged env and ifIdle", () => {
  const env = { HC_TERMINAL_ID: "t4", HC_SCOPE: "s", HC_TERMINAL_SOCKET: "/sock", PATH: "/bin", GONE: undefined };

  it("send and command run hc without HC_TERMINAL_ID and HC_SCOPE", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const { exec, calls } = fakeHerdr({ send: [(c) => ({ ...ok({}), stdout: "{}" })] });
    const spy: typeof exec = async (f, a, o) => {
      seen.push(o.env);
      return exec(f, a, o);
    };
    const client = createHerdrClient({ exec: spy, env });
    await client.send("t3", "hello");
    await client.command("t3", "/model a/b");
    expect(seen).toEqual([{ HC_TERMINAL_SOCKET: "/sock", PATH: "/bin" }, { HC_TERMINAL_SOCKET: "/sock", PATH: "/bin" }]);
    expect(calls[1].args).toEqual(["send", "--json", "t3", "--", "/model a/b"]);
  });

  it("other calls keep the caller's environment", async () => {
    let seen: unknown = "unset";
    const client = createHerdrClient({ exec: async (_f, _a, o) => ((seen = o.env), ok({})) as never, env });
    await client.kill("t3");
    expect(seen).toBeUndefined();
  });

  it("ifIdle passes --if idle before the terminal", async () => {
    const { exec, calls } = fakeHerdr();
    const client = createHerdrClient({ exec });
    await client.send("t3", "x", { ifIdle: true });
    await client.command("t3", "/new", { ifIdle: true });
    expect(calls[0].args).toEqual(["send", "--json", "--if", "idle", "t3", "--", "x"]);
    expect(calls[1].args).toEqual(["send", "--json", "--if", "idle", "t3", "--", "/new"]);
  });
});

describe("execFileExec", () => {
  it("a process killed by a signal leaks nothing from its argv", async () => {
    const SENTINEL = "SENTINEL-prompt-text-9f3a";
    // sh stands in for hc: `sh -c 'kill -9 $$' sh <args>` dies by SIGKILL with the pasted text in its argv.
    const killed: typeof execFileExec extends () => infer E ? E : never = (_f, args, o) => execFileExec()("sh", ["-c", "kill -9 $$", "sh", ...args], o);
    const err = await createHerdrClient({ command: "sh", exec: killed }).send("t3", SENTINEL).catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.message).toMatch(/killed or timed out/);
    expect(JSON.stringify({ message: err.message, command: err.command, stderr: err.stderr, stack: err.stack })).not.toContain(SENTINEL);
    const raw = await execFileExec()("sh", ["-c", "kill -9 $$", "sh", SENTINEL], {});
    expect(raw.code).toBeNull();
    expect(raw.spawnError).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain(SENTINEL);
  });

  it("a timed-out wait is reported as killed or timed out", async () => {
    const client = createHerdrClient({ command: "sh", exec: async (f, a, o) => execFileExec()("sh", ["-c", "sleep 5", "sh", ...a], { ...o, timeoutMs: 50 }) });
    await expect(client.kill("t3")).rejects.toThrow(/killed or timed out/);
  });

  it("an unstartable binary is spawnError ENOENT", async () => {
    expect((await execFileExec()("/no/such/hc-binary", [], {})).spawnError).toBe("ENOENT");
  });
});
