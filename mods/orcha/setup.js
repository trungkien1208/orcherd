// PROJECT SETUP: shown once when a project is added (left.js), with what
// Settings › Projects has for it: the working rules that go in its CLAUDE.md
// and the suggested skills. Changes are written as they are made; DONE and
// esc only close.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, props, closeOverlay, openOverlay, notify } from "herdr";
import { RULES } from "./catalog.js";
import { projectView } from "./project-view.js";
import { readProject, writeRules, rulesIn, installSkill, setAsksSetup } from "./project-setup.js";
import { notifyError } from "./accounts-data.js";
import { tokens, raised, icon, button } from "./ui.js";

/** Opens PROJECT SETUP for the project `space` (its id). */
export function openSetup(space) {
  openOverlay({ mod: "orcha", props: { part: "setup", space }, kind: "dialog", width: 620, height: 600, frame: "none" });
}

export default class Setup {
  constructor(cx) {
    this.space = spaces().find((s) => s.id === props()?.space) ?? null;
    this.info = null; // readProject()
    this.tab = "rules"; // or "skills"
    this.busy = {}; // skill name → "here" | "for you"
    this.failed = {}; // skill name → the command to run by hand
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    this.load(cx);
  }

  load(cx) {
    if (!this.space?.folder) return;
    cx.spawn(async (cx) => {
      this.info = await readProject(this.space.folder);
      cx.notify();
    });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  toggleRule(id, cx) {
    const info = this.info;
    const ids = RULES.map((r) => r.id).filter((r) => (r === id ? !info.rules.includes(r) : info.rules.includes(r)));
    cx.spawn(async (cx) => {
      try {
        info.file.text = await writeRules(info.file.path, ids);
        info.rules = rulesIn(info.file.text);
      } catch (err) {
        notifyError({ title: "The rules were not written", body: String(err), level: "error" });
      }
      cx.notify();
    });
  }

  install(skill, global, cx) {
    if (!this.info || this.busy[skill.name]) return;
    this.busy[skill.name] = global ? "for you" : "here";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await installSkill(skill, this.info.folder, global);
      delete this.busy[skill.name];
      if (r.ok) {
        delete this.failed[skill.name];
        this.info.installed[skill.name] = { ...this.info.installed[skill.name], [global ? "global" : "project"]: true };
      } else {
        // The row then offers the command, to run by hand in a terminal.
        this.failed[skill.name] = r.command;
        notifyError({ title: `${skill.title} was not installed`, body: r.error, level: "error" });
      }
      cx.notify();
    });
  }

  // Stops asking on new projects; Settings › Projects turns it back on.
  never(cx) {
    cx.spawn(async () => {
      const failed = await setAsksSetup(false);
      if (failed) return notifyError({ title: "The setting was not saved", body: failed, level: "error" });
      notify({ title: "New projects won't ask again", body: "Rules and skills stay in Settings › Projects, where this can be turned back on.", level: "info", timeout: 6000 });
      this.close();
    });
  }

  rows(k) {
    if (!this.space?.folder) return div().p(10).text_color(k.dim).child("This project is gone.");
    if (!this.info) return div().p(10).text_color(k.dim).child("Reading the project…");
    const state = { info: this.info, tab: this.tab, busy: this.busy, failed: (name) => this.failed[name] };
    return projectView(k, "su", state, {
      tab: (id, cx) => {
        this.tab = id;
        cx.notify();
      },
      toggleRule: (id, cx) => this.toggleRule(id, cx),
      install: (skill, global, cx) => this.install(skill, global, cx),
      copy: (command, cx) => {
        cx.write_to_clipboard(command);
        notify({ title: "Install command copied", body: "Paste it in Terminal and press Return. It needs Node.js (nodejs.org).", level: "info", timeout: 6000 });
      },
    });
  }

  render(_cx) {
    const k = tokens();
    const box = v_flex()
      .id("orcha-setup")
      .track_focus(this.handle)
      .w(610)
      .h(590)
      .rounded(8)
      .border(3)
      .border_color(k.line)
      .bg(k.paper)
      .overflow_hidden()
      .on_key_down((e, _cx) => {
        if (e.key === "escape" || e.key === "enter") this.close();
      })
      .child(
        v_flex()
          .flex_none()
          .px(14)
          .py(10)
          .gap(2)
          .bg(k.card)
          .border_b(2.5)
          .border_color(k.line)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(icon("git-fork", 15, k.ink))
              .child(div().text_size(12.5).font_black().text_color(k.ink).child(`PROJECT SETUP · ${this.space?.name ?? ""}`)),
          )
          .child(div().text_size(11.5).text_color(k.muted).child("How agents should work here: rules for its instructions file, and skills to add. Changes are saved as you make them.")),
      )
      .child(v_flex().id("setup-rows").flex_1().min_h(0).px(14).pt(14).pb(14).overflow_y_scrollbar().child(this.rows(k)))
      .child(
        h_flex()
          .flex_none()
          .h(44)
          .px(12)
          .gap(14)
          .items_center()
          .bg(k.card)
          .border_t(2.5)
          .border_color(k.line)
          .text_size(11)
          .text_color(k.muted)
          .child("Later: Settings › Projects")
          .child(
            div()
              .id("setup-never")
              .cursor_pointer()
              .hover((s) => s.text_color(k.ink))
              .on_click((_e, cx) => this.never(cx))
              .child("Don't ask on new projects"),
          )
          .child(div().flex_1())
          .child(button(k, "setup-done", "DONE", () => this.close(), { primary: true })),
      );
    return raised(k, box, 5, 8);
  }
}
