#!/bin/sh
# Restarts the Herdr app so a freshly installed Orcherd loads. Herdr reloads
# mods live, but not a whole install at once, and it stops reloading after
# many in one run: without a restart the old copy keeps running and nothing
# says so. Agents keep running (they live in herdr-core, not in the window).
#
#   restart-herdr.sh ask [version]   a macOS dialog: Restart Herdr / Later
#   restart-herdr.sh now             quit Herdr and open it again
#
# install.sh runs `ask` detached after an update from inside the app; the
# Settings › orcha button runs `now`. macOS only: elsewhere it does nothing.
[ "$(uname -s)" = Darwin ] || exit 0

# The running Herdr.app, wherever it was installed.
app=$(ps -axo comm= | sed -n 's#^\(.*/Herdr\.app\)/Contents/MacOS/Herdr$#\1#p' | head -n 1)
[ -n "$app" ] || exit 0

if [ "${1:-}" = ask ]; then
  ver=${2:-}
  msg="Orcherd${ver:+ $ver} is installed.

Restart Herdr to load it. Your agents keep running."
  # The text goes in as an argument, never into the script itself.
  answer=$(osascript - "$msg" 2>/dev/null <<'OSA'
on run argv
  display dialog (item 1 of argv) with title "Orcherd" buttons {"Later", "Restart Herdr"} default button "Restart Herdr" giving up after 900
  return button returned of result
end run
OSA
)
  [ "$answer" = "Restart Herdr" ] || exit 0
fi

pid_of() { pgrep -f "$app/Contents/MacOS/Herdr" | head -n 1; }
bid=$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null)
if [ -n "$bid" ]; then
  osascript -e "tell application id \"$bid\" to quit" >/dev/null 2>&1 &
fi
# Up to 10 s for a clean quit, then TERM, then 5 s more.
i=0
while [ -n "$(pid_of)" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
pid=$(pid_of)
[ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null
i=0
while [ -n "$(pid_of)" ] && [ $i -lt 10 ]; do sleep 0.5; i=$((i + 1)); done
open "$app"
