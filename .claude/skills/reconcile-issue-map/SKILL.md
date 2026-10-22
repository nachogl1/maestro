---
name: reconcile-issue-map
description: 'ORION - Check that the GitHub issues (the issue map: epics, stories, blockers, labels, order) and the PRDs under docs/PRDs/ still describe the same product, and that both still match what is on main, then fix the drift with the person present. It finds a story nothing in the PRD asks for, a PRD section no story covers, a PRD changed after its stories were cut, a closed story the PRD never absorbed, a story with no epic, blockers that disagree between the body and GitHub''s native relation, two open stories on one folder, a label pair that cannot coexist, and an order that cannot be built. Every finding is explained as if the person had never heard of the project, with how much it matters; nothing is edited, filed, accepted or dropped without their word. Works with GitHub Issues only, like dev-next. Use when the user types /reconcile-issue-map, asks "are the issues still in line with the PRD", "is the backlog up to date", "does the issue map still match the product", or when a /dev-next run ended with `Drift found: run /reconcile-issue-map`.'
argument-hint: "(none) | <path to one PRD> | --since <yyyy-mm-dd>"
---

# /reconcile-issue-map

> [!NOTE]
> **Editing this skill?** Keep everything here **general**: no project, person, company, product or stack names — the project's own `CLAUDE.md` and its PRDs supply those at run time. It works with GitHub Issues only, like `dev-next`, whose `references/new-issue.md` defines the issue shape it checks against and files to.

The standing rule says there are **two sources of truth, kept in step**: the issues track the work, the PRD holds the
product, and a disagreement between them is a bug. People and repositories move on — a PRD section is rewritten after
its stories were cut, a story is filed from a conversation nobody wrote down, an epic is closed with children still
open, a folder is renamed under a story that names the old one. Nothing in the pipeline notices on its own. This skill
is the check: it reads both sources and the code on `main`, lists every way they have drifted apart, and puts the
drift right **with the person present**.

**A person runs this.** It is never started by another skill: `/dev-next` only probes for the cheapest signs of drift
at the end of its run and prints `Drift found: run /reconcile-issue-map`. Every decision below is the human's; this
skill gathers, checks, explains, recommends, and then does what was decided.

Read the project's `CLAUDE.md` first. It overrides this file where they disagree.

## Prerequisites

- `.claude/skills/dev-next/references/new-issue.md` is installed (orion ships it; `orion update` restores it). It is
  the issue shape every check here measures against. Missing → stop and say so.
- GitHub Issues as the tracker, `gh` signed in to the repository `origin` points at. A `CLAUDE.md` naming another
  tracker → stop and say this skill needs GitHub Issues.
- At least one PRD under `docs/PRDs/`. None → the product has no written truth to reconcile against: run only the
  map-health lens (below) and say so in the first line.
- `.claude/skills/issue-map/` is optional: when installed, its generator is run first and its footer is one of the
  inputs, and the map is rebuilt silently at the end.

## Arguments

| Form | Meaning |
|---|---|
| `/reconcile-issue-map` | Every PRD under `docs/PRDs/` against every issue, open and closed — the default. |
| `/reconcile-issue-map docs/PRDs/<name>.md` | One PRD and only the issues that reference it (or its epics). Faster on a large backlog. |
| `--since <yyyy-mm-dd>` | Ignore the bookmark (below) and treat every PRD change and every issue touched on or after that date as new. |

## Roles — spawn these as sub-agents, never do their work yourself

| Role | Model | Effort | Job |
|---|---|---|---|
| this session | opus | the user's own | reads the state and the PRDs, spawns the checks, judges, talks to the person and to GitHub |
| `map-health-<slug>` | sonnet | low | the mechanical lens: labels, parents, both blocker forms, seams, order. Returns one line per finding, no essay |
| `prd-trace-<slug>` | opus | high | the two PRD lenses: PRD → issues and issues → PRD. Returns a bounded table |
| `code-check-<slug>` | sonnet | low | the product lens: what `main` actually holds against what the PRD and the closed stories claim. Returns one line per finding |
| `reconcile-pr-<slug>` | sonnet | low | only in phase 3: applies the agreed PRD edits, the bookmark and the changelog file in its own worktree, runs the gate and opens the pull request |

