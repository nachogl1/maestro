---
name: handoff
description: ORION - Compact the current conversation into a handoff document for another agent to pick up. Captures the ephemeral knowledge that lives only in the chat — the goal, current state, decisions and their rationale, dead-ends, open questions, and next steps — while REFERENCING (never re-pasting) artifacts already written down (specs, plans, ADRs, issues, commits, diffs). Asks the user where to save the file — deliberately OUTSIDE the current workspace — and redacts secrets/PII before writing. If arguments are given, they describe what the next session will focus on and the document is tailored to that. Use when the user says "/handoff", "hand this off", "write a handoff for the next session", or "compact this conversation for another agent".
argument-hint: What will the next session be used for?
---

# handoff

> [!NOTE]
> **Editing this skill?** Keep everything here **general**: no project, person, company or stack names. It writes one local file outside the workspace and never touches git; the model may offer it only on a clear user cue (see *When it runs*).

Distil the **current conversation** into a single markdown handoff document so a fresh agent — with none of this chat's memory — can pick up exactly where this one left off. The value of the document is the knowledge that exists *only* in the conversation: the goal, the current state, the decisions and *why* they were made, the approaches that were tried and rejected, the open questions, and the immediate next steps. Everything already recorded elsewhere (a spec, a plan, an ADR, an issue, a commit, a diff) is **linked, not copied**.

## Why this exists

When a session gets long, is about to be compacted, or the work is being passed to a different agent/person, the durable artifacts (code, commits, issues, docs) only tell half the story. The other half — the reasoning, the rejected paths, the "we decided X because Y", the "don't bother trying Z, it doesn't work" — lives in the chat and evaporates when the session ends. This skill freezes that half into a portable file the next agent can read in one pass, without re-deriving anything and without wading back through the whole transcript.

## When it runs

It runs when the user types `/handoff` or asks for a handoff, and the model may also invoke it when the user clearly wants the conversation handed over to another session (for example when they say the context is nearly full and the work must continue elsewhere). The model never volunteers one mid-task without such a cue: writing a handoff is the user's decision.

## Arguments — what the next session is for

The slash command takes free-text arguments describing **what the next session will focus on** (the `argument-hint` is *"What will the next session be used for?"*).

- **Args present** — treat them as the next session's objective and *tailor the whole document to it*: lead with that objective, and bias "Current state", "Next steps", and "Pointers" toward what that specific follow-on work needs. Example: `/handoff finish the auth refactor and get CI green` → the doc foregrounds the auth work and the failing checks.
- **No args** — the handoff is general: "continue the work described below." Still capture everything, just without a narrowed focus.

## Step 1 — Read the situation (gather, don't duplicate)

Before writing anything, take stock. The goal is to separate **what's already written down** (link it) from **what only exists in this chat** (capture it).

