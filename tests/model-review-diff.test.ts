import { describe, expect, it } from "vitest";
import type { PlanDocument } from "../src/domain.js";
import type { ChatFn } from "../src/providers/pi-chat.js";
import { MODEL_REVIEW_SYSTEM, omitLockfiles, runModelReview } from "../src/review/model-review.js";

const plan: PlanDocument = { version: 1, createdAt: "2026-10-15T00:00:00.000Z", summary: "Add retry.", risks: [], acceptance: ["retry works"], estimatedUsd: null, groups: [], overlap: [], securitySensitive: false };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 };

const lockBody = ['+    "node_modules/@octokit/auth-token": {', '+      "version": "4.0.0"', "+    },", '-    "node_modules/old": {'].join("\n");
const diff = [
  "diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-export const retry = 1;\n+export const retry = 3;\n",
  `diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,3 +1,5 @@\n${lockBody}\n`,
  "diff --git a/crates/x/Cargo.lock b/crates/x/Cargo.lock\n--- a/crates/x/Cargo.lock\n+++ b/crates/x/Cargo.lock\n@@ -1 +1 @@\n+name = \"x\"\n",
].join("");

describe("model review diff", () => {
  it("replaces lockfile bodies with one placeholder line each", () => {
    const out = omitLockfiles(diff);
    expect(out).toContain("export const retry = 3;");
    expect(out).toContain("# package-lock.json: lockfile changed (+3/-1 lines), not sent for review\n");
    expect(out).toContain("# crates/x/Cargo.lock: lockfile changed (+1/-0 lines), not sent for review\n");
    expect(out).not.toContain("auth-token");
  });

  it("sends the model no lockfile body, the placeholder, and the [REDACTED] note", async () => {
    const seen: string[] = [];
    const chat: ChatFn = async (candidate, request) => {
      seen.push(...request.messages.map((message) => message.content));
      return { text: "[]", usage, provider: candidate.provider, model: candidate.model };
    };
    const review = await runModelReview(chat, [{ provider: "xai", model: "grok-4.7" }], { plan, diff: `${diff}+const token = "abcdef123456789";\n`, maxDiffChars: 100_000 });
    const all = seen.join("\n");
    expect(review.error).toBeUndefined();
    expect(all).not.toContain("auth-token");
    expect(all).not.toContain("node_modules/old");
    expect(all).toContain("# package-lock.json: lockfile changed (+3/-1 lines), not sent for review");
    expect(all).toContain("export const retry = 3;");
    expect(all).toContain("[REDACTED]");
    expect(MODEL_REVIEW_SYSTEM).toContain("`[REDACTED]` marks text removed before review: it is not in the code and must never be reported as a defect.");
  });
});
