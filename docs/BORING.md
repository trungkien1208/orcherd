# The boring stuff 🥱

You clicked. Respect. Here's everything nobody reads.

[← back to the fun part](../README.md)

## What you get

<table>
  <tr>
    <td width="50%"><img src="agents.png" alt="An open project: one card per agent with model, context and RAM" /></td>
    <td width="50%"><img src="process.png" alt="PROCESS: a little train per working agent between THINK, CODE, TEST and DONE" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Projects</b> · open as many as you like, every agent at a glance</sub></td>
    <td align="center"><sub><b>PROCESS</b> · trains. yes, trains. 🚂</sub></td>
  </tr>
</table>

- 🗂 **Projects**: cards per agent (model, context, RAM in green, yellow, red). Pick an icon from ~150 emoji. Drag one to reorder. **+ NEW** › New project… opens another folder (browse or type a path), the same folder again, or a new worktree. Closing a project's last pane closes the project.
- 🌳 **Worktrees**: projects in one repo share a card, like Orca: a line per checkout (MAIN first), **+ worktree** to branch off, right-click › Remove worktree… (the branch stays).
- 🖥 **Shells**: a shell running something shows it (`pnpm dev`) with a running dot, in the sidebar, its title bar and its tab; the ports it serves show as `:3000`, a click opens them.
- 🔄 **Resume**: Herdr crashed or the Mac rebooted? Each Claude and Codex chat comes back in its pane (`claude --resume`, `codex resume`), no retyping.
- 📊 **RAM**: the status bar shows Herdr in all (the window, herdr-core and every agent); hover for the split.
- 🚂 **PROCESS**: each working agent is a train between THINK, CODE, TEST and DONE. Click one to jump there.
- ⛽ **FUEL**: what's left on the plan of the agent in front of you: Claude, Codex or Cursor.
- 🔁 **ACCOUNTS**: add one, sign in, **SWITCH** the chat in front of you (keep running, restart, or a new pane with notes).
- 📁 **FILES**: the project's files beside INFO, search by name or text, a viewer next to your work. Right-click a file or folder: open it in the editor, its app or Finder, a new tab in a folder, copy its path. Markdown reads as a page (flip to SOURCE any time).
- 🔎 **FIND**: `⌘O` a file, `⌘⇧F` text in the project, `⌘F` text in the pane, `⌘L` links.
- 🔗 **Links**: right-click a link in a terminal to open or copy it, even the ones Claude shows only by name, even when they wrap.
- 🎨 **Looks**: folder tabs in the agent's color, Brutal, Matcha and Ocean themes, light and dark.

## Keys

| Keys | Does |
| --- | --- |
| `⌘O` | open a file by name |
| `⌘⇧F` | search text in the project |
| `⌘F` | search what the pane shows |
| `⌘L` | links and paths the pane printed (`⌘C` copies one) |
| `⌘,` | settings |
| `⌘W` | close the tab (the project too, on its last tab) |
| `⌘⇧W` | close the pane (the project too, on its last pane) |

`⌘P` stays Herdr's terminal picker. All of these work only while the orcha layout is on.


## Accounts, switching and hand-off

- **SWITCH** moves the chat in front of you to an account. Claude to Claude asks how, unless Settings › Hand-off already says:
  - **Keep running**: same chat, no restart; Claude picks up the new sign-in within half a minute. Every chat started in the same folder moves with it. The chat borrows the account: FUEL says BORROWED, and in ACCOUNTS its own account says HOME, where **RETURN** ends the borrow.
  - **Restart**: same chat, Claude starts again on the account. Only this pane moves.
  - **New pane**: a new agent opens beside the old one with short notes, sums up and waits for your go.
  - Another kind of agent (Codex, Cursor) always gets a new pane.
- Open ACCOUNTS and press Enter: the cursor starts on **BEST**, the account with more fuel than the one in use. Fuel that could not be read is never BEST.
- An account that sits idle keeps its last numbers ("last read Tue 09:38"); a window that reset since counts as full.
- **Settings › Accounts** shows the default with a **Return** button while the main folder's chats borrow another account: new chats start on the borrowed one until then.
- **Two accounts in two projects at once?** Yes: open Claude normally in one, and in the other SWITCH with **Restart** or **New pane**.
- **Rename** an account: `e` in ACCOUNTS, or **Rename** in Settings › Accounts. Only the name shown changes; its sign-in and chats stay.
- **ADD ACCOUNT** (`a`): name it, sign in in the pane that opens. Chats, settings and skills are shared between accounts.
- **SIGN IN** shows when orcha can't read an account's fuel, with the reason. `r` asks every account right now.
- **Settings › Hand-off** puts three marks on the fuel bar: ask the agent for a checklist, offer to switch, switch by itself. Kept in Orcherd's own `~/.config/orcherd/config.toml`.

### Token Station hub accounts

