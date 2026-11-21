// CREW (right panel): the subagents of the Claude chat in front of you, read
// from the files Claude Code writes for each one, beside the chat's own:
// ~/.claude/projects/<folder>/<session>/subagents/agent-<id>.jsonl (what it
// did) and agent-<id>.meta.json ({ description, agentType, finished, … }).
// bin/crew.py reads them; nothing runs inside Claude, and every account
// folder links ~/.claude/projects. A click on one opens CrewDetail: its
// brief, each tool it called and its report.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, props, closeOverlay, openOverlay } from "herdr";
import { paneSession } from "./accounts-data.js";
import { script } from "./paths.js";
import { tokens, chip, icon, modelLabel, tokensShort, readable } from "./ui.js";

const projectDir = (cwd) => `${home()}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}`;
const subagents = (chat) => `${projectDir(chat.cwd)}/${chat.id}/subagents`;

/** The chat a Claude pane runs: { id, cwd }. Its pid's session file (a
 *  resumed chat keeps its first id there, the one its subagents go under),
 *  else the folder's subagents written last. Null when neither says. */
export async function crewChat(terminal, cwd) {
  const chat = terminal ? await paneSession(terminal, null) : null;
  if (chat) return { id: chat.id, cwd: chat.cwd ?? cwd };
  if (!cwd) return null;
  const r = await exec("sh", ["-c", 'ls -td -- "$1"/*/subagents 2>/dev/null | head -n 1', "sh", projectDir(cwd)]);
  const id = /([0-9a-f]{8}-[0-9a-f-]{27})\/subagents$/.exec(r.stdout.trim())?.[1];
  return id ? { id, cwd } : null;
}

