// ACCOUNTS (SPEC §3.2), opened from FUEL or the header: one row per account
// with its plan limits. The account the agent in front of you runs on has the
// heavy border, the yellow edge and IN USE; the one with the most fuel left is
// BEST and gets the raised green SWITCH. SWITCH moves only the chat in front
// of you (Settings › Hand-off says how, else it asks: keep running, restart,
// new pane); keep running borrows the account's sign-in in the chat's folder,
// with any chat sharing it, and FUEL shows it BORROWED.
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
import { readAccounts, tokenState, needsSignIn, refreshFuel, addAccount, signIn, handOff, restartOn, keepRunningOn, keepInfo, startOn, claudeAccountOf, readHandoff, focusedAgent, readKeychain, keychainBlocks, moveToKeychain, unlockKeychain, openKeychainAccess, isStation, sameClaude } from "./accounts-data.js";
import { tokens, raised, chip, button, icon, fuelGauge, fuelLeft, readable } from "./ui.js";

export default class Accounts {
  constructor(cx) {
    this.list = [];
    this.at = 0;
    this.busy = null;
    this.choosing = null; // account id whose hand-off choices show
    this.adding = false;
    this.mode = "ask";
    this.keychain = null;
    this.confirmMove = false;
    this.nameInput = InputState.new({ placeholder: "name, like personal or work" });
    this.nameInput.on("submit", (_e, cx) => this.add(cx));
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
      // What IN USE means: the account of the agent in front of you.
      const from = focusedAgent();
      const key = from?.program?.key ?? "claude";
      if (key.includes("claude")) this.using = (from?.terminal && (await claudeAccountOf(from.terminal))) || active;
      else this.using = list.find((a) => key.includes(a.kind))?.id ?? null;
      // What keep running would do: why not, or how many other chats move with it.
      this.keep = from && key.includes("claude") ? await keepInfo(from) : { why: null, others: 0 };
      // Keep running writes the Keychain: it waits for it.
      if (list.some((a) => a.kind === "claude")) this.keychain = await readKeychain();
      const blocked = keychainBlocks(this.keychain);
      if (blocked && !this.keep.why) this.keep = { ...this.keep, why: blocked };
      const current = list.findIndex((a) => a.id === this.using);
      if (current >= 0 && this.at === 0) this.at = current;
      cx.notify();
    });
  }

  // The Claude account with the most fuel left, by its tighter limit.
  best() {
    let best = null;
    let most = -1;
    const using = this.list.find((a) => a.id === this.using);
    for (const a of this.list) {
      if (a.kind !== "claude" || a.why) continue;
      // With a hub: the same Claude account under the other source is one fuel, no way out.
      if (this.hasHub && using && a.id !== using.id && sameClaude(a, using)) continue;
      const fuel = Math.min(fuelLeft(a.limits.session) ?? 100, fuelLeft(a.limits.weekly) ?? 100);
      if (fuel > most) {
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

  // SWITCH: Claude to Claude has three ways (orcha's switch_mode); anything
  // else continues in a new pane with notes.
  switchTo(account, how, cx) {
    const from = focusedAgent();
    if (!from) return this.withoutAgent(account, cx);
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
        const body = way === "keep" ? `${moved} keep running, borrowing its sign-in (FUEL says BORROWED). Claude picks it up within half a minute.` : way === "restart" ? "Only this chat: same pane, restarted on the account." : "A new agent opens beside the old one and sums up first.";
        notify({ title: `The chat moves to ${account.label ?? account.id}`, body, level: "success", timeout: 5000 });
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
        ? button(k, `sign-${a.id}`, "SIGN IN", () => { signIn(a.id); this.close(); }, { small: true, primary: true })
        : inUse
          ? chip(k, "IN USE", k.ink, k.paper)
          : button(k, `switch-${a.id}`, isBest ? "SWITCH ↵" : "SWITCH", (_e, cx) => this.switchTo(a, null, cx), { primary: isBest, small: true });
    const choices = this.choosing === a.id
      ? h_flex()
          .gap(6)
          .pt(4)
          .items_center()
          .child(div().text_size(11.5).text_color(k.muted).child("Move this chat:"))
          .when(!this.keep?.why && !isStation(a), (el) => el.child(button(k, `keep-${a.id}`, this.keep?.others ? `KEEP RUNNING · ${this.keep.others + 1} CHATS` : "KEEP RUNNING", (_e, cx) => this.switchTo(a, "keep", cx), { small: true, primary: true })))
          .child(button(k, `restart-${a.id}`, "RESTART", (_e, cx) => this.switchTo(a, "restart", cx), { small: true, primary: Boolean(this.keep?.why) }))
          .child(button(k, `pane-${a.id}`, "NEW PANE", (_e, cx) => this.switchTo(a, "new_pane", cx), { small: true }))
      : null;
    const keepNote =
      this.choosing !== a.id ? null
      : this.keep?.why ? div().text_size(11).text_color(k.dim).child(`No keep running: ${this.keep.why}`)
      : this.keep?.others ? div().text_size(11).text_color(k.dim).child(`Keep running moves the ${this.keep.others + 1} chats on this folder together, no restart. Restart moves only this one.`)
      : null;
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
              .child(div().font_black().text_color(k.ink).child(a.label ?? a.id))
              .when(isBest, (el) => el.child(chip(k, "BEST", k.green)))
              // HUB / LOCAL only once a hub is paired: before that, nothing new shows.
              .when(this.hasHub && a.kind === "claude", (el) => el.child(chip(k, isStation(a) ? "HUB" : "LOCAL", isStation(a) ? k.blue : k.paper))),
          )
          .when(Boolean(a.why), (el) => el.child(div().text_size(11).text_color(readable(k, k.red)).child(`Can't start now: ${a.why}`)))
          .when(Boolean(a.email), (el) => el.child(div().text_size(11.5).text_color(k.dim).child(a.email)))
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
    const n = this.list.length;
    if (this.adding) {
      if (e.key !== "escape") return;
      this.adding = false;
      this.handle.focus();
      cx.notify();
      return;
    }
    if (e.key === "escape") return this.close();
    if (e.key === "a") {
      this.adding = true;
      this.nameInput.focus();
      cx.notify();
      return;
    }
    if (!n) return;
    if (e.key === "down" || e.key === "j") this.at = (this.at + 1) % n;
    else if (e.key === "up" || e.key === "k") this.at = (this.at + n - 1) % n;
    else if (e.key === "enter") this.switchTo(this.list[this.at], null, cx);
    else if (e.key === "r") this.refresh(cx);

    else return;
    cx.notify();
  }

  render(cx) {
    const k = tokens();
    const best = this.best();
    const kcBox = this.keychainBox(k);
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
          .child(div().flex_1().truncate().text_size(12).text_color(k.muted).child(focusedAgent() ? "switch moves the chat in front of you" : "switch starts a new chat on the account"))
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
      .child(
        v_flex()
          .id("accounts-list")
          .flex_1()
          .min_h(0)
          .p(12)
          .gap(8)
          .overflow_y_scrollbar()
          .when(Boolean(kcBox), (el) => el.child(kcBox))
          .children(this.list.length ? this.list.map((a, i) => this.row(k, a, i, best, cx)) : [div().p(12).text_color(k.dim).child("No accounts yet. Add your first one below.")])
          .child(this.addRow(k)),
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
          .child(keyHint("↵", "switch"))
          .child(keyHint("↑↓", "move"))
          .child(keyHint("a", "add"))
          .child(keyHint("r", this.busy === "refresh" ? "refreshing…" : "refresh"))
          .child(div().flex_1())
          .child(keyHint("esc", "close")),
      );
    return raised(k, box, 5, 8);
  }
}