Pair this Mac in Settings › Accounts › Token Station after comparing the hub's
certificate check. Hub accounts appear with a HUB tag. Starting one, or
switching to one with Restart or New pane, runs `tokenstation.py run <id>` for
that pane. It sets the hub relay endpoint only in the new Claude Code process;
Orcherd does not change your global Claude settings. A local account or a
plain `claude` command keeps its own connection.

The hub checks the pane's lease on each request. End day, Stop, or machine
revocation blocks further relay requests. Orcherd stops the pane at its next
sync and keeps its chat for a later restart. The hub's setup-token stays on
the hub for these runs. Clients from older Token Station versions may already
have copied a setup-token; updating the hub cannot revoke that copy at
Anthropic.
Unpair stops this Mac's hub panes, releases their leases when the hub is
reachable, and keeps their chats. Revoke the machine on the hub separately.
Settings → Accounts and the ACCOUNTS switcher have separate Local and Hub tabs. If the hub's address changes, use
**Change address** in the Hub tab; it verifies the same pinned certificate
and keeps the pairing. Restart running hub panes afterward.


## Opening links and files

A page opens in your browser, a folder in Finder, a picture, PDF or document in its app, code in the viewer at its line (`file.rs:42`). A path that isn't where it says is looked for in the project. Links Claude shows only by name are read from its conversation.

In a split tab, orcha learns where a pane is when the pointer passes over its title bar; if a right-click finds nothing, select the link first.

Open a file type somewhere else in Orcherd's `~/.config/orcherd/config.toml`:

```toml
[orcha.open_with]
md = "editor"          # cursor, code or zed, at the line
png = "system"         # the system's app
log = "folder"         # show it in Finder
rs = "editor:zed {path}:$L"
```


## Something looks wrong

- **Herdr looks the same.** Still on another layout: `⌘⇧P` → `layout.switch` → **orcha**.
- **FUEL and ACCOUNTS are empty.** Claude, Codex and Cursor show up by themselves once their CLI is installed; press `r` in ACCOUNTS, or add one there. Orcherd needs `python3` (`xcode-select --install`).
- **Signed in, but FUEL asks to sign in, or ACCOUNTS has a 🔑 box.** Claude couldn't write the macOS Keychain and kept its sign-in in `~/.claude/.credentials.json`. FUEL reads the file too. To switch accounts again, use the box's button: **MOVE TO KEYCHAIN**, **UNLOCK** (your Mac's password), or **KEYCHAIN ACCESS** (Settings › Reset Default Keychain, usually after the Mac's password changed; then SIGN IN again).
- **Herdr says "out of memory" after updates.** Quit it (`⌘Q`) and open it again. Your agents keep running.
- **A panel is blank.** `herdr-app check ~/.config/herdr-app/mods/orcha` says what broke. [Open an issue](https://github.com/trungkien1208/orcherd/issues) with it.
- **Two Claude chats in one folder show the same model.** Known: they share the folder's newest conversation.
- **Agents gone after a crash or reboot.** orcha resumes each chat it saw in the last 5 seconds before. Two Claude chats in one folder come back as one (they share the folder's newest conversation); start the other with `claude --resume`.


## Uninstall, and where the installer writes

Everything lives in `~/.config/herdr-app` (or `$HERDR_APP_HOME`): `layouts/orcha.json`, `themes/orcha-*.json`, `mods/orcha/`, orcha's keys in `keys.json` (only for the orcha layout) and the Matcha theme in `settings.json` if you had none. Herdr's own files and yours are left alone. Orcherd's accounts and settings live in `~/.config/orcherd`, its fuel cache in `~/.cache/orcherd`: apart from the terminal orcha, which Orcherd doesn't need.

```sh
cd ~/.config/herdr-app && rm -rf layouts/orcha.json themes/orcha-*.json mods/orcha ~/.config/orcherd ~/.cache/orcherd
```

Then `⌘⇧P` → `layout.switch` back to another layout.


## For contributors

- `mods/orcha/` is the plugin. `main.js` picks the part a layout block asks for; `ui.js` holds the look.
- `catalog.js` holds the working rules and suggested skills of Settings › Projects: edit it directly.
- `settings.js` starts from Herdr's settings page: compare with a new Herdr's `frame/settings/main.js` on updates.
- Animate with Herdr's native `.loop`, `.transition` and `.frames`, never timers.
- Loop: `sh install.sh`, `herdr-app check ~/.config/herdr-app/mods/orcha`, `herdr-app shot shot.png`. Herdr refuses reloads after many in one run: batch your installs.
- Releasing: bump `VERSION` in `mods/orcha/version.js`, commit, tag `vX.Y.Z`, `gh release create`. Installed copies ask GitHub's latest release every few hours, show a pink pill in the header, and Settings › 🐋 orcha installs that tag (`ORCHA_REF=vX.Y.Z` for `install.sh`).