`<slug>` is the repository name, lower-case, hyphenated (one PRD given → the PRD's file name without `PRD` and `.md`).
Name every sub-agent after what it does, keep the agent id each spawn returns, and ask each for a bounded result. A
sub-agent works in its own worktree when it writes, never stashes, never switches branches, commits only the files it
touched, and on failure reports and stops.

## The four lenses — what drift looks like

Every finding belongs to exactly one lens, and the person hears the lens name, in these words, before anything else:

| Lens, in the words you use | What is checked | Against what |
|---|---|---|
| **The PRD asks for something no story covers** | every scope item, acceptance line and build decision in each PRD has an epic or a story (open or closed) that names its section under `### References` or `### Goal`, or plainly implements it; every PRD section **changed since the bookmark** still matches the open stories that reference it (scope, acceptance criteria, vocabulary); nothing on the PRD's do-not-build list has an open story | the PRDs under `docs/PRDs/` (`git log` for what changed) |
| **A story the PRD does not ask for, or an outcome the PRD never absorbed** | every open story names a PRD section that exists and still says what the story says; every epic matches a PRD area; every story **closed since the bookmark** whose `## Decisions (agent-ready)`, pull request or last comments changed the product in a way the PRD does not record | the issues, open and closed, and their merged pull requests |
| **The issue map is broken** | an open non-epic issue with no native parent epic; an open epic with no open children, or a closed epic with open children; `### Blocked by` and the native relation disagree; a blocker that does not exist, points at an epic or closes a cycle; a story closed while a blocker of it is still open (built out of order); both `agent-ready` and `needs-human`, or a non-epic issue with neither readiness label (epics never carry one); `outside-change` without `needs-human` or without `### External reference`; two open stories on one `### Seam`; a `### Seam` folder absent from `main` that the story does not say it creates; a chain deeper than level 3 | `new-issue.md` and the issue-map footer |
| **The product does not match what the issues say** | a closed story whose seam, test or acceptance evidence is absent from `main` (the pull request was reverted, or never merged); an open story whose work `main` already holds (done under another name); a do-not-build item present in the code; a `TBD` row in the project's commands table that a closed scaffold story was meant to fill | the code and docs on `main` |

The issue map `issue-map` draws is a picture of the third lens; this skill reads the same facts and the footer the
map prints, and goes further.

## Who you are talking to — assume they know nothing

The person deciding has **no context**: not the project's vocabulary, not what any PRD section asks for, not what any
story built. Every finding is shown in this shape, in this order, one short sentence per line:

1. **Lens** — one of the four phrases above.
2. **What part of the product this is about** — one sentence on what that part *does and who it is for*, as if the
   person had never heard of it.
3. **What disagrees with what** — both sides in everyday words: what the PRD says, what the story says, what the
   code holds. Say what the thing *does*, never only what it is called.
4. **How it probably happened** — one sentence, from the evidence (the PRD section changed on <date> after the story
   was cut; the story was filed from a harvest; the folder was renamed by the story that …). Never a guess presented
   as a fact; say "probably" when it is one.
5. **How much it matters, and why** — **"fix before the next run"** (an agent will build the wrong thing or stall:
   an `agent-ready` story whose PRD section now says otherwise, a label pair that stops preflight, two open stories on
   one folder), **"fix some day"** (a reader would be misled, nothing breaks) or **"probably fine as it is"** (a
   harmless difference), then the reason in concrete terms.
6. **What I suggest, and what it would touch** — the recommendation and its size in plain words.

Words and habits: plain word first, internal word in brackets once ("the folder a story owns (its seam)"); names, not
bare numbers, for every issue and every PRD section ("the story that adds the review screen", "the PRD section on
exports"); no file names, labels or field names unless the person needs one to act; short sentences; options in the
same plain words ("Fix the story", "Update the PRD", "File a story", "It is fine as it is", "Not this time").

## Phase 0 — Gather

1. `gh auth status`, `gh repo view --json nameWithOwner,hasIssuesEnabled`. Issues disabled or another tracker named in
   `CLAUDE.md` → stop and say so. `.claude/skills/dev-next/references/new-issue.md` exists → else stop.
2. **Latest `main`, read only.** `git fetch origin main`, then read everything on `main` through `origin/main` —
   `git show origin/main:<path>`, `git ls-tree -r --name-only origin/main -- <path>`, `git grep <pattern>
   origin/main`, `git log`/`git diff` ranges ending at `origin/main` — never through the main checkout's files. That
   checkout may sit on another branch or hold someone's work: never switch its branch, never stash, never reset. Every
   sub-agent reads `main` the same way. This session creates no branch of its own; only `reconcile-pr-<slug>` does, in
   its own worktree.
3. Read the project's `CLAUDE.md` in full: layout, commands table, worktree root, boundaries, the PRD location if it
   names one, standing decisions.
4. Read `docs/reconcile-state.json` if it exists:
   ```json
   {
     "reconciled_at": "<commit on main the PRDs and issues were read at>",
     "last_reconcile": "<yyyy-mm-dd>",
     "accepted": [ { "lens": "<1-4>", "issue": "<N or none>", "section": "<PRD file and heading, or none>", "reason": "<the person's words>", "on": "<yyyy-mm-dd>" } ]
   }
   ```
   No file → nothing has been reconciled yet; every PRD section counts as changed and every closed story as new.
   `accepted` holds findings the person said are fine on purpose: they are checked again, but shown only when the
   facts behind them changed (a new PRD edit on that section, a new comment on that issue).
5. **The PRDs.** Every `docs/PRDs/*.md` on `origin/main` (or the one given), in full; `git log --name-only
   <reconciled_at>..origin/main -- docs/PRDs/` for what changed since the bookmark and `git diff
   <reconciled_at>..origin/main -- <file>` per changed file.
6. **The issues.** `gh issue list --state all --limit 500 --json number,title,state,labels,assignees,body,closedAt,
   updatedAt` (page past 500 with `--search` on `created:` ranges when the list is cut), the open epics'
   sub-issue lists (`gh api repos/{owner}/{repo}/issues/<epic>/sub_issues --jq 'map(.number)'`), and for every open
   non-epic issue its native blockers (`.../issues/<N>/dependencies/blocked_by --jq 'map(.number)'`). Write all of it
   to one scratch file outside the repository; the sub-agents read that file, never the API again. **Issues carrying
   any `wayfinder:*` label are left out of that file and skipped by every lens**: they are `/wayfinder`'s planning map
   and decision tickets, not stories, so they carry no readiness label, epic or seam on purpose.
7. **The issue map**, when installed: run `python .claude/skills/issue-map/scripts/issue_map.py` in the background, as
   its own command, never chained; when it finishes, copy its footer sentence (agree / DISAGREE on …; dropped links)
   into the scratch file.
8. **The in-flight file** `/dev-next` keeps (`.claude/skills/dev-next/references/in-flight.md` names it): the issues
   being worked on right now. They are read, never edited in phase 3.

## Phase 1 — Check, then judge

1. **Spawn the three check agents at once**, each with the scratch file, the bookmark date, the `accepted` list and a
   bounded brief:
   - `map-health-<slug>`: "one line per finding of the *issue map is broken* lens, in the order of the lens table:
     issue number and title, what is wrong, the evidence (the two lists that disagree, the missing folder, the label
     pair). Check every open issue; closed ones only for *closed while a blocker is open* and *closed epic with open
     children*. No essay."
   - `prd-trace-<slug>`: "two tables. (a) One row per PRD scope item, acceptance line and build decision: the section,
     the issue(s) that cover it or `none`, and `changed since bookmark` plus one line on whether the covering open
     stories still match the section as it reads now. (b) One row per open story and per story closed since the
     bookmark: the PRD section it names, whether that section exists and still says what the story says, and for a
     closed story whether its decisions and pull request changed the product in a way the PRD does not record. Quote
     the PRD line and the issue line that disagree. No essay."
   - `code-check-<slug>`: "for every story closed since the bookmark: does its seam exist on `main`, does a test cover
     its acceptance criteria (name the test file), was its pull request merged (`gh pr list --state merged --search
     '<N>'`)? For every open story: does `main` already hold what it asks for? For every do-not-build item in the
     PRDs: is it in the code (`git grep`)? For the commands table in `CLAUDE.md`: any `TBD` row a closed scaffold
     story should have filled? One line per finding, nothing per non-finding."
2. **Judge every line yourself** before showing anything: open the PRD section and the issue the line names and
   confirm it. A finding a sub-agent got wrong is dropped, not shown. A finding in `accepted` whose facts have not
   changed is counted as accepted and not shown.
3. **Rate it** — fix before the next run / fix some day / probably fine as it is — with one line of concrete
   reasoning: which open story an agent would build wrongly, what a reader would misread, what breaks.
4. **Group.** Findings about one PRD section, one epic or one folder become **one group**. A PRD section changed since
   the bookmark and the stories it affects are always one group. A group's rating is its highest finding's.
5. **Measure what fixing each group would touch**, counted, not guessed: the issues edited (and whether any is
   assigned, in flight, or `needs-human` — those are not edited here, phase 3), the PRD sections edited, the stories to
   file, and the labels or links to set.
6. **Recommend one destination per group:**
   - **Fix the issues** — edit bodies, labels, native links, seams, order (the `### Blocked by` section and the native
     relation set to agree; a story re-pointed at the PRD section that exists; a label pair corrected). The usual
     answer for the third lens.
   - **Update the PRD** — the PRD is behind the issues or the code: a closed story's outcome, a decision made in an
     interview, a renamed thing. Goes in this run's `docs(prd)` pull request.
   - **File a story** — the PRD asks for something no story covers, written to `new-issue.md` (names the PRD section
     under `### References`; the tier the PRD gives that section; `needs-human` unless nothing is left to ask), native
     sub-issue of the matching epic, both blocker forms. Several uncovered items in one PRD area are **one** story
     when one developer would build them in one session, else one each.
   - **Close a story** — `main` already holds the work, or the PRD dropped the need: closed with a comment saying
     why, never deleted.
   - **It is fine as it is** — recorded in `accepted` with the person's reason, so it is not shown again until the
     facts change. The recommendation for every finding rated "probably fine as it is".
   - **Not this time** — nothing written; the finding returns next run.
   The PRD wins on product, the issues track the work: when a PRD section and an open story disagree on **what** to
   build, the recommendation is to fix the story unless the person says the PRD is the stale one; when they disagree
   on **whether it is done**, the code on `main` decides.
7. **Write the explanation** for every group and finding in the shape of *Who you are talking to*.

## Phase 2 — Present and decide in waves (the touchpoint)

Nothing is edited, filed, closed, accepted or dropped automatically: the human decides every group.

1. Open with this, in these words or simpler, every run:
   - **What this does.** The project has two written truths: the PRD, which says what the product is, and the GitHub
     issues, which say what work is planned and done. Over time they drift apart, and an agent building from a stale
     story builds the wrong thing. Today we go through every place they disagree, and decide for each: fix the
     issues, update the PRD, file a story, close a story, or say it is fine as it is.
   - **What I already took off the list.** One line per finding the person accepted on an earlier run whose facts
     have not changed, and per sub-agent finding that did not hold up; then the counts: PRDs read, issues read,
     findings confirmed, by lens.
   - **The goal.** As few edits as possible, nothing written without your word, and the PRD and the issues saying the
     same thing when we are done.
2. Print the overview: every group as one line — lens, a plain title, how much it matters, the recommended
   destination, what it would touch — sorted into the three waves below.
3. Work the waves in order. Each wave: print its groups and findings in the six lines of *Who you are talking to*,
   then ask with clickable options (`AskUserQuestion`, up to four groups per call, one question per group, the
   recommendation first and marked "(Recommended)", every label in plain words; the tool takes four options, so
   anything else goes under "Other"). Say in one sentence what each wave is for before it starts.
   - **Wave 1 — fix before the next run.** Options: fix the issues (or update the PRD, whichever is recommended),
     the other of the two, file a story, not this time.
   - **Wave 2 — probably fine as it is.** Options: it is fine as it is, fix the issues, update the PRD, not this time.
   - **Wave 3 — fix some day.** Options: fix the issues, update the PRD, file a story (or close a story), not this
     time. Then one more question: how many stories to file in all, with the recommended merge of groups in one PRD
     area.
4. **Expect questions.** A question gets a short plain answer backed by the PRD line or the issue — then the wave
   carries on where it stopped. A decision changed mid-wave replaces the earlier one.
5. Record every decision before acting on any.

## Phase 3 — Act

Issue edits go straight to GitHub (they are the tracker's own state, like a claim or a label); file changes go through
**one** pull request on `feat/reconcile-<yyyymmdd>` (or the project's own branch pattern) in a worktree under the
project's worktree root, opened by `reconcile-pr-<slug>`. A human merges it; this skill has no merge autonomy.

1. **Fix the issues** → `gh issue edit` for bodies and labels (body to a UTF-8 file, `--body-file`; PowerShell adds a
   byte-order mark — `.claude/skills/dev-next/references/shell-traps.md`), the native sub-issue and `blocked_by`
   calls of `new-issue.md` steps 3 and 4 for links, **each read back**. Rules that are never broken here:
   - **Never edit an issue that is assigned to someone else, or in the in-flight file.** The assignee owns it. Such a
     fix is posted as a comment headed `Reconcile of <date>:` saying what is out of step — unless the issue is
     `needs-human`, whose reason must stay the last comment: there a line goes into the body's `### Scope` when nobody
     is assigned, and otherwise the finding is carried as "not this time".
   - **Never flip `needs-human` to `agent-ready`.** Only a person who has answered the open question does that; this
     skill may set `needs-human` (with the reason as the last comment), never remove it.
   - Removing a readiness label that should not be there (`agent-ready` beside `needs-human`) keeps `needs-human`.
2. **Update the PRD** → the exact lines and sections the person agreed, applied by `reconcile-pr-<slug>` in the
   worktree, never by this session and never on `main`. One pull request for the whole run.
3. **File a story** → exactly as `new-issue.md` says: every heading, `story` plus one readiness label and the tier
   the PRD gives that section (created first when missing, `new-issue.md` step 2), native sub-issue of its epic (the
   person picks when none fits), both blocker forms read back, the PRD section under
   `### References` and `### Goal`, `### References` also naming this reconcile run (`reconcile of <date>`).
4. **Close a story** → `gh issue close <N> --comment "<why, in plain words, and what covers it on main or which PRD
   change dropped it>"`. Never an assigned or in-flight issue.
5. **Write `docs/reconcile-state.json`** (in the worktree, part of the pull request): `reconciled_at` = the
   `origin/main` commit read in phase 0; `last_reconcile` = today; `accepted` = every finding the person said is fine
   as it is, this run and earlier, minus those whose facts changed and were decided again. Only this skill writes the
   file.
6. Add the run's own changelog file, `docs/changelog/<YYYY-MM-DD>-<branch>.md` (one line; every pull request carries one; create
   the folder with a `README.md` explaining the format if it does not exist). **Run the gate** (the gate commands the project's `CLAUDE.md` lists:
   build → lint → typecheck → full suite) in the worktree before the pull request opens; it opens only on green. Red →
   `reconcile-pr-<slug>` reports the failing command and stops, and this session names it first in the close-out for
   a person to fix (the pull request holds only PRD text, the bookmark and a changelog file, so red almost always
   means `main` itself is red). Then commit with Conventional Commits (`docs(prd): reconcile …` when the PRD changed,
   else `chore(reconcile): …`), **never `git add -A`**, push, open the pull request with the table below, and tell the
   person it waits for their merge. No file change at all (only issue edits) → still write the bookmark and open the
   pull request; it is what tells `/dev-next` the drift was looked at.
7. **Rebuild the issue map** when installed: the generator with no arguments, in the background, as its own command.

```
| Group | Lens and findings | How much it matters | What it would touch | Decision | Where it went |
|---|---|---|---|---|---|
```

8. **Close-out, ten lines or fewer:** findings confirmed by lens, decisions by destination, issues edited (by name),
   stories filed and closed (by name), the pull request waiting for a human, anything carried to next time, and the one
   next action: merge the pull request, or `/dev-next` when nothing waits.

---

## Rules that are not negotiable

0. **Never push to `main`.** The PRD edit and the bookmark land as a pull request a human merges.
1. **Never start from `/dev-next`.** It probes and prints one line; a person reconciles.
2. **Nothing edited, filed, closed, accepted or dropped without the person's word.** Every destination is an answer
   given in a wave.
3. **The PRD wins on what to build; `main` wins on what is done.** A story that contradicts its PRD section is fixed,
   not the PRD, unless the person says the PRD is the stale one — then the PRD edit is the decision, recorded.
4. **Never edit someone else's issue, an in-flight issue, or the last comment of a `needs-human` issue.** A comment
   or a `### Scope` line instead, or carry it.
5. **Never flip `needs-human` to `agent-ready`.**
6. **Both blocker forms, read back**, every time a link is set, exactly as `new-issue.md` says.
7. **Lens and importance with every finding.** The first words say which lens; one line says how much it matters and
   why. A finding without both is not ready to ask.
8. **Fewer edits.** Findings about one section, epic or folder are one group and, when filed, one story.
9. **Nothing already decided is asked again.** `accepted` is honoured until the facts behind an entry change.
10. **No production, customer or personal data.** A PRD or an issue carrying any is reported as a blocking finding and
    copied nowhere.
11. **Never schedule a wakeup or a `/loop`.** A finished sub-agent re-invokes this session on its own.

## References — load on demand, not up front

| File | Load at |
|---|---|
| `.claude/skills/dev-next/references/new-issue.md` | phase 1 (the shape every check measures against) and phase 3 (edits, links, read-backs) |
| `.claude/skills/dev-next/references/in-flight.md` | phase 0 step 8 (where the in-flight file is and what its entries mean) |
| `.claude/skills/dev-next/references/shell-traps.md` | phase 3, and whenever a shell command behaves strangely |
