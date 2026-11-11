// Right-click menus in orcha's look: a project's, a pane's or a file's (Menu,
// opened by orcha with props().target), and a terminal's (TerminalMenu, the layout's
// terminal_menu: Open and Copy for the link under the pointer or selected,
// Copy and Paste, then the pane's items, like any terminal).
// Closing actions sit last, in red.

import { div } from "gpui-kit";
import { props, run, openOverlay, panes, terminals, notify, hc, layout, settings, shared, setShared, window } from "herdr";
import { tokens, drawMenu, closePane, openWorktree } from "./ui.js";
import { linkInSelection, openLink, placeLinks, linkAt, transcriptLinks, completeLinks, systemOpen, openInEditor } from "./links.js";
import { projectRoot, openFile } from "./files.js";
import { ICON_OVERLAY } from "./icon.js";
import { openProjectAccount } from "./new.js";

// A project's or a pane's rows: [icon, label, action, danger]; closing
// actions sit last, after a line. A worktree (left.js: `linked`) can be
// removed (Herdr's dialog closes its space, then `git worktree remove`; the
// branch stays).
function items(target) {
  const t = target ?? {};
  if (t.kind === "file") {
    // FILES (files.js): { root, rel, dir, on, query, line }. Another
    // machine's files can only be shown in the viewer here.
    const full = `${t.root}/${t.rel}`;
    const platform = window()?.platform;
    const finder = platform === "macos" ? "Finder" : platform === "windows" ? "Explorer" : "the file manager";
    const copy = (text) => (cx) => cx.write_to_clipboard(text);
    const view = ["file", "Open in viewer", () => openFile(t.root, t.rel, t.on, t.query ?? null, t.line ?? null)];
    const copies = [["copy", "Copy path", copy(full)], ["copy", "Copy relative path", copy(t.rel)]];
    if (t.on) return [...(t.dir ? [] : [view, null]), ...copies];
    if (t.dir) {
      return [
        ["folder", `Open in ${finder}`, () => systemOpen(full)],
        ["code-xml", "Open in editor", () => openInEditor(full, null, null, true)],
        ["terminal", "New tab here", () => run("tab.new", { folder: full })],
        null,
        ...copies,
      ];
    }
    return [
      view,
      ["code-xml", "Open in editor", () => openInEditor(full, t.line ?? 1)],
      ["chevron-right", "Open with its app", () => systemOpen(full)],
      ["folder", `Show in ${finder}`, () => systemOpen(full, true)],
      null,
      ...copies,
    ];
  }
  if (t.kind === "project") {
    return [
      ["chevron-right", "Open", () => run("space.select", { id: t.id })],
      ["plus", "New tab", () => run("tab.new", { space: t.id })],
      ["settings", "Rename…", () => run("space.rename", { id: t.id })],
      ["zap", "Set icon…", () => openOverlay({ mod: "orcha", props: { part: "icon", target: t }, ...ICON_OVERLAY })],
      ["user-round", "Claude account…", () => openProjectAccount(t.id)],
      null,
      ...(t.linked ? [["git-branch", "Remove worktree…", () => openWorktree(t.id, "remove"), true]] : []),
      ["x", "Close project", () => run("space.close", { id: t.id }), true],
    ];
  }
  return [
    ["chevron-right", "Focus", () => run("pane.focus", { pane: t.pane })],
    ["settings", "Rename tab…", () => run("tab.rename", { id: t.tab })],
    ["columns-2", "Split right", () => run("pane.split", { direction: "right", pane: t.pane })],
    ["maximize-2", "Zoom", () => run("pane.zoom", { pane: t.pane })],
    null,
    ["x", "Close pane", () => closePane(t.pane), true],
  ];
}

/** The menu's height for `target`: 30 per row, 10 per line, title and edges. */
export function menuHeight(target) {
  const rows = items(target);
  return 50 + rows.filter(Boolean).length * 30 + rows.filter((r) => !r).length * 10;
}

export default class Menu {
  constructor(_cx) {}

  render(_cx) {
    const target = props()?.target;
    return drawMenu(tokens(), target?.kind === "file" ? target.name ?? "" : (target?.name ?? "").toUpperCase(), items(target));
  }
}

// What is selected in the terminal: copied, read back, and the clipboard
// put back as it was (Herdr has no other way to read a selection). Null
// when nothing new was selected.
async function selection(cx, pane) {
  const before = cx.read_from_clipboard();
  run("pane.focus", { pane });
  run("terminal.copy");
  await new Promise((done) => cx.timer.after(60, done));
  const after = cx.read_from_clipboard();
  if (!after || after === before) return null;
  if (before !== undefined) cx.write_to_clipboard(before);
  return after.trim();
}

// Rows are this many times taller than columns are wide, measured on a pane
// alone in its tab; until then, Geist Mono's.
const CELL_RATIO = 2.57;