async function crewPy(args) {
  const r = await exec("python3", ["-I", script("crew.py"), ...args]).catch(() => null);
  if (r?.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** The subagents of chat `chat` ({ id, cwd }) running now or finished in the
 *  last 5 minutes, each followed by its own helpers (bin/crew.py). */
export async function readCrew(chat) {
  return (await crewPy([subagents(chat)])) ?? [];
}

/** Opens one subagent's details over the window. */
export function openCrewDetail(chat, id) {
  openOverlay({ mod: "orcha", props: { part: "crew", file: `${subagents(chat)}/${id}.jsonl` }, kind: "dialog", width: 620, height: 560, frame: "none" });
}

// Each kind of subagent its face in CrewDetail's header; any other kind is a robot.
const FACES = { Explore: "🔍", Plan: "📐", "general-purpose": "🛠️", fork: "🍴", "claude-code-guide": "📘", "statusline-setup": "⚙️" };
const faceOf = (type) => FACES[type] ?? (/review/i.test(type ?? "") ? "🧐" : /web|fetch/i.test(type ?? "") ? "🌐" : "🤖");

/** Opus pink, Sonnet blue, Haiku teal, Fable yellow, anything else green. */
export const modelColor = (k, id) => (/opus/.test(id ?? "") ? k.pink : /sonnet/.test(id ?? "") ? k.blue : /haiku/.test(id ?? "") ? k.teal : /fable/.test(id ?? "") ? k.yellow : k.green);

// A tool as what it does: [icon, verb, how its target reads].
const VERBS = {
  Read: ["📖", "Reading"], Write: ["✍️", "Writing"], Edit: ["✏️", "Editing"], MultiEdit: ["✏️", "Editing"], NotebookEdit: ["✏️", "Editing"],
  Bash: ["▶️", "Running"], Grep: ["🔎", "Searching", (s) => `“${s}”`], Glob: ["🔎", "Finding", (s) => s], WebFetch: ["🌐", "Opening"],
  WebSearch: ["🌐", "Searching the web for", (s) => `“${s}”`], Agent: ["🤝", "Starting helper"], Task: ["🤝", "Starting helper"],
  TodoWrite: ["📋", "Updating its plan", () => ""], Skill: ["🧰", "Using skill"], ToolSearch: ["🧰", "Loading tools", () => ""],
  SubagentHandback: ["📨", "Reporting back", () => ""],
};

/** What a subagent does now: { icon, verb, what }, 📖 "Reading" "src/app.js". */
export function activity(a) {
  if (!a.tool) return { icon: "💭", verb: "Thinking…", what: "" };
  const [icon, verb, how] = VERBS[a.tool] ?? ["🛠️", `Using ${a.tool}`];
  return { icon, verb, what: how ? how(a.doing ?? "") : a.doing ?? "" };
}

/** "≈$0.12", "<$0.01". */
const money = (usd) => (usd >= 0.01 ? `≈$${usd.toFixed(2)}` : "<$0.01");

/** "0:41", "12:05", "1:02:09". */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** One subagent in full (props.file: its agent-<id>.jsonl), read again every
 *  2 s while it runs, so its calls come in live. */
export default class CrewDetail {
  constructor(cx) {
    this.file = props()?.file;
    this.agent = null;
    this.failed = false;
    this.briefOpen = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    this.read(cx);
    cx.timer.every(2000, (cx) => {
      if (this.agent?.status === "running") this.read(cx);
    });
  }

  read(cx) {
    cx.spawn(async (cx) => {
      const a = this.file ? await crewPy(["detail", this.file]) : null;
      if (a) this.agent = a;
      this.failed = !a && !this.agent;
      cx.notify();
    });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  render(_cx) {
    const k = tokens();
    const a = this.agent;
    const dim = (text) => div().text_size(11.5).text_color(k.dim).child(text);
    const framed = (el) => el.border(1.5).border_color(k.line);
    const heading = (text) => div().pt(6).text_size(10.5).font_black().text_color(k.muted).child(text);
    const time = (at) => (at ? new Date(at).toTimeString().slice(0, 8) : "");
    const head = v_flex()
      .flex_none()
      .px(14)
      .py(10)
      .gap(6)
      .bg(k.card)
      .border_b(2.5)
      .border_color(k.line)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().text_size(18).child(a ? faceOf(a.type) : "👥"))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(div().truncate().text_size(13.5).font_black().text_color(k.ink).child(a?.title ?? "Subagent"))
              .child(dim(a ? [a.type, a.effort && `${a.effort} effort`].filter(Boolean).join(" · ") : "")),
          )
          .child(
            div()
              .id("crew-close")
              .flex_none()
              .cursor_pointer()
              .on_click(() => this.close())
              .child(icon("x", 15, k.dim)),
          ),
      )
      .when(Boolean(a), (el) =>
        el.child(
          h_flex()
            .gap(6)
            .items_center()
            .child(framed(chip(k, a.status === "running" ? "RUNNING" : "DONE", a.status === "running" ? k.yellow : k.green)))
            .when(Boolean(a.model), (el) => el.child(framed(chip(k, modelLabel(a.model).toUpperCase(), modelColor(k, a.model)))))
            .child(div().flex_1())
            .child(dim([a.start && a.last ? clock((a.status === "running" ? Date.now() : a.last) - a.start) : null, `${a.tools} tools`, `${tokensShort(a.tokens)} tok`, money(a.cost)].filter(Boolean).join(" · "))),
        ),
      );
    const rows = [];
    if (!a) rows.push(dim(this.failed ? "Couldn't read this subagent: its files are gone, or python3 is missing." : "Reading…"));
    else {
      if (a.brief) {
        const long = a.brief.length > 280;
        rows.push(
          heading("BRIEF"),
          div()
              .id("crew-brief")
              .text_size(12)
              .line_height("17px")
              .text_color(k.foreground)
              .when(long, (el) => el.cursor_pointer().on_click((_e, cx) => {
                this.briefOpen = !this.briefOpen;
                cx.notify();
              }))
              .child(long && !this.briefOpen ? `${a.brief.slice(0, 280).trimEnd()}… (more)` : a.brief),
        );
      }
      rows.push(heading(`WHAT IT DID · ${a.calls.length + a.skipped}`));
      if (a.skipped) rows.push(dim(`${a.skipped} earlier calls not shown`));
      if (!a.calls.length) rows.push(dim(a.status === "running" ? "Thinking…" : "No tools called."));
      for (const c of a.calls) {
        rows.push(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().w(56).flex_none().text_size(10.5).text_color(k.dim).child(time(c.at)))
            .child(div().w(16).flex_none().text_size(11).child(c.failed ? "❌" : activity({ tool: c.tool }).icon))
            .child(div().w(80).flex_none().truncate().text_size(11.5).font_bold().text_color(c.failed ? readable(k, k.red) : k.ink).child(c.tool))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(k.muted).child(c.what || "")),
        );
      }
      if (a.report) {
        rows.push(
          heading(a.status === "running" ? "LAST SAID" : "REPORT"),
          div().p(8).rounded(5).border(1.5).border_color(k.line).bg(k.card).text_size(12).line_height("17px").text_color(k.foreground).child(a.report),
        );
      }
    }
    const body = v_flex().id("crew-body").flex_1().min_h(0).px(14).py(8).gap(4).overflow_y_scrollbar().text_size(12).children(rows);
    return v_flex()
      .id("orcha-crew")
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") this.close();
      })
      .w(610)
      .h(550)
      .rounded(8)
      .border(3)
      .border_color(k.line)
      .bg(k.paper)
      .overflow_hidden()
      .child(head)
      .child(body);
  }
}
