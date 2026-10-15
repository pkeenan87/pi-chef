import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setBillingResolver } from "../src/config.js";
import { summarize, unpricedModels } from "../src/cost/ledger.js";
import { WorkflowError, type CostRecord, type PlanDocument, type TaskState, type Ticket } from "../src/domain.js";
import { GitWorkspace } from "../src/git/worktrees.js";
import { forNewPlan } from "../src/orchestrator/plan.js";
import { blank } from "../src/orchestrator/planning.js";
import { TICKET_RULES } from "../src/orchestrator/prompts.js";
import { validateTickets } from "../src/orchestrator/tickets.js";
import type { DecisionsClient } from "../src/providers/clients.js";
import { readyAuth, singleTaskRequest, tasksRequest, tempRepo, tieredConfig, workflow } from "./helpers.js";

const ticket = (id: string, slug: string, extra: Partial<Ticket> = {}): Ticket => ({ id, slug, title: `T${id}`, whatToBuild: "x", acceptanceCriteria: ["works"], blockedBy: [], estimatedContextTokens: 30_000, ...extra });
const ALLOW = ["npm test", "npm run typecheck", "npx vitest run *"];

describe("ticket checks at plan time", () => {
  const options = { target: 150_000, fileSize: () => undefined, allowlist: ALLOW };

  it("rejects a check that is not an allowlisted command line and says what to do instead", () => {
    const result = validateTickets([ticket("01", "a", { checks: ["Validate all BDK APIs against the current docs."] })], options);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Ticket 01: check "Validate all BDK APIs against the current docs." cannot run');
    expect(result.errors[0]).toContain("npm test, npm run typecheck, npx vitest run *");
    expect(result.errors[0]).toContain("implementation instead");
  });

  it("accepts allowlisted commands, including wildcard extras, and rejects unsafe extras", () => {
    expect(validateTickets([ticket("01", "a", { checks: ["npm test", "npx vitest run tests/a.test.ts"] })], options).errors).toEqual([]);
    expect(validateTickets([ticket("01", "a", { checks: ["npx vitest run --config evil.ts"] })], options).errors[0]).toContain("cannot run");
  });

  it("skips the command check when no allowlist is given (callers that only parse)", () => {
    expect(validateTickets([ticket("01", "a", { checks: ["anything goes"] })], { target: 150_000, fileSize: () => undefined }).errors).toEqual([]);
  });

  it("tells the planner that checks are allowlisted commands", () => {
    const rules = TICKET_RULES(150_000, ALLOW);
    expect(rules).toContain("shell command lines");
    expect(rules).toContain("npm test, npm run typecheck, npx vitest run *");
    expect(TICKET_RULES(150_000, [])).toContain("leave checks empty");
  });

  it("rejects prose checks through the workflow with the project's allowlist", async () => {
    const app = workflow(await tempRepo(), { config: tieredConfig("commandAllowlist: ['npm test']") });
    const check = app.checkTickets([ticket("01", "a", { checks: ["Run the smoke test by hand."] })]);
    expect(check.errors[0]).toContain("cannot run");
    expect(app.checkTickets([ticket("01", "a", { checks: ["npm test"] })]).errors).toEqual([]);
  });
});

