const KEY_WORD = String.raw`(?:api[_-]?key|apikey|secret|password|passwd|pwd|token|refresh(?:[_-]?token)?|credentials?|private[_-]?key|access[_-]?key)`;

const PATTERNS: RegExp[] = [
  // PEM private keys, including truncated blocks with no END line.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{10,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{10,}/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}/g,
  // JWTs: header.payload.signature (signature may be empty for unsigned tokens).
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  // Azure SAS signature and storage / service bus connection string secrets.
  /(?<![A-Za-z0-9_])sig=[A-Za-z0-9%+/=_-]{8,}/g,
  /(?<![A-Za-z0-9_])(?:AccountKey|SharedAccessKey|SharedAccessSignature)\s*=\s*[^;\s"']+/gi,
  // Authorization headers of any scheme, and bare bearer tokens.
  /\bAuthorization\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+[^\s"',}]+/gi,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/gi,
  // Credentials embedded in URLs: scheme://user:pass@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s@/"']+@/gi,
  // key = value / key: value / "key": "value", with optional prefix such as DB_ or client_.
  new RegExp(
    String.raw`(?<![A-Za-z0-9])["']?[A-Za-z0-9_.-]{0,40}${KEY_WORD}["']?\s*[:=]\s*["']?[^\s"',}]+`,
    "gi",
  ),
];

function replacement(match: string): string {
  const url = /^([a-z][a-z0-9+.-]*:\/\/)[^\s:/@"']+:[^\s@/"']+@$/i.exec(match);
  return url ? `${url[1]}[REDACTED]@` : "[REDACTED]";
}

export function redact(value: string): string {
  let next = value;
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    next = next.replace(pattern, replacement);
  }
  return next;
}
export function containsSecret(value: string): boolean {
  return redact(value) !== value;
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = redactUnknown(inner);
    }
    return out;
  }
  return value;
}
