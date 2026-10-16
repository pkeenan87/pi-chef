import { configPaths, displayPath, foundryDeployment, type WorkflowConfig } from "../config.js";
import { isAccountProvider, type ProviderId } from "../domain.js";
import type { ProviderAuthView } from "./auth.js";
import { foundryConfigFrom } from "./runtime.js";

/** The slice of Pi's ModelRegistry that decides whether a model can be opened. Structural so tests can fake it. */
export interface UsableRegistry {
  find(provider: string, modelId: string): unknown;
  hasConfiguredAuth?(model: never): boolean;
}

/** The user config file, as shown in messages (`~/.pi/agent/chef.yaml`). */
export function userConfigPath(cwd: string): string {
  return displayPath(configPaths(cwd).userPath);
}

/**
 * Why a provider cannot be used from the config alone, or undefined. Foundry, Vercel, and local exist only when the user
 * config defines them (the account providers need no config block). The same words are used in route events, /status,
 * and stop messages.
 */
export function configProblem(config: WorkflowConfig, provider: ProviderId, userPath: string): string | undefined {
  if (isAccountProvider(provider)) return undefined;
  const block = config.providers[provider];
  if (!block) return `provider ${provider} is not registered (no providers.${provider} in ${userPath})`;
  if (provider === "foundry") {
    try {
      foundryConfigFrom(config);
    } catch {
      const env = block.endpointEnv ? ` or export ${block.endpointEnv}` : "";
      return `provider foundry is not registered (providers.foundry has no endpoint; set endpoint in ${userPath}${env})`;
    }
  }
  if (provider === "local" && !block.baseUrl) return `provider local is not registered (providers.local has no baseUrl; set baseUrl in ${userPath})`;
  return undefined;
}

/** Why the auth probe says a provider cannot be called, or undefined when it is ready. */
export function authProblem(view: ProviderAuthView): string | undefined {
  if (view.status === "ready") return undefined;
  const { provider } = view;
  if (isAccountProvider(provider)) {
    if (view.status === "missing") return `provider ${provider} has no login (run /login ${provider})`;
    if (view.status === "expired") return `provider ${provider} login has expired (run /login ${provider})`;
    return `provider ${provider} cannot be used: ${view.detail}`;
  }
  if (provider === "foundry") return `provider foundry has no Azure login (run az login)${view.detail && view.status !== "missing" ? `: ${view.detail}` : ""}`;
  if (provider === "vercel") return `provider vercel is not signed in: ${view.detail}`;
  return `provider ${provider} is not reachable: ${view.detail}`;
}

/** How the target is named in messages: the model, or the deployment it is mapped to. */
export function targetName(config: WorkflowConfig, provider: string, model: string): string {
  const id = provider === "foundry" ? foundryDeployment(config, model) : model;
  return id === model ? `model ${model}` : `deployment ${id} (mapped from ${model})`;
}

/**
 * Why Pi cannot open a candidate, or undefined. This is the /build preflight's test: Pi's registry must know the model
 * (for Foundry, under its deployment name) and hold usable credentials for it. Routing applies it to every candidate
 * whenever a registry is bound, so a model is never chosen that the preflight would then refuse.
 */
export function registryProblem(config: WorkflowConfig, registry: UsableRegistry, provider: string, model: string): string | undefined {
  const piId = provider === "foundry" ? foundryDeployment(config, model) : model;
  let known: unknown;
  try {
    known = piId ? registry.find(provider, piId) : undefined;
  } catch {
    known = undefined;
  }
  if (!known) return `${targetName(config, provider, model)} is not among the ${provider} provider's registered models`;
  if (typeof registry.hasConfiguredAuth === "function") {
    let signedIn = false;
    try {
      signedIn = registry.hasConfiguredAuth(known as never);
    } catch {
      signedIn = false;
    }
    if (!signedIn) return isAccountProvider(provider) ? `provider ${provider} has no login (run /login ${provider})` : `provider ${provider} has no usable credentials in Pi`;
  }
  return undefined;
}
