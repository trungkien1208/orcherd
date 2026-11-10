// Links in what agents print: web addresses and file paths, found in a
// terminal's text, then opened the way orcha in the terminal opens a
// Ctrl+clicked path (file_paths.rs): a folder in the file manager; a picture,
// PDF, web page or other document in the system's app; code and text in the
// viewer beside your work, or in the editor when [orcha.open_with] says so
// for that file type ("system", "folder", "editor", "editor:<command>").
// Relative paths are the pane's, else the project's; a bare name is looked
// for in the project.

import { exec, window, home, hc } from "herdr";
import { readTable } from "./config.js";
import { openFile } from "./files.js";

// file_paths.rs opens_in_system_app.
const SYSTEM_APP = new Set(
  "png jpg jpeg gif webp bmp tif tiff ico heic avif pdf doc docx xls xlsx ppt pptx odt ods odp pages numbers key rtf epub html htm mp4 mov m4v avi mkv webm mp3 wav m4a aac flac ogg zip tar gz tgz 7z rar dmg pkg msi".split(" "),
);

const URL_RE = /\bhttps?:\/\/[^\s<>"'`|\]]+/g;
const PATH_RE = /^(~|\.{1,2})?\/?[\w@.+-]+(\/[\w@.+-]+)*\/?(:\d+){0,2}$/;
// One-letter extensions only for real ones (.c .h .m .r .s .v .d), so "e.g" is no file.
const HAS_EXT = /\.([A-Za-z][A-Za-z0-9]{1,7}|[chmrsvd])(:\d+){0,2}$/;
const NOT_A_PATH = /^\d+(\.\d+)*(:\d+)*$|^\.+$|@.*\./;

/** How much of a terminal's history is read for links (`hc read` gives only
 *  the screen by default). */
export const HISTORY_LINES = "3000";

/** A terminal's screen and recent history, as text. */
export async function readTerminal(address) {
  return (await hc(["read", "--lines", HISTORY_LINES, address])).stdout ?? "";
}

/** The newest Claude conversation in `cwd` (Claude keeps one folder of them
 *  per project; orcha links every account's to ~/.claude's), or null. */
export async function claudeTranscript(cwd) {
  const dir = `${home()}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}`;
  const r = await exec("sh", ["-c", 'ls -t "$1"/*.jsonl 2>/dev/null | head -n 1', "orcha", dir]);
  return r.stdout.trim() || null;
}

// [label](target) in what Claude wrote: a web address, or a path with an
// optional :line or #L line.
const MD_LINK = /\[([^\]\n]{1,120})\]\(([^)\s]+)\)/g;

/** Links Claude wrote in the latest part of its conversation in `cwd`, as
 *  markdown: the screen shows only their labels (terminal hyperlinks).
 *  Newest first, with { label }. */
