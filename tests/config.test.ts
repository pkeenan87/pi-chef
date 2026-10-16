import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  estimateUsd,
  fromMicroUsd,
  loadConfig,
  parseConfig,
  priceFor,
  toMicroUsd,
  type PricingRow,
} from "../src/config.js";

const PROVIDERS_BLOCK = `
providers:
  openai: { type: openai, auth: account-login, model: gpt-5.4 }
  anthropic: { type: anthropic, auth: account-login, model: claude-sonnet }
  foundry:
    type: azure-foundry
    auth: azure-cli
    deployments: { classifier: c, reasoning: r, cheap: c }
  local: { type: openai-compatible, baseUrl: "http://127.0.0.1:1/v1", model: m }
`;

describe("parseConfig validation", () => {
  it.each([
    ["routing:\n  minConfidence: 1.5\n", /routing\.minConfidence/],
    ["routing:\n  minConfidence: -0.1\n", /routing\.minConfidence/],
    ["routing:\n  maxEscalations: -1\n", /routing\.maxEscalations/],
    ["routing:\n  maxEscalations: 1.5\n", /routing\.maxEscalations/],
    ["routing:\n  maxTier: ultra\n", /routing\.maxTier/],
    ["budgets:\n  taskUsd: 0\n", /budgets\.taskUsd/],
    ["budgets:\n  dailyUsd: -5\n", /budgets\.dailyUsd/],
    ["budgets:\n  softWarningRatio: 2\n", /budgets\.softWarningRatio/],
    ["budgets:\n  unknownCallUsd: -0.01\n", /budgets\.unknownCallUsd/],
    ["models:\n  cheap: nowhere\n", /models\.cheap/],
    ["pricing:\n  - { provider: local, model: m, effectiveFrom: '2026-01-01', inputPerMillionUsd: -1, outputPerMillionUsd: 1 }\n", /inputPerMillionUsd/],
    ["pricing:\n  - { provider: local, model: m, effectiveFrom: 'soon', inputPerMillionUsd: 1, outputPerMillionUsd: 1 }\n", /effectiveFrom/],
    ["pricing:\n  - { provider: local, model: m, effectiveFrom: '2026-02-30', inputPerMillionUsd: 1, outputPerMillionUsd: 1 }\n", /effectiveFrom/],
    ["orgProviderAllowlist: [mars]\n", /orgProviderAllowlist/],
  ])("rejects %j", (yaml, message) => {
    expect(() => parseConfig(yaml)).toThrow(message);
  });

  it("rejects duplicate pricing rows", () => {
    const row = "  - { provider: local, model: m, effectiveFrom: '2026-01-01', inputPerMillionUsd: 1, outputPerMillionUsd: 1 }\n";
    expect(() => parseConfig(`pricing:\n${row}${row}`)).toThrow(/duplicates/);
  });

  it("rejects a tier whose provider is missing or has no model name", () => {
    expect(() => parseConfig(`${PROVIDERS_BLOCK.replace("model: gpt-5.4", "")}\nmodels: { classifier: local, cheap: foundry, standard: anthropic, premium: openai }\n`)).toThrow(/providers\.openai\.model/);
    expect(() => parseConfig("providers:\n  local: { type: x, model: m }\nmodels: { classifier: local, cheap: foundry, standard: local, premium: local }\n")).toThrow(/models\.cheap/);
  });

  it("accepts valid boundaries and normalizes dates", () => {
    const config = parseConfig(`${PROVIDERS_BLOCK}
models: { classifier: local, cheap: foundry, standard: anthropic, premium: openai }
routing: { minConfidence: 0, maxEscalations: 0, maxTier: standard }
budgets: { softWarningRatio: 1 }
workers: { tokenBudget: 1 }
pricing:
  - { provider: local, model: m, effectiveFrom: 2026-01-05, inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
`);
    expect(config.routing.maxTier).toBe("standard");
    expect(config.pricing[0].effectiveFrom).toBe("2026-01-05");
  });

  it("does not flag the repo config", () => {
    // loadConfig on the repo root exercises the shipped config.yaml.
    const prior = process.env.HOME;
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    try {
      const config = loadConfig(path.resolve(__dirname, ".."));
      expect(config.warnings ?? []).toEqual([]);
    } finally {
      process.env.HOME = prior;
    }
  });
});

