import { foundryDeployment, tierCandidates, type WorkflowConfig } from "../config.js";
import { TIER_KEYS } from "../domain.js";
import { redact } from "../redact.js";
import { assertCommandSafe } from "../sandbox.js";
import { configProblem, userConfigPath } from "../providers/usable.js";
import { foundryConfigFrom } from "../providers/runtime.js";
import type { WorkflowContext } from "./context.js";

/** Runs the Azure CLI with an argv array. Tests pass a fake; the default is `runAz`. */
export type AzRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const HOST = /^([A-Za-z0-9][A-Za-z0-9-]*)\.(?:services\.ai|openai|cognitiveservices)\.azure\.com$/;

/** The Azure resource name in a Foundry endpoint host (`<resource>.services.ai.azure.com` or `<resource>.openai.azure.com`). */
export function resourceFromEndpoint(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname.match(HOST)?.[1];
  } catch {
    return undefined;
  }
}

interface Deployment {
  name: string;
  model: string;
  version?: string;
}

/** Why an az call failed, in words a person can act on. Never includes the raw output of a token command. */
function azFailure(result: { code: number; stderr: string }): string {
  const text = result.stderr || "";
  if (result.code === 127 || /not on PATH|ENOENT/i.test(text)) return "az is not on PATH; install the Azure CLI, then run az login.";
  if (/az login|not logged in|AADSTS|Please run 'az login'|no subscription/i.test(text)) return "az is not logged in; run az login.";
  const first = redact(text).split("\n").find((line) => line.trim()) ?? `exit code ${result.code}`;
  return `az failed: ${first.slice(0, 200)}`;
}

function parseDeployments(stdout: string): Deployment[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap((item) => {
      const entry = item as { name?: unknown; properties?: { model?: { name?: unknown; version?: unknown } } };
      if (typeof entry.name !== "string") return [];
      const model = entry.properties?.model;
      return [{ name: entry.name, model: typeof model?.name === "string" ? model.name : "unknown model", ...(typeof model?.version === "string" ? { version: model.version } : {}) }];
    });
  } catch {
    return undefined;
  }
}

/** Tier entries (after mapping) whose deployment is not in `have`, grouped by model and deployment. */
export function missingDeployments(config: WorkflowConfig, have: Set<string>): { model: string; deployment: string; tiers: string[] }[] {
  const out = new Map<string, { model: string; deployment: string; tiers: string[] }>();
  for (const tier of TIER_KEYS) {
    for (const candidate of tierCandidates(config, tier)) {
      if (candidate.provider !== "foundry") continue;
      const deployment = foundryDeployment(config, candidate.model);
      if (have.has(deployment)) continue;
      const key = `${candidate.model}\u0000${deployment}`;
      const entry = out.get(key) ?? { model: candidate.model, deployment, tiers: [] };
      entry.tiers.push(tier);
      out.set(key, entry);
    }
  }
  return [...out.values()];
}

/**
 * The `/status foundry` section: lists the resource's deployments with `az cognitiveservices account deployment list`
 * and flags every tier entry whose deployment is not among them. Runs az only when asked; prints deployment names and
 * model names and versions, never a token.
 */
export async function foundryLines(ctx: WorkflowContext): Promise<string[]> {
  const head = "Foundry deployments:";
  const problem = configProblem(ctx.config, "foundry", userConfigPath(ctx.cwd));
  if (problem) return [`${head} ${problem}.`];
  let endpoint: string;
  try {
    endpoint = foundryConfigFrom(ctx.config).endpoint;
  } catch {
    return [`${head} the Foundry endpoint is not set.`];
  }
  const resource = resourceFromEndpoint(endpoint);
  if (!resource) return [`${head} cannot derive the resource name from the endpoint host (expected <resource>.services.ai.azure.com or <resource>.openai.azure.com).`];
  const run = ctx.azure;
  const az = async (args: string[]) => {
    assertCommandSafe("az", args);
    return run(args);
  };
  let group = ctx.config.providers.foundry?.resourceGroup;
  if (!group) {
    const found = await az(["cognitiveservices", "account", "list", "--query", `[?name=='${resource}'].resourceGroup`, "-o", "tsv"]);
    if (found.code !== 0) return [`${head} ${azFailure(found)}`];
    group = found.stdout.split("\n").map((line) => line.trim()).find(Boolean);
    if (!group) return [`${head} no resource named ${resource} was found in your subscription. Set providers.foundry.resourceGroup in ${userConfigPath(ctx.cwd)}, or check az account show.`];
  }
  const listed = await az(["cognitiveservices", "account", "deployment", "list", "-g", group, "-n", resource, "-o", "json"]);
  if (listed.code !== 0) return [`${head} ${azFailure(listed)}`];
  const deployments = parseDeployments(listed.stdout);
  if (!deployments) return [`${head} az returned output that is not a deployment list.`];
  const lines = [`${head} ${deployments.length} on ${resource} (resource group ${group})`];
  for (const item of deployments) lines.push(`  ${item.name}: ${item.model}${item.version ? ` ${item.version}` : ""}`);
  const missing = missingDeployments(ctx.config, new Set(deployments.map((item) => item.name)));
  for (const item of missing) {
    const guess = deployments.find((candidate) => candidate.model === item.model || candidate.name === item.model);
    lines.push(
      `  Missing: foundry/${item.model}${item.deployment === item.model ? "" : ` → ${item.deployment}`} (used by ${item.tiers.join(", ")}) is not a deployment on ${resource}. Map it in ${userConfigPath(ctx.cwd)}: providers.foundry.deployments: { "${item.model}": "${guess?.name ?? deployments[0]?.name ?? "<your deployment name>"}" }`,
    );
  }
  if (missing.length === 0) lines.push("  Every Foundry entry in the tiers has a deployment.");
  return lines;
}
