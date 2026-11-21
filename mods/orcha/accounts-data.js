// Orcherd's accounts and their fuel, read from its own files (config.json
// and the limits cache, see paths.js), and what can be done with them: use
// one, add one, hand a chat to one. Shared by ACCOUNTS, Settings › Accounts,
// Settings › Hand-off and the low-fuel watch in the right panel.
//
// Fuel, signing in and switching go through bin/accounts.py, which ships
// with this mod: the Keychain and the account folders stay in one place.

import { readTextFile, writeTextFile, exec, hc, home, run, focused, agents, panes, spaces, notify, updates } from "herdr";
import { agentTitle, expandHome } from "./ui.js";
import { readTable, writeKey } from "./config.js";
import { configFile, cacheFile, script, makeConfigDir } from "./paths.js";
import { claudeTranscript, readTerminal } from "./links.js";

const LIMITS = () => script("accounts.py");
const CONFIG = () => configFile("config.json");

async function readJson(path) {
  try {
    const text = await readTextFile(path);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const lastLine = (r, fallback) => (r.stderr || r.stdout || fallback).trim().split("\n").pop();
const pause = (seconds) => exec("sleep", [String(seconds)]);

// The default account (Settings › Make default) is kept apart from the one in
// the main folder now (claude-active): chats on the main folder can borrow
// another account without a restart, and the default stays what it was.
const DEFAULT_FILE = () => configFile("claude-default");

/** Every account with its cached limits, the Claude account in the main
 *  folder now (`active`) and the default one (`main`, the same unless the
 *  main folder's chats are borrowing). */
export async function readAccounts() {
  const [config, activeFile, defaultFile] = await Promise.all([readJson(CONFIG()), readTextFile(configFile("claude-active")), readTextFile(DEFAULT_FILE())]);
  const local = (config?.accounts ?? []).filter((a) => a?.id);
  const known = (id) => (local.some((a) => a.id === id) ? id : null);
  // As accounts.py has it: until an account is put in the main folder, the
  // one that lives there (no folder of its own) is in it.
  const active = known(activeFile?.trim()) ?? local.find((a) => a.kind === "claude" && !a.dir)?.id ?? null;
  const main = known(defaultFile?.trim()) ?? active;
  const list = await Promise.all(
    local.map(async (account) => {
      const cache = cacheFile(`limits/${account.id}`);
      const [limits, token] = await Promise.all([readJson(`${cache}.json`), readJson(`${cache}.token.json`)]);
      return { ...account, limits: limits ?? {}, token };
    }),
  );
  list.push(...(await readStationAccounts(list)));
  return { list, active, main };
}

// Token Station ----------------------------------------------------------
// Hub accounts (bin/tokenstation.py, repo token-station) show beside the
// local ones once this Mac is paired. Before that none of this runs: no
// file, no network, every path below as it always was.

const STATION = () => script("tokenstation.py");
const STATION_DIR = () => `${home()}/.config/orcherd/station/`;
/** A hub account (source "station"), not one signed in on this Mac. */
export const isStation = (a) => a?.source === "station";
const stationIdOf = (folder) => folder.slice(STATION_DIR().length).split("/")[0];
/** The same Claude account (one fuel), by email: a hub and a local one can be. */
export const sameClaude = (a, b) => Boolean(a?.email) && a.email.toLowerCase() === (b?.email ?? "").toLowerCase();

async function stationLinked() {
  return Boolean(await readJson(configFile("station.json")));
}

/** The hub's accounts from tokenstation.py's cache, shaped like local ones.
 *  `why`: why a pane can't start on it now (null when it can). */
async function readStationAccounts(local) {
  const link = await readJson(configFile("station.json"));
  if (!link) return [];
  const cache = (await readJson(cacheFile("station.json"))) ?? {};
  const hub = cache.hub_name ?? link.hub_name ?? "hub";
  return (cache.accounts ?? []).map((h) => {
    const twin = local.find((a) => a.kind === "claude" && sameClaude(a, h));
    const why = cache.error
      ?? (!h.enabled ? "disabled on the hub"
        : h.needs_renew ? "needs renew on the hub"
        : !cache.grant?.open ? "the hub's day isn't started"
        : h.max_leases != null && h.live_leases >= h.max_leases ? `lease limit reached (${h.live_leases}/${h.max_leases})`
        : null);
    const note = `tokenstation@${hub}${twin ? ` · same Claude account as ${twin.label ?? twin.id}` : ""}`;
    return {
      id: `station-${h.id}`, stationId: String(h.id), kind: "claude", source: "station", hub,
      label: h.label, email: h.email ?? "", dir: `~/.config/orcherd/station/${h.id}`,
      limits: { ...(h.fuel ?? {}), note }, token: null, why,
    };
  });
}

/** tokenstation.py status: { paired, url, hub_name, check, synced_at, error, grant }. */
export async function stationStatus() {
  const r = await exec("python3", ["-I", STATION(), "status"]);
  try {
    return r.code === 0 ? JSON.parse(r.stdout) : { paired: false };
  } catch {
    return { paired: false };
  }
}

/** The cert a hub shows now: { url, pin, check }, or { error }. */
export async function stationProbe(url) {
  const r = await exec("python3", ["-I", STATION(), "probe", url]);
  try {
    return r.code === 0 ? JSON.parse(r.stdout) : { error: lastLine(r, "No answer from the hub.") };
  } catch {
    return { error: "The hub's answer could not be read." };
  }
}

/** Pairs this Mac. The code goes through a file in ~/.cache/orcherd (0700),
 *  which the script deletes: never argv. Null, or why it failed. */
export async function stationPair(url, code, pin) {
  await exec("mkdir", ["-p", "-m", "700", cacheFile("")]);
  const file = cacheFile(`station-pair-${Date.now()}.json`);
  try {
    await writeTextFile(file, JSON.stringify({ url, code, pin }), null);
  } catch {
    return "Could not write to ~/.cache/orcherd.";
  }
  const r = await exec("python3", ["-I", STATION(), "pair", file]);
  return r.code === 0 ? null : lastLine(r, "tokenstation.py failed");
}

/** Unpairs this Mac (the hub accounts' folders and their chats stay). */
export async function stationForget() {
  const r = await exec("python3", ["-I", STATION(), "forget"]);
  return r.code === 0 ? null : lastLine(r, "Could not unpair this Mac.");
}

/** Move a paired Mac to another address of the same pinned hub. */
export async function stationAddress(url) {
  const r = await exec("python3", ["-I", STATION(), "address", url]);
  return r.code === 0 ? null : lastLine(r, "Could not change the hub address.");
}

const span = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** A Claude account's sign-in as accounts.py last saw it (its .token.json):
 *  { signIn, idle, text }, or null when not known (not Claude, not read yet).
 *  The access token runs out every few hours and Claude renews it with the
 *  refresh token on the next chat, so only a missing sign-in asks to sign in. */
export function tokenState(a) {
  const tk = a.kind === "claude" ? a.token : null;
  if (!tk) return null;
  if (!tk.refresh) return { signIn: true, idle: false, text: "🔑 not signed in" };
  const left = tk.expires - Date.now();
  return left > 0
    ? { signIn: false, idle: false, text: `🔑 token good for ${span(left)} · renews itself` }
    : { signIn: false, idle: true, text: `🔑 token ran out ${span(-left)} ago · renews on the next chat` };
}

/** Whether to offer SIGN IN: the sign-in is missing, or (no token known) no fuel could be read. */
export const needsSignIn = (a, gauges) => (isStation(a) ? false : tokenState(a)?.signIn ?? !gauges.length);

/** Puts `id` in the main folder: every chat there moves to it within half a
 *  minute, without a restart. Null, or why it failed. */
async function activateAccount(id) {
  const r = await exec("python3", ["-I", LIMITS(), "activate", id]);
  return r.code === 0 ? null : lastLine(r, "accounts.py failed");
}

/** Settings › Make default: new chats start on `id`, and so do the ones on
 *  the main folder (no longer borrowing). Null, or why it failed. */
export async function makeDefault(id) {
  if (id.startsWith("station-")) return "A hub account can't be the default: the default lives in ~/.claude's sign-in, and a hub account has none here.";
  const failed = await activateAccount(id);
  if (failed) return failed;
  try {
    await writeTextFile(DEFAULT_FILE(), `${id}\n`, await readTextFile(DEFAULT_FILE()));
  } catch {
    return "The default was not saved. Try again.";
  }
  return null;
}

// The Keychain ---------------------------------------------------------
// Claude keeps its sign-in in the macOS Keychain, else (locked, broken, a
// managed Mac) in a .credentials.json in its folder. Fuel reads either;
// moving a chat to another account writes the Keychain, so it needs it.

/** { state: ok | file-only | locked | broken, why, files }, or null when
 *  accounts.py could not say (then nothing is shown). */
export async function readKeychain() {
  const r = await exec("python3", ["-I", LIMITS(), "keychain"]);
  try {
    return r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

/** Why the Keychain stops a chat from moving to another account, or null. */
export function keychainBlocks(kc) {
  if (!kc || kc.state === "ok") return null;
  if (kc.state === "file-only") return "Claude keeps its sign-in in a file, not the Keychain, so the chat would not see the switch. Move it to the Keychain first (the top of ACCOUNTS).";
  return "The macOS Keychain can't be written, so the sign-in can't move. The top of ACCOUNTS shows how to fix it.";
}

/** The sign-ins Claude left in .credentials.json go into the Keychain. Null, or why not. */
export async function moveToKeychain() {
  const r = await exec("python3", ["-I", LIMITS(), "keychain-move"]);
  return r.code === 0 ? null : lastLine(r, "accounts.py failed");
}

/** A pane beside the focused one asks for the Mac's password and unlocks the Keychain. */
export function unlockKeychain() {
  const script = 'security unlock-keychain && echo "\nUnlocked. Back in ACCOUNTS, press r." || echo "\nNot unlocked."; printf "Enter closes this pane. "; read -r _';
  run("pane.split", { direction: "right", argv: ["sh", "-c", script] });
}

/** Keychain Access, where a broken login keychain is reset. */
export function openKeychainAccess() {
  return exec("open", ["-a", "Keychain Access"]);
}

// What switching needs, and a report for an AI agent ------------------
// accounts.py doctor / diagnose / log. Settings › Accounts shows the checks
// and the setup steps; the report goes to an agent or the clipboard.

const problem = (id, icon, short, detail, fix = null) => ({ checks: [{ id, ok: false, icon, short, title: short, detail, fix, account: null }], accounts: null, signed: null });

/** { checks: [{ id, ok: true | false | null, icon, short, title, detail, fix,
 *  account }], accounts, signed }: what moving chats between Claude accounts
 *  needs on this Mac, and how many Claude accounts are here and signed in.
 *  Up to a minute: macOS may be showing a Keychain dialog that waits. */
export async function readDoctor() {
  const r = await exec("python3", ["-I", LIMITS(), "doctor"], { timeout: 60000 }).catch(() => null);
  if (!r || /xcode-select|command line developer tools|No developer tools/i.test(`${r.stderr}`))
    return problem("python", "🐍", "python3 is missing", "Orcherd switches accounts with python3, which comes with Apple's Command Line Tools (xcode-select --install).", "install-python");
  try {
    if (r.code === 0) return JSON.parse(r.stdout);
  } catch {}
  return problem("doctor", "⚠️", "The checks could not run", `${lastLine(r, "accounts.py failed")}. Fix with Claude reads a report of this Mac and finds out why.`, "diagnose");
}

/** Apple's Command Line Tools installer (python3 comes with it). */
export const installPython = () => exec("xcode-select", ["--install"]).catch(() => null);

/** A pane beside the focused one installs Claude Code. */
export function installClaude() {
  const script = 'curl -fsSL https://claude.ai/install.sh | bash; printf "\nBack in Settings › Accounts, press Check again. Enter closes this pane. "; read -r _';
  run("pane.split", { direction: "right", argv: ["sh", "-c", script] });
}

/** Writes ~/.cache/orcherd/diagnostics.md: versions, the checks, the
 *  accounts (emails masked, no tokens), the recent errors. { path } or { failed }. */
export async function writeDiagnostics(version) {
  let herdr = "?";
  try {
    const u = updates();
    herdr = `${u.app.version}${u.core.version ? ` (herdr-core ${u.core.version})` : ""}`;
  } catch {}
  const r = await exec("python3", ["-I", LIMITS(), "diagnose", version, herdr], { timeout: 90000 }).catch((err) => ({ code: 1, stderr: String(err?.message ?? err) }));
  if (r.code !== 0) return { failed: lastLine(r, "accounts.py failed") };
  return { path: r.stdout.trim().split("\n").pop() };
}

/** The report on the clipboard, to paste into any AI chat. */
export const copyDiagnostics = (path) => exec("/bin/sh", ["-c", 'LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 pbcopy < "$1"', "sh", path]);

/** Shows the report in Finder. */
export const revealDiagnostics = (path) => exec("open", ["-R", path]);

/** A new tab with Claude, told to read the report and fix what it finds with the user. */
export function fixWithAgent(path) {
  const task = `Read ${path}: a diagnostics report from Orcherd (orcha for the Herdr app) on this Mac. Follow its "For the AI agent reading this" section: find why it fails (most likely switching Claude accounts) and fix it with me. Never print or move a sign-in's secret, and ask me before deleting anything.`;
  run("tab.new", { name: "Fix Orcherd", folder: home(), argv: ["claude"], task });
}

/** An error the app showed, into errors.log for the report. Never awaited. */
export function logFailure(where, text) {
  if (!text) return;
  exec("python3", ["-I", LIMITS(), "log", String(where).slice(0, 40), String(text).slice(0, 2000)]).catch(() => null);
}

/** notify() for an error, which also goes to errors.log. */
export function notifyError(n) {
  logFailure(n.title, n.body);
  return notify(n);
}

/** Reads the accounts' fuel into the cache (network). Accounts read in the
 *  last two minutes are skipped, unless `fresh` (someone asked for it). */
export async function refreshFuel(fresh = false) {
  await exec("python3", ["-I", LIMITS(), "json", ...(fresh ? ["fresh"] : [])]);
  if (await stationLinked()) await exec("python3", ["-I", STATION(), "sync"]);
}

// The config folder each terminal's Claude reads (CLAUDE_CONFIG_DIR, from its
// process), or "-" for the main one, as accounts.py takes it. One ps for all.
async function configFolders(terminals) {
  const pids = await Promise.all(
    terminals.map(async (t) => {
      try {
        return JSON.parse((await hc(["get", "--json", t])).stdout).foreground?.pid ?? null;
      } catch {
        return null;
      }
    }),
  );
  const env = new Map();
  const live = pids.filter(Boolean);
  if (live.length) {
    const r = await exec("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", live.join(",")]);
    for (const line of r.stdout.split("\n")) {
      const m = /^\s*(\d+)\s(.*)$/.exec(line);
      if (m) env.set(Number(m[1]), /(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/.exec(m[2])?.[1] ?? "-");
    }
  }
  return pids.map((pid) => (pid && env.get(pid)) || "-");
}

const configFolder = async (terminal) => (await configFolders([terminal]))[0];

// The account whose sign-in is in each config folder now ("-": the main
// one), in order; null when not known. A hub folder is its hub account's;
// the others are asked of accounts.py, all in one run.
async function holdersOf(folders) {
  const hub = (f) => f.startsWith(STATION_DIR());
  const out = folders.map((f) => (hub(f) ? `station-${stationIdOf(f)}` : null));
  const ask = folders.filter((f) => !hub(f));
  if (!ask.length) return out;
  const r = await exec("python3", ["-I", LIMITS(), "whoami", ...ask]);
  const lines = r.code === 0 ? r.stdout.split("\n") : [];
  let n = 0;
  folders.forEach((f, i) => {
    if (!hub(f)) out[i] = lines[n++]?.trim() || null;
  });
  return out;
}

const holderOf = async (folder) => (await holdersOf([folder]))[0];

/** Which Claude account each Claude pane runs on, by terminal:
 *  { id, label, other, borrowed, seat }. `other`: not the default account
 *  (the main folder's). `borrowed`: the pane's folder belongs to another
 *  account (`seat`, its id: the session's own) and was kept running on this
 *  one, no restart. One read of
 *  every pane's folder and one per folder of who holds it. */
export async function readPaneAccounts() {
  const claudes = panes().filter((p) => p.terminal && p.program?.key?.includes("claude"));
  if (!claudes.length) return {};
  const folders = await configFolders(claudes.map((p) => p.terminal));
  const unique = [...new Set(folders)];
  const [holders, { list, main }, projects] = await Promise.all([holdersOf(unique), readAccounts(), readProjectAccounts()]);
  const holderOf = new Map(unique.map((f, i) => [f, holders[i]]));
  // Each pane's project: the space its tab is in.
  const projectOf = new Map();
  for (const s of spaces()) for (const t of s.tabs ?? []) projectOf.set(t.id, s);
  const out = {};
  claudes.forEach((p, i) => {
    const folder = folders[i];
    const id = holderOf.get(folder);
    if (!id) return;
    // The chat's home: its project's account when the project has one (any
    // other account in that project is borrowed, however the chat got on
    // it); else whose the config folder is, the default's for the main one.
    const project = projectOf.get(p.tab) ?? null;
    const mine = list.find((a) => a.kind === "claude" && a.id === projects[project?.folder]) ?? null;
    const owner = mine ?? (folder === "-" ? list.find((a) => a.id === main) ?? null : list.find((a) => a.kind === "claude" && claudeDir(a) === folder) ?? null);
    const label = list.find((a) => a.id === id)?.label ?? id;
    const borrowed = Boolean(owner && owner.id !== id);
    out[p.terminal] = { id, label, other: id !== main, borrowed, seat: borrowed ? owner.id : null, folder, project: mine ? project.name : null };
  });
  return out;
}

/** The account a terminal's Claude runs on, or null. */
export async function claudeAccountOf(terminal) {
  return holderOf(await configFolder(terminal));
}

/** What keeping `from`'s chat running on another account would do: a
 *  sign-in belongs to a config folder, so every chat in that folder moves
 *  (`others` besides this one), borrowing the account; the default account
 *  stays as it is. */
export async function keepInfo(from) {
  if (!from?.terminal) return { why: "Click into an agent first.", others: 0, home: null };
  const claudes = panes().filter((p) => p.terminal && p.terminal !== from.terminal && p.program?.key?.includes("claude"));
  const [folder, ...folders] = await configFolders([from.terminal, ...claudes.map((p) => p.terminal)]);
  if (folder.startsWith(STATION_DIR())) return { why: "this chat runs through the hub relay: restart it onto another account instead", others: 0, home: null };
  // The folder's own account: keep running onto it ends a borrow (RETURN).
  const { list, main } = await readAccounts();
  const home = folder === "-" ? main : list.find((a) => a.kind === "claude" && !isStation(a) && claudeDir(a) === folder)?.id ?? null;
  return { why: null, others: folders.filter((f) => f === folder).length, home };
}

/** Whether keep running onto `account` would move other chats too: a
 *  sign-in belongs to a config folder, not a pane. Only a chat alone in its
 *  folder borrows that way; RETURN (onto the folder's own account) puts a
 *  borrow back for all of them. */
export const keepMovesOthers = (keep, account) => Boolean(keep?.others) && account?.id !== keep?.home;

/** The chat keeps running on `account`'s sign-in, no restart: Claude reads it
 *  again within half a minute, and FUEL shows it BORROWED. Chats sharing its
 *  folder move with it (keepInfo). Null, or why not. */
export async function keepRunningOn(account, from) {
  if (isStation(account)) return "A running chat needs a restart to use a hub account: its relay endpoint is set when Claude Code starts. Restart the chat onto it, or open a new pane.";
  const keep = await keepInfo(from);
  if (keep.why) return keep.why;
  if (keepMovesOthers(keep, account)) return `${keep.others} other chat${keep.others === 1 ? " shares" : "s share"} this chat's folder and would move to ${account.label ?? account.id} too. RESTART moves only this chat.`;
  // Whoever asks (ACCOUNTS, the low-fuel watch): a Keychain that can't take
  // the sign-in would leave the chat where it was, with a note saying it moved.
  const blocked = keychainBlocks(await readKeychain());
  if (blocked) return blocked;
  const folder = await configFolder(from.terminal);
  // Borrowing on the main folder: remember the default first, so it stays.
  if (folder === "-" && !(await readTextFile(DEFAULT_FILE()))?.trim()) {
    const { active } = await readAccounts();
    if (active) await makeConfigDir().then(() => writeTextFile(DEFAULT_FILE(), `${active}\n`, null)).catch(() => {});
  }
  const r = await exec("python3", ["-I", LIMITS(), "switch-dir", account.id, folder]);
  return r.code === 0 ? null : lastLine(r, "accounts.py failed");
}

// Project accounts -------------------------------------------------------
// The Claude account a project's new chats start on (NEW asks once, the
// project's right-click menu changes it): { project folder: account id } in
// project-accounts.json. A chat started there is at home on that account;
// kept running on another one, it borrows.

const PROJECT_ACCOUNTS = () => configFile("project-accounts.json");

/** { project folder: account id }. */
export async function readProjectAccounts() {
  const map = await readJson(PROJECT_ACCOUNTS());
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

/** New Claude chats in `folder` start on account `id`. Null, or why not. */
export async function setProjectAccount(folder, id) {
  if (!folder) return "This project has no folder.";
  await makeConfigDir();
  const before = await readTextFile(PROJECT_ACCOUNTS());
  let map = {};
  try {
    map = before ? JSON.parse(before) : {};
  } catch {
    // a file that can't be read starts again: it only holds these choices
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) map = {};
  map[folder] = id;
  try {
    await writeTextFile(PROJECT_ACCOUNTS(), `${JSON.stringify(map, null, 2)}\n`, before);
  } catch {
    return "The project's account was not saved. Try again.";
  }
  return null;
}

/** What a shell runs to pick conversation `session` up again in config
 *  folder `folder` ("-" or none: the main one), so a chat resumed after a
 *  crash stays on its account. */
export function resumeClaude(session, folder) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  if (!folder || folder === "-") return `claude --resume ${session}`;
  if (folder.startsWith(STATION_DIR())) return `python3 -I ${q(STATION())} run ${stationIdOf(folder)} --resume ${session}`;
  return `env CLAUDE_CONFIG_DIR=${q(folder)} claude --resume ${session}`;
}

/** A new chat on `account`, in a new tab (of `space`, named `name`, when
 *  given): Claude in the account's own folder, Codex and Cursor as they are.
 *  Null, or why not. */
export async function startOn(account, { space, name } = {}) {
  const tab = (argv) => run("tab.new", { argv, ...(space ? { space } : {}), ...(name ? { name } : {}) });
  if (isStation(account)) {
    if (account.why) return `${account.label}: ${account.why}.`;
    tab(["python3", "-I", STATION(), "run", account.stationId]);
    return null;
  }
  if (account.kind !== "claude") {
    const argv = AGENT_RUN[account.kind];
    if (!argv) return `orcha can't start ${account.kind}.`;
    tab([argv]);
    return null;
  }
  const why = await folderTaken(account);
  if (why) return why;
  const dir = claudeDir(account);
  if (dir) await exec("python3", ["-I", LIMITS(), "link", account.id]);
  tab(dir ? ["env", `CLAUDE_CONFIG_DIR=${dir}`, "claude"] : ["claude"]);
  return null;
}

// A chat started in a Claude account's folder runs on whichever sign-in is in
// that folder now: another account's, after a chat there was kept running on
// it (or, in the main folder, after the default changed). Why `account`
// can't start in its folder now, or null. Starting anyway would open a chat
// that says one account and burns another. The account of the main folder
// (no folder of its own) gets one when another account is in the main
// folder (accounts.py seat): `account.dir` is set then, so callers read
// claudeDir(account) after this.
async function folderTaken(account) {
  const dir = claudeDir(account);
  const holder = await holderOf(dir ?? "-");
  if (holder === account.id) return null;
  const name = account.label ?? account.id;
  if (!dir) {
    const r = await exec("python3", ["-I", LIMITS(), "seat", account.id]);
    if (r.code !== 0) return `${name} lives in the main Claude folder (~/.claude), which another account holds now, and it could not get a folder of its own: ${lastLine(r, "accounts.py failed")}`;
    account.dir = r.stdout.trim().split("\n").pop();
    return claudeDir(account) ? null : `${name} could not get a folder of its own.`;
  }
  // Lent by a chat kept running there: given back when that chat is gone.
  await exec("python3", ["-I", LIMITS(), "free", account.id]);
  if ((await holderOf(dir)) === account.id) return null;
  const { list } = await readAccounts();
  const other = list.find((a) => a.id === holder)?.label ?? "another account";
  return `${name}'s folder is lent to ${other} now: a chat there was kept running on it. RETURN that chat first (ACCOUNTS, from that chat).`;
}

/** "Personal Mac" → "personal-mac" (orcha's account_slug). */
export function accountSlug(name) {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Opens a pane beside the focused one that signs `id` in (`accounts.py
 *  login`: the account's own folder, its email filled in). */
export function signIn(id) {
  run("pane.split", { direction: "right", argv: ["python3", "-I", LIMITS(), "login", id] });
}

/** The agents an account can be for. Claude accounts get a name and a folder
 *  each; Codex and Cursor sign in where their CLI keeps it, so one each. */
export const ACCOUNT_KINDS = [
  { kind: "claude", label: "Claude", cli: "claude" },
  { kind: "codex", label: "Codex", cli: "codex" },
  { kind: "cursor", label: "Cursor", cli: "cursor-agent" },
];

/** Adds an account to Orcherd's config.json and
 *  opens its sign-in: Claude account `name`, or the one Codex or Cursor
 *  account. Null, or why it failed. */
export async function addAccount(name, kind = "claude") {
  const one = kind !== "claude" ? ACCOUNT_KINDS.find((k) => k.kind === kind) : null;
  const slug = accountSlug(name);
  if (!one && !slug) return "Give it a name, like personal or work.";
  const id = one ? kind : `claude-${slug}`;
  await makeConfigDir();
  const before = await readTextFile(CONFIG());
  let config;
  try {
    config = before ? JSON.parse(before) : {};
  } catch {
    return "Orcherd's config.json could not be read.";
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return "Orcherd's config.json is not an object.";
  const list = (config.accounts ??= []);
  if (!Array.isArray(list)) return "accounts in config.json is not a list.";
  if (one) {
    if (list.some((a) => a?.kind === kind)) return `${one.label} is already an account: one per computer.`;
    list.push({ id, kind, label: one.label, email: "", dir: null });
  } else {
    if (list.some((a) => a?.id === id || a?.id?.replace(/^claude-/, "") === slug)) return `${id} is already an account.`;
    list.push({ id, kind: "claude", label: `Claude · ${slug}`, email: "", dir: `~/.config/orcherd/claude/${slug}` });
  }
  try {
    await writeTextFile(CONFIG(), `${JSON.stringify(config, null, 2)}\n`, before);
  } catch {
    return "config.json changed meanwhile. Try again.";
  }
  signIn(id);
  return null;
}

/** Gives a local account another name. Only the name shown changes: its id,
 *  folder and sign-in stay, so running chats and fuel are untouched. Null,
 *  or why it failed. */
export async function renameAccount(id, name) {
  const label = (name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40);
  if (!label) return "Give it a name.";
  if (id.startsWith("station-")) return "A hub account is named on the hub.";
  const before = await readTextFile(CONFIG());
  let config;
  try {
    config = JSON.parse(before);
  } catch {
    return "Orcherd's config.json could not be read.";
  }
  const account = Array.isArray(config?.accounts) ? config.accounts.find((a) => a?.id === id) : null;
  if (!account) return "That account is not in config.json any more.";
  if (config.accounts.some((a) => a?.id !== id && (a?.label ?? "").toLowerCase() === label.toLowerCase())) return `Another account is called ${label} already.`;
  account.label = label;
  try {
    await writeTextFile(CONFIG(), `${JSON.stringify(config, null, 2)}\n`, before);
  } catch {
    return "config.json changed meanwhile. Try again.";
  }
  return null;
}

/** Takes a local account off this Mac (accounts.py remove): config.json, its
 *  sign-ins in the Keychain, its fuel, its folder (~/.claude's chats stay:
 *  the folder only links to them). Not the default account, nor one a chat
 *  runs on now. Null, or why not; `kept`: a note on what stayed. */
export async function removeAccount(account) {
  if (isStation(account)) return { failed: "A hub account is removed on the hub." };
  const panes = await readPaneAccounts();
  const dir = claudeDir(account);
  const running = Object.values(panes).filter((p) => p.id === account.id || (dir && p.folder === dir)).length;
  if (running) return { failed: `${running} chat${running === 1 ? " runs" : "s run"} on ${account.label ?? account.id}. Close ${running === 1 ? "it" : "them"} or move ${running === 1 ? "it" : "them"} to another account first.` };
  const r = await exec("python3", ["-I", LIMITS(), "remove", account.id]);
  if (r.code !== 0) return { failed: lastLine(r, "accounts.py failed") };
  return { failed: null, kept: r.stdout.trim() || null };
}

// Hand-off settings ------------------------------------------------------
// In Orcherd's config.toml (config.js) under [orcha].

export const HANDOFF_DEFAULTS = {
  low_fuel_percent: 10,
  checklist_percent: 0,
  checklist_file: ".orcherd/handoff.md",
  auto_handoff_percent: 0,
  switch_mode: "ask",
};

/** The hand-off settings, the defaults filled in. */
export async function readHandoff() {
  const table = await readTable("orcha");
  const out = { ...HANDOFF_DEFAULTS };
  for (const key of Object.keys(HANDOFF_DEFAULTS)) if (key in table) out[key] = table[key];
  return out;
}

/** Sets one hand-off setting. Null, or why it failed. */
export function writeHandoff(key, value) {
  return key in HANDOFF_DEFAULTS ? writeKey("orcha", key, value) : Promise.resolve(`unknown setting ${key}`);
}

// Hand-off ---------------------------------------------------------------
// orcha_handoff.rs, the app's way: the old agent is asked nothing, so it
// works when it is out of fuel. Notes say what the work is, the folder's git
// state and where the old conversation is; the new agent opens beside the
// old one, reads them, sums up and waits for a go.

const AGENT_RUN = { claude: "claude", codex: "codex", cursor: "cursor-agent" };

/** The agent pane people are looking at, or null. */
export function focusedAgent() {
  const f = focused();
  if (!f?.pane) return null;
  const pane = panes().find((p) => p.pane === f.pane);
  if (!pane?.program?.agent) return null;
  const agent = agents().find((a) => a.pane === f.pane);
  return { pane: f.pane, terminal: agent?.address ?? f.terminal, cwd: pane.cwd || f.cwd, program: pane.program, title: agentTitle(agent, pane) ?? "" };
}

const sh = (script, ...args) => exec("sh", ["-c", script, "orcha", ...args]);

const fence = (text) => ["```", text.trim(), "```", ""];

async function buildNotes(from, checklistFile) {
  const source = from.program?.name ?? "agent";
  const lines = [
    `# Hand-off: ${from.title || "work in progress"}`,
    "",
    `You are taking over work another coding agent (${source}) started in \`${from.cwd}\`.`,
    "It stopped (usually out of plan limits), not because the work is done.",
    "",
    "Read these notes and check the repository state yourself. Then sum up where the work stands in five bullets: goal, what is done, what is left, open questions, the next step you suggest.",
    "",
    "**Do not continue the work yet.** Change no files and run nothing that changes state until the user tells you to go on.",
    "",
  ];
  if (checklistFile && (await sh('test -f "$1/$2"', from.cwd, checklistFile)).code === 0) {
    lines.push(`The previous agent left a checklist in \`${checklistFile}\`: read it too.`, "");
  }
  const git = (args) => exec("git", ["-C", from.cwd, ...args]).then((r) => (r.code === 0 ? r.stdout : ""));
  const [branch, status, stat, log] = await Promise.all([
    git(["branch", "--show-current"]),
    git(["status", "--short"]),
    git(["diff", "--stat", "HEAD"]),
    git(["log", "--oneline", "-8"]),
  ]);
  if (branch || status || log) {
    lines.push("## Repository", "", `- branch: \`${branch.trim() || "(detached)"}\``, "");
    if (status.trim()) lines.push("Uncommitted changes:", "", ...fence(status.slice(0, 4000)));
    if (stat.trim()) lines.push("Diff size:", "", ...fence(stat.slice(-2000)));
    if (log.trim()) lines.push("Recent commits:", "", ...fence(log));
  }
  const transcript = from.program?.key?.includes("claude") ? await claudeTranscript(from.cwd) : null;
  if (transcript) {
    lines.push("## Conversation", "", `The previous agent's conversation is in \`${transcript}\` (one JSON object per line, newest last). Read its last part first: the latest user requests and what the agent did about them.`, "");
  } else if (from.terminal) {
    const tail = (await readTerminal(from.terminal)).split("\n").slice(-300).join("\n");
    if (tail.trim()) lines.push("## The previous agent's screen", "", ...fence(tail.slice(-60000)));
  }
  return lines.join("\n");
}

// A Claude account's own folder, unless it is ~/.claude itself.
function claudeDir(account) {
  const dir = account.dir && expandHome(account.dir);
  return dir && dir !== `${home()}/.claude` ? dir : null;
}

/** Moves the focused agent's chat to `account`: notes, then the account's
 *  agent beside it, told to read them. Null, or why it failed. */
export async function handOff(account, { checklistFile = HANDOFF_DEFAULTS.checklist_file } = {}) {
  const from = focusedAgent();
  if (!from) return "Click into an agent first: its chat is what moves.";
  if (isStation(account) && account.why) return `${account.label}: ${account.why}.`;
  const command = AGENT_RUN[account.kind];
  if (!command) return `orcha can't hand a chat to ${account.kind}.`;
  const notes = await buildNotes(from, checklistFile);
  const folder = cacheFile("handoff");
  await sh('mkdir -p "$1" && chmod 700 "$1"', folder);
  const path = `${folder}/${new Date().toISOString().replace(/[:.]/g, "-")}-${account.kind}.md`;
  try {
    await writeTextFile(path, notes, null);
  } catch {
    return "The notes could not be saved.";
  }
  let argv = [command, `Read the hand-off notes in ${path}, sum up where the work stands, then wait for my go.`];
  if (isStation(account)) {
    argv = ["python3", "-I", STATION(), "run", account.stationId, ...argv.slice(1)];
  } else {
    const taken = account.kind === "claude" ? await folderTaken(account) : null;
    if (taken) return taken;
    const dir = account.kind === "claude" ? claudeDir(account) : null;
    if (dir) {
      await exec("python3", ["-I", LIMITS(), "link", account.id]);
      argv = ["env", `CLAUDE_CONFIG_DIR=${dir}`, ...argv];
    }
  }
  run("pane.split", { direction: "right", pane: from.pane, argv });
  return null;
}

/** Same pane, same chat, the agent restarted on `account` (orcha's
 *  SwitchMode::Restart): stops Claude and continues the folder's latest
 *  conversation on the account. It needs the account in a folder of its own
 *  (restart_folder in actions.rs): its sign-in may be set aside. */
export async function restartOn(account) {
  const from = focusedAgent();
  if (!from?.terminal) return "Click into an agent first.";
  if (account.kind !== "claude" || !from.program?.key?.includes("claude")) return "Restarting on another account works from Claude to Claude.";
  // A hub folder sees only its own chats: the one in this pane is linked
  // across first, so it goes on there. Local to local needs nothing.
  const fromFolder = await configFolder(from.terminal);
  // This pane's own chat, by its session: --continue takes the folder's
  // newest chat in that directory, another pane's when two work there.
  const chat = await paneSession(from.terminal, fromFolder);
  const cwd = chat?.cwd ?? from.cwd ?? home();
  const adopt = (to) => exec("python3", ["-I", STATION(), "adopt", fromFolder, to, cwd, ...(chat ? [chat.id] : [])]);
  const again = chat ? `--resume ${chat.id}` : "--continue";
  if (isStation(account)) {
    if (account.why) return `${account.label}: ${account.why}.`;
    await adopt(`${STATION_DIR()}${account.stationId}`);
    return typeContinue(from, `python3 -I '${STATION().replace(/'/g, "'\\''")}' run ${account.stationId} ${again}`);
  }
  const taken = await folderTaken(account);
  if (taken) return taken;
  const dir = claudeDir(account);
  if (dir) await exec("python3", ["-I", LIMITS(), "link", account.id]);
  if (fromFolder.startsWith(STATION_DIR())) await adopt(dir ?? "-");
  // Typed into the pane's shell: the folder quoted, so a space or a quote in it stays a name.
  const env = dir ? `env CLAUDE_CONFIG_DIR='${dir.replace(/'/g, "'\\''")}'` : "env -u CLAUDE_CONFIG_DIR";
  return typeContinue(from, `${env} claude ${again}`);
}

// Claude Code writes <config folder>/sessions/<pid>.json for each running
// chat ({ sessionId, cwd }); every account and hub folder links ~/.claude's.
// The chat in a terminal: { id, cwd }, or null when it can't be told.
export async function paneSession(terminal, folder) {
  let pid;
  try {
    pid = JSON.parse((await hc(["get", "--json", terminal])).stdout).foreground?.pid;
  } catch {
    return null;
  }
  if (!Number.isInteger(pid)) return null;
  const base = !folder || folder === "-" ? `${home()}/.claude` : folder;
  const info = (await readJson(`${base}/sessions/${pid}.json`)) ?? (await readJson(`${home()}/.claude/sessions/${pid}.json`));
  const id = info?.pid === pid ? info.sessionId : null;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { id, cwd: typeof info.cwd === "string" && info.cwd ? info.cwd : null };
}

// The pane's own shell is in front again: its foreground process is the
// terminal's first one. False when it can't be read.
async function shellInFront(terminal) {
  try {
    const t = JSON.parse((await hc(["get", "--json", terminal])).stdout);
    return t.foreground?.pid != null && t.foreground.pid === t.pid;
  } catch {
    return false;
  }
}

/** Ctrl+C twice leaves Claude Code; then the shell runs `command`. Null, or why not.
 *  It waits for the shell to be in front, not a fixed time: Claude can take
 *  longer to close, and the command typed before that lands in its chat box.
 *  Ctrl+C goes again while Claude stays: the first press may only clear a
 *  half-typed prompt or stop a turn. Nothing is typed if Claude never leaves. */
async function typeContinue(from, command) {
  let gone = false;
  for (let round = 0; round < 3 && !gone; round++) {
    await hc(["keys", from.terminal, "ctrl+c"]);
    await pause(0.4);
    if (!(await shellInFront(from.terminal))) await hc(["keys", from.terminal, "ctrl+c"]);
    for (let i = 0; i < (round < 2 ? 8 : 40) && !gone; i++) {
      await pause(0.25);
      gone = await shellInFront(from.terminal);
    }
  }
  if (!gone) return "Claude didn't close in this pane, so nothing was typed. Leave it (Ctrl+C twice) and restart again.";
  const r = await hc(["send", from.terminal, command]);
  return r.code === 0 ? null : lastLine(r, "hc send failed");
}

/** Asks the focused agent to write its checklist (it reads it between turns). */
export async function askForChecklist(file = HANDOFF_DEFAULTS.checklist_file) {
  const from = focusedAgent();
  if (!from?.terminal) return "Click into an agent first.";
  const text = `Your plan is running low. Before anything else, write ${file}: what is done, what is next as "- [ ]" items, open questions, and the files you touched, so another agent can continue. Then carry on.`;
  const r = await hc(["send", from.terminal, text]);
  return r.code === 0 ? null : lastLine(r, "hc send failed");
}
