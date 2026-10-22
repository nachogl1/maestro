---
name: prd-to-tickets
description: 'ORION - Split a PRD (a product requirements document under docs/PRDs/) into GitHub epics and stories that agents can build in parallel. Scaffold first, then the shared-contract stories, then everything fans out; blockers only on real contract dependencies; every story owns one folder or module; both blocker forms set (GitHub''s native relation and the Blocked by body section); epic to story as native sub-issues; every story labelled agent-ready or needs-human, and outside-change + needs-human when it lands in a repository the team does not own; existing open issues become blockers, never duplicates. Its first message checks docs/ux/prototypes/ for the screens the PRD describes and, when there is none, offers to draft one from the PRD in parallel so front-end stories have a design to follow. Works with GitHub Issues only, like dev-next. Use when the user types /prd-to-tickets, says "split this PRD into tickets", "cut the PRD into stories", or "create the epics and stories for this PRD".'
argument-hint: "<path to the PRD> --developers N"
---

# /prd-to-tickets

> [!NOTE]
> **Editing this skill?** Keep everything here **general**: no project, person, company, product or stack names — the project's own `CLAUDE.md` and the PRD supply those at run time. It works with GitHub Issues only, like `dev-next`, whose `references/new-issue.md` defines the issue shape it files to. The brief for the prototype sub-agent lives in `references/ux-prototype.md`.

A PRD says **what** to build. Agents build **stories**. This skill is the step between: it reads one PRD and files
the epics and stories that let several developers (people or `/dev-next` runs) work on it **at the same time without
colliding**, and it does so with the person present, so that nothing is filed `agent-ready` with a question left.

**The output is tickets, nothing else.** This session never writes application code and never edits the PRD; the one
thing it may add to the repository is a UX prototype, drafted by a sub-agent on its own branch when the PRD describes
screens and no prototype exists yet (phase 1).

Read the project's `CLAUDE.md` first. It overrides this file where they disagree.

## Prerequisites

- `.claude/skills/dev-next/references/new-issue.md` is installed (orion ships it; `orion update` restores it). It is
  the issue shape, the labels and the native links every ticket here follows. Missing → stop and say so.
- GitHub Issues as the tracker, `gh` signed in to the repository `origin` points at. A `CLAUDE.md` naming another
  tracker → stop and say this skill needs GitHub Issues.
- A PRD under `docs/PRDs/`. No PRD → stop: by the standing rule a PRD is the person's to write or provide, and this
  skill never writes one. Point at `/wayfinder` when the person is still finding the way to a PRD.
- `.claude/skills/issue-map/` is optional: when installed, the map is rebuilt silently at the end.

## Arguments

| Form | Meaning |
|---|---|
| `/prd-to-tickets docs/PRDs/<name>.md` | Split this PRD. |
| `/prd-to-tickets` | One PRD under `docs/PRDs/` → take it; several → ask which one (clickable options, newest first). |
| `--developers N` | How many developers must stay busy in parallel once the scaffold is in. **The person states it explicitly, every run**: as this argument, or in answer to the question in phase 2 step 1 (after the UX check). It is never taken silently from the PRD or the project's `CLAUDE.md`; those numbers only shape the recommended option of that question. |

## Roles

| Role | Model | Effort | Job |
|---|---|---|---|
| this session | opus | the user's own | reads the PRD, interviews, cuts the plan, files the issues; talks to GitHub |
| `inventory-<slug>` | sonnet | low | optional: maps every open issue and the repository's layout onto the PRD's sections and returns a bounded table (phase 2) |
| `ux-prototype-<slug>` | opus | high | drafts the UX prototype from the PRD in its own worktree and opens its pull request (phase 1, `references/ux-prototype.md`) |
| `plan-check-<slug>` | opus | xhigh | fresh context: reads the cut plan against the rules in phase 3 and returns PASS or every violation (phase 5) |
| `prd-update-<slug>` | sonnet | low | only when the person says yes in phase 6 step 6: applies the agreed lines to the PRD in its own worktree and opens the `docs(prd)` pull request |

`<slug>` is the PRD's file name without `PRD` and `.md`, lower-case, hyphenated. Name every sub-agent after what it
does, keep the agent id each spawn returns, and ask each for a bounded result. A sub-agent works in its own worktree,
never stashes, never switches branches, commits only the files it touched, and on failure reports and stops.

---

## Phase 0 — Preflight

