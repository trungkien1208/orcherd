#!/usr/bin/env -S python3 -I
"""Orcherd's accounts and their fuel (plan limits). Orcherd's own: it needs
nothing of the terminal orcha, and keeps its files apart from it.

  accounts.py json [fresh]          every account's fuel into the cache; fresh: ask past the cache
  accounts.py whoami <dir|->...     the account Claudes reading config folder <dir> run on (-: ~/.claude),
                                    one line per folder
  accounts.py switch-dir <id> <dir|->   move the Claudes reading <dir> onto that account, no restart
  accounts.py activate <id>         make that Claude account the one every default Claude uses
  accounts.py link <id>             link ~/.claude's shared files into a Claude account's folder
  accounts.py login <id>            sign that account in (its own folder, email filled in)
  accounts.py keychain              whether Claude's sign-ins can go in the Keychain (JSON)
  accounts.py keychain-move         put sign-ins Claude left in .credentials.json into the Keychain

Files: ~/.config/orcherd (config.json with `accounts`, which account is where)
and ~/.cache/orcherd/limits (the fuel), the same folders as paths.js. Claude,
Codex and Cursor found on this Mac are added to config.json by themselves,
once each: an account removed from it stays removed.

Claude: Anthropic's usage endpoint, with the account's own sign-in from the
macOS Keychain, else the .credentials.json Claude keeps when it can't write
there (the same data as /usage). Codex: the rate limits Codex writes into its
newest session log. Cursor: the usage summary of cursor.com. Tokens are never
printed or refreshed here, never put in argv, and reach curl and `security`
on stdin only.
"""
import base64
import contextlib
import fcntl
import glob
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime

HOME = os.path.expanduser("~")
# Fixed, as paths.js has them: the app and this script must agree, whatever
# XDG_CONFIG_HOME the app happened to be started with.
CONFIG_DIR = os.path.join(HOME, ".config", "orcherd")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
CACHE = os.path.join(HOME, ".cache", "orcherd")
CACHE_DIR = os.path.join(CACHE, "limits")
SELECTED_FILE = os.path.join(CONFIG_DIR, "selected-account")

T = {
    "codex_note": "from your last Codex run:",
    "cursor_note": "plan {plan} · auto {auto}% · picked models {api}%",
    "err_codex": "no Codex session with limit data yet",
    "err_cursor": "not signed in — SIGN IN",
    "err_cursor_expired": "sign-in expired — SIGN IN",
    "err_expired": "sign-in expired — SIGN IN",
    "err_idle": "idle — wakes on its next chat",
    "err_nodata": "no limit data",
    "err_signin": "not signed in — SIGN IN",
    "err_request": "request failed",
}


# ---------- files: private, whole or not at all

def make_dir(d):
    """A folder only you can read (sign-in profiles and account folders live here)."""
    os.makedirs(d, mode=0o700, exist_ok=True)


def read_text(path):
    try:
        with open(path) as fh:
            return fh.read()
    except FileNotFoundError:
        return None


def atomic_write(path, text, mode=0o600):
    """Writes `path` whole or not at all: a temp file of its own beside it (two
    runs never share one), the old file's permissions kept, then renamed over
    it. A symlink is followed, so a linked dotfile stays a link."""
    path = os.path.realpath(path)
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        pass
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            os.fchmod(fh.fileno(), mode)
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def write_line(path, value):
    """A one-line state file (claude-active, selected-account), or none for None."""
    if value is None:
        with contextlib.suppress(FileNotFoundError):
            os.remove(path)
        return
    make_dir(os.path.dirname(path))
    atomic_write(path, value if value.endswith("\n") else value + "\n")


