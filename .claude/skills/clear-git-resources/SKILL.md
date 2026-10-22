---
name: clear-git-resources
description: ORION - Sweep the stale git resources a project collects — worktrees whose branch already landed, local and remote branches already on main or whose pull request is merged or closed, dead folders and loose files in the worktree root. Deletes the user's own stale items whose work cannot be lost without asking, asks before deleting anyone else's stale items (or the user's own with a closed pull request or a deleted remote branch), and never touches unmerged work, uncommitted changes, main, the audit/* and qa/* branches, the audit-* and qa-* worktrees, an open pull request or anything in flight. Use when the user types /clear-git-resources, says "clean up my branches / worktrees / the worktree folder", or when the session-start hook reports that the project has reached its branch or worktree limit (20 each by default; `branchLimit` / `worktreeLimit` in .claude/orion/config.json).
argument-hint: "(none) | --dry-run"
---

# /clear-git-resources

> [!NOTE]
> **Editing this skill?** Keep everything here **general**: no project, person, company or stack names. The scanner is `scripts/scan.sh` (portable bash, read-only); a change to what is found or how it is classified is a pull request on that file. The branch and worktree counts it prints are the same ones the session-start hook (`orion.sh check`) uses, so keep the expressions identical.

Every skill that builds something leaves git resources behind: a worktree, a local branch, a remote branch, sometimes a
folder or a log file in the worktree root. `/dev-next` deletes its own when a story merges, but nothing cleans up after a
failed run, a human-merged pull request (`/harvest`, `/reconcile-issue-map`, `/prd-to-tickets`, `/wayfinder`), or a
person's own experiments. This skill is the sweep: it **deletes the person's own stale items whose work cannot be
lost**, **asks** about the other stale ones, and **never touches** anything that still holds work or that another
skill uses.

Read the project's `CLAUDE.md` first. It overrides this file where they disagree (the worktree root, the branch pattern,
the default branch).

## Who you are talking to

A developer who wants a tidy machine but has no time to inspect each branch. Everyday words: "a branch whose work is
already on main", not "an ancestor of origin/main"; "a folder git has forgotten about", not "a prunable worktree
entry". Name the thing (its branch name or folder) because they need it to decide, and say in one line why it is on the
list and whose it is. Never ask twice about the same thing; never leave out anything that is kept without saying it is
kept.

## Whose it is, and what happens to it

Every `ITEM` line carries an action: `auto`, `ask` or `keep`. The scanner decides it; the skill never changes it.

**Whose it is.** An item is the person's own when the first commit on its branch that is not on the default branch
(for a branch merged with a merge commit, its tip) carries the email of their git identity (`git config user.email`,
read through `git var GIT_AUTHOR_IDENT`). A branch with no commits of its own (a fresh start, or fast-forwarded) is
nobody's, so it is asked about. A worktree on no branch lives on this computer only, so it is the person's own. No
identity set → nothing counts as theirs, every stale item is `ask`, and a `NOTE` line says so.

| Action | Groups | What it means |
|---|---|---|
| **`auto`** — deleted without asking | `wt-prunable` `wt-done` `wt-detached` `br-merged` `br-pr-closed` `rb-merged` `rb-pr-closed` `root-file` | Stale, the person's own, and nothing can be lost: every commit is on the default branch, its pull request merged at exactly the branch's current commit, a clean checkout on no branch whose commit a branch holds, a worktree entry whose folder is gone (removed on its own, never with a global prune), or a loose file in the worktree root unchanged for `--days` days (default 2). A locked worktree is never `auto` |
| **`ask`** — deleted only on the person's yes | `wt-done` `wt-detached` `wt-pr-closed` `br-merged` `br-pr-closed` `br-gone` `rb-merged` `rb-pr-closed` `root-orphan` | Stale but someone else's or nobody's; or the person's own with a pull request closed without merge, a branch that changed after its pull request merged, a remote branch that was deleted (it may still hold commits that were never pushed), or a lock; or a folder in the worktree root that is not a worktree and has nothing changed for `--days` days (its repository may only have moved) |
| **`keep`** — never offered, no command | `wt-active` `wt-dirty` `br-unmerged` `rb-unmerged` `wt-open-pr` `br-open-pr` `rb-open-pr` `wt-protected` `br-protected` `rb-protected` `root-recent` `root-other` | Commits not on the default branch with no pull request, commits on no branch that no branch holds, uncommitted changes, an open pull request, the default branch, the branch checked out in the main checkout, anything of an issue in `<wt root>/in-flight.json`, worktree-root entries with anything changed in the last `--days` days, other repositories' checkouts, and the resources other skills use (below) |

