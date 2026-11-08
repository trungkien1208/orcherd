// orcha's right panel: FUEL (the plan limits of the account the focused
// agent uses: Claude, Codex or Cursor), then the
// focused folder's BRANCH, CHANGES, HISTORY and WORKTREES. It also runs the
// low-fuel watch (handoff-watch.js).
//
// Git is read with one shell call every 3 s; FUEL from Orcherd's limits cache
// every 30 s. Rendering only draws the last answers.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, panes, spaces, exec, run, readTextFile, home, shared, setShared, openOverlay, notify } from "herdr";
import { tokens, button, icon, fuelGauge, readable, agentFacts, chip } from "./ui.js";
import { showSide } from "./sidetabs.js";
import HandoffWatch from "./handoff-watch.js";
import { refreshFuel, claudeAccountOf, readAccounts } from "./accounts-data.js";
import { configFile, cacheFile, script } from "./paths.js";

// One call: branch line, changed files, totals, last commit, the checkout's
// top folder and every worktree of the repo.
const GIT_SCRIPT = [
  'cd "$1" 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0',
  'echo "B $(git status --porcelain=v1 -b 2>/dev/null | head -n 1)"',
  "git status --porcelain=v1 2>/dev/null | head -n 30 | sed 's/^/F /'",
  'echo "S $(git diff --shortstat HEAD 2>/dev/null)"',
  "echo \"L $(git log -1 --format='%s%x09%cr' 2>/dev/null)\"",
  'echo "T $(git rev-parse --show-toplevel 2>/dev/null)"',
  "git worktree list --porcelain 2>/dev/null | sed 's/^/W /'",
].join("\n");

// "## main...origin/main [ahead 2, behind 1]" → { name, ahead, behind }
function parseBranch(line) {
  const m = /^## (?:No commits yet on )?(\S+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(line ?? "");
  if (!m) return null;
  const ahead = /ahead (\d+)/.exec(m[3] ?? "")?.[1];
  const behind = /behind (\d+)/.exec(m[3] ?? "")?.[1];
  return { name: m[1], ahead: Number(ahead ?? 0), behind: Number(behind ?? 0) };
}

