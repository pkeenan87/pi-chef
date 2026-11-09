// Pure helpers of the chef-config panel (no herdr imports, so tests can load them).

// Cheap guard against sending a secret: the CLI refuses them too, but nothing secret should reach even an argv.
export function looksSecret(text) {
  const v = String(text).trim();
  if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(v)) return true;
  if (/\b(sk|pk|rk|xai|ghp|gho|ghs|github_pat|xox[abp]|AKIA|AIza)[-_][A-Za-z0-9_-]{12,}/.test(v)) return true;
  if (/^(bearer|basic)\s+\S{8,}/i.test(v)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(v)) return true;
  return false;
}

// The models.* value for a kind and what was entered: { value } or { error }. The CLI validates again with the real parser.
export function modelValue(kind, parts) {
  const clean = (s) => String(s ?? "").trim();
  let value;
  if (kind === "local") {
    const id = clean(parts.localId);
    if (!id) return { error: "Pick a local model." };
    value = "local/" + id;
  } else if (kind === "agent") {
    const name = clean(parts.agent);
    if (!name) return { error: "Pick an agent." };
    const model = clean(parts.agentModel);
    if (/\s/.test(model)) return { error: "An agent model has no spaces." };
    value = "agent:" + name + (model ? "/" + model : "");
  } else {
    value = clean(parts.piText);
    if (!value) return { error: "Enter provider/id, for example anthropic/claude-sonnet-5-5." };
    if (/\s/.test(value) || value.indexOf("/") < 1 || value.endsWith("/")) return { error: "Use provider/id, for example anthropic/claude-sonnet-5-5." };
  }
  if (looksSecret(value)) return { error: "That looks like a secret. pi-chef config never holds secrets; nothing was sent." };
  return { value };
}

// The parts a click on agent `name` saves for a models row: another agent drops the model text (a model id belongs to one
// agent's CLI), the agent already chosen keeps it.
export function agentPick(row, name) {
  return row.kind === "agent" && row.agent === name ? { agent: name } : { agent: name, agentModel: "" };
}

// "$4.05", "$0.0042" for small amounts, "$0" for none.
export function fmtUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return "$" + n.toFixed(4);
  if (Math.abs(n) >= 100) return "$" + Math.round(n);
  return "$" + n.toFixed(2);
}

// How much of a limit is spent, 0 to 1.
export function ratio(spend, limit) {
  if (!(limit > 0) || !(spend > 0)) return 0;
  return Math.min(1, spend / limit);
}

// 131072 -> "128k"; small numbers as they are.
export function ctxText(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return n >= 1024 ? Math.round(n / 1024) + "k" : String(n);
}

export function ticketsText(plan) {
  const failed = plan.ticketsFailed > 0 ? ", " + plan.ticketsFailed + " failed" : "";
  return plan.ticketsDone + "/" + plan.ticketsTotal + " tickets" + failed;
}

// What an exec of the CLI gives back as one document: the JSON it printed, or an { ok: false, error }.
export function parseResult(r) {
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  if (json && typeof json === "object") return json;
  return { ok: false, error: "chef-config printed no JSON (exit " + r.code + "): " + String(r.stderr || r.stdout || "").trim().slice(0, 300) };
}

// The CLI argv (after its own command prefix) for a user-file write; `sha` is the file's sha256 from the last show.
export function setArgv(root, key, value, sha) {
  return ["set", "--cwd", root, "--key", key, "--value", String(value), ...(sha ? ["--expect", sha] : [])];
}

// The text of an input for a number: no trailing zeros.
export function numberText(n) {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "";
}

// A positive number from input text, or null.
export function positive(text) {
  const t = String(text).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}