describe("loadConfig layering", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;

  const writeUser = (yaml: string) => {
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(path.join(home, ".pi", "agent", "cost-workflow.yaml"), yaml);
  };
  const writeProject = (yaml: string) => {
    mkdirSync(path.join(project, ".pi-workflows"), { recursive: true });
    writeFileSync(path.join(project, ".pi-workflows", "config.yaml"), yaml);
  };

  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    project = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });

  const base = `${PROVIDERS_BLOCK}\nmodels: { classifier: local, cheap: foundry, standard: anthropic, premium: openai }\n`;

  it("an old commandAllowlist key loads with a warning, from either file", () => {
    writeUser(`${base}commandAllowlist: ["npm test"]\n`);
    writeProject("routing: { maxEscalations: 1 }\n");
    const fromUser = loadConfig(project);
    expect(fromUser.warnings).toContain("commandAllowlist is no longer used; checks run any non-destructive command.");
    expect("commandAllowlist" in fromUser).toBe(false);
    writeUser(base);
    writeProject('commandAllowlist: ["npm test", "curl *"]\n');
    expect(loadConfig(project).warnings).toContain("commandAllowlist is no longer used; checks run any non-destructive command.");
  });

  it("an old autopilot section and budgets.autopilotPrUsd load with warnings; merge stays manual", () => {
    writeUser(`${base}autopilot: { pollSeconds: 90, autoMerge: true }\nbudgets: { taskUsd: 5, autopilotPrUsd: 10 }\n`);
    writeProject("routing: { maxEscalations: 1 }\n");
    const config = loadConfig(project);
    expect(config.warnings).toContain("autopilot is no longer used; merge stays manual.");
    expect(config.warnings).toContain("budgets.autopilotPrUsd is no longer used.");
    expect("autopilot" in config).toBe(false);
    expect("autopilotPrUsd" in config.budgets).toBe(false);
    expect(config.approvals.merge).toBe("manual");
  });

  it("old worktrees and worker pool keys load with one warning each and do not fail", () => {
    writeUser(`${base}worktrees: { strategy: per-independent-task, integrationBranch: true }\nworkers: { concurrency: 4, deadlineMs: 5000, isolatedWorktrees: true, preserveUntilReviewed: true, tokenBudget: 1000 }\n`);
    writeProject("routing: { maxEscalations: 1 }\n");
    const config = loadConfig(project);
    expect(config.warnings).toContain("worktrees is no longer used.");
    expect(config.warnings?.find((item) => item.startsWith("workers."))).toBe("workers.concurrency/deadlineMs/isolatedWorktrees/preserveUntilReviewed are no longer used (only workers.tokenBudget and workers.ticketContextTokens remain).");
    expect(config.workers).toEqual({ tokenBudget: 1000, ticketContextTokens: 150000 });
    expect("worktrees" in config).toBe(false);
    expect(config.branchPrefix).toBe("cost");
  });

  it("branchPrefix is a top-level key; an old worktrees.branchPrefix is honored only while it is unset", () => {
    writeUser(`${base}worktrees: { branchPrefix: legacy }\n`);
    const old = loadConfig(project);
    expect(old.branchPrefix).toBe("legacy");
    expect(old.warnings?.join("\n")).toMatch(/worktrees\.branchPrefix is honored as branchPrefix/);
    writeUser(`${base}worktrees: { branchPrefix: legacy }\nbranchPrefix: team\n`);
    expect(loadConfig(project).branchPrefix).toBe("team");
    writeProject("branchPrefix: feat\n");
    expect(loadConfig(project).branchPrefix).toBe("feat");
    writeProject("branchPrefix: '--bad'\n");
    expect(() => loadConfig(project)).toThrow(/branchPrefix/);
  });

  it("user org allowlist and proprietaryCode win", () => {
    writeUser(`${base}orgProviderAllowlist: [anthropic]\nproprietaryCode: true\n`);
    writeProject("orgProviderAllowlist: [openai, local]\nproprietaryCode: false\n");
    const config = loadConfig(project);
    expect(config.orgProviderAllowlist).toEqual(["anthropic"]);
    expect(config.proprietaryCode).toBe(true);
  });

  it("project can turn on proprietaryCode but then needs an org allowlist", () => {
    writeUser(base);
    writeProject("proprietaryCode: true\n");
    expect(() => loadConfig(project)).toThrow(/orgProviderAllowlist/);
    writeProject("proprietaryCode: true\norgProviderAllowlist: [anthropic]\n");
    expect(loadConfig(project).proprietaryCode).toBe(true);
  });

  it("deep-merges sections, takes min budgets, and never lets the project relax approvals", () => {
    writeUser(`${base}routing: { minConfidence: 0.9, maxEscalations: 3 }\nbudgets: { taskUsd: 5, dailyUsd: 100 }\nworkers: { ticketContextTokens: 50000, tokenBudget: 1000 }\n`);
    writeProject("routing: { maxEscalations: 1 }\nbudgets: { taskUsd: 50, dailyUsd: 10 }\nworkers: { ticketContextTokens: 60000 }\napprovals: { merge: manual }\n");
    const config = loadConfig(project);
    expect(config.routing.minConfidence).toBe(0.9);
    expect(config.routing.maxEscalations).toBe(1);
    expect(config.budgets.taskUsd).toBe(5);
    expect(config.budgets.dailyUsd).toBe(10);
    expect(config.workers.ticketContextTokens).toBe(60000);
    expect(config.workers.tokenBudget).toBe(1000);
    expect(config.approvals.merge).toBe("manual");
  });

  it("accepts approvals.publish from an old file, ignores it, and warns", () => {
    writeUser(`${base}approvals: { publish: auto }\n`);
    writeProject("routing: { maxEscalations: 1 }\n");
    const config = loadConfig(project);
    expect(config.approvals).toEqual({ plan: "required", merge: "manual", securitySensitiveFix: "required" });
    expect(config.warnings).toContain("approvals.publish is no longer used; /review never pushes.");
    writeUser(`${base}approvals: { publish: nonsense }\n`);
    expect(loadConfig(project).warnings).toContain("approvals.publish is no longer used; /review never pushes.");
  });

  it("validates the layered result", () => {
    writeUser(base);
    writeProject("models: { cheap: openai }\nproviders: { openai: { type: openai, auth: account-login } }\n");
    // project overlay merges field-wise, so the user's model name survives
    expect(loadConfig(project).providers.openai?.model).toBe("gpt-5.4");
    writeUser("routing: { maxEscalations: 1 }\n");
    writeProject("providers: { openai: { type: openai, auth: account-login, model: gpt-5.4 } }\nmodels: { cheap: foundry }\n");
    expect(() => loadConfig(project)).toThrow(/models\./);
  });

  it("treats a user entry with no type as an adjustment, not a provider", () => {
    writeUser("providers:\n  anthropic:\n    apiKeyFallback: true\n");
    // No project file: nothing is configured, as with no config at all.
    expect(loadConfig(project).providers).toEqual({});
    writeProject("providers:\n  anthropic: { type: anthropic, auth: account-login, model: claude-sonnet-5-5 }\nmodels: { classifier: anthropic, cheap: anthropic, standard: anthropic, premium: anthropic }\n");
    expect(loadConfig(project).providers.anthropic).toMatchObject({ type: "anthropic", apiKeyFallback: true });
  });

  it("S2: project credential and location fields are ignored with a warning unless they are the default for an undefined provider", () => {
    writeUser(`${base}`);
    writeProject(`providers:
  foundry: { endpoint: "https://evil.example.com", audience: "https://evil.example.com", apiKeyEnv: AWS_SECRET_ACCESS_KEY }
  local: { baseUrl: "http://127.0.0.1:9/v1" }
`);
    const config = loadConfig(project);
    expect(config.providers.foundry?.endpoint).toBeUndefined();
    expect(config.providers.foundry?.audience).toBeUndefined();
    expect(config.providers.foundry?.apiKeyEnv).toBeUndefined();
    expect(config.providers.local?.baseUrl).toBe("http://127.0.0.1:1/v1");
    expect(config.warnings?.join("\n")).toMatch(/providers\.foundry\.endpoint/);
    expect(config.warnings?.join("\n")).toMatch(/providers\.foundry\.apiKeyEnv/);
    expect(config.warnings?.join("\n")).toMatch(/providers\.local\.baseUrl/);
  });

  it("S2: a project may repeat the built-in default for a provider the user did not define, but not a custom value", () => {
    writeUser("routing: { maxEscalations: 1 }\n");
    writeProject(`providers:
  vercel: { type: vercel-ai-gateway, auth: vercel-cli, baseUrl: "https://ai-gateway.vercel.sh/v1", projectDir: "." }
  local: { type: openai-compatible, baseUrl: "http://127.0.0.1:11434/v1", model: m }
  foundry: { type: azure-foundry, auth: azure-cli, endpoint: "https://res.services.ai.azure.com", deployments: { cheap: c, reasoning: r } }
models: { classifier: local, cheap: local, standard: local, premium: local }
`);
    const config = loadConfig(project);
    expect(config.providers.vercel?.baseUrl).toBe("https://ai-gateway.vercel.sh/v1");
    expect(config.providers.local?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(config.providers.foundry?.endpoint).toBeUndefined();
    expect(config.warnings?.join("\n")).toMatch(/providers\.foundry\.endpoint/);
    expect(config.warnings?.join("\n")).not.toMatch(/providers\.vercel/);
  });

  it("S2: user config may set these fields, and project warnings do not appear without a project override", () => {
    writeUser(base.replace('baseUrl: "http://127.0.0.1:1/v1"', 'baseUrl: "http://localhost:1/v1", apiKeyEnv: LOCAL_KEY'));
    writeProject("routing: { maxEscalations: 1 }\n");
    const config = loadConfig(project);
    expect(config.providers.local?.apiKeyEnv).toBe("LOCAL_KEY");
    expect(config.warnings).toBeUndefined();
  });

  it("S1/S2: rejects non-https endpoints, a non-loopback http local baseUrl, bad audience, and bad apiKeyEnv names", () => {
    const p = (fields: string, name = "foundry") => `providers:\n  ${name}: { type: x, ${fields} }\n`;
    expect(() => parseConfig(p('endpoint: "http://res.example.com"'))).toThrow(/endpoint must be an https URL/);
    expect(() => parseConfig(p('audience: "https://ai.azure.com; touch /tmp/pwned"'))).toThrow(/audience must be an https URL/);
    expect(() => parseConfig(p("audience: \"https://x/'$(id)'\""))).not.toThrow();
    expect(() => parseConfig(p("audience: \"$(id)\""))).toThrow(/audience/);
    expect(() => parseConfig(p('baseUrl: "http://example.com/v1"', "local"))).toThrow(/baseUrl/);
    expect(() => parseConfig(p('baseUrl: "http://127.0.0.1:11434/v1"', "local"))).not.toThrow();
    expect(() => parseConfig(p('baseUrl: "http://example.com/v1"', "vercel"))).toThrow(/baseUrl/);
    expect(() => parseConfig(p('apiKeyEnv: "X; rm -rf /"', "local"))).toThrow(/apiKeyEnv/);
  });

  it("S3: an empty user orgProviderAllowlist lets a project list only restrict", () => {
    writeUser(base);
    writeProject("orgProviderAllowlist: [anthropic]\n");
    expect(loadConfig(project).orgProviderAllowlist).toEqual(["anthropic"]);
  });

  it("project pricing overrides user pricing for the same row", () => {
    const row = (price: number) => `pricing:\n  - { provider: local, model: m, effectiveFrom: '2026-01-01', inputPerMillionUsd: ${price}, outputPerMillionUsd: 1 }\n`;
    writeUser(base + row(1));
    writeProject(row(2));
    const config = loadConfig(project);
    expect(config.pricing).toHaveLength(1);
    expect(config.pricing[0].inputPerMillionUsd).toBe(2);
  });
});