A group can hold `auto` and `ask` items side by side (`br-merged` holds the person's own and someone else's branches
already on main); the action on each line decides, never the group.

**Resources other skills use are never touched.** `/dev-next` keeps every run's reports on `audit/<login>`, an orphan
branch pushed without a pull request, checked out in `<wt root>/audit-<login>` while a run writes to it; `/harvest-qa`
drives its checks in a detached worktree named `qa-<yyyymmdd-hhmmss>`. The scanner never lists an `audit/*` or `qa/*`
branch (local or remote) and lists every `audit-*` and `qa-*` worktree or folder as `keep`, with no command, whatever
its state. If one of them is truly dead, the person removes it by hand.

A **squash-merged** branch is not an ancestor of the default branch, so it is recognised through its pull request
(`gh`): `auto` only when the branch still points at the commit the pull request merged. Without `gh`, the scanner says so
in a `NOTE` line and such a branch is recognised only through its deleted remote branch (`[gone]`), which is `ask` —
it is never deleted on a guess.

## Steps

### 0 · Preflight

1. `git` on the path, and the current folder inside a git repository. Missing → stop and say what is missing.
2. Read the project's `CLAUDE.md`: the **worktree root** (the folder its worktree rules name; default `C:\wt` on
   Windows, `~/wt` elsewhere) and the branch pattern. Read the limits from `.claude/orion/config.json`
   (`branchLimit` and `worktreeLimit`, default 20 each) if that file exists.
3. `gh auth status` — optional. Missing or signed out → carry on; the scan will say that pull request states are unknown.
4. **Never work in the main checkout's files.** The skill runs `git -C <main checkout>` for ref operations only: it
   never checks out, switches, stashes, rebases, resets, force-pushes or edits a file. Deleting is the only write.

### 1 · Scan

```
bash .claude/skills/clear-git-resources/scripts/scan.sh --fetch --wt-root "<wt root>" --limit <branchLimit> --wt-limit <worktreeLimit>
```

`--fetch` runs `git fetch --prune origin` first so remote branches deleted elsewhere drop out before anything is shown;
the `SCAN` line reports how many were pruned. With `--dry-run` as the skill's argument, run the scan without `--fetch`
and stop after step 2: nothing is deleted. The output is one record per line, tab-separated (`SCAN`, `COUNT`, `GROUP`,
`ITEM`, `NOTE`, `SUMMARY`; the header of `scan.sh` documents each). The `COUNT` line carries the hook's counts: local
plus remote-tracking branches (`HEAD` excluded) and worktrees (the main checkout excluded).

### 2 · Show the list

One message, in this order:

1. **Deleting now** — every `auto` item, grouped as the scanner groups them: the name and why it is here, reworded into
   plain language where the record is terse.
2. **Asking you about** — every `ask` item, grouped the same way, each line saying whose it is and what deleting it
   could lose.
3. **Kept** — one line per kept group (count only, no items).

Then the `NOTE` lines in plain words (pull request states unknown; no git identity; issues in flight; remote refs
pruned by the fetch). End with the `COUNT` line as one sentence: how many branches and worktrees the project has and
whether either is at or over its limit.

Nothing `auto` and nothing `ask` → say so in one line, with the counts, and stop.

### 3 · Delete the `auto` items

