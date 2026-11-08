// chef-config: shows every pi-chef setting with its user, project, default and effective value, where the
// effective one came from and which layering rule decided it. Scalar settings are editable (see below); all reading goes through the
// pi-chef CLI named in install.json (written by `npm run herdr:install`). Scalar settings can be edited:
// every write goes through the CLI's `set` / `unset` with --expect set to the file's sha256 from the last inspect;
// this mod never writes a config file itself and never logs a value.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Switch, InputState, Input, NumberInput } from "gpui-base";
import { NUMERIC, editable, projectProblem, looksSecret, valueArg, same, plain } from "./edit.js";
import { exec, props, focused, spaces, theme, appHome, home, readTextFile, pickFolder, watchFolder } from "herdr";

const REFRESH_MS = 10000;
const MAX_VALUE = 90;


function show(value) {
  if (value === undefined) return "—";
  let s;
  try { s = typeof value === "string" ? value : JSON.stringify(value); } catch { s = String(value); }
  if (s === undefined) return "—";
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE - 1) + "…" : s;
}

export default class ChefConfig extends View {
  init(_props, cx) {
    this.folder = props()?.folder ?? null;
    this.root = null;
    this.data = null;
    this.failure = null;
    this.section = null;
    this.loading = false;
    this.pending = false;
    this.watching = new Set();
    this.wanted = new Set();
    this.files = new Set();
    this.targets = {};          // key -> "user" | "project" (default user)
    this.notes = {};            // key -> { kind: "ok" | "warn" | "err", text }
    this.busy = new Set();      // keys with a write in flight
    this.inputs = {};           // key -> { state, synced, focused }; made once, here, never in render
    this.seq = 0;               // bumped by every write; a load that started earlier is dropped
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  // One load at a time; a request during a load queues exactly one more.
  refresh(cx) {
    if (this.loading) { this.pending = true; return; }
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      do {
        this.pending = false;
        try {
          await this.load();
          this.watch(cx);
        } catch (e) {
          this.failure = String(e?.message ?? e);
        }
        if (!this.pending) this.loading = false;
        cx.notify();
      } while (this.pending);
    });
  }

  // Refresh when a config file changes. Only the files count: ~/.pi/agent also holds Pi's sessions.
  watch(cx) {
    const dirs = new Set();
    const files = new Set();
    for (const f of [this.data?.user, this.data?.project, this.data?.legacy]) {
      if (!f?.path) continue;
      files.add(f.path);
      dirs.add(f.path.slice(0, f.path.lastIndexOf("/")));
    }
    this.wanted = dirs;
    this.files = files;
    for (const dir of dirs) {
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
            if (changed.some((p) => p === dir || this.files.has(abs(p)))) this.refresh(cx);
          }
        } catch { /* cannot watch here: the 10 s timer covers it */ }
        this.watching.delete(dir);
      });
    }
  }

  async load() {
    const raw = await readTextFile(`${appHome()}/mods/chef-config/install.json`);
    if (!raw) { this.failure = "install.json is missing: run `npm run herdr:install` in the pi-chef checkout."; return; }
    const cli = JSON.parse(raw).cli;
    this.cli = cli;
    if (!Array.isArray(cli) || cli.length === 0) { this.failure = "install.json has no `cli` argv array: run `npm run herdr:install` again."; return; }
    // A tab opened with tab.new {mod} has no cwd of its own: fall back to the active space's folder.
    // SpaceInfo.folder is "" for a space at home, so take the first non-empty term (|| , not ??).
    const start = this.folder || props()?.folder || focused()?.cwd || spaces().find((sp) => sp.active)?.folder || home();
    if (!start) { this.failure = "No project folder: open the panel with props {folder} or from a space with a folder."; return; }
    let root = start;
    try {
      const g = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: start });
      if (g.code === 0 && g.stdout.trim()) root = g.stdout.trim();
    } catch { /* not a repo: use the folder itself */ }
    if (!root) { this.failure = "No project folder to inspect."; return; }
    this.root = root;
    const mine = this.seq;
    const r = await exec(cli[0], [...cli.slice(1), "inspect", "--cwd", root], { timeout: 60000 });
    let json;
    try { json = JSON.parse(r.stdout); } catch { json = null; }
    if (!json) { this.failure = `chef-config printed no JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`; return; }
    if (mine !== this.seq || this.busy.size > 0) return; // a write finished or is running: its result is newer
    if (json.ok === false) { this.failure = json.error ?? "chef-config failed"; return; }
    this.failure = null;
    this.data = json;
    this.syncInputs();
    const names = this.sections();
    if (!this.section || !names.includes(this.section)) this.section = names[0] ?? null;
  }

  schemaFor(key) { return (this.data?.schema ?? []).find((x) => x.key === key); }

  // One InputState per text/number key, created the first time data arrives (an async task, not render) and kept.
  // The text follows the effective value unless the person is typing in it.
  syncInputs(force) {
    for (const k of this.data?.keys ?? []) {
      const s = this.schemaFor(k.key);
      if (!editable(s) || s.type === "bool" || s.type === "enum") continue;
      let slot = this.inputs[k.key];
      const text = plain(k.effective);
      if (!slot) {
        const state = InputState.new({ value: text, placeholder: plain(s.default) });
        if (NUMERIC.has(s.type)) {
          state.set_step(s.type === "usd" || s.type === "number" ? (s.max !== undefined && s.max <= 1 ? 0.05 : 1) : 1);
          if (s.min !== undefined) state.set_min(s.min);
          if (s.max !== undefined) state.set_max(s.max);
        }
        slot = this.inputs[k.key] = { state, synced: text, focused: false };
        state.on("focus", () => { slot.focused = true; });
        state.on("blur", (_e, cx) => { slot.focused = false; this.commitInput(k.key, cx); });
        state.on("submit", (_e, cx) => this.commitInput(k.key, cx));
      } else if (force === k.key || (!slot.focused && slot.synced !== text)) {
        slot.state.set_value(text);
        slot.synced = text;
      }
    }
  }

  target(key) { return this.targets[key] ?? "user"; }

  // Runs the CLI for one edit. `value` is the --value argument (null for unset). Always re-renders from the result.
  write(key, value, cx) {
    const s = this.schemaFor(key);
    if (!s || !this.root || this.busy.has(key)) return;
    const file = this.target(key);
    if (file === "project" && projectProblem(s)) { this.note(key, "err", `Not allowed in the project file (${projectProblem(s)}).`, cx); return; }
    if (value !== null && s.type !== "bool" && !NUMERIC.has(s.type) && looksSecret(JSON.parse(value), s.type)) {
      this.note(key, "err", "That looks like a secret. pi-chef config never holds secrets; nothing was sent.", cx);
      this.resetInput(key);
      return;
    }
    const view = this.data?.[file];
    const argv = [...this.cli.slice(1), value === null ? "unset" : "set", "--cwd", this.root, "--file", file, "--key", key];
    if (value !== null) argv.push("--value", value);
    if (view?.sha256) argv.push("--expect", view.sha256);
    this.busy.add(key);
    delete this.notes[key];
    cx.notify();
    cx.spawn(async (cx) => {
      let json = null;
      try {
        const r = await exec(this.cli[0], argv, { timeout: 60000 });
        try { json = JSON.parse(r.stdout); } catch { json = null; }
        if (!json) json = { ok: false, error: `chef-config printed no JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
      } catch (e) {
        json = { ok: false, error: String(e?.message ?? e) };
      }
      this.seq++;
      if (Array.isArray(json.keys)) { this.data = json; this.failure = null; }
      this.busy.delete(key);
      this.syncInputs(key);
      if (json.ok === false) {
        this.notes[key] = { kind: "err", text: json.error ?? "chef-config refused the edit" };
      } else {
        const k = this.data?.keys?.find((x) => x.key === key);
        const eff = k?.effective;
        const written = value === null ? undefined : JSON.parse(value);
        let text = value === null ? `Reset in the ${file} file.` : `Saved to the ${file} file.`;
        let kind = "ok";
        if (value !== null && k && !same(eff, written)) {
          text += ` Effective value is ${show(eff)}, from ${k.source === "default" ? "the default" : `the ${k.source} file`} (${k.rule}).`;
          kind = "warn";
        }
        text += " pi-chef applies it on the next command.";
        if (json.edit?.reflowed) { text += " The file was reflowed: spacing or comment positions may have moved."; kind = "warn"; }
        this.notes[key] = { kind, text };
      }
      cx.notify();
    });
  }

  note(key, kind, text, cx) { this.notes[key] = { kind, text }; cx.notify(); }

  resetInput(key) {
    const slot = this.inputs[key];
    const k = this.data?.keys?.find((x) => x.key === key);
    if (slot && k) { slot.state.set_value(plain(k.effective)); slot.synced = plain(k.effective); }
  }

  // Text/number inputs: send on Enter or blur, only when the text changed since it was last synced.
  commitInput(key, cx) {
    const slot = this.inputs[key];
    const s = this.schemaFor(key);
    if (!slot || !s || this.busy.has(key)) return;
    const text = slot.state.value();
    if (text === slot.synced) return;
    const arg = valueArg(s, text);
    if (arg === null) {
      this.note(key, "err", NUMERIC.has(s.type) ? `Not a valid ${s.type === "number" || s.type === "usd" ? "number" : "whole number"}.` : "Not a valid value.", cx);
      this.resetInput(key);
      return;
    }
    this.write(key, arg, cx);
  }

  step(key, dir, cx) {
    const slot = this.inputs[key];
    const s = this.schemaFor(key);
    if (!slot || !s || this.busy.has(key)) return;
    const cur = Number(slot.state.value());
    if (!Number.isFinite(cur)) { this.note(key, "err", "Not a valid number.", cx); this.resetInput(key); return; }
    const inc = s.type === "usd" || s.type === "number" ? (s.max !== undefined && s.max <= 1 ? 0.05 : 1) : 1;
    let next = Math.round((cur + dir * inc) * 1e6) / 1e6;
    if (s.min !== undefined && (next < s.min || (s.exclusiveMin && next <= s.min))) next = cur;
    if (s.max !== undefined && next > s.max) next = s.max;
    slot.state.set_value(String(next));
    this.commitInput(key, cx);
  }

  sections() {
    const out = [];
    for (const k of this.data?.keys ?? []) if (!out.includes(k.section)) out.push(k.section);
    return out;
  }

  chip(text, color, t) {
    return div().px(6).rounded(4).bg(t.raised).text_size(11).text_color(color).child(text);
  }

  fileLine(label, f, t) {
    return h_flex().gap(8).text_size(12)
      .child(div().w(56).text_color(t.dim).child(label))
      .child(div().text_color(t.foreground).truncate().child(f?.display ?? "?"))
      .child(div().text_color(f?.exists ? t.done : t.blocked).child(f?.exists ? "exists" : "missing"));
  }

  header(t) {
    const d = this.data;
    return v_flex().gap(4).p(12).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().text_size(14).child("pi-chef config"))
        .child(div().id("cc-folder").text_size(12).text_color(t.accent).truncate()
          .on_click((_e, cx) => {
            cx.spawn(async (cx) => {
              const f = await pickFolder({ prompt: "Project to show" });
              if (f) { this.folder = f; this.refresh(cx); }
            });
          }).child(this.root ?? "…"))
        .child(div().flex_1())
        .child(this.chip(`${d?.warnings?.length ?? 0} warnings`, d?.warnings?.length ? t.working : t.dim, t))
        .child(div().id("cc-refresh").px(10).py(3).rounded(4).bg(t.raised).text_size(12)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx)).child(this.loading ? "Refreshing…" : "Refresh")))
      .child(this.fileLine("user", d?.user, t))
      .child(this.fileLine("project", d?.project, t));
  }

  banner(text, t) {
    return div().m(12).p(10).rounded(6).bg(t.raised).border(1).border_color(t.blocked).text_size(12)
      .text_color(t.blocked).child(text);
  }

  valueCell(label, value, t, present) {
    return h_flex().gap(6).text_size(12)
      .child(div().w(58).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).truncate().text_color(present ? t.foreground : t.dim).child(show(value)));
  }

  row(k, desc, t) {
    const src = { user: t.accent, project: t.working, merged: t.done, default: t.dim }[k.source] ?? t.dim;
    return v_flex().id(`row-${k.key}`).gap(3).p(10).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().text_size(13).child(k.key))
        .child(this.chip(k.source, src, t))
        .child(this.chip(k.rule, t.muted, t))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(show(k.effective))))
      .child(this.valueCell("user", k.user, t, k.user !== undefined))
      .child(this.valueCell("project", k.project, t, k.project !== undefined))
      .child(this.valueCell("default", k.default, t, k.default !== undefined))
      .when(!!desc, (el) => el.child(div().text_size(12).text_color(t.muted).child(desc)))
      .when(editable(this.schemaFor(k.key)), (el) => el.child(this.controls(k, t)));
  }

  button(id, label, t, { selected, disabled, onClick }) {
    return div().id(id).px(10).py(3).rounded(4).text_size(12)
      .bg(selected ? t.selected : t.raised)
      .text_color(disabled ? t.dim : selected ? t.foreground : t.muted)
      .when(!disabled, (el) => el.hover((st) => st.bg(t.hover)).on_click(onClick))
      .child(label);
  }

  controls(k, t) {
    const s = this.schemaFor(k.key);
    const busy = this.busy.has(k.key);
    const file = this.target(k.key);
    const why = projectProblem(s);
    const note = this.notes[k.key];
    const noteColor = note ? { ok: t.done, warn: t.working, err: t.blocked }[note.kind] : t.dim;
    let control;
    if (s.type === "bool") {
      const on = k.effective === true;
      control = Switch.new(`sw-${k.key}`).checked(on).disabled(busy)
        .on_change((checked, cx) => this.write(k.key, checked ? "true" : "false", cx))
        .child(h_flex().w(36).h(20).p(2).rounded(10).items_center().bg(on ? t.accent : t.raised)
          .when(on, (el) => el.justify_end())
          .child(div().w(16).h(16).rounded(8).bg(t.foreground)));
    } else if (s.type === "enum") {
      control = h_flex().gap(4).children((s.enum ?? []).map((v) => this.button(`en-${k.key}-${v}`, v, t, {
        selected: k.effective === v, disabled: busy,
        onClick: (_e, cx) => { if (k.effective !== v) this.write(k.key, JSON.stringify(v), cx); },
      })));
    } else if (NUMERIC.has(s.type)) {
      const slot = this.inputs[k.key];
      control = slot ? div().w(180).child(NumberInput.new(slot.state).disabled(busy)
        .on_step((action, cx) => this.step(k.key, action === "increment" ? 1 : -1, cx))
        .controls_right()
        .decrement_button(div().px(6).text_size(12).child("−"))
        .increment_button(div().px(6).text_size(12).child("+"))) : div();
    } else {
      const slot = this.inputs[k.key];
      control = slot ? div().w(300).child(Input.new(slot.state).disabled(busy).h(28).px(8).items_center().rounded(4).border(1).border_color(t.input).bg(t.background).text_color(t.foreground)) : div();
    }
    const resetable = k[file] !== undefined;
    return v_flex().gap(4).pt(4)
      .child(h_flex().gap(8).items_center()
        .child(control)
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child("write to"))
        .child(this.button(`tg-${k.key}-user`, "User", t, { selected: file === "user", disabled: false, onClick: (_e, cx) => { this.targets[k.key] = "user"; cx.notify(); } }))
        .child(this.button(`tg-${k.key}-project`, "Project", t, { selected: file === "project", disabled: !!why, onClick: (_e, cx) => { this.targets[k.key] = "project"; cx.notify(); } }))
        .child(this.button(`rs-${k.key}`, "Reset", t, { selected: false, disabled: busy || !resetable, onClick: (_e, cx) => this.write(k.key, null, cx) })))
      .when(!!why, (el) => el.child(div().text_size(11).text_color(t.dim).child(`Project is off for this key — ${why}.`)))
      .when(!!note, (el) => el.child(div().text_size(12).text_color(noteColor).child(note.text)));
  }

  render(cx) {
    const t = theme();
    const root = v_flex().id("chef-config").size_full().bg(t.surface).text_color(t.foreground).text_size(13);
    if (this.failure && !this.data) return root.child(this.banner(this.failure, t));
    if (!this.data) return root.child(div().p(12).text_color(t.muted).child("Loading…"));
    const d = this.data;
    const desc = {};
    for (const s of d.schema ?? []) desc[s.key] = s.description;
    const names = this.sections();
    const rows = d.keys.filter((k) => k.section === this.section);
    root.child(this.header(t));
    if (this.failure) root.child(this.banner(this.failure, t));
    for (const e of d.errors ?? []) root.child(this.banner(`${e.display ? e.display + ": " : ""}${e.message}`, t));
    for (const w of d.warnings ?? []) root.child(div().px(12).py(2).text_size(12).text_color(t.working).child(`warning: ${w}`));
    if (d.effectiveFrom && d.effectiveFrom !== "loaded") {
      root.child(div().px(12).py(4).text_size(12).text_color(t.working).child(`Values shown come from ${d.effectiveFrom} only: a file was rejected.`));
    }
    return root.child(h_flex().flex_1().min_h(0)
      .child(v_flex().w(150).border_r(1).border_color(t.border).overflow_y_scrollbar().p(6).gap(2)
        .children(names.map((n) => div().id(`sec-${n}`).px(8).py(4).rounded(4).text_size(13)
          .bg(n === this.section ? t.selected : t.surface)
          .text_color(n === this.section ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.section = n; cx.notify(); }).child(n))))
      .child(v_flex().flex_1().min_w(0).overflow_y_scrollbar()
        .children(rows.map((k) => this.row(k, desc[k.schemaKey], t)))
));
  }
}
