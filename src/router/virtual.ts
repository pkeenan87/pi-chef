import { tierCandidates, type WorkflowConfig } from "../config.js";
import type { QuotaUsage } from "../cost/quota.js";
import { modelMetricKey, type AcceptedClassification, type Tier, type TierCandidate } from "../domain.js";
import { decideRoute } from "./policy.js";
import { circuitOpenFor } from "./stats.js";
import { selectCandidate, type Availability } from "./select.js";
import { shadowCost, tierCost, type SuccessTable } from "./stats.js";

/**
 * The cost-opt/auto virtual model. Stateful and cache-aware: the first user request is classified once,
 * the chosen model then stays for the session (a switch loses the prompt cache), and it moves only when
 * the work really changes: an escalation cue, a long new request, a higher thinking level, a failure,
 * or the single plan-to-build handoff to the cheap tier after the first successful edit.
 */

export type ChatTier = "cheap" | "standard" | "premium";
const CHAT_TIERS: ChatTier[] = ["cheap", "standard", "premium"];
export const VIRTUAL_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export interface RouterClassification {
  taskType: string;
  complexity: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  securitySensitive: boolean;
  confidence: number;
  source: "model" | "fallback";
}

/** Stored on the Pi session branch. Plain JSON. */
export interface RouterState {
  v: 1;
  tier: ChatTier;
  provider: string;
  model: string;
  phase: "plan" | "build";
  classifiedAt: string;
  classification: RouterClassification;
  switches: number;
}

export interface ModelLike {
  provider: string;
  id: string;
  contextWindow?: number;
}

/** The slice of Pi's ModelRegistry the router needs. */
export interface RouterRegistry<M extends ModelLike> {
  find(provider: string, id: string): M | undefined;
  getAvailable(): M[];
  isUsingOAuth?(model: M): boolean;
}

export interface RouterMessage {
  role: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
}

export interface RouterRequest<M extends ModelLike> {
  reason: "user" | "continuation" | "retry" | "direct";
  thinkingLevel: string;
  messages: readonly RouterMessage[];
  previous?: { model: M; thinkingLevel?: string };
  failed?: { model: M; thinkingLevel?: string; message?: { stopReason?: string; errorMessage?: string } };
  state?: RouterState;
  signal?: AbortSignal;
}

export interface RouterSnapshot {
  config: WorkflowConfig;
  table: SuccessTable;
  availability?: Availability;
  budget: "ok" | "soft" | "hard";
  budgetRemainingUsd?: number;
  /** Subscription quota use for shadow-price ranking. */
  quota?: QuotaUsage;
}

export interface RouteEvent {
  purpose: string;
  tier: string;
  provider: string;
  model: string;
  selectionReason: string;
}

export interface VirtualDeps<M extends ModelLike> {
  registry: RouterRegistry<M>;
  /** Read lazily: continuation requests never need it. */
  snapshot(): Promise<RouterSnapshot>;
  /** Classifies once with the selector-chosen Decisions classifier; keyword fallback on any failure. */
  classify(text: string, signal?: AbortSignal): Promise<AcceptedClassification>;
  now(): Date;
  rng?: () => number;
  /** Circuit-breaker metric for a model that failed with an overload, rate limit, 5xx, or auth error. */
  recordFailure?(input: { taskType: string; tier: ChatTier; provider: string; model: string }): void | Promise<void>;
  /** Called whenever the router picks a different model or tier (not on sticky continuations). */
  onRoute?(event: RouteEvent): void | Promise<void>;
  /** Runs before a candidate is returned, e.g. to refresh a provider token. */
  prepare?(candidate: TierCandidate): void | Promise<void>;
}

export interface RouterResult<M extends ModelLike> {
  model: M;
  thinkingLevel: string;
  state?: RouterState;
}

const EDIT_TOOLS = new Set(["edit", "write"]);
const LONG_MESSAGE = 2000;
const ESCALATION_CUE = /\b(this is (?:really )?hard|think harder|use a (?:stronger|better|smarter|bigger) model|stronger model)\b/i;
const CONTEXT_OVERFLOW = /context (?:length|window)|context_length|prompt is too long|too many tokens|maximum context|input is too long|exceeds? the (?:context|maximum)|overflow/i;
const TRANSIENT = /overload|rate.?limit|too many requests|\b429\b|\b5\d\d\b|unavailable|capacity|bad gateway|timed? ?out|unauthori[sz]ed|\b401\b|\b403\b|forbidden|authenticat|api key|credential|quota/i;

