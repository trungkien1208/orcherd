#!/usr/bin/env -S python3 -I
"""Orcherd's side of Token Station: the hub on your LAN that hands your own
Claude setup-tokens to your own machines (repo token-station). Kept apart
from accounts.py on purpose: nothing here runs until this Mac is paired, so
Orcherd without a hub works exactly as before.

  tokenstation.py status                 paired or not, the hub, the last sync (JSON)
  tokenstation.py probe <url>            the hub's cert check, before trusting it (JSON)
  tokenstation.py pair [file]            {url, code, name, pin} in a file (then deleted)
                                         or on stdin: pair this Mac
  tokenstation.py sync                   heartbeat, then the hub's accounts into the cache
  tokenstation.py run <id> [claude args] lease hub account <id>, then become `claude` on it
  tokenstation.py adopt <from> <to> <cwd>  let `claude --continue` in folder <to> find
                                         the chat last had in <from> (- is ~/.claude)
  tokenstation.py forget                 unpair: key, settings, cache and leases gone

On a Mac with no Orcherd, only a terminal (installed by the hub's
/client/install.sh, used as `hubclaude`):

  tokenstation.py list                   the hub's accounts, the day, what this Mac borrows
  tokenstation.py use <id>               borrow: plain `claude` runs on hub account <id>
  tokenstation.py restore                give this Mac its own Claude sign-in back
  tokenstation.py service install|remove the agent that runs `sync` every minute
  tokenstation.py uninstall              restore, unpair, remove the agent and the client

Files: ~/.config/orcherd/station.json (the hub's address, its cert pin, this
Mac's id, the hub's name), the machine key in the Keychain item
"orcherd-station-device", and in ~/.cache/orcherd: station.json (the hub's
accounts, for ACCOUNTS and FUEL), station-leases/<lease>.json (one per pane
on a hub account) and station-usage.json (how far the transcripts were
read). Each hub account gets its own Claude folder,
~/.config/orcherd/station/<id>: ~/.claude's files linked in except
`projects`, so its transcripts, and so its token use, are its own.

The token goes from the hub straight into the env of `claude` (os.execve):
never argv, never a file. So it leaves this Mac when that claude ends, and
Orcherd ends it (and what it started, which has its env) when the lease
ends: at the day's end (even with the hub out of reach), when the hub says
so (Stop on its Live page, account deleted) and when the hub no longer
knows this Mac (revoked).

Borrow (`use`) is the one place a token is written down: as the sign-in of
~/.claude in the Keychain (Claude's own item, "Claude Code-credentials"), so
a plain `claude`, and the ones already running, use the hub account. The
Mac's own sign-in waits in the Keychain item "token-station-borrow-backup"
and goes back on `restore`, at the day's end, on Stop, and when the hub no
longer knows this Mac. The borrowed sign-in also says it expires at the
day's end, so Claude stops using it then even if nothing here runs.

This file's original is token-station's client/tokenstation.py (the hub
serves it to terminal-only Macs); Orcherd's mods/orcha/bin/ has a copy. The machine key lives in the Keychain and reaches
curl on stdin. The hub's cert is pinned (curl --pinnedpubkey) from pairing on.
"""
import base64
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from urllib.parse import urlsplit

HOME = os.path.expanduser("~")
CONFIG_DIR = os.path.join(HOME, ".config", "orcherd")
LINK_FILE = os.path.join(CONFIG_DIR, "station.json")
FOLDERS = os.path.join(CONFIG_DIR, "station")
CACHE = os.path.join(HOME, ".cache", "orcherd")
CACHE_FILE = os.path.join(CACHE, "station.json")
LEASES = os.path.join(CACHE, "station-leases")
USAGE_FILE = os.path.join(CACHE, "station-usage.json")
LIMITS = os.path.join(CACHE, "limits")
ORCHERD_CONFIG = os.path.join(CONFIG_DIR, "config.json")
KC_SERVICE = "orcherd-station-device"
# The sign-in a plain `claude` (config folder ~/.claude) reads, and where a
# borrow keeps the Mac's own while a hub account is in its place.
CLAUDE_SERVICE = "Claude Code-credentials"
BACKUP_SERVICE = "token-station-borrow-backup"
BORROW_FILE = os.path.join(CACHE, "station-borrow.json")
BORROW_LAST = os.path.join(CACHE, "station-borrow-last.json")  # a borrow was restored: watch for it coming back
LOCK_FILE = os.path.join(CACHE, "station.lock")
CLIENT_DIR = os.path.join(HOME, ".local", "share", "token-station-client")
WRAPPER = os.path.join(HOME, ".local", "bin", "hubclaude")
AGENT_LABEL = "com.token-station.client"
AGENT_PLIST = os.path.join(HOME, "Library", "LaunchAgents", f"{AGENT_LABEL}.plist")
DEFAULT_PORT = 8787
TOKEN_FIELDS = ("input", "output", "cache_read", "cache_write")
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
# What Claude Code writes in a transcript when Anthropic refuses its token.
AUTH_FAILED = re.compile(r"\b401\b|Login expired|/login|OAuth token|Invalid API key|authenticat", re.I)
# ~/.claude's files a hub folder must not share: the sign-in and the transcripts.
PRIVATE = (".claude.json", ".credentials.json", "daemon", "daemon.log", "daemon-auth-cooldown",
           "daemon-auth-status.json", "backups", "projects")


class Fail(Exception):
    """A plain sentence for the person: the last line Orcherd shows."""


# ---------- files: private, whole or not at all

def make_dir(d):
    os.makedirs(d, mode=0o700, exist_ok=True)