// The cell under a window point. A pane alone in its tab: the layout says
// where its terminal is. In a split tab: its title bar, where the pointer last
// passed over it (pane.js). The terminal fills that place in rows and columns.
function cellAt(point, pane, size) {
  if (!point || !pane || !size.cols || !size.rows) return null;
  const tree = layout();
  // Layout sizes grow with the app's zoom; the pointer and the window do not.
  const zoom = settings().zoom ?? 1;
  const [padY, padX] = tree.terminal_padding ?? [0, 0];
  const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);
  const inside = (left, top, right, bottom) =>
    point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
      ? { row: Math.floor(((point.y - top) / (bottom - top)) * size.rows), col: Math.floor(((point.x - left) / (right - left)) * size.cols) }
      : null;
  const alone = pane.zoomed || panes().filter((p) => p.tab === pane.tab).length === 1;
  if (!alone) {
    const bar = shared("orcha.paneBounds")?.[pane.pane];
    if (!bar) return null;
    const left = bar.x + padX * zoom;
    const right = bar.x + bar.w - padX * zoom;
    const top = bar.y + bar.h + padY * zoom;
    const cell = (right - left) / size.cols;
    return inside(left, top, right, top + size.rows * cell * (shared("orcha.cellRatio") ?? CELL_RATIO));
  }
  const px = (id) => {
    const node = find(tree, id);
    return node && !node.hidden ? node.size?.px ?? 0 : 0;
  };
  const view = globalThis.window.viewport_size();
  const main = find(tree, "main");
  const work = find(tree, "work");
  const edge = find(tree, "frame")?.border?.width ?? 0;
  const header = main?.content?.pane?.header?.height ?? 0;
  const side = (work?.padding?.[1] ?? 0) + edge + (main?.padding?.[1] ?? 0) + padX;
  const left = (px("sidebar") + side) * zoom;
  const right = view.width - (px("right") + side) * zoom;
  const top = (px("header") + (work?.padding?.[0] ?? 0) + edge + px("tabs") + header + padY) * zoom;
  const bottom = view.height - (px("status") + (work?.padding?.[0] ?? 0) + edge + px("frame-foot") + padY) * zoom;
  const ratio = ((bottom - top) / size.rows) / ((right - left) / size.cols);
  if (Math.abs(ratio - (shared("orcha.cellRatio") ?? 0)) > 0.02) setShared("orcha.cellRatio", Math.round(ratio * 1000) / 1000);
  return inside(left, top, right, bottom);
}

export class TerminalMenu {
  constructor(cx) {
    this.ready = false; // shown once known what it holds, so its rows don't jump
    this.link = null; // the link selected or under the pointer
    this.selected = null;
    const target = props()?.target ?? {};
    this.pane = panes().find((p) => p.pane === target.pane) ?? null;
    // Where the right-click was, before the pointer moves on.
    const point = globalThis.window.mouse_position();
    cx.spawn(async (cx) => {
      this.selected = await selection(cx, target.pane);
      const chosen = this.selected ? linkInSelection(this.selected) : null;
      this.link = chosen ?? (target.terminal ? await this.linkUnder(target.terminal, point) : null);
      this.ready = true;
      cx.notify();
    });
  }

  // The link under the right-click: as the screen shows it, else one Claude
  // wrote whose label is there.
  async linkUnder(terminal, point) {
    const [screen, info] = await Promise.all([hc(["read", "--json", terminal]), hc(["get", "--json", terminal])]);
    let text = "";
    let size = {};
    try {
      text = JSON.parse(screen.stdout).text ?? "";
      size = JSON.parse(info.stdout);
    } catch {
      return null;
    }
    const cell = cellAt(point, this.pane, size);
    if (!cell) return null;
    const claude = this.pane?.program?.key?.includes("claude");
    const shown = linkAt(placeLinks(text, size.cols), cell);
    if (shown) return claude ? (await completeLinks([shown], this.pane.cwd))[0] : shown;
    return claude ? linkAt(placeLinks(text, size.cols, await transcriptLinks(this.pane.cwd)), cell) : null;
  }

  async open(link) {
    const cwd = this.pane?.cwd ?? null;
    const root = cwd ? await projectRoot(cwd, null) : null;
    const failed = await openLink(link, { cwd, root, on: null });
    if (failed) notify({ title: failed, level: "warning", timeout: 4000 });
  }

  render(_cx) {
    if (!this.ready) return div();
    const k = tokens();
    const tg = props()?.target ?? {};
    const all = terminals();
    const term = all.find((t) => t.address === tg.terminal);
    const parent = term?.parent && all.find((t) => t.address === term.parent);
    const toProgram = term?.labels?.["herdr.right-click"] === "program";
    const link = this.link;
    const kind = link?.url ? "link" : "file";
    const rows = [
      ...(link
        ? [
            [link.url ? "globe" : "file", `Open ${kind}`, () => this.open(link)],
            ["copy", link.url ? "Copy link" : "Copy path", (cx) => cx.write_to_clipboard(link.raw)],
            null,
          ]
        : []),
      ...(this.selected ? [["copy", "Copy", (cx) => cx.write_to_clipboard(this.selected)]] : []),
      ["paste", "Paste", () => run("terminal.paste")],
      null,
      ["columns-2", "Split right", () => run("pane.split", { direction: "right", pane: tg.pane })],
      ["rows-2", "Split down", () => run("pane.split", { direction: "down", pane: tg.pane })],
      ["maximize-2", this.pane?.zoomed ? "Unzoom" : "Zoom", () => run("pane.zoom", { pane: tg.pane })],
      ...(toProgram ? [["menu", "Use this menu on right-click", () => run("terminal.right_click", { terminal: term.address, to: "menu" })]] : []),
      ...(parent ? [["arrow-down", `Send back to ${parent.name || parent.address}`, () => run("terminal.park", { terminal: term.address })]] : []),
      null,
      ["x", "Close pane", () => closePane(tg.pane), true],
    ];
    return drawMenu(k, link ? link.label ?? link.raw : null, rows);
  }
}
