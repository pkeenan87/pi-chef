const PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b(api[_-]?key|secret|password|token|refresh)\s*[:=]\s*["']?[^\s"',}]+/gi,
  /\b(AZURE_OPENAI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*=\s*\S+/g,
];

export function redact(value: string): string {
  let next = value;
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    next = next.replace(pattern, "[REDACTED]");
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
