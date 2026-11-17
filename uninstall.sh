#!/bin/sh
# Takes Orcherd off this Mac. Quit Herdr first (Cmd+Q): your agents keep running.
#
#   curl -fsSL https://raw.githubusercontent.com/trungkien1208/orcherd/HEAD/uninstall.sh | sh
#       Orcherd leaves Herdr: its layout, themes, mods, keys, and the theme and
#       layout picks that named them. Accounts, settings and projects stay, so
#       install.sh brings it back as it was (start over).
#
#   curl -fsSL https://raw.githubusercontent.com/trungkien1208/orcherd/HEAD/uninstall.sh | sh -s -- --all
#       Also what Orcherd keeps for itself: saved accounts and their Keychain
#       items, settings, projects, the fuel cache, the Token Station pairing.
#       Chats stay: they live in ~/.claude (an account folder with chats of its
#       own is kept). Refuses while a chat still runs on one of Orcherd's
#       account folders.
#
#   sh uninstall.sh [--all]   (from a clone)
#
# Herdr's own files and yours are left alone. Safe to run twice.
set -eu

all=0
for arg in "$@"; do
  case "$arg" in
    --all) all=1 ;;
    *) echo "usage: sh uninstall.sh [--all]" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    echo "Orcherd doesn't install on Windows: nothing to remove."
    exit 0 ;;
esac

command -v python3 >/dev/null 2>&1 || { echo "The uninstall needs python3, like the install did." >&2; exit 1; }

# Herdr writes its files while it runs (mod folders, shared.json): edits under
# it would be overwritten or half-applied.
if pgrep -f "Herdr.app/Contents/MacOS/Herdr" >/dev/null 2>&1 || pgrep -x herdr-app >/dev/null 2>&1; then
  echo "Quit Herdr first (Cmd+Q; your agents keep running), then run this again." >&2
  exit 1
fi

dest=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}

python3 -I - "$dest" "$all" <<'PY'
import glob, hashlib, json, os, re, shutil, subprocess, sys

dest, everything = sys.argv[1], sys.argv[2] == "1"
HOME = os.path.expanduser("~")
CONF = os.path.join(HOME, ".config", "orcherd")
CACHE = os.path.join(HOME, ".cache", "orcherd")
# Token Station's own client (a Mac paired from the hub's page, no Orcherd
# needed) shares Orcherd's station files: those stay while it is installed.
CLIENT = os.path.isdir(os.path.join(HOME, ".local", "share", "token-station-client"))
# The keys install.sh binds for the orcha layout.
KEYS = {"cmd-,": "orcha.settings", "cmd-o": "orcha.find-file", "cmd-shift-f": "orcha.find-text",
        "cmd-f": "orcha.find-pane", "cmd-l": "orcha.find-link", "cmd-w": "orcha.close-tab",
        "cmd-shift-w": "orcha.close-pane"}
removed, kept, notes = [], [], []


def short(p):
    return "~" + p[len(HOME):] if p.startswith(HOME + os.sep) else p


def gone(p):
    """Removes a file, link or folder (never what a link points at)."""
    if os.path.islink(p) or os.path.isfile(p):
        os.remove(p)
    elif os.path.isdir(p):
        shutil.rmtree(p)
    else:
        return
    removed.append(short(p))


def edit(path, change):
    """Changes a JSON file in place; one that doesn't parse is never written over."""
    try:
        with open(path) as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return
    except (OSError, ValueError):
        notes.append(f"{short(path)} could not be read: left as it is.")
        return
    if not isinstance(data, dict) or not change(data):
        return
    tmp = path + ".orcha-tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    removed.append(f"Orcherd's entries in {short(path)}")


def keychain_delete(service):
    found = False
    for _ in range(50):  # one item per account name; never loops forever
        r = subprocess.run(["security", "delete-generic-password", "-s", service], capture_output=True)
        if r.returncode != 0:
            break
        found = True
    if found:
        removed.append(f'Keychain item "{service}"')


def own_chats(d):
    """An account folder whose chats are its own, not links into ~/.claude."""
    p = os.path.join(d, "projects")
    return os.path.isdir(p) and not os.path.islink(p)


# ---------- before anything: nothing still running on what --all removes
if everything:
    ps = subprocess.run(["ps", "eww", "-U", str(os.getuid()), "-o", "command="], capture_output=True, text=True).stdout
    users = [l for l in ps.splitlines() if re.search(r"CLAUDE_CONFIG_DIR=(~|" + re.escape(HOME) + r")/\.config/orcherd/", l)]
    if users:
        sys.exit("Chats still run on Orcherd's account folders (~/.config/orcherd/...): end them first "
                 "(or switch them back to the default account), then run this again. Nothing was removed.")

# ---------- the Token Station pairing goes first, while its script is here
station_script = os.path.join(dest, "mods", "orcha", "bin", "tokenstation.py")
if everything and not CLIENT and os.path.exists(os.path.join(CONF, "station.json")):
    if os.path.exists(station_script):
        try:
            r = subprocess.run([sys.executable, "-I", station_script, "forget"], capture_output=True,
                               text=True, timeout=120, stdin=subprocess.DEVNULL)
            if r.returncode == 0:
                removed.append("the Token Station pairing")
            else:
                notes.append("Token Station couldn't unpair cleanly: its files are removed anyway.")
        except subprocess.TimeoutExpired:
            notes.append("Token Station didn't answer: its files are removed anyway.")
    if os.path.exists(os.path.join(CACHE, "station-borrow.json")):
        notes.append("A hub sign-in may still be in place for plain `claude`: if it stops working, run /login.")
    notes.append("Revoke this Mac on the hub's Machines page too.")

