import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WorkflowError } from "../domain.js";
import { redact } from "../redact.js";

const exec = promisify(execFile);

/** Refresh the token when it has less than this much life left. */
export const VERCEL_REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** A token without a readable `exp` is reused for this long after a successful pull. */
const UNKNOWN_EXPIRY_TTL_MS = 5 * 60 * 1000;
const TOKEN_VAR = "VERCEL_OIDC_TOKEN";

/** `exp` (ms since epoch) of a JWT, or undefined. The signature is not checked: Vercel does that. */
export function jwtExpiryMs(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Value of VERCEL_OIDC_TOKEN in dotenv text (quotes optional). */
export function tokenFromDotenv(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${TOKEN_VAR}\\s*=\\s*(.*?)\\s*$`));
    if (!match) continue;
    const value = match[1]!.replace(/^(["'])(.*)\1$/, "$2");
    if (value) return value;
  }
  return undefined;
}

export interface VercelTokenOptions {
  /** Directory that has been `vercel link`ed. Relative paths resolve from `root`. */
  projectDir?: string;
  /** File `vercel env pull` writes inside projectDir. Default .env.local. */
  envFile?: string;
  /** Project root used to resolve a relative projectDir. */
  root: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  readFile?: (file: string) => string | undefined;
  /** Runs `vercel` with an argument array and no shell. */
  run?: (args: string[], cwd: string) => Promise<void>;
}

export interface VercelStatus {
  status: "ready" | "expired" | "missing";
  detail: string;
  expiresAt?: string;
  /** A linked projectDir is configured, so a missing or old token is fixed by the next call. */
  refreshable?: boolean;
}

export interface VercelTokenSource {
  /** A token with at least ten minutes of life, refreshed through the Vercel CLI when needed. Never log it. */
  getToken(): Promise<string>;
  /** Passive check: does not run the CLI and never exposes the token. */
  status(): VercelStatus;
  /** Absolute path of the env file, for `!command` providers that read it. */
  envFilePath(): string | undefined;
}

export function createVercelTokenSource(options: VercelTokenOptions): VercelTokenSource {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const envFile = options.envFile ?? ".env.local";
  const dir = options.projectDir ? path.resolve(options.root, options.projectDir) : undefined;
  const file = dir ? path.join(dir, envFile) : undefined;
  const readFile =
    options.readFile ??
    ((target: string) => {
      try {
        return existsSync(target) ? readFileSync(target, "utf8") : undefined;
      } catch {
        return undefined;
      }
    });
  const run =
    options.run ??
    (async (args: string[], cwd: string) => {
      await exec("vercel", args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
    });
  let cached: { token: string; validUntil: number } | undefined;
  let pulling: Promise<void> | undefined;

  /** Token usable for at least the refresh margin, from the env var or the env file. */
  const fresh = (): { token: string; validUntil: number } | undefined => {
    const candidates = [env[TOKEN_VAR], file ? tokenFromDotenv(readFile(file) ?? "") : undefined];
    for (const token of candidates) {
      if (!token) continue;
      const exp = jwtExpiryMs(token);
      if (exp !== undefined && exp - VERCEL_REFRESH_MARGIN_MS > now()) return { token, validUntil: exp - VERCEL_REFRESH_MARGIN_MS };
    }
    return undefined;
  };

  return {
    envFilePath: () => file,
    status() {
      const hit = fresh();
      if (hit) return { status: "ready", detail: "Vercel OIDC token is present and valid.", expiresAt: new Date(hit.validUntil + VERCEL_REFRESH_MARGIN_MS).toISOString(), refreshable: !!dir };
      const stale = [env[TOKEN_VAR], file ? tokenFromDotenv(readFile(file) ?? "") : undefined].some(Boolean);
      if (dir) {
        return {
          status: stale ? "expired" : "missing",
          refreshable: true,
          detail: `${stale ? "Vercel token is expired or about to expire" : "No Vercel token found"}; it will be refreshed with \`vercel env pull ${envFile} --yes\` in ${dir}. Needs \`vercel login && vercel link\` once.`,
        };
      }
      return { status: stale ? "expired" : "missing", detail: "Set providers.vercel.projectDir to a linked project, or run `vercel login && vercel link`, then `vercel env pull`." };
    },
    async getToken() {
      if (cached && now() < cached.validUntil) return cached.token;
      const hit = fresh();
      if (hit) {
        cached = hit;
        return hit.token;
      }
      if (!dir || !file) {
        throw new WorkflowError("AUTH_MISSING", "Vercel token is missing or expiring. Set providers.vercel.projectDir to a project linked with `vercel link`.");
      }
      // One pull at a time: concurrent callers share it.
      pulling ??= run(["env", "pull", envFile, "--yes"], dir).finally(() => {
        pulling = undefined;
      });
      try {
        await pulling;
      } catch (error) {
        throw new WorkflowError("AUTH_EXPIRED", `\`vercel env pull\` failed: ${redact((error as Error).message).slice(0, 300)}. Run \`vercel login\` and \`vercel link\`.`);
      }
      const pulled = fresh();
      if (pulled) {
        cached = pulled;
        return pulled.token;
      }
      // A token with no readable expiry is accepted for a short while after a successful pull.
      const token = tokenFromDotenv(readFile(file) ?? "");
      if (token && jwtExpiryMs(token) === undefined) {
        cached = { token, validUntil: now() + UNKNOWN_EXPIRY_TTL_MS };
        return token;
      }
      throw new WorkflowError("AUTH_EXPIRED", `\`vercel env pull\` ran but ${envFile} has no valid ${TOKEN_VAR}. Run \`vercel login\` and \`vercel link\`.`);
    },
  };
}
