// FILES on the right (sidetabs.js): the focused folder's files as a tree, and
// a search box over the whole project, by file name (NAME) or by what is
// inside the files (TEXT). Clicking a file opens it in the viewer beside your
// work (viewer.js); the same viewer is reused while it is open in the tab.
// Right-click a file or a folder: open it in the editor, its app or Finder,
// a new tab in a folder, copy its path (menu.js).
//
// The tree is adapted from Herdr's own `files` mod (Apache-2.0, see NOTICE).
// Search runs ripgrep when it is installed, else git or grep.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, run, shared, setShared, openOverlay } from "herdr";
import { tokens, icon, readable } from "./ui.js";
import { menuHeight } from "./menu.js";

const PER_FOLDER = 500;
const TOTAL = 5000;
const RESULTS = 200;

export function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

async function directory(path, on) {
  const script =
    'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// The project's root: the git checkout around `cwd`, else `cwd`.
export async function projectRoot(cwd, on) {
  const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { on }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : cwd;
}

// Every file in the project, relative to `root` (ignored files left out).
const LIST_FILES = 'cd "$1" || exit 1; if command -v rg >/dev/null 2>&1; then rg --files --hidden -g "!.git" 2>/dev/null; elif git rev-parse >/dev/null 2>&1; then git ls-files -co --exclude-standard; else find . -type f -not -path "*/.git/*" | sed "s|^\\./||"; fi | head -n 20000';
// Lines holding the text: path:line:text, a few per file.
const GREP = 'cd "$1" || exit 1; if command -v rg >/dev/null 2>&1; then rg -n -S -F --no-heading --max-count 5 --max-columns 240 --max-columns-preview --hidden -g "!.git" -- "$2" 2>/dev/null; else grep -rnIF --exclude-dir=.git -m 5 -- "$2" . 2>/dev/null | sed "s|^\\./||"; fi | head -n 300';

// "src/app/main.rs" for "mainrs" or "app main": every word appears, in order.
function matches(path, words) {
  const p = path.toLowerCase();
  let at = 0;
  for (const w of words) {
    const i = p.indexOf(w, at);
    if (i < 0) return -1;
    at = i + w.length;
  }
  // Shorter paths and hits in the file name first.
  const name = p.slice(p.lastIndexOf("/") + 1);
  return (words.every((w) => name.includes(w)) ? 0 : 1000) + p.length;
}

/** Files in `root` whose path holds every word of `query`, best first. */
export async function findFiles(root, on, query, cache = {}) {
  if (cache.root !== root || !cache.files) {
    const r = await exec("sh", ["-c", LIST_FILES, "orcha", root], { on });
    cache.root = root;
    cache.files = r.stdout.split("\n").filter(Boolean);
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return cache.files
    .map((path) => ({ path, score: matches(path, words) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, RESULTS);
}

/** Lines in `root`'s files holding `query`: { path, line, text }. */
export async function findText(root, on, query) {
  const r = await exec("sh", ["-c", GREP, "orcha", root, query], { on });
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (m) out.push({ path: m[1], line: Number(m[2]), text: m[3].trim() });
  }
  return out;
}

/** Opens `path` (inside `root`) in the viewer beside your work: with
 *  `query`, the lines holding it listed on top; with `line`, that line. */
export function openFile(root, path, on, query = null, line = null) {
  setShared("orcha.view", { root, path, on: on ?? null, query, line, seq: Date.now() });
  const tab = focused()?.tab;
  const viewer = panes().find((p) => p.mod === "orcha" && p.tab === tab);
  if (viewer) run("pane.focus", { pane: viewer.pane });
  else run("pane.split", { direction: "right", mod: "orcha", props: { part: "viewer" } });
}

export default class Files {
  constructor(cx) {
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.mode = "name"; // or "text"
    this.query = "";
    this.results = null;
    this.list = {}; // the project's files, read once per project
    this.searchInput = InputState.new({ placeholder: "Search this project" });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value();
      this.searchSoon(cx);
    });
    this.searchInput.on("submit", (_e, cx) => {
      const first = this.results?.[0];
      if (first) openFile(this.projectRoot, first.path, this.on, this.mode === "text" ? this.query : null);
      cx.notify();
    });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (this.current(context)) this.refresh(cx);
        }
      } catch {
        if (this.context === context) this.watched = null;
      }
    });
  }

  async loadFolder(path, context) {
    const entries = await directory(path ? `${context.cwd}/${path}` : context.cwd, context.on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
  }

  refresh(cx) {
    const { cwd, on } = location();
    const next = key();
    if (next !== this.context?.key) {
      this.context = { key: next, cwd, on };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set();
      this.pending = new Set();
      this.marks = {};
      this.watched = null;
      this.error = null;
      this.loading = false;
      this.list = {};
      this.projectRoot = cwd;
      if (cwd) cx.spawn(async (cx) => {
        this.projectRoot = await projectRoot(cwd, on);
        if (this.query) this.search(cx);
      });
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", "."], { on }).catch(() => null);
        const top = await projectRoot(cwd, on);
        const marks = {};
        if (status?.code === 0) {
          for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  // Right-click: the menu for a file or a folder (`rel`: its path in the project).
  menu(rel, dir, extra = {}) {
    return (_e, cx) => {
      cx.stop_propagation();
      const target = { kind: "file", root: this.projectRoot, rel, dir, on: this.on ?? null, name: rel.split("/").pop(), ...extra };
      openOverlay({ mod: "orcha", props: { part: "menu", target }, kind: "popup", at: "pointer", frame: "none", width: 230, height: menuHeight(target) });
    };
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) {
        if (folder === path || folder.startsWith(`${path}/`)) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context);
          } catch (e) {
            if (this.current(context)) this.error = String(e);
          } finally {
            if (this.context === context) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  // Searching waits for a short pause in typing.
  searchSoon(cx) {
    const asked = (this.asked = (this.asked ?? 0) + 1);
    cx.timer.after(220, (cx) => {
      if (asked === this.asked) this.search(cx);
    });
    cx.notify();
  }

  search(cx) {
    const query = this.query.trim();
    if (!query) {
      this.results = null;
      cx.notify();
      return;
    }
    const root = this.projectRoot;
    const on = this.on;
    const mode = this.mode;
    this.searching = true;
    cx.spawn(async (cx) => {
      this.list ??= {};
      const results = mode === "name" ? await findFiles(root, on, query, this.list) : await findText(root, on, query);
      // Only the answer to the latest question counts.
      if (query !== this.query.trim() || mode !== this.mode) return;
      this.results = results;
      this.searching = false;
      cx.notify();
    });
  }

  rows(prefix, depth, out, k) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path);
      const mark = this.marks[`${this.projectRoot}/${path}`] ?? this.marks[`${this.root}/${path}`];
      const viewing = shared("orcha.view")?.path === `${this.relative()}${path}`;
      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(26)
          .flex_none()
          .pl(6 + depth * 14)
          .pr(6)
          .gap(6)
          .items_center()
          .rounded(4)
          .bg(viewing ? k.yellow + "40" : "#00000000")
          .cursor_pointer()
          .hover((s) => s.bg(k.hover))
          .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : openFile(this.projectRoot, `${this.relative()}${path}`, this.on)))
          .on_mouse_down("right", this.menu(`${this.relative()}${path}`, entry.dir))
          .child(entry.dir ? icon(open ? "chevron-down" : "chevron-right", 11, k.dim) : div().w(11).flex_none())
          .child(icon(entry.dir ? "folder" : "file", 13, entry.dir ? k.ink : k.muted))
          .child(div().flex_1().min_w(0).truncate().text_color(k.foreground).child(entry.name))
          .when(Boolean(mark), (el) => el.child(div().text_size(10.5).font_black().text_color(readable(k, mark === "A" ? k.green : mark === "M" ? k.yellow : k.red)).child(mark))),
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, k);
    }
    return out;
  }

  // The folder shown, relative to the project root ("" or "app/").
  relative() {
    if (!this.root || !this.projectRoot || this.root === this.projectRoot) return "";
    return this.root.startsWith(`${this.projectRoot}/`) ? `${this.root.slice(this.projectRoot.length + 1)}/` : "";
  }

  result(k, r, i) {
    const slash = r.path.lastIndexOf("/");
    const dir = slash >= 0 ? r.path.slice(0, slash + 1) : "";
    const name = r.path.slice(slash + 1);
    return v_flex()
      .id(`hit-${i}`)
      .flex_none()
      .px(6)
      .py(4)
      .gap(1)
      .rounded(4)
      .cursor_pointer()
      .hover((s) => s.bg(k.hover))
      .on_click(() => openFile(this.projectRoot, r.path, this.on, this.mode === "text" ? this.query.trim() : null))
      .on_mouse_down("right", this.menu(r.path, false, { query: this.mode === "text" ? this.query.trim() : null, line: r.line ?? null }))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(icon("file", 12, k.muted))
          .child(div().flex_none().font_bold().text_color(k.ink).child(name))
          .when(r.line != null, (el) => el.child(div().flex_none().text_size(10.5).text_color(k.dim).child(`:${r.line}`)))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(k.dim).child(dir)),
      )
      .when(Boolean(r.text), (el) => el.child(div().pl(18).truncate().text_size(11.5).text_color(k.muted).child(r.text)));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const k = tokens();
    const modeChip = (id, label) => {
      const on = this.mode === id;
      return div()
        .id(`files-mode-${id}`)
        .px(7)
        .h(22)
        .flex()
        .items_center()
        .rounded(4)
        .border(2)
        .border_color(on ? k.line : "#00000000")
        .bg(on ? k.ink : k.card)
        .text_size(10.5)
        .font_black()
        .text_color(on ? k.paper : k.muted)
        .cursor_pointer()
        .on_click((_e, cx) => {
          this.mode = id;
          this.results = null;
          this.search(cx);
        })
        .child(label);
    };
    const searchBox = v_flex()
      .flex_none()
      .gap(6)
      .p(8)
      .border_b(2)
      .border_color(k.line)
      .child(
        h_flex()
          .h(30)
          .px(8)
          .gap(6)
          .items_center()
          .rounded(5)
          .border(2)
          .border_color(k.line)
          .bg(k.paper)
          .child(icon("search", 13, k.muted))
          .child(Input.new(this.searchInput).flex_1().min_w(0).h(26).text_size(12.5).text_color(k.ink))
          .when(Boolean(this.query), (el) =>
            el.child(
              div()
                .id("files-clear")
                .cursor_pointer()
                .on_click((_e, cx) => {
                  this.searchInput.set_value("");
                  this.query = "";
                  this.results = null;
                  cx.notify();
                })
                .child(icon("x", 12, k.dim)),
            ),
          ),
      )
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .child(modeChip("name", "NAME"))
          .child(modeChip("text", "TEXT"))
          .child(div().flex_1())
          .child(div().truncate().text_size(10.5).text_color(k.dim).child(this.projectRoot?.split("/").pop() ?? "")),
      );
    const body = this.results
      ? v_flex()
          .id("files-results")
          .flex_1()
          .min_h(0)
          .p(6)
          .overflow_y_scrollbar()
          .text_size(12)
          .children(this.results.map((r, i) => this.result(k, r, i)))
          .when(!this.results.length, (el) => el.child(div().p(8).text_size(12).text_color(k.dim).child(this.mode === "text" ? "No file holds that text." : "No file by that name.")))
      : v_flex()
          .id("files-tree")
          .flex_1()
          .min_h(0)
          .p(6)
          .overflow_y_scrollbar()
          .text_size(12.5)
          .children(this.rows("", 0, [], k))
          .when(Boolean(this.error) || !this.entries.get("")?.length, (el) => el.child(div().p(8).text_size(12).text_color(k.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))));
    return v_flex()
      .id("orcha-files")
      .size_full()
      .p(10)
      .pt(10)
      .bg(k.paper)
      .child(v_flex().size_full().min_h(0).rounded(6).border(2).border_color(k.line).bg(k.card).overflow_hidden().child(searchBox).child(body));
  }
}