1. `gh auth status`, `gh repo view --json nameWithOwner,hasIssuesEnabled`. Issues disabled or a different tracker
   named in `CLAUDE.md` → stop and say so. `.claude/skills/dev-next/references/new-issue.md` exists → else stop.
2. Read the project's `CLAUDE.md` in full: the layout (application and test code paths), the worktree root, the
   boundaries (external read-only repositories and their work-item key format, sensitive data classes, boundaries an
   agent must not move), the working language, the standing decisions. A question the project has already answered
   is never asked in phase 4.
3. Labels: `gh label list --limit 200 --json name --jq '.[].name'`; create any of `epic`, `story`, `agent-ready`,
   `needs-human`, `in-progress`, `outside-change`, `bug` that is missing, with a one-line description. Never rename or
   delete one.
4. **Latest `main`, read only.** `git fetch origin main`, then read the code, the layout and `docs/ux/` on `main`
   through `origin/main` — `git show origin/main:<path>`, `git ls-tree -r --name-only origin/main -- <path>`,
   `git grep <pattern> origin/main` — never through the main checkout's files. That checkout may sit on another branch
   or hold someone's work: never switch its branch, never stash, never reset. This session creates no branch of its
   own; only its sub-agents do, each in its own worktree.
5. **Locate the PRD** (arguments above) and read it in full. Note every section number or heading, so each story can
   name the one it serves under `### References` and `### Goal`. Nothing is asked of the person in this phase: the
   first thing they hear is phase 1.

## Phase 1 — The UX check: the first thing the person hears

The standing rule: **front-end development is led by the UX prototype in `docs/ux/prototypes/`**. A story that adds
or changes a screen implements the prototype's screen, never a layout of its own. So before anything is cut:

1. **Does the PRD describe screens?** Pages, views, forms, dashboards, a user flow through a UI, anything a person
   sees and clicks. Read the PRD for it; do not guess from the stack. No screens at all → say so in one line and go to
   phase 2; nothing below applies.
2. **Is there a prototype for them?** Look under `docs/ux/prototypes/` (and `docs/ux/` for older projects) for a
   folder or file whose `README.md` or headings name the PRD's screens. Found → say which file leads, in one line;
   every front-end story in phase 3 names its screen in that file under `### References`.
