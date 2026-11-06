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

Files: ~/.config/orcherd/station.json (the hub's address, its cert pin, this
Mac's id, the hub's name), the machine key in the Keychain item
"orcherd-station-device", and in ~/.cache/orcherd: station.json (the hub's
accounts, for ACCOUNTS and FUEL), station-leases/<lease>.json (one per pane
on a hub account) and station-usage.json (how far the transcripts were
read). Each hub account gets its own Claude folder,
~/.config/orcherd/station/<id>: ~/.claude's files linked in except
`projects`, so its transcripts, and so its token use, are its own.

The token goes from the hub straight into the env of `claude` (os.execve):
never argv, never a file. The machine key lives in the Keychain and reaches
curl on stdin. The hub's cert is pinned (curl --pinnedpubkey) from pairing on.
"""
import base64
import hashlib
import json
import os
import re
import shutil
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


# ---------- the Keychain: the machine key, on stdin only
# ORCHERD_STATION_TEST_KEY_FILE: tests only, so they never touch the real
# Keychain (with HOME pointed elsewhere for the files).
TEST_KEY_FILE = os.environ.get("ORCHERD_STATION_TEST_KEY_FILE")


def kc_read():
    if TEST_KEY_FILE:
        try:
            with open(TEST_KEY_FILE) as fh:
                return fh.read().strip() or None
        except OSError:
            return None
    r = subprocess.run(["security", "find-generic-password", "-s", KC_SERVICE, "-w"],
                       capture_output=True, text=True, timeout=10)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def kc_write(secret):
    """`security -i` reads the command on stdin, so the key never shows in
    ps; read back, because `security -i` can fail and still exit 0."""
    if TEST_KEY_FILE:
        make_dir(os.path.dirname(TEST_KEY_FILE))
        with open(os.open(TEST_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
            fh.write(secret)
        return
    cmd = f'add-generic-password -U -s "{KC_SERVICE}" -a "orcherd" -X {secret.encode().hex()}\n'
    r = subprocess.run(["security", "-i"], input=cmd, capture_output=True, text=True, timeout=10)
    if r.returncode != 0 or kc_read() != secret:
        raise Fail("The machine key could not go in the macOS Keychain (locked?). Unlock it and pair again.")


def kc_delete():
    if TEST_KEY_FILE:
        with_suppressed(os.remove, TEST_KEY_FILE)
        return
    subprocess.run(["security", "delete-generic-password", "-s", KC_SERVICE],
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
                "started": time.time(), "pane": pane, "cwd": cwd, "tokens": [0, 0, 0, 0]})
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
    return r.returncode == 0 and f"CLAUDE_CONFIG_DIR={lease['folder']}" in r.stdout


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


def sync(link):
    """One tick: the hub's accounts (for ACCOUNTS), then a heartbeat with every
    pane still running on a hub account, the tokens their chats spent, a
    refused token, and this Mac's fuel for the same Claude accounts. A pane
    that ended is released."""
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

    leases = [l for l in (read_json(os.path.join(LEASES, f)) for f in sorted(os.listdir(LEASES))
                          if f.endswith(".json")) if l] if os.path.isdir(LEASES) else []
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
    write_json(USAGE_FILE, usage)
    emails = {(a.get("email") or "").lower() for a in accounts if a.get("email")}
    try:
        status, out = request(link, "POST", "/api/v1/heartbeat",
                              {"leases": items, "fuel": local_fuel(emails)}, key=key)
    except Fail:
        return
    for lid in out.get("ended", []) if status == 200 else []:
        with_suppressed(os.remove, os.path.join(LEASES, f"{lid}.json"))


def cmd_sync():
    link = read_json(LINK_FILE)
    if link:  # not paired: nothing to do, nothing to say
        sync(link)


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
        else:
            sys.exit(__doc__.split("\n\n")[1])
    except Fail as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main(sys.argv)