describe("state carried into a new plan version", () => {
  const draft = (tickets: Ticket[]): PlanDocument => ({
    version: 2,
    createdAt: "2026-10-15T00:00:00.000Z",
    summary: "s",
    risks: [],
    acceptance: [],
    estimatedUsd: null,
    groups: tickets.map((item) => ({ id: `${item.id}-${item.slug}`, summary: item.title, files: [], dependsOn: [], edits: [] })),
    overlap: [],
    securitySensitive: false,
    tickets,
  });
  const record = (groupId: string) => ({ groupId, branch: `cost/t/${groupId}`, path: `/w/${groupId}`, baseSha: "base", headSha: "head" });

  it("drops runs and marks worktrees of groups the new plan no longer has, keeps the rest, and restarts attempts", () => {
    const task: TaskState = {
      ...blank("t", "req", "2026-10-15T00:00:00.000Z"),
      plan: draft([ticket("01", "old-slug"), ticket("02", "same")]),
      worktrees: [record("01-old-slug"), record("02-same")],
      ticketRuns: { "01": { status: "done", attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false }, "02": { status: "done", attempts: 1, turns: 1, tokens: 1, costUsd: 0, maxContextTokens: 1, crossedTarget: false } },
      attempts: [{ tier: "cheap", provider: "openai", model: "m", outcome: "failure", at: "2026-10-15T00:00:00.000Z" }],
      integration: { branch: "cost/t/integration", sha: "abc", path: "/w/integration" },
    };
    const next = forNewPlan(task, draft([ticket("01", "new-slug"), ticket("02", "same")]));
    expect(next.attempts).toEqual([]);
    expect(next.integration).toBeUndefined();
    expect(next.worktrees.map((item) => [item.groupId, item.abandoned ?? false])).toEqual([["01-old-slug", true], ["02-same", false]]);
    // The stale "done" for ticket 01 is gone, so the new 01 runs; 02 stays done.
    expect(Object.keys(next.ticketRuns ?? {})).toEqual(["02"]);
  });

  it("un-abandons a worktree whose group returns in a later version", () => {
    const task: TaskState = { ...blank("t", "req", "2026-10-15T00:00:00.000Z"), plan: draft([ticket("01", "a")]), worktrees: [{ ...record("01-a"), abandoned: true }] };
    expect(forNewPlan(task, draft([ticket("01", "a")])).worktrees[0]!.abandoned).toBeUndefined();
  });

  it("abandons dropped groups on a re-plan, lists orphans, cleans both up without confirmation, and integrates only live branches", async () => {
    const cwd = await tempRepo();
    const app = workflow(cwd);
    expect((await app.plan(tasksRequest)).ok).toBe(true);
    expect((await app.approvePlan()).ok).toBe(true);
    expect((await app.implement()).ok).toBe(true);
    const taskId = app.activeTaskId()!;
    const before = app.store.load(taskId)!;
    expect(before.worktrees.map((item) => item.groupId).sort()).toEqual(["alert", "ingest"]);
    expect(before.attempts.length).toBeGreaterThan(0);
    // A worktree no state records, as an earlier plan version or a crash leaves behind.
    const git = new GitWorkspace(cwd);
    const orphanDir = path.join(app.store.root, "worktrees", taskId, "orphan-x");
    await git.createWorktree({ dir: orphanDir, branch: `cost/${taskId}/orphan-x`, baseSha: await git.head() });
    // Re-plan with only the ingest group: alert is abandoned, attempts restart.
    expect((await app.plan(singleTaskRequest)).ok).toBe(true);
    const after = app.store.load(taskId)!;
    expect(after.attempts).toEqual([]);
    expect(after.worktrees.find((item) => item.groupId === "alert")?.abandoned).toBe(true);
    expect(after.worktrees.find((item) => item.groupId === "ingest")?.abandoned).toBeUndefined();
    const status = await app.worktrees("status");
    expect(status.text).toContain("alert cost/");
    expect(status.text).toContain("abandoned");
    expect(status.text).toContain("orphan orphan-x");
    const cleanup = await app.worktrees("cleanup");
    expect(cleanup.ok, cleanup.text).toBe(true);
    expect(cleanup.text).toContain("alert");
    expect(cleanup.text).toContain("orphan orphan-x");
    expect(existsSync(orphanDir)).toBe(false);
    expect(app.store.load(taskId)!.worktrees.map((item) => item.groupId)).toEqual(["ingest"]);
    // The next run rebuilds the integration branch from the base with the live branch only.
    expect((await app.approvePlan()).ok).toBe(true);
    const again = await app.implement();
    expect(again.ok, again.text).toBe(true);
    const log = await git.git(["log", "--format=%s", `cost/${taskId}/integration`]);
    expect(log.stdout).toContain("Integrate cost/");
    expect(log.stdout).not.toContain("alert");
  });
});

describe("phantom spend", () => {
  afterEach(() => setBillingResolver(undefined));
  const pricing = [
    { provider: "anthropic", model: "cheap", effectiveFrom: "2026-01-01", inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
    { provider: "anthropic", model: "cheap", billing: "api-key" as const, effectiveFrom: "2026-01-01", inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  ];
  const unknown: CostRecord = { id: "1", at: "2026-10-15T10:00:00.000Z", taskId: "t", phase: "IDLE", provider: "anthropic", model: "other", tier: "interactive", requests: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: null, actualUsd: null, usageKnown: false, outcome: "unknown", retries: 0, reason: "observed assistant usage" };

  it("estimates an unpriced subscription model from subscription rows only, and api-key rows while on a key", () => {
    expect(summarize([unknown], { pricing }).estimatedUnknownUsd).toBe(0);
    setBillingResolver(() => "api-key");
    expect(summarize([unknown], { pricing }).estimatedUnknownUsd).toBe(10);
  });

  it("names the models in the ledger that have no pricing row", () => {
    const priced: CostRecord = { ...unknown, id: "2", model: "cheap" };
    expect(unpricedModels([priced, unknown, unknown], pricing)).toEqual(["anthropic/other"]);
  });

  it("ledgers a git failure before any model call as a known zero with no strike against the model", async () => {
    const cwd = await tempRepo();
    const git = new GitWorkspace(cwd);
    git.createWorktree = async () => {
      throw new WorkflowError("GIT", "fatal: not a git repository");
    };
    const app = workflow(cwd, { git });
    await app.plan(singleTaskRequest);
    await app.approvePlan();
    const result = await app.implement();
    expect(result.ok).toBe(false);
    const record = app.store.readLedger().find((item) => item.reason.includes("not a git repository"));
    expect(record).toMatchObject({ actualUsd: 0, usageKnown: true, outcome: "failure" });
    expect(JSON.stringify(app.store.readMetrics())).not.toContain('"failure"');
  });

  it("never sends a classifier call to a provider that is not signed in", async () => {
    const log: string[] = [];
    const client = (id: "foundry" | "vercel"): DecisionsClient => ({
      id,
      async decide(request) {
        log.push(`${id}:${request.model}`);
        throw new Error("az account show failed");
      },
    });
    const app = workflow(await tempRepo(), { config: tieredConfig(), auth: readyAuth("missing"), deciders: { foundry: client("foundry"), vercel: client("vercel") } });
    const result = await app.route("add a feature");
    expect(result.ok).toBe(true);
    expect(log).toEqual([]);
    expect(app.store.readLedger().filter((item) => item.tier === "classifier")).toEqual([]);
    expect(app.store.readMetrics().classification).toBeUndefined();
  });
});
