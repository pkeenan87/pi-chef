// chef-config: a herdr side panel for pi-chef. Four collapsible sections: the model for each ticket difficulty
// (Pi model, local model or external agent), the local model server, the plans of the project, and what they cost.
// Everything is read and written through the pi-chef CLI named in install.json (written by `npm run herdr:install`):
// `show` for the data, `set` / `local-add` / `local-remove` / `plan-activate` / `plan-close` for changes. Writes to the
// user config carry --expect with the file's sha256 from the last show. This mod never writes a file itself and never
// logs a value.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, NumberInput } from "gpui-base";
import { exec, props, focused, spaces, theme, appHome, home, readTextFile, watchFolder } from "herdr";
import { agentPick, ctxText, fmtUsd, modelValue, numberText, parseResult, positive, ratio, setArgv, ticketsText } from "./lib.js";

const REFRESH_MS = 8000;
const MODEL_KEYS = ["low", "medium", "high", "review"];
const KINDS = [["pi", "Pi"], ["local", "Local"], ["agent", "Agent"]];
const SECTIONS = [["models", "Models"], ["local", "Local model"], ["plans", "Plans"], ["costs", "Costs"]];

export default class ChefConfig extends View {
  init(_props, cx) {
    this.root = null;
    this.start = null;
    this.data = null;
    this.failure = null;
    this.loading = false;
    this.pending = false;
    this.watching = new Set();
    this.wanted = new Set();
    this.files = new Set();
    this.notes = {};            // note key -> { kind: "ok" | "warn" | "err", text, needsForce? }
    this.busy = new Set();      // note keys with a CLI call in flight
    this.draft = {};            // model key -> { kind }: a kind picked but not saved yet
    this.detected = null;       // the last local-detect result
    this.detectedFor = null;    // the root it was run for (the first load of a root detects once)
    this.scope = "today";       // costs breakdown: "today" | "plan"
    this.seq = 0;               // bumped by every write; a load that started earlier is dropped
    try { this.collapsed = JSON.parse(localStorage.getItem("collapsed") ?? "{}"); } catch { this.collapsed = {}; }
    this.inputs = {};           // name -> { state, synced, focused }; made once, here, never in render
    for (const k of MODEL_KEYS) {
      this.field(`pi:${k}`, "provider/id");
      this.field(`am:${k}`, "model (blank = agent default)");
    }
    this.field("base", "http://127.0.0.1:8080/v1");
    this.field("ctx", "context window", true);
    this.field("taskUsd", "20", true);
    this.field("dailyUsd", "75", true);
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  field(name, placeholder, numeric) {
    const state = InputState.new({ placeholder });
    if (numeric) { state.set_step(1); state.set_min(0); }
    const slot = this.inputs[name] = { state, synced: "", focused: false };
    state.on("focus", () => { slot.focused = true; });
    state.on("blur", (_e, cx) => { slot.focused = false; this.commit(name, cx); });
    state.on("submit", (_e, cx) => this.commit(name, cx));
  }

  text(name) { return this.inputs[name].state.value(); }

  // The input follows the saved value unless the person is typing in it.
  follow(name, text) {
    const slot = this.inputs[name];
    if (!slot || slot.focused || slot.synced === text) return;
    slot.state.set_value(text);
    slot.synced = text;
  }

  syncInputs() {
    const d = this.data;
    if (!d) return;
    for (const k of MODEL_KEYS) {
      const row = d.models[k];
      this.follow(`pi:${k}`, row.kind === "pi" ? row.value : "");
      this.follow(`am:${k}`, row.kind === "agent" ? (row.agentModel ?? "") : "");
    }
    if (d.local.configured) this.follow("base", d.local.baseUrl);
    this.follow("taskUsd", numberText(d.budgets.taskUsd));
    this.follow("dailyUsd", numberText(d.budgets.dailyUsd));
  }

  // ---- loading

  location() {
    const forced = props()?.folder;
    const cwd = focused()?.cwd;
    if (forced) return forced;
    if (cwd) return cwd;
    // The panel itself has the keyboard (no cwd): keep the project it showed rather than flip to the space's folder.
    if (this.start) return this.start;
    return spaces().find((sp) => sp.active)?.folder || home();
  }

  // One load at a time; a request during a load queues exactly one more.
  refresh(cx) {
    this.start = this.location();
    if (this.loading) { this.pending = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      do {
        this.pending = false;
        try {
          await this.load(cx);
          this.watch(cx);
        } catch (e) {
          this.failure = String(e?.message ?? e);
        }
        if (!this.pending) this.loading = false;
        cx.notify();
      } while (this.pending);
    });
  }