3. **None found → tell the person, before any question about the split.** Say, in plain words:
   *"There is no UX prototype for the front-end to lead with. My suggestion is that I draft one now from the PRD,
   in parallel with the split, so that agents building a screen have a design to follow instead of inventing a
   layout each."* Then ask once (clickable options, the recommendation first):
   - **Draft it in parallel (recommended)** — spawn `ux-prototype-<slug>` with the brief in
     `references/ux-prototype.md`. It works in its own worktree on `feat/ux-prototype-<slug>` (or the
     project's own branch pattern), writes
     `docs/ux/prototypes/<slug>/` (one self-contained HTML click-through plus a `README.md` listing the screens), opens
     a pull request **a human merges**, and returns the pull request link and the screen list. The split carries on
     while it works.
   - **The person provides it** — nothing is spawned; the person says where it will live.
   - **The PRD has no screens after all** — say so and continue without the front-end rules.
4. **Whichever way, when the prototype does not exist on `main` yet, phase 3 cuts, and phase 6 files, one
   `needs-human` story: "UX prototype for <PRD name>"**, seam `docs/ux/prototypes/<slug>/`, under the epic that
   holds the most front-end stories (its own epic when none does), with the
   prototype pull request (or the person's promise) as its last comment, and **every front-end story is blocked by
   it**, in both blocker forms. It closes when the prototype is merged. That is what keeps a front-end agent from
   starting on a screen nobody has drawn.

The sub-agent's result arrives while later phases run. When it does, post its pull request link as the last comment
on the prototype story (filed in phase 6) and say in the close-out that the pull request waits for a human review.
A failure is reported in one line and the story stays `needs-human` with the person named to draw it.

## Phase 2 — Read the PRD and the backlog

1. **The developer count, stated explicitly by the person.** `--developers N` given → use it. Not given → ask once
   (clickable options; recommend the number the PRD's own team section or the project's `CLAUDE.md` states when there
   is one, else the number of people the person named) and wait for the answer. Never take the number from the PRD or
   `CLAUDE.md` without the person confirming it: that number is what phase 3's parallelism check is measured against,
   and a wrong one cuts the backlog for the wrong team.
2. **From the PRD, extract into a scratch note** (never into the repository): the vocabulary, the scope and the
   do-not-build list, the acceptance bar, the build decisions already taken, the tier the PRD gives each part (MVP,
   stretch, stretch 2, …), the repositories the work touches that this team does not own, the screens (phase 1),
   the data types or interfaces several parts share (the **contracts**), and every question the PRD leaves open.
3. **Inventory the backlog — mandatory, never skipped.**
   `gh issue list --state open --limit 200 --json number,title,labels,assignees,body`, and
   `gh issue list --state open --label epic --json number,title`. For every open issue, decide which PRD section (if
   any) it already covers. A large backlog or an unfamiliar repository may go to `inventory-<slug>` with a bounded
   brief ("one row per open issue: number, title, the PRD section it covers or `none`, its seam; then one row per
   top-level folder: what lives there — no essay").
   - **An open issue already covers a slice of the PRD → it is a blocker of the stories that need that slice, never
     a duplicate ticket.** It keeps its labels and assignee; this skill never edits it.
   - **An open epic already matches a PRD area → reuse it** as the parent; a new epic is created only when none fits.
   - **A closed issue** covered something once → it does not now; cut the story (never defer to a closed issue).
   - **Code on `main` already does it** → no story; say so in the plan under "already done".
4. **Check the layout against the PRD.** List the application and test paths on `origin/main` (`git ls-tree`, as in
   phase 0). A project with no code yet needs a
   **scaffold story** (the project skeleton, the build, the test runner, the gate commands filled into `CLAUDE.md`);
   a project that already builds and tests does not.

## Phase 3 — Cut the work

The shape of the cut is what makes parallel work possible. Every rule here is checked by `plan-check-<slug>` in
phase 5, so a cut that breaks one is sent back before the person sees it.

**Epics.** One epic per PRD area (a top-level section or a user-facing capability), labelled `epic`, body: the PRD
section it covers and one line per story it will hold. Reuse an existing open epic when one matches (phase 2).
Epic → story is a **native sub-issue**, never a text list.

**The chain stays shallow — scaffold → contract stories → fan-out:**

1. **Level 0 — the scaffold**, one story, when the project has no code yet. On day one, one developer works, by rule:
   there is nothing to parallelise before the skeleton builds and tests. A project that already builds skips this
   level, and level 1 is where work starts.
2. **Level 1 — the contract stories.** Every type, interface, schema, shared project file or configuration that more
   than one story would extend becomes **its own story**, blocked only by the scaffold. Their number is what the
   developer count can take side by side: aim for one contract story per developer, never fewer than two unless the
   PRD genuinely has one contract.
3. **Level 2 and below — the fan-out.** Every other story is blocked **only** by the contract story that defines
   what it consumes (the consumer of a type waits for its definer). A story blocked by a sibling that merely "comes
   first in the PRD" is a cut mistake: a blocker is a real dependency on a definition, nothing else. Depth above
   level 3 is a sign the cut is wrong; re-cut before going on.

**Every story:**

- **owns one seam** — one folder or module under `### Seam`, existing on `main` or created by the story (say which).
  Two stories on one folder, type or interface are merged into one, or one blocks the other, never left to collide.
  Two stories in one epic may share vocabulary, never files.
- **is one pull request** — buildable in one `/dev-next` session, with every acceptance criterion a checkbox that has
  a test an agent can run. A criterion an agent cannot meet alone (credentials it does not hold, a live service, a
  person's act) is **its own `needs-human` story** naming the person, never left inside an `agent-ready` one.
- **carries the full `new-issue.md` shape**: `### Epic`, `### Goal` (with the PRD section), `### Scope` (in, out,
  what it reuses, what it builds on that does not exist yet), `### Seam`, `### Acceptance criteria`,
  `### References` (the PRD sections; for a front-end story, the prototype file and the screen id), `### Blocked by`
  (`#<N> — <title>` lines or `(none)`), `### External reference` only for an `outside-change`,
  `### Evidence expected`, the process footer, and `## Decisions (agent-ready)` holding the interview's answers for
  that story (phase 4) so `/dev-next` asks nothing.
- **is labelled `story` plus exactly one readiness label:**
  - `agent-ready` — nothing left to ask: an agent claims it, builds in a worktree, opens the pull request, gets a
    fresh-agent review and merges on green with no human. Mandatory and mutually exclusive with `needs-human`.
  - `needs-human` — a person must act or decide first (answer a question, grant access, draw the prototype, name an
    evaluation set) and then flips it to `agent-ready`; or the ticket is human-only work for good (training, a written
    rule, a compliance record). The reason is the issue's **last comment**, posted right after creation.
  - `outside-change` — the work lands in a repository this team does not own (the project's `CLAUDE.md` lists them):
    never autonomous, always ends at a pull request that repository's own reviewer merges, **always also
    `needs-human`**, always carries `### External reference` with that repository's work-item key. `/dev-next` skips
    it; the plan says who drives it.
- **carries one tier label**, `tier:<name>` (`new-issue.md` step 2): the tier the PRD gives the work it covers
  (`tier:mvp`, `tier:stretch`, `tier:stretch-2`). A scaffold, contract or UX prototype story takes the first tier,
  in the PRD's order, of the stories that wait for it. Epics carry none. The tier never changes a blocker or a level.
- **front-end** (adds or changes a screen) → blocked by the prototype story (phase 1 step 4) until the prototype is
  on `main`, and references its screen.

**Blockers come in two forms, always both:** the `### Blocked by` body section (what agents parse) and GitHub's native
"blocked by" relation (what people see). Existing open issues from phase 2 appear here like any other blocker.

**The parallelism check — do it on paper before anything is filed.** Assign every story its level (0 when nothing
blocks it, else one more than its highest blocker; an existing open blocker counts at the level it would have). The
**contract level** is the lowest level that is not the scaffold: 1 when there is a scaffold, 0 when there is none.
Then walk the levels: from the contract level on, the number of stories that become unblocked at once must be
**at least the developer count** while later levels still hold work. A level that leaves developers idle is
re-cut: split a seam that is really two, promote a shared piece to a contract story, or drop a blocker that is not a
real dependency. Write the per-level counts into the plan; the person sees them.

**Size the whole.** A PRD that cuts into more than about thirty stories is split by epic into several runs of this
skill, the first run filing the scaffold, the contracts and the first epic's fan-out; say so rather than filing a
hundred tickets nobody can read.

## Phase 4 — The interview: every open question, nothing left to ask

A story filed `agent-ready` with a question left becomes a guess the dev agent bakes in and the reviewer cannot judge.

- **Ask every question the PRD leaves open**, grouped per story or per contract, through the clickable-options tool
  (`AskUserQuestion`): distinct options, your recommended answer **first and marked**, so a whole batch can be
  accepted in seconds. No cap on the number of questions. Plain language, as to a junior developer with no context.
- **Never ask what is already decided**: the PRD's build decisions, the project's `CLAUDE.md` (worktree root, merge
  method, data rules, language, deploy target), the standing decisions. The PRD wins on product; the rules win on
  process; a contradiction between them is reported as a bug, not resolved by a question.
- **Rounds.** After a batch, re-read the answers against the PRD and the cut: a question that only now arises goes
  into the next batch. Stop when a round produces no new question.
- **"I don't know, ask <someone>"** → that story is `needs-human`, with the open question and the person's name as
  its last comment. Nothing is guessed on anyone's behalf. The rest of the plan is unaffected.
- **A reversible decision the person could take now but did not** → recommend the simplest option that meets the
  acceptance bar, say it is reversible, record the answer under that story's `## Decisions (agent-ready)`.
- **Work the PRD gives no tier** → one question per epic: which tier its stories take (`mvp` recommended, the PRD's
  other tiers as the other options). The answer is a PRD fact, so it is one of the lines of phase 6's PRD question.

## Phase 5 — A fresh check, then one look

1. **Write the plan to a scratch file** (outside the repository): per epic, its stories in level order, each with
   title, seam, labels, blockers (by name), level, PRD section; the per-level counts against the developer count; the
   "already done" and "becomes a blocker" lists from phase 2; the prototype line from phase 1.
2. **Spawn `plan-check-<slug>`** with the plan, the PRD path and the rules of phase 3, asking for PASS or a numbered
   list of violations (one line each: the story, the rule, the fix). Fix every violation and run the check again;
   never show the person a plan that failed it.
3. **Show the whole plan to the person once** — the table, the counts, the open `needs-human` items with who acts —
   and ask for one of: file it as-is, change something (then show it again), or stop here (nothing is filed; the plan
   file stays so the answers are not lost). This is the last look before tickets exist; it is not a new interview round.

## Phase 6 — File, link, read back

File in dependency order, so every blocker exists before the issue it blocks:

1. **Epics first.** `gh issue create --title "<title>" --label epic --body-file <file>`. An existing open epic reused
   from phase 2 is not re-created.
2. **Stories level by level**, lowest level first. Every tier label the plan uses is created first when missing
   (`new-issue.md` step 2). Body to a UTF-8 file, `gh issue create --title "<title>" --label story --label
   <readiness> --label <tier> [--label outside-change] --body-file <file>` (PowerShell adds a byte-order mark; bash
   heredocs break on apostrophes — `.claude/skills/dev-next/references/shell-traps.md`). Names, not bare numbers,
   in titles and bodies. The `### Blocked by` lines are filled with the numbers minted in this run as they appear.
3. **Links, per `new-issue.md` steps 3 and 4, each read back:** the native sub-issue link to the epic
   (`.../issues/<epic>/sub_issues -X POST -F sub_issue_id=<child id>`, verified with `--jq 'map(.number)'`), then the
   native `blocked_by` relation for every `### Blocked by` line (`.../issues/<new>/dependencies/blocked_by -X POST -F
   issue_id=<blocker id>`, verified the same way). **A read-back that does not match the body is fixed before the next
   issue is filed**; the dev skill blocks on the union of the two, so a mismatch is a bug in the ticket.
4. **`needs-human` and `outside-change` stories get their reason as the last comment now**, including the prototype
   story's pull request link if it has arrived.
5. **Rebuild the issue map** when `.claude/skills/issue-map/` is installed: run its generator with no arguments in
   the background, as its own command, never chained. Its footer confirms the body sections and native relations agree.
6. **Ask once, after the batch:** "Should we update the PRD with this too?" — one line per change the interview made
   to the product (naming the PRD section), only when there is one. "No" ends it; "yes" → spawn `prd-update-<slug>`
   with the exact lines and sections: it works in its own worktree on `feat/prd-update-<slug>` (or the project's
   own branch pattern), adds its own changelog file, `docs/changelog/<YYYY-MM-DD>-<branch>.md` (one line; the folder
   created with a `README.md` explaining the format if missing), runs the gate (the gate commands the project's `CLAUDE.md` lists: build → lint → typecheck → full suite)
   and on green commits only the PRD and the changelog file, opens a `docs(prd)` pull request a human merges, and
   returns its link; red → it reports the failing command and stops. Never pushed to `main`.
7. **Close-out, ten lines or fewer:** epics and stories filed (counts per level against the developer count), which
   story `/dev-next` takes first (the scaffold, or the contract stories when there is no scaffold), every
   `needs-human` item with who acts and what, every `outside-change` with who drives it, the prototype pull request
   waiting for a human if any, and the one next action: `/dev-next` for the first unblocked story.

---

## Rules that are not negotiable

0. **Never push to `main`.** This session writes nothing to the repository; the prototype and a PRD update are each
   written by a sub-agent in its own worktree and land as a pull request a human merges.
1. **Nothing is filed `agent-ready` with a question left.** `agent-ready` and `needs-human` never sit together.
2. **`outside-change` never travels alone**: always `needs-human`, always `### External reference`, never built here.
3. **Both blocker forms, always, read back.** The body section for agents, the native relation for people.
4. **Epic → story is a native sub-issue**, never a text list. A story never hangs loose.
5. **Existing open issues are blockers, never duplicates.** The inventory of phase 2 is mandatory; a closed issue
   covers nothing.
6. **Blockers only on real contract dependencies**; every story names its own seam; the chain stays shallow; after
   the scaffold, the developer count stays busy at every level.
7. **No front-end story without a prototype to follow**: it is blocked by the prototype story until the prototype
   is on `main`.
8. **Nothing is filed without the person's one look**, and nothing is filed that failed the fresh plan check.
9. **This session never writes application code** and never edits the PRD by hand.
10. **Never schedule a wakeup or a `/loop`.** The prototype sub-agent's result arrives as a notification.

## References — load on demand, not up front

| File | Load at |
|---|---|
| `.claude/skills/dev-next/references/new-issue.md` | phase 3 (the shape) and phase 6 (the links and read-backs) |
| `references/ux-prototype.md` | phase 1 step 3 — the brief for `ux-prototype-<slug>` |
| `.claude/skills/dev-next/references/shell-traps.md` | phase 6, and whenever a shell command behaves strangely |
