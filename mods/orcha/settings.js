// orcha's settings: Herdr's own settings page (frame/settings, Apache-2.0)
// with orcha's sections on top: Projects (working rules and skills),
// Accounts and Layout. Writes changes immediately; no Save step.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, TextView } from "gpui-base";
import { hc, run, theme, themes, fonts, updates, telemetry, settings, layouts, shared, setShared, appHome, readTextFile, writeTextFile, playSound, props, closeOverlay, window, spaces, exec, home, layout, notify } from "herdr";
import { RULES, SKILLS } from "./catalog.js";
import { configFile } from "./paths.js";
import { fuelGauge, tokens, projectTile, raised, chip } from "./ui.js";
import { VERSION, REPO, updateInfo, available, checkUpdate, runUpdate } from "./version.js";
import { readAccounts, tokenState, needsSignIn, makeDefault, refreshFuel, addAccount, signIn, ACCOUNT_KINDS, readHandoff, writeHandoff, HANDOFF_DEFAULTS, isStation, stationStatus, stationProbe, stationPair, stationForget, stationAddress } from "./accounts-data.js";

// Copies skill folders from a GitHub repo's tarball: no Node needed. A skill
// is the folder whose SKILL.md says `name: <skill>`, else a folder so named.
// Args: repo, destination, skill names.
const FROM_GITHUB = `src=$1 dest=$2; shift 2
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$src/tar.gz/HEAD" | tar -xz -C "$tmp" || { echo "could not download $src from GitHub" >&2; exit 1; }
mkdir -p "$dest" || exit 1
for name in "$@"; do
  f=$(grep -rlE --include=SKILL.md "^name: *[\\"']?\${name}[\\"']? *\\$" "$tmp" | head -1)
  [[ -z $f ]] && f=$(find "$tmp" -path "*/$name/SKILL.md" | head -1)
  [[ -z $f ]] && { echo "$name is not in $src" >&2; exit 1; }
  rm -rf "$dest/$name" && cp -R "\${f:h}" "$dest/$name" || exit 1
done`;

// `npx skills add` arguments: in the project, or for the user (-g).
const skillArgs = (skill, global) => ["-y", "skills", "add", skill.source, "--skill", ...skill.skills, "-a", "claude-code", "-y", ...(global ? ["-g"] : [])];

const I = (name) => `frame/settings/${name}.svg`;

const O = (name) => `mods/orcha/icons/${name}.svg`;

const SECTIONS = [
  { id: "projects", title: "Projects", svg: O("git-fork") },
  { id: "accounts", title: "Accounts", svg: O("fuel") },
  { id: "handoff", title: "Hand-off", svg: O("handoff") },
  { id: "orcha", title: "Layout", svg: O("columns-2") },
  { id: "whale", title: "orcha", emoji: "🐋" },
  { id: "look", title: "Look", icon: "palette" },
  ...(window()?.platform === "macos" ? [{ id: "keyboard", title: "Keyboard", icon: "keyboard" }] : []),
  { id: "machines", title: "Machines", icon: "server" },
  { id: "alerts", title: "Alerts", icon: "bell" },
  { id: "updates", title: "Updates", icon: "refresh" },
  { id: "privacy", title: "Privacy", icon: "shield" },
];

// One marked block in CLAUDE.md holds the working rules (Orcherd's own markers).
const BLOCK_START = "<!-- orcherd:rules start · managed by Orcherd (Settings › Projects); edit them there -->";
const BLOCK_START_PREFIX = "<!-- orcherd:rules start";
const BLOCK_END = "<!-- orcherd:rules end -->";
const RULE_MARK = "<!-- orcherd:rule ";

function blockSpan(text) {
  const start = text.indexOf(BLOCK_START_PREFIX);
  if (start < 0) return null;
  const end = text.indexOf(BLOCK_END, start);
  return end < 0 ? null : [start, end + BLOCK_END.length];
}

function rulesIn(text) {
  const span = blockSpan(text);
  if (!span) return [];
  const block = text.slice(span[0], span[1]);
  const ids = [];
  let at = block.indexOf(RULE_MARK);
  while (at >= 0) {
    const id = block.slice(at + RULE_MARK.length).split(/\s/)[0];
    if (RULES.some((r) => r.id === id)) ids.push(id);
    at = block.indexOf(RULE_MARK, at + 1);
  }
  return ids;
}

function blockFor(ids) {
  let out = `${BLOCK_START}\n## Working rules\n`;
  for (const rule of RULES.filter((r) => ids.includes(r.id))) out += `\n${RULE_MARK}${rule.id} -->\n### ${rule.title}\n\n${rule.body}\n`;
  return out + BLOCK_END;
}

function withRules(text, ids) {
  const block = ids.length ? blockFor(ids) : null;
  const span = blockSpan(text);
  if (span && block) return text.slice(0, span[0]) + block + text.slice(span[1]);
  if (span) {
    const before = text.slice(0, span[0]).replace(/\n+$/, "");
    const after = text.slice(span[1]).replace(/^\n+/, "");
    if (!before) return after;
    return after ? `${before}\n\n${after}` : `${before}\n`;
  }
  if (!block) return text;
  if (!text.trim()) return `${block}\n`;
  return `${text.replace(/\n+$/, "")}\n\n${block}\n`;
}

