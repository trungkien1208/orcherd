// PROJECT SETUP: shown once when a project is added (left.js), with what
// Settings › Projects has for it: the working rules that go in its CLAUDE.md
// and the suggested skills. Changes are written as they are made; DONE and
// esc only close.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, props, closeOverlay, openOverlay, notify } from "herdr";
import { GROUPS, RULES, SKILLS } from "./catalog.js";
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

  heading(k, text) {
    return div().pt(14).pb(4).px(8).text_size(11).font_black().text_color(k.muted).child(text.toUpperCase());
  }

  // What it is on the left, the control on the right: as Settings draws it.
  row(k, title, about, control) {
    return h_flex()
      .w_full()
      .gap(14)
      .px(8)
      .py(8)
      .items_center()
      .border_b(1)
      .border_color(k.border)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().text_size(13).font_semibold().text_color(k.ink).child(title))
          .child(div().text_size(11.5).line_height("16px").text_color(k.dim).child(about)),
      )
      .child(div().flex_none().child(control));
  }

  toggle(k, id, on, onClick) {
    return div()
      .id(id)
      .w(38)
      .h(22)
      .rounded(11)
      .p(2)
      .border(2)
      .border_color(k.line)
      .cursor_pointer()
      .bg(on ? k.green : k.card)
      .flex()
      .items_center()
      .when(on, (el) => el.justify_end())
      .on_click(onClick)
      .child(div().w(14).h(14).rounded(7).bg(on ? k.line : k.muted));
  }

  rows(k) {
    const info = this.info;
    const out = v_flex().w_full();
    if (!this.space?.folder) return out.child(div().p(10).text_color(k.dim).child("This project is gone."));
    if (!info) return out.child(div().p(10).text_color(k.dim).child("Reading the project…"));
    out.child(this.heading(k, `Working rules · ${info.file.path.split("/").pop()}`));
    for (const rule of RULES) {
      out.child(this.row(k, rule.title, rule.summary, this.toggle(k, `su-rule-${rule.id}`, info.rules.includes(rule.id), (_e, cx) => this.toggleRule(rule.id, cx))));
    }
    let group = null;
    for (const skill of SKILLS) {
      if (skill.group !== group) {
        group = skill.group;
        out.child(this.heading(k, `Skills · ${group}`));
        const about = GROUPS.find((g) => g.name === group)?.about;
        if (about) out.child(div().px(8).pb(4).text_size(12).text_color(k.dim).child(about));
      }
      const where = info.installed[skill.name] ?? {};
      const busy = this.busy[skill.name];
      const failed = this.failed[skill.name];
      const note = (text, color) => div().text_size(12).font_semibold().text_color(color).child(text);
      const control = busy
        ? note(`installing ${busy}…`, k.dim)
        : where.project
          ? note("✓ in this project", k.green)
          : where.global
            ? note("✓ for you", k.green)
            : h_flex()
                .gap(6)
                .when(Boolean(failed), (el) =>
                  el.child(
                    button(k, `su-c-${skill.name}`, "Copy command", (_e, cx) => {
                      cx.write_to_clipboard(failed);
                      notify({ title: "Install command copied", body: "Paste it in Terminal and press Return. It needs Node.js (nodejs.org).", level: "info", timeout: 6000 });
                    }, { small: true }),
                  ),
                )
                .child(button(k, `su-p-${skill.name}`, "Add here", (_e, cx) => this.install(skill, false, cx), { small: true }))
                .child(button(k, `su-g-${skill.name}`, "For me", (_e, cx) => this.install(skill, true, cx), { small: true }));
      const about = failed ? `Not installed. Copy the command and run it in Terminal, or try again. · ${skill.source}` : `${skill.summary} · ${skill.source}`;
      out.child(this.row(k, skill.title, about, control));
    }
    return out;
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
          .child(div().text_size(11.5).text_color(k.muted).child("How agents should work in this project. Rules go in one block orcha keeps; what your team wrote around it stays as it is.")),
      )
      .child(v_flex().id("setup-rows").flex_1().min_h(0).px(6).pb(8).overflow_y_scrollbar().child(this.rows(k)))
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