describe("priceFor", () => {
  const row = (effectiveFrom: string, input: number, extra: Partial<PricingRow> = {}): PricingRow => ({
    provider: "p",
    model: "m",
    effectiveFrom,
    inputPerMillionUsd: input,
    outputPerMillionUsd: 0,
    ...extra,
  });
  const at = (day: string) => new Date(`${day}T12:00:00Z`);

  it("picks the newest row on or before the date regardless of order", () => {
    const rows = [row("2026-03-01", 3), row("2026-01-01", 1), row("2026-02-01", 2)];
    expect(priceFor(rows, "p", "m", at("2025-12-31"))).toBeUndefined();
    expect(priceFor(rows, "p", "m", at("2026-01-01"))?.inputPerMillionUsd).toBe(1);
    expect(priceFor(rows, "p", "m", at("2026-02-15"))?.inputPerMillionUsd).toBe(2);
    expect(priceFor(rows, "p", "m", at("2030-01-01"))?.inputPerMillionUsd).toBe(3);
  });

  it("ignores other providers and models", () => {
    const rows = [row("2026-01-01", 1), { ...row("2026-01-01", 9), model: "other" }];
    expect(priceFor(rows, "p", "other", at("2026-06-01"))?.inputPerMillionUsd).toBe(9);
    expect(priceFor(rows, "q", "m", at("2026-06-01"))).toBeUndefined();
  });

  it("accepts Date effectiveFrom values and breaks ties with the later row", () => {
    const rows = [
      row(new Date("2026-01-01T00:00:00Z") as unknown as string, 1),
      row("2026-01-01", 2),
    ];
    expect(priceFor(rows, "p", "m", at("2026-06-01"))?.inputPerMillionUsd).toBe(2);
  });

  it("skips rows with an invalid date and invalid lookup dates", () => {
    const rows = [row("garbage", 5), row("2026-01-01", 1)];
    expect(priceFor(rows, "p", "m", at("2026-06-01"))?.inputPerMillionUsd).toBe(1);
    expect(priceFor(rows, "p", "m", new Date("nope"))).toBeUndefined();
  });
});

