import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { edit, inspect, main, type InspectResult } from "../src/cli/chef-config.js";

const TEMPLATE = readFileSync(path.resolve(__dirname, "..", "templates", "chef.yaml"), "utf8");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

describe("chef-config set / unset", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "chef-set-home-"));
    project = mkdtempSync(path.join(tmpdir(), "chef-set-proj-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });
  const userFile = (name = "chef.yaml") => path.join(home, ".pi", "agent", name);
  const projFile = (name = "config.yaml") => path.join(project, ".pi-workflows", name);
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const read = (file: string) => readFileSync(file, "utf8");
  const key = (r: InspectResult, k: string) => r.keys.find((x) => x.key === k)!;
  const set = (file: "user" | "project", k: string, value: string, expect?: string) => edit({ cwd: project, file, key: k, value, ...(expect ? { expect } : {}) });
  const unset = (file: "user" | "project", k: string) => edit({ cwd: project, file, key: k });

  it("creates the user file when missing and sets the key", () => {
    const r = set("user", "budgets.taskUsd", "7");
    expect(r.ok).toBe(true);
    expect(r.edit).toMatchObject({ changed: true, action: "set", file: "user" });
    expect(read(userFile())).toBe("budgets:\n  taskUsd: 7\n");
    expect(key(r, "budgets.taskUsd")).toMatchObject({ user: 7, effective: 7, source: "user" });
  });

  it("creates the project file when missing", () => {
    const r = set("project", "branchPrefix", "team");
    expect(r.ok).toBe(true);
    expect(read(projFile())).toBe("branchPrefix: team\n");
    expect(key(r, "branchPrefix")).toMatchObject({ project: "team", source: "project" });
  });

  it("keeps comments and layout outside the edited line byte for byte", () => {
    const before = "## my notes\n\n# keep this\nbranchPrefix: me   # trailing\n\nbudgets:\n  # why 7\n  taskUsd: 7   # task cap\n  dailyUsd: 50\n\n# end\n";
    put(userFile(), before);
    expect(set("user", "budgets.taskUsd", "9").ok).toBe(true);
    expect(read(userFile())).toBe(before.replace("taskUsd: 7 ", "taskUsd: 9 "));
  });

  it("adds a new key to an existing section and a new section, leaving the rest alone", () => {
    const before = "# top\nbudgets:\n  taskUsd: 7   # cap\n";
    put(userFile(), before);
    expect(set("user", "budgets.dailyUsd", "30").ok).toBe(true);
    expect(read(userFile())).toBe("# top\nbudgets:\n  taskUsd: 7   # cap\n  dailyUsd: 30\n");
    expect(set("user", "advisors.plan", "false").ok).toBe(true);
    expect(read(userFile())).toBe("# top\nbudgets:\n  taskUsd: 7   # cap\n  dailyUsd: 30\nadvisors:\n  plan: false\n");
  });

  it("a file that is all comments keeps them", () => {
    put(userFile(), "# only a note\n");
    expect(set("user", "branchPrefix", "x").ok).toBe(true);
    expect(read(userFile())).toBe("# only a note\nbranchPrefix: x\n");
  });

  describe("with the real sample config", () => {
    beforeEach(() => put(userFile(), TEMPLATE));

    it("uncomments a template key and its header in place, keeping the note", () => {
      const r = set("user", "budgets.taskUsd", "7");
      expect(r.ok).toBe(true);
      const after = read(userFile());
      expect(after).toContain("budgets:\n  taskUsd: 7              # one task's spend\n");
      expect(after).toContain("#   dailyUsd: 75            # all spend today");
      // Only the header and the key line changed.
      const a = TEMPLATE.split("\n");
      const b = after.split("\n");
      expect(b.length).toBe(a.length);
      expect(b.filter((line, i) => line !== a[i])).toEqual(["budgets:", "  taskUsd: 7              # one task's spend"]);
      expect(key(r, "budgets.taskUsd")).toMatchObject({ user: 7, effective: 7 });
    });

    it("on unset puts the sample's own line and header back: the file is the sample again", () => {
      set("user", "budgets.taskUsd", "7");
      const r = unset("user", "budgets.taskUsd");
      expect(r.ok).toBe(true);
      expect(read(userFile())).toBe(TEMPLATE);
      expect(key(r, "budgets.taskUsd")).toMatchObject({ effective: 20, source: "default" });
    });

    it("keeps the section header live while another key under it is set", () => {
      set("user", "budgets.taskUsd", "7");
      set("user", "budgets.dailyUsd", "30");
      unset("user", "budgets.taskUsd");
      const after = read(userFile());
      expect(after).toContain("budgets:\n#   taskUsd: 20             # one task's spend\n  dailyUsd: 30            # all spend today");
      unset("user", "budgets.dailyUsd");
      expect(read(userFile())).toBe(TEMPLATE);
    });

    // A section opened twice ("Map keys must be unique") was the failure here: both orders, both sections.
    it.each([
      ["localMode.difficulties", "[low]", "localMode.default", "true"],
      ["providers.foundry.routeStyle", "v1", "providers.foundry.endpoint", "https://x.services.ai.azure.com"],
    ])("two keys under one commented sample section (%s, %s): one header, either order", (k1, v1, k2, v2) => {
      for (const order of [[[k1, v1], [k2, v2]], [[k2, v2], [k1, v1]]] as const) {
        put(userFile(), TEMPLATE);
        for (const [k, v] of order) expect(set("user", k, v).ok, `${k} ${v}`).toBe(true);
        const after = read(userFile());
        const top = k1.split(".")[0]!;
        expect(after.split("\n").filter((l) => l === `${top}:`)).toHaveLength(1);
        const r = inspect(project);
        expect(r.errors).toEqual([]);
        expect(r.user.parsed).toBeDefined();
        // Both values are live in the parsed file.
        expect(key(r, k1).user).toEqual(parse(v1));
        expect(key(r, k2).user).toEqual(parse(v2));
        expect(set("user", k1, parse(v1) === true ? "false" : v1).edit?.reflowed).toBeUndefined();
        // Unsetting both gives the sample back (each header returns to its comment).
        expect(unset("user", k1).ok).toBe(true);
        expect(unset("user", k2).ok).toBe(true);
        expect(read(userFile()).split("\n").filter((l) => l === `${top}:`)).toHaveLength(0);
      }
    });

    it.each([
      [["endpoint", "routeStyle"], ["endpoint", "routeStyle"]],
      [["endpoint", "routeStyle"], ["routeStyle", "endpoint"]],
      [["routeStyle", "endpoint"], ["endpoint", "routeStyle"]],
      [["routeStyle", "endpoint"], ["routeStyle", "endpoint"]],
    ])("two keys under providers.foundry (sets %j, unsets %j) round-trip to the sample byte for byte", (sets, unsets) => {
      const v: Record<string, string> = { endpoint: "https://x.services.ai.azure.com", routeStyle: "v1" };
      for (const k of sets) expect(set("user", `providers.foundry.${k}`, v[k]!).ok, k).toBe(true);
      for (const k of unsets) {
        const r = unset("user", `providers.foundry.${k}`);
        expect(r.ok, k).toBe(true);
        expect(r.edit?.reflowed, k).toBeUndefined();
      }
      expect(read(userFile())).toBe(TEMPLATE);
    });

    it("sets a top-level template key and a list", () => {
      expect(set("user", "branchPrefix", "me").ok).toBe(true);
      expect(read(userFile())).toMatch(/\nbranchPrefix: me {14}# \/build names/);
      const r = set("user", "routing.requirePremiumReviewFor", "[auth, secrets]");
      expect(r.ok).toBe(true);
      const after = read(userFile());
      expect(after).toContain("routing:\n");
      expect(after).toContain("  requirePremiumReviewFor: [auth, secrets]  # reviewed on premium");
      expect(after).not.toContain("#     - permissions");
      expect(key(r, "routing.requirePremiumReviewFor").user).toEqual(["auth", "secrets"]);
    });

    it("an enum set through a template line", () => {
      const r = set("user", "session.compactionTier", "standard");
      expect(r.ok).toBe(true);
      expect(read(userFile())).toContain("session:\n");
      expect(key(r, "session.compactionTier")).toMatchObject({ user: "standard", effective: "standard" });
    });
  });

  it("unset of a key that is not from the sample deletes it and the section it empties", () => {
    put(userFile(), "# keep\nbranchPrefix: me\nproviders:\n  foundry:\n    routeStyle: v1   # x\n");
    const r = unset("user", "providers.foundry.routeStyle");
    expect(r.ok).toBe(true);
    expect(read(userFile())).toBe("# keep\nbranchPrefix: me\n");
    // A hand-written line (no sample note) is deleted even for a sample key, never left as a comment.
    unset("user", "branchPrefix");
    expect(read(userFile())).toBe("# keep\n");
  });

  it("unset of a sample key in the project file deletes it: sample lines are only for the user file", () => {
    put(projFile(), "# mine\nbranchPrefix: team\nbudgets:\n  taskUsd: 5   # my cap\n");
    expect(unset("project", "budgets.taskUsd").ok).toBe(true);
    expect(read(projFile())).toBe("# mine\nbranchPrefix: team\n");
    expect(unset("project", "branchPrefix").ok).toBe(true);
    expect(read(projFile())).toBe("# mine\n");
  });

  it("a rule that spans both files rolls the write back (proprietaryCode needs an allowlist)", () => {
    put(userFile(), "branchPrefix: me\n");
    const r = set("user", "proprietaryCode", "true");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/orgProviderAllowlist/);
    expect(read(userFile())).toBe("branchPrefix: me\n");
    // Removing the allowlist while proprietaryCode is on is refused the same way.
    put(userFile(), "proprietaryCode: true\norgProviderAllowlist: [anthropic]\n");
    const u = unset("user", "orgProviderAllowlist");
    expect(u.ok).toBe(false);
    expect(read(userFile())).toBe("proprietaryCode: true\norgProviderAllowlist: [anthropic]\n");
    // A file that did not exist is removed again.
    put(userFile(), "branchPrefix: me\n");
    const p = set("project", "proprietaryCode", "true");
    expect(p.ok).toBe(false);
    expect(existsSync(projFile())).toBe(false);
    // An error that was there before the edit does not block an unrelated edit.
    put(userFile(), "proprietaryCode: true\n");
    expect(set("user", "branchPrefix", "x").ok).toBe(true);
  });

  it("unset of a key that is absent writes nothing", () => {
    put(userFile(), "branchPrefix: me\n");
    const r = unset("user", "budgets.taskUsd");
    expect(r.ok).toBe(true);
    expect(r.edit?.changed).toBe(false);
    expect(read(userFile())).toBe("branchPrefix: me\n");
  });

  describe("refusals (nothing is written)", () => {
    it("a secret value", () => {
      put(userFile(), "branchPrefix: me\n");
      const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
      const r = set("user", "branchPrefix", secret);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/secret/);
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(read(userFile())).toBe("branchPrefix: me\n");
    });

    it("budgets.taskUsd 0 and a negative number", () => {
      for (const v of ["0", "-3", "abc", "true"]) {
        const r = set("user", "budgets.taskUsd", v);
        expect(r.ok, v).toBe(false);
        expect(r.error, v).toMatch(/budgets\.taskUsd/);
      }
      expect(existsSync(userFile())).toBe(false);
    });

    it("an enum outside its values, a wrong type, an unknown key, a fixed key", () => {
      expect(set("user", "session.compactionTier", "ultra").error).toMatch(/must be one of/);
      expect(set("user", "advisors.plan", "maybe").error).toMatch(/true or false/);
      expect(set("user", "advisors.maxPlanConsults", "1.5").error).toMatch(/whole number/);
      expect(set("user", "nonsense.key", "1").error).toMatch(/not a setting/);
      expect(set("user", "approvals.merge", "auto").ok).toBe(false);
      expect(set("user", "branchPrefix", "").error).toMatch(/needs a value|non-empty/);
      expect(set("user", "branchPrefix", "{a: ").error).toMatch(/not valid YAML/);
      expect(set("user", "tiers.premium", "[]").ok).toBe(false);
      expect(existsSync(userFile())).toBe(false);
    });

    it("a stale --expect", () => {
      put(userFile(), "branchPrefix: me\n");
      const stale = sha("branchPrefix: other\n");
      const r = set("user", "branchPrefix", "you", stale);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/changed since/);
      expect(read(userFile())).toBe("branchPrefix: me\n");
      expect(set("user", "branchPrefix", "you", sha("branchPrefix: me\n")).ok).toBe(true);
      expect(read(userFile())).toBe("branchPrefix: you\n");
    });

    it("--expect works for a missing file (hash of the empty text)", () => {
      expect(set("user", "branchPrefix", "a", sha("")).ok).toBe(true);
      expect(set("project", "branchPrefix", "a", sha("x")).ok).toBe(false);
    });

    it("the view carries the hash to pass back", () => {
      put(userFile(), "branchPrefix: me\n");
      const r = set("user", "advisors.plan", "false");
      expect(r.user.sha256).toBe(sha(read(userFile())));
      expect(r.project.sha256).toBe(sha(""));
    });

    it("user-only and fixed keys in the project file", () => {
      for (const k of ["workspaceDir", "isolation.worktree", "session.model", "routing.reviewTier", "approvals.merge", "providers.foundry.endpoint"]) {
        const value = k === "isolation.worktree" ? "false" : k === "providers.foundry.endpoint" ? "https://x.services.ai.azure.com" : k === "approvals.merge" ? "manual" : k === "session.model" ? "openai/gpt-6.1-sol" : k === "routing.reviewTier" ? "premium" : ".x";
        if (k === "providers.foundry.endpoint") put(userFile(), "providers:\n  foundry:\n    audience: https://ai.azure.com\n");
        const r = set("project", k, value);
        expect(r.ok, k).toBe(false);
        expect(r.error, k).toMatch(/user-only|fixed/);
      }
      expect(existsSync(projFile())).toBe(false);
    });

    it("a provider location field in the project file when the user has no block for it", () => {
      const r = set("project", "providers.vercel.envFile", ".env.local");
      expect(r.ok).toBe(true);
      expect(key(r, "providers.vercel.envFile")).toMatchObject({ project: ".env.local", source: "project" });
    });

    it("a result the loader would reject, and an unreadable file", () => {
      put(userFile(), "proprietaryCode: true\norgProviderAllowlist: [anthropic]\n");
      const r = set("user", "budgets.dailyUsd", "0");
      expect(r.ok).toBe(false);
      put(projFile(), "budgets: [unclosed\n");
      const bad = set("project", "branchPrefix", "x");
      expect(bad.ok).toBe(false);
      expect(read(projFile())).toBe("budgets: [unclosed\n");
    });
  });

  it("raising a lower-wins key in the user file while the project is lower: written, effective stays the project's", () => {
    put(userFile(), "budgets:\n  taskUsd: 7\n");
    put(projFile(), "budgets:\n  taskUsd: 5\n");
    const r = set("user", "budgets.taskUsd", "30");
    expect(r.ok).toBe(true);
    expect(read(userFile())).toBe("budgets:\n  taskUsd: 30\n");
    expect(key(r, "budgets.taskUsd")).toMatchObject({ user: 30, project: 5, effective: 5, source: "project" });
  });

  it("edits the .yml and legacy names the loader reads", () => {
    put(userFile("chef.yml"), "branchPrefix: a\n");
    put(projFile("config.yml"), "branchPrefix: b\n");
    set("user", "branchPrefix", "c");
    set("project", "branchPrefix", "d");
    expect(read(userFile("chef.yml"))).toBe("branchPrefix: c\n");
    expect(read(projFile("config.yml"))).toBe("branchPrefix: d\n");
    expect(existsSync(userFile("chef.yaml"))).toBe(false);
    expect(existsSync(projFile("config.yaml"))).toBe(false);
  });

  it("edits the legacy cost-workflow.yaml when it is the only user file", () => {
    put(userFile("cost-workflow.yaml"), "branchPrefix: a\n");
    set("user", "branchPrefix", "z");
    expect(read(userFile("cost-workflow.yaml"))).toBe("branchPrefix: z\n");
    expect(existsSync(userFile("chef.yaml"))).toBe(false);
  });

  it("the loader's lenient path decides: a file with a dropped tier or session section still accepts an edit", () => {
    const before = "tiers:\n  bogus: []\nsession:\n  pin: maybe\nbudgets:\n  taskUsd: 7\n";
    put(userFile(), before);
    // The loader only drops those sections with a warning; the whole file is not rejected.
    const r = set("user", "budgets.taskUsd", "9");
    expect(r.ok, r.error).toBe(true);
    expect(read(userFile())).toBe(before.replace("taskUsd: 7", "taskUsd: 9"));
  });

  it("an edit that leaves the key not equal to the value, or removes another key, is never written", () => {
    // A column-0 comment inside a block: the line editor cannot be sure of the block, so the result is checked.
    const before = "budgets:\n  taskUsd: 7\n# a note\n  dailyUsd: 50\n";
    put(userFile(), before);
    const r = unset("user", "budgets.taskUsd");
    expect(r.ok, r.error).toBe(true);
    expect(parse(read(userFile()))).toEqual({ budgets: { dailyUsd: 50 } });
    expect(read(userFile())).toContain("# a note");
  });

  it("keeps CRLF line endings, including on added lines", () => {
    put(userFile(), "# top\r\nbudgets:\r\n  taskUsd: 7   # cap\r\n");
    expect(set("user", "budgets.taskUsd", "9").ok).toBe(true);
    expect(read(userFile())).toBe("# top\r\nbudgets:\r\n  taskUsd: 9   # cap\r\n");
    expect(set("user", "budgets.dailyUsd", "30").ok).toBe(true);
    expect(set("user", "advisors.plan", "false").ok).toBe(true);
    const after = read(userFile());
    expect(after).toBe("# top\r\nbudgets:\r\n  taskUsd: 9   # cap\r\n  dailyUsd: 30\r\nadvisors:\r\n  plan: false\r\n");
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(unset("user", "advisors.plan").ok).toBe(true);
    expect(read(userFile())).toBe("# top\r\nbudgets:\r\n  taskUsd: 9   # cap\r\n  dailyUsd: 30\r\n");
  });

  it("a 4-space file falls back to the Document API, says so, and keeps its indentation", () => {
    put(userFile(), "budgets:\n    taskUsd: 7   # cap\n    dailyUsd: 50\n");
    const r = set("user", "budgets.taskUsd", "9");
    expect(r.ok, r.error).toBe(true);
    expect(r.edit).toMatchObject({ changed: true, reflowed: true });
    expect(parse(read(userFile()))).toEqual({ budgets: { taskUsd: 9, dailyUsd: 50 } });
    expect(read(userFile())).toContain("    taskUsd: 9");
    expect(read(userFile())).toContain("# cap");
  });

  it("line edits do not set reflowed", () => {
    put(userFile(), "budgets:\n  taskUsd: 7\n");
    expect(set("user", "budgets.taskUsd", "9").edit?.reflowed).toBeUndefined();
  });

  describe("main", () => {
    const run = (argv: string[]) => {
      let out = "";
      let err = "";
      const code = main(argv, (t) => (out += t), (t) => (err += t));
      return { code, out, err };
    };

    it("set and unset print the new inspect JSON and exit 0", () => {
      const a = run(["set", "--cwd", project, "--file", "project", "--key", "budgets.taskUsd", "--value", "4"]);
      expect(a.code).toBe(0);
      expect(JSON.parse(a.out)).toMatchObject({ ok: true, edit: { action: "set", changed: true } });
      expect(read(projFile())).toBe("budgets:\n  taskUsd: 4\n");
      const b = run(["unset", "--cwd", project, "--file", "project", "--key", "budgets.taskUsd"]);
      expect(b.code).toBe(0);
      expect(JSON.parse(b.out).ok).toBe(true);
    });

    it("a refused edit is ok:false with exit 0", () => {
      const r = run(["set", "--cwd", project, "--file", "user", "--key", "budgets.taskUsd", "--value", "0"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ ok: false });
    });

    it("a negative number is a value, not a flag", () => {
      const r = run(["set", "--cwd", project, "--file", "user", "--key", "budgets.taskUsd", "--value", "-1"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).error).toMatch(/greater than 0/);
    });

    it("usage errors exit 2 with no stdout", () => {
      const cases = [
        ["set"],
        ["set", "--cwd", project],
        ["set", "--cwd", project, "--file", "both", "--key", "a", "--value", "1"],
        ["set", "--cwd", project, "--file", "user", "--value", "1"],
        ["set", "--cwd", project, "--file", "user", "--key", "branchPrefix"],
        ["unset", "--cwd", project, "--file", "user", "--key", "branchPrefix", "--value", "1"],
        ["unset", "--cwd", project, "--file", "user", "--key", "branchPrefix", "--expect"],
      ];
      for (const argv of cases) {
        const r = run(argv);
        expect(r.code, argv.join(" ")).toBe(2);
        expect(r.out).toBe("");
        expect(r.err).not.toBe("");
      }
    });
  });
});