const rank = (tier: ChatTier): number => CHAT_TIERS.indexOf(tier);
const maxTier = (a: ChatTier, b: ChatTier): ChatTier => (rank(a) >= rank(b) ? a : b);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : [])).join("\n");
}

function lastUserIndex(messages: readonly RouterMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.role === "user") return i;
  return -1;
}

function lastUser(messages: readonly RouterMessage[]): string {
  const index = lastUserIndex(messages);
  return index >= 0 ? textOf(messages[index]!.content) : "";
}

/** A successful edit or write tool result after the last user message. */
function editedThisTurn(messages: readonly RouterMessage[]): boolean {
  const last = lastUserIndex(messages);
  return messages.slice(last + 1).some((item) => item.role === "toolResult" && EDIT_TOOLS.has(item.toolName ?? "") && !item.isError);
}

/** Lowest tier a thinking level allows: high floors at standard, xhigh at premium. */
export function thinkingFloor(level: string): ChatTier | undefined {
  return level === "xhigh" ? "premium" : level === "high" ? "standard" : undefined;
}

function chatTier(tier: Tier): ChatTier {
  return tier === "standard" || tier === "premium" ? tier : "cheap";
}

function isSensitive(classification: AcceptedClassification, config: WorkflowConfig): boolean {
  const categories = config.routing.requirePremiumReviewFor;
  return (
    classification.risk === "high" ||
    classification.task_type === "security" ||
    classification.required_capabilities.some((cap) => cap === "security-sensitive" || categories.includes(cap)) ||
    categories.includes(classification.task_type)
  );
}

function summarize(classification: AcceptedClassification, config: WorkflowConfig): RouterClassification {
  return {
    taskType: classification.task_type,
    complexity: classification.complexity,
    risk: classification.risk,
    securitySensitive: isSensitive(classification, config),
    confidence: classification.confidence,
    source: classification.source,
  };
}

function accepted(summary: RouterClassification, tier: ChatTier): AcceptedClassification {
  return {
    task_type: summary.taskType,
    complexity: summary.complexity,
    risk: summary.risk,
    required_capabilities: summary.securitySensitive ? ["security-sensitive"] : [],
    recommended_tier: tier,
    confidence: summary.confidence,
    reason_codes: ["router_state"],
    source: summary.source,
  };
}

/** Tier the classifier and thinking level ask for. Low thinking goes one tier down, never for sensitive work. */
function wantedTier(classification: AcceptedClassification, config: WorkflowConfig, thinking: string): ChatTier {
  const base = chatTier(classification.recommended_tier);
  const floor = thinkingFloor(thinking);
  if (floor) return maxTier(base, floor);
  if (thinking === "low" && !isSensitive(classification, config)) return CHAT_TIERS[Math.max(0, rank(base) - 1)]!;
  return base;
}

function classifyFailure(request: RouterRequest<ModelLike>): "overflow" | "transient" | "other" {
  const text = `${request.failed?.message?.errorMessage ?? ""} ${request.failed?.message?.stopReason ?? ""}`;
  if (CONTEXT_OVERFLOW.test(text)) return "overflow";
  return TRANSIENT.test(text) ? "transient" : "other";
}

