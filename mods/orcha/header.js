// The header, one row over the whole window (SPEC §2 "Header"): the raised
// 🐐🐋 ORCHERD chip, then counts as colored pills (projects, running, needs you),
// a search box in the middle that opens FIND, and square buttons for the
// command palette, ACCOUNTS and settings. macOS keeps its window buttons at the left, so it
// leaves them room. Dragging it moves the window.
//
// The header is the one copy of orcha that listens for its keys (keys.json,
// layout:orcha): orcha.settings (⌘,), orcha.accounts, orcha.find-file (⌘O), orcha.find-text (⌘⇧F),
// orcha.find-pane (⌘F), orcha.find-link (⌘L) open FIND (finder.js);
// orcha.close-tab (⌘W) and orcha.close-pane (⌘⇧W) close without Herdr's
// question; orcha.new-project is NEW PROJECT's folder picker (new.js).

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, run, window, openOverlay, nextCommand, focused, panes, setShared } from "herdr";
import { tokens, chip, raised, icon, pill, closeTab, closePane } from "./ui.js";
import { browseProject } from "./new.js";
import { available, checkUpdate, landed, restartNeeded } from "./version.js";

// A square icon button with a hard shadow, like the other raised things.
function square(k, id, name, tip, onClick) {
  const el = div()
    .id(id)
    .size(28)
    .flex()
    .items_center()
    .justify_center()
    .rounded(6)
    .border(2)
    .border_color(k.line)
    .bg(k.card)
    .cursor_pointer()
    .hover((s) => s.bg(k.hover))
    .tooltip(tip)
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick();
    })
    .child(icon(name, 15, k.ink));
  return raised(k, el, 2, 6);
}

/** Opens SETTINGS: Herdr's settings with orcha's on top (settings.js), on
 *  `section` when given. */
export function openSettings(section) {
  openOverlay({ mod: "orcha", props: { part: "settings", section }, kind: "dialog", width: 900, height: 620 });
}

/** Opens ACCOUNTS. */
export function openAccounts() {
  openOverlay({ mod: "orcha", props: { part: "accounts" }, kind: "dialog", width: 560, frame: "none" });
}

/** Opens FIND on one of its tabs: "file", "text", "pane" or "links". */
export function openFinder(mode) {
  openOverlay({ mod: "orcha", props: { part: "finder", mode }, kind: "dialog", width: 650, height: 470, frame: "none" });
}

export default class Header {
  constructor(cx) {
    const commands = {
      "find-file": () => openFinder("file"),
      "find-text": () => openFinder("text"),
      // In the file viewer, ⌘F opens its own find bar (viewer.js).
      "find-pane": () => {
        const pane = focused()?.pane;
        if (panes().some((p) => p.pane === pane && p.mod === "orcha")) setShared("orcha.viewerFind", { pane, seq: Date.now() });
        else openFinder("pane");
      },
      "find-link": () => openFinder("links"),
      settings: () => openSettings(),
      accounts: openAccounts,
      "close-tab": () => closeTab(),
      "close-pane": () => closePane(),
      // Not awaited: other keys work while the picker is up.
      "new-project": browseProject,
    };
    cx.spawn(async () => {
      for (;;) commands[await nextCommand()]?.();
    });
    // A newer orcha on GitHub? Asked now and every few hours (version.js).
    landed();
    checkUpdate();
    cx.timer.every(60 * 60 * 1000, () => checkUpdate());
  }

  render(_cx) {
    const k = tokens();
    const projects = spaces().length;
    const list = agents();
    const working = list.filter((a) => a.status === "working").length;
    const needs = list.filter((a) => a.status === "blocked").length;
    const mac = window()?.platform === "macos";
    const next = available();
    // Installed, but Herdr runs the old copy until it restarts.
    const waiting = restartNeeded();
    const search = raised(
      k,
      h_flex()
        .id("orcha-search")
        .w_full()
        .h(28)
        .px(10)
        .gap(8)
        .items_center()
        .rounded(6)
        .border(2)
        .border_color(k.line)
        .bg(k.card)
        .cursor_pointer()
        .hover((s) => s.bg(k.hover))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          openFinder("file");
        })
        .child(icon("search", 14, k.muted))
        .child(div().flex_1().truncate().text_size(12).text_color(k.muted).child("Search files and text"))
        .child(chip(k, "⌘O", k.raised, k.dim).border(1.5).border_color(k.dim))
        .child(chip(k, "⌘⇧F", k.raised, k.dim).border(1.5).border_color(k.dim)),
      2,
      6,
    );
    return h_flex()
      .id("orcha-header")
      .size_full()
      .pl(mac ? 84 : 14)
      .pr(12)
      .gap(10)
      .items_center()
      .bg(k.paper)
      .border_b(2.5)
      .border_color(k.line)
      .child(raised(k, chip(k, "🐐🐋 ORCHERD", k.pink).h(26).px(10).text_size(13).border(2).border_color(k.line), 2, 5))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(pill(k, `${projects} projects`, k.dim))
          .when(working > 0, (el) => el.child(pill(k, `${working} running`, k.yellow)))
          .when(needs > 0, (el) => el.child(pill(k, `${needs} needs you`, k.red).loop("opacity", { from: 0.55, to: 1, period: 1200 })))
          .when(Boolean(next), (el) =>
            el.child(
              div()
                .id("orcha-update")
                .cursor_pointer()
                .tooltip("A bigger whale surfaced. Click to release it.")
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  openSettings("whale");
                })
                .child(raised(k, chip(k, `🐋 ${next.latest} IS OUT · UPDATE`, k.pink).h(22).px(8).border(2).border_color(k.line), 2, 5).loop("opacity", { from: 0.7, to: 1, period: 1600 })),
            ),
          )
          .when(!next && Boolean(waiting), (el) =>
            el.child(
              div()
                .id("orcha-restart")
                .cursor_pointer()
                .tooltip("Installed. Herdr loads it after a restart.")
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  openSettings("whale");
                })
                .child(raised(k, chip(k, `🐋 ${waiting} · RESTART HERDR`, k.pink).h(22).px(8).border(2).border_color(k.line), 2, 5).loop("opacity", { from: 0.7, to: 1, period: 1600 })),
            ),
          ),
      )
      .child(div().flex_1())
      .child(div().w(340).flex_shrink(1).min_w(160).child(search))
      .child(div().flex_1())
      .child(square(k, "orcha-palette", "command", "Commands (⌘⇧P)", () => run("app.palette")))
      .child(square(k, "orcha-accounts", "user-round", "Accounts", openAccounts))
      .child(square(k, "orcha-settings", "settings", "Settings (⌘,)", () => openSettings()));
  }
}
