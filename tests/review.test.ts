import { describe, expect, it } from "vitest";
import { reviewDiff } from "../src/review/review.js";

async function review(diff: string, checks: { name: string; command: string; args: string[] }[] = [], run?: (c: string, a: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  return reviewDiff({
    diff,
    checks,
    cwd: "/tmp",
    planAcceptance: [],
    runner: { run: async (c, a) => (run ? run(c, a) : { code: 0, stdout: "", stderr: "" }) },
  });
}
describe("review summary", () => {
  it("says a review without checks cannot pass and how to fix it", async () => {
    const report = await review("+const x = 1;\n");
    expect(report.passed).toBe(false);
    expect(report.summary).toContain("no checks ran");
    expect(report.summary).toContain("checks:");
    expect(report.summary).not.toMatch(/0 blocking finding/);
  });

  it("names the blocking findings and the failed check", async () => {
    const report = await review("+const x = 1;\n", [{ name: "unit", command: "npm", args: ["test"] }], async () => ({ code: 1, stdout: "", stderr: "2 failing" }));
    expect(report.passed).toBe(false);
    expect(report.summary).toContain("1 blocking finding(s): unit failed.");
  });
});

const categories = async (line: string) => (await review(`+${line}\n`)).findings.filter((f) => f.severity === "blocking").map((f) => f.category);

describe("review heuristics", () => {
  it.each([
    "const task-runner = 1; // risk-assessment disk-usage",
    "const password = process.env.PASSWORD;",
    "apiKey: string;",
    "const password: string = input;",
    "model.eval(x)",
    "const retrieval(x)",
    "see AKIA docs",
  ])("does not flag %s", async (line) => {
    expect(await categories(line)).toEqual([]);
  });

  it.each([
    ['const key = "sk-abcdefghijklmnopqrstuvwxyz";', "secrets"],
    ['password = "hunter2hunter2"', "secrets"],
    ["AKIAABCDEFGHIJKLMNOP", "secrets"],
    ["-----BEGIN RSA PRIVATE KEY-----", "secrets"],
    ["eval(userInput)", "security"],
    ["verify: false", "auth"],
  ])("flags %s", async (line, category) => {
    expect(await categories(line)).toContain(category);
  });

  it("scans only the lines a diff adds", async () => {
    const diff = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,2 @@", "-eval(input)", '-const password = "hunter2hunter2";', " // verify: false", "+const ok = 1;"].join("\n");
    expect((await review(diff)).findings.filter((f) => f.severity === "blocking")).toEqual([]);
  });

  it("runs checks concurrently but reports them in order", async () => {
    let active = 0;
    let max = 0;
    const checks = [
      { name: "one", command: "npm", args: ["test"] },
      { name: "two", command: "npm", args: ["run", "lint"] },
      { name: "bad", command: "rm", args: ["-rf", "/"] },
      { name: "three", command: "npm", args: ["run", "build"] },
    ];
    const report = await review("x", checks, async (_c, args) => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, args[0] === "test" ? 40 : 5));
      active -= 1;
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(max).toBeGreaterThan(1);
    expect(report.checks.map((c) => c.name)).toEqual(["one", "two", "bad", "three"]);
    expect(report.checks[2]?.ran).toBe(false);
    expect(report.passed).toBe(false);
  });
});