1. **Scan the conversation** for: the original goal, decisions made, alternatives considered and rejected, problems hit and how they were (or weren't) resolved, and anything the user explicitly asked to remember or avoid.
2. **Inventory the durable artifacts** the conversation produced or touched, so you can reference them by path/URL instead of restating them. Run what's relevant and cheap:
   - `git status` and `git log --oneline -15` — branch, recent commits, uncommitted work.
   - `git diff --stat` (and `git diff` only if you need to *summarise*, not paste) — what's changed in the working tree.
   - Open PRs / issues if the tracker is in play (`gh pr view`, `gh issue list`) — capture numbers/URLs, not bodies.
   - Any files written this session (specs, plans, ADRs, reports) — capture their paths.
3. **Get a real timestamp** for the document header — don't guess it. Run `date "+%Y-%m-%d %H:%M"` (or the platform equivalent) and use the result.

Do **not** paste large blobs (full diffs, whole file contents, entire issue bodies, long logs) into the handoff. If the next agent needs that detail, they can open the artifact — give them the path/URL and a one-line summary of what's in it.

## Step 2 — Ask where to save it (NOT the current workspace)

The handoff document is *meta-work about the conversation*, not a project artifact — it must **not** land inside the current repo/workspace (where it would pollute the tree or get committed by accident). Ask the user where to save it using the clickable-options tool (`AskUserQuestion`), phrased for someone who may not know the machine's folder layout.

First determine the current workspace root so you can *exclude* it: run `git rev-parse --show-toplevel` (fall back to the current working directory if not a git repo). Any location at or inside that path is disallowed.

Offer options like (adapt labels to the OS; use `~`-relative paths, resolve `~` at runtime):

- **Downloads folder** (`~/Downloads`) — easy to find later. *(Recommended.)*
- **A dedicated handoffs folder** (`~/handoffs/`, created if missing) — keeps them together over time.
- **Home folder** (`~`).
- *(The tool always adds an "Other" choice — the user can type any absolute path.)*

Rules for the chosen location:

- If the user's choice resolves to a path **at or inside the workspace root**, refuse it, say why in one line ("that's inside the current repo — a handoff shouldn't be committed with the project"), and re-ask.
- Create the target directory if it doesn't exist.
- **Filename:** `handoff-<repo-or-folder-name>-<YYYY-MM-DD-HHMM>.md` (use the timestamp from Step 1). If a file with that name already exists, append a short numeric suffix rather than overwriting.

## Step 3 — Write the handoff document

Write a single markdown file using the structure below. Keep it **skimmable and dense** — a fresh agent should be able to read it top-to-bottom in a couple of minutes and know what to do. Omit any section that genuinely has nothing to say (don't pad). Every reference to existing work is a **path or URL with a one-line gloss**, never a copy of its contents.

```markdown
# Handoff — <short title of the work>

- **Created:** <YYYY-MM-DD HH:MM>  (from Step 1)
- **Repo / workspace:** <repo name> — <workspace root path>
- **Branch:** <current branch>  ·  **Uncommitted changes:** <yes/no — see git status>
- **Next session's focus:** <the args, verbatim-ish — or "general continuation" if none given>

## TL;DR
<2–4 sentences: what this was about and exactly where it stands right now. If someone reads only this, they know the state.>

## Objective
<The goal of the work — what "done" looks like. If it's captured in a spec/issue/plan, one line here + link, not a restatement.>

## What's been done
<Bulleted, each item pointing at its artifact rather than describing it in full:>
- <e.g. "Implemented X — see `path/to/file` and commit `<sha>`.">
- <e.g. "Wrote the migration plan — see `docs/plan.md`.">
- <e.g. "Opened PR #<N> (<url>) — awaiting review.">

## Current state of the code
<Branch, working-tree state, what's in progress vs finished. Summarise `git status`/`git diff --stat` — don't paste the diff. Note anything half-done or knowingly broken.>

## Key decisions & rationale  ← the part that exists ONLY in this chat
<The reasoning the durable artifacts don't capture. For each: the decision, the why, and (if relevant) what it rules out.>
- **Decided:** <X>. **Why:** <Y>. <Link to ADR/issue if one exists, else this is the only record.>

## Dead-ends & things NOT to retry
<Approaches tried and abandoned, with the reason — so the next agent doesn't burn time repeating them.>
- <e.g. "Tried approach A — abandoned because <reason>. Don't revisit unless <condition> changes.">

## Open questions / blockers
<Unresolved items, decisions waiting on the user, external blockers. Mark which need a human.>
- [ ] <question / blocker> — <who/what it's waiting on>

## Next steps (in order)
<Concrete, ordered, actionable. The first thing the next agent should do, then the next.>
1. <step>
2. <step>

## Gotchas & environment notes
<Traps, quirks, required env/setup, commands that must be run a certain way, conventions from CLAUDE.md that matter here.>

## Pointers (artifacts index)
<A flat index of everything relevant, by path/URL — the "go read this" list.>
- Spec/plan/ADR: <path or url>
- Related issues/PRs: <#N — url>
- Key files: <path — one-line what-it-is>
- How to orient fast: <commands to run, e.g. `git log --oneline -10`, the test command, how to launch the app>
```

Tailor the emphasis to the arguments: if the next session is for a specific slice of work, make **Next steps** and **Pointers** revolve around that slice.

## Step 4 — Redaction pass (mandatory, before saving)

Before writing the file to disk, scan the drafted content and remove anything sensitive. The handoff will be read by another session and may be moved around or shared — it must not carry secrets or personal data.

Redact (replace with a labelled placeholder like `<redacted: API key>`):

- **Credentials & secrets** — API keys, tokens, passwords, connection strings, private keys, `.env` values, bearer tokens, session cookies.
- **PII** — personal names, emails, phone numbers, home addresses, government/ID numbers. (The user's own identity is fine to keep only where it's genuinely needed, e.g. a `gh` login for a command — otherwise generalise.)
- **Internal-only specifics that aren't needed** to continue the work — prefer the generic form where the detail adds nothing.

If a secret was *necessary* context (e.g. "the deploy failed because the token lacked scope X"), keep the *fact* and redact the *value*: "the deploy token lacked scope X — value redacted." Never write the raw value.

## Step 5 — Save & confirm

1. Write the file to the chosen path.
2. Print a short confirmation: the **full path**, the filename, and a one-line list of the sections included.
3. Tell the user how to use it in the next session, e.g. *"Start the new session and point the agent at `<path>` — it has everything needed to continue."*

## What this skill does NOT do

- **Does NOT save into the current workspace/repo** — always somewhere the user picks outside it.
- **Does NOT duplicate existing artifacts** — specs, plans, ADRs, issues, commits, and diffs are referenced by path/URL with a one-line summary, never re-pasted.
- **Does NOT commit, push, or open a PR** — it writes one local file and nothing else. No git state changes.
- **Does NOT volunteer** — it runs on `/handoff`, a request for a handoff, or a clear user cue that the work must continue in another session; never mid-task without one.
- **Does NOT write secrets or PII** — the redaction pass in Step 4 is mandatory.
- **Does NOT dump the raw transcript** — it *distils*; a wall of chat log is not a handoff.

## Failure modes

- **Nothing much happened this session** — say so and produce a minimal handoff (objective + current state + next steps). Don't invent content to fill sections.
- **Not a git repo** — skip the git-based inventory; use the current working directory as the workspace root to exclude, and gather state from the conversation and any files written.
- **User's chosen path is inside the workspace** — refuse, explain in one line, re-ask (Step 2).
- **Can't determine a timestamp** — ask the user for the date, or note it as approximate; don't fabricate a precise one.
- **A referenced artifact's path is uncertain** — link what you're confident of and flag the rest as "verify path" rather than guessing a wrong path.

## Cleanup checklist

- [ ] Exactly one markdown file written, to a user-chosen location **outside** the workspace.
- [ ] No git operations performed (no commit / push / branch / PR).
- [ ] Existing artifacts referenced by path/URL, not copied in.
- [ ] Redaction pass done — no keys, tokens, passwords, or PII in the file.
- [ ] Document tailored to the arguments (next-session focus) when they were given.
- [ ] Confirmation printed with the full saved path.