export async function routeVirtual<M extends ModelLike>(request: RouterRequest<M>, deps: VirtualDeps<M>): Promise<RouterResult<M>> {
  const thinkingLevel = request.thinkingLevel;
  const state = request.state;
  const registry = deps.registry;

  const same = (a: ModelLike | undefined, provider: string, id: string): boolean => a?.provider === provider && a.id === id;
  const usableModel = (provider: string, id: string): M | undefined => {
    const model = registry.find(provider, id);
    if (!model) return undefined;
    if (!registry.getAvailable().some((item) => same(item, provider, id))) return undefined;
    // OpenAI and Anthropic only through an account login, never an API key.
    if ((provider === "openai" || provider === "anthropic") && !registry.isUsingOAuth?.(model)) return undefined;
    return model;
  };
  const done = async (_model: M, candidate: TierCandidate): Promise<void> => {
    await deps.prepare?.(candidate);
  };

  // Tool follow-ups stay put; they carry the plan-to-build handoff, nothing else.
  if (request.reason === "continuation") {
    if (state) {
      const switched = state.phase === "plan" && state.tier !== "cheap" && !state.classification.securitySensitive && state.classification.complexity !== "high" && editedThisTurn(request.messages);
      if (switched) {
        const snapshot = await deps.snapshot();
        if (snapshot.budget !== "hard") {
          const pick = await choose(snapshot, "cheap", {}, "build handoff");
          if (pick) {
            const next: RouterState = { ...state, tier: "cheap", provider: pick.candidate.provider, model: pick.candidate.model, phase: "build", switches: state.switches + 1 };
            await emit("handoff", next, pick.reason);
            return { model: pick.model, thinkingLevel, state: next };
          }
        }
      }
      const model = usableModel(state.provider, state.model) ?? request.previous?.model;
      if (model) return { model, thinkingLevel };
    } else if (request.previous) {
      return { model: request.previous.model, thinkingLevel };
    }
  }

  if (request.reason === "direct") {
    const snapshot = await deps.snapshot();
    for (const tier of CHAT_TIERS) {
      const pick = await choose(snapshot, tier, {}, "compaction summary");
      if (pick) {
        await emit("direct", { tier, provider: pick.candidate.provider, model: pick.candidate.model }, pick.reason);
        return { model: pick.model, thinkingLevel };
      }
    }
    throw new Error(noModelMessage(snapshot.config, "cheap"));
  }

  const snapshot = await deps.snapshot();
  if (snapshot.budget === "hard") throw new Error("Task or daily budget is exhausted. Run /cost for details.");
  const soft = snapshot.budget === "soft";

  if (request.reason === "retry" && state) {
    const retried = await retry(snapshot);
    if (retried) return retried;
  }

  if (!state || request.reason === "retry") {
    // Classify once. After a retry with no state, the failed model is excluded from the pick.
    const text = lastUser(request.messages);
    const classification = await deps.classify(text, request.signal);
    const exclude = request.failed && classifyFailure(request) !== "other" ? request.failed.model : undefined;
    return initial(snapshot, classification, exclude);
  }

  // A later user turn: stay on the model unless the work changed.
  const text = lastUser(request.messages);
  const cue = ESCALATION_CUE.test(text);
  const reclassify = cue || text.length > LONG_MESSAGE;
  const fresh = reclassify ? await deps.classify(text, request.signal) : undefined;
  const summary = fresh ? summarize(fresh, snapshot.config) : state.classification;
  let tier = state.tier;
  if (!soft) {
    if (fresh) tier = maxTier(tier, wantedTier(fresh, snapshot.config, thinkingLevel === "low" ? "medium" : thinkingLevel));
    const floor = thinkingFloor(thinkingLevel);
    if (floor) tier = maxTier(tier, floor);
    if (cue && tier === state.tier) tier = CHAT_TIERS[Math.min(2, rank(tier) + 1)]!;
  }
  const classifiedAt = fresh ? deps.now().toISOString() : state.classifiedAt;
  if (tier === state.tier) {
    const model = usableModel(state.provider, state.model);
    if (model) {
      if (!fresh) return { model, thinkingLevel, state };
      const next: RouterState = { ...state, classification: summary, classifiedAt };
      return { model, thinkingLevel, state: next };
    }
    // The model disappeared from the registry or lost its credentials: pick again in the same tier.
    const pick = await choose(snapshot, tier, { exclude: { provider: state.provider, id: state.model } }, "unusable model");
    if (!pick) throw new Error(noModelMessage(snapshot.config, tier));
    const next: RouterState = { ...state, provider: pick.candidate.provider, model: pick.candidate.model, classification: summary, classifiedAt, switches: state.switches + 1 };
    await emit("user", next, pick.reason);
    return { model: pick.model, thinkingLevel, state: next };
  }
  const decision = await decide(snapshot, accepted(summary, tier), undefined);
  const next: RouterState = {
    ...state,
    tier: decision.tier,
    provider: decision.candidate.provider,
    model: decision.candidate.model,
    phase: decision.tier === "cheap" ? "build" : "plan",
    classification: summary,
    classifiedAt,
    switches: state.switches + 1,
  };
  await emit("user", next, decision.reason);
  return { model: decision.model, thinkingLevel, state: next };

  // ---- helpers (hoisted) ----

  async function emit(purpose: string, route: { tier: string; provider: string; model: string }, reason: string): Promise<void> {
    await deps.onRoute?.({ purpose, tier: route.tier, provider: route.provider, model: route.model, selectionReason: reason });
  }

  /** Config view whose chat tiers list only usable candidates (registered, credentialed, not excluded); soft budget keeps the cheapest. */
  function view(snapshot: RouterSnapshot, options: { exclude?: ModelLike; minWindow?: number }): WorkflowConfig {
    const soft = snapshot.budget === "soft";
    const tiers: WorkflowConfig["tiers"] = { ...snapshot.config.tiers };
    for (const tier of CHAT_TIERS) {
      let list = tierCandidates(snapshot.config, tier).filter((candidate) => {
        if (candidate.api !== "chat") return false;
        if (options.exclude && same(options.exclude, candidate.provider, candidate.model)) return false;
        const model = usableModel(candidate.provider, candidate.model);
        if (!model) return false;
        return options.minWindow === undefined || (model.contextWindow ?? 0) > options.minWindow;
      });
      if (soft && list.length > 1) {
        const price = (c: TierCandidate): number => tierCost(snapshot.config.pricing, c.provider, c.model, deps.now(), snapshot.config.workers.tokenBudget) ?? Number.POSITIVE_INFINITY;
        // Near the money limit real price decides; the quota shadow price only breaks ties (for example between $0 subscriptions).
        const shadow = (c: TierCandidate): number => shadowCost(snapshot.config, c.provider, c.model, snapshot.quota);
        // A candidate whose circuit is open is not the cheapest usable one.
        const healthy = list.filter((c) => !circuitOpenFor(snapshot.table, state?.classification.taskType ?? "general", modelMetricKey(tier, c.provider, c.model), snapshot.config.routing.circuitBreakerFailures, deps.now()));
        list = [[...(healthy.length > 0 ? healthy : list)].sort((a, b) => price(a) - price(b) || shadow(a) - shadow(b))[0]!];
      }
      tiers[tier] = list;
    }
    return { ...snapshot.config, tiers };
  }

  /** Picks a candidate in exactly one tier through the selector. */
  async function choose(
    snapshot: RouterSnapshot,
    tier: ChatTier,
    options: { exclude?: ModelLike; minWindow?: number },
    why: string,
  ): Promise<{ model: M; candidate: TierCandidate; reason: string } | undefined> {
    const config = view(snapshot, options);
    const selection = selectCandidate({
      tier,
      taskType: state?.classification.taskType ?? "general",
      config,
      table: snapshot.table,
      availability: snapshot.availability,
      budgetRemainingUsd: snapshot.budgetRemainingUsd,
      quota: snapshot.quota,
      rng: deps.rng,
      at: deps.now(),
    });
    if (!selection.candidate) return undefined;
    const model = usableModel(selection.candidate.provider, selection.candidate.model);
    if (!model) return undefined;
    await done(model, selection.candidate);
    return { model, candidate: selection.candidate, reason: `${why}: ${selection.reason}` };
  }

  /** decideRoute over the usable view; keeps the model the session already uses when it fits the tier. */
  async function decide(
    snapshot: RouterSnapshot,
    classification: AcceptedClassification,
    exclude: ModelLike | undefined,
  ): Promise<{ tier: ChatTier; model: M; candidate: TierCandidate; reason: string }> {
    const config = view(snapshot, { exclude });
    const wanted = chatTier(classification.recommended_tier);
    const decision = decideRoute(classification, config, snapshot.table, {
      purpose: "preview",
      at: deps.now(),
      availability: snapshot.availability,
      budgetRemainingUsd: snapshot.budgetRemainingUsd,
      quota: snapshot.quota,
      rng: deps.rng,
    });
    if (decision.blocked || !decision.candidate) {
      const message = !decision.blocked || decision.blocked.startsWith("No models are configured") ? noModelMessage(snapshot.config, chatTier(decision.tier)) : decision.blocked;
      throw new Error(`${message} Run /cost or /status for details.`);
    }
    const tier = chatTier(decision.tier);
    if (snapshot.budget === "soft" && rank(tier) > rank(wanted)) {
      throw new Error(`The ${wanted} tier has no usable model and the soft budget limit blocks escalating to ${tier}. Run /cost for details.`);
    }
    let candidate = decision.candidate;
    const current = request.previous?.model;
    if (current && snapshot.budget !== "soft" && !exclude) {
      const kept = tierCandidates(config, tier).find((item) => same(current, item.provider, item.model));
      if (kept) candidate = kept;
    }
    const model = usableModel(candidate.provider, candidate.model);
    if (!model) throw new Error(noModelMessage(snapshot.config, tier));
    await done(model, candidate);
    return { tier, model, candidate, reason: candidate === decision.candidate ? (decision.selectionReason ?? "") : "kept the model already in use" };
  }

  async function initial(snapshot: RouterSnapshot, classification: AcceptedClassification, exclude: ModelLike | undefined): Promise<RouterResult<M>> {
    const summary = summarize(classification, snapshot.config);
    const tier = wantedTier(classification, snapshot.config, thinkingLevel);
    const decision = await decide(snapshot, { ...classification, recommended_tier: tier }, exclude);
    const next: RouterState = {
      v: 1,
      tier: decision.tier,
      provider: decision.candidate.provider,
      model: decision.candidate.model,
      phase: decision.tier === "cheap" ? "build" : "plan",
      classifiedAt: deps.now().toISOString(),
      classification: summary,
      switches: 0,
    };
    await emit("user", next, decision.reason);
    return { model: decision.model, thinkingLevel, state: next };
  }

  /** Retry handling with state. Returns undefined to fall through (no state left to use). */
  async function retry(snapshot: RouterSnapshot): Promise<RouterResult<M> | undefined> {
    const failed = request.failed?.model;
    const kind = failed ? classifyFailure(request) : "other";
    const current = state!;
    if (!failed || kind === "other") {
      const model = (failed && usableModel(failed.provider, failed.id)) || usableModel(current.provider, current.model);
      return model ? { model, thinkingLevel } : undefined;
    }
    if (kind === "transient") {
      await deps.recordFailure?.({ taskType: current.classification.taskType, tier: current.tier, provider: failed.provider, model: failed.id });
      const pick = await choose(snapshot, current.tier, { exclude: failed }, "retry after provider error");
      if (!pick) return { model: failed, thinkingLevel };
      const next: RouterState = { ...current, provider: pick.candidate.provider, model: pick.candidate.model, switches: current.switches + 1 };
      await emit("retry", next, pick.reason);
      return { model: pick.model, thinkingLevel, state: next };
    }
    // Context overflow: a larger window in this tier, else the next ones.
    const window = failed.contextWindow ?? 0;
    for (const tier of CHAT_TIERS.slice(rank(current.tier))) {
      const pick = await choose(snapshot, tier, { minWindow: window }, "retry after context overflow");
      if (!pick) continue;
      const next: RouterState = { ...current, tier, provider: pick.candidate.provider, model: pick.candidate.model, switches: current.switches + 1 };
      await emit("retry", next, pick.reason);
      return { model: pick.model, thinkingLevel, state: next };
    }
    return { model: failed, thinkingLevel };
  }
}

