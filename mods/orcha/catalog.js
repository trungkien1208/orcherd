// Orcherd's working rules and suggested skills (Settings › Projects): edit them here.
export const RULES = [
  {
    "id": "slices",
    "title": "Plan in slices first",
    "summary": "split the work into small slices and a todo list, wait for a go, then do one at a time",
    "body": "Before writing code for anything bigger than a one-line fix:\n1. Split the work into thin vertical slices, each one working and testable on its own.\n2. Write them as a todo list (use your todo tool if you have one), with how each slice will be checked.\n3. Show the list and wait for a go-ahead.\n4. Do one slice at a time: build it, check it, mark it done, then start the next.\nIf a slice turns out bigger than planned, stop and slice it again."
  },
  {
    "id": "verify",
    "title": "Verify before saying done",
    "summary": "run the project's checks and report what really happened",
    "body": "Do not call work done until you have run the project's own checks (typecheck, tests, lint) on what you changed. Report the real result: paste failures, and say plainly when a check was skipped or could not run."
  },
  {
    "id": "commit",
    "title": "Propose the commit message first",
    "summary": "small commits, a message the user agrees to before committing, never push unasked",
    "body": "Keep commits small and about one thing. Before committing, show the commit message and wait for agreement. Never push, force-push or open a pull request unless asked."
  },
  {
    "id": "careful",
    "title": "Ask before anything hard to undo",
    "summary": "deleting files, resetting, rewriting history or touching shared systems",
    "body": "Ask first before anything hard to undo: deleting or overwriting files you did not create, `git reset --hard`, rebases and force pushes, dropping data, or changing shared systems (CI, production, other people's branches)."
  },
  {
    "id": "scope",
    "title": "Stay in scope",
    "summary": "change only what the task needs; note the rest instead of fixing it",
    "body": "Change only what the task needs. When you notice something else worth fixing, write it down in your reply instead of fixing it, so the change stays easy to review."
  },
  {
    "id": "comments",
    "title": "Comments say why",
    "summary": "no comments that repeat the code; explain the reason or the trap",
    "body": "Write comments only where the code cannot say it: why it is done this way, a trap, a constraint from outside. Never comments that repeat what the code does."
  },
  {
    "id": "handoff",
    "title": "Keep a hand-off checklist",
    "summary": "on long tasks, keep .orcherd/handoff.md current so another agent can continue",
    "body": "On a task that takes more than a few steps, keep `.orcherd/handoff.md` up to date: what is done, what is next as `- [ ]` items, open questions, and the files touched. Another agent may have to continue from it if you run out of plan."
  },
  {
    "id": "root-cause",
    "title": "Fix the cause, not the symptom",
    "summary": "reproduce, trace back to the first wrong step and fix it there; no hiding guards",
    "body": "When fixing a bug, reproduce it first, then trace it back to the first place the code did something wrong and fix it there. If the state that broke things should never exist, do not add a guard, retry, clamp or swallowed error where it surfaced: find what produced it. Look for the same fault elsewhere and fix those too."
  }
];

// Skill groups, in the order Settings › Projects and PROJECT SETUP show them.
export const GROUPS = [
  {
    "name": "Plan",
    "about": "Before coding: turn an idea into a plan you both agree on."
  },
  {
    "name": "Build",
    "about": "While coding: small changes, tests first, code that reads well."
  },
  {
    "name": "Debug",
    "about": "When something breaks or gets slow: find the real cause first."
  },
  {
    "name": "Check",
    "about": "Before merging: prove it works and find what it could break."
  },
  {
    "name": "UI",
    "about": "Building screens: a look of its own and polished details."
  },
  {
    "name": "Talk",
    "about": "How the agent talks to you and how its writing sounds."
  },
  {
    "name": "Catch up",
    "about": "Coming back to a chat, or handing it to a fresh agent."
  },
  {
    "name": "Skills",
    "about": "Find more skills, or make your own."
  }
];

