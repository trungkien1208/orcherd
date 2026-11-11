// Orcherd's accounts and their fuel, read from its own files (config.json
// and the limits cache, see paths.js), and what can be done with them: use
// one, add one, hand a chat to one. Shared by ACCOUNTS, Settings › Accounts,
// Settings › Hand-off and the low-fuel watch in the right panel.
//
// Fuel, signing in and switching go through bin/accounts.py, which ships
// with this mod: the Keychain and the account folders stay in one place.

import { readTextFile, writeTextFile, exec, hc, home, run, focused, agents, panes, spaces } from "herdr";
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
  if (!from?.terminal) return { why: "Click into an agent first.", others: 0 };
  const claudes = panes().filter((p) => p.terminal && p.terminal !== from.terminal && p.program?.key?.includes("claude"));
  const [folder, ...folders] = await configFolders([from.terminal, ...claudes.map((p) => p.terminal)]);
  if (folder.startsWith(STATION_DIR())) return { why: "this chat runs through the hub relay: restart it onto another account instead", others: 0 };
  return { why: null, others: folders.filter((f) => f === folder).length };
}

/** The chat keeps running on `account`'s sign-in, no restart: Claude reads it
 *  again within half a minute, and FUEL shows it BORROWED. Chats sharing its
 *  folder move with it (keepInfo). Null, or why not. */
export async function keepRunningOn(account, from) {
  if (isStation(account)) return "A running chat needs a restart to use a hub account: its relay endpoint is set when Claude Code starts. Restart the chat onto it, or open a new pane.";
  const { why } = await keepInfo(from);
  if (why) return why;
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
  const dir = claudeDir(account);
  const why = await folderTaken(account);
  if (why) return why;
  if (dir) await exec("python3", ["-I", LIMITS(), "link", account.id]);
  tab(dir ? ["env", `CLAUDE_CONFIG_DIR=${dir}`, "claude"] : ["claude"]);
  return null;
}

// A chat started in a Claude account's folder runs on whichever sign-in is in
// that folder now: another account's, after a chat there was kept running on
// it (or, in the main folder, after the default changed). Why `account`
// can't start in its folder now, or null. Starting anyway would open a chat
// that says one account and burns another.
async function folderTaken(account) {
  const dir = claudeDir(account);
  const holder = await holderOf(dir ?? "-");
  if (holder === account.id) return null;
  const { list } = await readAccounts();
  const name = account.label ?? account.id;
  const other = list.find((a) => a.id === holder)?.label ?? "another account";
  if (!dir) return `${name} lives in the main Claude folder (~/.claude), and ${other} is in it now. Make ${name} the default (Settings › Accounts), or KEEP RUNNING a chat onto it.`;
  return `${name}'s folder is lent to ${other} now: a chat there was kept running on it. RETURN that chat first (ACCOUNTS, from that chat), or KEEP RUNNING this chat onto ${name}.`;
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
    const dir = account.kind === "claude" ? claudeDir(account) : null;
    const taken = account.kind === "claude" ? await folderTaken(account) : null;
    if (taken) return taken;
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
  // across first, so --continue goes on with it. Local to local needs nothing.
  const fromFolder = await configFolder(from.terminal);
  const adopt = (to) => exec("python3", ["-I", STATION(), "adopt", fromFolder, to, from.cwd ?? home()]);
  if (isStation(account)) {
    if (account.why) return `${account.label}: ${account.why}.`;
    await adopt(`${STATION_DIR()}${account.stationId}`);
    return typeContinue(from, `python3 -I '${STATION().replace(/'/g, "'\\''")}' run ${account.stationId} --continue`);
  }
  const dir = claudeDir(account);
  const taken = await folderTaken(account);
  if (taken) return taken;
  if (dir) await exec("python3", ["-I", LIMITS(), "link", account.id]);
  if (fromFolder.startsWith(STATION_DIR())) await adopt(dir ?? "-");
  // Typed into the pane's shell: the folder quoted, so a space or a quote in it stays a name.
  const env = dir ? `env CLAUDE_CONFIG_DIR='${dir.replace(/'/g, "'\\''")}'` : "env -u CLAUDE_CONFIG_DIR";
  return typeContinue(from, `${env} claude --continue`);
}

/** Ctrl+C twice leaves Claude Code; then the shell runs `command`. Null, or why not. */
async function typeContinue(from, command) {
  await hc(["keys", from.terminal, "ctrl+c"]);
  await pause(0.4);
  await hc(["keys", from.terminal, "ctrl+c"]);
  await pause(1);
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