@contextlib.contextmanager
def state_lock():
    """One change to the sign-ins at a time, however many windows ask."""
    make_dir(CONFIG_DIR)
    with open(os.path.join(CONFIG_DIR, ".lock"), "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        _KC_READ.clear()  # what was read before the lock may have changed since
        yield


# ---------- accounts: config.json, plus the agents found on this Mac

# herdr's agent id: its command. Plan limits exist for these three only.
AGENTS = {"claude": ("claude", "Claude"), "codex": ("codex", "Codex"), "cursor": ("cursor-agent", "Cursor")}
# where agent installers put their command when it is not on PATH yet
AGENT_DIRS = ("~/.local/bin", "~/.claude/local", "/opt/homebrew/bin", "/usr/local/bin",
              "~/.npm-global/bin", "~/.bun/bin", "~/.volta/bin", "~/.cargo/bin")
# An account id ends up in file names and Keychain item names: nothing else.
ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")


def agent_path(cmd):
    found = shutil.which(cmd)
    if found:
        return found
    for folder in AGENT_DIRS:
        path = os.path.join(os.path.expanduser(folder), cmd)
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def claude_email(folder=None):
    """The signed-in email of a Claude config folder (~/.claude by default)."""
    path = os.path.join(folder, ".claude.json") if folder else os.path.join(HOME, ".claude.json")
    try:
        with open(path) as fh:
            return (json.load(fh).get("oauthAccount") or {}).get("emailAddress") or ""
    except (OSError, ValueError, AttributeError):
        return ""


def load_config():
    """(config, its text as read). No file: an empty config. A file that can't
    be read or parsed (a hand edit gone wrong): None, and nothing is ever
    saved over it."""
    try:
        text = read_text(CONFIG_FILE)
    except OSError:
        return None, None
    if text is None:
        return {"accounts": []}, None
    try:
        cfg = json.loads(text)
    except ValueError:
        return None, text
    if not isinstance(cfg, dict) or not isinstance(cfg.setdefault("accounts", []), list):
        return None, text
    return cfg, text


def save_config(cfg, before):
    """Saves config.json unless it changed since it was read (`before`): the
    app may have added an account meanwhile. True when saved."""
    make_dir(CONFIG_DIR)
    if read_text(CONFIG_FILE) != before:
        return False
    atomic_write(CONFIG_FILE, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    return True


def with_detected(cfg, before):
    """Adds one account for each of Claude / Codex / Cursor installed but not
    an account yet, so FUEL shows without any setup. Each kind once
    (`detected`): one removed by hand is not added back."""
    seen = cfg.get("detected") if isinstance(cfg.get("detected"), list) else []
    have = {a.get("kind") for a in cfg["accounts"] if isinstance(a, dict)}
    changed = False
    for kind, (cmd, label) in AGENTS.items():
        if kind in seen:
            continue
        if kind not in have:
            if not agent_path(cmd):
                continue
            if kind == "claude":
                cfg["accounts"].append({"id": "claude-main", "kind": "claude", "label": "Claude",
                                        "email": claude_email(), "dir": None})
            else:
                cfg["accounts"].append({"id": kind, "kind": kind, "label": label, "email": "", "dir": None})
        seen.append(kind)
        changed = True
    if changed:
        cfg["detected"] = seen
        with contextlib.suppress(OSError):
            save_config(cfg, before)
    return cfg


def valid_dir(d):
    """An account's own Claude folder must be a folder of its own under your
    home: it gets links made in it and sign-in files removed from it."""
    if not d:
        return True
    if not isinstance(d, str):
        return False
    p = os.path.expanduser(d)
    return (os.path.isabs(p) and ".." not in p.split(os.sep)
            and os.path.normpath(p).startswith(HOME + os.sep))


_cfg, _before = load_config()
CFG = with_detected(_cfg, _before) if _cfg is not None else {"accounts": []}
ACCOUNTS = {a["id"]: a for a in CFG["accounts"]
            if isinstance(a, dict) and isinstance(a.get("id"), str) and ID_RE.match(a["id"])
            and a.get("kind") in AGENTS and valid_dir(a.get("dir"))}


def claude_dir(acct):
    """CLAUDE_CONFIG_DIR of a Claude account; None for the default ~/.claude."""
    d = acct.get("dir")
    return os.path.expanduser(d) if d else None


# ---------- one Claude sign-in for every default session
# Every Claude without CLAUDE_CONFIG_DIR reads the default sign-in ("Claude
# Code-credentials" in the Keychain, the account shown from ~/.claude.json).
# `activate` puts an account's sign-in there, so running sessions move with
# it, no restart. The sign-in it replaces (Claude may have refreshed it) is
# kept first in "orcherd-claude-<id>", so that account still works when it
# comes back. Secrets only ever travel on stdin, hex encoded, never in argv.
DEFAULT_SERVICE = "Claude Code-credentials"
ACTIVE_FILE = os.path.join(CONFIG_DIR, "claude-active")
PROFILE_DIR = os.path.join(CONFIG_DIR, "claude-accounts")


def dir_service(d):
    """The Keychain item Claude reads for config folder `d` (as Claude hashes it)."""
    return DEFAULT_SERVICE + ("-" + hashlib.sha256(d.encode()).hexdigest()[:8] if d else "")


def own_service(cfg):
    """The Keychain item Claude itself keeps for an account's config folder."""
    return dir_service(claude_dir(cfg))


def kept_service(acct):
    return f"orcherd-claude-{acct}"


def unowned_service(service):
    """Where a sign-in no account owns is kept before it is replaced."""
    return "orcherd-claude-unowned-" + hashlib.sha256(service.encode()).hexdigest()[:8]


# One run asks for the same item many times over (who holds it, which copy
# is freshest, its fuel): each is read from the Keychain once. kc_write and
# a sign-in made by Claude meanwhile (cmd_login) forget what was read.
_KC_READ = {}


def keychain_read(service):
    if service not in _KC_READ:
        r = subprocess.run(["security", "find-generic-password", "-s", service, "-w"],
                           capture_output=True, text=True, timeout=10)
        _KC_READ[service] = r.stdout.rstrip("\n") if r.returncode == 0 and r.stdout.strip() else None
    return _KC_READ[service]


# When Claude can't write the Keychain (locked, a broken login keychain, a
# managed Mac) it keeps the sign-in in `.credentials.json` in its config
# folder instead. Fuel reads it there too; switching needs the Keychain
# (`keychain` says how it stands, `keychain-move` puts the files back in).
def cred_files():
    """{Keychain item: the .credentials.json Claude keeps in its place}."""
    out = {DEFAULT_SERVICE: os.path.join(HOME, ".claude", ".credentials.json")}
    for c in ACCOUNTS.values():
        d = c["kind"] == "claude" and claude_dir(c)
        if d:
            out[dir_service(d)] = os.path.join(d, ".credentials.json")
    return out


def cred_file_read(service):
    path = cred_files().get(service)
    if not path:
        return None
    try:
        with open(path) as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def expires_of(raw):
    try:
        return json.loads(raw)["claudeAiOauth"].get("expiresAt", 0)
    except (TypeError, ValueError, KeyError, AttributeError):
        return -1


def kc_read(service):
    """The sign-in in Keychain item `service`, or in the .credentials.json
    Claude keeps in its place: whichever was refreshed last."""
    kc, file = keychain_read(service), cred_file_read(service)
    if not file or not kc:
        return kc or file
    return file if expires_of(file) > expires_of(kc) else kc


def kc_account(service):
    """The item's account attribute (Claude writes the user name there)."""
    r = subprocess.run(["security", "find-generic-password", "-s", service],
                       capture_output=True, text=True, timeout=10)
    m = re.search(r'"acct"<blob>="([^"]*)"', r.stdout)
    return m.group(1) if m else os.environ.get("USER", "")


KEYCHAIN_WRITE_FAILED = ("The macOS Keychain can't be written (locked or broken), so the sign-in "
                         "can't move. ACCOUNTS shows how to fix it.")
PROBE_SERVICE = "orcherd-keychain-probe"


def kc_write(service, account, secret):
    """Puts `secret` in Keychain item `service`, on stdin (`security -i`), and
    reads it back: `security -i` can fail and still exit 0."""
    if any(c in s for s in (service, account) for c in '"\\\n\r'):
        raise RuntimeError("A Keychain item's name has a character it can't take: nothing was written.")
    try:
        # one line: `security -w` gives back a value with line breaks as hex
        secret = json.dumps(json.loads(secret), separators=(",", ":"))
    except ValueError:
        pass
    cmd = f'add-generic-password -U -s "{service}" -a "{account}" -X {secret.encode().hex()}\n'
    _KC_READ.pop(service, None)
    r = subprocess.run(["security", "-i"], input=cmd, capture_output=True, text=True, timeout=10)
    _KC_READ.pop(service, None)
    if r.returncode != 0 or keychain_read(service) != secret:
        raise RuntimeError(KEYCHAIN_WRITE_FAILED)


def keychain_state():
    """{state, why, files}: `ok`; `file-only` (writable, but Claude keeps a
    sign-in in a .credentials.json the Keychain lacks); `locked`; `broken` (no
    default keychain, or its password no longer matches the Mac's). A
    throwaway item is written and removed to find out: reading alone can't tell."""
    try:
        # only files the Keychain lacks or holds an older sign-in for
        files = []
        for service, path in cred_files().items():
            raw = cred_file_read(service)
            if raw and path not in files and expires_of(raw) > expires_of(keychain_read(service)):
                files.append(path)
        r = subprocess.run(["security", "add-generic-password", "-U", "-s", PROBE_SERVICE,
                            "-a", "orcherd", "-w", "probe"],
                           capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired:
        # macOS is asking for the keychain's password in a dialog
        return {"state": "locked", "why": "macOS is asking to unlock the Keychain", "files": []}
    if r.returncode == 0:
        subprocess.run(["security", "delete-generic-password", "-s", PROBE_SERVICE],
                       capture_output=True, timeout=10)
        return {"state": "file-only" if files else "ok", "why": None, "files": files}
    why = ((r.stderr or r.stdout).strip().splitlines() or ["security failed"])[-1]
    locked = any(w in why.lower() for w in ("interaction is not allowed", "locked"))
    return {"state": "locked" if locked else "broken", "why": why, "files": files}


def cmd_keychain_move():
    """Each sign-in Claude left in a .credentials.json goes into its Keychain
    item (unless the item holds a fresher one), checked, then the file goes:
    Claude reads the Keychain from then on."""
    for service, path in cred_files().items():
        raw = cred_file_read(service)
        if not raw:
            continue
        kc = keychain_read(service)
        if not kc or expires_of(raw) > expires_of(kc):
            kc_write(service, kc_account(service), raw)  # checked: it raises when not there
        os.remove(path)


def claude_accounts():
    return [a for a, c in ACCOUNTS.items() if c["kind"] == "claude"]


def active_claude():
    """The Claude account in the default sign-in: the one `activate` put
    there, else the account that uses ~/.claude itself."""
    try:
        a = (read_text(ACTIVE_FILE) or "").strip()
        if a in ACCOUNTS:
            return a
    except OSError:
        pass
    return next((a for a in claude_accounts() if not claude_dir(ACCOUNTS[a])), None)


def claude_profile(acct):
    """An account's oauthAccount (its email etc.) as last seen."""
    try:
        with open(os.path.join(PROFILE_DIR, acct + ".json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        pass
    d = claude_dir(ACCOUNTS[acct])
    if d:
        try:
            with open(os.path.join(d, ".claude.json")) as fh:
                return json.load(fh).get("oauthAccount")
        except (OSError, ValueError, AttributeError):
            pass
    return None


# A pane started in an account's own folder (CLAUDE_CONFIG_DIR) reads that
# folder's item, not the default one. Switching such a pane puts the new
# account's sign-in into that item; this file remembers which account each
# folder item holds now ({service: account}).
SLOTS_FILE = os.path.join(CONFIG_DIR, "claude-slots.json")


def read_slots():
    try:
        slots = json.loads(read_text(SLOTS_FILE) or "{}")
        return {k: v for k, v in slots.items() if v in ACCOUNTS}
    except (OSError, ValueError, AttributeError):
        return {}


def write_slots(slots):
    make_dir(CONFIG_DIR)
    atomic_write(SLOTS_FILE, json.dumps(slots))


def slot_owner(service):
    """The account whose sign-in is in a folder's item now."""
    slots = read_slots()
    if service in slots:
        return slots[service]
    return next((a for a in claude_accounts() if own_service(ACCOUNTS[a]) == service), None)


def holders(acct):
    """Every Keychain item that holds the account's sign-in: the default item
    when active, folder items it was switched into, its own folder's item
    (unless another account was switched into it) and the copy Orcherd kept."""
    out = [DEFAULT_SERVICE] if acct == active_claude() else []
    slots = read_slots()
    out += [svc for svc, a in slots.items() if a == acct]
    own = own_service(ACCOUNTS[acct])
    if claude_dir(ACCOUNTS[acct]) and slots.get(own, acct) == acct:
        out.append(own)
    out.append(kept_service(acct))
    return list(dict.fromkeys(out))


def kc_oauth(service):
    """(expiresAt, raw) of an item's sign-in, or (-1, None)."""
    raw = kc_read(service)
    exp = expires_of(raw)
    return (exp, raw) if exp >= 0 else (-1, None)


def freshest(acct):
    """(item, raw) of the account's most recently refreshed sign-in, or (None, None)."""
    best = (-1, None, None)
    for svc in holders(acct):
        exp, raw = kc_oauth(svc)
        if raw and exp > best[0]:
            best = (exp, svc, raw)
    return best[1], best[2]


def claude_service(acct):
    """Where the account's live sign-in is: its most recently refreshed item."""
    return freshest(acct)[0] or own_service(ACCOUNTS[acct])


def nudge_claude(config_dir):
    """Make running Claude sessions of `config_dir` (None: ~/.claude) read
    their sign-in again. When the folder has a .credentials.json, Claude
    only looks at that file's modified time to notice a new sign-in, so a
    Keychain change alone goes unseen; touching the file (content untouched)
    makes it drop the token it holds and read the Keychain again."""
    folder = os.path.expanduser(config_dir) if config_dir else os.path.join(HOME, ".claude")
    path = os.path.join(folder, ".credentials.json")
    if os.path.exists(path):
        with contextlib.suppress(OSError):
            os.utime(path, None)


def sync_claude(acct):
    """Claude replaces the refresh token on every refresh, so a copy of a
    sign-in left behind stops working: the freshest one goes to the copy
    Orcherd kept and to items whose sign-in has run out, and the Claudes
    reading them are nudged. An item still in date is left alone: it may be
    a sign-in of its own, and two folders sharing one would fight over it."""
    src, raw = freshest(acct)
    if not src:
        return
    exp = expires_of(raw)
    now = time.time() * 1000
    folders = {dir_service(claude_dir(c)): claude_dir(c)
               for c in ACCOUNTS.values() if c["kind"] == "claude" and claude_dir(c)}
    for svc in holders(acct):
        old, cur = kc_oauth(svc)
        if svc == src or cur == raw or old >= exp:
            continue
        if svc != kept_service(acct) and old > now:
            continue
        kc_write(svc, kc_account(svc), raw)
        if svc == DEFAULT_SERVICE:
            nudge_claude(None)
        elif svc in folders:
            nudge_claude(folders[svc])


# ---------- fetchers: {"session": (pct, reset_ts), "weekly": (...), "note": str} or {"error": str}

CACHE_TTL = 120
# a request that failed for a while (no network, a timeout): ask again after
# this; rate limited (HTTP 429): wait longer. The last numbers stay meanwhile.
RETRY_AFTER = 300
RATE_LIMIT_RETRY_AFTER = 900


def iso_ts(s):
    s = s.replace("Z", "+00:00")
    # Python 3.9 (macOS's own) takes only 3 or 6 digits of a second's fraction
    s = re.sub(r"(\.\d+)", lambda m: (m.group(1) + "000000")[:7], s, count=1)
    return datetime.fromisoformat(s).timestamp()


def claude_limits(cfg):
    try:
        oauth = json.loads(kc_read(claude_service(cfg["id"])))["claudeAiOauth"]
        token = oauth["accessToken"]
    except Exception:
        return {"error": T["err_signin"]}
    if oauth.get("expiresAt", 0) / 1000 < time.time():
        # Claude refreshes it on the next chat; until then the last numbers stay
        if oauth.get("refreshToken"):
            # no request was made: nothing to back off from, look again next time
            return {"error": T["err_idle"], "transient": True, "asked": False}
        return {"error": T["err_expired"]}
    if not re.fullmatch(r"[A-Za-z0-9._~+/=-]+", token):
        return {"error": T["err_signin"]}  # it goes in a curl config line: nothing else may
    # curl (system certs) with headers fed on stdin, so the token never shows in `ps`.
    curl_cfg = (f'header = "Authorization: Bearer {token}"\n'
                'header = "anthropic-beta: oauth-2025-04-20"\n'
                'header = "Content-Type: application/json"\n')
    r = subprocess.run(["curl", "-sS", "-m", "15", "-f", "-K", "-",
                        "https://api.anthropic.com/api/oauth/usage"],
                       input=curl_cfg, capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        return {"error": f"{T['err_request']} ({r.stderr.strip()[:80]})",
                "transient": True, "rate_limited": "error: 429" in r.stderr}
    data = json.loads(r.stdout)
    out = {}
    for key, name in (("five_hour", "session"), ("seven_day", "weekly")):
        w = data.get(key) or {}
        if w.get("utilization") is not None:
            out[name] = (float(w["utilization"]), iso_ts(w["resets_at"]) if w.get("resets_at") else None)
    return out or {"error": T["err_nodata"]}


def codex_limits(_cfg):
    def mtime(f):
        try:
            return os.path.getmtime(f)
        except OSError:
            return 0
    files = sorted(glob.glob(os.path.join(HOME, ".codex", "sessions", "*", "*", "*", "*.jsonl")),
                   key=mtime, reverse=True)[:10]
    for f in files:
        rl = None
        try:
            with open(f, errors="ignore") as fh:
                for line in fh:
                    if '"rate_limits"' not in line:
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    cand = (obj.get("payload") or {}).get("rate_limits") or obj.get("rate_limits")
                    if cand and cand.get("primary"):
                        rl = cand
        except OSError:
            continue
        if not rl:
            continue
        out = {"note": T["codex_note"] + " " + datetime.fromtimestamp(mtime(f)).strftime("%a %H:%M")}
        for key, name in (("primary", "session"), ("secondary", "weekly")):
            w = rl.get(key) or {}
            reset = w.get("resets_at")
            reset = reset if isinstance(reset, (int, float)) else None
            pct = float(w.get("used_percent") or 0)
            if reset and reset < time.time():
                pct = 0.0  # the window already reset since that run
            out[name] = (pct, reset)
        return out
    return {"error": T["err_codex"]}


def cursor_limits(_cfg):
    try:
        tok = subprocess.run(["security", "find-generic-password", "-s", "cursor-access-token", "-w"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        payload = tok.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        sub = json.loads(base64.urlsafe_b64decode(payload))["sub"].split("|")[-1]
    except Exception:
        return {"error": T["err_cursor"]}
    if not re.fullmatch(r"[A-Za-z0-9._~+/=-]+", tok) or not re.fullmatch(r"[A-Za-z0-9._~+/=-]+", sub):
        return {"error": T["err_cursor"]}  # they go in a curl config line: nothing else may
    # Same session cookie the Cursor dashboard uses; fed on stdin, never in `ps`.
    curl_cfg = f'header = "Cookie: WorkosCursorSessionToken={sub}%3A%3A{tok}"\n'
    r = subprocess.run(["curl", "-sS", "-m", "15", "-f", "-K", "-", "https://cursor.com/api/usage-summary"],
                       input=curl_cfg, capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        return {"error": T["err_cursor_expired"]}
    data = json.loads(r.stdout)
    plan = data["individualUsage"]["plan"]
    return {"monthly": (float(plan.get("totalPercentUsed") or 0), iso_ts(data["billingCycleEnd"])),
            "note": T["cursor_note"].format(plan=data.get("membershipType", "?"),
                                            auto=f"{plan.get('autoPercentUsed') or 0:.0f}",
                                            api=f"{plan.get('apiPercentUsed') or 0:.0f}")}


FETCH = {"claude": claude_limits, "codex": codex_limits, "cursor": cursor_limits}


def read_cache(path):
    """(data, age in seconds), or (None, None)."""
    try:
        with open(path) as fh:
            return json.load(fh), time.time() - os.path.getmtime(path)
    except (OSError, ValueError):
        return None, None


def retry_at(path):
    try:
        return float((read_text(path) or "0").strip() or 0)
    except (OSError, ValueError):
        return 0.0


WINDOWS = ("session", "weekly", "monthly")


def kept_numbers(cached, idle):
    """The last numbers read (`at`), for while no new ones can be: a window
    that reset since counts as full again. Idle (no request can be made until
    the account's next chat): marked so, with when they were read."""
    ours = cached.get("idle")  # the note below is ours then, not the fetcher's
    out = {k: v for k, v in cached.items() if k != "idle" and not (k == "note" and ours)}
    now = time.time()
    for name in WINDOWS:
        entry = out.get(name)
        if isinstance(entry, list) and len(entry) == 2 and isinstance(entry[1], (int, float)) and entry[1] < now:
            out[name] = [0.0, None]
    if idle:
        out["idle"] = True
        if isinstance(out.get("at"), (int, float)):
            out["note"] = "last read " + datetime.fromtimestamp(out["at"]).strftime("%a %H:%M")
    return out


def get(acct, fresh=False):
    """The account's limits, cached for CACHE_TTL. A request that fails for a
    while (rate limited, offline) or can't be made (an idle sign-in) keeps the
    last numbers and backs off, so the fuel gauge does not flip to an error
    every few minutes."""
    make_dir(CACHE_DIR)
    path = os.path.join(CACHE_DIR, acct + ".json")
    retry = path + ".retry"
    # An idle sign-in costs no request to look at again, and a chat (a borrow
    # often starts one) renews it any minute: only a real request's back-off
    # holds it.
    def waits(cached, age):
        if fresh or cached is None:
            return False
        idle = cached.get("error") == T["err_idle"] or cached.get("idle")
        return (age < CACHE_TTL and not idle) or retry_at(retry) > time.time()
    cached, age = read_cache(path)
    if waits(cached, age):
        return cached
    # one request at a time, however many windows ask
    with open(path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cached, age = read_cache(path)
        if waits(cached, age):
            return cached
        cfg = ACCOUNTS[acct]
        try:
            data = FETCH[cfg["kind"]](cfg)
        except Exception as e:  # an answer of an unexpected shape, a timeout: never a token in it
            data = {"error": f"{T['err_request']} ({type(e).__name__})", "transient": True}
        if data.pop("transient", False):
            if data.pop("asked", True):
                wait = RATE_LIMIT_RETRY_AFTER if data.pop("rate_limited", False) else RETRY_AFTER
                atomic_write(retry, str(time.time() + wait))
            if cached is not None and "error" not in cached:
                kept = kept_numbers(cached, data.get("error") == T["err_idle"])
                if kept != cached:
                    atomic_write(path, json.dumps(kept))
                return kept
        else:
            with contextlib.suppress(OSError):
                os.remove(retry)
            if "error" not in data:
                data["at"] = time.time()
        atomic_write(path, json.dumps(data))
        return data


def forget_fuel(acct):
    """A new sign-in may be someone else's plan: the old numbers go."""
    with contextlib.suppress(OSError):
        os.remove(os.path.join(CACHE_DIR, acct + ".json"))


def expire_fuel(acct):
    """The account's sign-in moved: its fuel is asked again on the next read,
    past the cache and any back-off. The last numbers stay until then (and
    after, when the sign-in is idle)."""
    path = os.path.join(CACHE_DIR, acct + ".json")
    with contextlib.suppress(OSError):
        os.utime(path, (0, 0))
    with contextlib.suppress(OSError):
        os.remove(path + ".retry")


def write_token(acct):
    """<id>.token.json beside the fuel cache: when the account's access token
    runs out (ms) and whether a refresh token is there to renew it, for
    ACCOUNTS to show. Never the token itself."""
    exp, raw = kc_oauth(claude_service(acct))
    refresh = bool(raw and json.loads(raw)["claudeAiOauth"].get("refreshToken"))
    make_dir(CACHE_DIR)
    atomic_write(os.path.join(CACHE_DIR, acct + ".token.json"), json.dumps({"expires": max(exp, 0), "refresh": refresh}))


def cmd_json(fresh=False):
    """Reads every account's fuel into the cache (<id>.json) and, for Claude,
    its sign-in's state (<id>.token.json): what FUEL and ACCOUNTS show. One
    account that fails never stops the others."""
    for acct, cfg in ACCOUNTS.items():
        if cfg["kind"] == "claude":
            # apart: a Keychain that can't be written stops the sync, not
            # what ACCOUNTS knows of the sign-in
            for step in (sync_claude, write_token):
                try:
                    with state_lock():
                        step(acct)
                except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError):
                    pass  # the Keychain is busy: next time
        try:
            get(acct, fresh)
        except (OSError, ValueError):
            pass


def dir_account(found_raw):
    """The account of the Claudes reading config folder `found_raw` (None: ~/.claude)."""
    found = os.path.realpath(os.path.expanduser(found_raw)) if found_raw else None
    if found_raw:
        owner = slot_owner(dir_service(found_raw))
        if owner:
            return owner
    for a, cfg in ACCOUNTS.items():
        if cfg["kind"] != "claude":
            continue
        d = claude_dir(cfg)
        if found and d and os.path.realpath(d) == found:
            return a
    return None if found else active_claude()


# ---------- switching and signing in

def link_shared(target):
    """An extra Claude account's folder: everything of ~/.claude linked in
    (history, settings, skills...) except the sign-in files, so all accounts
    share their conversations."""
    src = os.path.join(HOME, ".claude")
    private = (".claude.json", ".credentials.json", "daemon", "daemon.log", "daemon-auth-cooldown",
               "daemon-auth-status.json", "backups")
    make_dir(target)
    for name in os.listdir(src) if os.path.isdir(src) else []:
        if (name in private or name.startswith(("policy-limits.json", "remote-settings.json", ".."))
                or ".tmp" in name):
            continue
        dst = os.path.join(target, name)
        if not os.path.lexists(dst):
            os.symlink(os.path.join(src, name), dst)


def set_profile(path, profile):
    """Claude's state file `path` (~/.claude.json, or a folder's) shows who is
    signed in. Claude writes this file too: read, change, write at once,
    and left alone when it can't be read."""
    try:
        with open(path) as fh:
            state = json.load(fh)
        if not isinstance(state, dict):
            return
        state["oauthAccount"] = profile
        atomic_write(path, json.dumps(state, indent=2))
    except (OSError, ValueError):
        pass


def set_default_profile(acct):
    """~/.claude.json shows who the default sign-in is."""
    profile = claude_profile(acct)
    if profile:
        set_profile(os.path.join(HOME, ".claude.json"), profile)


def cmd_select(acct):
    write_line(SELECTED_FILE, acct)


def cmd_activate(acct):
    """Every default Claude session moves to this account (no restart)."""
    if ACCOUNTS[acct]["kind"] != "claude":
        sys.exit("activate: not a Claude account")
    current = active_claude()
    if current == acct:
        return
    source = freshest(acct)[1]
    if not source:
        sys.exit(T["err_signin"])
    account_attr = kc_account(DEFAULT_SERVICE)
    # keep the live sign-in (maybe refreshed since) first: for its account, or
    # aside when no account owns it
    live = kc_read(DEFAULT_SERVICE)
    if live:
        kc_write(kept_service(current) if current else unowned_service(DEFAULT_SERVICE), account_attr, live)
    if current:
        try:
            with open(os.path.join(HOME, ".claude.json")) as fh:
                profile = (json.load(fh) or {}).get("oauthAccount")
        except (OSError, ValueError, AttributeError):
            profile = None
        if profile:
            make_dir(PROFILE_DIR)
            atomic_write(os.path.join(PROFILE_DIR, current + ".json"), json.dumps(profile))
    kc_write(DEFAULT_SERVICE, account_attr, source)
    set_default_profile(acct)
    write_line(ACTIVE_FILE, acct)
    expire_fuel(acct)
    cmd_select(acct)


def switch_claude_dir(acct, d):
    """Move the Claudes reading config folder `d` (None: the default) onto `acct`."""
    if not d:
        cmd_activate(acct)  # the default item: every default session moves
        nudge_claude(None)
        return
    if not valid_dir(d):
        sys.exit("That config folder is not one Orcherd can switch.")
    service = dir_service(d)
    owner = slot_owner(service)
    if owner == acct:
        cmd_select(acct)
        return
    source = kc_read(claude_service(acct))
    if not source:
        sys.exit(T["err_signin"])
    account_attr = kc_account(service)
    live = kc_read(service)
    if live:
        # keep the sign-in being replaced (maybe refreshed since): for its
        # account, or aside when no account owns it
        kc_write(kept_service(owner) if owner else unowned_service(service), account_attr, live)
    kc_write(service, account_attr, source)
    slots = read_slots()
    native = next((a for a in claude_accounts() if own_service(ACCOUNTS[a]) == service), None)
    if acct == native:
        slots.pop(service, None)
    else:
        slots[service] = acct
    write_slots(slots)
    # the folder's profile shows who is signed in
    profile = claude_profile(acct)
    state_path = os.path.join(os.path.expanduser(d), ".claude.json")
    if profile and os.path.exists(state_path):
        set_profile(state_path, profile)
    expire_fuel(acct)
    nudge_claude(d)
    cmd_select(acct)


def prepare_sign_in(acct):
    """Before `acct` signs in where Claude will write its sign-in: an account of
    the default folder becomes the active one first (the sign-in there now,
    another account's, is kept for it); an account whose folder another account
    was switched into gets the folder back the same way."""
    cfg = ACCOUNTS[acct]
    service = own_service(cfg)
    if not claude_dir(cfg):
        current = active_claude()
        if current == acct:
            return
        live = kc_read(service)
        if current and live:
            kc_write(kept_service(current), kc_account(service), live)
        write_line(ACTIVE_FILE, acct)
        return
    slots = read_slots()
    owner = slots.get(service)
    if owner and owner != acct:
        live = kc_read(service)
        if live:
            kc_write(kept_service(owner), kc_account(service), live)
        slots.pop(service)
        write_slots(slots)


def publish_sign_in(acct):
    """Claude wrote the new sign-in in the account's own item. Fuel and chats may
    read the account elsewhere (the default item when it is active, the copy
    Orcherd kept when it is not): the new sign-in goes there too."""
    if not kc_read(own_service(ACCOUNTS[acct])):
        return
    sync_claude(acct)  # the new sign-in is the freshest: it reaches every copy
    if acct == active_claude():
        # who signed in may be someone new: forget the profile kept for the account
        with contextlib.suppress(OSError):
            os.remove(os.path.join(PROFILE_DIR, acct + ".json"))
        set_default_profile(acct)


def env_for(acct):
    env = dict(os.environ)
    env.pop("CLAUDE_CONFIG_DIR", None)
    d = claude_dir(ACCOUNTS[acct]) if ACCOUNTS[acct]["kind"] == "claude" else None
    if d:
        env["CLAUDE_CONFIG_DIR"] = d
    return env


def email(acct):
    """Signed-in email of an account, or None (only the email is read)."""
    cfg = ACCOUNTS[acct]
    try:
        if cfg["kind"] == "claude":
            if acct == active_claude():
                return claude_email() or None
            return (claude_profile(acct) or {}).get("emailAddress")
        if cfg["kind"] == "cursor":
            with open(os.path.join(HOME, ".cursor", "cli-config.json")) as fh:
                return (json.load(fh).get("authInfo") or {}).get("email")
        with open(os.path.join(HOME, ".codex", "auth.json")) as fh:
            id_token = (json.load(fh).get("tokens") or {}).get("id_token", "")
        payload = id_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("email")
    except Exception:
        return None


def cmd_login(acct):
    """Sign this account in, in its own folder, with its email filled in. A
    sign-in that doesn't finish (cancelled, the pane closed) puts back which
    account the default sign-in and the folders belong to."""
    cfg = ACCOUNTS[acct]
    label = cfg.get("label") or acct
    shown = str(cfg.get("email") or "").replace("\x1b", "")
    who = f"  →  {shown}" if shown else ""
    print(f"\033[1m  Sign in {label.replace(chr(27), '')}{who}\033[0m")
    print("\033[2m  Your browser opens. Pick the email above.\033[0m\n")
    done = None
    before = None
    # closing the pane ends the sign-in: undo, as for any other unfinished one
    signal.signal(signal.SIGHUP, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        if cfg["kind"] == "claude":
            d = claude_dir(cfg)
            if d:
                link_shared(d)
            with state_lock():
                before = (read_text(ACTIVE_FILE), read_text(SLOTS_FILE))
                prepare_sign_in(acct)
            cmd = ["claude", "auth", "login"] + (["--email", shown] if shown else [])
        else:
            cmd = [AGENTS[cfg["kind"]][0], "login"]
        path = agent_path(cmd[0])
        if not path:
            print(f"  {cmd[0]} is not installed.")
        else:
            done = subprocess.run([path] + cmd[1:], env=env_for(acct))
            _KC_READ.clear()  # Claude wrote the new sign-in meanwhile
    except KeyboardInterrupt:
        done = None
    finally:
        if before is not None:
            with state_lock():
                if done is not None and done.returncode == 0:
                    try:
                        publish_sign_in(acct)
                    except RuntimeError as e:
                        print(f"\n  {e}")
                else:
                    write_line(ACTIVE_FILE, before[0])
                    if before[1] is None:
                        with contextlib.suppress(FileNotFoundError):
                            os.remove(SLOTS_FILE)
                    else:
                        atomic_write(SLOTS_FILE, before[1])
    forget_fuel(acct)
    e = email(acct)
    print(f"\n  {label} ({e or 'not signed in'})")
    try:
        input("\033[2m\n  Enter closes this pane. \033[0m")
    except (EOFError, KeyboardInterrupt):
        pass


MUTATING = ("switch-dir", "activate", "keychain-move")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else ""
    if cmd == "json":
        cmd_json(args[1:] == ["fresh"])
    elif cmd == "whoami" and len(args) > 1:
        for d in args[1:]:
            print(dir_account(None if d == "-" else d) or "")
    elif cmd in MUTATING and (cmd == "keychain-move" or (len(args) > 1 and args[1] in ACCOUNTS)):
        with state_lock():
            if cmd == "switch-dir" and len(args) > 2:
                switch_claude_dir(args[1], None if args[2] == "-" else args[2])
            elif cmd == "activate":
                cmd_activate(args[1])
            elif cmd == "keychain-move":
                cmd_keychain_move()
            else:
                sys.exit(__doc__)
    elif cmd == "link" and len(args) > 1 and args[1] in ACCOUNTS:
        d = claude_dir(ACCOUNTS[args[1]])
        if d:
            link_shared(d)
    elif cmd == "login" and len(args) > 1 and args[1] in ACCOUNTS:
        cmd_login(args[1])
    elif cmd == "keychain":
        print(json.dumps(keychain_state()))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        sys.exit(str(e))
    except subprocess.TimeoutExpired:
        sys.exit("macOS is asking to unlock the Keychain: unlock it, then try again.")
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        # never the data itself: only what kind of thing went wrong
        sys.exit(f"accounts.py failed ({type(e).__name__}).")