const LOOKS = { main: "Herdr", terminals: "Terminals", win98: "Herdr 98" };
const APPEARANCES = [
  [null, "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

// What the app uses when settings.json names no font (settings.rs).
const DEFAULT_FONT = "JetBrains Mono";
const DEFAULT_UI_FONT = "Geist";

export default class Settings {
  constructor(cx) {
    this.init(null, cx);
  }

  init(_props, cx) {
    // A low-fuel note asks for Accounts (handoff-watch.js) for a short while.
    const pending = shared("orcha.openSection");
    if (pending && pending.until > Date.now()) setShared("orcha.openSection", null);
    const asked = props()?.section ?? (pending && pending.until > Date.now() ? pending.id : null);
    this.section = SECTIONS.some((s) => s.id === asked) ? asked : "projects";
    this.orcha = { project: null, info: null, busy: {}, failed: {}, addKind: "claude", accountTab: "local", accounts: null, active: null, icons: {} };
    cx.spawn(async (cx) => {
      try {
        this.orcha.icons = JSON.parse((await readTextFile(configFile("project-icons.json"))) ?? "{}") ?? {};
      } catch {
        this.orcha.icons = {};
      }
      cx.notify();
    });
    this.picking = null; // "font" | "ui_font" while its list is open
    this.filter = "";
    this.fontInput = InputState.new({ placeholder: "Type to search fonts" });
    this.fontInput.on("change", (_e, cx) => { this.filter = this.fontInput.value(); cx.notify(); });
    this.accountInput = InputState.new({ placeholder: "name, like personal or work" });
    this.accountInput.on("submit", (_e, cx) => this.addAccount(cx));
    this.stationUrlInput = InputState.new({ placeholder: "hub address, like kien-mac.local:8787" });
    this.stationUrlInput.on("submit", (_e, cx) => this.stationCheck(cx));
    this.stationAddressInput = InputState.new({ placeholder: "new hub address, e.g. mac.local:8787" });
    this.stationAddressInput.on("submit", (_e, cx) => this.stationMove(cx));
    this.stationCodeInput = InputState.new({ placeholder: "6-digit code" });
    this.stationCodeInput.on("submit", (_e, cx) => this.stationPairGo(cx));
    this.renameInput = InputState.new();
    this.renameInput.on("focus", (_e, cx) => { this.renameFocused = true; cx.notify(); });
    this.renameInput.on("blur", (_e, cx) => { this.renameFocused = false; cx.notify(); });
    this.renameInput.on("change", (_e, cx) => { if (this.machineEdit?.action === "rename") this.machineEdit.name = this.renameInput.value(); cx.notify(); });
    this.renameInput.on("submit", (_e, cx) => {
      const edit = this.machineEdit;
      if (edit?.action === "rename") this.machineAction(edit.machine, "rename", cx, edit.name);
    });
    this.person = {};
    this.raw = null;
    this.previews = {}; // layout name -> its "preview" picture
    this.previewsOf = "";
    this.showData = false;
    this.machineList = null;
    this.machineLoading = false;
    this.machineError = null;
    this.machineBusy = {};
    this.machineResults = {};
    this.machineEdit = null;
    this.machineNotice = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      await this.load();
      if (this.section === "machines") await this.loadMachines();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      if (this.section === "projects") this.loadProject(cx);
      if (this.section === "accounts") this.loadAccounts(cx);
    });
    // After "Check now": follow the look (the answer comes from the app), then
    // "Up to date" for a moment.
    cx.timer.every(300, (cx) => {
      if (!this.asked) return;
      if (updates().checking) this.asked = Date.now();
      else if (Date.now() - this.asked >= 3000) this.asked = null;
      cx.notify();
    });
    cx.timer.every(3000, (cx) => {
      if (this.section !== "machines") return;
      cx.spawn(async (cx) => {
        await this.loadMachines();
        cx.notify();
      });
    });
  }

  file() {
    return `${appHome()}/settings.json`;
  }

  // Each layout file may name a picture of itself (`"preview"` on its root).
  loadPreviews(names, cx) {
    this.previewsOf = names.join("\n");
    cx.spawn(async (cx) => {
      const found = {};
      for (const name of names) {
        try {
          const preview = JSON.parse((await readTextFile(`${appHome()}/layouts/${name}.json`)) ?? "{}").preview;
          if (typeof preview === "string" && preview) found[name] = preview;
        } catch {}
      }
      this.previews = found;
      cx.notify();
    });
  }

  async load() {
    this.raw = await readTextFile(this.file());
    try {
      this.person = this.raw ? JSON.parse(this.raw) : {};
    } catch {
      this.person = {};
    }
  }

  // Changes settings.json the way an agent would: read, change, write back
  // only if nobody changed it meanwhile (else read again and redo).
  change(edit, cx) {
    cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.load();
        const next = JSON.parse(JSON.stringify(this.person));
        edit(next);
        try {
          await writeTextFile(this.file(), JSON.stringify(next, null, 2) + "\n", this.raw);
          this.person = next;
          break;
        } catch {}
      }
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Pieces ---------------------------------------------------------------

  heading(t, text) {
    return div().pt(6).pb(8).text_size(12).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  // One setting: what it is on the left, the control on the right.
  row(t, title, about, control) {
    return h_flex()
      .w_full()
      .gap(16)
      .py(12)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().text_size(14).text_color(t.foreground).child(title))
          .when(Boolean(about), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(about))),
      )
      .child(div().flex_none().child(control));
  }

  button(t, id, label, onClick) {
    return div()
      .id(id)
      .px(12)
      .py(5)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .cursor_pointer()
      .text_size(13)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(label);
  }

  // − value +
  stepper(t, id, value, onMinus, onPlus) {
    const b = (k, label, f) =>
      div()
        .id(`${id}-${k}`)
        .w(28)
        .h(28)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .text_size(15)
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(f)
        .child(label);
    return h_flex()
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .overflow_hidden()
      .child(b("minus", "\u2212", onMinus))
      .child(div().w(54).text_size(13).text_color(t.foreground).flex().justify_center().child(value))
      .child(b("plus", "+", onPlus));
  }

  toggle(t, id, on, onClick) {
    return div()
      .id(id)
      .w(36)
      .h(20)
      .rounded(10)
      .p(2)
      .cursor_pointer()
      .bg(on ? t.accent : t.hover)
      .flex()
      .when(on, (el) => el.justify_end())
      .on_click(onClick)
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
  }

  // Look -----------------------------------------------------------------

  // A small drawing of each layout, in the theme's colors (as the welcome draws them).
  preview(t, name) {
    const row = () => div().flex().flex_row();
    const col = () => div().flex().flex_col();
    const term = (bg = t.background, edge = t.border) => div().flex_1().rounded(2).bg(bg).border_1().border_color(edge);
    const line = (w, c = t.dim) => div().h(3).w(w).flex_none().rounded(2).bg(c);
    const lines = (n, c) => col().gap(4).p(5).children([...Array(n)].map((_, i) => line(i % 2 ? 22 : 32, c)));
    const frame = (el) => el.size_full().rounded(6).overflow_hidden().border_1().border_color(t.border).bg(t.surface);
    if (name === "main")
      return frame(row())
        .child(col().w(42).border_r(1).border_color(t.border).child(lines(4)))
        .child(
          col()
            .flex_1()
            .child(row().h(11).gap(2).p(2).border_b(1).border_color(t.border).child(div().w(20).rounded(2).bg(t.accent)).child(div().w(16).rounded(2).bg(t.raised)).child(div().w(16).rounded(2).bg(t.raised)))
            .child(row().flex_1().p(4).gap(3).child(term()).child(term())),
        );
    if (name === "terminals") {
      const card = () => col().flex_1().rounded(4).border_1().border_color("#2c2f34").bg("#17191c").child(row().h(7).px(3).items_center().border_b(1).border_color("#25282c").child(line(14, "#5d6168")));
      return frame(col())
        .bg("#131619")
        .p(4)
        .gap(4)
        .child(row().h(10).gap(3).p(1).rounded(4).bg("#1d1f22").child(div().w(30).rounded(3).bg("#34373c").border_1().border_color("#4a4d53")).child(div().w(30)))
        .child(row().flex_1().gap(4).child(card()).child(card()));
    }
    // A layout of the person's own: a plain frame.
    return frame(col()).child(row().h(11).border_b(1).border_color(t.border)).child(row().flex_1().p(4).child(term()));
  }

  layoutPicker(t, cx) {
    const current = shared("layout") ?? "main";
    // Shipped looks in the welcome's order, then the person's own; new files show up by themselves.
    const shipped = Object.keys(LOOKS);
    const rank = (n) => (shipped.includes(n) ? shipped.indexOf(n) : shipped.length);
    const names = [...layouts()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (names.join("\n") !== this.previewsOf) this.loadPreviews(names, cx);
    return h_flex()
      .w_full()
      .flex_wrap()
      .gap(8)
      .children(
        names.map((name) => {
          const on = name === current;
          return v_flex()
            .id(`st-l-${name}`)
            .w(124)
            .gap(6)
            .p(6)
            .rounded(10)
            .border_2()
            .border_color(on ? t.accent : "#00000000")
            .bg(on ? t.raised : "#00000000")
            .cursor_pointer()
            .hover((s) => s.bg(t.raised))
            .on_click((_e, cx) => {
              run("layout.switch", { name });
              cx.notify();
            })
            .child(
              div()
                .h(62)
                .w_full()
                .child(
                  this.previews[name]
                    ? image(this.previews[name]).size_full().rounded(6).border_1().border_color(t.border)
                    : this.preview(t, name),
                ),
            )
            .child(
              h_flex()
                .gap(5)
                .items_center()
                .child(div().text_size(12.5).text_color(on ? t.foreground : t.muted).child(LOOKS[name] ?? name))
                .when(on, (el) => el.child(svg(I("check")).size(12).text_color(t.accent))),
            );
        }),
      );
  }

  // One of a few: [value, label] pairs side by side, `now` raised.
  segmented(t, id, options, now, onPick) {
    return h_flex()
      .p(2)
      .gap(2)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .children(
        options.map(([value, label]) =>
          div()
            .id(`${id}-${label}`)
            .px(12)
            .py(4)
            .rounded(6)
            .text_size(13)
            .cursor_pointer()
            .when(now === value, (el) => el.bg(t.raised).text_color(t.foreground).border_1().border_color(t.border))
            .when(now !== value, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => onPick(value, cx))
            .child(label),
        ),
      );
  }

  appearancePicker(t, cx) {
    return this.segmented(t, "st-ap", APPEARANCES, this.person.appearance ?? null, (value, cx) =>
      this.change((p) => {
        if (value === null) delete p.appearance;
        else p.appearance = value;
      }, cx),
    );
  }

  themePicker(t, light) {
    const s = settings();
    const current = light ? s.theme_light : s.theme_dark;
    return h_flex()
      .w_full()
      .flex_wrap()
      .gap(8)
      .children(
        // A theme named like a layout (themes/win98.json) is that layout's own.
        themes()
          .filter((x) => Boolean(x.light) === light && (x.name === shared("layout") || !layouts().includes(x.name)))
          .map(({ name, colors: c }) => {
          const on = name === current;
          const dot = (color) => div().w(8).h(8).rounded(4).bg(color);
          return v_flex()
            .id(`st-t-${name}`)
            .w(124)
            .gap(6)
            .p(6)
            .rounded(10)
            .border_2()
            .border_color(on ? t.accent : "#00000000")
            .cursor_pointer()
            .hover((s) => s.bg(t.raised))
            .on_click((_e, cx) => {
              run("app.theme", { name });
              cx.notify();
            })
            .child(
              v_flex()
                .h(46)
                .w_full()
                .p(7)
                .gap(6)
                .rounded(6)
                .border_1()
                .border_color(t.border)
                .bg(c.background)
                .child(div().h(4).w(44).rounded(2).bg(c.terminal_foreground))
                .child(h_flex().gap(4).child(dot(c.accent)).child(dot(c.ansi1)).child(dot(c.ansi2)).child(dot(c.ansi3)).child(dot(c.ansi5))),
            )
            .child(
              h_flex()
                .gap(5)
                .items_center()
                .child(div().text_size(12.5).text_color(on ? t.foreground : t.muted).child(name.replace(/-/g, " ")))
                .when(on, (el) => el.child(svg(I("check")).size(12).text_color(t.accent))),
            );
        }),
      );
  }

  // The font in use, written in itself; a click opens the list.
  fontButton(t, which, family) {
    const open = this.picking === which;
    return div()
      .id(`st-f-${which}`)
      .w(220)
      .px(12)
      .py(6)
      .rounded(7)
      .border_1()
      .border_color(open ? t.accent : t.border)
      .bg(t.raised)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.picking = open ? null : which;
        this.filter = "";
        this.fontInput.set_value("");
        if (this.picking) this.fontInput.focus();
        else this.handle.focus();
        cx.notify();
      })
      .child(div().font_family(family).text_size(13.5).text_color(t.foreground).child(family));
  }

  fontList(t, which, def) {
    const q = this.filter.toLowerCase();
    const matches = fonts().filter((f) => f.toLowerCase().includes(q)).slice(0, 200);
    const choose = (name, cx) => {
      this.change((p) => {
        if (name === null) delete p[which];
        else p[which] = name;
      }, cx);
      this.picking = null;
      this.handle.focus();
      cx.notify();
    };
    const item = (id, label, family, onClick) =>
      div()
        .id(id)
        .px(10)
        .py(5)
        .rounded(6)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(onClick)
        .child(div().font_family(family).text_size(13.5).text_color(t.foreground).child(label));
    return v_flex()
      .w_full()
      .mb(8)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      // Let the child's native scroll run before stopping the page's wheel event.
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .child(
        div()
          .px(12)
          .py(8)
          .border_b(1)
          .border_color(t.border)
          .text_size(13)
          .child(Input.new(this.fontInput).h(28).text_color(t.foreground)),
      )
      .child(
        div()
          .id(`st-fl-${which}`)
          .h(200)
          .p(4)
          .overflow_y_scrollbar()
          .when(!q, (el) => el.child(item(`st-fd-${which}`, `Default (${def})`, def, (_e, cx) => choose(null, cx))))
          .children(matches.map((f, i) => item(`st-fi-${which}-${i}`, f, f, (_e, cx) => choose(f, cx)))),
      );
  }

  look(t, cx) {
    const s = settings();
    const p = this.person;
    const own = (key, composed, def) => (p[key] ?? def) !== composed;
    const size = (key, value, d, cx) => this.change((q) => (q[key] = Math.max(8, Math.min(32, (q[key] ?? value) + d))), cx);
    const fontRow = (which, sizeKey, title, family, def, sizeNow) =>
      v_flex()
        .w_full()
        .child(
          this.row(
            t,
            title,
            own(which, family, def) ? "This layout sets its own; yours shows in the others." : null,
            h_flex()
              .gap(8)
              .items_center()
              .child(this.fontButton(t, which, family))
              // The panels' text follows zoom: they size their rows to it.
              .when(Boolean(sizeKey), (el) => el.child(this.stepper(t, `st-${sizeKey}`, `${Math.round(sizeNow)}`, (_e, cx) => size(sizeKey, sizeNow, -1, cx), (_e, cx) => size(sizeKey, sizeNow, 1, cx)))),
          ),
        )
        .when(this.picking === which, (el) => el.child(this.fontList(t, which, def)));
    return v_flex()
      .w_full()
      .child(this.heading(t, "Layout"))
      .child(this.layoutPicker(t, cx))
      .child(div().h(18))
      .child(this.heading(t, "Theme"))
      .child(this.row(t, "Appearance", "Light or dark, or as your system is now.", this.appearancePicker(t, cx)))
      .child(div().pt(12).pb(8).text_size(12.5).text_color(t.dim).child("For the layout you're in: each layout keeps its own light and dark theme."))
      .child(div().pb(6).text_size(12.5).font_medium().text_color(t.muted).child("Dark"))
      .child(this.themePicker(t, false))
      .child(div().pt(10).pb(6).text_size(12.5).font_medium().text_color(t.muted).child("Light"))
      .child(this.themePicker(t, true))
      .child(div().h(18))
      .child(this.heading(t, "Size and fonts"))
      .child(
        this.row(
          t,
          "Zoom",
          "Everything: terminals, panels, text.",
          h_flex()
            .gap(8)
            .items_center()
            .child(this.stepper(t, "st-zoom", `${Math.round(s.zoom * 100)}%`, () => run("app.zoom_out"), () => run("app.zoom_in")))
            .child(this.button(t, "st-zoom-reset", "Reset", () => run("app.zoom_reset"))),
        ),
      )
      .child(fontRow("font", "font_size", "Terminal font", s.font_family, DEFAULT_FONT, s.font_size))
      .child(fontRow("ui_font", null, "Interface font", s.ui_font_family, DEFAULT_UI_FONT));
  }

  keyboard(t) {
    const choices = [
      ["auto", "Automatic (Alt on US keyboards)"],
      ["on", "Alt"],
      ["off", "Types characters"],
      ["left", "Left Option is Alt"],
      ["right", "Right Option is Alt"],
    ];
    return v_flex()
      .w_full()
      .child(this.heading(t, "Option key"))
      .child(div().pb(12).text_size(13).text_color(t.dim).child("Use Option for terminal shortcuts or to type accents and special characters."))
      .children(choices.map(([value, label]) => {
        const on = (this.person.option_as_alt ?? "auto") === value;
        return h_flex()
          .id(`st-option-${value}`)
          .gap(10)
          .px(12)
          .py(10)
          .rounded(7)
          .items_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.change((p) => { p.option_as_alt = value; }, cx))
          .child(div().text_color(on ? t.accent : t.muted).child(on ? "◉" : "○"))
          .child(div().text_size(14).text_color(t.foreground).child(label));
      }));
  }

  // Machines -------------------------------------------------------------

  async loadMachines() {
    if (this.machineLoading) return;
    this.machineLoading = true;
    try {
      const r = await hc(["machine", "ls", "--json"]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout || "Couldn't read machines.");
      const list = JSON.parse(r.stdout).machines;
      if (!Array.isArray(list)) throw new Error("Couldn't read machines.");
      this.machineList = list.filter((m) => !m.temporary);
      this.machineError = null;
    } catch (e) {
      this.machineError = String(e);
    } finally {
      this.machineLoading = false;
    }
  }

  machineAction(machine, action, cx, name) {
    if (this.machineBusy[machine]) return;
    if (action === "rename" && (!name?.trim() || name.trim() === machine)) return;
    this.machineBusy[machine] = action;
    delete this.machineResults[machine];
    this.machineEdit = null;
    this.handle.focus();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const args = ["machine", action, machine];
        if (action === "rename") args.push(name.trim());
        const r = await hc(args);
        let payload = null;
        try { payload = JSON.parse(r.stdout || r.stderr); } catch {}
        if (r.code !== 0) throw new Error(payload?.error?.message || (r.stderr || r.stdout || "It didn't work.").trim());
        const message = action === "update"
          ? `Updated ${machine}${payload?.version ? ` to hc ${payload.version}` : ""}; its terminals kept running.`
          : action === "rename" ? `Renamed ${machine} to ${name.trim()}.` : `Removed ${machine}; its terminals keep running there.`;
        if (action === "update") this.machineResults[machine] = { message, ok: true };
        else this.machineNotice = message;
      } catch (e) {
        this.machineResults[machine] = { message: String(e), ok: false };
      } finally {
        delete this.machineBusy[machine];
      }
      await this.loadMachines();
      cx.notify();
    });
  }

  olderCore(remote, local) {
    const parse = (v) => /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(v ?? "");
    const a = parse(remote), b = parse(local);
    if (!a || !b) return false;
    for (let i = 1; i <= 3; i++) {
      if (+a[i] !== +b[i]) return +a[i] < +b[i];
    }
    if (!a[4] || !b[4]) return Boolean(a[4] && !b[4]);
    const x = a[4].split("."), y = b[4].split(".");
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      if (x[i] === undefined || y[i] === undefined) return x[i] === undefined;
      const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
      return xn && yn ? +x[i] < +y[i] : xn !== yn ? xn : x[i] < y[i];
    }
    return false;
  }

  machineRow(t, m, localVersion) {
    const busy = this.machineBusy[m.name];
    const edit = this.machineEdit?.machine === m.name ? this.machineEdit : null;
    const state = String(m.state ?? "unknown").replace(/[_-]/g, " ");
    const color = ["connected", "online"].includes(m.state) ? t.ansi2 : ["connecting", "reconnecting"].includes(m.state) ? t.working : t.blocked;
    const result = this.machineResults[m.name];
    const controls = h_flex().gap(6).items_center();
    if (busy) controls.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child(div().text_size(12).text_color(t.muted).child(busy === "update" ? "Updating…" : busy === "rename" ? "Renaming…" : "Removing…"));
    else {
      if (this.olderCore(m.version, localVersion)) controls.child(this.button(t, `st-m-update-${m.name}`, "Update", (_e, cx) => this.machineAction(m.name, "update", cx)));
      for (const [action, label] of [["rename", "Rename"], ["rm", "Remove"]]) {
        controls.child(this.button(t, `st-m-${action}-${m.name}`, label, (_e, cx) => {
          this.machineEdit = { machine: m.name, action, name: m.name };
          if (action === "rename") {
            this.renameInput.set_value(m.name);
            this.renameInput.set_selected_range({ start: 0, end: encodeURIComponent(m.name).replace(/%[0-9A-F]{2}/g, "_").length });
            this.renameFocused = true;
            this.renameInput.focus();
          }
          cx.notify();
        }));
      }
    }
    const row = v_flex().w_full().py(12).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(div().w(7).h(7).flex_none().rounded(4).bg(color))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(14).text_color(t.foreground).child(m.name))
          .child(div().text_size(12.5).text_color(t.dim).child(`${m.target ?? ""} · ${state} · ${m.version ? `hc ${m.version}` : "hc version unknown"}`)))
        .child(controls.flex_none()));
    if (busy === "update") row.child(div().text_size(12.5).text_color(t.dim).child("Copying this computer's herdr-core. Its terminals keep running."));
    if (edit && !busy) {
      const cancel = this.button(t, `st-m-cancel-${m.name}`, "Cancel", (_e, cx) => { this.machineEdit = null; this.handle.focus(); cx.notify(); });
      if (edit.action === "rm") row.child(v_flex().gap(8)
        .child(div().text_size(12.5).text_color(t.muted).child(`Remove ${m.name}? Its terminals keep running there.`))
        .child(h_flex().gap(6).child(cancel).child(this.button(t, `st-m-confirm-${m.name}`, "Remove machine", (_e, cx) => this.machineAction(m.name, "rm", cx)))));
      else row.child(v_flex().gap(6)
        .child(div().text_size(12).text_color(t.dim).child("New name (addresses using the old name stop working)"))
        .child(h_flex().gap(6).items_center()
          .child(Input.new(this.renameInput).flex_1().min_w(0).h(32).px(10).rounded(7).border_1().border_color(this.renameFocused ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground))
          .child(cancel).child(this.button(t, `st-m-save-${m.name}`, "Save", (_e, cx) => this.machineAction(m.name, "rename", cx, edit.name)))));
    }
    if (result) row.child(div().text_size(12.5).text_color(result.ok ? t.ansi2 : t.blocked).child(result.message));
    return row;
  }

  machines(t) {
    const version = updates().core.version;
    return v_flex().w_full()
      .child(this.heading(t, "Machines"))
      .child(div().pb(8).text_size(12.5).line_height("18px").text_color(t.dim).child("Your computers, reached over ssh. Their terminals keep running when you disconnect."))
      .child(this.row(t, "This computer", `Connected · ${version ? `hc ${version}` : "hc version unknown"}`, div().w(7).h(7).rounded(4).bg(t.ansi2)))
      .children((this.machineList ?? []).map((m) => this.machineRow(t, m, version)))
      .when(this.machineList === null && !this.machineError, (el) => el.child(h_flex().py(14).gap(8).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child(div().text_size(12.5).text_color(t.dim).child("Reading machines…"))))
      .when(this.machineList?.length === 0, (el) => el.child(div().py(14).text_size(12.5).text_color(t.dim).child("No other machines yet.")))
      .when(Boolean(this.machineError), (el) => el.child(div().py(10).text_size(12.5).text_color(t.blocked).child(this.machineError)))
      .when(Boolean(this.machineNotice), (el) => el.child(div().py(10).text_size(12.5).text_color(t.ansi2).child(this.machineNotice)))
      .child(h_flex().pt(16).child(this.button(t, "st-m-add", "Add a machine", () => run("mod.open", { name: "machine-add" }))));
  }

  // Alerts ---------------------------------------------------------------

  alerts(t) {
    const sounds = this.person.sounds ?? {};
    const on = sounds.enabled !== false;
    const file = (f) => (f ? f.split(/[\\/]/).pop() : "Herdr's sound");
    return v_flex()
      .w_full()
      .child(this.heading(t, "Sounds"))
      .child(
        this.row(
          t,
          "Play sounds",
          "When an agent needs you, and when one finishes while you're not looking. A note shows in the corner either way.",
          this.toggle(t, "st-sounds", on, (_e, cx) => this.change((p) => (p.sounds = { ...(p.sounds ?? {}), enabled: !on }), cx)),
        ),
      )
      .child(this.row(t, "An agent needs you", file(sounds.blocked), this.button(t, "st-play-blocked", "Play", () => playSound("blocked"))))
      .child(this.row(t, "An agent finished", file(sounds.done), this.button(t, "st-play-done", "Play", () => playSound("done"))))
      .child(div().pt(12).text_size(12.5).line_height("18px").text_color(t.dim).child("Want your own sounds? Ask your agent to set sounds.done and sounds.blocked in settings.json to an MP3."));
  }

  // Updates --------------------------------------------------------------

  updates(t) {
    const u = updates();
    const at = (secs) => {
      const d = new Date(secs * 1000);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const checked = u.checked ? ` Checked at ${at(u.checked)}.` : "";
    const result = u.checking ? "Checking\u2026" : u.checked
      ? `Up to date.${checked}`
      : "No successful check. Check your connection and try again.";
    // Pressed: "Checking\u2026" while it looks, then "Up to date" for a moment
    // (a find changes the row instead). One per row: an element shows once.
    const asked = this.asked && Date.now() - this.asked < 3000;
    const check = (id) =>
      !u.checks
        ? null
        : u.checking && this.asked
          ? div().px(12).py(5).text_size(13).text_color(t.dim).child("Checking\u2026")
          : asked && u.checked && !u.checking
            ? div().px(12).py(5).text_size(13).text_color(t.ansi2).child("\u2713 Up to date")
            : this.button(t, id, "Check now", (_e, cx) => {
                this.asked = Date.now();
                run("app.check_updates");
                cx.notify();
              });
    const primary = (id, label, f) =>
      div().id(id).px(12).py(5).rounded(7).cursor_pointer().bg(t.accent).text_color(t.accent_foreground).text_size(13).font_semibold().hover((s) => s.opacity(0.9)).on_click(f).child(label);
    const app = !u.app.updates
      ? ["A build from source: it updates with git, not here.", null]
      : u.app.ready
        ? [`${u.app.ready} is ready. Restart to switch now; it also switches when you quit.`, primary("st-app-update", "Restart to update", () => run("app.update"))]
        : [result, check("st-check-app")];
    const c = u.core;
    const core = c.managed
      ? [`Managed by ${c.managed}: update it there.`, null]
      : c.updating
        ? ["Updating\u2026 your terminals keep running.", null]
        : c.error
          ? [`The update failed: ${c.error}`, primary("st-core-retry", "Try again", () => run("app.update_core"))]
          : c.ready
            ? [`${c.ready} is ready. Your terminals keep running through it.`, primary("st-core-update", "Update herdr-core", () => run("app.update_core"))]
            : u.checks
              ? [result, check("st-check-core")]
              : ["Not checked: a build from source looks for no updates.", null];
    return v_flex()
      .w_full()
      .child(this.heading(t, "Herdr"))
      .child(this.row(t, `Herdr ${u.app.version}`, app[0], h_flex().gap(8).flex_none()
        .child(this.button(t, "st-whats-new", "What's new", () => { closeOverlay(props()?.overlay); run("app.whats_new"); }))
        .when(Boolean(app[1]), (el) => el.child(app[1]))))
      .child(div().h(18))
      .child(this.heading(t, "herdr-core"))
      .child(this.row(t, `herdr-core ${c.version ?? ""}`, core[0], core[1] ?? div()))
      .child(div().pt(12).text_size(12.5).line_height("18px").text_color(t.dim).child("Herdr looks for both every hour and tells you in the corner. herdr-core runs your terminals, so they keep running through its updates."));
  }


  // Privacy --------------------------------------------------------------

  // A report as it goes out, one line per line of JSON.
  report(t, id, title, about, report) {
    const lines = JSON.stringify(report, null, 2).split("\n");
    return v_flex()
      .w_full()
      .pt(14)
      .gap(4)
      .child(div().text_size(13.5).text_color(t.foreground).child(title))
      .when(Boolean(about), (el) => el.child(div().text_size(12.5).text_color(t.dim).child(about)))
      .child(
        v_flex()
          .id(id)
          .mt(4)
          .w_full()
          .p(10)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .children(lines.map((l) => div().font_family(DEFAULT_FONT).text_size(12).line_height("17px").text_color(t.muted).whitespace_nowrap().child(l || " "))),
      );
  }

  privacy(t) {
    const s = telemetry();
    const on = s ? s.setting : this.person.telemetry !== false;
    const at = (secs) => new Date(secs * 1000).toLocaleString();
    const why = s?.off_because ? `Off for now: ${s.off_because} is set where Herdr started.` : null;
    const body = v_flex()
      .w_full()
      .child(this.heading(t, "Usage data"))
      .child(
        this.row(
          t,
          "Share anonymous usage data",
          why ?? "Once a day: which agents and features you use, how many spaces and tabs, your system and Herdr's version. Never what's in your terminals, never names of files, folders or projects.",
          this.toggle(t, "st-telemetry", on, (_e, cx) =>
            this.change((p) => {
              if (on) p.telemetry = false;
              else delete p.telemetry;
            }, cx),
          ),
        ),
      )
      .child(
        this.row(
          t,
          "What we send",
          s && !s.sends ? "This build never sends: it's built from source. You can still see what a release would send." : "Exactly what leaves your computer, word for word.",
          this.button(t, "st-telemetry-show", this.showData ? "Hide" : "Show", (_e, cx) => {
            this.showData = !this.showData;
            cx.notify();
          }),
        ),
      );
    if (!this.showData) return body;
    if (!s?.enabled) return body.child(div().pt(14).text_size(13).text_color(t.dim).child("Nothing is collected or sent while it's off."));
    return body
      .children(s.queued.map((r, i) => this.report(t, `st-tq-${i}`, `Waiting to send: ${r.day}`, "Sent as is, soon.", r)))
      .when(Boolean(s.draft), (el) => el.child(this.report(t, "st-td", "Today so far", "A draft: it changes until the day ends (UTC), then goes out once.", s.draft)))
      .when(Boolean(s.last_sent), (el) => el.child(this.report(t, "st-tl", `Last sent: ${s.last_sent.report.day}`, `Sent ${at(s.last_sent.at)}.`, s.last_sent.report)));
  }

  // ----------------------------------------------------------------------

  // orcha: Projects ------------------------------------------------------

  // The project these rules and skills are for: the one picked, else the
  // shown space.
  projectSpace() {
    const list = spaces();
    return list.find((s) => s.id === this.orcha.project) ?? list.find((s) => s.active) ?? list[0] ?? null;
  }

  // CLAUDE.md, unless the project keeps its rules in AGENTS.md (CLAUDE.md
  // missing, or only pointing there): orcha_rules.rs instruction_file.
  async instructionFile(folder) {
    const claude = `${folder}/CLAUDE.md`;
    const agents = `${folder}/AGENTS.md`;
    const agentsText = await readTextFile(agents);
    if (agentsText != null) {
      const claudeText = await readTextFile(claude);
      if (claudeText == null || claudeText.includes("AGENTS.md")) return { path: agents, text: agentsText };
    }
    return { path: claude, text: (await readTextFile(claude)) ?? "" };
  }

  loadProject(cx) {
    const space = this.projectSpace();
    if (!space?.folder || this.orcha.loading === space.id) return;
    this.orcha.loading = space.id;
    cx.spawn(async (cx) => {
      const folder = space.folder;
      const file = await this.instructionFile(folder);
      const installed = {};
      for (const skill of SKILLS) {
        const first = skill.skills[0];
        installed[skill.name] = {
          project: (await readTextFile(`${folder}/.claude/skills/${first}/SKILL.md`)) != null,
          global: (await readTextFile(`${home()}/.claude/skills/${first}/SKILL.md`)) != null,
        };
      }
      this.orcha.info = { space: space.id, folder, file, rules: rulesIn(file.text), installed };
      this.orcha.loading = null;
      cx.notify();
    });
  }

  // Sets the managed block to `ids`, only if the file did not change since read.
  setRules(ids, cx) {
    const info = this.orcha.info;
    if (!info) return;
    cx.spawn(async (cx) => {
      const raw = await readTextFile(info.file.path);
      const before = raw ?? "";
      const after = withRules(before, ids);
      try {
        if (after !== before) await writeTextFile(info.file.path, after, raw);
        info.file.text = after;
        info.rules = rulesIn(after);
      } catch (err) {
        notify({ title: "The rules were not written", body: String(err), level: "error" });
      }
      cx.notify();
    });
  }

  // `npx skills add` in the project, or for the user (-g): orcha_rules.rs install_skill.
  // Without Node (or when npx fails) the skill folders come straight from GitHub.
  installSkill(skill, global, cx) {
    const info = this.orcha.info;
    if (!info || this.orcha.busy[skill.name]) return;
    this.orcha.busy[skill.name] = global ? "for you" : "here";
    cx.notify();
    cx.spawn(async (cx) => {
      const args = skillArgs(skill, global);
      // An app opened from the Dock has no shell PATH, and nvm, fnm and the
      // like set it up in .zshrc, which only an interactive shell reads.
      // Its input is /dev/null, so nothing in .zshrc can wait on a question.
      let r = await exec("/bin/sh", ["-c", `exec /bin/zsh -lic 'exec npx "$@"' npx "$@" </dev/null`, "sh", ...args], { cwd: info.folder });
      if (r.code !== 0) {
        const dest = global ? `${home()}/.claude/skills` : `${info.folder}/.claude/skills`;
        r = await exec("/bin/zsh", ["-c", FROM_GITHUB, "zsh", skill.source, dest, ...skill.skills], { cwd: info.folder });
      }
      delete this.orcha.busy[skill.name];
      if (r.code === 0) {
        delete this.orcha.failed[`${global ? "" : info.folder}|${skill.name}`];
        notify({ title: `${skill.title} installed`, level: "success", timeout: 4000 });
      } else {
        // The row then offers the command, to run by hand in a terminal.
        const cd = global ? "" : `cd '${info.folder.replaceAll("'", "'\\''")}' && `;
        this.orcha.failed[`${global ? "" : info.folder}|${skill.name}`] = `${cd}npx ${skillArgs(skill, global).join(" ")}`;
        notify({ title: `${skill.title} was not installed`, body: (r.stderr || r.stdout || "no internet?").trim().split("\n").pop(), level: "error" });
      }
      this.loadProject(cx);
    });
  }

  // Projects as vertical tabs beside the page: their own scroll, so the list
  // stays put while the rules scroll.
  projectTabs(t, cx) {
    const space = this.projectSpace();
    const k = tokens();
    return v_flex()
      .id("op-tabs")
      .w(200)
      .flex_none()
      .h_full()
      .gap(4)
      .px(10)
      .py(22)
      .overflow_y_scroll()
      .border_r(1)
      .border_color(t.border)
      .child(div().px(4).child(this.heading(t, "Project")))
      .children(
        spaces().map((s) => {
          const on = s.id === space?.id;
          return h_flex()
            .id(`op-${s.id}`)
            .w_full()
            .h(34)
            .px(6)
            .gap(8)
            .items_center()
            .rounded(7)
            .border_2()
            .border_color(on ? k.line : "#00000000")
            .bg(on ? k.yellow : "#00000000")
            .cursor_pointer()
            .text_size(12.5)
            .font_black()
            .text_color(on ? k.chipText : k.muted)
            .hover((st) => (on ? st : st.bg(k.hover)))
            .on_click((_e, cx) => {
              this.orcha.project = s.id;
              this.orcha.info = null;
              this.orcha.loading = null;
              this.loadProject(cx);
              cx.notify();
            })
            .child(projectTile(k, s.name, this.orcha.icons[s.folder], 20))
            .child(div().flex_1().min_w(0).truncate().child(s.name));
        }),
      );
  }

  projects(t, cx) {
    const space = this.projectSpace();
    const info = this.orcha.info;
    if (space && info?.space !== space.id) this.loadProject(cx);
    const out = v_flex().w_full();
    if (!space) return out.child(div().text_color(t.dim).child("Open a project first."));
    out.child(div().text_size(16).font_semibold().text_color(t.foreground).child(space.name));
    if (!info) return out.child(div().pt(12).text_color(t.dim).child("Reading the project…"));
    const fileName = info.file.path.split("/").pop();
    out.child(div().pt(4).pb(4).text_size(12.5).text_color(t.dim).child(`Rules go in ${fileName}, as one block orcha keeps; what your team wrote around it stays as it is.`));
    out.child(div().pt(12)).child(this.heading(t, "Working rules"));
    for (const rule of RULES) {
      const on = info.rules.includes(rule.id);
      out.child(
        this.row(t, rule.title, rule.summary, this.toggle(t, `rule-${rule.id}`, on, (_e, cx) => {
          const ids = RULES.map((r) => r.id).filter((id) => (id === rule.id ? !on : info.rules.includes(id)));
          this.setRules(ids, cx);
        })),
      );
    }
    let group = null;
    for (const skill of SKILLS) {
      if (skill.group !== group) {
        group = skill.group;
        out.child(div().pt(18)).child(this.heading(t, `Skills · ${group}`));
      }
      const where = info.installed[skill.name] ?? {};
      const busy = this.orcha.busy[skill.name];
      const failed = this.orcha.failed[`${info.folder}|${skill.name}`] ?? this.orcha.failed[`|${skill.name}`];
      const control = busy
        ? div().text_size(12.5).text_color(t.dim).child(`installing ${busy}…`)
        : where.project
          ? div().text_size(12.5).text_color(t.done).child("✓ in this project")
          : where.global
            ? div().text_size(12.5).text_color(t.done).child("✓ for you")
            : h_flex()
                .gap(6)
                .when(Boolean(failed), (el) =>
                  el.child(this.button(t, `sk-c-${skill.name}`, "Copy command", (_e, cx) => {
                    cx.write_to_clipboard(failed);
                    notify({ title: "Install command copied", body: "Paste it in Terminal and press Return. It needs Node.js (nodejs.org).", level: "info", timeout: 6000 });
                  })),
                )
                .child(this.button(t, `sk-p-${skill.name}`, "Add here", (_e, cx) => this.installSkill(skill, false, cx)))
                .child(this.button(t, `sk-g-${skill.name}`, "For me", (_e, cx) => this.installSkill(skill, true, cx)));
      const about = failed ? `Not installed. Copy the command and run it in Terminal, or try again. · ${skill.source}` : `${skill.summary} · ${skill.source}`;
      out.child(this.row(t, skill.title, about, control));
    }
    return out;
  }

  // orcha: the whale itself ---------------------------------------------
  // Which orcha this is, and the newer one when GitHub has it (version.js).
  // Written like the README: loud on purpose.

  whale(t, cx) {
    const k = tokens();
    const u = updateInfo();
    const next = available();
    const updating = shared("orcha.updating");
    const open = (url) => exec("open", [url]);
    const at = (ms) => new Date(ms).toTimeString().slice(0, 5);
    const big = (id, label, onClick) =>
      raised(
        k,
        div()
          .id(id)
          .px(14)
          .h(32)
          .flex()
          .items_center()
          .rounded(6)
          .border(2)
          .border_color(k.line)
          .bg(k.yellow)
          .cursor_pointer()
          .text_size(13)
          .font_black()
          .text_color(k.chipText)
          .hover((s) => s.opacity(0.9))
          .on_click(onClick)
          .child(label),
        3,
        6,
      );
    const hero = raised(
      k,
      v_flex()
        .gap(6)
        .p(18)
        .rounded(9)
        .border(2.5)
        .border_color(k.line)
        .bg(k.card)
        .child(h_flex().gap(10).items_center().child(chip(k, "🐐🐋 ORCHERD", k.pink).h(24).px(9).text_size(12.5).border(2).border_color(k.line)).child(div().text_size(22).font_black().text_color(k.ink).child(`Orcherd ${VERSION}`)))
        .child(div().pt(4).text_size(14).font_bold().text_color(k.ink).child("Herdr's window 🪟 + orcha's brain 🧠 = ORCHERD."))
        .child(div().text_size(12.5).text_color(k.muted).child("A plugin. Not a fork. Absolutely not normal.")),
      4,
      9,
    );
    let status;
    if (updating || this.orcha.busy.update) {
      status = v_flex()
        .gap(4)
        .child(div().text_size(15).font_black().text_color(k.ink).child("Releasing the whale… 🐋💨"))
        .child(div().text_size(12.5).text_color(k.muted).child(`Hauling ${updating?.to ?? next?.latest ?? "it"} out of GitHub. Herdr reloads when it lands. Don't panic, the goat is holding the door.`));
    } else if (next) {
      status = v_flex()
        .gap(10)
        .child(div().text_size(15).font_black().text_color(k.ink).child(`🌊 A bigger whale just surfaced: ${next.latest}`))
        .child(div().text_size(12.5).text_color(k.muted).child(`You're on ${VERSION}, which is basically a fossil now. One click, no Terminal, no tears.`))
        .child(
          h_flex()
            .gap(10)
            .items_center()
            .child(big("whale-update", "Release the whale 🐋", (_e, cx) => this.updateWhale(next.latest, cx)))
            .child(this.button(t, "whale-notes", "What's new 📜", () => open(next.url ?? `https://github.com/${REPO}/releases`))),
        )
        .when(Boolean(next.notes), (el) =>
          el.child(
            div()
              .mt(4)
              .p(14)
              .rounded(8)
              .border(2)
              .border_color(k.line)
              .bg(k.paper)
              .text_size(12.5)
              .text_color(k.ink)
              .child(TextView.markdown("whale-notes-md", next.notes).selectable(true).on_link_click((url) => open(url))),
          ),
        );
    } else if (u.error) {
      status = v_flex()
        .gap(8)
        .child(div().text_size(15).font_black().text_color(k.ink).child("🛜 The ocean is offline."))
        .child(div().text_size(12.5).text_color(k.muted).child(`GitHub didn't pick up (${u.error}). Check your Wi-Fi, then poke it again.`))
        .child(h_flex().child(this.button(t, "whale-check", "Poke GitHub again 🔭", () => checkUpdate(true))));
    } else if (u.checking || !u.checked) {
      status = div().text_size(15).font_black().text_color(k.ink).child("Scanning the ocean for bigger whales… 🔭");
    } else {
      status = v_flex()
        .gap(8)
        .child(div().text_size(15).font_black().text_color(k.ink).child("✨ Freshest whale in the ocean."))
        .child(div().text_size(12.5).text_color(k.muted).child(`Nothing to update. GitHub was asked at ${at(u.checked)} and it shrugged.`))
        .child(h_flex().child(this.button(t, "whale-check", "Check again anyway 🔭", () => checkUpdate(true))));
    }
    return v_flex()
      .w_full()
      .gap(18)
      .child(hero)
      .child(v_flex().gap(6).child(this.heading(t, "Updates")).child(status))
      .child(
        v_flex()
          .gap(8)
          .child(this.heading(t, "Links"))
          .child(
            h_flex()
              .gap(8)
              .child(this.button(t, "whale-gh", "GitHub 🐙", () => open(`https://github.com/${REPO}`)))
              .child(this.button(t, "whale-rel", "All releases 📦", () => open(`https://github.com/${REPO}/releases`)))
              .child(this.button(t, "whale-boring", "Nerd stuff 🥱", () => open(`https://github.com/${REPO}/blob/main/docs/BORING.md`))),
          ),
      )
      .child(div().text_size(11.5).text_color(t.dim).child("New releases show up as a pink pill in the header. The goat is Herdr's, the whale is ours 🍵"));
  }

  updateWhale(version, cx) {
    if (this.orcha.busy.update) return;
    this.orcha.busy.update = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const failed = await runUpdate(version);
      delete this.orcha.busy.update;
      if (failed) notify({ title: "The whale got stuck 🐋🪤", body: failed, level: "error" });
      cx.notify();
    });
  }

  // orcha: Accounts ------------------------------------------------------

  loadAccounts(cx) {
    cx.spawn(async (cx) => {
      // ✓ default: the default account, even while the main folder borrows another.
      // mainOn: the account in the main folder now, another one while its chats borrow.
      const { list, main, active } = await readAccounts();
      this.orcha.accounts = list;
      this.orcha.active = main;
      this.orcha.mainOn = active;
      this.orcha.station = await stationStatus();
      cx.notify();
    });
  }

  useAccount(a, cx) {
    if (this.orcha.busy[a.id]) return;
    this.orcha.busy[a.id] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const back = this.orcha.active === a.id; // the default already: its chats return from a borrow
      const failed = await makeDefault(a.id);
      delete this.orcha.busy[a.id];
      if (!failed) {
        this.orcha.active = a.id;
        this.orcha.mainOn = a.id;
        setShared("orcha.fuelRev", Date.now());
        notify({ title: back ? `Back on ${a.label ?? a.id}` : `${a.label ?? a.id} is the default now`, body: "New chats start on it, and the chats in the main folder (~/.claude) move to it within half a minute. A chat started in another account's folder stays there.", level: "success", timeout: 6000 });
      } else notify({ title: "The default was not changed", body: failed, level: "error" });
      cx.notify();
    });
  }

  accounts(t, cx) {
    if (!this.orcha.accounts) this.loadAccounts(cx);
    const k = tokens();
    const hubTab = this.orcha.accountTab === "hub";
    const out = v_flex()
      .w_full()
      .child(this.heading(t, "Accounts"))
      .child(h_flex().gap(8).py(8)
        .child(this.button(t, "accounts-local", hubTab ? "Local" : "Local ✓", (_e, cx) => { this.orcha.accountTab = "local"; cx.notify(); }))
        .child(this.button(t, "accounts-hub", hubTab ? "Hub ✓" : "Hub", (_e, cx) => { this.orcha.accountTab = "hub"; cx.notify(); })))
      .child(div().pb(6).text_size(12.5).text_color(t.dim).child(hubTab
        ? "Hub accounts run through Token Station. Start day on the hub before opening a chat."
        : "Local accounts use this Mac's sign-ins. New Claude chats start on the default. To move the chat in front of you, open ACCOUNTS: click FUEL, or 👤 in the header."));
    if (hubTab) out.child(this.stationSection(t));
    for (const a of (this.orcha.accounts ?? []).filter((a) => isStation(a) === hubTab)) {
      const inUse = a.kind === "claude" && a.id === this.orcha.active;
      // The default's chats were kept running on another account: the main folder holds that one now.
      const lent = inUse && this.orcha.mainOn && this.orcha.mainOn !== a.id ? (this.orcha.accounts ?? []).find((x) => x.id === this.orcha.mainOn) ?? null : null;
      const gauges = [fuelGauge(k, "5H", a.limits.session), fuelGauge(k, "WEEK", a.limits.weekly), fuelGauge(k, "MONTH", a.limits.monthly)].filter(Boolean);
      const token = tokenState(a);
      const control =
        isStation(a)
          ? div().text_size(12.5).text_color(a.why ? t.blocked : t.dim).child(a.why ?? "from the hub")
          : needsSignIn(a, gauges)
          ? this.button(t, `acc-sign-${a.id}`, "Sign in", () => { closeOverlay(props()?.overlay); signIn(a.id); })
          : a.kind !== "claude"
          ? div()
          : this.orcha.busy[a.id]
            ? div().text_size(12.5).text_color(t.dim).child("changing…")
            : inUse
              ? h_flex().gap(10).items_center().child(div().text_size(12.5).text_color(t.done).child("✓ default")).when(Boolean(lent), (el) => el.child(this.button(t, `acc-return-${a.id}`, "Return", (_e, cx) => this.useAccount(a, cx))))
              : this.button(t, `acc-${a.id}`, "Make default", (_e, cx) => this.useAccount(a, cx));
      out.child(
        v_flex()
          .w_full()
          .gap(6)
          .py(12)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(12)
              .items_center()
              .child(v_flex().flex_1().min_w(0).child(div().text_size(14).text_color(t.foreground).child(a.label ?? a.id)).child(div().text_size(12.5).text_color(t.dim).child(a.email ?? a.limits.note ?? "")).when(Boolean(token), (el) => el.child(div().text_size(12).text_color(token.signIn ? t.blocked : t.dim).child(token.text))))
              .child(control),
          )
          .when(Boolean(lent), (el) => el.child(div().text_size(12).text_color(t.muted).child(`Its chats in the main folder (~/.claude) borrow ${lent.label ?? lent.id} now, and new chats start there too. Return puts them back on ${a.label ?? a.id}, no restart.`)))
          .children(gauges),
      );
    }
    const kind = ACCOUNT_KINDS.find((k) => k.kind === this.orcha.addKind) ?? ACCOUNT_KINDS[0];
    const claude = kind.kind === "claude";
    const added = !claude && (this.orcha.accounts ?? []).some((a) => a.kind === kind.kind);
    const addButton = this.orcha.busy.add
      ? div().text_size(12.5).text_color(t.dim).child("adding…")
      : this.button(t, "acc-add", "Add and sign in", (_e, cx) => this.addAccount(cx));
    if (!hubTab) out.child(
      v_flex()
        .w_full()
        .gap(6)
        .py(12)
        .border_b(1)
        .border_color(t.border)
        .child(
          h_flex()
            .gap(12)
            .items_center()
            .child(div().flex_1().text_size(14).text_color(t.foreground).child("Add an account"))
            .child(this.kindPicker(t)),
        )
        .child(
          div()
            .text_size(12.5)
            .text_color(t.dim)
            .child(
              claude
                ? "Give it a name. A sign-in opens beside your work; your chats, settings and skills are shared with the other accounts."
                : added
                  ? `${kind.label} is already here. It signs in where the ${kind.cli} CLI keeps it, so one ${kind.label} account per computer.`
                  : `A sign-in opens beside your work (${kind.cli} login). It needs the ${kind.cli} CLI installed.`,
            ),
        )
        .when(claude, (el) =>
          el.child(
            h_flex()
              .gap(8)
              .pt(4)
              .child(Input.new(this.accountInput).flex_1().min_w(0).h(32).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground))
              .child(addButton),
          ),
        )
        .when(!claude && !added, (el) => el.child(h_flex().pt(4).child(addButton))),
    );
    return out.child(
      h_flex()
        .pt(14)
        .gap(8)
        .child(this.button(t, "acc-refresh", "Refresh fuel", (_e, cx) =>
          cx.spawn(async (cx) => {
            await refreshFuel(true);
            setShared("orcha.fuelRev", Date.now());
            this.loadAccounts(cx);
          }),
        )),
    );
  }

  // orcha: Token Station ---------------------------------------------------
  // Your own hub of Claude accounts on the LAN (bin/tokenstation.py). Two
  // steps to pair: read the hub's cert and compare it with the hub's page,
  // then the 6-digit code. Nothing about it runs before that.

  stationSection(t) {
    const st = this.orcha.station;
    const busy = this.orcha.busy.station;
    const field = (input) => Input.new(input).flex_1().min_w(0).h(32).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground);
    const text = (s, color = t.dim) => div().text_size(12.5).text_color(color).child(s);
    const box = v_flex().w_full().gap(6).py(12).border_b(1).border_color(t.border)
      .child(div().text_size(14).text_color(t.foreground).child("Token Station"));
    if (!st) return box.child(text("…"));
    if (st.paired) {
      const state = st.error ?? (st.grant?.open ? `The hub's day is on${st.grant.ends_at ? ` until ${new Date(st.grant.ends_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}: hub accounts can start here.` : "The hub's day isn't started: hub accounts wait for Start day on the hub.");
      return box
        .child(text(`Paired with tokenstation@${st.hub_name} · ${st.url}`, t.foreground))
        .child(text(`Cert ${st.check}. HUB accounts run through the hub relay for each pane; local accounts keep their own connection.`))
        .child(text(state, st.error ? t.blocked : t.dim))
        .child(text("Use the hub's .local name or an IP covered by its cert. 0.0.0.0 is only its listening address."))
        .child(h_flex().gap(8).pt(4).child(field(this.stationAddressInput))
          .child(busy ? text(busy) : this.button(t, "station-address", "Change address", (_e, cx) => this.stationMove(cx))))
        .child(h_flex().gap(8).pt(4)
          .child(busy ? text(busy) : this.button(t, "station-sync", "Sync now", (_e, cx) => this.stationSync(cx)))
          .child(this.button(t, "station-forget", this.orcha.stationConfirm ? "Sure? Unpair" : "Unpair this Mac", (_e, cx) => this.stationUnpair(cx))));
    }
    const probe = this.orcha.stationProbe;
    box.child(text("Use the Claude accounts of your own Token Station hub on this Mac. On the hub's Machines page press Add machine, then:"));
    if (!probe) {
      return box.child(h_flex().gap(8).pt(4).child(field(this.stationUrlInput))
        .child(busy ? text(busy) : this.button(t, "station-check", "Check hub", (_e, cx) => this.stationCheck(cx))));
    }
    return box
      .child(text(`The hub at ${probe.url} shows cert ${probe.check}.`, t.foreground))
      .child(text("Pair only if the hub's Machines page shows the same. If it differs, stop: something is between this Mac and the hub.", t.blocked))
      .child(h_flex().gap(8).pt(4).child(field(this.stationCodeInput))
        .child(busy ? text(busy) : this.button(t, "station-pair", "Pair", (_e, cx) => this.stationPairGo(cx)))
        .child(this.button(t, "station-cancel", "Cancel", (_e, cx) => { this.orcha.stationProbe = null; cx.notify(); })));
  }

  stationRun(cx, label, work) {
    if (this.orcha.busy.station) return;
    this.orcha.busy.station = label;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await work();
      } catch (error) {
        notify({ title: "Token Station failed", body: String(error), level: "error", timeout: 8000 });
      } finally {
        delete this.orcha.busy.station;
        this.loadAccounts(cx);
        setShared("orcha.fuelRev", Date.now());
      }
    });
  }

  stationCheck(cx) {
    this.stationRun(cx, "checking…", async () => {
      const probe = await stationProbe(this.stationUrlInput.value());
      if (probe.error) notify({ title: "No hub there", body: probe.error, level: "error" });
      else {
        this.orcha.stationProbe = probe;
        this.stationCodeInput.focus();
      }
    });
  }

  stationPairGo(cx) {
    const probe = this.orcha.stationProbe;
    if (!probe) return;
    this.stationRun(cx, "pairing…", async () => {
      const failed = await stationPair(probe.url, this.stationCodeInput.value(), probe.pin);
      if (failed) notify({ title: "Not paired", body: failed, level: "error" });
      else {
        this.orcha.stationProbe = null;
        this.stationCodeInput.set_value("");
        notify({ title: "Paired with the hub ⚡", body: "Its accounts show in ACCOUNTS with HUB.", level: "success", timeout: 6000 });
      }
    });
  }

  stationSync(cx) {
    this.stationRun(cx, "syncing…", () => refreshFuel(true));
  }

  stationMove(cx) {
    this.stationRun(cx, "changing address…", async () => {
      const failed = await stationAddress(this.stationAddressInput.value());
      if (failed) notify({ title: "Address unchanged", body: failed, level: "error", timeout: 8000 });
      else {
        this.stationAddressInput.set_value("");
        notify({ title: "Hub address changed", body: "Restart any running hub panes so Claude Code uses the new address.", level: "success", timeout: 8000 });
      }
    });
  }

  stationUnpair(cx) {
    if (!this.orcha.stationConfirm) {
      this.orcha.stationConfirm = true;
      cx.notify();
      return;
    }
    this.orcha.stationConfirm = false;
    this.stationRun(cx, "unpairing…", async () => {
      const failed = await stationForget();
      if (failed) {
        notify({ title: "Unpair failed", body: failed, level: "error", timeout: 8000 });
        return;
      }
      notify({ title: "Unpaired", body: "Hub accounts are gone from this Mac; their chats stay in ~/.config/orcherd/station. Revoke this Mac on the hub too.", level: "success", timeout: 8000 });
    });
  }

  // Claude · Codex · Cursor: which agent the new account is for.
  kindPicker(t) {
    return this.segmented(t, "acc-kind", ACCOUNT_KINDS.map((k) => [k.kind, k.label]), this.orcha.addKind, (kind, cx) => {
      this.orcha.addKind = kind;
      cx.notify();
    });
  }

  addAccount(cx) {
    if (this.orcha.busy.add) return;
    this.orcha.busy.add = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const kind = this.orcha.addKind;
      const failed = await addAccount(kind === "claude" ? this.accountInput.value() : "", kind);
      delete this.orcha.busy.add;
      if (failed) notify({ title: "The account was not added", body: failed, level: "error" });
      else {
        if (kind === "claude") this.accountInput.set_value("");
        notify({ title: "Sign in beside your work", body: "When it says you're in, press Enter there.", level: "success", timeout: 6000 });
        closeOverlay(props()?.overlay);
      }
      this.loadAccounts(cx);
    });
  }

  // orcha: Hand-off ------------------------------------------------------
  // In Orcherd's config.toml [orcha].

  loadHandoff(cx) {
    cx.spawn(async (cx) => {
      this.orcha.handoff = await readHandoff();
      cx.notify();
    });
  }

  setHandoff(key, value, cx) {
    this.orcha.handoff = { ...(this.orcha.handoff ?? HANDOFF_DEFAULTS), [key]: value };
    cx.notify();
    cx.spawn(async (cx) => {
      const failed = await writeHandoff(key, value);
      if (failed) {
        notify({ title: "Not saved", body: failed, level: "error" });
        this.loadHandoff(cx);
      }
    });
  }

  // The three marks on one fuel bar: 100% left on the left, empty on the right.
  handoffBar(h) {
    const k = tokens();
    const marks = [
      { at: h.checklist_percent, color: k.blue, label: "checklist" },
      { at: h.low_fuel_percent, color: k.yellow, label: "offer" },
      { at: h.auto_handoff_percent, color: k.red, label: "auto" },
    ].filter((m) => m.at > 0);
    return div()
      .relative()
      .w_full()
      .h(46)
      .mt(4)
      .child(
        h_flex()
          .absolute()
          .top(14)
          .left(0)
          .w_full()
          .h(16)
          .rounded(4)
          .border(2)
          .border_color(k.line)
          .overflow_hidden()
          .child(div().h_full().w("50%").bg(k.green))
          .child(div().h_full().w("30%").bg(k.yellow))
          .child(div().h_full().w("20%").bg(k.red)),
      )
      .children(
        marks.map((m) =>
          div()
            .absolute()
            .top(0)
            .left(`${100 - m.at}%`)
            .ml(-1.5)
            .w(3)
            .h(34)
            .bg(k.line)
            .child(div().absolute().top(0).left(-4).size(11).rounded(6).border(2).border_color(k.line).bg(m.color)),
        ),
      )
      .child(h_flex().absolute().bottom(0).left(0).w_full().justify_between().text_size(10.5).text_color(k.dim).child("100% left").child("empty"));
  }

  handoff(t, cx) {
    if (!this.orcha.handoff) {
      this.loadHandoff(cx);
      return div().text_color(t.dim).child("Reading settings…");
    }
    const h = this.orcha.handoff;
    const percent = (key, about, title) => {
      const v = Number(h[key]) || 0;
      const step = (d) => (_e, cx) => this.setHandoff(key, Math.max(0, Math.min(90, v + d)), cx);
      return this.row(t, title, about, this.stepper(t, `ho-${key}`, v ? `${v}%` : "off", step(-5), step(5)));
    };
    const modes = [
      ["ask", "Ask"],
      ["keep", "Keep running"],
      ["restart", "Restart"],
      ["new_pane", "New pane"],
    ];
    const modePicker = h_flex()
      .gap(4)
      .children(
        modes.map(([id, label]) => {
          const on = h.switch_mode === id;
          return div()
            .id(`ho-mode-${id}`)
            .px(10)
            .py(4)
            .rounded(7)
            .border_1()
            .border_color(on ? t.accent : t.border)
            .bg(on ? t.raised : "#00000000")
            .cursor_pointer()
            .text_size(12.5)
            .text_color(on ? t.foreground : t.muted)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.setHandoff("switch_mode", id, cx))
            .child(label);
        }),
      );
    return v_flex()
      .w_full()
      .child(this.heading(t, "Before an account runs dry"))
      .child(div().pb(4).text_size(12.5).line_height("18px").text_color(t.dim).child("Three marks on the fuel of the account in use. Under each one, orcha does a bit more to keep your work going. SWITCH in ACCOUNTS (click FUEL) moves a chat any time."))
      .child(this.handoffBar(h))
      .child(percent("checklist_percent", "The agent in front of you writes what is done and what is next to the checklist file, so the next one can pick up.", "Ask for a checklist under"))
      .child(percent("low_fuel_percent", "A note offers to move the chat to the account with the most fuel.", "Offer to switch under"))
      .child(percent("auto_handoff_percent", "The chat moves to the account with the most fuel by itself, between turns.", "Switch by itself under"))
      .child(div().pt(14))
      .child(this.heading(t, "How a chat moves"))
      .child(this.row(t, "Claude to another Claude account", "Keep running: same chat, no restart. Restart: same chat, the agent starts again on the account. New pane: a new agent beside the old one reads notes and sums up first. Another kind of agent always gets a new pane.", modePicker))
      .child(
        this.row(
          t,
          "Checklist file",
          "Where the checklist goes, inside the project.",
          div().text_size(12.5).text_color(t.foreground).child(h.checklist_file || HANDOFF_DEFAULTS.checklist_file),
        ),
      );
  }

  // orcha: Layout --------------------------------------------------------

  orchaLayout(t, cx) {
    const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);
    const tree = layout();
    const right = find(tree, "right");
    const sidebar = find(tree, "sidebar");
    const width = sidebar?.size?.px ?? 300;
    const processOn = shared("orcha.process") !== "off";
    return v_flex()
      .w_full()
      .child(this.heading(t, "Panels"))
      .child(this.row(t, "Right panel", "FUEL, the branch, changes, history and worktrees beside your work.", this.toggle(t, "ol-right", right ? !right.hidden : false, () => run("layout.toggle", { id: "right" }))))
      .child(this.row(t, "PROCESS", "Running agents as trains at the foot of the sidebar.", this.toggle(t, "ol-process", processOn, () => setShared("orcha.process", processOn ? "off" : "on"))))
      .child(
        this.row(t, "Sidebar width", "How much room the projects get.", this.stepper(t, "ol-width", `${width}px`, () => run("layout.resize", { id: "sidebar", px: Math.max(240, width - 20) }), () => run("layout.resize", { id: "sidebar", px: Math.min(480, width + 20) }))),
      );
  }

  render(cx) {
    const t = theme();
    const u = updates();
    const waiting = Boolean(u.app.ready || (u.core.ready && !u.core.managed));
    const nav = v_flex()
      .flex_none()
      .w(190)
      .p(10)
      .gap(2)
      .border_r(1)
      .border_color(t.border)
      .child(div().px(10).pt(6).pb(12).text_size(16).font_semibold().text_color(t.foreground).child("Settings"))
      .children(
        SECTIONS.map((s) => {
          const on = s.id === this.section;
          return h_flex()
            .id(`st-s-${s.id}`)
            .gap(10)
            .px(10)
            .py(7)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .bg(on ? t.raised : "#00000000")
            .hover((st) => st.bg(t.raised))
            .on_click((_e, cx) => {
              this.section = s.id;
              this.picking = null;
              this.machineEdit = null;
              this.handle.focus();
              if (s.id === "machines") cx.spawn(async (cx) => { await this.loadMachines(); cx.notify(); });
              if (s.id === "projects") this.loadProject(cx);
              if (s.id === "accounts") this.loadAccounts(cx);
              if (s.id === "handoff") this.loadHandoff(cx);
              if (s.id === "whale") checkUpdate();
              cx.notify();
            })
            .child(s.emoji ? div().w(15).text_size(13).child(s.emoji) : svg(s.svg ?? I(s.icon)).size(15).text_color(on ? t.accent : t.dim))
            .child(div().flex_1().text_size(13.5).text_color(on ? t.foreground : t.muted).child(s.title))
            .when((s.id === "updates" && waiting) || (s.id === "whale" && Boolean(available())), (el) => el.child(div().w(7).h(7).rounded(4).bg(t.accent)));
        }),
      );
    return h_flex()
      .id("settings")
      .track_focus(this.handle)
      .w_full()
      .h(620)
      .min_h(0)
      .items_start()
      .bg(t.popover)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (this.machineEdit) {
          if (k === "escape") this.machineEdit = null;
          else return;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (k === "escape") {
          if (this.picking) this.picking = null;
          else return this.close();
          this.handle.focus();
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(nav.h_full().child(div().flex_1()).child(this.button(t, "st-feedback", "Send feedback", () => { closeOverlay(props()?.overlay); run("app.feedback"); })))
      .when(this.section === "projects", (el) => el.child(this.projectTabs(t, cx)))
      .child(
        // A bar that always shows: the pages are taller than the dialog and
        // people should see that they scroll.
        div()
          .relative()
          .flex_1()
          .min_w(0)
          .h_full()
          .child(
            div()
              .id("st-body")
              .size_full()
              .overflow_y_scroll()
              // Padding inside, not on the scroll area: there it counts as
              // content and a page that fits still shows a bar.
              .child(
                div()
                  .px(28)
                  .py(22)
                  .child(
                    this.section === "projects"
                      ? this.projects(t, cx)
                      : this.section === "accounts"
                        ? this.accounts(t, cx)
                      : this.section === "handoff"
                        ? this.handoff(t, cx)
                      : this.section === "orcha"
                        ? this.orchaLayout(t, cx)
                      : this.section === "whale"
                        ? this.whale(t, cx)
                      : this.section === "look"
                      ? this.look(t, cx)
                      : this.section === "keyboard"
                        ? this.keyboard(t)
                      : this.section === "machines"
                        ? this.machines(t)
                      : this.section === "alerts"
                        ? this.alerts(t)
                        : this.section === "privacy"
                          ? this.privacy(t)
                          : this.updates(t),
                  ),
              ),
          )
          .child(Scrollbar.vertical("st-body").mode("always").absolute().inset_0()),
      );
  }
}