  async load(cx) {
    const raw = await readTextFile(`${appHome()}/mods/chef-config/install.json`);
    if (!raw) { this.failure = "install.json is missing: run `npm run herdr:install` in the pi-chef checkout."; return; }
    const cli = JSON.parse(raw).cli;
    if (!Array.isArray(cli) || cli.length === 0) { this.failure = "install.json has no `cli` argv array: run `npm run herdr:install` again."; return; }
    this.cli = cli;
    const start = this.start;
    if (!start) { this.failure = "No project folder: open the panel from a space with a folder."; return; }
    let root = start;
    try {
      const g = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: start });
      if (g.code === 0 && g.stdout.trim()) root = g.stdout.trim();
    } catch { /* not a repo: use the folder itself */ }
    const mine = this.seq;
    const json = await this.call(["show", "--cwd", root]);
    if (mine !== this.seq || this.busy.size > 0) return; // a write finished or is running: its result is newer
    if (json.ok === false) { this.failure = json.error ?? "chef-config failed"; return; }
    this.failure = null;
    if (root !== this.root) { this.root = root; this.notes = {}; this.draft = {}; this.detected = null; }
    this.data = json;
    for (const key of Object.keys(this.notes)) if (this.notes[key].kind === "ok") delete this.notes[key];
    this.syncInputs();
    if (json.local.configured && this.detectedFor !== root) { this.detectedFor = root; this.detect(cx, true); }
  }

  async call(args) {
    try {
      return parseResult(await exec(this.cli[0], [...this.cli.slice(1), ...args], { timeout: 60000 }));
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // Refresh when the user config or the plans / ledger change. Only the user file counts in ~/.pi/agent (it holds Pi's sessions too).
  watch(cx) {
    const f = this.data?.files;
    if (!f) return;
    const dirs = new Map([[f.user.path.slice(0, f.user.path.lastIndexOf("/")), f.user.path], [f.workspace, null]]);
    this.wanted = new Set(dirs.keys());
    this.files = new Set([f.user.path]);
    for (const [dir, only] of dirs) {
      if (this.watching.has(dir)) continue;
      this.watching.add(dir);
      cx.spawn(async (cx) => {
        try {
          while (this.wanted.has(dir)) {
            const changed = await watchFolder(dir);
            if (!this.wanted.has(dir)) break;
            // Anything but a non-empty list of paths (a missing folder, say) would spin: the timer covers it.
            if (!Array.isArray(changed) || changed.length === 0) break;
            const abs = (p) => (p.startsWith("/") ? p : `${dir}/${p}`);
            if (only === null || changed.some((p) => p === dir || abs(p) === only)) this.refresh(cx);
          }
        } catch { /* cannot watch here: the timer covers it */ }
        this.watching.delete(dir);
      });
    }
  }

  // ---- writes

  // Runs one CLI call that changes something. `noteKey` says where its outcome shows. The answer is a fresh `show`.
  mutate(noteKey, args, cx, done) {
    if (!this.root || !this.cli || this.busy.has(noteKey)) return;
    this.busy.add(noteKey);
    delete this.notes[noteKey];
    cx.notify();
    cx.spawn(async (cx) => {
      const json = await this.call(args);
      this.seq++;
      this.busy.delete(noteKey);
      if (json.ok === false) {
        this.notes[noteKey] = { kind: "err", text: json.error ?? "chef-config refused the change", needsForce: json.needsForce === true };
        if (/changed since it was read/.test(json.error ?? "")) this.refresh(cx);
      } else {
        if (Array.isArray(json.plans)) { this.data = json; this.syncInputs(); }
        this.notes[noteKey] = { kind: json.note ? "warn" : "ok", text: json.note ?? "Saved." };
        if (done) done(json, cx);
      }
      cx.notify();
    });
  }

  note(key, kind, text, cx) { this.notes[key] = { kind, text }; cx.notify(); }

  sha() { return this.data?.files?.user?.sha256; }

  commit(name, cx) {
    const d = this.data;
    if (!d) return;
    const [kind, key] = name.split(":");
    if (kind === "pi") this.saveModel(key, "pi", {}, cx);
    else if (kind === "am") {
      const row = d.models[key];
      // A model for the agent already chosen; with none chosen yet, it is read when one is picked.
      if (row.kind === "agent" && this.text(name) !== (row.agentModel ?? "")) this.saveModel(key, "agent", { agent: row.agent }, cx);
    } else if (name === "base") this.saveBase(cx);
    else if (name === "taskUsd" || name === "dailyUsd") this.saveBudget(name, cx);
  }

  saveModel(key, kind, pick, cx) {
    const row = this.data.models[key];
    const parts = { piText: this.text(`pi:${key}`), agentModel: this.text(`am:${key}`), ...pick };
    const r = modelValue(kind, parts);
    if (r.error) {
      // Leaving an empty Pi field alone while another kind is saved is not an error.
      if (kind === "pi" && parts.piText.trim() === "" && row.kind !== "pi") return;
      this.note(`m:${key}`, "err", r.error, cx);
      return;
    }
    if (r.value === row.value) { delete this.notes[`m:${key}`]; cx.notify(); return; }
    this.mutate(`m:${key}`, setArgv(this.root, `models.${key}`, r.value, this.sha()), cx, () => { delete this.draft[key]; });
  }

  saveBudget(name, cx) {
    const n = positive(this.text(name));
    const saved = this.data.budgets[name];
    if (n === null) {
      this.note("budgets", "err", "Enter a dollar amount greater than 0.", cx);
      this.inputs[name].synced = "";
      this.follow(name, numberText(saved));
      return;
    }
    if (n === saved) return;
    this.mutate("budgets", setArgv(this.root, `budgets.${name}`, String(n), this.sha()), cx);
  }

  saveBase(cx) {
    const d = this.data;
    const url = this.text("base").trim();
    if (!d.local.configured || url === d.local.baseUrl) return;
    if (url === "") { this.follow("base", d.local.baseUrl); return; }
    this.mutate("local", setArgv(this.root, "local.baseUrl", url, this.sha()), cx, (_j, cx) => this.detect(cx, true));
  }

  preset(url, cx) {
    this.inputs.base.state.set_value(url);
    if (this.data.local.configured) this.saveBase(cx);
    else cx.notify();
  }

  detect(cx, quiet) {
    const url = this.text("base").trim() || this.data?.local?.baseUrl || "";
    if (!url) { if (!quiet) this.note("local", "err", "Enter the server URL or pick a preset first.", cx); return; }
    if (this.busy.has("detect")) return;
    this.busy.add("detect");
    cx.notify();
    cx.spawn(async (cx) => {
      const json = await this.call(["local-detect", "--base-url", url, "--cwd", this.root]);
      this.busy.delete("detect");
      this.detected = json;
      if (json.ok !== false && json.reachable && json.baseUrl !== url && !this.inputs.base.focused) this.inputs.base.state.set_value(json.baseUrl);
      cx.notify();
    });
  }

  addLocal(m, cx) {
    const ctx = m.contextWindow ?? positive(this.text("ctx"));
    if (!ctx) { this.note("local", "err", "The server did not report a context window: enter one below.", cx); return; }
    const args = ["local-add", "--cwd", this.root, "--id", m.id, "--context-window", String(Math.round(ctx))];
    const url = this.detected?.baseUrl || this.text("base").trim();
    if (url) args.push("--base-url", url);
    if (this.sha()) args.push("--expect", this.sha());
    this.mutate("local", args, cx, (_j, cx) => this.detect(cx, true));
  }

  removeLocal(id, cx) {
    const args = ["local-remove", "--cwd", this.root, "--id", id];
    if (this.sha()) args.push("--expect", this.sha());
    this.mutate("local", args, cx, (_j, cx) => this.detect(cx, true));
  }

  activate(id, cx) { this.mutate(`p:${id}`, ["plan-activate", "--cwd", this.root, "--id", id], cx); }
  closePlan(id, force, cx) { this.mutate(`p:${id}`, ["plan-close", "--cwd", this.root, "--id", id, ...(force ? ["--force"] : [])], cx); }

  toggle(id, cx) {
    this.collapsed[id] = !this.collapsed[id];
    try { localStorage.setItem("collapsed", JSON.stringify(this.collapsed)); } catch { /* not persisted */ }
    cx.notify();
  }

  // ---- pieces

  button(id, label, t, { selected, disabled, onClick }) {
    return div().id(id).px(7).py(2).rounded(4).text_size(11).flex_none()
      .bg(selected ? t.selected : t.raised)
      .text_color(disabled ? t.dim : selected ? t.foreground : t.muted)
      .when(!disabled, (el) => el.hover((s) => s.bg(t.hover)).on_click(onClick))
      .child(label);
  }

  input(name, t, busy) {
    return Input.new(this.inputs[name].state).disabled(!!busy).h(26).px(7).items_center().rounded(4).border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12);
  }

  numberInput(name, t, busy, onStep) {
    return div().w(96).child(NumberInput.new(this.inputs[name].state).disabled(!!busy)
      .on_step((action, cx) => onStep(action === "increment" ? 1 : -1, cx))
      .controls_right()
      .decrement_button(div().px(5).text_size(12).child("−"))
      .increment_button(div().px(5).text_size(12).child("+")));
  }

  stepBudget(name, dir, cx) {
    const cur = positive(this.text(name)) ?? this.data.budgets[name];
    const next = Math.max(0, Math.round((cur + dir) * 100) / 100);
    this.inputs[name].state.set_value(String(next));
    this.saveBudget(name, cx);
  }

  noteLine(key, t) {
    const n = this.notes[key];
    if (!n) return div();
    const color = { ok: t.done, warn: t.working, err: t.blocked }[n.kind];
    return div().text_size(11).text_color(color).child(n.text);
  }

  section(id, title, summary, body, t) {
    const open = !this.collapsed[id];
    return v_flex().id(`sec-${id}`).border_b(1).border_color(t.border)
      .child(h_flex().id(`sec-head-${id}`).gap(6).px(10).py(7).items_center().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggle(id, cx))
        .child(div().w(10).text_size(10).text_color(t.dim).child(open ? "▾" : "▸"))
        .child(div().font_semibold().text_size(12).child(title))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(summary.color ?? t.dim).child(summary.text ?? "")))
      .when(open, (el) => el.child(v_flex().gap(8).px(10).pb(10).child(body)));
  }

  // ---- models

  modelRow(key, t) {
    const d = this.data;
    const row = d.models[key];
    const kind = this.draft[key]?.kind ?? row.kind;
    const busy = this.busy.has(`m:${key}`);
    const unsaved = kind !== row.kind;
    let editor;
    if (kind === "pi") {
      editor = this.input(`pi:${key}`, t, busy);
    } else if (kind === "local") {
      const ids = d.local.models.map((m) => m.id);
      editor = ids.length === 0
        ? div().text_size(11).text_color(t.dim).child("No local models yet: add one under Local model.")
        : h_flex().gap(4).flex_wrap().children(ids.map((id) => this.button(`lm-${key}-${id}`, id, t, {
          selected: row.kind === "local" && row.id === id, disabled: busy,
          onClick: (_e, cx) => this.saveModel(key, "local", { localId: id }, cx),
        })));
    } else {
      editor = v_flex().gap(4)
        .child(h_flex().gap(4).flex_wrap().children(d.agents.map((name) => this.button(`ag-${key}-${name}`, name, t, {
          selected: row.kind === "agent" && row.agent === name, disabled: busy,
          onClick: (_e, cx) => {
            const pick = agentPick(row, name);
            // A model typed for the earlier agent is cleared with the change, in the field too.
            const slot = this.inputs[`am:${key}`];
            if (pick.agentModel === "" && slot) { slot.state.set_value(""); slot.synced = ""; }
            this.saveModel(key, "agent", pick, cx);
          },
        }))))
        .child(this.input(`am:${key}`, t, busy));
    }
    const what = kind === "pi" ? "a model" : kind === "local" ? "a local model" : "an agent";
    return v_flex().id(`model-${key}`).gap(4)
      .child(h_flex().gap(6).items_center()
        .child(div().w(50).font_semibold().text_size(12).child(key))
        .child(h_flex().gap(3).children(KINDS.map(([id, label]) => this.button(`kind-${key}-${id}`, label, t, {
          selected: kind === id, disabled: false,
          onClick: (_e, cx) => { if (id === row.kind) delete this.draft[key]; else this.draft[key] = { kind: id }; cx.notify(); },
        }))))
        .child(div().flex_1())
        .when(row.source !== "default", (el) => el.child(div().text_size(10).text_color(row.source === "project" ? t.working : t.dim).child(row.source))))
      .child(editor)
      .when(unsaved, (el) => el.child(div().text_size(11).text_color(t.dim).child(`Saved: ${row.value}. Choose ${what} to change it.`)))
      .when(!!row.problem, (el) => el.child(div().text_size(11).text_color(t.blocked).child(row.problem)))
      .child(this.noteLine(`m:${key}`, t));
  }

  modelsBody(t) {
    const d = this.data;
    return v_flex().gap(10)
      .when(d.modelsShadowedByProject, (el) => el.child(div().text_size(11).text_color(t.working).child("This project's config sets models: it replaces the whole section, so changes here show but do not apply in this project.")))
      .children(MODEL_KEYS.map((k) => this.modelRow(k, t)));
  }

  // ---- local server

  localStatus(t) {
    const x = this.detected;
    if (this.busy.has("detect")) return { text: "checking…", color: t.muted };
    if (!x) return { text: "not checked", color: t.dim };
    if (x.ok === false) return { text: "invalid URL", color: t.blocked };
    if (x.reachable) return { text: `reachable · ${x.models.length} served`, color: t.done };
    return { text: "unreachable", color: t.blocked };
  }

  localBody(t) {
    const d = this.data;
    const x = this.detected && this.detected.ok !== false ? this.detected : null;
    const status = this.localStatus(t);
    const busy = this.busy.has("local");
    const served = x?.reachable ? x.models : [];
    const needCtx = served.some((m) => !m.contextWindow && m.configured === undefined);
    return v_flex().gap(6)
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).bg(status.color))
        .child(div().text_size(11).text_color(status.color).child(status.text))
        .child(div().flex_1())
        .child(this.button("detect", "Detect", t, { selected: false, disabled: this.busy.has("detect"), onClick: (_e, cx) => this.detect(cx, false) })))
      .child(this.input("base", t, busy))
      .child(h_flex().gap(4).flex_wrap().children(d.local.presets.map((p) => this.button(`preset-${p.name}`, p.name, t, {
        selected: this.text("base").trim() === p.baseUrl, disabled: busy, onClick: (_e, cx) => this.preset(p.baseUrl, cx),
      }))))
      .when(!!this.detected && this.detected.ok === false, (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.detected.error)))
      .when(!!x && !x.reachable, (el) => el.child(div().text_size(11).text_color(t.dim).child(x.error)))
      .when(served.length > 0, (el) => el.child(v_flex().gap(3)
        .child(div().text_size(10).text_color(t.dim).child("SERVED"))
        .children(served.map((m) => this.servedRow(m, t, busy)))
        .when(needCtx, (e) => e.child(h_flex().gap(6).items_center()
          .child(div().text_size(11).text_color(t.dim).child("context for Add"))
          .child(this.numberInput("ctx", t, false, (dir, cx) => {
            const cur = positive(this.text("ctx")) ?? 8192;
            this.inputs.ctx.state.set_value(String(Math.max(4096, cur + dir * 4096)));
            cx.notify();
          }))))))
      .when(d.local.models.length > 0, (el) => el.child(v_flex().gap(3)
        .child(div().text_size(10).text_color(t.dim).child("IN CONFIG"))
        .children(d.local.models.map((m) => h_flex().id(`cfg-${m.id}`).gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(m.id))
          .child(div().text_size(11).text_color(t.muted).child(ctxText(m.contextWindow)))
          .child(this.button(`rm-${m.id}`, "✕", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.removeLocal(m.id, cx) }))))))
      .child(this.noteLine("local", t));
  }

  servedRow(m, t, busy) {
    const saved = m.configured !== undefined;
    const same = saved && (m.contextWindow === undefined || m.configured === m.contextWindow);
    return v_flex().id(`served-${m.id}`).gap(1)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(m.id))
        .child(div().text_size(11).text_color(t.muted).child(m.contextWindow ? ctxText(m.contextWindow) : "ctx ?"))
        .child(same
          ? div().px(7).py(2).text_size(11).text_color(t.done).child("saved")
          : this.button(`add-${m.id}`, saved ? "Update" : "Add", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.addLocal(m, cx) })))
      .when(!!m.mismatch, (el) => el.child(div().text_size(10).text_color(t.working).child(`Saved context is ${ctxText(m.configured)}; the server runs ${ctxText(m.contextWindow)}.`)));
  }

  // ---- plans

  planRow(p, t) {
    const note = this.notes[`p:${p.id}`];
    const busy = this.busy.has(`p:${p.id}`);
    return v_flex().id(`plan-${p.id}`).gap(2).py(5).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().w(8).text_size(10).text_color(t.accent).child(p.active ? "●" : ""))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).text_color(p.closed ? t.dim : t.foreground).child(p.name))
        .child(div().text_size(11).text_color(t.muted).child(p.unknown > 0 ? `${fmtUsd(p.spendUsd)}+?` : fmtUsd(p.spendUsd))))
      .child(div().pl(14).truncate().text_size(11).text_color(t.muted).child(p.state))
      .child(div().pl(14).truncate().text_size(11).text_color(t.dim).child(`${ticketsText(p)}${p.branch ? ` · ${p.branch}` : ""}`))
      .when(!p.closed, (el) => el.child(h_flex().pl(14).gap(4)
        .when(!p.active, (e) => e.child(this.button(`act-${p.id}`, "Make active", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.activate(p.id, cx) })))
        .child(this.button(`close-${p.id}`, "Close", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.closePlan(p.id, false, cx) }))
        .when(!!note?.needsForce, (e) => e.child(this.button(`force-${p.id}`, "Close anyway", t, { selected: false, disabled: busy, onClick: (_e, cx) => this.closePlan(p.id, true, cx) })))))
      .when(!!note, (el) => el.child(div().pl(14).text_size(11).text_color({ ok: t.done, warn: t.working, err: t.blocked }[note.kind]).child(note.text)));
  }

  plansBody(t) {
    const plans = this.data.plans;
    if (plans.length === 0) return div().text_size(11).text_color(t.dim).child("No plans in this project. /plan <request> starts one.");
    return v_flex().children(plans.map((p) => this.planRow(p, t)));
  }

  // ---- costs

  meter(label, spend, limit, status, t, unknown) {
    const color = status === "hard" ? t.blocked : status === "soft" ? t.working : t.accent;
    return v_flex().gap(3)
      .child(h_flex().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(label))
        .child(div().text_size(12).text_color(status === "ok" ? t.foreground : color).child(`${fmtUsd(spend)}${unknown > 0 ? "+?" : ""} / ${fmtUsd(limit)}`)))
      .child(div().h(4).rounded(2).bg(t.raised).child(div().h(4).rounded(2).bg(color).w(`${Math.round(ratio(spend, limit) * 100)}%`)));
  }

  costsBody(t) {
    const d = this.data;
    const c = d.costs;
    const scope = this.scope === "plan" && c.plan ? c.plan : c.today;
    const rows = scope.byModel.slice(0, 8);
    const notMetered = c.today.unknown + (c.plan?.unknown ?? 0);
    return v_flex().gap(8)
      .child(this.meter("Today", c.today.spendUsd, c.today.limitUsd, c.today.status, t, c.today.unknown))
      .when(!!c.plan, (el) => el.child(this.meter(`Plan ${c.plan.name}`, c.plan.spendUsd, c.plan.limitUsd, c.plan.status, t, c.plan.unknown)))
      .when(!c.plan, (el) => el.child(div().text_size(11).text_color(t.dim).child("No active plan.")))
      .child(h_flex().gap(4).items_center()
        .child(div().text_size(10).text_color(t.dim).child("SPEND BY MODEL"))
        .child(div().flex_1())
        .child(this.button("scope-today", "Today", t, { selected: scope === c.today, disabled: false, onClick: (_e, cx) => { this.scope = "today"; cx.notify(); } }))
        .child(this.button("scope-plan", "Plan", t, { selected: scope === c.plan, disabled: !c.plan, onClick: (_e, cx) => { this.scope = "plan"; cx.notify(); } })))
      .child(scope.byModel.length === 0
        ? div().text_size(11).text_color(t.dim).child("Nothing spent yet.")
        : v_flex().gap(2).children(rows.map((r) => h_flex().gap(6)
          .child(div().flex_1().min_w(0).truncate().text_size(11).child(r.name))
          .child(div().text_size(11).text_color(t.muted).child(`${fmtUsd(r.spendUsd)}${r.unknown > 0 ? `+? (${r.unknown})` : ""}`)))))
      .when(scope.byPhase.length > 0, (el) => el.child(h_flex().gap(4).flex_wrap().children(scope.byPhase.map((r) => div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(`${r.name} ${fmtUsd(r.spendUsd)}`)))))
      .when(notMetered > 0 || c.unpriced.length > 0, (el) => el.child(v_flex().gap(2)
        .when(notMetered > 0, (e) => e.child(div().text_size(11).text_color(t.working).child(`${notMetered} call(s) not metered or unpriced; budgets count them at an estimate (+?).`)))
        .when(c.unpriced.length > 0, (e) => e.child(div().text_size(11).text_color(t.working).child(`No pricing row: ${c.unpriced.slice(0, 4).join(", ")}${c.unpriced.length > 4 ? "…" : ""}`)))))
      .child(v_flex().gap(4).pt(6).border_t(1).border_color(t.border)
        .child(div().text_size(10).text_color(t.dim).child("BUDGETS (USD)"))
        .when(d.budgets.shadowedByProject, (el) => el.child(div().text_size(11).text_color(t.working).child("This project's config sets budgets: it replaces the whole section, so changes here do not apply in this project.")))
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(11).text_color(t.muted).child("daily"))
          .child(this.numberInput("dailyUsd", t, this.busy.has("budgets"), (dir, cx) => this.stepBudget("dailyUsd", dir, cx)))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.muted).child("task"))
          .child(this.numberInput("taskUsd", t, this.busy.has("budgets"), (dir, cx) => this.stepBudget("taskUsd", dir, cx))))
        .child(this.noteLine("budgets", t)));
  }

  // ---- render

  banner(text, color, t) {
    return div().mx(10).mt(8).p(8).rounded(6).bg(t.raised).border(1).border_color(color).text_size(11).text_color(color).child(text);
  }

  render(cx) {
    const t = theme();
    const root = v_flex().id("chef-config").size_full().bg(t.surface).text_color(t.foreground).text_size(12);
    if (this.start && this.location() !== this.start && !this.loading) this.refresh(cx);
    if (this.failure && !this.data) return root.child(this.banner(this.failure, t.blocked, t));
    if (!this.data) return root.child(div().p(12).text_color(t.muted).child("Loading…"));
    const d = this.data;
    const c = d.costs;
    const summaries = {
      models: {},
      local: this.localStatus(t),
      plans: { text: `${d.plans.filter((p) => !p.closed).length} open` },
      costs: { text: `${fmtUsd(c.today.spendUsd)} / ${fmtUsd(c.today.limitUsd)}`, color: c.today.status === "hard" ? t.blocked : c.today.status === "soft" ? t.working : t.dim },
    };
    const bodies = { models: () => this.modelsBody(t), local: () => this.localBody(t), plans: () => this.plansBody(t), costs: () => this.costsBody(t) };
    return root
      .child(h_flex().gap(6).px(10).py(7).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("pi-chef"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.root?.split("/").pop() ?? ""))
        .child(this.button("refresh", this.loading ? "…" : "↻", t, { selected: false, disabled: false, onClick: (_e, cx) => this.refresh(cx) })))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .when(!!this.failure, (el) => el.child(this.banner(this.failure, t.blocked, t)))
        .children(d.errors.map((e) => this.banner(e, t.blocked, t)))
        .children(d.warnings.slice(0, 3).map((w) => div().px(10).pt(6).text_size(11).text_color(t.working).child(w)))
        .children(SECTIONS.map(([id, title]) => this.section(id, title, summaries[id], bodies[id](), t))));
  }
}