export async function transcriptLinks(cwd, max = 200) {
  const file = cwd && (await claudeTranscript(cwd));
  if (!file) return [];
  const r = await exec("tail", ["-n", "400", file]);
  const out = [];
  const seen = new Set();
  const lines = r.stdout.split("\n").reverse();
  for (const line of lines) {
    if (!line.includes('"assistant"') || !line.includes("](")) continue;
    let text = "";
    try {
      const msg = JSON.parse(line).message;
      text = (Array.isArray(msg?.content) ? msg.content : []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    } catch {
      continue;
    }
    const found = [...text.matchAll(MD_LINK)];
    for (const [, label, target] of found) {
      if (seen.has(target) || out.length >= max) continue;
      seen.add(target);
      if (/^https?:\/\//.test(target)) out.push({ raw: target, label, url: true });
      else {
        const m = /^(.*?)(?:#L(\d+)|:(\d+))?(?:-L?\d+)?$/.exec(target);
        out.push({ raw: target, label, path: m[1], line: Number(m[2] ?? m[3]) || null });
      }
    }
  }
  return out;
}

// A printed path, or null: it has a slash or a file's extension, and is no
// number, version or email.
function asPath(token) {
  if (token.length < 3 || !PATH_RE.test(token) || NOT_A_PATH.test(token)) return null;
  if (!token.includes("/") && !HAS_EXT.test(token)) return null;
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(token);
  return { raw: token, path: m[1], line: m[2] ? Number(m[2]) : null };
}

const CUT_URL = /^[^\s<>"'`|\]│]+/;
const CUT_PATH = /^[\w@.+\-/~:]+/;

// Where the text of a table cell starts in the next row, for a cell holding
// column `at` of this row: a mark in front (⧉) can shift it from the row above.
function cellText(text, next, at) {
  const start = text.lastIndexOf("│", at) + 1;
  return start + /^\s*/.exec(next.slice(start))[0].length;
}

// Where a link cut at `end` of a row goes on, or null. The right edge of the
// terminal: at the start of the next row, past any indent. A full table cell:
// in the same column of the next row. Agents and tables wrap long links
// mid-word, so a link that stops at the very edge likely goes on.
function nextPart(rows, row, start, end, cols, pattern) {
  const next = rows[row + 1];
  if (next === undefined) return null;
  const after = rows[row].slice(end);
  const atEdge = cols && !after.trim() && end >= cols - 2;
  const inCell = /^ ?│/.test(after);
  if (!atEdge && !inCell) return null;
  const from = inCell ? cellText(rows[row], next, start) : /^[\s│>]*/.exec(next)[0].length;
  const part = pattern.exec(next.slice(from))?.[0];
  return part ? { row: row + 1, from, to: from + part.length } : null;
}

// Every link in the rows, joined across rows, with where each part is:
// [{ link, spans: [{ row, from, to }] }], top to bottom.
function findLinks(rows, cols) {
  const taken = rows.map((text) => text);
  const take = (span) => {
    const text = taken[span.row];
    taken[span.row] = text.slice(0, span.from) + " ".repeat(span.to - span.from) + text.slice(span.to);
  };
  const follow = (row, m, pattern) => {
    const spans = [{ row, from: m.index, to: m.index + m[0].length }];
    let raw = m[0];
    for (let part = nextPart(taken, row, m.index, spans[0].to, cols, pattern); part && spans.length < 8; ) {
      raw += rows[part.row].slice(part.from, part.to);
      spans.push(part);
      part = nextPart(taken, part.row, part.from, part.to, cols, pattern);
    }
    return { raw, spans };
  };
  const out = [];
  rows.forEach((_, row) => {
    for (const m of [...taken[row].matchAll(URL_RE)]) {
      const { raw, spans } = follow(row, m, CUT_URL);
      spans.forEach(take);
      out.push({ link: { raw: raw.replace(/[.,;:!?)]+$/, ""), url: true, cut: spans.length > 1, head: m[0] }, spans });
    }
    for (const m of [...taken[row].matchAll(/[\w@.+\-/~:]+/g)]) {
      const clean = m[0].replace(/^:+/, "").replace(/[.,;:]+$/, "");
      const alone = asPath(clean);
      // Only what already reads as a path goes on: a plain word at the edge
      // is followed by the next word, not by more of it.
      const { raw, spans } = alone && clean === m[0] ? follow(row, m, CUT_PATH) : { raw: clean, spans: [{ row, from: m.index, to: m.index + m[0].length }] };
      const link = asPath(raw.replace(/[.,;:]+$/, ""));
      if (!link) continue;
      spans.forEach(take);
      if (spans.length > 1) Object.assign(link, { cut: true, head: clean, alt: alone?.path });
      out.push({ link, spans });
    }
  });
  return out;
}

// Where a label Claude wrote is on the rows, wrapped or not: the spans of its
// words, or null. A wrapped label ends its row (or its table cell).
function labelSpans(rows, label) {
  const words = label.split(/\s+/);
  const fromRow = (row, rest, column) => {
    const text = rows[row];
    if (text === undefined) return null;
    const whole = rest.join(" ");
    const at = column ?? text.indexOf(whole);
    if (at >= 0 && text.startsWith(whole, at)) return [{ row, from: at, to: at + whole.length }];
    for (let n = rest.length - 1; n >= 1; n -= 1) {
      const part = rest.slice(0, n).join(" ");
      const from = column ?? text.indexOf(part);
      if (from < 0 || !text.startsWith(part, from)) continue;
      const to = from + part.length;
      if (text.slice(to).trim() && !/^\s*│/.test(text.slice(to))) continue;
      const next = rows[row + 1] ?? "";
      const inCell = /^\s*│/.test(text.slice(to));
      const onward = fromRow(row + 1, rest.slice(n), inCell ? cellText(text, next, from) : /^[\s│>]*/.exec(next)[0].length);
      if (onward) return [{ row, from, to }, ...onward];
    }
    return null;
  };
  for (let row = 0; row < rows.length; row += 1) {
    const spans = fromRow(row, words, null);
    if (spans) return spans;
  }
  return null;
}

/** The links on a terminal's screen and where: [{ link, row, from, to }], one
 *  entry per row a link is on. `written` are links Claude wrote, found by the
 *  label the screen shows. */
export function placeLinks(screen, cols, written = []) {
  const rows = screen.split("\n");
  const out = [];
  const place = (link, spans) => spans.forEach((span) => out.push({ link, ...span }));
  for (const { link, spans } of findLinks(rows, cols)) place(link, spans);
  for (const link of written) {
    const spans = link.label ? labelSpans(rows, link.label) : null;
    if (spans) place(link, spans);
  }
  return out;
}

/** The link at a cell of the screen, or null. One column of grace: a click
 *  lands on the edge of a character as easily as inside it. */
export function linkAt(placed, cell) {
  if (!cell) return null;
  return placed.find((p) => p.row === cell.row && cell.col >= p.from - 1 && cell.col <= p.to)?.link ?? null;
}

/** The links in `text`, newest (lowest on screen) first, each once:
 *  { raw, url } for a web address, { raw, path, line } for a file path.
 *  With `cols`, links cut at the right edge are joined. */
export function scanLinks(text, max = 300, cols = 0) {
  const seen = new Set();
  const out = [];
  for (const { link } of findLinks((text ?? "").split("\n"), cols).reverse()) {
    if (seen.has(link.raw)) continue;
    seen.add(link.raw);
    if (out.length < max) out.push(link);
  }
  return out;
}

/** Selected text as one link, or null: a selection across wrapped rows has
 *  their line breaks and indents in it. */
export function linkInSelection(text) {
  return scanLinks(text.replace(/\s*\n[\s│>]*/g, ""), 1)[0] ?? null;
}

/** A terminal's width in columns, or 0. */
export async function terminalCols(address) {
  try {
    return JSON.parse((await hc(["get", "--json", address])).stdout).cols ?? 0;
  } catch {
    return 0;
  }
}

// What Claude's conversation says in full: a link cut on the screen is the one
// there that starts the same. Surer than joining rows, which only guesses.
const WORDS_IN_JSON = /https?:\/\/[^\s<>"'`|\]\\)]+|[~.]{0,2}\/?[\w@.+-]+(?:\/[\w@.+-]+)+/g;

/** Cut links made whole from the Claude conversation in `cwd`, when it has them. */
export async function completeLinks(links, cwd) {
  if (!cwd || !links.some((l) => l.cut)) return links;
  const file = await claudeTranscript(cwd);
  if (!file) return links;
  const known = new Set((await exec("tail", ["-c", "2000000", file])).stdout.match(WORDS_IN_JSON) ?? []);
  const whole = (link) => {
    if (!link.cut || known.has(link.url ? link.raw : link.path)) return link;
    let best = null;
    for (const word of known) {
      if (word.startsWith(link.head) && word.length > link.head.length && (!best || word.length > best.length)) best = word;
    }
    if (!best) return link;
    return link.url ? { ...link, raw: best } : { ...link, raw: best, path: best, line: null };
  };
  return links.map(whole);
}

// Finds a printed path: as written, in the pane's folder, in the project,
// else a file of that name (or ending in that path) in the project.
const RESOLVE = `
p=$1; cwd=$2; root=$3
case $p in "~"*) p="$HOME\${p#\\~}";; esac
hit() { if [ -d "$1" ]; then echo "d $1"; exit 0; elif [ -e "$1" ]; then echo "f $1"; exit 0; fi; }
case $p in /*) hit "$p";; *) hit "$cwd/$p"; [ -n "$root" ] && hit "$root/$p";; esac
[ -n "$root" ] || exit 1
p=\${p#./}
if command -v rg >/dev/null 2>&1; then f=$(cd "$root" && rg --files --hidden -g '!.git' -g "**/$p" 2>/dev/null | head -n 1)
else f=$(cd "$root" && find . -path "*/$p" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -n 1); fi
[ -n "$f" ] && hit "$root/\${f#./}"
exit 1`;

/** Where a printed path is: { path, dir } or null. */
async function resolvePath(raw, cwd, root, on) {
  const r = await exec("sh", ["-c", RESOLVE, "orcha", raw, cwd ?? "", root ?? ""], { on });
  const m = /^([df]) (.+)$/.exec(r.stdout.trim());
  return r.code === 0 && m ? { dir: m[1] === "d", path: m[2] } : null;
}

/** Hands `target` (a path or a web address) to the system's app for it. */
export function systemOpen(target, reveal = false) {
  const platform = window()?.platform;
  if (platform === "macos") return exec("open", reveal ? ["-R", target] : [target]);
  if (platform === "windows") return exec("explorer", [reveal ? `/select,${target}` : target]);
  return exec("xdg-open", [reveal ? target.replace(/\/[^/]*$/, "") : target]);
}

// The editor at a line (platform/macos.rs OrchaOpenTarget::File), or the
// person's own command with {path}, $P and $L. `folder`: a folder, opened as
// it is (no line).
export function openInEditor(path, line, command, folder = false) {
  const script = command
    ? command.replace(/\{path\}/g, '"$P"')
    : folder
      ? 'for c in cursor code zed; do command -v "$c" >/dev/null 2>&1 && exec "$c" "$P"; done; open "$P"'
    : 'for c in cursor code; do command -v "$c" >/dev/null 2>&1 && exec "$c" -g "$P:$L"; done; command -v zed >/dev/null 2>&1 && exec zed "$P:$L"; open "$P"';
  return exec("sh", ["-c", `P="$1" L="$2"; ${script}`, "orcha", path, String(line ?? 1)]);
}

/** Opens a link: a web address in the browser, a path the way its type and
 *  [orcha.open_with] say. Null, or why it could not. */
export async function openLink(link, { cwd, root, on }) {
  if (link.url) {
    systemOpen(link.raw);
    return null;
  }
  // A link joined across rows may have taken a word that is not part of it.
  const found = (await resolvePath(link.path, cwd, root, on)) ?? (link.alt ? await resolvePath(link.alt, cwd, root, on) : null);
  if (!found) return `can't find ${link.path}`;
  const slash = found.path.lastIndexOf("/");
  const viewer = () => openFile(found.path.slice(0, slash) || "/", found.path.slice(slash + 1), on, null, link.line);
  // Another machine's files: only the viewer can show them here.
  if (on) return found.dir ? `${link.path} is a folder on ${on}` : (viewer(), null);
  if (found.dir) {
    systemOpen(found.path);
    return null;
  }
  const ext = /\.([A-Za-z0-9]+)$/.exec(found.path)?.[1]?.toLowerCase() ?? "";
  const choice = (await readTable("orcha.open_with"))[ext] ?? (SYSTEM_APP.has(ext) ? "system" : "viewer");
  if (choice === "system") systemOpen(found.path);
  else if (choice === "folder") systemOpen(found.path, true);
  else if (choice === "editor") openInEditor(found.path, link.line);
  else if (typeof choice === "string" && choice.startsWith("editor:")) openInEditor(found.path, link.line, choice.slice(7));
  else viewer();
  return null;
}
