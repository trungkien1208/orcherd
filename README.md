<p align="center"><img src="docs/banner.svg" alt="The goat got a whale: Herdr app, but it slaps." width="100%" /></p>

<p align="center"><b>Herdr's window 🪟 + orcha's brain 🧠 = ORCHERD.</b><br/>A plugin. Not a fork. Absolutely not normal.</p>

## Why? 🐐 + 🐋

<p align="center"><img src="docs/orcherd.svg" alt="The goat (Herdr app) brings a real window, terminals that never die, GPU speed and mods, but no brain. The whale (orcha) brings every agent at a glance, PROCESS trains, fuel and account switch, find, files and links, but no window. Together: ORCHERD." width="100%" /></p>

## Look 👀

<p align="center"><img src="docs/cockpit.png" alt="Orcherd: projects and agents on the left, two agents side by side in folder tabs, PROCESS trains, fuel and git on the right" width="100%" /></p>

## Install 🚀

Pick your fighter: 🍎 [macOS](#-macos) · 🪟 [Windows](#-windows)

### 🍎 macOS

Apple Silicon only. Intel Mac? The goat doesn't do Intel. Neither do we. 🫠

**Step 1.** Summon the goat 🐐 (skip if Herdr is already in your house):

```sh
curl -fsSL https://releases.herdr.dev/app/install.sh | sh
```

**Step 2.** Release the whale 🐋:

```sh
curl -fsSL https://raw.githubusercontent.com/trungkien1208/orcherd/HEAD/install.sh | sh
```

**Step 3.** Open the goat: launch **Herdr** (Spotlight `⌘Space` → `Herdr`, or `~/Applications/Herdr.app`). Already open? Restart it: `⌘Q`, then open it again so every part of Orcherd loads fresh. Your agents keep running.

**Step 4.** Tell the goat who's boss: in Herdr's window, `⌘⇧P` → `layout.switch` → **orcha**. Or Settings › Look, click the one with the ✓ energy:

<p align="center"><img src="docs/layout.png" alt="Herdr's layout picker with orcha selected" width="70%" /></p>

**Step 5.** There is no step 5. Go ship something. 🫡

### 🪟 Windows

Bad news, delivered with love: **the whale can't swim here yet.** 🐋🚫

The goat runs on Windows just fine. The whale is a different animal: it breathes `sh`, `python3`, `ps` and `lsof`, and keeps your accounts in the macOS Keychain. Install it on Windows and you get a very pretty cockpit with empty seats: no sidebar, no FILES, no FIND, no FUEL. So we won't pretend, and we won't hand you an installer that lies.

What you can do today:

**Step 1.** Get the goat anyway 🐐 (it's a great terminal app on its own). In PowerShell, x64 only:

```powershell
powershell -c "irm https://releases.herdr.dev/app/install.ps1 | iex"
```

**Step 2.** Open **Herdr** from the Start menu. Its command palette is `Ctrl+Shift+P`, not `⌘⇧P`. You're on Windows, you knew that.

**Step 3.** Want the whale on Windows? Help it learn to swim 🏊: the port starts with knowing what a real Windows PC has. Download **orcherd-windows-probe.zip** from the [latest release](https://github.com/trungkien1208/orcherd/releases/latest), unzip it, then:

```powershell
powershell -ExecutionPolicy Bypass -File win-probe.ps1
```

It changes nothing and prints no secrets (for sign-in files: only whether they exist, their size and key names). Then copy the `probe-mod` folder to `%USERPROFILE%\.config\herdr-app\mods\orcha-probe`, and in Herdr: `Ctrl+Shift+P` → `mod.open` → **orcha-probe** → **Copy report**. [Open an issue](https://github.com/trungkien1208/orcherd/issues) with both reports (they show your user folder's name: blank it if you mind). Every report moves the whale closer. Watch **Releases** to hear when it lands.

<sub>New: import projects from Cursor, Claude and Codex, ⌘F inside files, Codex and Cursor accounts, updates from the header · Before: worktrees in one card like Orca, dev servers with their ports, agents back after a crash, drag to reorder · Fuel and accounts are Orcherd's own, no terminal orcha needed · update = the pink 🐋 pill in the header (or Settings › 🐋 orcha), or run step 2 again · nerd stuff nobody reads: [click here 🥱](docs/BORING.md) · Apache-2.0 · the goat is Herdr's, the whale is ours 🍵</sub>