function parseGit(out) {
  const git = { branch: null, files: [], added: 0, removed: 0, last: null, top: null, worktrees: [] };
  for (const line of out.split("\n")) {
    const kind = line.slice(0, 2);
    const rest = line.slice(2);
    if (kind === "B ") git.branch = parseBranch(rest);
    else if (kind === "F ") git.files.push({ code: rest.slice(0, 2).trim() || "M", path: rest.slice(3) });
    else if (kind === "S ") {
      git.added = Number(/(\d+) insertion/.exec(rest)?.[1] ?? 0);
      git.removed = Number(/(\d+) deletion/.exec(rest)?.[1] ?? 0);
    } else if (kind === "L " && rest.trim()) {
      const [subject, age] = rest.split("\t");
      git.last = { subject, age };
    } else if (kind === "T ") git.top = rest.trim() || null;
    else if (kind === "W ") {
      // --porcelain: "worktree <path>" starts one, then branch/detached/bare/prunable.
      const [word, ...more] = rest.split(" ");
      const value = more.join(" ");
      const tree = git.worktrees.at(-1);
      if (word === "worktree") git.worktrees.push({ path: value, branch: null, detached: false, bare: false, prunable: false });
      else if (!tree) continue;
      else if (word === "branch") tree.branch = value.replace(/^refs\/heads\//, "");
      else if (word === "detached") tree.detached = true;
      else if (word === "bare") tree.bare = true;
      else if (word === "prunable") tree.prunable = true;
    }
  }
  git.worktrees = git.worktrees.filter((w) => !w.bare);
  return git;
}

async function readJson(path) {
  try {
    const text = await readTextFile(path);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export default class Panel {
  constructor(cx) {
    this.folder = null;
    this.git = null;
    this.fuel = null;
    this.history = false;
    this.worktrees = true;
    this.readGit(cx);
    this.readFuel(cx);
    cx.timer.every(3000, (cx) => this.readGit(cx));
    // Fuel goes stale unless someone asks the plans: once a minute ask them
    // through bin/accounts.py (it skips accounts read under 2 minutes ago),
    // then read the cache again.
    this.refreshFuel(cx);
    cx.timer.every(60000, (cx) => this.refreshFuel(cx));
    this.watch = new HandoffWatch();
    cx.timer.every(60000, (cx) => this.watch.check(cx));
  }

  currentFolder() {
    return focused()?.cwd ?? spaces().find((s) => s.active)?.folder ?? null;
  }

  readGit(cx) {
    cx.spawn(async (cx) => {
      const folder = this.currentFolder();
      if (!folder) return;
      const r = await exec("sh", ["-c", GIT_SCRIPT, "sh", folder]);
      this.folder = folder;
      this.git = r.code === 0 && r.stdout.trim() ? parseGit(r.stdout) : null;
      // The status bar shows the same summary; told only when it changes.
      const g = this.git;
      const summary = g ? { branch: g.branch?.name ?? null, files: g.files.length, added: g.added, removed: g.removed } : null;
      if (JSON.stringify(summary) !== JSON.stringify(shared("orcha.git") ?? null)) setShared("orcha.git", summary);
      cx.notify();
    });
  }

  // The kind of agent in front of you: its fuel is the one shown.
  focusedKind() {
    const f = focused();
    const key = (f?.pane ? panes().find((p) => p.pane === f.pane) : null)?.program?.key ?? "";
    return key.includes("codex") ? "codex" : key.includes("cursor") ? "cursor" : "claude";
  }

  // The account the agent in front of you runs on (a Claude: the one in its
  // config folder, else the active one; others: the one last picked, else the
  // first), its email and limits.
  // The key FUEL was read for: the agent kind, the pane, its account as the
  // sidebar last read it (so a switch shows at once), any switch since.
  fuelKeyNow() {
    const f = focused();
    return `${this.focusedKind()}:${f?.pane ?? ""}:${agentFacts().accounts?.[f?.terminal]?.id ?? ""}:${shared("orcha.fuelRev") ?? 0}`;
  }

  readFuel(cx) {
    const kind = this.focusedKind();
    const f = focused();
    const asked = (this.fuelKey = this.fuelKeyNow());
    cx.spawn(async (cx) => {
      const config = await readJson(configFile("config.json"));
      const accounts = (config?.accounts ?? []).filter((a) => a.kind === kind);
      // The sidebar's read of the pane's account is instant; asking the
      // process takes a few hundred ms, so only when it has none yet.
      const known = kind === "claude" ? agentFacts().accounts?.[f?.terminal] : null;
      const pick = kind === "claude" && f?.terminal ? known?.id ?? (await claudeAccountOf(f.terminal)) : null;
      const file = kind === "claude" ? "claude-active" : "selected-account";
      // A hub account isn't in config.json: its fuel comes with the hub's
      // list (tokenstation.py sync), not from a cache of ours.
      if (pick?.startsWith("station-")) {
        const hub = (await readAccounts()).list.find((a) => a.id === pick);
        if (!hub || asked !== this.fuelKey) return;
        this.fuel = { label: hub.label ?? hub.id, email: hub.email || null, chip: "⚡ HUB", sub: null, limits: hub.limits };
        cx.notify();
        return;
      }
      const fallback = pick ?? (await readTextFile(configFile(file)))?.trim();
      // None picked yet (a new Mac): the account of the main ~/.claude folder.
      const account = accounts.find((a) => a.id === fallback) ?? (kind === "claude" ? accounts.find((a) => !a.dir) ?? null : accounts[0]);
      if (!account || asked !== this.fuelKey) return;
      const limits = await readJson(cacheFile(`limits/${account.id}.json`));
      // A switch clears the account's cached fuel: ask for it now, not in a minute.
      if (!limits?.session && !limits?.weekly && !limits?.error && Date.now() - (this.kicked?.[account.id] ?? 0) > 30000) {
        this.kicked = { ...this.kicked, [account.id]: Date.now() };
        this.refreshFuel(cx);
      }
      // Borrowing: the account whose tokens are spent (its fuel below), a
      // BORROWED chip, and one line saying whose chat it is.
      const owner = known?.borrowed ? accounts.find((a) => a.id === known.seat) : null;
      const short = (a) => (a.label ?? a.id).split("·").pop().trim();
      this.fuel = {
        label: account.label ?? account.id,
        email: owner ? null : account.email ?? null,
        chip: owner ? "🤝 BORROWED" : null,
        sub: owner ? `${short(owner)}'s chat, running on ${short(account)}'s tokens` : null,
        limits,
      };
      cx.notify();
    });
  }

  refreshFuel(cx) {
    cx.spawn(async (cx) => {
      await refreshFuel();
      this.readFuel(cx);
    });
  }

  // One line per checkout of the repo: its folder's name, its branch, HERE
  // for the one you are in. A click shows its project, opening it if needed.
  worktreeRows(t, git) {
    if (git.worktrees.length < 2) return [div().text_size(12).text_color(t.dim).child("only this checkout")];
    const open = (path) => {
      const space = spaces().find((s) => s.folder === path);
      if (space) run("space.select", { id: space.id });
      else run("space.new", { folder: path, machine: spaces().find((s) => s.active)?.machine ?? "" });
    };
    return git.worktrees.map((w, n) => {
      const here = w.path === git.top;
      return h_flex()
        .id(`worktree-${w.path}`)
        .gap(8)
        .items_center()
        .rounded(3)
        .text_size(12)
        .when(!here && !w.prunable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => open(w.path)))
        .child(div().flex_none().font_bold().text_color(w.prunable ? t.dim : t.ink).child(w.path.split("/").pop() || w.path))
        .child(div().flex_1().truncate().text_color(t.dim).child(w.prunable ? "folder gone" : w.branch ?? (w.detached ? "detached" : "")))
        .when(n === 0, (el) => el.child(div().flex_none().text_size(10).font_black().text_color(t.dim).child("MAIN")))
        .when(here, (el) => el.child(chip(t, "HERE", t.yellow).border(1.5).border_color(t.line)));
    });
  }

  // A section: icon and title (a chevron when it folds), then its rows.
  // `onClick` makes the whole section a button.
  section(t, name, title, children, { fold, onClick } = {}) {
    const open = !fold || fold.open;
    const head = h_flex()
      .h(24)
      .items_center()
      .gap(6)
      .text_size(11)
      .font_black()
      .text_color(t.ink)
      .when(Boolean(fold), (el) => el.child(icon(fold?.open ? "chevron-down" : "chevron-right", 13, t.dim)))
      .child(icon(name, 14, t.ink))
      .child(div().flex_1().child(title))
      .when(Boolean(onClick), (el) => el.child(icon("chevron-right", 13, t.dim)));
    const header = fold
      ? head
          .id(`fold-${title}`)
          .cursor_pointer()
          .on_click((_e, cx) => {
            fold.toggle();
            cx.notify();
          })
      : head;
    return v_flex()
      .id(`section-${title}`)
      .px(12)
      .py(10)
      .gap(5)
      .border_b(2)
      .border_color(t.line)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .child(header)
      .when(open, (el) => el.children(children));
  }

  render(cx) {
    const t = tokens();
    // FUEL follows the agent in front of you, and any switch of account.
    if (this.fuelKeyNow() !== this.fuelKey) this.readFuel(cx);
    const sections = [];
    if (this.fuel) {
      const rows = [
        h_flex()
          .gap(6)
          .items_center()
          .child(div().text_size(12.5).font_bold().text_color(t.ink).child(this.fuel.label))
          .when(Boolean(this.fuel.chip), (el) => el.child(chip(t, this.fuel.chip, t.pink).border(1.5).border_color(t.line)))
          .when(Boolean(this.fuel.email), (el) => el.child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(this.fuel.email))),
      ];
      if (this.fuel.sub) rows.push(div().text_size(11).text_color(t.dim).child(this.fuel.sub));
      const session = fuelGauge(t, "5H", this.fuel.limits?.session);
      const weekly = fuelGauge(t, "WEEK", this.fuel.limits?.weekly);
      const monthly = fuelGauge(t, "MONTH", this.fuel.limits?.monthly);
      if (session) rows.push(session);
      if (weekly) rows.push(weekly);
      if (monthly) rows.push(monthly);
      if (this.fuel.limits?.note) rows.push(div().text_size(11).text_color(t.dim).child(this.fuel.limits.note));
      if (this.fuel.limits?.error) rows.push(div().text_size(11.5).text_color(readable(t, t.blocked)).child(this.fuel.limits.error));
      sections.push(
        this.section(t, "fuel", "FUEL", rows, {
          onClick: () => openOverlay({ mod: "orcha", props: { part: "accounts" }, kind: "dialog", width: 560, frame: "none" }),
        }),
      );
    }
    const git = this.git;
    if (!git) {
      sections.push(this.section(t, "git-branch", "BRANCH", [div().text_size(12).text_color(t.dim).child("not a git folder")]));
    } else {
      const b = git.branch;
      const branchRows = [div().text_size(12.5).font_bold().truncate().text_color(t.ink).child(b?.name ?? "detached")];
      if (b && (b.ahead || b.behind)) {
        branchRows.push(
          h_flex()
            .gap(8)
            .text_size(12)
            .when(b.ahead > 0, (el) => el.child(h_flex().gap(3).items_center().child(icon("arrow-up", 12, readable(t, t.done))).child(div().text_color(readable(t, t.done)).child(`${b.ahead} to push`))))
            .when(b.behind > 0, (el) => el.child(h_flex().gap(3).items_center().child(icon("arrow-down", 12, t.ansi4)).child(div().text_color(t.ansi4).child(`${b.behind} to pull`)))),
        );
      }
      // ⌘E / ⌘G: the project in the first IDE or Git app on this Mac (bin/open-in.sh).
      const openIn = (app) =>
        exec("sh", [script("open-in.sh"), app, this.folder]).then((r) => {
          if (r.code !== 0) notify({ title: `No ${app === "ide" ? "IDE" : "Git app"} found`, body: r.stderr.trim(), level: "warning", timeout: 6000 });
        });
      branchRows.push(
        h_flex()
          .gap(6)
          .pt(4)
          .child(button(t, "orcha-ide", h_flex().gap(5).items_center().child(icon("code-xml", 13)).child("IDE").child(div().text_color(t.dim).child("⌘E")), () => openIn("ide"), { small: true }))
          .child(button(t, "orcha-git", h_flex().gap(5).items_center().child(icon("git-merge", 13)).child("Git").child(div().text_color(t.dim).child("⌘G")), () => openIn("git"), { small: true })),
      );
      sections.push(this.section(t, "git-branch", "BRANCH", branchRows));

      const codeColor = (code) => readable(t, code.includes("D") ? t.blocked : code.includes("A") || code === "??" ? t.done : t.working);
      const changeRows = git.files.length
        ? [
            h_flex()
              .gap(8)
              .text_size(12)
              .child(div().text_color(t.muted).child(git.files.length === 1 ? "1 file" : `${git.files.length} files`))
              .child(div().font_bold().text_color(readable(t, t.done)).child(`+${git.added}`))
              .child(div().font_bold().text_color(readable(t, t.blocked)).child(`−${git.removed}`)),
            ...git.files.slice(0, 12).map((f) =>
              h_flex()
                .id(`change-${f.path}`)
                .gap(8)
                .rounded(3)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => showSide("files"))
                .text_size(12)
                .child(div().w(16).font_bold().text_color(codeColor(f.code)).child(f.code === "??" ? "A" : f.code[0]))
                .child(div().flex_1().truncate().text_color(t.foreground).child(f.path)),
            ),
          ]
        : [div().text_size(12).text_color(t.dim).child("nothing changed")];
      sections.push(this.section(t, "file-diff", "CHANGES", changeRows));

      if (git.last) {
        sections.push(
          this.section(t, "history", "HISTORY", [div().text_size(12).truncate().text_color(t.foreground).child(git.last.subject), div().text_size(11.5).text_color(t.dim).child(git.last.age)], {
            fold: { open: this.history, toggle: () => (this.history = !this.history) },
          }),
        );
      }
      sections.push(
        this.section(t, "git-fork", `WORKTREES · ${git.worktrees.length}`, this.worktreeRows(t, git), {
          fold: { open: this.worktrees, toggle: () => (this.worktrees = !this.worktrees) },
        }),
      );
    }
    // One thin-bordered box, sections split by lines, no shadow (SPEC §2).
    return v_flex()
      .id("orcha-panel")
      .size_full()
      .p(10)
      .bg(t.paper)
      .child(v_flex().rounded(6).border(2).border_color(t.line).bg(t.card).overflow_hidden().overflow_y_scrollbar().children(sections));
  }
}
