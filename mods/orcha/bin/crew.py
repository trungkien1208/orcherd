#!/usr/bin/env -S python3 -I
"""CREW, the right panel's subagents of one Claude chat, as JSON.

  crew.py <subagents folder>      the ones running now and the ones finished
                                  in the last 5 minutes (longer while helpers
                                  of their own run), each under its parent
  crew.py detail <agent-*.jsonl>  one of them in full: its brief, each tool it
                                  called (what on, failed or not) and its report

Claude Code writes, beside each chat, <session>/subagents/agent-<id>.jsonl
(what the subagent did) and agent-<id>.meta.json ({ description, agentType,
model, spawnDepth, toolUseId, finished }). Those are only read. A subagent's
file can reach tens of MB and the panel asks every 2 s, so what was read of
each is kept in ~/.cache/orcherd/crew/<id>.json and only what was added
since is read.

Cost is a rough estimate from token counts and list prices (the table
johnnyvizz/claude-kit's savvy-progress uses, MIT), not a bill.
"""
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime

DONE_KEEP = 5 * 60  # a finished one stays this long, then leaves CREW
STALE = 10 * 60  # one that wrote nothing this long, never finished: gone (Esc, chat closed)
NEWEST = 12  # files looked at, by last write
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "orcherd", "crew")
STATE = 1  # raise when the kept state changes shape: old ones are read again

# Per million tokens: input, output, cache read, cache write (5 minutes);
# a 1-hour cache write costs twice the input. First match wins.
PRICES = [
    ("fable-5-1", (10, 50, 0.25, 12.5)), ("mythos-5-1", (10, 50, 0.25, 12.5)),
    ("fable", (10, 50, 1, 12.5)), ("mythos", (10, 50, 1, 12.5)),
    ("opus-5-5", (4, 20, 0.2, 5)), ("opus", (5, 25, 0.5, 6.25)),
    ("sonnet-5-5", (2, 10, 0.1, 2.5)), ("sonnet-5", (2, 10, 0.2, 2.5)), ("sonnet", (3, 15, 0.3, 3.75)),
    ("haiku-5-5", (0.1, 0.5, 0.01, 0.125)), ("haiku", (1, 5, 0.1, 1.25)),
]
TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")

# The part of a tool's input that says what it was for, by tool.
WHAT = {"Read": "file_path", "Edit": "file_path", "Write": "file_path", "NotebookEdit": "notebook_path",
        "Grep": "pattern", "Glob": "pattern", "Bash": "command", "WebFetch": "url", "WebSearch": "query",
        "Agent": "description", "Task": "description", "Skill": "skill", "ToolSearch": "query"}