# ---------- Herdr's folder: only Orcherd's own files
for p in ([os.path.join(dest, "layouts", "orcha.json"), os.path.join(dest, "layouts", "orcha.svg")]
          + glob.glob(os.path.join(dest, "themes", "orcha-*.json"))
          + glob.glob(os.path.join(dest, "mods", "orcha*"))
          + glob.glob(os.path.join(dest, ".orcha-install.*"))  # an install cut short
          + glob.glob(os.path.join(dest, "*.orcha-tmp"))):
    gone(p)


def unbind(keys):
    mine = keys.get("layout:orcha")
    if not isinstance(mine, dict):
        return False
    before = len(mine)
    for k, v in KEYS.items():
        if mine.get(k) == v:
            del mine[k]
    if not mine:
        del keys["layout:orcha"]
        return True
    return len(mine) != before


def untheme(settings):
    theme = settings.get("theme")
    if isinstance(theme, str) and theme.startswith("orcha-"):
        del settings["theme"]
        return True
    if isinstance(theme, dict):
        ours = [k for k, v in theme.items() if isinstance(v, str) and v.startswith("orcha-")]
        for k in ours:
            del theme[k]
        if not theme:
            del settings["theme"]
        return bool(ours)
    return False


def unshare(shared):
    changed = False
    if shared.get("layout") == "orcha":  # Herdr opens on its own layout instead
        del shared["layout"]
        changed = True
    if everything:
        for k in [k for k in shared if k.startswith("orcha.")]:
            del shared[k]
            changed = True
    return changed


edit(os.path.join(dest, "keys.json"), unbind)
edit(os.path.join(dest, "settings.json"), untheme)
edit(os.path.join(dest, "shared.json"), unshare)
if everything:
    for p in glob.glob(os.path.join(dest, "data", "orcha*")):  # the mod's own store: projects opened
        gone(p)

# ---------- what Orcherd keeps for itself
if everything and os.path.isdir(CONF):
    try:
        with open(os.path.join(CONF, "config.json")) as fh:
            accounts = json.load(fh).get("accounts", [])
    except (OSError, ValueError, AttributeError):
        accounts = []
    try:
        with open(os.path.join(CONF, "claude-active")) as fh:
            active = fh.read().strip()
    except OSError:
        active = ""
    names = {a.get("id"): a.get("label") or a.get("id") for a in accounts if isinstance(a, dict)}

    # Account folders: their files are links into ~/.claude (gone, never what
    # they point at); one with chats of its own is kept.
    for parent in ("claude", "station"):
        if parent == "station" and CLIENT:
            continue
        for d in sorted(glob.glob(os.path.join(CONF, parent, "*"))):
            if os.path.isdir(d) and not os.path.islink(d) and own_chats(d):
                kept.append(short(d))
            else:
                gone(d)
    # The sign-in Claude keeps for each removed folder.
    for a in accounts:
        if isinstance(a, dict) and a.get("kind") == "claude" and a.get("dir"):
            d = os.path.expanduser(a["dir"])
            if os.path.realpath(d).startswith(os.path.realpath(CONF) + os.sep) and not os.path.exists(d):
                keychain_delete("Claude Code-credentials-" + hashlib.sha256(d.encode()).hexdigest()[:8])
    for name in sorted(os.listdir(CONF)):
        p = os.path.join(CONF, name)
        if name in ("claude", "station") and os.path.isdir(p) and not os.path.islink(p):
            if not os.listdir(p):
                os.rmdir(p)
            continue
        if CLIENT and name.startswith("station"):
            continue
        gone(p)
    if not os.listdir(CONF):
        os.rmdir(CONF)
    if active and active in names:
        notes.append(f"Plain `claude` stays signed in as {names[active]}. Other accounts need /login again.")

if everything and os.path.isdir(CACHE):
    for name in sorted(os.listdir(CACHE)):
        if CLIENT and (name.startswith("station") or name == "limits"):
            continue
        gone(os.path.join(CACHE, name))
    if not os.listdir(CACHE):
        os.rmdir(CACHE)

if everything and sys.platform == "darwin":
    dump = subprocess.run(["security", "dump-keychain"], capture_output=True, text=True).stdout
    for service in sorted(set(re.findall(r'"svce"<blob>="(orcherd-[^"]*)"', dump))):
        if CLIENT and service == "orcherd-station-device":
            continue
        keychain_delete(service)

if CLIENT and everything:
    notes.append("Token Station's client is on this Mac and shares the station files: they stay. "
                 "`tokenstation uninstall` removes it.")

# ---------- report
if removed:
    print("Removed:")
    for r in removed:
        print("  " + r)
else:
    print("Nothing of Orcherd's was here." if everything else "Nothing of Orcherd's was in Herdr.")
for k in kept:
    print(f"Kept {k}: it holds chats of its own. Delete it yourself when you don't need them.")
for n in notes:
    print(n)
if everything:
    print("Orcherd is gone. Herdr opens on its own layout.")
else:
    print("Orcherd is out of Herdr; accounts, settings and projects stay.\n"
          "Reinstall: curl -fsSL https://raw.githubusercontent.com/trungkien1208/orcherd/HEAD/install.sh | sh\n"
          "then open Herdr and Cmd+Shift+P → layout.switch → orcha.")
PY
