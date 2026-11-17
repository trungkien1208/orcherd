#!/bin/sh
# orcha for the Herdr desktop app: copies orcha's layout, themes and mods
# into Herdr's config folder. An open Herdr restarts once after.
#
#   curl -fsSL https://raw.githubusercontent.com/trungkien1208/orcherd/HEAD/install.sh | sh
#   sh install.sh          (from a clone)
#   ORCHA_REF=v0.5.0 sh    (piped: that release instead of the newest code;
#                           Settings › orcha's update button does this)
#
# Run it again to update. Only orcha's own files are written
# (layouts/orcha.json and its preview, themes/orcha-*, mods/orcha*), plus orcha's keys for the
# orcha layout in keys.json (Cmd+, Cmd+O Cmd+Shift+F Cmd+F Cmd+L Cmd+W Cmd+Shift+W) and orcha's
# colors when no theme is picked yet; Herdr's shipped files and your own are
# left alone.
set -eu

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    echo "Orcherd doesn't run on Windows yet: Herdr does, the whale doesn't. https://github.com/trungkien1208/orcherd#-windows" >&2
    exit 1 ;;
esac

REPO="trungkien1208/orcherd"
# From a clone only when this file was run by name: piped from curl, $0 is
# just "sh", and the folder it was run in (Herdr's own config folder, say)
# must not be taken for a copy of orcha.
src=
case "$0" in
  install.sh | */install.sh) src=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true) ;;
esac
fetched=
cleanup_fetch() { [ -z "$fetched" ] || rm -rf "$fetched"; }
trap cleanup_fetch EXIT
if [ -z "$src" ] || [ ! -d "$src/mods/orcha" ]; then
  # Piped from curl: fetch this repository's current files (or ORCHA_REF's).
  command -v curl >/dev/null 2>&1 || { echo "Orcherd needs curl"; exit 1; }
  fetched=$(mktemp -d)
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/${ORCHA_REF:-HEAD}" | tar -xz -C "$fetched"
  src=$(find "$fetched" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -d "$src/mods/orcha" ] || { echo "the download did not contain orcha's mods"; exit 1; }
fi
dest=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}

mkdir -p "$dest/layouts" "$dest/themes" "$dest/mods"
cp "$src/layouts/orcha.json" "$dest/layouts/orcha.json"
cp "$src/layouts/orcha.svg" "$dest/layouts/orcha.svg"
for old in "$dest"/themes/orcha-*.json; do
  [ -e "$old" ] || continue
  [ -e "$src/themes/$(basename "$old")" ] || rm -f "$old"
done
cp "$src"/themes/orcha-*.json "$dest/themes/"
# Staged outside mods/, so Herdr never sees a half-copied mod folder.
stage=$(mktemp -d "$dest/.orcha-install.XXXXXX")
trap 'rm -rf "$stage"; cleanup_fetch' EXIT
# orcha's mods that this version no longer has go first.
for old in "$dest"/mods/orcha*; do
  [ -e "$old" ] || continue
  [ -d "$src/mods/$(basename "$old")" ] || rm -rf "$old"
done
for mod in "$src"/mods/orcha*; do
  name=$(basename "$mod")
  cp -R "$mod" "$stage/$name"
  # Move the old copy aside before deleting it: Herdr may write into a mod
  # folder (jsconfig.json) while it is being removed.
  [ ! -e "$dest/mods/$name" ] || mv "$dest/mods/$name" "$stage/$name.old"
  mv "$stage/$name" "$dest/mods/$name"
done
# Cmd+, opens orcha's settings and Cmd+O / Cmd+Shift+F / Cmd+F / Cmd+L open FIND
# while the orcha layout shows, and orcha's
# colors are the theme unless the person already picked one (Settings › Look).
python3 -I - "$dest" <<'PY'
import json, os, sys

def update(path, change):
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = {}
    if not change(data):
        return
    tmp = path + ".orcha-tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)

def bind(keys):
    mine = keys.setdefault("layout:orcha", {})
    mine["cmd-,"] = "orcha.settings"
    # FIND: a file by name, text in the project, text in the pane, links.
    mine["cmd-o"] = "orcha.find-file"
    mine["cmd-shift-f"] = "orcha.find-text"
    mine["cmd-f"] = "orcha.find-pane"
    mine["cmd-l"] = "orcha.find-link"
    # Cmd+W / Cmd+Shift+W close the tab / pane without asking; a project's last one leaves a fresh shell, the project stays.
    mine["cmd-w"] = "orcha.close-tab"
    mine["cmd-shift-w"] = "orcha.close-pane"
    return True

def colors(person):
    if "theme" in person:
        return False
    person["theme"] = {"light": "orcha-matcha", "dark": "orcha-matcha-dark"}
    return True

home = sys.argv[1]
update(os.path.join(home, "keys.json"), bind)
update(os.path.join(home, "settings.json"), colors)
PY
command -v herdr-app >/dev/null 2>&1 || [ -x "$HOME/.local/bin/herdr-app" ] ||
  echo "Herdr is not installed yet: curl -fsSL https://releases.herdr.dev/app/install.sh | sh"
echo "Orcherd installed into $dest."
# Herdr reloads mods live, but a whole install at once is more than it
# picks up cleanly (and it refuses reloads after many in one run): an open
# Herdr restarts once. Its agents keep running.
if [ -n "${ORCHA_REF:-}" ] && [ ! -t 1 ] && pgrep -f "Herdr.app/Contents/MacOS/Herdr" >/dev/null 2>&1; then
  # Updated from inside the app (Settings › orcha, the header's pill): this
  # output goes nowhere, and the app keeps running the old copy until it
  # restarts. A macOS dialog asks, after this script has ended.
  ver=$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' "$dest/mods/orcha/version.js" 2>/dev/null)
  nohup /bin/sh "$dest/mods/orcha/bin/restart-herdr.sh" ask "$ver" </dev/null >/dev/null 2>&1 &
  echo "Restart Herdr to load it."
elif pgrep -f "Herdr.app/Contents/MacOS/Herdr" >/dev/null 2>&1 || pgrep -x herdr-app >/dev/null 2>&1; then
  echo ""
  echo "  >>> Restart Herdr now: quit it (Cmd+Q) and open it again. <<<"
  echo "  So every part of Orcherd loads fresh. Your agents keep running."
  echo ""
  echo "Then, the first time: Cmd+Shift+P → layout.switch → orcha"
else
  echo "Open the Herdr app, then the first time in its window: Cmd+Shift+P → layout.switch → orcha"
fi