def cost(model, u):
    i, o, r, w = next((p for key, p in PRICES if key in (model or "")), PRICES[4][1])
    hour = (u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0
    five = (u.get("cache_creation_input_tokens") or 0) - hour
    return ((u.get("input_tokens") or 0) * i + (u.get("output_tokens") or 0) * o
            + (u.get("cache_read_input_tokens") or 0) * r + five * w + hour * 2 * i) / 1e6


def what(name, args):
    """A tool call in one line: "app/main.js", "git status", "3 todos"."""
    if not isinstance(args, dict):
        return ""
    if name == "TodoWrite":
        return f"{len(args.get('todos') or [])} todos"
    key = WHAT.get(name, "")
    value = args.get(key) or next((v for v in args.values() if isinstance(v, str) and v.strip()), "")
    line = str(value).strip().splitlines()[0] if str(value).strip() else ""
    if key.endswith("_path") and "/" in line:
        line = "/".join(line.rstrip("/").split("/")[-2:])  # its folder and name
    elif name == "Bash":
        line = re.split(r"&&|;\s", line)[-1].strip() or line  # the command, past `cd …;` and `export …&&`
    return line.replace(os.path.expanduser("~"), "~", 1)[:160]


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


def fresh():
    return {"v": STATE, "offset": 0, "start": None, "last": None, "tokens": 0, "cost": 0.0, "mid": None,
            "mid_tokens": 0, "mid_cost": 0.0, "tools": 0, "tool": None, "doing": "", "todos": None,
            "effort": None, "context": 0, "model": None, "agents": []}


def scan(fh, s, full=None):
    """Reads the complete lines from s["offset"] on into state `s`; `full`
    (a dict) also gets the brief, every call and the report."""
    fh.seek(s["offset"])
    data = fh.read()
    end = data.rfind(b"\n") + 1
    s["offset"] += end
    for line in data[:end].splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        try:
            at = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).timestamp()
        except (KeyError, TypeError, ValueError, AttributeError):
            at = None
        if at:
            s["start"] = s["start"] or at
            s["last"] = at
        kind = row.get("type")
        if kind == "api-request":
            s["effort"] = ((row.get("params") or {}).get("output_config") or {}).get("effort") or s["effort"]
        msg = row.get("message")
        if not isinstance(msg, dict):
            continue
        if full is not None and kind == "user":
            content = msg.get("content")
            if full["brief"] is None and not text_of(content).lstrip().startswith("<"):
                full["brief"] = text_of(content).strip() or None
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("is_error"):
                    full["failed"].add(block.get("tool_use_id"))
        if kind != "assistant":
            continue
        u = msg.get("usage")
        if isinstance(u, dict):
            # Each block of a message is a line repeating its usage: count it once.
            n, c = sum(u.get(k) or 0 for k in TOKEN_KEYS), cost(msg.get("model"), u)
            if msg.get("id") and msg.get("id") == s["mid"]:
                s["tokens"] += n - s["mid_tokens"]
                s["cost"] += c - s["mid_cost"]
            else:
                s["tokens"] += n
                s["cost"] += c
            s["mid"], s["mid_tokens"], s["mid_cost"], s["context"] = msg.get("id"), n, c, n
            if msg.get("model") and not msg["model"].startswith("<"):
                s["model"] = msg["model"]
        for block in msg.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                name, args = block.get("name"), block.get("input")
                s["tools"] += 1
                s["tool"], s["doing"] = name, what(name, args)
                if name in ("Agent", "Task"):
                    s["agents"].append(block.get("id"))
                if name == "TodoWrite" and isinstance(args, dict):
                    s["todos"] = args.get("todos")
                if full is not None and name == "SubagentHandback":
                    full["report"] = args.get("message") if isinstance(args, dict) else None
                elif full is not None:
                    full["calls"].append({"id": block.get("id"), "at": int(at * 1000) if at else None,
                                          "tool": (name or "?").split("__")[-1], "what": s["doing"]})
            elif full is not None and block.get("type") == "text" and block.get("text", "").strip():
                full["said"] = block["text"].strip()
    return s


