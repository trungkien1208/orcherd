// A project's working rules and skills as Settings › Projects and PROJECT
// SETUP both draw them: two counters that double as tabs, then rule cards
// or skills by group. The owners keep the state and do the writing.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { GROUPS, RULES, SKILLS } from "./catalog.js";
import { raised, button, chip, readable } from "./ui.js";

const GROUP_COLORS = ["yellow", "green", "blue", "pink", "teal", "red"];

const skillsAdded = (info) => SKILLS.filter((s) => info.installed[s.name]?.project || info.installed[s.name]?.global).length;

// A counter that is also the tab it counts.
function tab(k, id, value, label, on, onClick) {
  const box = v_flex()
    .id(id)
    .flex_1()
    .px(12)
    .py(8)
    .gap(1)
    .rounded(7)
    .border(2.5)
    .border_color(k.line)
    .bg(on ? k.yellow : k.card)
    .cursor_pointer()
    .when(!on, (el) => el.hover((s) => s.bg(k.hover)))
    .on_click(onClick)
    .child(div().text_size(20).font_black().text_color(on ? k.chipText : k.ink).child(value))
    .child(div().text_size(10.5).font_black().text_color(on ? k.chipText : k.muted).child(label));
  return on ? raised(k, box, 3, 7).flex_1() : div().flex_1().mr(3).mb(3).child(box);
}

function toggle(k, on) {
  return div()
    .w(38)
    .h(22)
    .flex_none()
    .rounded(11)
    .p(2)
    .border(2)
    .border_color(k.line)
    .bg(on ? k.green : k.card)
    .flex()
    .items_center()
    .when(on, (el) => el.justify_end())
    .child(div().w(14).h(14).rounded(7).bg(on ? k.line : k.muted));
}

// A card: tinted and outlined in ink when it is on.
function card(k, id, on) {
  return h_flex()
    .id(id)
    .w_full()
    .px(12)
    .py(10)
    .gap(12)
    .items_center()
    .rounded(7)
    .border(on ? 2.5 : 2)
    .border_color(k.line)
    .bg(on ? k.green + (k.dark ? "33" : "40") : k.card);
}

function text(k, title, about, extra) {
  return v_flex()
    .flex_1()
    .min_w(0)
    .gap(3)
    .child(title)
    .child(div().text_size(12).line_height("17px").text_color(k.ink).opacity(0.75).child(about))
    .when(Boolean(extra), (el) => el.child(extra));
}

function rules(k, p, info, on) {
  const file = info.file.path.split("/").pop();
  return v_flex()
    .w_full()
    .gap(8)
    .child(div().pb(2).text_size(12).text_color(k.dim).child(`Written to ${file} as one block orcha keeps; what your team wrote around it stays as it is.`))
    .children(
      RULES.map((rule) => {
        const set = info.rules.includes(rule.id);
        return card(k, `${p}-rule-${rule.id}`, set)
          .cursor_pointer()
          .when(!set, (el) => el.hover((s) => s.bg(k.hover)))
          .on_click((_e, cx) => on.toggleRule(rule.id, cx))
          .child(text(k, div().text_size(13.5).font_black().text_color(k.ink).child(rule.title), rule.summary))
          .child(toggle(k, set));
      }),
    );
}