function noModelMessage(config: WorkflowConfig, tier: ChatTier): string {
  const listed = tierCandidates(config, tier).filter((item) => item.api === "chat").map((item) => `${item.provider}/${item.model}`);
  return `No usable ${tier} model: ${listed.length > 0 ? `${listed.join(", ")} not registered in Pi or missing credentials (run /login or /status)` : "none configured"}.`;
}

/** Smallest known contextWindow and maxTokens across the configured chat candidates, for the virtual model's declared limits. */
export function declaredLimits(config: WorkflowConfig, find: (provider: string, id: string) => { contextWindow?: number; maxTokens?: number } | undefined): { contextWindow?: number; maxTokens?: number } {
  const windows: number[] = [];
  const outputs: number[] = [];
  for (const tier of CHAT_TIERS) {
    for (const candidate of tierCandidates(config, tier)) {
      if (candidate.api !== "chat") continue;
      const model = find(candidate.provider, candidate.model);
      if (model?.contextWindow) windows.push(model.contextWindow);
      if (model?.maxTokens) outputs.push(model.maxTokens);
    }
  }
  return {
    ...(windows.length > 0 ? { contextWindow: Math.min(...windows) } : {}),
    ...(outputs.length > 0 ? { maxTokens: Math.min(...outputs) } : {}),
  };
}