def kept(path):
    """The state read so far of one subagent's file, brought up to date."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, os.path.basename(path)[:-6] + ".json")
    size = os.path.getsize(path)
    try:
        with open(cache) as fh:
            s = json.load(fh)
        if s.get("v") != STATE or s.get("offset", 0) > size:
            s = fresh()  # an old shape, or the file was rewritten
    except (OSError, ValueError):
        s = fresh()
    if s["offset"] == size:
        return s
    with open(path, "rb") as fh:
        scan(fh, s)
    fd, tmp = tempfile.mkstemp(dir=CACHE, suffix=".tmp")
    with os.fdopen(fd, "w") as fh:
        json.dump(s, fh)
    os.replace(tmp, cache)
    return s


def meta_of(path):
    try:
        with open(path[:-6] + ".meta.json") as fh:
            meta = json.load(fh)
        return meta if isinstance(meta, dict) else {}
    except (OSError, ValueError):
        return {}


def level_of(meta):
    return meta.get("spawnDepth") if isinstance(meta.get("spawnDepth"), int) else 1


def summary(path, s, meta, now):
    finished = meta.get("finished") is True
    todos = s["todos"]
    steps = None
    if isinstance(todos, list) and todos:
        steps = {"done": sum(1 for t in todos if isinstance(t, dict) and t.get("status") == "completed"), "total": len(todos)}
    return {
        "id": os.path.basename(path)[:-6],
        "title": meta.get("description") or meta.get("agentType") or "subagent",
        "type": meta.get("agentType"),
        "model": s["model"] or meta.get("model"),
        "effort": s["effort"],
        "status": "done" if finished else "running",
        # "mcp__server__tool" → "tool"
        "tool": s["tool"].split("__")[-1] if s["tool"] else None,
        "doing": s["doing"],  # what that last tool was for
        "tools": s["tools"],
        "context": s["context"],
        "tokens": s["tokens"],
        "cost": round(s["cost"], 4),
        "steps": steps,
        "start": int(s["start"] * 1000) if s["start"] else None,
        "last": int(s["last"] * 1000) if s["last"] else None,
        # Finished over 5 minutes ago, or silent past STALE: shown only while
        # helpers of its own still run.
        "_old": (s["last"] or 0) < now - (DONE_KEEP if finished else STALE),
        "_level": level_of(meta),
        "_from": meta.get("toolUseId"),
        "_agents": set(s["agents"]),
    }


PRIVATE = ("_old", "_level", "_from", "_agents")


def main(folder):
    now = time.time()
    try:
        names = [n for n in os.listdir(folder) if n.startswith("agent-") and n.endswith(".jsonl")]
    except OSError:
        names = []
    paths = sorted((os.path.join(folder, n) for n in names), key=os.path.getmtime, reverse=True)
    recent = [p for p in paths[:NEWEST] if os.path.getmtime(p) >= now - max(DONE_KEEP, STALE)]
    out = []
    for path in recent:
        try:
            out.append(summary(path, kept(path), meta_of(path), now))
        except OSError:
            continue

    # A subagent's parent is one level up with the Agent call that started it
    # (its meta's toolUseId). A helper's own file repeats its parent's calls
    # (its own one, its siblings'), hence the level.
    def parent_of(a):
        return next((p for p in out if p["_level"] == a["_level"] - 1 and a["_from"] in p["_agents"]), None)

    # A helper whose parent wrote nothing lately: look one level up among the
    # older files (their metas first; a file is read once, then kept).
    older = paths[len(recent):len(recent) + 40]
    for _ in range(3):
        lost = [a for a in out if a["_level"] > 1 and a["_from"] and not parent_of(a)]
        levels = {a["_level"] - 1 for a in lost}
        found = []
        for path in older if lost else []:
            meta = meta_of(path)
            if level_of(meta) not in levels:
                continue
            try:
                a = summary(path, kept(path), meta, now)
            except OSError:
                continue
            if any(x["_from"] in a["_agents"] for x in lost):
                found.append(path)
                out.append(a)
        older = [p for p in older if p not in found]
        if not found:
            break

    kids = {}
    for a in out:
        parent = parent_of(a) if a["_level"] > 1 else None
        kids.setdefault(parent["id"] if parent else None, []).append(a)
    ordered = []

    def walk(key, depth):
        """Lists the subagents under `key`, depth first; how many of them still run."""
        busy = 0
        for a in kids.get(key, []):
            ordered.append(a)
            a["depth"] = depth
            a["helpers"] = walk(a["id"], depth + 1)  # its own subagents still running
            busy += a["helpers"] + (a["status"] == "running" and not a["_old"])
        return busy
    walk(None, 1)
    shown = [a for a in ordered if not a["_old"] or a["helpers"]]
    for a in shown:
        for k in PRIVATE:
            del a[k]
    print(json.dumps(shown))


def detail(path):
    if not (os.path.basename(path).startswith("agent-") and path.endswith(".jsonl")):
        sys.exit(__doc__)
    full = {"brief": None, "calls": [], "failed": set(), "said": "", "report": None}
    try:
        with open(path, "rb") as fh:
            s = scan(fh, fresh(), full)
    except OSError as e:
        sys.exit(f"Can't read {path}: {e.strerror}")
    a = summary(path, s, meta_of(path), time.time())
    for k in PRIVATE:
        del a[k]
    calls = full["calls"]
    for c in calls:
        c["failed"] = c.pop("id") in full["failed"]
    a.update(brief=full["brief"], calls=calls[-300:], skipped=max(0, len(calls) - 300),
             report=full["report"] or full["said"] or None)
    print(json.dumps(a))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "detail":
        detail(sys.argv[2])
    elif len(sys.argv) == 2:
        main(sys.argv[1])
    else:
        sys.exit(__doc__)
