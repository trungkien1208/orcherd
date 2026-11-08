// Which orcha this is, whether GitHub has a newer one, and getting it.
// The header asks GitHub at start and every few hours (shared
// "orcha.update"), shows a pill when a newer release is out, and Settings ›
// orcha has the button. Updating runs that release's install.sh; Herdr then
// reloads the mods, so the new copy says it landed ("orcha.updating").

import { exec, shared, setShared, notify } from "herdr";

/** Bumped at every release, before the tag. */
export const VERSION = "0.7.0";
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

/** A newer release, or null. */
export function available() {
  const u = updateInfo();
  return u.latest && newer(u.latest, VERSION) ? u : null;
}

/** Asks GitHub for the newest release, unless it answered in the last few
 *  hours (`force`: now). A failed ask is tried again on the next one. */
export async function checkUpdate(force = false) {
  const before = updateInfo();
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
 *  Herdr reloads the mods as they land, so this copy may not live to hear
 *  the end: the new one reports it (landed). */
export async function runUpdate(version) {
  const tag = `v${version}`;
  setShared("orcha.updating", { to: version, at: Date.now() });
  const r = await exec("/bin/sh", ["-c", `curl -fsSL "https://raw.githubusercontent.com/${REPO}/${tag}/install.sh" | ORCHA_REF="${tag}" sh`]);
  if (r.code === 0) return null;
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
