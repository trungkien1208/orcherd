// Which orcha this is, whether GitHub has a newer one, and getting it.
// The header asks GitHub at start and every few hours (shared
// "orcha.update"), shows a pill when a newer release is out, and Settings ›
// orcha has the button. Updating runs that release's install.sh; Herdr then
// reloads the mods, so the new copy says it landed ("orcha.updating").

import { exec, shared, setShared, notify, readTextFile, appHome } from "herdr";
import { script } from "./paths.js";

/** Bumped at every release, before the tag. */
export const VERSION = "0.12.0";
export const REPO = "trungkien1208/orcherd";
const EVERY = 6 * 60 * 60 * 1000;

const parse = (v) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? "") ?? []).slice(1, 4).map(Number);

/** Whether version `a` is newer than `b` ("0.10.0" > "0.9.3"). */
export function newer(a, b) {
  const [x, y] = [parse(a), parse(b)];
  if (x.length < 3 || y.length < 3) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** What GitHub said last: { latest, url, notes, checked, error }. */
export const updateInfo = () => shared("orcha.update") ?? {};

/** A newer release, or null. Null too once it is installed and only waits
 *  for Herdr to restart (restartNeeded): installing it again changes nothing. */
export function available() {
  const u = updateInfo();
  if (!u.latest || !newer(u.latest, VERSION)) return null;
  const on = shared("orcha.installed");
  return on && !newer(u.latest, on) ? null : u;
}

/** The version installed on disk when it is newer than the one running:
 *  Herdr has to restart to load it. Else null. */
export function restartNeeded() {
  const on = shared("orcha.installed");
  return on && newer(on, VERSION) ? on : null;
}

/** Reads which version is installed on disk (a copy newer than this one
 *  lands there when Herdr does not reload it), into "orcha.installed". */
export async function readInstalled() {
  const text = await readTextFile(`${appHome()}/mods/orcha/version.js`).catch(() => null);
  const on = /export const VERSION = "([^"]+)"/.exec(text ?? "")?.[1] ?? null;
  if (on !== (shared("orcha.installed") ?? null)) setShared("orcha.installed", on);
  return on;
}

/** Quits Herdr and opens it again, so the installed copy loads. Agents keep running. */
export function restartHerdr() {
  return exec("/bin/sh", ["-c", `nohup /bin/sh '${script("restart-herdr.sh").replace(/'/g, "'\\''")}' now </dev/null >/dev/null 2>&1 &`]);
}

/** Asks GitHub for the newest release, unless it answered in the last few
 *  hours (`force`: now). A failed ask is tried again on the next one. */
export async function checkUpdate(force = false) {
  const before = updateInfo();
  await readInstalled();
  if (!force && before.checked && !before.error && Date.now() - before.checked < EVERY) return;
  setShared("orcha.update", { ...before, checking: true });
  try {
    // GitHub answers 403 to a request without a User-Agent.
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "orcherd" } });
    if (!r.ok) throw new Error(`GitHub said ${r.status}`);
    const rel = await r.json();
    setShared("orcha.update", { latest: rel.tag_name?.replace(/^v/, ""), url: rel.html_url, notes: rel.body ?? "", checked: Date.now() });
  } catch (err) {
    setShared("orcha.update", { ...before, checking: false, error: String(err?.message ?? err) });
  }
}

/** Installs release `version` with its own install.sh. Null, or why not.
 *  Herdr may reload the mods as they land, so this copy may not live to hear
 *  the end: the new one reports it (landed). When Herdr doesn't reload
 *  them, this one says a restart is needed (and install.sh asks in a dialog).
 *  Up to 10 minutes: exec stops a command after 30 s unless told otherwise,
 *  and a slow line takes longer than that to fetch a release. */
export async function runUpdate(version) {
  const tag = `v${version}`;
  setShared("orcha.updating", { to: version, at: Date.now() });
  const r = await exec("/bin/sh", ["-c", `curl -fsSL --retry 2 "https://raw.githubusercontent.com/${REPO}/${tag}/install.sh" | ORCHA_REF="${tag}" sh`], { timeout: 600000 }).catch((err) => ({ code: 1, stderr: String(err?.message ?? err) }));
  if (r.code === 0) {
    // "orcha.updating" stays: the copy that loads next says it landed.
    if (newer(await readInstalled(), VERSION)) notify({ title: `🐋 Orcherd ${version} is installed`, body: "Restart Herdr to load it: ⌘Q and open it again, or Restart Herdr in Settings › orcha. Your agents keep running.", level: "success", timeout: 20000 });
    return null;
  }
  setShared("orcha.updating", null);
  return (r.stderr || r.stdout || "no internet?").trim().split("\n").pop();
}

/** Run once by the header: the new copy says the update landed. */
export function landed() {
  const u = shared("orcha.updating");
  if (!u) return;
  if (!newer(u.to, VERSION)) {
    setShared("orcha.updating", null);
    notify({ title: `🐋 orcha ${VERSION} has landed`, body: "Restart Herdr once to finish: ⌘Q, then open it again so every part loads fresh. Your agents keep running.", level: "success", timeout: 15000 });
  } else if (Date.now() - u.at > 10 * 60 * 1000) {
    setShared("orcha.updating", null);
  }
}