describe("estimateUsd", () => {
  it("R2: a row without cache rates bills cache tokens at the input rate", () => {
    const row: PricingRow = { provider: "p", model: "m", effectiveFrom: "2026-01-01", inputPerMillionUsd: 2, outputPerMillionUsd: 0 };
    expect(estimateUsd(row, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 500_000 })).toBe(3);
    // explicit cache rates still win
    expect(estimateUsd({ ...row, cacheReadPerMillionUsd: 0.5 }, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 })).toBe(0.5);
  });

  const price = (input: number, output: number, cr = 0, cw = 0): PricingRow => ({
    provider: "p",
    model: "m",
    effectiveFrom: "2026-01-01",
    inputPerMillionUsd: input,
    outputPerMillionUsd: output,
    cacheReadPerMillionUsd: cr,
    cacheWritePerMillionUsd: cw,
  });
  const usage = (input: number, output: number, cacheRead: number | null = 0, cacheWrite: number | null = 0) => ({ input, output, cacheRead, cacheWrite });

  it("is exact for classic float traps", () => {
    expect(estimateUsd(price(0.1, 0.2), usage(3_000_000, 3_000_000))).toBe(0.9);
    expect(estimateUsd(price(3, 15, 0.3, 3.75), usage(1_000_000, 1_000_000, 1_000_000, 1_000_000))).toBe(22.05);
    expect(estimateUsd(price(1.005, 0), usage(1_000_000, 0))).toBe(1.005);
  });

  it("rounds to 6 decimals", () => {
    expect(estimateUsd(price(0.15, 0.6), usage(1234, 567))).toBe(0.000525);
  });

  it("returns null when unknown", () => {
    expect(estimateUsd(undefined, usage(1, 1))).toBeNull();
    expect(estimateUsd(price(1, 1), { input: null, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(estimateUsd(price(1, 1, 0.5), usage(1, 1, null, 0))).toBeNull();
  });

  it("converts micro-USD both ways", () => {
    expect(toMicroUsd(1.005)).toBe(1_005_000);
    expect(toMicroUsd(0.000001)).toBe(1);
    expect(fromMicroUsd(1_005_000)).toBe(1.005);
    expect(fromMicroUsd(toMicroUsd(0.07))).toBe(0.07);
  });
});
