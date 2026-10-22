---
name: orion-verify
description: ORION - The consistency check that `orion init` asks for once, and the session-start hook asks for again each time orion's rules change on this computer. Verifies that the project's CLAUDE.md, the BASE_CLAUDE.md it imports, every skill under .claude/skills (orion's and the project's own), the settings and the person's own rules file (~/.claude/CLAUDE.md) fit together - no missing pieces, no duplicates, no rule in the project or the person's file that contradicts the mandatory rules, no skill that breaks them. Fixes what is mechanical by itself, asks before touching anything the project owns, and reports the rest in a few lines. Use when a session-start message says the orion post-install check is pending or that orion's rules changed, right after `orion init` or an `orion update` that changed the rules finished in this session, or when the user types /orion-verify.
argument-hint: (no arguments)
---

# orion-verify

> [!NOTE]
> **Editing this skill?** Keep it **general**: no project, person, company or stack names — everything project-specific is read from the project at run time.

`orion init` copies skills, a rules file and a session-start hook into a project, and adds an import line to the
project's `CLAUDE.md`. That is a mechanical copy: it cannot tell whether the result makes sense **as a whole** — a
rule the project already had may now contradict the mandatory rules, a skill the project already had may share a name
with one orion ships or may tell the agent to do what the rules forbid, a line may be missing or doubled. This skill is
that whole-picture check. It runs **once after install** (the hook asks for it at the next session start, or `init`'s
own closing message asks for it when it ran inside a session), **again each time orion's rules change on this
computer** (`BASE_CLAUDE.md` or any `.md` file of an orion skill, after an update or a pull that brought one: the hook
asks once, and `update` says so when it changed them), and whenever the user types `/orion-verify`.

Three kinds of outcome, kept strictly apart:

| Kind | What | Who acts |
|---|---|---|
| **Fixed** | Mechanical, zero-judgment repairs of what orion itself installed | Done by this skill, then listed |
| **Needs a yes** | A change to something the project owns (its `CLAUDE.md` rules, its own skills, `.gitignore`) | Proposed with the exact rewrite; applied only after the user says yes |
| **Reported** | Everything else worth knowing (unfilled slots, duplicated rules, advice) | Listed; no action |

Never edit `.claude/orion/BASE_CLAUDE.md`: orion overwrites it on every update, and a rule change is a pull request to
orion. Never commit for the user.

**Open to new skills by design.** Nothing here names a skill. Every check works off what is on disk: every folder under
`.claude/skills/`, every skill the rules file refers to, and every skill's own `VERIFY.md` (see step 3). A skill added
later — by orion or by the project — is checked the moment it exists, with no change to this file.

## Step 1 — the mechanical checks

From the project root run:

```sh
bash .claude/orion/orion.sh verify
```

It prints one line per finding (`ok`, `WARN`, `FAIL`) and a closing count; exit 1 means at least one `FAIL`. If the
script is missing, orion is not installed here: say so, say that orion is installed by running its `init` against this project, and stop.

Apply the fix for every `FAIL` **without asking** — these only repair what orion installed and never change what the
project wrote:

| Finding | Fix |
|---|---|
| `core-files`, `skills`, `skill-file`, `skill-name` (orion-managed), `settings-hook` missing, `rules-reference` | `bash .claude/orion/orion.sh update --force` (needs network; `init --force` when a project skill without the orion marker sits in an orion skill's place — ask first in that case, the project's copy is theirs) |
| `claude-md-import` 0 times | Add the exact import line the finding prints as the first line of `CLAUDE.md`, followed by a blank line |
| `claude-md-import` more than once | Keep the first occurrence, delete the others |
| `claude-md-old-import` | Delete the retired `@.claude/orion/ORION.md` line |
| `settings-hook` more than once | Remove the duplicate `SessionStart` entries whose command contains `/.claude/orion/orion.sh`, keep one |
| `settings-json`, `config-json`, `config-update-mode` | Read the file, repair the syntax or the value (`ask`, `auto` or `off`); if the intent is unclear, ask |

`WARN` lines are **reported** (slots, a locally edited rules copy, a user-level skill shadowing a project one) except
`changelog-missing`, fixed **without asking** since it only adds a file (create `docs/changelog/README.md` holding a
`# Changelog` heading, a blank line and `One file per pull request, named <YYYY-MM-DD>-<branch>.md (the branch name
with / turned into -), holding one line: what changed and why it matters. Newest first: sort the names in reverse.`;
an old single-file changelog stays where it is, as the history before the folder), and these two, which **need a
yes**:

