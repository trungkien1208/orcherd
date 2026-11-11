// The left side (SPEC §2 "Left sidebar", §3.1 PROCESS): + NEW and the menu,
// then the projects, then the running agents as trains.
//
// Read off the render path: one `ps` every 4 s for memory, and each Claude
// agent's newest transcript every 5 s for its model, its context and what it
// is doing (its station). Models, contexts and stations are shared with the
// other parts.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, terminals, run, exec, hc, home, readTextFile, openOverlay, shared, setShared, notify } from "herdr";
import {
  tokens,
  raised,
  dot,
  button,
  icon,
  programIcon,
  ownTitle,
  agentColor,
  modelLabel,
  modelOf,
  tokensShort,
  agentFacts,
  pill,
  projectTile,
  ago,
  RANK,
  agentTitle,
  plural,
  openWorktree,
  shellBusy,
  portPill,
} from "./ui.js";
import { readPaneAccounts, resumeClaude } from "./accounts-data.js";
import { configFile } from "./paths.js";
import { systemOpen } from "./links.js";
import { menuHeight } from "./menu.js";
import { ICON_OVERLAY } from "./icon.js";
import { indexSpaces, readRepo, groupSpaces, isRepo, repoKey, moveGroup } from "./repos.js";
import { openNew } from "./new.js";

const GB = 1024 * 1024 * 1024;
// A context this big is worth a look (orcha_usage: HEAVY_CONTEXT_TOKENS).
const HEAVY_CONTEXT = 150_000;
const STATIONS = ["THINK", "CODE", "TEST", "DONE"];

// Bytes in MB, to the nearest 10: shared only when that changes.
const mb = (n) => Math.round(n / (10 * 1024 * 1024)) * 10;
const bytes = (n) => (n >= GB ? `${(n / GB).toFixed(1)}G` : `${Math.max(1, Math.round(n / (1024 * 1024)))}M`);

// Claude keeps a folder per project: the path with every character that is
// not a letter or a digit as `-` (so `LARK_AUTOMATION` is `LARK-AUTOMATION`).
const claudeDir = (cwd) => `${home()}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}`;

// From the newest transcript: line 1 the model, line 2 the last tool call
// (with the start of a shell command), line 3 the last reply's token usage.
const TRANSCRIPT_SCRIPT = [
  'f=$(ls -t "$1"/*.jsonl 2>/dev/null | head -n 1); [ -n "$f" ] || exit 0',
  't=$(tail -c 262144 "$f")',
  "printf '%s' \"$t\" | grep -o '\"model\":\"claude-[a-z0-9.-]*' | tail -n 1 | cut -d'\"' -f4",
  "printf '%s\\n' \"$(printf '%s' \"$t\" | grep -o '\"type\":\"tool_use\",\"id\":\"[^\"]*\",\"name\":\"[A-Za-z_]*\"\\(,\"input\":{\"command\":\"[^\"]\\{0,120\\}\\)\\?' | tail -n 1)\"",
  "printf '%s' \"$t\" | grep -o '\"usage\":{[^}]*}' | tail -n 1",
  // Its session, to resume it after a crash (marked: the lines above may be missing).
  'echo "session:$(basename "$f" .jsonl)"',
].join("\n");

// Codex keeps its sessions by date; the newest one started in the folder:
// line 1 its size (or "same"), then the model (else config.toml's), the last
// tool call and the last turn's token usage in what was read.
const CODEX_SCRIPT = [
  'f=; for x in $(ls -t "$HOME"/.codex/sessions/*/*/*/*.jsonl 2>/dev/null | head -n 40); do head -c 6000 "$x" | grep -qF "\\"cwd\\":\\"$1\\"" && { f=$x; break; }; done',
  'if [ -z "$f" ]; then sed -n \'s/^model *= *"\\(.*\\)"/\\1/p\' "$HOME/.codex/config.toml" 2>/dev/null | head -n 1; exit 0; fi',
  // $2 is its size last time: unchanged, say so; grown, read only what was
  // added (sessions reach tens of MB, mostly pictures).
  's=$(wc -c < "$f" | tr -d " "); [ "$s" = "$2" ] && { echo same; exit 0; }; printf "%s\\n%s\\n" "$s" "$f"',
  'from=1; [ -n "$2" ] && [ "$2" -lt "$s" ] && from=$(($2 + 1))',
  "tail -c +\"$from\" \"$f\" | LC_ALL=C grep -oE '\"model\":\"[^\"]*|\"name\":\"[a-z_]+\",\"input\":\".{0,250}|\"last_token_usage\":\\{[^}]*\\}' | awk '/^\"model/{m=$0} /^\"name/{t=$0} /^\"last_token/{u=$0} END{sub(/^\"model\":\"/,\"\",m); print m; print t; print u}'",
].join("\n");

const READING = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|Task|Agent|TodoWrite|ToolSearch)$/;
const CHECKS = /\b(test|tests|jest|vitest|pytest|nextest|tsc|typecheck|lint|eslint|clippy|check)\b/;