// One skill: a row in its group's panel, tinted once it is added.
function skillRow(k, p, info, state, on, skill, last) {
  const where = info.installed[skill.name] ?? {};
  const busy = state.busy[skill.name];
  const failed = state.failed(skill.name);
  const added = where.project || where.global;
  const control = busy
    ? chip(k, `INSTALLING ${busy.toUpperCase()}…`, k.yellow).h(22).px(8).border(2).border_color(k.line)
    : where.project
      ? chip(k, "✓ THIS PROJECT", k.green).h(22).px(8).border(2).border_color(k.line)
      : where.global
        ? chip(k, "✓ FOR YOU", k.green).h(22).px(8).border(2).border_color(k.line)
        : h_flex()
            .gap(6)
            .child(button(k, `${p}-sk-p-${skill.name}`, "Add here", (_e, cx) => on.install(skill, false, cx), { small: true, primary: true }))
            .child(button(k, `${p}-sk-g-${skill.name}`, "For me", (_e, cx) => on.install(skill, true, cx), { small: true }));
  const title = h_flex()
    .gap(8)
    .items_center()
    .child(div().text_size(13.5).font_black().text_color(k.ink).child(skill.title))
    .child(div().min_w(0).truncate().text_size(11).font_semibold().text_color(k.muted).child(skill.source));
  const retry = failed
    ? h_flex()
        .pt(4)
        .gap(8)
        .items_center()
        .child(div().text_size(11.5).font_bold().text_color(readable(k, k.red)).child("Not installed. Run the command in Terminal, or try again."))
        .child(button(k, `${p}-sk-c-${skill.name}`, "Copy command", (_e, cx) => on.copy(failed, cx), { small: true }))
    : null;
  return h_flex()
    .id(`${p}-sk-${skill.name}`)
    .w_full()
    .px(12)
    .py(10)
    .gap(12)
    .items_center()
    .bg(added ? k.green + (k.dark ? "33" : "40") : k.card)
    .when(!last, (el) => el.border_b(2).border_color(k.line))
    .child(text(k, title, skill.summary, retry))
    .child(div().flex_none().child(control));
}

// Each group a raised panel: a bar in the group's color, then its skills.
function skills(k, p, info, state, on) {
  const out = v_flex().w_full().gap(14);
  GROUPS.forEach((group, i) => {
    const list = SKILLS.filter((s) => s.group === group.name);
    if (!list.length) return;
    const color = k[GROUP_COLORS[i % GROUP_COLORS.length]];
    const added = list.filter((s) => info.installed[s.name]?.project || info.installed[s.name]?.global).length;
    const panel = v_flex()
      .w_full()
      .rounded(8)
      .border(2.5)
      .border_color(k.line)
      .bg(k.card)
      .overflow_hidden()
      .child(
        h_flex()
          .w_full()
          .px(12)
          .py(8)
          .gap(10)
          .items_center()
          .bg(color)
          .border_b(2.5)
          .border_color(k.line)
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(div().text_size(14).font_black().text_color(k.chipText).child(group.name.toUpperCase()))
              .child(div().text_size(11.5).font_semibold().text_color(k.chipText).opacity(0.75).child(group.about)),
          )
          .child(chip(k, `${added}/${list.length}`, k.card, k.ink).h(22).px(8).border(2).border_color(k.line)),
      )
      .children(list.map((skill, j) => skillRow(k, p, info, state, on, skill, j === list.length - 1)));
    out.child(raised(k, panel, 3, 8));
  });
  return out;
}

/** The view. `state`: { info (readProject()), tab ("rules" | "skills"),
 *  busy: { skill name: "here" | "for you" }, failed(skill name) → command }.
 *  `on`: { tab(id, cx), toggleRule(id, cx), install(skill, global, cx),
 *  copy(command, cx) }. `p` prefixes the element ids. */
export function projectView(k, p, state, on) {
  const { info } = state;
  const which = state.tab === "skills" ? "skills" : "rules";
  return v_flex()
    .w_full()
    .gap(14)
    .child(
      h_flex()
        .w_full()
        .gap(10)
        .child(tab(k, `${p}-tab-rules`, `${info.rules.length}/${RULES.length}`, "WORKING RULES ON", which === "rules", (_e, cx) => on.tab("rules", cx)))
        .child(tab(k, `${p}-tab-skills`, `${skillsAdded(info)}/${SKILLS.length}`, "SKILLS ADDED", which === "skills", (_e, cx) => on.tab("skills", cx))),
    )
    .child(which === "rules" ? rules(k, p, info, on) : skills(k, p, info, state, on));
}