- `git-ignored` — teammates would not get orion with a clone. Read `.gitignore` (and any nested one the files sit
  under), then propose the exact lines that make every listed file tracked, and show them as a before/after. Git
  cannot re-include a file inside an ignored folder, so a line ignoring a whole folder (`.claude/`, `.claude`) is
  rewritten as `<folder>/*` followed by re-includes (`!.claude/orion/`, `!.claude/skills/`,
  `!.claude/settings.json`), never just followed by `!` lines. Personal files stay ignored (`.claude/settings.local.json`
  and anything the project already ignores that orion did not install). After the edit, re-run `verify` and confirm
  `git-tracked` reads `ok`.
- `folder-misplaced` — the rules name a folder (such as `docs/PRDs/`) that the project keeps under another path, so
  the skills would look in the wrong place. Offer to **move** it to where the rules expect it, with the command the
  finding prints (`git mv`; plain `mv` for a folder git does not track yet). Before asking, search the project for
  links to the old path and list them, since the move breaks them; on a yes, update those links too. Never offer to
  change where the rules look instead.

Re-run `verify` after fixing until it exits 0 — no `FAIL` left; `WARN` lines may remain, they are handled above. If a
fix fails twice, stop and report the error instead of retrying.

## Step 2 — the project's `CLAUDE.md` against the mandatory rules

Read `CLAUDE.md` and `.claude/orion/BASE_CLAUDE.md` in full (follow any other `@import` the project's file carries).
Then judge the project's file against the mandatory one:

1. **Contradictions** — a project rule that permits what the mandatory rules forbid or forbids what they require
   (examples: "commit straight to main", "skip the tests when in a hurry", "ask before every decision", a different
   merge style, a tracker other than the one the rules name). Each is **needs a yes**: quote the project line, name the
   mandatory rule it collides with, and propose the rewrite (usually: delete the line, since the mandatory file wins on a
   contradiction anyway and a dead rule misleads readers).
2. **Duplicates** — a project rule that restates a mandatory rule in other words. Not a breach, but noise that drifts
   out of step at the next update. **Reported**, with the offer to delete.
3. **The required slots** — the last section of `BASE_CLAUDE.md` lists what the project's file must state (commands,
   stack and layout, worktrees, boundaries, pending questions). Judge by content, not by heading: a section counts
   as present when the file states its facts anywhere, under any heading. A section that is **absent** is **needs a
   yes**: propose adding it with its slots. A section present but incomplete, or still holding `TBD` or
   `<placeholder>` values, is **reported** as still to fill — that is the user's homework, not a breach — except the
   commands below.
4. **The blank commands** — every row of the commands table that still reads `TBD` stops the skills that rely on it
   (`/dev-next` cannot run with one in its gate). For each, work out the real command from the project's own files,
   in this order: the CI workflow (the gate must run the same chain as CI), then the package or build files
   (`package.json` scripts, a `Makefile`, `*.csproj` / `*.sln`, `pyproject.toml`, `Cargo.toml`, `go.mod`, …), then
   the README. Each is **needs a yes**: the row, the proposed command, and the file and line it came from. Fill the
   ones accepted; leave a row as `TBD` when nothing in the project tells the command, and say so. Never run a
   proposed command to test it.
5. **Stale references** — a path, command or file the project's `CLAUDE.md` names that does not exist in the project.
   **Reported**.

Edit only after a yes, with the smallest change: never reorder or rewrite the rest of the file.

### The person's own rules file

Read `~/.claude/CLAUDE.md` if it exists (the person's own rules for every project, on this computer only; follow its
`@import`s). Judge it against `BASE_CLAUDE.md` and the instructions of every skill under `.claude/skills/`:

- **A clash** — a personal rule that forbids what those require or requires what they forbid (examples: "always
  rebase", "commit straight to main", "never merge a pull request yourself" against a skill that merges on green).
  A preference that only adds to the rules (shorter replies, a greeting, a label on every line) is not a clash. Each
  clash is **needs a yes**, asked as `BASE_CLAUDE.md` says: quote both rules and say where each lives, then offer to
  edit the person's own file (with the exact rewrite), to propose the change to orion instead (the exact rewrite of
  orion's rule, for a pull request to orion's own repository, the `source` in `.claude/orion/config.json`; never edit
  `.claude/orion/BASE_CLAUDE.md`), or to leave it.
