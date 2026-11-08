// Pure helpers of the chef-config panel (no herdr imports, so tests can load them).

// Sections whose scalar keys get controls. approvals, tiers, providers, pricing and quota stay read-only.
const EDIT_SECTIONS = new Set(["Top level", "session", "localMode", "workers", "budgets", "routing", "review", "advisors"]);
const SCALARS = new Set(["bool", "enum", "int", "number", "usd", "ms", "string", "path", "modelRef"]);
export const NUMERIC = new Set(["int", "number", "usd", "ms"]);

// A key is editable when it is one scalar of an editable section (no list rows, no tiers.*, no wildcards), not
// approvals.* and not a fixed key.
export function editable(s) {
  return !!s && EDIT_SECTIONS.has(s.section) && SCALARS.has(s.type) && s.rule !== "fixed"
    && !/[\[\]*]/.test(s.key) && !s.key.startsWith("approvals.");
}

// Same rule as the CLI (projectMaySet): a project file may not hold user-only or fixed keys. The provider-location
// exception does not apply to the scalar sections handled here.
export function projectProblem(s) {
  if (s.rule === "user-only") return "user-only: pi-chef ignores it in a project file";
  if (s.rule === "fixed") return "fixed: it cannot be changed";
  return null;
}

// Cheap guard against sending a secret: the CLI refuses them too, but nothing secret should reach even an argv.
export function looksSecret(text, type) {
  const v = String(text).trim();
  if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(v)) return true;
  if (/\b(sk|pk|rk|xai|ghp|gho|ghs|github_pat|xox[abp]|AKIA|AIza)[-_][A-Za-z0-9_-]{12,}/.test(v)) return true;
  if (/^(bearer|basic)\s+\S{8,}/i.test(v)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(v)) return true;
  // The generic long-token rule skips paths and provider/id values, which are legitimately long and slash-separated.
  if (type !== "path" && type !== "modelRef" && /^[A-Za-z0-9+_=-]{32,}$/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v)) return true;
  return false;
}

// The --value for a scalar: numbers and booleans bare, every string as a JSON (so YAML double-quoted) scalar.
export function valueArg(s, text) {
  if (s.type === "bool") return text === "true" || text === "false" ? text : null;
  if (NUMERIC.has(s.type)) {
    const t = String(text).trim();
    if (t === "" || !Number.isFinite(Number(t))) return null;
    if (s.type !== "number" && s.type !== "usd" && !Number.isInteger(Number(t))) return null;
    return String(Number(t));
  }
  return JSON.stringify(String(text));
}

export function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
export function plain(v) { return v === undefined || v === null ? "" : typeof v === "string" ? v : String(v); }
