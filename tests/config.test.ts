import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  estimateUsd,
  fromMicroUsd,
  loadConfig,
  parseConfig,
  priceFor,
  toMicroUsd,
  unpricedConfigModels,
  type PricingRow,
} from "../src/config.js";

const LOCAL = `local:
  baseUrl: "http://127.0.0.1:8081/v1"
  apiKeyEnv: LOCAL_API_KEY
  models:
    - { id: Qwen3.8-27B, contextWindow: 131072, maxTokens: 16384 }
    - { id: small, contextWindow: 32768 }
`;

describe("defaults", () => {
  it("uses the default models, escalation count and turn limit when nothing is set", () => {
    const config = parseConfig("");
    expect(config.models).toEqual({ low: "xai/grok-4.7", medium: "anthropic/claude-sonnet-5-5", high: "openai/gpt-6.1-sol", review: "anthropic/claude-opus-5-5" });
    expect(config.models).toEqual(DEFAULT_MODELS);
    expect(config.routing).toEqual({ maxEscalations: 2, maxTicketTurns: 100 });
    expect(config.local).toBeUndefined();
    expect(config.agents).toEqual({});
    expect(config.review).toEqual({ model: true, tickets: true, maxDiffChars: 120000, maxChunks: 6, timeoutMs: 300000 });
    expect(config.budgets).toEqual({ taskUsd: 20, dailyUsd: 75, softWarningRatio: 0.8, unknownCallUsd: 0.05, idleWarnMinutes: 60, idleWarnTokens: 100000 });
    expect(config.branchPrefix).toBe("chef");
  });

  it("fills the models a file leaves out from the defaults", () => {
    const config = parseConfig("models: { high: 'agent:claude/opus' }\n");
    expect(config.models).toEqual({ ...DEFAULT_MODELS, high: "agent:claude/opus" });
  });
});

describe("parseConfig validation", () => {
  it.each([
    ["routing:\n  maxEscalations: -1\n", /routing\.maxEscalations/],
    ["routing:\n  maxEscalations: 1.5\n", /routing\.maxEscalations/],
    ["routing:\n  maxTicketTurns: 4\n", /routing\.maxTicketTurns/],
    ["budgets:\n  taskUsd: 0\n", /budgets\.taskUsd/],
    ["budgets:\n  dailyUsd: -5\n", /budgets\.dailyUsd/],
    ["budgets:\n  softWarningRatio: 2\n", /budgets\.softWarningRatio/],
    ["budgets:\n  unknownCallUsd: -0.01\n", /budgets\.unknownCallUsd/],
    ["models:\n  low: nowhere\n", /models\.low is not valid/],
    ["models:\n  high: 'agent:nope'\n", /unknown agent/],
    ["models:\n  high: 'agent:claude/'\n", /empty model/],
    ["models:\n  review: 42\n", /models\.review/],
    ["review:\n  tickets: maybe\n", /review\.tickets/],
    ["local:\n  baseUrl: 'http://127.0.0.1:1/v1'\n", /local\.models/],
    ["local:\n  baseUrl: 'http://example.com/v1'\n  models: [{ id: m, contextWindow: 8192 }]\n", /local\.baseUrl/],
    ["local:\n  baseUrl: 'http://127.0.0.1:1/v1'\n  apiKeyEnv: 'not a name'\n  models: [{ id: m, contextWindow: 8192 }]\n", /local\.apiKeyEnv/],
    ["local:\n  baseUrl: 'http://127.0.0.1:1/v1'\n  models: [{ id: m, contextWindow: 100 }]\n", /contextWindow/],
    ["local:\n  baseUrl: 'http://127.0.0.1:1/v1'\n  models: [{ id: m, contextWindow: 8192, maxTokens: 5 }]\n", /maxTokens/],
    ["local:\n  baseUrl: 'http://127.0.0.1:1/v1'\n  models: [{ id: m, contextWindow: 8192 }, { id: m, contextWindow: 8192 }]\n", /duplicates/],
    ["agents:\n  mine: { run: [] }\n", /agents\.mine\.run/],
    ["agents:\n  mine: { run: [cli], modelFlag: model }\n", /modelFlag/],
    ["agents:\n  'bad name': { run: [cli] }\n", /agent name/],
    ["pricing:\n  - { provider: local, model: m, effectiveFrom: '2026-01-01', inputPerMillionUsd: -1, outputPerMillionUsd: 1 }\n", /inputPerMillionUsd/],
    ["pricing:\n  - { provider: local, model: m, effectiveFrom: 'soon', inputPerMillionUsd: 1, outputPerMillionUsd: 1 }\n", /effectiveFrom/],
    ["pricing:\n  - { provider: local, model: m, effectiveFrom: '2026-02-30', inputPerMillionUsd: 1, outputPerMillionUsd: 1 }\n", /effectiveFrom/],
  ])("rejects %j", (yaml, message) => {
    expect(() => parseConfig(yaml)).toThrow(message);
  });

  it("rejects duplicate pricing rows", () => {
    const row = "  - { provider: local, model: m, effectiveFrom: '2026-01-01', inputPerMillionUsd: 1, outputPerMillionUsd: 1 }\n";
    expect(() => parseConfig(`pricing:\n${row}${row}`)).toThrow(/duplicates/);
  });

  it("accepts the documented example and normalizes dates", () => {
    const config = parseConfig(`models:
  low: local/Qwen3.8-27B
  medium: anthropic/claude-sonnet-5-5
  high: agent:claude/opus
  review: anthropic/claude-opus-5-5:high
${LOCAL}agents:
  claude: { run: [claude, --permission-mode, acceptEdits], modelFlag: --model }
  mine: { run: [mycli] }
routing: { maxEscalations: 0 }
budgets: { softWarningRatio: 1 }
pricing:
  - { provider: anthropic, model: claude-sonnet-5-5, effectiveFrom: 2026-01-05, inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
`);
    expect(config.models.high).toBe("agent:claude/opus");
    expect(config.local).toEqual({
      baseUrl: "http://127.0.0.1:8081/v1",
      apiKeyEnv: "LOCAL_API_KEY",
      models: [
        { id: "Qwen3.8-27B", contextWindow: 131072, maxTokens: 16384 },
        { id: "small", contextWindow: 32768 },
      ],
    });
    expect(config.agents.claude).toEqual({ run: ["claude", "--permission-mode", "acceptEdits"], modelFlag: "--model" });
    expect(config.agents.mine).toEqual({ run: ["mycli"] });
    expect(config.pricing[0].effectiveFrom).toBe("2026-01-05");
    expect(config.routing.maxEscalations).toBe(0);
  });

  it("review.tickets is a boolean and defaults on", () => {
    expect(parseConfig("review: { tickets: false }\n").review.tickets).toBe(false);
    expect(parseConfig("branchPrefix: x\n").review.tickets).toBe(true);
  });

  it("warns once about pricing rows the models need, and not for local models or agents", () => {
    const config = parseConfig("models: { low: local/Qwen3.8-27B, medium: anthropic/claude-sonnet-5-5, high: 'agent:claude', review: anthropic/claude-opus-5-5 }\n" + LOCAL);
    expect(unpricedConfigModels(config)).toEqual(["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"]);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings![0]).toContain("No pricing rows for anthropic/claude-sonnet-5-5, anthropic/claude-opus-5-5");
  });

  it("does not flag the repo config", () => {
    // loadConfig on the repo root exercises the shipped config.yaml.
    const prior = process.env.HOME;
    process.env.HOME = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    try {
      const config = loadConfig(path.resolve(__dirname, ".."));
      expect((config.warnings ?? []).filter((item) => !item.startsWith("No pricing rows"))).toEqual([]);
    } finally {
      process.env.HOME = prior;
    }
  });
});

