/** The slice of Pi's ModelRegistry that decides whether a model can be opened. Structural so tests can fake it. */
export interface UsableRegistry {
  find(provider: string, modelId: string): unknown;
  hasConfiguredAuth?(model: never): boolean;
}

/**
 * Why Pi cannot open a model, or undefined. This is the /build preflight's test: Pi's registry must know the model and
 * hold usable credentials for it. Routing applies it to the model it picks whenever a registry is bound, so a model is
 * never chosen that the preflight would then refuse.
 */
export function registryProblem(registry: UsableRegistry, provider: string, model: string): string | undefined {
  let known: unknown;
  try {
    known = model ? registry.find(provider, model) : undefined;
  } catch {
    known = undefined;
  }
  if (!known) return `model ${model} is not among the ${provider} provider's registered models`;
  if (typeof registry.hasConfiguredAuth === "function") {
    let signedIn = false;
    try {
      signedIn = registry.hasConfiguredAuth(known as never);
    } catch {
      signedIn = false;
    }
    if (!signedIn) return `provider ${provider} has no login or key in Pi (run /login ${provider})`;
  }
  return undefined;
}
