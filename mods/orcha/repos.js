// Projects by git repo, for the sidebar's repo cards (left.js): which repo
// each space's folder is in, the spaces grouped by it, and the moves that put
// a dragged group somewhere else.

import { exec, run } from "herdr";

/** Each space's panes, its live folder and its repo key, from one pass over
 *  the panes: Map space id → { cwd, mine, agents, shells, key }. The live folder
 *  is its first terminal's (else where it was made), as Herdr names it. */
export function indexSpaces(list, allPanes) {
  const byTab = new Map();
  for (const p of allPanes) {
    const tab = byTab.get(p.tab);
    if (tab) tab.push(p);
    else byTab.set(p.tab, [p]);
  }
  const out = new Map();
  for (const space of list) {
    const mine = space.tabs.flatMap((t) => byTab.get(t.id) ?? []);
    const cwd = mine.find((p) => p.cwd)?.cwd || space.folder || "";
    out.set(space.id, {
      cwd,
      mine,
      agents: mine.filter((p) => p.program?.agent),
      shells: mine.filter((p) => !p.program?.agent),
      key: `${space.machine ?? ""}\n${cwd}`,
    });
  }
  return out;
}

/** The repo a key's folder is in: { repo, main, top, linked }, null outside git. */
export async function readRepo(key) {
  const at = key.indexOf("\n");
  const on = key.slice(0, at) || null;
  const cwd = key.slice(at + 1);
  try {
    const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--show-prefix"], { cwd, on });
    const [top, common, prefix] = r.code === 0 ? r.stdout.split("\n") : [];
    if (!top || !common) return null;
    // A folder inside a checkout (a project kept in a bigger repo's folder, a
    // package of a monorepo) is a project of its own, not a worktree of it.
    if (prefix) return { repo: `${on ?? ""}\n${common}\n${prefix}`, main: cwd, top: cwd, linked: false };
    // A submodule's git folder sits in its parent's: its own repo, not a worktree.
    const sub = common.includes("/.git/modules/");
    const main = sub ? top : common.endsWith("/.git") ? common.slice(0, -5) : common;
    return { repo: `${on ?? ""}\n${sub ? top : common}`, main, top, linked: main !== top };
  } catch {
    return null; // the machine is unreachable
  }
}

/** Spaces by repo, in the order the first of each shows: the main checkout
 *  first, then its worktrees. A space outside git (or not read yet) is its
 *  own group: { info, machine, members: [{ space, info }] }. */
export function groupSpaces(list, index, git) {
  const out = [];
  const byRepo = new Map();
  for (const space of list) {
    const info = git[index.get(space.id).key] ?? null;
    const known = info && byRepo.get(info.repo);
    if (known) {
      known.members.push({ space, info });
      continue;
    }
    const group = { info, machine: space.machine ?? null, members: [{ space, info }] };
    if (info) byRepo.set(info.repo, group);
    out.push(group);
  }
  // Stable: worktrees keep their order behind the main checkout.
  for (const g of out) if (g.members.length > 1) g.members.sort((a, b) => Number(a.info.linked) - Number(b.info.linked));
  return out;
}

/** A group shown as a repo card: more than one checkout, or a worktree alone. */
export const isRepo = (g) => Boolean(g.info) && (g.members.length > 1 || g.info.linked);
export const repoKey = (g) => `repo:${g.info.repo}`;

/** Puts group `from` where group `to` is: one space.move per space that has
 *  to go (each takes it out, then puts it at its index), over `ids`, the
 *  spaces in their current order. */
export function moveGroup(groups, from, to, ids) {
  const moved = [...groups];
  moved.splice(to, 0, ...moved.splice(from, 1));
  const order = moved.flatMap((g) => g.members.map((m) => m.space.id));
  if (order.length !== ids.length) return;
  const now = [...ids];
  order.forEach((id, at) => {
    if (now[at] === id) return;
    now.splice(now.indexOf(id), 1);
    now.splice(at, 0, id);
    run("space.move", { id, index: at + 1 });
  });
}