export const SKILLS = [
  {
    "name": "to-tickets",
    "title": "To tickets",
    "summary": "cuts a plan into small slices, each one you can build and check on its own. Type /to-tickets",
    "group": "Plan",
    "source": "mattpocock/skills",
    "skills": [
      "to-tickets"
    ]
  },
  {
    "name": "grill-me",
    "title": "Grill me",
    "summary": "asks you question after question about a plan until nothing is left open. Type /grill-me",
    "group": "Plan",
    "source": "mattpocock/skills",
    "skills": [
      "grill-me"
    ]
  },
  {
    "name": "writing-plans",
    "title": "Superpowers: plans",
    "summary": "brainstorms with you, writes a step-by-step plan, then works through it with checks",
    "group": "Plan",
    "source": "obra/superpowers",
    "skills": [
      "writing-plans",
      "executing-plans",
      "brainstorming"
    ]
  },
  {
    "name": "improve-codebase-architecture",
    "title": "Improve architecture",
    "summary": "finds code that is hard to test or change, suggests how to reshape it, then talks the one you pick through. Type /improve-codebase-architecture",
    "group": "Plan",
    "source": "mattpocock/skills",
    "skills": [
      "improve-codebase-architecture"
    ]
  },
  {
    "name": "tdd",
    "title": "Test-driven development",
    "summary": "writes a failing test first, then just enough code to make it pass",
    "group": "Build",
    "source": "mattpocock/skills",
    "skills": [
      "tdd"
    ]
  },
  {
    "name": "ponytail",
    "title": "Ponytail",
    "summary": "the smallest change that solves the task, plus a code review in plain English",
    "group": "Build",
    "source": "DietrichGebert/ponytail",
    "skills": [
      "ponytail",
      "ponytail-review"
    ]
  },
  {
    "name": "code-simplification",
    "title": "Code simplification",
    "summary": "makes working code easier to read without changing what it does",
    "group": "Build",
    "source": "addyosmani/agent-skills",
    "skills": [
      "code-simplification"
    ]
  },
  {
    "name": "systematic-debugging",
    "title": "Superpowers: debugging",
    "summary": "finds the cause before touching code, and checks the fix before calling it done",
    "group": "Debug",
    "source": "obra/superpowers",
    "skills": [
      "systematic-debugging",
      "verification-before-completion"
    ]
  },
  {
    "name": "diagnosing-bugs",
    "title": "Diagnosing bugs",
    "summary": "a step-by-step loop for hard bugs and slowdowns: reproduce, narrow it down, prove the cause",
    "group": "Debug",
    "source": "mattpocock/skills",
    "skills": [
      "diagnosing-bugs"
    ]
  },
  {
    "name": "blast-radius",
    "title": "Blast radius",
    "summary": "finds what a change could break outside the diff, and proves the key safety point by running code. Type /blast-radius",
    "group": "Check",
    "source": "cursor/plugins",
    "skills": [
      "blast-radius"
    ]
  },
  {
    "name": "doubt-driven-development",
    "title": "Doubt-driven development",
    "summary": "a fresh reviewer tries to disprove each big decision before the agent builds on it",
    "group": "Check",
    "source": "addyosmani/agent-skills",
    "skills": [
      "doubt-driven-development"
    ]
  },
  {
    "name": "agent-browser",
    "title": "Agent browser",
    "summary": "the agent opens your web app, clicks through it and takes screenshots. Needs the CLI: npm i -g agent-browser",
    "group": "Check",
    "source": "vercel-labs/agent-browser",
    "skills": [
      "agent-browser"
    ]
  },
  {
    "name": "correct",
    "title": "Correct",
    "summary": "turns mistakes agents keep repeating in this repo into checks that block them. Type /correct after you had to correct one",
    "group": "Check",
    "source": "cursor/plugins",
    "skills": [
      "correct"
    ]
  },
  {
    "name": "design-taste-frontend",
    "title": "Design taste",
    "summary": "landing pages and redesigns that do not look like a template",
    "group": "UI",
    "source": "leonxlnx/taste-skill",
    "skills": [
      "design-taste-frontend"
    ]
  },
  {
    "name": "frontend-design",
    "title": "Frontend design",
    "summary": "Anthropic's guide to a look of its own: colors, type and layout picked for the brief",
    "group": "UI",
    "source": "anthropics/skills",
    "skills": [
      "frontend-design"
    ]
  },
  {
    "name": "make-interfaces-feel-better",
    "title": "Interfaces that feel better",
    "summary": "polishes the details: spacing, motion, shadows, hover and focus",
    "group": "UI",
    "source": "jakubkrehel/make-interfaces-feel-better",
    "skills": [
      "make-interfaces-feel-better"
    ]
  },
  {
    "name": "i-have-adhd",
    "title": "I have ADHD",
    "summary": "answers start with the next step, number the work and skip tangents. Type /i-have-adhd",
    "group": "Talk",
    "source": "ayghri/i-have-adhd",
    "skills": [
      "i-have-adhd"
    ]
  },
  {
    "name": "caveman",
    "title": "Caveman",
    "summary": "short answers with the same facts: far fewer words and tokens. Type /caveman",
    "group": "Talk",
    "source": "JuliusBrussee/caveman",
    "skills": [
      "caveman",
      "caveman-commit",
      "caveman-review"
    ]
  },
  {
    "name": "humanizer",
    "title": "Humanizer",
    "summary": "rewrites text so it stops sounding like AI",
    "group": "Talk",
    "source": "blader/humanizer",
    "skills": [
      "humanizer"
    ]
  },
  {
    "name": "ketchup",
    "title": "Ketchup",
    "summary": "what changed since your last message and every decision waiting on you. Type /ketchup, or /bro to restate the last reply plainly",
    "group": "Catch up",
    "source": "cursor/plugins",
    "skills": [
      "ketchup",
      "bro"
    ]
  },
  {
    "name": "handoff",
    "title": "Handoff",
    "summary": "squeezes the chat into a note a fresh agent can continue from. Type /handoff",
    "group": "Catch up",
    "source": "mattpocock/skills",
    "skills": [
      "handoff"
    ]
  },
  {
    "name": "find-skills",
    "title": "Find skills",
    "summary": "looks for a ready-made skill when you ask how to do something",
    "group": "Skills",
    "source": "vercel-labs/skills",
    "skills": [
      "find-skills"
    ]
  },
  {
    "name": "skill-creator",
    "title": "Skill creator",
    "summary": "writes a new skill with you, tests it and tunes when it kicks in",
    "group": "Skills",
    "source": "anthropics/skills",
    "skills": [
      "skill-creator"
    ]
  }
];
