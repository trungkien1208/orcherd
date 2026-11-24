// A project's working rules and skills, for Settings › Projects (settings.js)
// and PROJECT SETUP (setup.js): the rules block in CLAUDE.md, the skills
// installed, and which projects were already asked about them.

import { exec, home, readTextFile, writeTextFile } from "herdr";
import { RULES, SKILLS } from "./catalog.js";
import { readTable, writeKey } from "./config.js";
import { configFile, makeConfigDir } from "./paths.js";

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

/** The ids of the rules `text` has in its block. */
export function rulesIn(text) {
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

// CLAUDE.md, unless the project keeps its rules in AGENTS.md (CLAUDE.md
// missing, or only pointing there): orcha_rules.rs instruction_file.
async function instructionFile(folder) {
  const claude = `${folder}/CLAUDE.md`;
  const agents = `${folder}/AGENTS.md`;
  const agentsText = await readTextFile(agents);
  if (agentsText != null) {
    const claudeText = await readTextFile(claude);
    if (claudeText == null || claudeText.includes("AGENTS.md")) return { path: agents, text: agentsText };
  }
  return { path: claude, text: (await readTextFile(claude)) ?? "" };
}

/** What `folder` has: { folder, file: { path, text }, rules: [id], installed: { skill name: { project, global } } }. */
export async function readProject(folder) {
  const file = await instructionFile(folder);
  const installed = {};
  for (const skill of SKILLS) {
    const first = skill.skills[0];
    installed[skill.name] = {
      project: (await readTextFile(`${folder}/.claude/skills/${first}/SKILL.md`)) != null,
      global: (await readTextFile(`${home()}/.claude/skills/${first}/SKILL.md`)) != null,
    };
  }
  return { folder, file, rules: rulesIn(file.text), installed };
}

/** Sets the managed block of the file at `path` to `ids`; the file's new
 *  text. Throws when the file changed while it was being written. */
export async function writeRules(path, ids) {
  const raw = await readTextFile(path);
  const before = raw ?? "";
  const after = withRules(before, ids);
  if (after !== before) await writeTextFile(path, after, raw);
  return after;
}

/** `npx skills add` in `folder`, or for the user (`global`): orcha_rules.rs
 *  install_skill. Without Node (or when npx fails) the skill folders come
 *  straight from GitHub. { ok }, or { ok: false, error, command }: the
 *  command to run by hand in a terminal. */
export async function installSkill(skill, folder, global) {
  const args = skillArgs(skill, global);
  // An app opened from the Dock has no shell PATH, and nvm, fnm and the
  // like set it up in .zshrc, which only an interactive shell reads.
  // Its input is /dev/null, so nothing in .zshrc can wait on a question.
  let r = await exec("/bin/sh", ["-c", `exec /bin/zsh -lic 'exec npx "$@"' npx "$@" </dev/null`, "sh", ...args], { cwd: folder });
  if (r.code !== 0) {
    const dest = global ? `${home()}/.claude/skills` : `${folder}/.claude/skills`;
    r = await exec("/bin/zsh", ["-c", FROM_GITHUB, "zsh", skill.source, dest, ...skill.skills], { cwd: folder });
  }
  if (r.code === 0) return { ok: true };
  const cd = global ? "" : `cd '${folder.replaceAll("'", "'\\''")}' && `;
  return { ok: false, error: (r.stderr || r.stdout || "no internet?").trim().split("\n").pop(), command: `${cd}npx ${args.join(" ")}` };
}

// Asking on a new project ------------------------------------------------

// The folders PROJECT SETUP was shown for: each is asked once.
const ASKED = () => configFile("project-setup.json");

async function readAsked() {
  const raw = await readTextFile(ASKED());
  try {
    const list = JSON.parse(raw ?? "[]");
    return { raw, list: Array.isArray(list) ? list : [] };
  } catch {
    return { raw, list: [] };
  }
}

/** Whether PROJECT SETUP was already shown for `folder`. */
export const wasAsked = async (folder) => (await readAsked()).list.includes(folder);

/** Remembers that `folders` were asked (or told where the rules are). */
export async function markAsked(folders) {
  const { raw, list } = await readAsked();
  const next = [...new Set([...list, ...folders])];
  if (next.length === list.length) return;
  try {
    await makeConfigDir();
    await writeTextFile(ASKED(), `${JSON.stringify(next, null, 2)}\n`, raw);
  } catch {
    // written by another window meanwhile: at worst the project is asked again
  }
}

/** Whether a new project opens PROJECT SETUP ([orcha] ask_setup, on unless set to false). */
export const asksSetup = async () => (await readTable("orcha")).ask_setup !== false;

/** Turns that on or off. Null, or why it failed. */
export const setAsksSetup = (on) => writeKey("orcha", "ask_setup", on);