Starting the skill is the go for these: no question. Run each one's command as described in step 5, in the order step 5
gives. `--dry-run` skips this step.

### 4 · Ask about the `ask` items

Use the AskUserQuestion tool. **One question per group** that has `ask` items, each with the options *Delete all <n>*,
*Pick which to keep* and *Keep all* (marked recommended). *Pick which to keep* → the person types the names to keep in
the free-text answer; every other `ask` item in that group is deleted. Up to four questions per call; more groups → more
calls. Never fold two groups into one question, and never ask about a `keep` item.

A question gets a short plain answer — open the branch's log or the folder to back it — and the asking carries on where
it stopped. A decision changed before the deleting starts replaces the earlier one.

### 5 · Delete what was agreed

Run **exactly the command the `ITEM` record carries**, nothing else, in this order: worktrees (`wt-*`), then local
branches (`br-*`), then remote branches (`rb-*`), then the worktree root (`root-*`). Worktrees first because a branch
checked out in a worktree cannot be deleted before the worktree is gone; the `wt-*` commands already chain the
`branch -D` for that reason.

- A `worktree remove` that is refused with "contains modified or untracked files": run
  `git -C <worktree> status --porcelain`. **Empty** → the only files are gitignored (a local environment, build
  output); `worktree remove --force` is expected and fine. **Not empty** → the scanner's picture was stale; report the
  worktree as kept and move on. Never force a worktree with real changes.
- "not a working tree", "branch not found", "remote ref does not exist" → already gone; count it as done.
- Any other error → report it with the exact message, skip the item, carry on. Two items failing with the same error →
  stop deleting, report, and let the person decide; do not retry the same command.
- A `push --delete` is **the only command that touches the remote**; it is run only for `rb-*` items that are `auto` or
  that the person agreed to.

### 6 · Report

Run the scan again (no `--fetch`) and say, in one message: what was deleted without asking and what on the person's
word (count per kind: worktrees, local branches, remote branches, folders, files), what was refused and why, what was
kept, and the new branch and worktree counts against their limits. Still at or over a limit → one line saying the
session-start hook will offer the sweep again tomorrow unless `branchLimit` / `worktreeLimit` in
`.claude/orion/config.json` is raised or set to `off`.

## Rules

- **Only `auto` items are deleted without a yes.** Every `ask` item needs the person's yes; no default yes, no "I
  assumed you would want", no batch larger than what was agreed. `--dry-run` deletes nothing at all.
- **A `keep` item never gets a command.** The scanner prints none for it; do not write one. That covers the default
  branch, `audit/*` and `qa/*` branches, `audit-*` and `qa-*` worktrees, open pull requests, anything in
  `in-flight.json`, the branch the main checkout is on, unmerged work and uncommitted changes.
- **Never change an item's action.** Not to `auto` because it "looks safe", not to `keep` on a hunch: a wrong action is a
  pull request on `scripts/scan.sh`.
- **Never force-push, never stash, never switch branches, never reset, never rebase, never `--force` a worktree with
  real uncommitted changes.**
- **Other repositories' checkouts in the shared worktree root are not yours.** They are listed as kept and left alone,
  whatever their age.
- **Say what was kept.** Every item the scanner saw is either deleted, refused with its error, or listed as kept with
  the reason. Nothing disappears from the report.
- **No clever commands.** The command in the `ITEM` record, verbatim; one item at a time; output read before the next.

## The session-start hook

`orion.sh check` (the one `SessionStart` hook orion installs) counts the project's branches — local plus
remote-tracking, `HEAD` excluded — and worktrees — the main checkout excluded — once a day, with no network. When either
count is at or above its limit (`branchLimit` / `worktreeLimit`, default 20 each; a number or `off` in
`.claude/orion/config.json`) it asks Claude Code to offer this skill before anything else. Saying "Not now" ends it for
the session; the next day asks again while a count stays at or above its limit. The hook only counts when this skill is
installed in the project; uninstalling the skill silences it.