// The station a tool call puts an agent at: reading → THINK, editing or
// running → CODE, tests and checks → TEST.
function stationOf(toolLine) {
  const name = /"name":"([A-Za-z_]+)"/.exec(toolLine ?? "")?.[1];
  if (!name || READING.test(name)) return "THINK";
  if (name === "Bash") return CHECKS.test(/"command":"(.*)$/.exec(toolLine)?.[1] ?? "") ? "TEST" : "CODE";
  return "CODE";
}

// Codex's station, from the command its last tool call ran: an edit is CODE,
// checks are TEST, looking around (ls, cat, rg, git status) is THINK.
function codexStation(toolLine) {
  if (!toolLine) return "THINK";
  if (/apply_patch|write_file|\bcat\s*>|>\s*\S+\.\w+/.test(toolLine)) return "CODE";
  if (CHECKS.test(toolLine)) return "TEST";
  if (/\b(ls|cat|rg|grep|find|head|tail|sed -n|git (status|log|diff|show))\b/.test(toolLine)) return "THINK";
  return "CODE";
}

// The tokens a reply carried: fresh input plus what came from the cache.
function contextOf(usageLine) {
  const field = (name) => Number(new RegExp(`"${name}":(\\d+)`).exec(usageLine ?? "")?.[1] ?? 0);
  const used = field("input_tokens") + field("cache_creation_input_tokens") + field("cache_read_input_tokens");
  return used > 0 ? used : null;
}

// Processes a shell keeps beside you (prompt helpers), not something you ran.
const HELPERS = /(^|\/)(gitstatusd|gitstatus)\b/;
const SHELL = /^-?(\S*\/)?(zsh|bash|fish|sh)(\s|$)/;
// How to pick a conversation up again.
const RESUME = { claude: (id, folder) => resumeClaude(id, folder), codex: (id) => `codex resume ${id}` };
// Herdr itself: the window, and herdr-core, which runs every terminal.
const HERDR = /(Herdr\.app\/Contents\/MacOS\/Herdr|herdr-core --hc-launchd)(\s|$)/;
const LAUNCHERS = /^(node|nodejs|python[\d.]*|ruby|bun|deno|sh|bash|zsh|env|exec|npx)$/;

// What a command line runs, short: `node …/pnpm dev:local` → `pnpm dev:local`,
// `python3 -m http.server 8000` → `http.server 8000`.
function commandLabel(args) {
  const words = args.split(/\s+/).filter((w) => w && !w.startsWith("-"));
  const base = (w) => w.split("/").pop();
  let i = 0;
  while (i < words.length - 1 && LAUNCHERS.test(base(words[i]))) i++;
  const label = [base(words[i] ?? ""), ...(words[i + 1] ? [words[i + 1].includes("/") ? base(words[i + 1]) : words[i + 1]] : [])].join(" ");
  return label.length > 28 ? `${label.slice(0, 27)}…` : label;
}

// `lsof -Fpn`: "p<pid>" then "n<addr>:<port>" lines → Map pid → ports.
function listeningPorts(text) {
  const out = new Map();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (!port) continue;
      if (!out.has(pid)) out.set(pid, new Set());
      out.get(pid).add(port);
    }
  }
  return out;
}

// A per-viewer list kept between restarts (localStorage can be missing).
function stored(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
}
function keep(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // only a convenience
  }
}

export default class Left {
  constructor(cx) {
    this.memory = new Map(); // terminal address → bytes
    this.changed = new Map(); // pane → { status, at }
    this.icons = {}; // project folder → emoji (Orcherd's project-icons.json, paths.js)
    this.codex = new Map(); // folder → { size, lines }: the last Codex session read
    this.git = {}; // repo key (repos.js) → { repo, main, top, linked } or null (not git)
    this.asking = new Set(); // repo keys being read
    // Agents the last run had (orcha.sessions): after a crash their terminals
    // come back as plain shells, so the first look resumes them (resumeLost).
    this.lost = { ...(shared("orcha.sessions") ?? {}) };
    this.pressed = null; // the group a drag started on
    this.over = null; // the group it would land on
    // Projects showing their agents, remembered between restarts: one opens
    // when it is selected and stays open until its arrow closes it.
    this.opened = new Set(stored("orcha.opened"));
    this.readIcons(cx);
    this.readMemory(cx);
    this.readTranscripts(cx);
    cx.timer.every(4000, (cx) => this.readMemory(cx));
    cx.timer.every(5000, (cx) => this.readTranscripts(cx));
    // Which account each Claude pane runs on: FUEL reads it, at once.
    this.readAccountsOf(cx);
    cx.timer.every(15000, (cx) => this.readAccountsOf(cx));
    cx.timer.every(60000, (cx) => this.readIcons(cx));
    // A folder's repo rarely changes; a new folder is read on sight (render).
    cx.timer.every(60000, (cx) => this.readGit([...new Set([...indexSpaces(spaces(), panes()).values()].map((x) => x.key))], cx, true));
  }

