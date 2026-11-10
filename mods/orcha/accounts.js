// ACCOUNTS (SPEC §3.2), opened from FUEL or the header: one row per account
// with its plan limits. The account the agent in front of you runs on has the
// heavy border, the yellow edge and IN USE; the one with the most fuel left is
// BEST, gets the raised green SWITCH and the cursor, so Enter goes there.
// SWITCH moves only the chat in front of you (Settings › Hand-off says how,
// else it asks: keep running, restart, new pane); keep running borrows the
// account's sign-in in the chat's folder, with any chat sharing it, and FUEL
// shows it BORROWED. While it borrows, the account the chat is at home on
// says HOME and its button is RETURN: the borrow ends, no restart.
// Without an agent in front, SWITCH starts a new chat on the account. The
// default account for new chats is Settings › Accounts' business, never this.
// An account without fuel to read offers SIGN IN. + ADD ACCOUNT adds a Claude
// account and opens its sign-in.
//
// When Claude's sign-in can't go in the macOS Keychain (locked, broken, kept
// in a .credentials.json), a box on top says so with the one button that
// fixes it; fuel still reads, but KEEP RUNNING waits for the Keychain.
//
// Read from Orcherd's own files (config.json, the limits cache): opening the
// popup asks nothing of the network. `r` refreshes through `accounts.py json`.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, notify, setShared } from "herdr";
import { readAccounts, tokenState, needsSignIn, refreshFuel, addAccount, renameAccount, signIn, handOff, restartOn, keepRunningOn, keepInfo, startOn, claudeAccountOf, readHandoff, focusedAgent, readKeychain, keychainBlocks, moveToKeychain, unlockKeychain, openKeychainAccess, isStation, sameClaude } from "./accounts-data.js";
import { tokens, raised, chip, button, icon, fuelGauge, fuelLeft, readable, agentFacts } from "./ui.js";

// The fuel left on an account by its tighter limit, or null when none was read.
function fuelOf(a) {
  const windows = [fuelLeft(a.limits?.session), fuelLeft(a.limits?.weekly)].filter((v) => v != null);
  return windows.length ? Math.min(...windows) : null;
}

export default class Accounts {
  constructor(cx) {
    this.list = [];
    this.at = 0;
    this.placed = false; // the cursor was put on BEST (else IN USE) once the list was read
    this.home = null; // the account the chat in front is at home on, while it borrows another
    this.keep = { why: null, others: 0 };
    this.tab = "local";
    this.tabChosen = false;
    this.busy = null;
    this.choosing = null; // account id whose hand-off choices show
    this.adding = false;
    this.mode = "ask";
    this.keychain = null;
    this.confirmMove = false;
    this.nameInput = InputState.new({ placeholder: "name, like personal or work" });
    this.nameInput.on("submit", (_e, cx) => this.add(cx));
    this.renaming = null; // account id whose name is being typed (e)
    this.renameInput = InputState.new({ placeholder: "the account's name" });
    this.renameInput.on("submit", (_e, cx) => this.rename(cx));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    this.load(cx);
    cx.spawn(async (cx) => {
      this.mode = (await readHandoff()).switch_mode;
      cx.notify();
    });
  }

  load(cx) {
    cx.spawn(async (cx) => {
      const { list, active } = await readAccounts();
      this.list = list;
      this.hasHub = list.some(isStation);
      // What IN USE means: the account of the agent in front of you. The
      // sidebar's last read of it shows at once; the pane's process confirms.
      const from = focusedAgent();
      const key = from?.program?.key ?? "claude";
      const claude = key.includes("claude");
      const fact = claude && from?.terminal ? agentFacts().accounts?.[from.terminal] : null;
      const place = (using) => {
        this.using = using;
        if (this.hasHub && !this.tabChosen) this.tab = isStation(list.find((a) => a.id === using)) ? "hub" : "local";
        const visible = this.visible();
        if (!this.placed) {
          // Enter does what the green button says: the cursor starts on BEST.
          const start = visible.findIndex((a) => a.id === this.best());
          this.at = start >= 0 ? start : Math.max(0, visible.findIndex((a) => a.id === using));
          this.placed = visible.length > 0;
        }
        if (this.at >= visible.length) this.at = Math.max(0, visible.length - 1);
        cx.notify();
      };
      this.home = fact?.borrowed ? fact.seat : null;
      place(claude ? fact?.id ?? active : list.find((a) => key.includes(a.kind))?.id ?? null);
      // The slow reads, together: the pane's process (its account, what keep
      // running would do: why not, or how many other chats move with it) and
      // the Keychain, which keep running writes.
      const [using, keep, keychain] = await Promise.all([
        claude && from?.terminal ? claudeAccountOf(from.terminal) : null,
        claude && from ? keepInfo(from) : { why: null, others: 0 },
        list.some((a) => a.kind === "claude") ? readKeychain() : null,
      ]);
      this.keychain = keychain;
      const blocked = keychainBlocks(keychain);
      this.keep = blocked && !keep.why ? { ...keep, why: blocked } : keep;
      if (using && using !== this.using) {
        // The sidebar's read was behind (a switch just now): the borrow it knew is not this one.
        this.home = null;
        this.placed = false;
      }
      place(using || this.using);
      this.tabChosen = true;
    });
  }

