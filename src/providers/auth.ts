import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Billing } from "../config.js";
import { isAccountProvider, type AccountProvider, type ProviderId } from "../domain.js";
import { redact } from "../redact.js";

export type AuthStatus = "ready" | "missing" | "expired" | "blocked" | "unavailable";

export interface ProviderAuthView {
  provider: ProviderId;
  status: AuthStatus;
  method: "oauth" | "azure-cli" | "vercel-cli" | "local" | "api-key" | "none";
  detail: string;
  expiresAt?: string;
}

export interface AuthProbe {
  inspect(provider: ProviderId): Promise<ProviderAuthView>;
}

interface StoredCredential {
  type?: string;
  expires?: number | string;
}

function parseExpiry(expires: number | string | undefined): number | undefined {
  if (typeof expires === "number") return expires;
  if (typeof expires === "string") {
    const parsed = Date.parse(expires);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function viewFromCredential(
  provider: AccountProvider,
  credential: StoredCredential | undefined,
  now: number,
  apiKeyFallback = false,
): ProviderAuthView {
  if (!credential) {
    return { provider, status: "missing", method: "none", detail: "No stored Pi credential. Run /login and choose account sign-in." };
  }
  if (credential.type === "api_key" && apiKeyFallback) {
    return { provider, status: "ready", method: "api-key", detail: "API key stored in Pi (allowed by providers." + provider + ".apiKeyFallback). Billed per token." };
  }
  if (credential.type === "api_key") {
    return {
      provider,
      status: "blocked",
      method: "api-key",
      detail: `API key credentials are rejected. Sign in with the ${provider} account, or allow the key with providers.${provider}.apiKeyFallback: true in ~/.pi/agent/chef.yaml (billed per token).`,
    };
  }
  if (credential.type !== "oauth") {
    return { provider, status: "blocked", method: "none", detail: `Unsupported credential type ${credential.type ?? "unknown"}.` };
  }
  const expires = parseExpiry(credential.expires);
  if (expires !== undefined && expires <= now) {
    return {
      provider,
      status: "expired",
      method: "oauth",
      detail: "Account session expired. Re-run /login. The workflow is paused and will not use an API key.",
      expiresAt: new Date(expires).toISOString(),
    };
  }
  return {
    provider,
    status: "ready",
    method: "oauth",
    detail: "Account login is present.",
    expiresAt: expires === undefined ? undefined : new Date(expires).toISOString(),
  };
}

export function readAuthFile(file: string): Record<string, StoredCredential> {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, StoredCredential>;
  const meta: Record<string, StoredCredential> = {};
  for (const [provider, credential] of Object.entries(parsed)) {
    if (!credential || typeof credential !== "object") continue;
    meta[provider] = { type: credential.type, expires: credential.expires };
  }
  return meta;
}

/** How long a successful `az account show` is reused (ms). */
export const AZURE_SESSION_TTL_MS = 60_000;

export class FileAuthProbe implements AuthProbe {
  private fileCache?: { file: string; mtimeMs: number; size: number; stored: Record<string, StoredCredential> };
  private azureReady?: { at: number };

  /** auth.json is re-read only when its mtime or size changes. */
  private readStored(file: string): Record<string, StoredCredential> {
    let stat: { mtimeMs: number; size: number } | undefined;
    try {
      stat = statSync(file);
    } catch {
      stat = undefined;
    }
    if (!stat) {
      this.fileCache = undefined;
      return readAuthFile(file);
    }
    const cached = this.fileCache;
    if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.stored;
    const stored = readAuthFile(file);
    this.fileCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, stored };
    return stored;
  }

  constructor(
    private readonly options: {
      authFile?: string;
      now?: () => number;
      azure?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
      localReachable?: () => Promise<boolean>;
      /** Account providers whose Pi-stored API key may be used when no account login is present. */
      apiKeyFallback?: (provider: AccountProvider) => boolean;
      /** Passive Vercel token check (see createVercelTokenSource().status). */
      vercel?: () => { status: "ready" | "expired" | "missing"; detail: string; expiresAt?: string; refreshable?: boolean };
      /** Refreshes the Vercel token file (`vercel env pull`); called when the token is missing or expiring and a project is linked. */
      vercelRefresh?: () => Promise<unknown>;
    } = {},
  ) {}

  private authFile(): string {
    return this.options.authFile ?? path.join(homedir(), ".pi", "agent", "auth.json");
  }

  /** How an account provider is billed right now, from the credential Pi has stored for it. */
  billing(provider: string): Billing {
    if (!isAccountProvider(provider)) return "subscription";
    try {
      const stored = this.readStored(this.authFile());
      // The same credential `inspect` picks: openai first when it is usable, else the legacy openai-codex login.
      const now = this.options.now?.() ?? Date.now();
      const allow = this.options.apiKeyFallback?.(provider) ?? false;
      const useCodex = provider === "openai" && viewFromCredential("openai", stored.openai, now, allow).status !== "ready" && viewFromCredential("openai", stored["openai-codex"], now, allow).status === "ready";
      const credential = useCodex ? stored["openai-codex"] : stored[provider];
      return credential?.type === "api_key" ? "api-key" : "subscription";
    } catch {
      return "subscription";
    }
  }

  async inspect(provider: ProviderId): Promise<ProviderAuthView> {
    const now = this.options.now?.() ?? Date.now();
    if (isAccountProvider(provider)) {
      let stored: Record<string, StoredCredential> = {};
      try {
        stored = this.readStored(this.authFile());
      } catch {
        return { provider, status: "unavailable", method: "none", detail: "auth.json could not be read." };
      }
      const allow = this.options.apiKeyFallback?.(provider) ?? false;
      if (provider !== "openai") return viewFromCredential(provider, stored[provider], now, allow);
      const openai = viewFromCredential("openai", stored.openai, now, allow);
      if (openai.status === "ready") return openai;
      const codex = viewFromCredential("openai", stored["openai-codex"], now, allow);
      if (codex.status === "ready") return { ...codex, detail: "Legacy openai-codex account login is present." };
      if (openai.status === "expired" || codex.status === "expired") return openai.status === "expired" ? openai : codex;
      if (openai.status === "blocked" || codex.status === "blocked") return openai.status === "blocked" ? openai : codex;
      return openai;
    }
    if (provider === "foundry") {
      if (!this.options.azure) {
        return { provider, status: "unavailable", method: "azure-cli", detail: "Azure CLI probe is not configured." };
      }
      if (this.azureReady && now - this.azureReady.at < AZURE_SESSION_TTL_MS) {
        return { provider, status: "ready", method: "azure-cli", detail: "Azure CLI session is present." };
      }
      const result = await this.options.azure(["account", "show", "-o", "json"]);
      if (result.code !== 0) {
        this.azureReady = undefined;
        return {
          provider,
          status: "missing",
          method: "azure-cli",
          detail: redact(result.stderr || "az account show failed. Run az login."),
        };
      }
      this.azureReady = { at: now };
      return { provider, status: "ready", method: "azure-cli", detail: "Azure CLI session is present." };
    }
    if (provider === "vercel") {
      if (!this.options.vercel) {
        return { provider, status: "unavailable", method: "vercel-cli", detail: "Vercel is not configured. Add providers.vercel and run `vercel login && vercel link`." };
      }
      let view = this.options.vercel();
      // A missing or expiring token is refreshed now (`vercel env pull`) when a project is linked: Pi reads the file it writes.
      let refreshError: string | undefined;
      if (view.status !== "ready" && view.refreshable === true && this.options.vercelRefresh) {
        try {
          await this.options.vercelRefresh();
        } catch (error) {
          refreshError = redact((error as Error).message);
        }
        view = this.options.vercel();
      }
      return {
        provider,
        status: view.status === "ready" ? "ready" : view.status === "expired" ? "expired" : "missing",
        method: "vercel-cli",
        detail: refreshError ?? view.detail,
        expiresAt: view.expiresAt,
      };
    }
    if (this.options.localReachable) {
      const ok = await this.options.localReachable();
      return ok
        ? { provider, status: "ready", method: "local", detail: "Local endpoint responded." }
        : { provider, status: "unavailable", method: "local", detail: "Local endpoint is not reachable." };
    }
    return { provider, status: "unavailable", method: "local", detail: "Local reachability probe is not configured." };
  }
}
