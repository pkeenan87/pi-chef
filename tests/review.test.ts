import { describe, expect, it } from "vitest";
import { reviewDiff } from "../src/review/review.js";

async function review(diff: string, checks: { name: string; command: string; args: string[] }[] = [], run?: (c: string, a: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  return reviewDiff({
    diffs: [{ groupId: "g", diff }],
    integratedDiff: "",
    checks,
    cwd: "/tmp",
    allowlist: ["npm test", "npm run lint", "npm run build"],
    planAcceptance: [],
    runner: { run: async (c, a) => (run ? run(c, a) : { code: 0, stdout: "", stderr: "" }) },
  });
}
const categories = async (diff: string) => (await review(diff)).findings.filter((f) => f.severity === "blocking").map((f) => f.category);

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
