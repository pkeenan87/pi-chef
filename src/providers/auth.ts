import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WorkflowError, type ProviderId } from "../domain.js";
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
  provider: "openai" | "anthropic",
  credential: StoredCredential | undefined,
  now: number,
): ProviderAuthView {
  if (!credential) {
    return { provider, status: "missing", method: "none", detail: "No stored Pi credential. Run /login and choose account sign-in." };
  }
  if (credential.type === "api_key") {
    return {
      provider,
      status: "blocked",
      method: "api-key",
      detail: "API key credentials are rejected. Sign in with the provider account. There is no API-key fallback.",
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
      /** Passive Vercel token check (see createVercelTokenSource().status). */
      vercel?: () => { status: "ready" | "expired" | "missing"; detail: string; expiresAt?: string; refreshable?: boolean };
    } = {},
  ) {}

  async inspect(provider: ProviderId): Promise<ProviderAuthView> {
    const now = this.options.now?.() ?? Date.now();
    if (provider === "openai" || provider === "anthropic") {
      const file = this.options.authFile ?? path.join(homedir(), ".pi", "agent", "auth.json");
      let stored: Record<string, StoredCredential> = {};
      try {
        stored = this.readStored(file);
      } catch {
        return { provider, status: "unavailable", method: "none", detail: "auth.json could not be read." };
      }
      if (provider === "anthropic") return viewFromCredential("anthropic", stored.anthropic, now);
      const openai = viewFromCredential("openai", stored.openai, now);
      if (openai.status === "ready") return openai;
      const codex = viewFromCredential("openai", stored["openai-codex"], now);
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
      const view = this.options.vercel();
      // An expired or missing token is refreshed by `vercel env pull` on the next call when a project is linked.
      const refreshable = view.status !== "ready" && view.refreshable === true;
      return {
        provider,
        status: view.status === "ready" || refreshable ? "ready" : view.status === "expired" ? "expired" : "missing",
        method: "vercel-cli",
        detail: view.detail,
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

export function assertCallable(view: ProviderAuthView): void {
  if (view.status === "ready") return;
  if (view.status === "expired") {
    throw new WorkflowError("AUTH_EXPIRED", view.detail);
  }
  if (view.method === "api-key") {
    throw new WorkflowError("API_KEY_REJECTED", `API key credentials are rejected. ${view.detail}`);
  }
  if (view.status === "blocked") {
    throw new WorkflowError("API_KEY_REJECTED", view.detail);
  }
  throw new WorkflowError("AUTH_MISSING", view.detail);
}