def read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_json(path, obj):
    make_dir(os.path.dirname(path))
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(obj, fh, indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        with_suppressed(os.remove, tmp)
        raise


def with_suppressed(fn, *a):
    try:
        fn(*a)
    except OSError:
        pass


# ---------- the Keychain: secrets on stdin only
# ORCHERD_STATION_TEST_KEY_FILE: tests only, so they never touch the real
# Keychain (with HOME pointed elsewhere for the files): each item is a file
# next to it, and no launchd agent is loaded.
TEST_KEY_FILE = os.environ.get("ORCHERD_STATION_TEST_KEY_FILE")


def kc_test_path(service):
    return TEST_KEY_FILE if service == KC_SERVICE else f"{TEST_KEY_FILE}-{re.sub(r'[^A-Za-z0-9]+', '_', service)}"


def kc_read(service=KC_SERVICE, strict=False):
    """The item's secret, or None when there is no such item. strict: any
    other failure (a locked Keychain) raises, so it is never taken for "none"
    and acted on (a sign-in deleted because it could not be read)."""
    if TEST_KEY_FILE:
        try:
            with open(kc_test_path(service)) as fh:
                return fh.read().strip() or None
        except OSError:
            return None
    r = subprocess.run(["security", "find-generic-password", "-s", service, "-w"],
                       capture_output=True, text=True, timeout=10)
    if r.returncode == 0:
        return r.stdout.strip() or None
    if strict and r.returncode != 44:  # 44: errSecItemNotFound
        raise Fail("The macOS Keychain can't be read now (locked?): unlock it and try again. Nothing was changed.")
    return None


def kc_account(service):
    """The item's account attribute (Claude writes the user name there)."""
    if TEST_KEY_FILE:
        return os.environ.get("USER", "")
    r = subprocess.run(["security", "find-generic-password", "-s", service],
                       capture_output=True, text=True, timeout=10)
    m = re.search(r'"acct"<blob>="([^"]*)"', r.stdout)
    return m.group(1) if m else os.environ.get("USER", "")


def kc_write(secret, service=KC_SERVICE, account="orcherd"):
    """`security -i` reads the command on stdin, so the secret never shows in
    ps; read back, because `security -i` can fail and still exit 0."""
    if TEST_KEY_FILE:
        path = kc_test_path(service)
        make_dir(os.path.dirname(path))
        with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
            fh.write(secret)
        return
    if not re.fullmatch(r"[\w .@+-]*", account):
        account = os.environ.get("USER", "")
    cmd = f'add-generic-password -U -s "{service}" -a "{account}" -X {secret.encode().hex()}\n'
    r = subprocess.run(["security", "-i"], input=cmd, capture_output=True, text=True, timeout=10)
    if r.returncode != 0 or kc_read(service) != secret:
        if service == KC_SERVICE:
            raise Fail("The machine key could not go in the macOS Keychain (locked?). Unlock it and pair again.")
        raise Fail("The macOS Keychain could not be written (locked?). Unlock it and try again.")


def kc_delete(service=KC_SERVICE):
    if TEST_KEY_FILE:
        with_suppressed(os.remove, kc_test_path(service))
        return
    subprocess.run(["security", "delete-generic-password", "-s", service],
                   capture_output=True, timeout=10)


# ---------- the hub

def hub_url(text):
    """https://host:port from what a person typed (host, host:port, or a URL)."""
    text = (text or "").strip()
    if not text:
        raise Fail("Type the hub's address, like kien-mac.local:8787.")
    u = urlsplit(text if "://" in text else f"https://{text}")
    if u.scheme != "https" or not u.hostname:
        raise Fail("The hub talks HTTPS only: https://<host>:<port>.")
    host = f"[{u.hostname}]" if ":" in u.hostname else u.hostname
    return f"https://{host}:{u.port or DEFAULT_PORT}"


def pin_of_der(der):
    """sha256 of a cert's public key (curl's --pinnedpubkey form), from its DER."""
    p = subprocess.run(["openssl", "x509", "-inform", "DER", "-pubkey", "-noout"],
                       input=der, capture_output=True, timeout=15)
    if p.returncode != 0:
        raise Fail("The hub's cert could not be read.")
    body = "".join(l for l in p.stdout.decode().splitlines() if l and not l.startswith("-----"))
    return "sha256//" + base64.b64encode(hashlib.sha256(base64.b64decode(body)).digest()).decode()


def check_of(pin):
    """The first 64 bits of the pin, as the hub's Machines page shows them."""
    h = base64.b64decode(pin.split("//", 1)[1]).hex().upper()
    return " ".join(h[i:i + 4] for i in range(0, 16, 4))


def request(link, method, path, body=None, key=None, pin=None):
    """(status, JSON) from the hub, through curl with the cert pinned. The
    machine key (and any body) go in curl's config on stdin, never argv."""
    cfg = ['header = "Content-Type: application/json"']
    if key:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", key):
            raise Fail("The machine key in the Keychain is damaged: pair again.")
        cfg.append(f'header = "Authorization: Bearer {key}"')
    if body is not None:
        data = json.dumps(body).replace("\\", "\\\\").replace('"', '\\"')
        cfg.append(f'data = "{data}"')
    cfg.append(f'request = "{method}"')
    cfg.append('write-out = "\\n%{http_code}"')
    r = subprocess.run(["curl", "-sS", "-m", "15", "-k", "--pinnedpubkey", pin or link["pin"], "-K", "-",
                        link["url"] + path],
                       input="\n".join(cfg) + "\n", capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        if "pinned" in r.stderr.lower() or r.returncode == 90:
            raise Fail("The hub's cert is not the one paired: stop, something may be in between. "
                       "If the hub made a new cert, pair again.")
        raise Fail(f"The hub at {link['url']} did not answer ({r.stderr.strip()[:80]}).")
    text, _, code = r.stdout.rpartition("\n")
    try:
        return int(code), (json.loads(text) if text.strip() else {})
    except ValueError:
        return int(code or 0), {}


def why(out, fallback):
    return (out or {}).get("error") or fallback


# ---------- commands

def cmd_status():
    link = read_json(LINK_FILE)
    cache = read_json(CACHE_FILE) or {}
    if not link:
        print(json.dumps({"paired": False}))
        return
    print(json.dumps({"paired": True, "url": link["url"], "hub_name": cache.get("hub_name") or link.get("hub_name"),
                      "check": check_of(link["pin"]), "machine_id": link.get("machine_id"),
                      "synced_at": cache.get("at"), "error": cache.get("error"), "grant": cache.get("grant")}))


def cmd_probe(url):
    """The cert the hub shows now, for the person to compare with the hub's page."""
    url = hub_url(url)
    u = urlsplit(url)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # nothing is sent: the cert is only read, then checked by a person
    try:
        with socket.create_connection((u.hostname, u.port), timeout=8) as s:
            with ctx.wrap_socket(s, server_hostname=u.hostname) as t:
                der = t.getpeercert(binary_form=True)
    except OSError as e:
        raise Fail(f"No hub answered at {url} ({e.strerror or e}).")
    pin = pin_of_der(der)
    print(json.dumps({"url": url, "pin": pin, "check": check_of(pin)}))


def cmd_pair(path=None):
    # From a file the app wrote in ~/.cache/orcherd (0700) and gone at once:
    # the app can't give a child stdin, and the code stays out of argv.
    try:
        if path:
            with open(path) as fh:
                text = fh.read()
            os.remove(path)
        else:
            text = sys.stdin.read()
        req = json.loads(text)
    except (OSError, ValueError):
        raise Fail("pair reads {url, code, name, pin} from a file or stdin.")
    url, pin = hub_url(req.get("url")), req.get("pin") or ""
    code = re.sub(r"\D", "", str(req.get("code") or ""))
    if not re.fullmatch(r"sha256//[A-Za-z0-9+/=]{40,}", pin):
        raise Fail("Check the hub's cert first (probe).")
    if len(code) != 6:
        raise Fail("The pairing code is the 6 digits on the hub's Machines page.")
    name = (req.get("name") or socket.gethostname().split(".")[0])[:64]
    link = {"url": url, "pin": pin}
    status, out = request(link, "POST", "/api/v1/pair", {"code": code, "name": name})
    if status != 201:
        raise Fail(why(out, f"The hub said no ({status})."))
    kc_write(out["key"])
    link.update(machine_id=out["machine_id"], hub_name=out.get("hub_name"), paired_at=time.time())
    write_json(LINK_FILE, link)
    sync(link)
    print(json.dumps({"hub_name": out.get("hub_name"), "machine_id": out["machine_id"]}))


def cmd_forget():
    """Unpairs this Mac. The hub accounts' folders stay: their chats are yours."""
    kc_delete()
    for f in (LINK_FILE, CACHE_FILE, USAGE_FILE):
        with_suppressed(os.remove, f)
    shutil.rmtree(LEASES, ignore_errors=True)


# ---------- a hub account's folder

def prepare_folder(aid):
    """~/.config/orcherd/station/<id>: ~/.claude's files linked in (settings,
    skills, history...) except the sign-in and the transcripts."""
    folder = os.path.join(FOLDERS, aid)
    make_dir(folder)
    make_dir(os.path.join(folder, "projects"))
    src = os.path.join(HOME, ".claude")
    for name in os.listdir(src) if os.path.isdir(src) else []:
        if (name in PRIVATE or name.startswith(("policy-limits.json", "remote-settings.json", ".."))
                or ".tmp" in name):
            continue
        dst = os.path.join(folder, name)
        if not os.path.lexists(dst):
            os.symlink(os.path.join(src, name), dst)
    # A new folder would open on Claude's first-run screens: say they were seen.
    state = os.path.join(folder, ".claude.json")
    if not os.path.exists(state):
        theme = (read_json(os.path.join(HOME, ".claude.json")) or {}).get("theme")
        write_json(state, {"hasCompletedOnboarding": True, **({"theme": theme} if theme else {})})
    return folder


def projects_of(folder):
    """The real transcripts folder a Claude config folder writes to (- is ~/.claude)."""
    base = os.path.join(HOME, ".claude") if folder in ("-", "") else os.path.expanduser(folder)
    return os.path.realpath(os.path.join(base, "projects"))


def cmd_adopt(src, dst, cwd):
    """`claude --continue` in `dst` continues the newest chat of `cwd` it can
    see. A hub folder sees only its own, so the chat last had in `src` is
    linked into it (Claude then writes on through the link)."""
    a, b = projects_of(src), projects_of(dst)
    if a == b:
        return
    slug = re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(cwd))
    try:
        chats = [os.path.join(a, slug, f) for f in os.listdir(os.path.join(a, slug)) if f.endswith(".jsonl")]
    except OSError:
        return
    if not chats:
        return
    newest = max(chats, key=os.path.getmtime)
    make_dir(os.path.join(b, slug))
    link = os.path.join(b, slug, os.path.basename(newest))
    if not os.path.lexists(link):
        os.symlink(os.path.realpath(newest), link)
    os.utime(link, follow_symlinks=True)  # the newest one there, for --continue


def wait_enter(text):
    """A pane that would vanish says why first."""
    sys.stderr.write(f"\n{text}\n\nEnter closes this pane. ")
    sys.stderr.flush()
    with_suppressed(lambda: sys.stdin.readline())
    sys.exit(1)


def cmd_run(aid, args):
    if not re.fullmatch(r"\d{1,9}", aid):
        wait_enter("Token Station: that is not a hub account.")
    link = read_json(LINK_FILE)
    if not link:
        wait_enter("Token Station: this Mac isn't paired with a hub (Settings › Accounts › Token Station).")
    key = kc_read()
    if not key:
        wait_enter("Token Station: the machine key is not in the Keychain. Pair this Mac again.")
    claude = shutil.which("claude")
    if not claude:
        wait_enter("Token Station: the claude command is not installed.")
    folder = prepare_folder(aid)
    pane, cwd = os.environ.get("HC_TERMINAL_ID", ""), os.getcwd()
    try:
        status, out = request(link, "POST", f"/api/v1/accounts/{aid}/lease",
                              {"pane": pane[:200], "cwd": cwd[:1024]}, key=key)
    except Fail as e:
        wait_enter(f"Token Station: {e}")
    if status != 201:
        held = "".join(f"\n  · {l.get('machine')} {l.get('pane') or ''} {l.get('cwd') or ''}" for l in out.get("leases", []))
        wait_enter(f"Token Station: {why(out, f'the hub said no ({status})')}.{held}")
    token = out["token"]
    write_json(os.path.join(LEASES, f"{out['lease_id']}.json"),
               {"lease_id": out["lease_id"], "account": aid, "pid": os.getpid(), "folder": folder,
                "started": time.time(), "ends_at": out.get("ends_at"), "pane": pane, "cwd": cwd,
                "tokens": [0, 0, 0, 0]})
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    env.update(CLAUDE_CONFIG_DIR=folder, CLAUDE_CODE_OAUTH_TOKEN=token)
    # The same process becomes claude: the lease file's pid is claude's pid.
    os.execve(claude, ["claude", *args], env)


# ---------- sync: the heartbeat and the hub's accounts

def alive(lease):
    """Whether the lease's claude still runs: its pid, with this folder in its env
    (ps -E), so a reused pid is not taken for it."""
    r = subprocess.run(["ps", "-E", "-ww", "-o", "command=", "-p", str(lease["pid"])],
                       capture_output=True, text=True, timeout=10)
    # The whole value: station/1 must not match a claude of station/12.
    return r.returncode == 0 and re.search(rf"(^|\s)CLAUDE_CONFIG_DIR={re.escape(lease['folder'])}(\s|$)",
                                           r.stdout) is not None


def running(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True  # there, but not ours to signal
    return True


def tree(pid):
    """pid and every process under it: claude's tools, shells and MCP servers
    inherit its env, token included, so they go with it."""
    r = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=10)
    kids = {}
    for line in r.stdout.splitlines():
        try:
            p, pp = (int(x) for x in line.split())
        except ValueError:
            continue
        kids.setdefault(pp, []).append(p)
    out, todo = [], [pid]
    while todo:
        p = todo.pop()
        out.append(p)
        todo += kids.get(p, [])
    return out


def stop(lease, why="its hub lease ended"):
    """Ends the lease's claude and everything under it, so its token is gone
    from this Mac. The chat stays on disk: Restart goes on with it. The
    pane's terminal is told why, or it would just go quiet."""
    if not alive(lease):
        return
    r = subprocess.run(["ps", "-o", "tty=", "-p", str(lease["pid"])], capture_output=True, text=True, timeout=10)
    tty = r.stdout.strip() if r.returncode == 0 else ""
    pids = tree(lease["pid"])
    try:
        stop_pids(pids)
    finally:
        if re.fullmatch(r"ttys?\d+", tty):
            try:
                # O_NOCTTY: the agent has no terminal and must not take this one.
                fd = os.open(f"/dev/{tty}", os.O_WRONLY | os.O_NOCTTY)
                with os.fdopen(fd, "w") as fh:
                    fh.write(f"\r\n\r\n[Token Station] claude stopped: {why}. The chat is kept: "
                             "restart on the account while the hub's day is on.\r\n")
            except OSError:
                pass


def stop_pids(pids):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for p in pids:
            with_suppressed(os.kill, p, sig)
        deadline = time.time() + 5
        while time.time() < deadline and any(running(p) for p in pids):
            time.sleep(0.2)
        pids = [p for p in pids if running(p)]
        if not pids:
            return


def read_leases():
    if not os.path.isdir(LEASES):
        return []
    return [l for l in (read_json(os.path.join(LEASES, f)) for f in sorted(os.listdir(LEASES))
                        if f.endswith(".json")) if l]


def iso(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def read_transcripts(folder, since, usage):
    """New lines of every transcript in a hub folder since the last read:
    (token totals, whether a refused token showed). A message's usage is
    written on several lines with the same id: it counts once. Lines older
    than `since` (the oldest live lease) don't count: a chat adopted from
    elsewhere brings its past."""
    totals, failed = [0, 0, 0, 0], False
    files = usage.setdefault("files", {})
    for root, _dirs, names in os.walk(os.path.join(folder, "projects"), followlinks=True):
        for n in names:
            if not n.endswith(".jsonl"):
                continue
            path = os.path.join(root, n)
            st = files.setdefault(path, {"offset": 0, "ino": None, "id": None, "last": [0, 0, 0, 0], "tot": [0, 0, 0, 0]})
            try:
                info = os.stat(path)
                # Another file under the same name, or one cut shorter: read it from the start.
                if info.st_ino != st.get("ino") or info.st_size < st["offset"]:
                    st.update(offset=0, ino=info.st_ino, id=None, last=[0, 0, 0, 0], tot=[0, 0, 0, 0])
                with open(path, "rb") as fh:
                    fh.seek(st["offset"])
                    chunk = fh.read()
            except OSError:
                continue
            end = chunk.rfind(b"\n") + 1  # a line still being written waits for the next read
            for raw in chunk[:end].splitlines():
                try:
                    d = json.loads(raw)
                except ValueError:
                    continue
                ts = iso(d.get("timestamp"))
                # 5 s of slack: transcript times may be cut to the second.
                if ts is not None and ts < since - 5:
                    continue
                m = d.get("message") if isinstance(d.get("message"), dict) else {}
                if d.get("isApiErrorMessage"):
                    c = m.get("content")
                    text = c[0].get("text", "") if isinstance(c, list) and c and isinstance(c[0], dict) else str(c or "")
                    if AUTH_FAILED.search(f"{d.get('apiError') or ''} {text}"):
                        failed = True
                u = m.get("usage")
                if d.get("type") == "assistant" and isinstance(u, dict) and m.get("id"):
                    now = [int(u.get(k) or 0) for k in USAGE_KEYS]
                    if m["id"] == st["id"]:
                        st["last"] = [max(a, b) for a, b in zip(st["last"], now)]
                    else:
                        st["tot"] = [a + b for a, b in zip(st["tot"], st["last"])]
                        st["id"], st["last"] = m["id"], now
            st["offset"] += end
            totals = [t + a + b for t, a, b in zip(totals, st["tot"], st["last"])]
    return totals, failed


def local_fuel(hub_emails):
    """Fuel this Mac read for its own Claude accounts whose email is a hub
    account's: the hub can't read it with a setup-token. No other email leaves."""
    out = {}
    for a in (read_json(ORCHERD_CONFIG) or {}).get("accounts", []):
        if not isinstance(a, dict) or a.get("kind") != "claude":
            continue
        email = (a.get("email") or "").strip().lower()
        if not email:
            folder = os.path.expanduser(a["dir"]) if a.get("dir") else None
            email = ((read_json(os.path.join(folder, ".claude.json") if folder else os.path.join(HOME, ".claude.json"))
                      or {}).get("oauthAccount") or {}).get("emailAddress", "").lower()
        if email not in hub_emails or not re.fullmatch(r"[A-Za-z0-9_.-]+", str(a.get("id", ""))):
            continue
        fuel = read_json(os.path.join(LIMITS, f"{a['id']}.json")) or {}
        part = {k: fuel[k] for k in ("session", "weekly") if isinstance(fuel.get(k), list) and len(fuel[k]) == 2}
        if part:
            out[email] = part
    return out


class locked:
    """One of sync / use / restore at a time: the agent's minute and Orcherd's
    fuel tick may both sync while the person types `hubclaude use`."""

    def __enter__(self):
        make_dir(CACHE)
        self.fh = open(LOCK_FILE, "a")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()


def sync(link):
    """One tick: the hub's accounts (for ACCOUNTS), then a heartbeat with every
    pane still running on a hub account, the tokens their chats spent, a
    refused token, and this Mac's fuel for the same Claude accounts. A pane
    that ended is released. A lease that ended, here or on the hub, stops its
    pane."""
    leases = read_leases()
    # The day's end holds even when the hub is out of reach: the pane stops,
    # and is released below once the hub answers.
    for l in leases:
        if isinstance(l.get("ends_at"), (int, float)) and time.time() >= l["ends_at"]:
            stop(l, "the hub's day is over")
    sweep_borrow()
    b = borrowed()
    if b and time.time() >= b.get("ends_at", 0):
        restore()  # the day is over: the hub ended that lease already
        b = None
    key = kc_read()
    cache = read_json(CACHE_FILE) or {}
    if not key:
        cache.update(at=time.time(), error="The machine key is not in the Keychain: pair this Mac again.")
        write_json(CACHE_FILE, cache)
        return
    try:
        status, out = request(link, "GET", "/api/v1/accounts", key=key)
    except Fail as e:
        cache.update(at=time.time(), error=str(e), grant={"open": False, "ends_at": None})
        write_json(CACHE_FILE, cache)
        return
    if status == 401:
        # Revoked (or the hub was set up again): every hub token leaves this Mac.
        for l in leases:
            stop(l, "this Mac was revoked on the hub")
            with_suppressed(os.remove, os.path.join(LEASES, f"{l['lease_id']}.json"))
        restore()
        cache.update(at=time.time(), error="This Mac was revoked on the hub: pair it again.", accounts=[],
                     grant={"open": False, "ends_at": None})
        write_json(CACHE_FILE, cache)
        return
    if status != 200:
        cache.update(at=time.time(), error=why(out, f"The hub answered {status}."))
        write_json(CACHE_FILE, cache)
        return
    accounts = out.get("accounts", [])
    write_json(CACHE_FILE, {"at": time.time(), "error": None, "hub_name": out.get("hub_name"),
                            "grant": out.get("grant"), "accounts": accounts})

    gone, live = [], []
    for l in leases:
        (live if alive(l) else gone).append(l)
    for l in gone:
        try:
            request(link, "POST", "/api/v1/release", {"lease_id": l["lease_id"]}, key=key)
        except Fail:
            continue  # the hub ends it after 90 s anyway; try again next tick
        with_suppressed(os.remove, os.path.join(LEASES, f"{l['lease_id']}.json"))

    # Tokens: per hub account, what its folder's transcripts grew by since the
    # last tick, all on its oldest live lease (the hub keeps per-lease totals,
    # so a share split between panes would count twice).
    usage = read_json(USAGE_FILE) or {}
    sent = usage.setdefault("sent", {})
    items = []
    by_account = {}
    for l in live:
        by_account.setdefault(l["account"], []).append(l)
    for aid, ls in by_account.items():
        ls.sort(key=lambda l: l["lease_id"])
        totals, failed = read_transcripts(ls[0]["folder"], min(l["started"] for l in ls), usage)
        before = sent.get(aid, [0, 0, 0, 0])
        grew = [max(0, t - b) for t, b in zip(totals, before)]
        sent[aid] = totals
        first = ls[0]
        first["tokens"] = [a + b for a, b in zip(first.get("tokens", [0, 0, 0, 0]), grew)]
        write_json(os.path.join(LEASES, f"{first['lease_id']}.json"), first)
        for l in ls:
            items.append({"lease_id": l["lease_id"], "pane": l.get("pane", ""), "cwd": l.get("cwd", ""),
                          **({"tokens": dict(zip(TOKEN_FIELDS, l["tokens"]))} if l is first else {}),
                          **({"auth_failed": True} if failed and l is first else {})})
    if b:
        # Borrowed: every chat of ~/.claude since the borrow began is the hub account's.
        totals, failed = read_transcripts(os.path.join(HOME, ".claude"), b["started"], usage.setdefault("borrow", {}))
        before = sent.get("borrow", [0, 0, 0, 0])
        b["tokens"] = [a + max(0, t - x) for a, t, x in zip(b.get("tokens", [0, 0, 0, 0]), totals, before)]
        sent["borrow"] = totals
        write_json(BORROW_FILE, b)
        items.append({"lease_id": b["lease_id"], "pane": "borrow", "cwd": HOME,
                      "tokens": dict(zip(TOKEN_FIELDS, b["tokens"])), **({"auth_failed": True} if failed else {})})
    write_json(USAGE_FILE, usage)
    emails = {(a.get("email") or "").lower() for a in accounts if a.get("email")}
    try:
        status, out = request(link, "POST", "/api/v1/heartbeat",
                              {"leases": items, "fuel": local_fuel(emails)}, key=key)
    except Fail:
        return
    if status != 200:
        return
    ended = set(out.get("ended", []))
    grant = out.get("grant") or {}
    if b and b["lease_id"] in ended:
        restore()
    elif b and grant.get("open") and isinstance(grant.get("ends_at"), (int, float)) \
            and grant["ends_at"] != b.get("ends_at"):
        move_borrow_end(b, grant["ends_at"])
    for l in live:
        if l["lease_id"] in ended:
            stop(l, "the hub ended its lease (Stop, the day's end, or the account removed)")
            with_suppressed(os.remove, os.path.join(LEASES, f"{l['lease_id']}.json"))
        elif grant.get("open") and isinstance(grant.get("ends_at"), (int, float)) \
                and grant["ends_at"] != l.get("ends_at"):
            # Start day again while it is open moves its end: so do the leases'.
            l["ends_at"] = grant["ends_at"]
            write_json(os.path.join(LEASES, f"{l['lease_id']}.json"), l)


def cmd_sync():
    link = read_json(LINK_FILE)
    if link:  # not paired: nothing to do, nothing to say
        with locked():
            sync(link)
    elif borrowed():
        with locked():
            restore()  # unpaired while borrowing: the Mac's own sign-in comes back


# ---------- borrow: a hub account in the place of this Mac's own sign-in

def borrowed():
    return read_json(BORROW_FILE)


def item_json(raw):
    try:
        o = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        return {}
    return o if isinstance(o, dict) else {}


def oauth_of(raw):
    o = item_json(raw).get("claudeAiOauth")
    return o if isinstance(o, dict) else None


def is_borrowed_sign_in(raw):
    """Claude's own sign-ins always carry a refresh token; a borrowed one never."""
    o = oauth_of(raw)
    return o is not None and not o.get("refreshToken")


def is_own_sign_in(raw):
    o = oauth_of(raw)
    return o is not None and bool(o.get("refreshToken"))


def borrow_sign_in(token, ends_at, live):
    """The item as it is (Claude keeps MCP sign-ins in it too) with only the
    Claude sign-in swapped for one made of the setup-token: no refresh token
    (it can't be refreshed, and needn't be), and it ends with the day."""
    o = item_json(live)
    o["claudeAiOauth"] = {"accessToken": token, "refreshToken": None,
                          "expiresAt": int(ends_at * 1000), "scopes": ["user:inference"]}
    return json.dumps(o)


def move_borrow_end(b, ends_at):
    """Start day again moved the day's end: so does the borrowed sign-in's."""
    raw = kc_read(CLAUDE_SERVICE)
    if raw and is_borrowed_sign_in(raw):
        o = item_json(raw)
        o["claudeAiOauth"]["expiresAt"] = int(ends_at * 1000)
        kc_write(json.dumps(o), CLAUDE_SERVICE, b.get("kc_account", ""))
    b["ends_at"] = ends_at
    write_json(BORROW_FILE, b)


def put_back(live, account):
    """The borrowed Claude sign-in out of the item, the kept one in (or none,
    when the Mac had none). Other keys (MCP sign-ins made meanwhile) stay.
    The kept one stays kept: a claude still holding the borrowed sign-in
    could write it back, and sweep_borrow then puts this one back again."""
    kept = kc_read(BACKUP_SERVICE, strict=True)
    o = item_json(live)
    if kept and oauth_of(kept):
        o["claudeAiOauth"] = oauth_of(kept)
        kc_write(json.dumps(o), CLAUDE_SERVICE, account)
    else:
        o.pop("claudeAiOauth", None)
        if o:
            kc_write(json.dumps(o), CLAUDE_SERVICE, account)
        else:
            kc_delete(CLAUDE_SERVICE)


def restore(link=None, key=None):
    """This Mac's own sign-in back in its place, the borrowed one gone, the
    lease released (when link and key are given; else the hub has ended it or
    ends it in 90 s). True when something was borrowed."""
    b = borrowed()
    if not b:
        return False
    live = kc_read(CLAUDE_SERVICE, strict=True)
    note = None
    if is_own_sign_in(live) and oauth_of(live) == oauth_of(kc_read(BACKUP_SERVICE, strict=True)):
        pass  # the borrow never got in place: the Mac's own is there
    elif is_own_sign_in(live):
        # Signed in again (/login) while borrowing: that sign-in is the one in
        # use now; the kept one stays aside, for the person to decide.
        note = "A new sign-in was made while borrowing: it stays; the old one is kept in the Keychain item " \
               f"\"{BACKUP_SERVICE}\"."
    else:
        put_back(live, b.get("kc_account", ""))
    write_json(BORROW_LAST, {"restored": time.time(), "kc_account": b.get("kc_account", "")})
    with_suppressed(os.remove, BORROW_FILE)
    if link and key:
        try:
            request(link, "POST", "/api/v1/release", {"lease_id": b["lease_id"]}, key=key)
        except Fail:
            pass  # the hub ends it after 90 s without a heartbeat
    if note:
        sys.stderr.write(note + "\n")
    return True


def sweep_borrow():
    """No borrow on, yet a borrowed sign-in in Claude's item: a claude that
    still held it wrote it back after a restore. The Mac's own goes back."""
    last = read_json(BORROW_LAST)
    if not last or borrowed():
        return
    try:
        live = kc_read(CLAUDE_SERVICE, strict=True)
        if is_borrowed_sign_in(live):
            put_back(live, last.get("kc_account", ""))
    except Fail:
        pass  # a locked Keychain: next minute


def linked():
    link, key = read_json(LINK_FILE), kc_read()
    if not link or not key:
        raise Fail("This Mac isn't paired with a hub: run the command from the hub's Machines › Add machine page.")
    return link, key


def when(ts):
    return datetime.fromtimestamp(ts).strftime("%H:%M") if isinstance(ts, (int, float)) else "?"


def cmd_list():
    link, _ = linked()
    with locked():
        sync(link)
    cache = read_json(CACHE_FILE) or {}
    grant = cache.get("grant") or {}
    print(f"Hub {cache.get('hub_name') or link.get('hub_name') or link['url']}: "
          + (f"day open until {when(grant.get('ends_at'))}" if grant.get("open") else "day off (Start day on the hub)"))
    if cache.get("error"):
        print(f"  {cache['error']}")
    for a in cache.get("accounts", []):
        state = ("disabled" if not a.get("enabled") else "needs renew" if a.get("needs_renew")
                 else f"limit {a.get('live_leases')}/{a['max_leases']}"
                 if a.get("max_leases") is not None and a.get("live_leases", 0) >= a["max_leases"]
                 else "ready" if grant.get("open") else "day off")
        fuel = (a.get("fuel") or {}).get("session")
        fuel = f"  5h {fuel[0]:.0f}%" if isinstance(fuel, list) and fuel and fuel[0] is not None else ""
        print(f"  {a['id']:>3}  {a.get('label', '')[:20]:<20} {(a.get('email') or '')[:30]:<30} {state}{fuel}")
    b = borrowed()
    print(f"\nBorrowing {b.get('label') or b['account']} until {when(b.get('ends_at'))}: `hubclaude restore` gives the Mac its own sign-in back."
          if b else "\n`hubclaude use <id>`: plain `claude` runs on that account until the day ends.")


def cmd_use(aid):
    if not re.fullmatch(r"\d{1,9}", aid):
        raise Fail("hubclaude use <id>: the id `hubclaude` lists.")
    link, key = linked()
    if os.path.exists(os.path.join(HOME, ".claude", ".credentials.json")):
        raise Fail("Claude keeps this Mac's sign-in in ~/.claude/.credentials.json, not the Keychain, so it "
                   "can't be swapped. `hubclaude run <id>` starts one claude on the hub account instead.")
    with locked():
        b = borrowed()
        if b and str(b["account"]) == aid:
            print(f"Already on {b.get('label') or aid} until {when(b.get('ends_at'))}.")
            return
        if b:
            restore(link, key)
        status, out = request(link, "POST", f"/api/v1/accounts/{aid}/lease", {"pane": "borrow", "cwd": HOME}, key=key)
        if status != 201:
            held = "".join(f"\n  · {l.get('machine')} {l.get('pane') or ''}" for l in out.get("leases", []))
            raise Fail(f"{why(out, f'The hub said no ({status}).')}{held}")
        token, ends_at = out["token"], out.get("ends_at") or time.time() + 8 * 3600
        label = next((a.get("label") for a in (read_json(CACHE_FILE) or {}).get("accounts", [])
                      if str(a.get("id")) == aid), None)
        try:
            live = kc_read(CLAUDE_SERVICE, strict=True)
            account = kc_account(CLAUDE_SERVICE)
            # The Mac's own sign-in goes aside first; if that fails, nothing changed.
            # It always replaces what was aside: an older one may hold a refresh
            # token rotated since. With no sign-in now, nothing is kept: an old
            # one must not come back at restore. A borrowed one in place (a
            # borrow cut short) leaves the kept one alone: that is the Mac's own.
            if is_own_sign_in(live):
                kc_write(live, BACKUP_SERVICE, account)
            elif not is_borrowed_sign_in(live):
                kc_delete(BACKUP_SERVICE)
            write_json(BORROW_FILE, {"lease_id": out["lease_id"], "account": aid, "label": label,
                                     "ends_at": ends_at, "started": time.time(), "kc_account": account,
                                     "tokens": [0, 0, 0, 0]})
            kc_write(borrow_sign_in(token, ends_at, live), CLAUDE_SERVICE, account)
        except Exception:
            restore(link, key)
            raise
        # Token use counts from now: the chats already there are the Mac's own.
        usage = read_json(USAGE_FILE) or {}
        files = {}
        for root, _dirs, names in os.walk(os.path.join(HOME, ".claude", "projects")):
            for n in names:
                if n.endswith(".jsonl"):
                    try:
                        st = os.stat(os.path.join(root, n))
                    except OSError:
                        continue
                    files[os.path.join(root, n)] = {"offset": st.st_size, "ino": st.st_ino, "id": None,
                                                    "last": [0, 0, 0, 0], "tot": [0, 0, 0, 0]}
        usage["borrow"] = {"files": files}
        usage.setdefault("sent", {})["borrow"] = [0, 0, 0, 0]
        write_json(USAGE_FILE, usage)
    print(f"Plain `claude` now runs on {label or 'hub account ' + aid} until {when(ends_at)} (the day's end); "
          "ones already running switch within half a minute.\n"
          "`hubclaude restore` gives this Mac its own sign-in back (it also comes back by itself when the day ends).")


def cmd_restore():
    link, key = read_json(LINK_FILE), kc_read()
    with locked():
        done = restore(link, key) if link and key else restore()
    print("This Mac's own Claude sign-in is back; running claudes switch within half a minute."
          if done else "Nothing borrowed: this Mac is on its own sign-in.")


# ---------- the agent: sync every minute, for a Mac with no Orcherd

def cmd_service(action, python=None):
    if action == "install":
        from xml.sax.saxutils import escape
        # The python install.sh found on PATH (a stable link, like Homebrew's
        # bin/python3), not sys.executable, which can be a versioned path an
        # upgrade removes.
        py = python or os.environ.get("STATION_PYTHON") or sys.executable
        logs = os.path.join(HOME, "Library", "Logs", "token-station-client.log")
        text = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>{escape(py)}</string><string>-I</string><string>{escape(os.path.abspath(__file__))}</string><string>sync</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{escape(logs)}</string>
  <key>StandardErrorPath</key><string>{escape(logs)}</string>
</dict></plist>
"""
        os.makedirs(os.path.dirname(AGENT_PLIST), exist_ok=True)
        with open(AGENT_PLIST, "w") as fh:
            fh.write(text)
    elif action != "remove":
        raise Fail("tokenstation.py service install | remove")
    uid = os.getuid()
    target = f"gui/{uid}/{AGENT_LABEL}"
    if not TEST_KEY_FILE:  # tests: the plist only, never a real agent
        subprocess.run(["launchctl", "bootout", target], capture_output=True, timeout=20)
        # bootout returns before the agent is gone; bootstrap before that fails (5).
        for _ in range(50):
            if subprocess.run(["launchctl", "print", target], capture_output=True, timeout=10).returncode != 0:
                break
            time.sleep(0.1)
    if action == "remove":
        with_suppressed(os.remove, AGENT_PLIST)
    elif not TEST_KEY_FILE:
        for attempt in range(5):
            r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", AGENT_PLIST], capture_output=True, text=True, timeout=20)
            if r.returncode == 0:
                break
            time.sleep(1)
        else:
            raise Fail(f"launchctl could not start the agent: {r.stderr.strip()[:120]}")


def cmd_uninstall():
    """Everything back as before the install: own sign-in, no pairing, no
    agent, no client. The hub still lists this Mac: revoke it there."""
    link, key = read_json(LINK_FILE), kc_read()
    with locked():
        if link and key:
            restore(link, key)
        else:
            restore()
        for l in read_leases():
            stop(l)
            if link and key:
                try:
                    request(link, "POST", "/api/v1/release", {"lease_id": l["lease_id"]}, key=key)
                except Fail:
                    pass
        # The kept copy is only needed while a borrowed sign-in could come back.
        try:
            kept = kc_read(BACKUP_SERVICE, strict=True)
            if kept and oauth_of(kept) == oauth_of(kc_read(CLAUDE_SERVICE, strict=True)):
                kc_delete(BACKUP_SERVICE)
        except Fail:
            pass
        with_suppressed(os.remove, BORROW_LAST)
    cmd_service("remove")
    cmd_forget()
    with_suppressed(os.remove, LOCK_FILE)
    try:
        with open(WRAPPER) as fh:
            ours = CLIENT_DIR in fh.read()
    except OSError:
        ours = False
    if ours:
        with_suppressed(os.remove, WRAPPER)
    if os.path.dirname(os.path.abspath(__file__)) == CLIENT_DIR:
        shutil.rmtree(CLIENT_DIR, ignore_errors=True)
    print("Token Station is off this Mac: its own Claude sign-in is back, the agent and the client are gone.\n"
          "Revoke this Mac on the hub's Machines page too.")
    if kc_read(BACKUP_SERVICE):
        print(f"An older sign-in is still kept in the Keychain item \"{BACKUP_SERVICE}\" (a /login made while "
              f"borrowing took its place). Delete it when you don't need it: "
              f"security delete-generic-password -s \"{BACKUP_SERVICE}\"")


def main(argv):
    cmd, rest = (argv[1], argv[2:]) if len(argv) > 1 else ("", [])
    try:
        if cmd == "status":
            cmd_status()
        elif cmd == "probe" and len(rest) == 1:
            cmd_probe(rest[0])
        elif cmd == "pair" and len(rest) <= 1:
            cmd_pair(*rest)
        elif cmd == "sync":
            cmd_sync()
        elif cmd == "run" and rest:
            cmd_run(rest[0], rest[1:])
        elif cmd == "adopt" and len(rest) == 3:
            cmd_adopt(*rest)
        elif cmd == "forget":
            cmd_forget()
        elif cmd == "list" and not rest:
            cmd_list()
        elif cmd == "use" and len(rest) == 1:
            cmd_use(rest[0])
        elif cmd == "restore" and not rest:
            cmd_restore()
        elif cmd == "service" and len(rest) in (1, 2):
            cmd_service(*rest)
        elif cmd == "uninstall" and not rest:
            cmd_uninstall()
        else:
            sys.exit("\n\n".join(p for p in __doc__.split("\n\n") if p.lstrip().startswith("tokenstation.py")))
    except Fail as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main(sys.argv)