describe("the sample files", () => {
  let home: string;
  let project: string;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
    project = mkdtempSync(path.join(tmpdir(), "pi-proj-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = priorHome;
  });
  const template = () => readFileSync(path.resolve(__dirname, "..", "templates", "chef.yaml"), "utf8");

  it("loads the commented chef.yaml template as the defaults, with no warning besides the missing prices", () => {
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(path.join(home, ".pi", "agent", "chef.yaml"), template());
    // Alongside the sample project config, as init writes them.
    mkdirSync(path.join(project, ".pi-workflows"), { recursive: true });
    writeFileSync(path.join(project, ".pi-workflows", "config.yaml"), readFileSync(path.resolve(__dirname, "..", ".pi-workflows", "config.yaml"), "utf8"));
    const config = loadConfig(project);
    expect((config.warnings ?? []).filter((item) => !item.startsWith("No pricing rows"))).toEqual([]);
    expect(config.budgets.taskUsd).toBe(20);
    expect(config.models).toEqual(DEFAULT_MODELS);
  });

  it("keeps every example in the chef.yaml template valid and equal to the defaults it names", () => {
    // Uncomment every setting line ("# key"), keep the "##" explanations.
    const uncommented = template().split("\n").map((line) => line.replace(/^# /, "")).join("\n");
    const config = parseConfig(uncommented);
    expect(config.budgets).toEqual({ taskUsd: 20, dailyUsd: 75, softWarningRatio: 0.8, unknownCallUsd: 0.05, idleWarnMinutes: 60, idleWarnTokens: 100000 });
    expect(config.routing).toEqual({ maxEscalations: 2, maxTicketTurns: 100 });
    expect(config.review).toEqual({ model: true, tickets: true, maxDiffChars: 120000, maxChunks: 6, timeoutMs: 300000 });
    expect(config.models).toEqual(DEFAULT_MODELS);
    expect(config.warnings ?? []).toEqual([]);
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