  // Whether SWITCH can't move a chat onto `a` now: the chat is on it, or `a` must sign in first.
  held(a) {
    return a.id === this.using || needsSignIn(a, [a.limits.session, a.limits.weekly, a.limits.monthly].filter(Boolean));
  }

  visible() {
    return this.hasHub ? this.list.filter((a) => isStation(a) === (this.tab === "hub")) : this.list;
  }

  selectTab(tab, cx) {
    this.tab = tab;
    this.tabChosen = true;
    this.at = 0;
    this.choosing = null;
    this.adding = false;
    this.renaming = null;
    cx.notify();
  }

  // The Claude account worth switching to: the most fuel left, by its
  // tighter limit, and more than the one in use has. Only fuel that was read
  // counts: an account that must sign in, or whose fuel is not known, is no
  // promise. Null when the one in use is the best there is.
  best() {
    let best = null;
    const using = this.list.find((a) => a.id === this.using);
    let most = using?.kind === "claude" ? fuelOf(using) ?? -1 : -1;
    for (const a of this.visible()) {
      if (a.kind !== "claude" || a.why || this.held(a)) continue;
      // With a hub: the same Claude account under the other source is one fuel, no way out.
      if (this.hasHub && using && sameClaude(a, using)) continue;
      const fuel = fuelOf(a);
      if (fuel != null && fuel > most) {
        most = fuel;
        best = a.id;
      }
    }
    return best;
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  add(cx) {
    if (this.busy) return;
    const name = this.nameInput.value();
    this.busy = "add";
    cx.notify();
    cx.spawn(async (cx) => {
      const failed = await addAccount(name);
      this.busy = null;
      if (failed) notify({ title: "The account was not added", body: failed, level: "error" });
      else {
        this.adding = false;
        this.nameInput.set_value("");
        notify({ title: "Sign in beside your work", body: "When it says you're in, press Enter there.", level: "success", timeout: 6000 });
        this.close();
      }
      this.load(cx);
    });
  }

  // e: another name for the account under the cursor (a hub account is named on the hub).
  startRename(a, cx) {
    if (!a || isStation(a)) return;
    this.renaming = a.id;
    this.renameInput.set_value(a.label ?? a.id);
    this.renameInput.focus();
    cx.notify();
  }

  rename(cx) {
    const id = this.renaming;
    if (!id) return;
    cx.spawn(async (cx) => {
      const failed = await renameAccount(id, this.renameInput.value());
      if (failed) notify({ title: "The name was not changed", body: failed, level: "error" });
      else {
        this.renaming = null;
        this.handle.focus();
        setShared("orcha.fuelRev", Date.now());
      }
      this.load(cx);
    });
  }

  // SWITCH: Claude to Claude has three ways (orcha's switch_mode); anything
  // else continues in a new pane with notes.
  switchTo(account, how, cx) {
    const from = focusedAgent();
    if (!from) return this.withoutAgent(account, cx);
    // Enter on the row in use: the chat is there already.
    if (account.id === this.using) return;
    const claudeToClaude = account.kind === "claude" && from.program?.key?.includes("claude");
    let way = claudeToClaude ? how ?? (this.mode === "ask" ? null : this.mode) : "new_pane";
    // Keep running can't here (or onto a hub account): ask instead, with why.
    if (way === "keep" && (this.keep?.why || isStation(account))) way = null;
    if (!way) {
      this.choosing = this.choosing === account.id ? null : account.id;
      cx.notify();
      return;
    }
    this.busy = account.id;
    this.choosing = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const failed = way === "keep" ? await keepRunningOn(account, from) : way === "restart" ? await restartOn(account) : await handOff(account);
      this.busy = null;
      setShared("orcha.fuelRev", Date.now());
      // The switch cleared the account's cached fuel: read it again for FUEL.
      if (!failed) refreshFuel().then(() => setShared("orcha.fuelRev", Date.now()));
      if (failed) notify({ title: "The chat did not move", body: failed, level: "error" });
      else {
        const moved = this.keep?.others ? `This chat and ${this.keep.others} more on the same folder` : "This chat";
        const back = way === "keep" && account.id === this.home;
        const body = back ? `${moved} ${this.keep?.others ? "are" : "is"} back on ${this.keep?.others ? "their" : "its"} own account: nothing borrowed. Claude picks it up within half a minute.` : way === "keep" ? `${moved} keep${this.keep?.others ? "" : "s"} running, borrowing its sign-in (FUEL says BORROWED). Claude picks it up within half a minute. RETURN in ACCOUNTS ends the borrow.` : way === "restart" ? "Only this chat: same pane, restarted on the account." : "A new agent opens beside the old one and sums up first.";
        notify({ title: back ? `The chat is back on ${account.label ?? account.id}` : `The chat moves to ${account.label ?? account.id}`, body, level: "success", timeout: 6000 });
        this.close();
      }
      cx.notify();
    });
  }

  // No agent in front: a new chat on the account, in a new tab. The default
  // account stays as it is (Settings › Accounts).
  withoutAgent(account, cx) {
    cx.spawn(async () => {
      const failed = await startOn(account);
      if (failed) notify({ title: "The chat did not start", body: failed, level: "error" });
      else this.close();
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = "refresh";
    cx.notify();
    cx.spawn(async (cx) => {
      await refreshFuel(true);
      this.busy = null;
      setShared("orcha.fuelRev", Date.now());
      this.load(cx);
    });
  }

  row(k, a, i, best, cx) {
    const inUse = a.id === this.using;
    const isBest = a.id === best && !inUse;
    const cursor = i === this.at;
    // While the chat borrows: the account it is at home on, one click back.
    const isHome = a.id === this.home && !inUse;
    const enter = cursor ? " ↵" : "";
    const kindColor = a.kind === "claude" ? k.yellow : a.kind === "codex" ? k.green : a.kind === "cursor" ? k.blue : k.pink;
    const gauges = [
      fuelGauge(k, "5H", a.limits.session),
      fuelGauge(k, "WEEK", a.limits.weekly),
      fuelGauge(k, "MONTH", a.limits.monthly),
    ].filter(Boolean);
    const busy = this.busy === a.id;
    const token = tokenState(a);
    const action = busy
      ? div().text_size(11.5).text_color(k.dim).child("moving…")
      : needsSignIn(a, gauges)
        ? button(k, `sign-${a.id}`, `SIGN IN${enter}`, () => { signIn(a.id); this.close(); }, { small: true, primary: true })
        : inUse
          ? chip(k, "IN USE", k.ink, k.paper)
          : isHome
            ? button(k, `switch-${a.id}`, `RETURN${enter}`, (_e, cx) => this.switchTo(a, this.keep?.why ? null : "keep", cx), { primary: true, small: true })
            : button(k, `switch-${a.id}`, `SWITCH${enter}`, (_e, cx) => this.switchTo(a, null, cx), { primary: isBest, small: true });
    const choices = this.choosing === a.id
      ? h_flex()
          .gap(6)
          .pt(4)
          .items_center()
          .child(div().text_size(11.5).text_color(k.muted).child("Move this chat:"))
          .when(!this.keep?.why && !isStation(a), (el) => el.child(button(k, `keep-${a.id}`, this.keep?.others ? `KEEP RUNNING · ${this.keep.others + 1} CHATS` : "KEEP RUNNING", (_e, cx) => this.switchTo(a, "keep", cx), { small: true, primary: true })))
          .child(button(k, `restart-${a.id}`, "RESTART", (_e, cx) => this.switchTo(a, "restart", cx), { small: true, primary: Boolean(this.keep?.why) || isStation(a) }))
          .child(button(k, `pane-${a.id}`, "NEW PANE", (_e, cx) => this.switchTo(a, "new_pane", cx), { small: true }))
      : null;
    // What each way does, in a line: nobody should have to try one to find out.
    const keepLine = isStation(a) ? "No keep running on a hub account: its token lives only in claude's env."
      : this.keep?.why ? `No keep running: ${this.keep.why}`
      : this.keep?.others ? `Keep running: no restart, the ${this.keep.others + 1} chats on this folder move together, borrowing the account.`
      : "Keep running: no restart, the chat borrows the account within half a minute.";
    const keepNote = this.choosing !== a.id ? null
      : v_flex()
          .gap(1)
          .text_size(11)
          .text_color(k.dim)
          .child(div().child(keepLine))
          .child(div().child("Restart: same chat, only this pane, Claude starts again on the account."))
          .child(div().child("New pane: a new agent beside this one reads notes and sums up first."));
    const body = h_flex()
      .id(`account-${a.id}`)
      .flex_none()
      .relative()
      .gap(12)
      .p(10)
      .pl(inUse ? 16 : 12)
      .items_start()
      .rounded(6)
      .border(inUse || cursor ? 2.5 : 1.5)
      .border_color(inUse || cursor ? k.line : k.dim + "88")
      .bg(inUse || cursor ? k.card : k.paper)
      .overflow_hidden()
      .on_click((_e, cx) => {
        this.at = i;
        cx.notify();
      })
      .when(inUse, (el) => el.child(div().absolute().top(0).left(0).w(5).h_full().bg(k.yellow)))
      .child(chip(k, (a.kind ?? "agent").toUpperCase(), kindColor).border(1.5).border_color(k.line))
      .child(
        // min_w(0): long notes wrap and gauges fit instead of running out of the card.
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(this.renaming === a.id
                ? Input.new(this.renameInput).flex_1().min_w(0).h(24).px(6).rounded(5).border(2).border_color(k.line).bg(k.paper).text_size(12.5).text_color(k.ink)
                : div().font_black().text_color(k.ink).child(a.label ?? a.id))
              .when(this.renaming === a.id, (el) => el.child(div().flex_none().text_size(10.5).text_color(k.dim).child("↵ save · esc")))
              .when(isBest, (el) => el.child(chip(k, "BEST", k.green)))
              .when(isHome, (el) => el.child(chip(k, "HOME", k.pink)))
              // HUB / LOCAL only once a hub is paired: before that, nothing new shows.
              .when(this.hasHub && a.kind === "claude", (el) => el.child(chip(k, isStation(a) ? "HUB" : "LOCAL", isStation(a) ? k.blue : k.paper))),
          )
          .when(Boolean(a.why), (el) => el.child(div().text_size(11).text_color(readable(k, k.red)).child(`Can't start now: ${a.why}`)))
          .when(Boolean(a.email), (el) => el.child(div().text_size(11.5).text_color(k.dim).child(a.email)))
          .when(isHome, (el) => el.child(div().text_size(11).text_color(k.dim).child("This chat's own account: it borrows the one in use. RETURN ends the borrow, no restart.")))
          .when(Boolean(a.limits.note), (el) => el.child(div().text_size(11).text_color(k.dim).child(a.limits.note)))
          .children(gauges.length || token?.idle ? gauges : [div().text_size(11.5).text_color(a.limits.error ? readable(k, k.red) : k.dim).child(a.limits.error ?? "no fuel read yet: sign in, then refresh")])
          .when(Boolean(token), (el) => el.child(div().text_size(11).text_color(token.signIn ? readable(k, k.red) : k.dim).child(token.text)))
          .when(Boolean(choices), (el) => el.child(choices))
          .when(Boolean(keepNote), (el) => el.child(keepNote)),
      )
      .child(action);
    return body;
  }

  // The Keychain, when it is in the way: what happened and the one way out.
  keychainBox(k) {
    const kc = this.keychain;
    if (!kc || kc.state === "ok") return null;
    const move = (_e, cx) => {
      if (!this.confirmMove) {
        this.confirmMove = true;
        cx.notify();
        return;
      }
      this.confirmMove = false;
      this.busy = "keychain";
      cx.notify();
      cx.spawn(async (cx) => {
        const failed = await moveToKeychain();
        this.busy = null;
        if (failed) notify({ title: "The sign-in stayed in the file", body: failed, level: "error" });
        else notify({ title: "The sign-in is in the Keychain", body: "Switching works again.", level: "success", timeout: 5000 });
        this.load(cx);
      });
    };
    const box = {
      "file-only": {
        title: "Claude's sign-in is in a file, not the Keychain",
        body: `Fuel reads it fine. Moving a chat to another account needs it in the Keychain. Moves ${kc.files?.length === 1 ? kc.files[0].replace(/^\/Users\/[^/]+/, "~") : `${kc.files?.length ?? 0} files`} in, then deletes the file.`,
        action: this.busy === "keychain" ? div().text_size(11.5).text_color(k.dim).child("moving…") : button(k, "keychain-move", this.confirmMove ? "SURE? MOVE" : "MOVE TO KEYCHAIN", move, { small: true, primary: true }),
      },
      locked: {
        title: "The macOS Keychain is locked",
        body: "Claude can't save its sign-in there, and switching accounts can't either. Unlock it with your Mac's password, then press r.",
        action: button(k, "keychain-unlock", "UNLOCK", () => { unlockKeychain(); this.close(); }, { small: true, primary: true }),
      },
      broken: {
        title: "The macOS Keychain can't be written",
        body: "Usually the Mac's password changed and the login keychain kept the old one. In Keychain Access: Settings › Reset Default Keychain, then SIGN IN again here.",
        action: button(k, "keychain-open", "KEYCHAIN ACCESS", () => openKeychainAccess(), { small: true, primary: true }),
      },
    }[kc.state];
    if (!box) return null;
    return h_flex()
      .flex_none()
      .gap(10)
      .p(10)
      .items_start()
      .rounded(6)
      .border(2.5)
      .border_color(k.line)
      .bg(k.yellow + "33")
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().font_black().text_size(12.5).text_color(k.ink).child(`🔑 ${box.title}`))
          .child(div().text_size(11.5).text_color(k.muted).child(box.body))
          .when(Boolean(kc.why) && kc.state !== "file-only", (el) => el.child(div().text_size(11).text_color(k.dim).child(`macOS says: ${kc.why}`))),
      )
      .child(box.action);
  }

  // + ADD ACCOUNT, then a name box and ADD once clicked.
  addRow(k) {
    if (!this.adding) {
      return h_flex()
        .id("account-add")
        .flex_none()
        .h(40)
        .gap(6)
        .justify_center()
        .items_center()
        .rounded(6)
        .border(2)
        .border_dashed()
        .border_color(k.dim)
        .text_size(12)
        .font_black()
        .text_color(k.muted)
        .cursor_pointer()
        .hover((s) => s.bg(k.hover).text_color(k.ink))
        .on_click((_e, cx) => {
          this.adding = true;
          this.nameInput.focus();
          cx.notify();
        })
        .child(icon("user-plus", 14))
        .child("ADD ACCOUNT");
    }
    return h_flex()
      .flex_none()
      .gap(8)
      .p(8)
      .items_center()
      .rounded(6)
      .border(2.5)
      .border_color(k.line)
      .bg(k.card)
      .child(chip(k, "CLAUDE", k.yellow).border(1.5).border_color(k.line))
      .child(Input.new(this.nameInput).flex_1().min_w(0).h(28).px(8).rounded(5).border(2).border_color(k.line).bg(k.paper).text_size(12.5).text_color(k.ink))
      .child(this.busy === "add" ? div().text_size(11.5).text_color(k.dim).child("adding…") : button(k, "account-add-go", "ADD ↵", (_e, cx) => this.add(cx), { primary: true, small: true }));
  }

  key(e, cx) {
    const visible = this.visible();
    const n = visible.length;
    if (this.adding || this.renaming) {
      if (e.key !== "escape") return;
      this.adding = false;
      this.renaming = null;
      this.handle.focus();
      cx.notify();
      return;
    }
    if (e.key === "escape") return this.close();
    if (e.key === "a" && this.tab !== "hub") {
      this.adding = true;
      this.nameInput.focus();
      cx.notify();
      return;
    }
    if (e.key === "a") return;
    if (e.key === "r") return this.refresh(cx);
    if (!n) return;
    if (e.key === "e") return this.startRename(visible[this.at], cx);
    if (e.key === "down" || e.key === "j") this.at = (this.at + 1) % n;
    else if (e.key === "up" || e.key === "k") this.at = (this.at + n - 1) % n;
    else if (e.key === "enter") {
      // What the cursor row's button says: SIGN IN, RETURN or SWITCH.
      const a = visible[this.at];
      if (a.id !== this.using && needsSignIn(a, [a.limits.session, a.limits.weekly, a.limits.monthly].filter(Boolean))) {
        signIn(a.id);
        return this.close();
      }
      this.switchTo(a, a.id === this.home && !this.keep?.why ? "keep" : null, cx);
    } else return;
    cx.notify();
  }

  render(cx) {
    const k = tokens();
    const best = this.best();
    const visible = this.visible();
    const kcBox = this.tab === "hub" ? null : this.keychainBox(k);
    const keyHint = (key, what) => h_flex().gap(4).items_center().child(div().font_black().text_color(k.ink).child(key)).child(div().text_color(k.muted).child(what));
    const box = v_flex()
      .id("orcha-accounts")
      .w(560)
      .h(640)
      .rounded(8)
      .border(3)
      .border_color(k.line)
      .bg(k.paper)
      .overflow_hidden()
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(
        h_flex()
          .flex_none()
          .px(14)
          .h(48)
          .gap(10)
          .items_center()
          .bg(k.card)
          .border_b(2.5)
          .border_color(k.line)
          .child(icon("fuel", 18, k.ink))
          .child(div().font_black().text_size(14).text_color(k.ink).child("ACCOUNTS"))
          .child(div().flex_1().truncate().text_size(12).text_color(k.muted).child(!focusedAgent() ? "switch starts a new chat on the account" : this.home ? "this chat borrows the account in use · RETURN ends it" : "switch moves the chat in front of you"))
          .child(
            div()
              .id("accounts-close")
              .p(4)
              .rounded(5)
              .border(2)
              .border_color(k.line)
              .cursor_pointer()
              .hover((s) => s.bg(k.hover))
              .on_click(() => this.close())
              .child(icon("x", 14, k.ink)),
          ),
      )
      .when(this.hasHub, (el) => el.child(
        h_flex().flex_none().px(12).py(8).gap(8).bg(k.card).border_b(2).border_color(k.line)
          .child(button(k, "accounts-local-tab", this.tab === "local" ? "LOCAL ✓" : "LOCAL", (_e, cx) => this.selectTab("local", cx), { small: true, primary: this.tab === "local" }))
          .child(button(k, "accounts-hub-tab", this.tab === "hub" ? "HUB ✓" : "HUB", (_e, cx) => this.selectTab("hub", cx), { small: true, primary: this.tab === "hub" }))
      ))
      .child(
        v_flex()
          .id("accounts-list")
          .flex_1()
          .min_h(0)
          .p(12)
          .gap(8)
          .overflow_y_scrollbar()
          .when(Boolean(kcBox), (el) => el.child(kcBox))
          .children(visible.length ? visible.map((a, i) => this.row(k, a, i, best, cx)) : [div().p(12).text_color(k.dim).child(this.tab === "hub" ? "No hub accounts yet. Pair this Mac in Settings → Accounts → Hub." : "No local accounts yet. Add your first one below.")])
          .when(this.tab !== "hub", (el) => el.child(this.addRow(k))),
      )
      .child(
        h_flex()
          .flex_none()
          .px(14)
          .h(38)
          .gap(14)
          .items_center()
          .bg(k.card)
          .border_t(2.5)
          .border_color(k.line)
          .text_size(11.5)
          .child(keyHint("↵", focusedAgent() ? "switch" : "new chat"))
          .child(keyHint("↑↓", "move"))
          .when(this.tab !== "hub", (el) => el.child(keyHint("a", "add")).child(keyHint("e", "rename")))
          .child(keyHint("r", this.busy === "refresh" ? "refreshing…" : "refresh"))
          .child(div().flex_1())
          .child(keyHint("esc", "close")),
      );
    return raised(k, box, 5, 8);
  }
}