  readIcons(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(configFile("project-icons.json"));
        this.icons = text ? JSON.parse(text) : {};
      } catch {
        this.icons = {};
      }
      cx.notify();
    });
  }

  // One pass over the process table: each terminal's shell and everything
  // under it, for its memory; what a shell runs (its newest child) and the
  // TCP ports anything under it listens on, so a dev server shows.
  readMemory(cx) {
    cx.spawn(async (cx) => {
      const live = terminals().filter((t) => t.state === "live" && t.pid);
      if (!live.length) return;
      const r = await exec("ps", ["-axo", "pid=,ppid=,rss=,args="]);
      if (r.code !== 0) return;
      const procs = new Map(); // pid → { rss, args }
      const kids = new Map();
      for (const line of r.stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const [pid, ppid] = [Number(m[1]), Number(m[2])];
        procs.set(pid, { rss: Number(m[3]) * 1024, args: m[4] });
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
      }
      // What each shell runs (its newest child, not a prompt helper); agents'
      // terminals are not shells to show. Ports are asked only when one does.
      const agentsAt = new Set(panes().filter((p) => p.program?.agent).map((p) => p.terminal));
      const running = new Map();
      for (const t of live) {
        if (agentsAt.has(t.address)) continue;
        const children = (kids.get(t.pid) ?? []).filter((pid) => !HELPERS.test(procs.get(pid)?.args ?? ""));
        if (children.length) running.set(t.address, children[children.length - 1]);
      }
      const listening = running.size ? await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).catch(() => null) : null;
      const ports = listeningPorts(listening?.stdout ?? "");
      // Everything under a process (each counted once).
      const seen = new Set();
      const under = (root) => {
        let total = 0;
        const next = [root];
        while (next.length) {
          const pid = next.pop();
          if (seen.has(pid)) continue;
          seen.add(pid);
          total += procs.get(pid)?.rss ?? 0;
          next.push(...(kids.get(pid) ?? []));
        }
        return total;
      };
      // Herdr in all: the window, then herdr-core with every terminal and agent.
      const roots = [...procs].filter(([, p]) => HERDR.test(p.args));
      const app = roots.filter(([, p]) => p.args.includes("Herdr.app")).reduce((sum, [pid]) => sum + under(pid), 0);
      const core = roots.filter(([, p]) => !p.args.includes("Herdr.app")).reduce((sum, [pid]) => sum + under(pid), 0);
      const herdr = { app: mb(app), all: mb(app + core) };
      const memory = new Map();
      const busy = {};
      const idle = new Set(); // terminals that are a shell at its prompt
      for (const t of live) {
        let total = 0;
        const open = new Set();
        const mine = new Set();
        const next = [t.pid];
        while (next.length) {
          const pid = next.pop();
          if (mine.has(pid)) continue;
          mine.add(pid);
          total += procs.get(pid)?.rss ?? 0;
          for (const port of ports.get(pid) ?? []) open.add(port);
          next.push(...(kids.get(pid) ?? []));
        }
        memory.set(t.address, total);
        const child = running.get(t.address);
        if (child) busy[t.address] = { cmd: commandLabel(procs.get(child).args), ports: [...open].sort((a, b) => a - b) };
        else if (!agentsAt.has(t.address) && SHELL.test(procs.get(t.pid)?.args ?? "")) idle.add(t.address);
      }
      this.resumeLost(idle);
      this.memory = memory;
      this.publish({ memory: Object.fromEntries([...memory].map(([t, b]) => [t, mb(b)])), busy, herdr });
      cx.notify();
    });
  }

  // Once, on the first look after a start: an agent the last run had whose
  // terminal is now a shell at its prompt (Herdr gives a lost terminal a
  // fresh shell, and never runs its command again) gets its conversation
  // back. A terminal whose agent still runs is left alone.
  resumeLost(idle) {
    const lost = Object.entries(this.lost);
    this.lost = {};
    if (!lost.length) return;
    const done = new Set();
    let n = 0;
    for (const [terminal, { kind, session, folder }] of lost) {
      // Two chats in one folder read as the same conversation: resume it once.
      if (!idle.has(terminal) || !RESUME[kind] || done.has(session)) continue;
      done.add(session);
      hc(["send", terminal, RESUME[kind](session, folder)]);
      n += 1;
    }
    if (n) notify({ title: `Resumed ${n} agent${n > 1 ? "s" : ""} after the restart`, level: "info", timeout: 4000 });
  }

  // Models by folder; contexts and stations by terminal. Shared only when
  // something changed.
  // Models, contexts and stations by terminal: Claude's from its newest
  // conversation in the folder, Codex's from its newest session there.
  readTranscripts(cx) {
    cx.spawn(async (cx) => {
      const live = panes().filter((p) => p.cwd && p.terminal);
      const models = {};
      const contexts = {};
      const stations = {};
      const sessions = {}; // terminal → { kind, session }: what to resume after a crash
      // `lines(cwd)` gives [model, last tool call, last usage], or null.
      const read = async (kind, lines, station, context) => {
        const mine = live.filter((p) => p.program?.key?.includes(kind));
        const folders = [...new Set(mine.map((p) => p.cwd))];
        // Every folder at once; each is its own small script.
        const all = await Promise.all(folders.map((cwd) => lines(cwd).catch(() => null)));
        folders.forEach((cwd, i) => {
          const got = all[i];
          if (!got) return;
          const [model, tool, usage, session] = got;
          const label = modelLabel(model?.trim());
          const used = context(usage);
          for (const p of mine.filter((p) => p.cwd === cwd)) {
            if (label) models[p.terminal] = label;
            if (tool !== undefined) stations[p.terminal] = station(tool);
            if (used) contexts[p.terminal] = used;
            // Claude's config folder too: the chat comes back on its account.
            const folder = kind === "claude" ? shared("orcha.agents")?.accounts?.[p.terminal]?.folder : null;
            if (session) sessions[p.terminal] = folder && folder !== "-" ? { kind, session, folder } : { kind, session };
          }
        });
      };
      const claude = async (cwd) => {
        const r = await exec("sh", ["-c", TRANSCRIPT_SCRIPT, "sh", claudeDir(cwd)]);
        if (r.code !== 0) return null;
        const out = r.stdout.split("\n");
        const session = out.find((line) => line.startsWith("session:"))?.slice(8);
        return [...out.filter((line) => !line.startsWith("session:")).slice(0, 3), session];
      };
      // Codex sessions are big: read again only when the file grew.
      const codex = async (cwd) => {
        const seen = this.codex.get(cwd);
        const r = await exec("sh", ["-c", CODEX_SCRIPT, "sh", cwd, seen?.size ?? ""]);
        const last = seen ? [...seen.lines, seen.session] : null;
        if (r.code !== 0) return last;
        const out = r.stdout.split("\n");
        if (out[0] === "same") return last;
        // No session in the folder: config.toml's model alone.
        if (!/^\d+$/.test(out[0])) return [out[0]];
        // Line 2 is the session file (…-<uuid>.jsonl); what the new part did
        // not say, the earlier part did.
        const session = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(out[1])?.[1];
        const lines = out.slice(2, 5).map((line, i) => line || seen?.lines?.[i] || "");
        this.codex.set(cwd, { size: out[0], lines, session });
        return [...lines, session];
      };
      await Promise.all([
        read("claude", claude, stationOf, contextOf),
        read("codex", codex, codexStation, (usage) => Number(/"input_tokens":(\d+)/.exec(usage ?? "")?.[1] ?? 0) || null),
      ]);
      this.publish({ models, contexts, stations });
      // Kept in shared.json, so the next start finds them. Ones still waiting
      // to be resumed stay until they are.
      const keep = { ...this.lost, ...sessions };
      if (JSON.stringify(keep) !== JSON.stringify(shared("orcha.sessions") ?? {})) setShared("orcha.sessions", keep);
      cx.notify();
    });
  }

  readAccountsOf(cx) {
    cx.spawn(async () => {
      try {
        this.publish({ accounts: await readPaneAccounts() });
      } catch {
        // the last read stays
      }
    });
  }

  // Shares what was read (memory in MB, to the nearest 10) only when it changed.
  publish(part) {
    const facts = { ...(shared("orcha.agents") ?? {}), ...part };
    if (JSON.stringify(facts) !== JSON.stringify(shared("orcha.agents") ?? null)) setShared("orcha.agents", facts);
  }

  top(k) {
    return h_flex()
      .gap(8)
      .px(2)
      .pt(4)
      .pb(12)
      .child(
        div()
          .flex_1()
          .child(
            button(k, "orcha-new", h_flex().gap(6).items_center().child(icon("plus", 15)).child("NEW"), () => openNew(), {
              primary: true,
            }),
          ),
      )
      .child(button(k, "orcha-menu", icon("menu", 16), () => run("app.palette")));
  }

  // Right-click: the menu for a project or a pane, where the pointer is.
  menu(target) {
    return (_e, cx) => {
      cx.stop_propagation();
      openOverlay({ mod: "orcha", props: { part: "menu", target }, kind: "popup", at: "pointer", frame: "none", width: 230, height: menuHeight(target) });
    };
  }

  // How long a pane has been in its state; stamped when it changes.
  since(pane) {
    const now = Date.now();
    const seen = this.changed.get(pane.pane);
    if (!seen || seen.status !== pane.status) this.changed.set(pane.pane, { status: pane.status, at: now });
    return now - this.changed.get(pane.pane).at;
  }

  // An agent: its avatar in the agent's color, what it works on, its model and
  // how long it has been like this, then context and RAM as colored pills.
  agentCard(k, pane, agent) {
    const facts = this.facts;
    const color = agentColor(k, pane.program);
    const title = agentTitle(agent, pane) || pane.program?.name;
    const context = pane.terminal ? facts.contexts?.[pane.terminal] : null;
    const mem = pane.terminal ? this.memory.get(pane.terminal) : null;
    const status = pane.status ?? "idle";
    const health = [];
    if (context) health.push(pill(k, [icon("brain", 11), `${tokensShort(context)} context`], context >= HEAVY_CONTEXT ? k.yellow : k.green));
    if (mem) health.push(pill(k, [icon("cpu", 11), `${bytes(mem)} RAM`], mem >= 2 * GB ? k.red : mem >= GB ? k.yellow : k.green));
    const statePill = status === "blocked" ? pill(k, "needs you", k.red) : status === "working" ? pill(k, "running", k.yellow) : status === "done" ? pill(k, "done", k.green) : null;
    return h_flex()
      .id(`pane-${pane.pane}`)
      .gap(10)
      .p(8)
      .items_start()
      .rounded(7)
      .border(pane.focused ? 2 : 0)
      .border_color(k.line)
      .when(pane.focused, (el) => el.bg(k.paper))
      .hover((el) => (pane.focused ? el : el.bg(k.hover)))
      .on_click(() => run("pane.focus", { pane: pane.pane }))
      .on_mouse_down("right", this.menu({ kind: "pane", pane: pane.pane, tab: pane.tab, terminal: pane.terminal, name: title }))
      .child(
        div()
          .relative()
          .size(30)
          .flex()
          .flex_none()
          .items_center()
          .justify_center()
          .rounded(15)
          .border(2)
          .border_color(k.line)
          .bg(color)
          .child(programIcon(pane.program, 16, k.chipText) ?? icon("zap", 15, k.chipText))
          .child(div().absolute().bottom(-2).right(-2).child(dot(k, status, 10))),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().font_bold().text_color(k.ink).child(title))
              .when(Boolean(statePill), (el) => el.child(statePill)),
          )
          .child(div().text_size(11.5).text_color(k.muted).child(`${modelOf(pane, facts)} · ${ago(this.since(pane))}`))
          .when(health.length > 0, (el) => el.child(h_flex().gap(5).pt(2).children(health))),
      );
  }

  // A shell: one quiet row.
  // A shell: one quiet row; what it runs and the ports it serves under it.
  shellRow(k, pane) {
    const title = ownTitle(pane) || pane.program?.name || "Shell";
    const busy = shellBusy(pane, this.facts);
    return h_flex()
      .id(`pane-${pane.pane}`)
      .min_h(30)
      .py(busy ? 4 : 0)
      .px(8)
      .gap(8)
      .items_center()
      .rounded(7)
      .border(pane.focused ? 2 : 0)
      .border_color(k.line)
      .when(pane.focused, (el) => el.bg(k.paper))
      .hover((el) => (pane.focused ? el : el.bg(k.hover)))
      .on_click(() => run("pane.focus", { pane: pane.pane }))
      .on_mouse_down("right", this.menu({ kind: "pane", pane: pane.pane, tab: pane.tab, terminal: pane.terminal, name: title }))
      .child(
        div()
          .relative()
          .size(30)
          .flex()
          .flex_none()
          .items_center()
          .justify_center()
          .child(icon("terminal", 15, busy ? k.ink : k.muted))
          .when(Boolean(busy), (el) => el.child(div().absolute().bottom(3).right(3).child(dot(k, "working", 8)))),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().truncate().text_size(12.5).text_color(k.ink).when(pane.focused, (el) => el.font_bold()).child(title))
          .when(Boolean(busy), (el) =>
            el.child(
              h_flex()
                .gap(5)
                .items_center()
                .child(div().flex_shrink(1).min_w(0).truncate().text_size(11.5).text_color(k.muted).child(busy.cmd))
                .children(busy.ports.slice(0, 3).map((port) => portPill(k, `port-${pane.pane}-${port}`, port, systemOpen))),
            ),
          ),
      );
  }

  // A newly selected project opens, and the repo card it is in.
  openSelected(list, groups) {
    const id = list.find((s) => s.active)?.id;
    if (!id || id === this.selected) return;
    this.selected = id;
    this.opened.add(id);
    const group = groups.find((g) => g.members.some((m) => m.space.id === id));
    if (group && isRepo(group)) this.opened.add(repoKey(group));
    keep("orcha.opened", this.opened);
  }

  // The arrow: shows or hides a project's agents (or a repo's worktrees)
  // without switching to it.
  toggle(key, cx) {
    if (this.opened.has(key)) this.opened.delete(key);
    else this.opened.add(key);
    keep("orcha.opened", this.opened);
    cx.notify();
  }

  // A control inside a draggable row: pressing it neither drags nor selects.
  noDrag(el) {
    const stop = (_e, cx) => cx.stop_propagation();
    return el.on_mouse_down("left", stop).on_mouse_up("left", stop);
  }

  fold(k, id, key, what) {
    const open = this.opened.has(key);
    return this.noDrag(
      div()
        .id(id)
        .flex_none()
        .p(3)
        .rounded(4)
        .cursor_pointer()
        .hover((s) => s.bg(k.hover))
        .tooltip(open ? `Hide ${what}` : `Show ${what}`)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.toggle(key, cx);
        })
        .child(icon(open ? "chevron-down" : "chevron-right", 13, k.dim)),
    );
  }

  // Which repo each folder is in (repos.js), all at once. `prune` drops
  // folders no space is in any more.
  readGit(keys, cx, prune = false) {
    const due = keys.filter((key) => !this.asking.has(key));
    for (const key of due) this.asking.add(key);
    cx.spawn(async (cx) => {
      const found = await Promise.all(due.map(readRepo));
      let changed = false;
      due.forEach((key, i) => {
        this.asking.delete(key);
        if (JSON.stringify(this.git[key] ?? null) !== JSON.stringify(found[i])) changed = true;
        this.git[key] = found[i];
      });
      if (prune) for (const key of Object.keys(this.git)) if (!keys.includes(key)) delete this.git[key];
      if (changed) cx.notify();
    });
  }

  // Drag a project onto another to move it there (same machine only), its
  // worktrees with it; a press and release on the same one runs `select`.
  drag(el, groups, gi, select) {
    const from = this.pressed;
    return el
      .relative()
      .when(from === gi && this.over !== gi, (e) => e.opacity(0.5))
      .when(from !== null && from !== gi && this.over === gi, (e) =>
        e.child(div().absolute().left(0).right(0).h(3).rounded(2).bg(tokens().pink).when(from < gi, (l) => l.bottom(-2)).when(from > gi, (l) => l.top(-2))),
      )
      .on_mouse_down("left", () => {
        this.pressed = gi;
        this.over = gi;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressed === null) return;
        const over = groups[this.pressed]?.machine === groups[gi].machine ? gi : null;
        if (this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const [start, over] = [this.pressed, this.over];
        this.pressed = this.over = null;
        if (start === gi) select();
        else if (start !== null && over === gi) moveGroup(groups, start, gi, spaces().map((s) => s.id));
        cx.notify();
      });
  }

  // How its agents are doing: needs you, running, else a dot each.
  // A server a shell runs shows its first port in front.
  state(k, x) {
    const rank = Math.max(0, ...x.mine.map((p) => RANK[p.status] ?? 0));
    const agent =
      rank === RANK.blocked
        ? pill(k, "needs you", k.red)
        : rank === RANK.working
          ? pill(k, "running", k.yellow)
          : x.agents.length
            ? h_flex().gap(3).children(x.agents.map((p) => dot(k, p.status ?? "idle", 8)))
            : null;
    const port = x.shells.map((p) => shellBusy(p, this.facts)?.ports[0]).find(Boolean);
    if (!port) return agent;
    return h_flex().gap(5).items_center().child(pill(k, `:${port}`, k.blue)).when(Boolean(agent), (el) => el.child(agent));
  }

  // A project's or a repo's top line: its tile (a click picks an icon), its
  // name, a line under it, how it is doing and its arrow.
  head(k, { id, target, active, sub, state, fold, menu }) {
    return h_flex()
      .id(id)
      .gap(10)
      .px(8)
      .py(6)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(!active, (el) => el.hover((s) => s.bg(k.hover)))
      .when(Boolean(menu), (el) => el.on_mouse_down("right", this.menu(menu)))
      .child(
        this.noDrag(
          div()
            .id(`tile-${id}`)
            .rounded(7)
            .hover((s) => s.opacity(0.8))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              openOverlay({ mod: "orcha", props: { part: "icon", target }, ...ICON_OVERLAY });
            })
            .child(projectTile(k, target.name, this.icons[target.folder])),
        ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().truncate().text_size(13.5).text_color(k.ink).when(active, (el) => el.font_black()).when(!active, (el) => el.font_semibold()).child(target.name))
          .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11.5).text_color(k.muted).child(sub))),
      )
      .when(Boolean(state), (el) => el.child(state))
      .child(this.fold(k, `fold-${id}`, ...fold));
  }

  // An open project or repo: a raised card, the yellow edge on the selected one.
  card(k, active, head, body) {
    const card = v_flex()
      .relative()
      .rounded(9)
      .border(2.5)
      .border_color(k.line)
      .bg(k.card)
      .overflow_hidden()
      .child(div().absolute().top(0).left(0).w(5).h_full().bg(active ? k.yellow : k.dim + "66"))
      .child(head.pl(12))
      .child(body);
    return raised(k, card, 4, 9);
  }

  // A space's agents as cards, then its shells as rows.
  paneList(k, x, byPane) {
    return v_flex()
      .gap(4)
      .children(x.agents.map((p) => this.agentCard(k, p, byPane.get(p.pane))))
      .children(x.shells.map((p) => this.shellRow(k, p)));
  }

  // A project in one folder: one row, or a card with its agents when open.
  project(k, space, byPane, groups, gi) {
    const x = this.index.get(space.id);
    const target = { id: space.id, folder: space.folder, name: space.name };
    const sub = [space.branch, x.agents.length ? plural(x.agents.length, "agent") : null].filter(Boolean).join(" · ");
    const head = this.drag(
      this.head(k, { id: `project-${space.id}`, target, active: space.active, sub, state: this.state(k, x), fold: [space.id, "its agents"], menu: { kind: "project", ...target } }),
      groups,
      gi,
      () => run("space.select", { id: space.id }),
    );
    return this.opened.has(space.id) ? this.card(k, space.active, head, this.paneList(k, x, byPane).pl(12).pr(6).pb(8)) : head;
  }

  // A checkout in a repo card: a branch line, how its agents are doing, and
  // its agents under it when opened.
  checkout(k, { space, info }, last, byPane) {
    const x = this.index.get(space.id);
    const label = space.branch || info.top.split("/").pop();
    const state = this.state(k, x);
    const row = h_flex()
      .id(`checkout-${space.id}`)
      .h(30)
      .px(6)
      .gap(7)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .border(space.active ? 2 : 0)
      .border_color(k.line)
      .when(space.active, (el) => el.bg(k.paper))
      .when(!space.active, (el) => el.hover((s) => s.bg(k.hover)))
      .on_click(() => run("space.select", { id: space.id }))
      .on_mouse_down("right", this.menu({ kind: "project", id: space.id, name: label, folder: space.folder, linked: info.linked }))
      .child(div().flex_none().text_size(12).text_color(k.dim).child(last ? "└" : "├"))
      .child(icon(info.linked ? "git-branch" : "git-fork", 13, info.linked ? k.muted : k.ink))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(k.ink).when(space.active, (el) => el.font_bold()).child(label))
      .when(!info.linked, (el) => el.child(div().flex_none().text_size(10).font_black().text_color(k.dim).child("MAIN")))
      .when(Boolean(state), (el) => el.child(state))
      .when(x.mine.length > 0, (el) => el.child(this.fold(k, `fold-checkout-${space.id}`, space.id, "its agents")));
    if (!this.opened.has(space.id) || !x.mine.length) return row;
    return v_flex().gap(4).child(row).child(this.paneList(k, x, byPane).pl(18));
  }

  // A repo with worktrees (like Orca): one card, the repo's tile and name on
  // top, then a line per checkout (the main one first) and + worktree.
  // Clicking the name shows the main checkout (opening it when only
  // worktrees are open).
  repo(k, g, byPane, groups, gi) {
    const main = g.members.find((m) => !m.info.linked)?.space ?? null;
    const lead = main ?? g.members[0].space;
    const target = { id: lead.id, folder: main?.folder ?? g.info.main, name: main?.name ?? g.info.main.split("/").pop() };
    const all = g.members.map((m) => this.index.get(m.space.id));
    const x = { mine: all.flatMap((y) => y.mine), agents: all.flatMap((y) => y.agents), shells: all.flatMap((y) => y.shells) };
    const trees = g.members.filter((m) => m.info.linked).length;
    const active = g.members.some((m) => m.space.active);
    const key = repoKey(g);
    const open = this.opened.has(key);
    const sub = [plural(trees, "worktree"), x.agents.length ? plural(x.agents.length, "agent") : null].filter(Boolean).join(" · ");
    const select = () => (main ? run("space.select", { id: main.id }) : run("space.new", { folder: g.info.main, machine: g.machine ?? "" }));
    const head = this.drag(
      this.head(k, { id: `repo-${lead.id}`, target, active, sub, state: open ? null : this.state(k, x), fold: [key, "its worktrees"], menu: main ? { kind: "project", ...target } : null }),
      groups,
      gi,
      select,
    );
    const add = h_flex()
      .id(`worktree-new-${lead.id}`)
      .h(26)
      .px(6)
      .gap(7)
      .items_center()
      .rounded(6)
      .text_size(11.5)
      .font_black()
      .text_color(k.muted)
      .cursor_pointer()
      .hover((s) => s.bg(k.hover).text_color(k.ink))
      .on_click(() => openWorktree(lead.id, "new", this.index.get(lead.id)?.cwd))
      .child(div().w(8))
      .child(icon("plus", 13))
      .child("worktree");
    if (!open) return this.card(k, active, head, div());
    return this.card(
      k,
      active,
      head,
      v_flex()
        .pl(14)
        .pr(6)
        .pb(8)
        .gap(3)
        .children(g.members.map((m, n) => this.checkout(k, m, n === g.members.length - 1, byPane)))
        .child(add),
    );
  }

  // A metro line of the four stations. The train runs on the leg between
  // the stop it reached and the next one: the rail behind it filled in ink,
  // a small engine in the agent's color chugging forward with puffs of
  // smoke behind, the next stop blinking. When the agent moves on, the rail
  // grows and the engine glides to the next leg. At DONE it parks under the
  // flag. Everything moves natively, no redraws from here.
  metro(k, at, color, key = "depot") {
    const pct = (x) => `${(x / 3) * 100}%`;
    const moving = at >= 0 && at < 3;
    const head = at >= 3 ? 3 : at + 0.5;
    const puff = (left, top, size, period) =>
      div().absolute().left(left).top(top).size(size).rounded(size / 2).bg(k.dim).loop("opacity", { from: 0, to: 0.8, period });
    const body = h_flex()
      .relative()
      .size_full()
      .justify_center()
      .items_center()
      .rounded(4)
      .border(2)
      .border_color(k.line)
      .bg(color)
      .child(icon("train-front", 9, k.chipText))
      .when(moving, (el) => el.loop("top", { from: 0, to: -1.5, period: 420 }));
    const engine = div()
      .absolute()
      .top(-6)
      .right(-11)
      .w(22)
      .h(15)
      .child(
        div()
          .relative()
          .size_full()
          .when(moving, (el) => el.loop("left", { from: -3, to: 2, period: 1400 }))
          .when(moving, (el) => el.child(puff(-7, 1, 5, 700)).child(puff(-13, -2, 4, 900)).child(puff(-18, -4, 3, 1100)))
          .child(body),
      );
    // DONE is a little checkered flag.
    const flag = (done) =>
      v_flex()
        .size(10)
        .rounded(2)
        .border(1.5)
        .border_color(k.line)
        .overflow_hidden()
        .children(
          [0, 1].map((r) =>
            h_flex()
              .flex_1()
              .children([0, 1].map((c) => div().flex_1().bg((r + c) % 2 ? (done ? color : k.card) : k.ink))),
          ),
        );
    return div()
      .relative()
      .flex_1()
      .h(22)
      .child(div().absolute().top(10).left(0).w_full().h(3).rounded(2).bg(k.dim + "66"))
      .children(
        [0, 1, 2, 3].map((i) => {
          const next = moving && i === at + 1;
          const base = div().absolute().top(6.5).left(pct(i)).ml(-5);
          if (i === 3) return base.child(flag(at >= 3)).when(next, (el) => el.loop("opacity", { from: 0.4, to: 1, period: 900 }));
          return base
            .size(10)
            .rounded(5)
            .border(2)
            .border_color(next ? color : k.line)
            .bg(i <= at ? k.ink : k.card)
            .when(next, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 900 }));
        }),
      )
      .when(at >= 0, (el) =>
        el.child(
          div()
            .id(`rail-${key}`)
            .absolute()
            .top(10)
            .left(0)
            .w(pct(head))
            .h(3)
            .rounded(2)
            .bg(k.ink)
            .transition("width", { duration: 900, easing: "ease-in-out" })
            .child(engine),
        ),
      );
  }

  // PROCESS (SPEC §3.1): a fixed card at the foot of the sidebar. Each running
  // agent is a train on its own line, labelled by its model, with its project
  // and what it works on under it.
  process(k, allPanes, list, byPane) {
    if (shared("orcha.process") === "off") return null;
    const running = allPanes.filter((p) => p.program?.agent && p.status === "working");
    const stations = this.facts.stations ?? {};
    const projectOf = new Map();
    if (running.length) for (const space of list) for (const p of this.index.get(space.id)?.agents ?? []) projectOf.set(p.pane, space.name);
    const lane = (pane) => {
      const color = agentColor(k, pane.program);
      const at = Math.max(0, STATIONS.indexOf(stations[pane.terminal] ?? "THINK"));
      const about = [projectOf.get(pane.pane), agentTitle(byPane.get(pane.pane), pane)].filter(Boolean).join(" · ");
      const line = h_flex()
        .gap(10)
        .items_center()
        .child(
          h_flex()
            .w(96)
            .flex_none()
            .h(24)
            .px(6)
            .gap(5)
            .items_center()
            .rounded(5)
            .border(2)
            .border_color(k.line)
            .bg(color)
            .child(programIcon(pane.program, 13, k.chipText) ?? icon("train-front", 13, k.chipText))
            .child(div().flex_1().truncate().text_size(10.5).font_black().text_color(k.chipText).child(modelOf(pane, this.facts).toUpperCase())),
        )
        .child(this.metro(k, at, color, pane.pane));
      return v_flex()
        .id(`train-${pane.pane}`)
        .gap(3)
        .cursor_pointer()
        .on_click(() => run("pane.focus", { pane: pane.pane }))
        .child(line)
        .when(Boolean(about), (el) => el.child(div().pl(2).truncate().text_size(10.5).text_color(k.muted).child(about)));
    };
    // Station names under the line: first at its start, last at its end.
    const labels = h_flex()
      .pl(106)
      .justify_between()
      .text_size(9)
      .font_black()
      .text_color(k.dim)
      .children(STATIONS.map((s) => div().child(s)));
    const body = running.length
      ? v_flex().gap(10).children(running.map(lane)).child(labels)
      : v_flex()
          .gap(6)
          .child(h_flex().gap(10).items_center().child(h_flex().w(96).flex_none().gap(5).items_center().child(icon("train-front", 15, k.dim)).child(div().text_size(10.5).font_black().text_color(k.dim).child("DEPOT"))).child(this.metro(k, -1, k.dim)))
          .child(labels)
          .child(div().pt(2).text_size(11.5).text_color(k.muted).child("No trains running. They leave the depot when an agent starts working."));
    const card = v_flex()
      .gap(10)
      .p(12)
      .rounded(9)
      .border(2.5)
      .border_color(k.line)
      .bg(k.card)
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .child(icon("train-front", 15, k.ink))
          .child(div().flex_1().text_size(12).font_black().text_color(k.ink).child("PROCESS"))
          .when(running.length > 0, (el) => el.child(pill(k, `${running.length} running`, k.yellow))),
      )
      .child(body);
    return div().px(2).pt(10).flex_none().child(raised(k, card, 4, 9));
  }

  render(cx) {
    const k = tokens();
    // An account was switched: read the panes' accounts now, and again once a
    // restarted Claude is up.
    const fuelRev = shared("orcha.fuelRev") ?? 0;
    if (fuelRev !== this.fuelRev) {
      if (this.fuelRev !== undefined) {
        this.readAccountsOf(cx);
        cx.timer.after(6000, (cx) => this.readAccountsOf(cx));
      }
      this.fuelRev = fuelRev;
    }
    const rev = shared("orcha.iconsRev") ?? 0;
    if (rev !== this.iconsRev) {
      this.iconsRev = rev;
      this.readIcons(cx);
    }
    const allPanes = panes();
    const byPane = new Map(agents().map((a) => [a.pane, a]));
    const list = spaces();
    // Read once per frame and passed down: each space's panes, the agents' facts.
    this.index = indexSpaces(list, allPanes);
    this.facts = agentFacts();
    const unread = new Set();
    for (const { key } of this.index.values()) if (!(key in this.git) && !this.asking.has(key)) unread.add(key);
    if (unread.size) this.readGit([...unread], cx);
    const groups = groupSpaces(list, this.index, this.git);
    this.openSelected(list, groups);
    const projects = groups.map((g, gi) => (isRepo(g) ? this.repo(k, g, byPane, groups, gi) : this.project(k, g.members[0].space, byPane, groups, gi)));
    const trains = this.process(k, allPanes, list, byPane);
    return v_flex()
      .id("orcha-left")
      .size_full()
      .px(10)
      .py(8)
      .bg(k.paper)
      .text_size(13)
      .child(this.top(k))
      .child(div().px(4).pb(6).text_size(11).font_black().text_color(k.dim).child(`PROJECTS · ${projects.length}`))
      .child(
        v_flex()
          .id("orcha-projects")
          .flex_1()
          .min_h(0)
          .gap(4)
          .overflow_y_scrollbar()
          // Let go anywhere else: no move.
          .on_mouse_up("left", (_e, cx) => {
            this.pressed = null;
            this.over = null;
            cx.notify();
          })
          .children(projects),
      )
      .when(Boolean(trains), (el) => el.child(trains));
  }
}
