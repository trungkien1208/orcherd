// Orcherd on Windows, stage 0: what Herdr's mod runtime does on this PC.
// Not part of Orcherd. Copy this folder to <Herdr config>\mods\orcha-probe,
// then in Herdr: Ctrl+Shift+P → mod.open → orcha-probe. Click "Pick a folder",
// press Ctrl+Shift+O and Ctrl+Alt+F inside the dialog, then "Copy report"
// and send the text back. The report is also saved as orcha-probe.txt in
// Herdr's config folder.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, appHome, window, focused, spaces, readTextFile, writeTextFile, pickFolder, theme, props, closeOverlay } from "herdr";
import * as fs from "fs/promises";

// Each program is asked for its version the way Orcherd would start it: by bare name, no shell.
const PROGRAMS = [
  ["py", ["-3", "--version"]], ["python", ["--version"]], ["python3", ["--version"]],
  ["git", ["--version"]], ["rg", ["--version"]], ["curl", ["--version"]], ["curl.exe", ["--version"]],
  ["tar", ["--version"]], ["claude", ["--version"]], ["claude.cmd", ["--version"]], ["claude.exe", ["--version"]],
  ["codex", ["--version"]], ["codex.cmd", ["--version"]], ["cursor-agent", ["--version"]],
  ["code", ["--version"]], ["code.cmd", ["--version"]], ["cursor", ["--version"]], ["cursor.cmd", ["--version"]],
  ["powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]],
  ["pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]],
  ["sh", ["-c", "echo sh-ok"]], ["netstat", ["-ano", "-p", "tcp"]], ["explorer", ["/?"]],
];

const first = (text) => (text ?? "").trim().split(/\r?\n/)[0]?.slice(0, 100) ?? "";

export default class Probe extends View {
  init(_props, cx) {
    this.lines = [];
    this.keys = [];
    this.done = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      await this.run(cx);
      this.done = true;
      await this.save();
      cx.notify();
    });
  }

  say(cx, text) {
    this.lines.push(text);
    cx.notify();
  }

  async run(cx) {
    const w = window();
    this.say(cx, `platform: ${w?.platform}  titlebar: ${w?.titlebar}`);
    this.say(cx, `home(): ${home()}`);
    this.say(cx, `appHome(): ${appHome()}`);
    const f = focused();
    this.say(cx, `focused().cwd: ${f?.cwd}  terminal: ${f?.terminal}`);
    for (const s of spaces().slice(0, 3)) this.say(cx, `space "${s.name}" folder: ${s.folder}  machine: ${s.machine}`);

    this.say(cx, "");
    this.say(cx, "== exec by bare name");
    for (const [cmd, args] of PROGRAMS) {
      const t = Date.now();
      try {
        const r = await exec(cmd, args, { timeout: 15000 });
        const extra = cmd === "netstat" ? `${(r.stdout.match(/LISTENING/g) ?? []).length} LISTENING` : first(r.stdout) || first(r.stderr);
        this.say(cx, `${cmd}: code ${r.code} in ${Date.now() - t} ms: ${extra}`);
      } catch (e) {
        this.say(cx, `${cmd}: REJECTED in ${Date.now() - t} ms: ${first(String(e?.message ?? e))}`);
      }
    }

    this.say(cx, "");
    this.say(cx, "== process list timing");
    const t = Date.now();
    try {
      const r = await exec("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Csv -NoTypeInformation"], { timeout: 30000 });
      this.say(cx, `powershell Win32_Process: code ${r.code}, ${r.stdout.split("\n").length} lines, ${r.stdout.length} bytes, ${Date.now() - t} ms`);
      const herdr = r.stdout.split("\n").filter((l) => /herdr/i.test(l)).slice(0, 4);
      for (const l of herdr) this.say(cx, `  ${l.trim().slice(0, 200)}`);
    } catch (e) {
      this.say(cx, `powershell Win32_Process: REJECTED ${first(String(e?.message ?? e))}`);
    }

    this.say(cx, "");
    this.say(cx, "== files");
    const drive = /^[A-Za-z]:/.exec(home())?.[0] ?? "C:";
    for (const dir of [home(), `${drive}\\`, `${drive}/`]) {
      try {
        const names = await fs.readdir(dir);
        this.say(cx, `fs.readdir(${dir}): ${names.length} entries, e.g. ${names.slice(0, 3).join(", ")}`);
      } catch (e) {
        this.say(cx, `fs.readdir(${dir}): REJECTED ${first(String(e?.message ?? e))}`);
      }
    }
    for (const p of [`${home()}/.claude/.credentials.json`, `${home()}\\.claude\\.credentials.json`]) {
      const text = await readTextFile(p).catch((e) => `REJECTED ${e}`);
      this.say(cx, `readTextFile(${p}): ${text == null ? "null" : text.startsWith("REJECTED") ? first(text) : `${text.length} chars`}`);
    }
    const keys = await readTextFile(`${appHome()}/keys.json`).catch(() => null);
    this.say(cx, "keys.json:");
    this.say(cx, keys ?? "(none)");
  }

  report() {
    const keys = this.keys.length ? this.keys : ["(no keys pressed in the dialog)"];
    return [...this.lines, "", "== keys pressed in the dialog", ...keys, "", `pickFolder: ${this.picked ?? "(not tried)"}`].join("\n");
  }

  async save() {
    try {
      const path = `${appHome()}/orcha-probe.txt`;
      const old = await readTextFile(path).catch(() => null);
      await writeTextFile(path, this.report(), old);
      this.saved = path;
    } catch (e) {
      this.saved = `not saved: ${first(String(e?.message ?? e))}`;
    }
  }

  render(cx) {
    const t = theme();
    const button = (id, label, onClick) =>
      h_flex().id(id).h(28).px(12).items_center().rounded(6).bg(t.raised).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
    return v_flex()
      .id("probe")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props().overlay);
        this.keys.push(`key "${e.key}" modifiers ${JSON.stringify(e.modifiers)}`);
        cx.stop_propagation();
        cx.spawn(async (cx) => { await this.save(); cx.notify(); });
        cx.notify();
      })
      .size_full()
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_size(12)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(this.done ? "Orcherd probe: done" : "Orcherd probe: running…"))
        .child(button("pick", "Pick a folder", (_e, cx) => cx.spawn(async (cx) => {
          this.picked = (await pickFolder({ prompt: "Any folder" })) ?? "(cancelled)";
          await this.save();
          cx.notify();
        })))
        .child(button("copy", "Copy report", (_e, cx) => cx.write_to_clipboard(this.report()))))
      .child(div().text_color(t.dim).child(this.saved ? `Saved: ${this.saved}` : "Press Ctrl+Shift+O, Ctrl+Alt+F and Ctrl+, here, then Copy report."))
      .child(v_flex().id("lines").flex_1().min_h(0).overflow_y_scrollbar().text_color(t.muted).font_family("monospace")
        .children(this.report().split("\n").map((l, i) => div().id(`l${i}`).child(l || " "))));
  }
}