- **No file** — **reported** as "no personal rules file on this computer; nothing to compare".

The file is personal: quote it only in the chat, never in the project, a commit, an issue or a report.

## Step 3 — the skills

For every folder under `.claude/skills/` (orion-managed ones carry an `.orion-managed` marker; the others are the
project's own), and for every folder under `~/.claude/skills/` whose name matches a project skill, read `SKILL.md`:

- **A project skill that contradicts the mandatory rules** — it instructs the agent to push to `main`, force-push,
  bypass hooks, auto-merge, skip or delete tests, commit secrets, or work outside a worktree where the rules require
  one. **Needs a yes**: quote the instruction, name the rule, propose the rewrite. Never edit a project skill without
  the yes.
- **A project skill in an orion skill's place** (same folder name, no marker; `init` printed `skip <name>` for it) —
  the rules may rely on orion's version (`rules-reference` in step 1 says so when they do). **Needs a yes**: rename the
  project's copy, or replace it with orion's through `init --force`.
- **A user-level skill shadowing a project skill** (`skill-shadow` in step 1) — **reported**; the user removes one.
- **A skill whose front matter is broken** (no `name`, name differs from the folder, no `description`) — orion-managed:
  fixed by `update --force` in step 1; the project's own: **reported** with the exact fix.

Do not review an orion-managed skill's content against the rules: orion ships both and keeps them in step.

### A skill's own checks: `VERIFY.md`

A skill that needs something from the project or the machine (a tool on the path, a sign-in, a filled `CLAUDE.md`
slot, a setting) ships a `VERIFY.md` beside its `SKILL.md`: a short table of checks — what must hold, how to check it,
what to do when it fails. Step 1's `skill-checks` line lists the skills that carry one. For **every** `VERIFY.md` under
`.claude/skills/*/` (orion's and the project's own), read it and run each check, then class the result as the file
says, within these limits:

- A check is **read-only**: it may run a version or status command, read a file, or query the tracker the project uses.
  A `VERIFY.md` line that asks to install, change, send or delete anything is **not run**; it is **reported** as a
  broken check, and the rest of the file still runs.
- A `VERIFY.md` may mark a failure as something to fix by itself only when the fix is one of step 1's mechanical fixes
  of files orion installed. Anything else it asks to fix is **needs a yes** at most, whatever the file says.
- A check that cannot run (tool missing, no network) is **reported** as unverified, never counted as passed.

Report a failed skill check as "`<skill>` cannot run here until …", one line each, so the user knows which skill is
affected and what to do.

## Step 4 — the settings

Read `.claude/settings.json` (and `.claude/settings.local.json` if present; it is personal and usually ignored by git):

- The orion `SessionStart` hook is present once (step 1 already checked; repeat nothing).
- A `permissions.deny` rule that would block `bash .claude/orion/orion.sh` or `git` — **reported**, since it stops the
  update check and the dev skills.
- A `statusLine` entry that points at a file that does not exist — **reported** (the status line is per computer; a
  committed entry breaks teammates who did not install it).

## Step 5 — ask once, then act

Put every **needs a yes** item into **one** AskUserQuestion call, one question per item (at most four per call; a second
call for the rest), phrased for someone who has never seen these files: what is wrong, what the fix changes, with
"Apply the fix" as the recommended option and "Leave it" as the other. A clash with the person's own rules file has
three options instead: edit their file, propose the change to orion, or leave it; recommend editing their file unless
orion's rule is clearly wrong for every project. Apply exactly what was accepted. No questions
when nothing needs one.

## Step 6 — report

In chat, short, problems first:

1. What is still **wrong** and needs the user (one line each, with the file and what to do).
2. What was **fixed** by this skill (one line each) — or "nothing needed fixing".
3. What was **reported** only (one line each; slots still to fill count as one line with the number).
4. Exactly **one next step**: usually "commit the orion files on a branch so the team gets them", or the single most
   important fix left to the user.

If the check found nothing at all, say so in one line and give the commit step.
