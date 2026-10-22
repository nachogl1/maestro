---
name: dev-next
description: ORION - Pick up the next GitHub issue nobody owns and ship it end to end — claim, develop in a worktree, review with a fresh agent, merge on green CI, close, audit. Works with GitHub Issues only (it drives the gh tool and GitHub's sub-issue and blocked-by links). Use when the user types /dev-next, asks what to work on next, or says to take the next issue, take issue #N, or resume a crashed run.
---

# /dev-next

> [!NOTE]
> **Editing this skill?** Keep everything here **general**: no project, person, company or stack names — the project's own `CLAUDE.md` supplies those at run time.

One command. **Two touchpoints with the human**: one batch of questions at the start, and a ten-line summary at the end.
Everything between is autonomous. The run **never waits for a person** — anything it cannot resolve is labelled `needs-human`
(`gh issue edit N --add-label needs-human --remove-label agent-ready` — the two readiness labels never sit together),
explained in a comment, released, and the run carries on.

**Releasing an issue always means all four:** the reason as the issue's last comment, `gh issue edit N
--remove-label in-progress --remove-assignee @me`, its entry dropped from the in-flight file, and the `merging` slot
freed if it held it. An assignee left behind keeps the issue out of every later run (`references/eligibility.md`),
even after a person re-marks it `agent-ready`; a leftover `in-progress` label tells the team someone is on it when
nobody is. Remove both. Every give-up path below releases
this way; only the branch and worktree may stay behind for a human.

Read the project's `CLAUDE.md` first. It is not optional and it overrides this file where they disagree.

**Project files are read from `origin/main`, never from the main checkout's working files** — the main checkout may
be on another branch (phase 0 step 6). After `git fetch origin main`, read `CLAUDE.md`, the runtime pin files, the CI
workflow, `docs/harvest-state.json`, `docs/harvest-qa-state.json`, `docs/reconcile-state.json` and the PRDs with
`git show origin/main:<path>` (`git ls-tree -r --name-only origin/main <folder>` to list a folder); a path missing
there counts as missing.

## What this skill reads from the project

Everything project-specific comes from the target repository's own `CLAUDE.md` (and, where it is silent, from the
repository's files). This skill expects that file to state the items below; the default applies when it says nothing.

| Item | Default when `CLAUDE.md` is silent |
|---|---|
| **Tracker** | GitHub Issues in the repository `origin` points at — the only tracker this skill supports. A `CLAUDE.md` that names another tracker → stop in preflight (phase 0 step 1) and say so. |
| **Labels** | `epic`, `story`, `agent-ready`, `needs-human`, `in-progress`, `outside-change`, `bug`, plus the `wayfinder:*` set the planning skill owns (`wayfinder:map`, `wayfinder:research`, …). Missing ones of the seven are created in preflight (phase 0 step 7); `wayfinder:*` labels are never created here. An issue carrying any `wayfinder:*` label is a planning ticket: never eligible, never asked about, never counted as drift. Every story also carries one `tier:*` label (`references/new-issue.md` step 2): it is for readers only, and never makes an issue more or less eligible or changes the order issues are taken in. |
| **The gate chain** — build → lint → typecheck → full suite, with the exact commands | Derived from the CI workflow (`.github/workflows/`) and the project files (`package.json`, `pyproject.toml`, `Makefile`, …), and the run says so in the first touchpoint. Nothing derivable → stop (phase 0 step 3). |
| **Skip-count baseline** | The skip count the suite reports on `main` before the change; any other number fails the gate. |
| **Worktree root** `<wt root>` | `C:\wt` on Windows, `~/wt` elsewhere. Worktrees live outside the project. |
| **Branch pattern** | `feat/<N>-<slug>`. |
| **Merge method** | Squash-merge, branch deleted afterwards. |
| **Pinned runtimes** — every interpreter or SDK the project pins (a version file, a toolchain file, an SDK pin) | Read the pin files themselves. |
| **Per-issue resources** — a port, a database name, anything derived from the issue number | None. |
| **Data rules** | No production, customer or personal data in the repository, ever; no secrets outside a gitignored `.env`. |
| **Domain invariants** — a record that must be written, a documented schema kept in step with code | None. |
| **Read-only repositories** — repositories this team does not own that may sit on the same machine | None. |
| **Questions to settle before the first story** — a list the project keeps open | None. |
| **Issue map** — the blocked-by graph `/issue-map` draws | Rebuilt silently after every claim and every merge when `.claude/skills/issue-map/` is installed. |
| **Requirements document (PRD)** — where it lives | None. |
| **Findings bar** — what is fixed now, deferred, filed or dropped | The rubric in phase 4. |

## Arguments

| Form | Meaning |
|---|---|
| `/dev-next` | Pick **one** eligible issue and ship it end to end — the default. Zero eligible → diagnose, never "nothing to do". |
| `/dev-next N` | Pick **N** eligible issues and ship them (N is 1-4; a bare number above four is read as an issue number, `/dev-next <N>` = `#<N>`, and the run says so). **Four is the cap** — beyond that this session's context holds too many reports and the decisions late in the run get worse. Fewer eligible than N → take what there is and say so. |
| `/dev-next #<N> #<M>` | Claim exactly these, however many. **The only way to resume a crashed run** — an issue already assigned to you is never picked up automatically, because this terminal cannot tell whether another of your terminals still owns it. |

**Several issues at once → one terminal with `/dev-next N`, never N terminals started together.** Sibling terminals of
one login rank the same top candidate and lose claim races to each other.

**Every issue, however many, ends the same way: its own pull request, merged into `main` on green CI.** The count changes
how many run side by side, never the destination.

## Roles — spawn these as sub-agents, never do their work yourself

| Role | Model | Effort | Job |
|---|---|---|---|
| orchestrator | opus | the user's own | this session. Talks to GitHub, spawns the others. **Never writes application code.** |
| `ready-check-N` | sonnet | low | reads one issue, returns `READY` or its questions, one line each with a recommended answer, nothing else |
| `dev-N` | opus | high | one worktree, one branch, one pull request. Most of the tokens. |
| `review-N` | opus | xhigh | fresh context, reads the CI suite result (runs the suite itself only when there is no CI), posts the verdict |

**Every brief** asks for a bounded result (the report shape its reference file gives, never an essay) and says: never
`git stash`, never switch branches in any checkout, never `git add -A` — commit only the files you touched (the
reviewer and the ready-check commit nothing) — and on failure report and stop instead of attempting your own recovery.
Mechanical work runs on the cheap model at low effort; only the dev and review roles run high.

**Effort** is passed as the Agent tool's `effort` on every spawn, whatever model the fallback below lands on. The
orchestrator runs at whatever effort the user's own session is set to (`/effort` or their settings); this skill never
changes it.

Name every sub-agent `role-N` (`dev-<N>`, `review-<N>-r2`, `ready-check-<N>`) — the audit finds them by that prefix;
the Agent tool rejects `:` and `#` in names on some machines. **Keep the agent id each spawn returns** and resume with
SendMessage to that id: a finished agent is often not reachable by its name. **No cap on how many are alive at once**: every
picked issue gets its own agents from the start; a rate-limit error (HTTP 429) is a reason to retry that spawn, never to queue.

Team members may be on different Claude plans, and a plan that lacks a model fails instantly on HTTP 429 with no
fallback. There is no separate probe: the first real spawn on a model is the probe, and an HTTP 429 on it retries that
spawn one model down and records the substitute for the rest of the run, always in this order:
**opus → sonnet** — a role takes the first model at or below its listed one that the plan holds. Never
substitute up, never skip down past a model the plan has. If the plan holds nothing at or below the listed model,
take the lowest model it holds. This applies to every role, the reviewer included. The audit's per-agent `model` field
records what actually ran.

## Parallelism — more than one issue at once, safely

A run asked for one issue does phases 1-6 for it alone; the rules below are then trivially satisfied. Asked for more, it
develops them **side by side**. Speed is the reason; safety is the constraint. Every one of these rules wins over speed.

1. **The count is decided by eligibility, not by the argument.** After phase 1 filtering, take up to the number asked
   for; fewer eligible → take what there is and say why the remaining slots are empty; zero → the diagnosis in
   `references/eligibility.md`. **Never widen the filter to fill a slot.**
2. **A second pick must not collide with the first.** Same epic is good (shared vocabulary); same seam or files is
   not (a merge conflict that a fresh reviewer then has to judge). Read every body; if two plausibly touch the same
   files, take a different candidate — and when in doubt, run fewer. Two issues where one is `Blocked by` the other
   are never a pair.
3. **Nothing is shared between issues.** Own worktree, own branch, own dev and review agents, and own copy of any
   per-issue resource (port, database) the project's `CLAUDE.md` derives from the issue number. A dev agent is told
   only about its own issue.
4. **Every picked issue runs at once.** One dev + one review per issue, **no cap on agents alive** — all N picked
   issues are in flight side by side from phase 3; nothing queues behind a slot.
5. **The machine has no cap, but this terminal is not alone.** Other terminals run this skill on the same machine
   and cannot see this session's agents. The in-flight file (`references/in-flight.md`) is how they see each other:
   every claimed issue is listed there, for visibility and for the merge queue. **Any number of issues may be in
   flight on the machine at once** — never wait for a slot; the only machine-wide queue is the `merging` slot.
6. **Merges are serialised — across terminals, not just within this one.** Whichever pull request is green first
   merges first. Take the `merging` slot in the in-flight file before phase 5 step 1 — write, re-read, confirm your run
   id, and re-confirm it on every CI poll and right before the merge command — and release it after step 4; a terminal
   that finds the slot live waits, and a holder's CI poll is capped at 30 minutes so the queue always moves. Each
   remaining branch then merges `origin/main` again, pushes, and waits for a **fresh** CI run on the merged result —
   that is `references/merge-and-ci.md` step 1 repeated, not skipped. A conflict goes back to `dev-N`; the
   orchestrator never resolves one.
7. **One failure never takes down the others.** An issue that goes `needs-human` is released on its own — including
   its entry in the in-flight file, and the `merging` slot if it held one; the rest carry on to merge and audit as if
   each had run alone.
8. **Sibling terminals on one machine may talk.** A terminal may message another (ListAgents / SendMessage) to warn
   about a shared file or type it is changing and to announce that it takes the merge slot; a change to a type another
   in-flight story consumes stays additive (new members, no changed signatures) until both have merged. The in-flight
   file stays the source of truth for the merge slot; a message never takes or releases it.

**A team usually spans several machines.** The in-flight file is per machine, so the merge queue is only machine-wide:
two people merging from two machines in the same minute are serialised by GitHub alone, not by this skill. That
residual is accepted for a small team; if it bites, the fix is a shared location for the file, recorded in the
project's `CLAUDE.md`.

---

## Phase 0 — Preflight

1. **Tools, tracker and runtimes.** `git --version`, `gh auth status`, `gh repo view --json nameWithOwner` (the
   repository `origin` points at: its GitHub Issues are the tracker, and this skill supports no other — a `CLAUDE.md`
   naming a different tracker → **stop and say this skill needs GitHub Issues**), and every runtime the project pins.
   **Missing tool → stop and print the command that fixes it.** Resolve each pinned runtime **once**, to an exact interpreter or SDK path
   whose `--version` prints the pinned version (an environment variable the project names, then the versioned launcher,
   then the version manager's own lookup), and pass those exact paths into every dev and review brief: the plain
   command on PATH may be another version on a teammate's machine. None found → stop and print the install command.
2. **Questions to settle before the first story.** If the project's `CLAUDE.md` keeps a list of questions to settle
   before the first story, and it still has items that are **not** marked parked or waiting for a named person, put
   them to the human as one batch — each with a recommended answer — then **this session** applies the answers to the
   files the list names in a worktree of its own (`git -C <main checkout> worktree add --no-track
   <wt root>/questions-<slug> -b feat/<slug> origin/main`, pushed the first time with `git push -u origin feat/<slug>`), adds the pull request's own changelog file,
   `docs/changelog/<YYYY-MM-DD>-<branch>.md` (one line), runs the gate the project's `CLAUDE.md` lists (build → lint → typecheck → full suite) in that
   worktree, opens the pull request with the results in its evidence table, and **stops**; a human merges it. A gate
   command still reading `TBD` (one of the questions may be what settles it) is not run: the evidence table says which
   ones were `TBD` and so not run. A command that runs and fails is fixed before the pull request opens, or the run
   stops and says so.
   No story is taken in that session. An item marked parked, or waiting for a named person, is skipped: it is resolved
   by the pull request that records that person's answer. This comes before step 3 because one of those questions may
   be the gate itself.
3. **The gate commands must be known.** Read them from the project's `CLAUDE.md`; if it is silent, derive them from the
   CI workflow and the project files and say so in the first touchpoint. If they are not known — a placeholder such as
   `TBD`, no CI and nothing derivable — stop and say so: there is no gate to run, so nothing can be shipped by this
   skill yet.
4. **No model probe.** A one-word probe agent costs tens of thousands of tokens (the system prompt) and tells you
   nothing the first real spawn does not. Spawn each role on its listed model; an HTTP 429 retries that spawn one model
   down (*Roles* above).
5. Mint a **run id** in **UTC**: `<repo>-<yyyymmdd-hhmmss>-<4 hex>`, where `<repo>` is
   `gh repo view --json name --jq .name` and the time comes from `date -u +%Y%m%d-%H%M%S`
   (PowerShell: `(Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')`). It names the worktree, the audit entry and
   every claim comment, and the harvest sorts audit reports by it. Never truncate the hex suffix: two terminals started
   in the same second differ only there. Never use a local clock: ids from different time zones then sort wrongly.
6. **Start from the latest `main`, without switching any branch.** `git -C <main checkout> fetch origin main`. Every
   worktree this run creates branches from `origin/main` (phase 3), never from whatever the main checkout has checked
   out, so every dev on the team starts from the same point. **Never `git checkout` or `git switch` in the main
   checkout**: a person may be working there. When it is already on `main` and clean, fast-forward it too
   (`git -C <main checkout> merge --ff-only origin/main`; `git pull --ff-only origin main` can fail with "Cannot
   fast-forward to multiple branches"); on another branch, or dirty, leave it exactly as it is — never stash, never
   reset. On `main` and unable to fast-forward → **stop and print what is in the way**. Then, when the main checkout
   is on `main` at `origin/main`, run the project's dependency install or restore command there: a failure (a
   dependency security advisory that the build treats as an error is the usual one) means the gate on `main` is red →
   **stop before claiming and print it** — every story would end `INHERITED RED`. On any other branch this check is
   skipped; the dev agent's first gate run reports a red `main` as `INHERITED RED` instead.
   Steps 1, 2, 3 and 6 (the update or the restore) are the only things that stop a run before it starts; step 8 pauses it.
7. **Labels, then snapshot.** `gh label list --limit 200 --json name --jq '.[].name'`; create every one of the seven
   labels in *What this skill reads from the project* that is missing, with `gh label create <name> --description
   "<one line>"` (a fresh repository carries only GitHub's defaults, so without this step every run would stall in
   step 8). Never rename or delete a label. Then snapshot what everyone else is doing — open issues with assignees,
   open pull requests, remote `feat/*` branches. This is the whole coordination mechanism with the **team**. There
   are no meetings.
8. **Unlabelled issues.** Any open, unassigned, non-`epic` issue with no `wayfinder:*` label (the planning skill's
   tickets, never this skill's), carrying none of `agent-ready`, `needs-human` or `outside-change`, is not eligible until a person
   says what it is. List them to the human in one batch, each with a recommended label and a one-line reason, apply the
   answers — a `needs-human` answer is posted as a comment with the human's reason, so it is the issue's last comment —
   then continue. This is part of the first touchpoint, not a wait mid-run.
9. Create the in-flight file if it is missing (`references/in-flight.md`) and read it. This is the whole
   coordination mechanism with the **other terminals on this machine** — note which issues are already in flight
   and whether someone is mid-merge. It never limits how many you take. **Before ranking**, write this run's own entry
   with `"issue": null` (run id, `startedAt`), wait 5 s and re-read: sibling terminals started together then see each
   other before any of them has claimed (`references/in-flight.md`, *Run entries*).

## Phase 1 — Pick and claim

**Sibling terminals stagger.** Re-read the in-flight file before ranking (phase 0 step 9 already wrote this run's
issue-less entry). Count *k* = the **other** runs with an entry that started in the last 5 minutes and before this one
(by `startedAt`, then run id; any login on this machine), **issue-less entries included**; skip the top *k* candidates
and start from candidate *k*+1, so siblings started together take distinct offsets. Counting only claimed runs lets
them rank the same top candidate — learned the hard way. One terminal with `/dev-next N` stays the right way to run
several.

Load `references/eligibility.md`. Filter, then rank, then take the top **one** by default, or the top N when a number was
asked for (never more than four). Fewer eligible than that → take what there is and say so; see *Parallelism* above.

**Zero eligible → do not say "nothing to do".** Name the issue that is blocking, name its assignee, drop this run's
issue-less in-flight entry, and stop.

**There is no machine-wide cap.** Read the in-flight file (`references/in-flight.md`) only to see what the other
terminals hold — never wait for a slot, and never let its length reduce the number you claim. It is the ranking that
keeps terminals apart: an issue another terminal already claimed is assigned, so it is never eligible.

Claim, in this order — the order matters:

1. `gh issue edit N --add-assignee @me` — **the assignee is the only atomic claim.**
2. `gh issue edit N --add-label in-progress`
3. Comment: claimed by run `<run id>`, branch `feat/N-<slug>`. Advisory only, and posted **second**, once the slug exists.
4. Add the issue's entry to the in-flight file: the first claim fills its number into this run's issue-less entry, a
   further claim adds an entry of its own. From here the issue is listed as in flight until phase 5 clean-up or a
   `needs-human` release removes it.
5. Rebuild the issue map silently when `.claude/skills/issue-map/` is installed: `/issue-map --silent` (runs
   `python .claude/skills/issue-map/scripts/issue_map.py`; shows nothing). Run it in the background, as its own command,
   never chained with another — after the phase 3 worktree exists, so a slow rebuild can never push `git worktree add`
   past the tool timeout. A failure is one logged line and never stops the run.

Re-read the issue immediately before writing to it. Another terminal may have claimed it in the last few seconds; if the
assignee is not you, release nothing and pick the next candidate. **A non-empty assignee on this re-read aborts the
claim** — no edit, no comment, even when the assignee is your own login: a check that only printed its result once
can let a claim comment through on an issue another terminal holds.

**Re-read it again after step 3.** Two claims can land in the same second, from two machines or from two of your own
terminals (same login, so the assignee check passes twice). If the issue now shows a second assignee, or a "claimed by
run …" comment posted before yours from a different run id, the earlier claim wins and you back off: delete your own
claim comment (`gh issue comment N --delete-last --yes` — only if the last comment is yours), drop your in-flight entry,
unassign yourself **only when the other assignee is a different login** (another of your own runs shares your
assignee and must keep it — `references/eligibility.md`, *Claim contention*), never touch `in-progress`, and pick the
next candidate.

## Phase 2 — Q&A (the first touchpoint)

- Issue labelled `agent-ready` before this run started → **ask nothing at all**. Go to phase 3.
- Issue labelled `agent-ready` in this run's preflight (step 8) → spawn `ready-check-N` with the issue body. It returns
  `READY`, or **every** question it has — no cap on the count, one line each with a recommended answer, no prose. It also checks two things a fresh label hides: **every acceptance
  criterion against the project's standing rules** (its `CLAUDE.md`: no build or run of a repository the team does not
  own, the skip-count baseline, no production, customer or personal data), and **every assumption in the body against
  current `main`** (a reason or note a later merge has overtaken). Either one failing is a question, or `needs-human`
  when no answer can make it agent-ready (a story that needs a system running that agents may not run).
  An unanswered question becomes a guess the dev agent bakes into the code; a long list is cheaper than that.
- Ask them all **in one batch**, each with a recommended answer the human can accept as-is.
- Write the answers onto the issue under a `## Decisions (agent-ready)` heading. They are binding on the dev and the reviewer.
- Any answer of the form "I don't know, ask someone else" → label `needs-human` and release the issue (the four steps
  at the top: comment why, remove `in-progress`, unassign, drop the in-flight entry), then pick a replacement.

## Phase 3 — Develop

```
git -C <main checkout> worktree add --no-track <wt root>/<N>-<slug> -b feat/<N>-<slug> origin/main
```

`--no-track` matters: a branch made from `origin/main` would otherwise track `main`, so a plain `git push` fails or
lands on `main`, and a merged branch never shows as gone to a clean-up sweep. The first push sets the branch's own
upstream (`git push -u origin feat/<N>-<slug>`, in the dev brief).

`<wt root>` is the worktree root the project's `CLAUDE.md` names (default `C:\wt` on Windows, `~/wt` elsewhere).

If the project's `CLAUDE.md` derives a per-issue resource from the issue number (a port, a database name), allocate it
now and write it where `CLAUDE.md` says (usually the worktree's `.env`), **replacing** any line already there for the
same setting — never append to a copy of `.env.example`, which may carry an empty one that wins.

Spawn `dev-N` with the brief in `references/dev-agent.md`. Give it: the issue, the worktree path, any per-issue
resource, the exact runtime paths from phase 0 step 1, and the gate commands. **You do not write application code.**

With more than one issue picked, run this phase for **all of them at the same time** — a worktree, a branch and a
dev agent each, none told anything about the others. Nothing waits for a slot.

Dev reports FAILED → label `needs-human` and release the issue (the failure is the reason comment), **leave the branch
and worktree for a human**, and carry on with whatever else the run has.

Dev reports `INHERITED RED` (the gate was already failing on `main` before it changed anything) → the story is not the
problem, `main` is. Open **one** `bug` issue for the red gate on `main` **per `references/new-issue.md`**: every
heading, each failing test named under `### Acceptance criteria` (green again), `### Seam` the folder the failures sit
in, labels `story` + `bug` + `tier:bug` + `needs-human` (its rule for an issue filed mid-run: nobody has checked it is ready; the
reason comment, the issue's last, asks a person to confirm the failures and flip it to `agent-ready`), native sub-issue
of the story's epic. One per run: a second dev reporting the same failures links the same issue
(`references/merge-and-ci.md`, *After the merge*). Once flipped, `references/eligibility.md` ranks it first. Then
release the story **without** `needs-human`: the comment links the bug, `in-progress` removed, unassigned, in-flight
entry dropped. The
worktree and local branch are removed when the dev made no commit (nothing to keep, and the next run would otherwise
have to clean them up); with commits they stay for a human. That bug issue is how a person learns about a pre-existing
failure; the run never waits for them.

## Phase 4 — Review

Spawn a **brand-new** `review-N` per `references/review-agent.md`. It gets only the issue, the pull request, the worktree,
the runtime paths and the commands — **no prior context, and never the agent that wrote the code**. A fresh one for every
round: a reviewer that has already argued for its own findings is no longer fresh eyes.

Reviews start as each dev finishes — no pull request is held for another.

**Before every review spawn, re-read the issue's comments.** A comment posted after the claim that binds the story — a
`Harvest of …` hand-over, a `## Decisions (agent-ready)` edit — goes to `dev-N` first (SendMessage), and the review
waits for that round. A binding comment the dev never saw costs a whole review round.

**The findings rubric** (unless the project's `CLAUDE.md` sets a different bar): small, safe **and in a file the pull
request already changes** → fixed in this pull request. Critical → a GitHub issue, linked from the pull request.
**Medium or high** — it would mislead a user, lose data, block another story, or cost the next run real time → a
`deferred` entry in the run's audit report, never a file in the product tree. **Low → nowhere.** Never open an issue
"to be safe"; a backlog nobody drains is worse than no backlog. The reviewer's tags are in `references/review-agent.md`.

- `CHANGES REQUESTED` → send the must-fix list, plus every `Fix now:` line, back to the **same** `dev-N`
  (SendMessage to the agent id kept at spawn, so it keeps its context; if it is no longer reachable, spawn a new `dev-N`
  on the same worktree and branch with the findings). It fixes them in the same branch, re-greens the gate, pushes, and
  reports. Then a **new** `review-N` reviews the whole pull request again — that is one round.
- `APPROVED` with `Fix now:` lines → same loop: `dev-N` fixes them in this pull request, then a fresh review confirms.
  Small and safe is fixed in the same session, never deferred — **once**. After the first `APPROVED`, the confirming
  review is the last: a new `Fix now:` it raises becomes a `Defer:` line, never another round (otherwise every fresh
  reviewer finds one new small thing and the loop never ends). **One exception:** a confirming-review finding that a
  user would see — a screen showing a wrong or empty result, an error swallowed — or that lets sensitive material
  through a gate (a malformed input read as trusted, say) is sent to `dev-N` once more and merged on green CI with
  **no further review**.
- `APPROVED` with only `Defer:` lines → no new review and no dev round: CI on the merged result is the gate.
- A finding that is only the pull request body (a stale test count in the evidence table) → the orchestrator edits the
  body itself; no dev round, no new review.
- `Defer:` lines — from the reviewer or from the dev agent's own report — → **the orchestrator keeps them and writes
  them into the run's audit report at phase 6** (`references/audit.md`, the `deferred` list: severity, area, what, why,
  owner). Nothing is written into the product tree, and no dev agent is resumed for them (resuming one just to write
  deferral files costs a whole turn). Only **medium or high** is kept; a `Defer:` the orchestrator cannot tie to a
  user-visible wrong result, lost data, a blocked story or real lost time is a low and is dropped on the spot — it is
  not recorded anywhere. **So they survive a run that dies before phase 6**, the orchestrator posts the kept lines as
  one `Deferred:` comment on the pull request the moment they arrive (the reviewer's are already in its verdict
  comment; the dev agent's are not); phase 6 copies from the pull request comments, never from memory.
- `Critical:` lines — from the reviewer or from the dev agent's own report — → the orchestrator opens one GitHub issue
  each **per `references/new-issue.md`** — full body, `story` + `needs-human` (nobody has checked it is ready; the
  reason is posted as a comment, the issue's last) + its tier (`tier:bug` for a defect, else `tier:dev-next`), native
  sub-issue of the claimed issue's epic, blocked by the claimed issue in both forms when the fix depends on its code —
  and links it from the pull request. Nothing else becomes an
  issue, and nobody but the orchestrator opens one.

**Every review is a round, approved or not.** Not approved after **three rounds** → `needs-human`, release the issue (the four steps at the top), leave the branch, and move on.

## Phase 5 — Merge

Follow `references/merge-and-ci.md`. In short: take the `merging` slot in the in-flight file → merge `origin/main` into
the branch and push so CI runs on what will actually land → poll for the check run id, then watch it → squash-merge →
release the slot → verify the issue closed → delete worktree and branch → remove the issue from the in-flight file →
rebuild the issue map silently when `.claude/skills/issue-map/` is installed (`/issue-map --silent`, in the background,
as its own command, never chained; it shows nothing and never blocks the run).

**Never merge on red or pending. "No checks reported" is red.** Red after two rounds → `needs-human` and the issue released.

More than one pull request → **one merge at a time, on the whole machine**. The `merging` slot is the queue: a terminal
that finds it taken waits. After the first lands, each remaining branch merges `origin/main` again, pushes, and gets a
fresh check run before it may merge (*Parallelism* rule 6).

## Phase 6 — Audit and report

Write the per-issue JSON per `references/audit.md` to the `audit/<your login>` branch. It cannot be reconstructed later —
local transcripts age out — so it happens on every run from the first. It carries the run's `Defer:` lines as the
`deferred` list (phase 4), and only the `friction` and `lessons_learned` lines that meet the bar in `audit.md`
(important or critical; a routine wait is not a line). The lists are usually empty.

A `merged` issue also gets its QA record, `runs/<run id>/qa-<N>.json` on the same branch, from the dev agent's
`QA checks` blocks and story (`audit.md`, *The QA record*): the checks a later `/harvest-qa` run drives against
`main`, and the story it dedupes them by. Same commit as the run report; nothing else changes.

Then count the one harvest pile: `deferred` entries + `friction` + `lessons_learned` lines across every developer's
audit branch — fetch them first with `git fetch origin 'refs/heads/audit/*:refs/remotes/origin/audit/*'`, list reports
with `git ls-tree -r --name-only origin/audit/<login> runs/`, read with `git show`, never check out — in runs whose run id
sorts after that login's `harvested_through` entry in `docs/harvest-state.json` (`git show origin/main:docs/harvest-state.json`), plus every entry in that
file's `carried` list (the file is written only by the `/harvest` skill; no file → everything is unharvested). At
**10 or more** → the summary ends with the line `Harvest due: run /harvest`. Counting only; this skill never runs the
harvest.

Then count the QA pile **separately, in records, never added to the harvest count**: `runs/<run id>/qa-<N>.json`
files across every audit branch in runs newer than that login's `tested_through` entry in `docs/harvest-qa-state.json`
(`git show origin/main:docs/harvest-qa-state.json`), plus the records that file's `carried` list points at (its entries are single checks: count each distinct
login, run and issue once, and not again when that record is already counted as newer; the file is written only by
`/harvest-qa`; no file → every record is untested). At **5 or more records** → the summary ends with the line `QA due:
run /harvest-qa`, after the `Harvest due` line if both apply. Each pile is judged against its own threshold only.
Counting only; this skill never runs the QA.

Then probe for drift between the issues and the PRD — **mechanical only, from data this run already holds**, never a
sub-agent and never a judgement. Three signs, any one of which is enough: (a) the issue map's footer, when `issue-map`
is installed and was rebuilt this run, says the body sections and native relations DISAGREE or that it dropped a link
(to an epic, to a missing issue, or one closing a cycle); (b) an open non-epic issue in the phase 0 snapshot with no
`wayfinder:*` label (planning tickets hang under their map, not under an epic) carries both `agent-ready` and `needs-human`, or is in no open epic's sub-issue list
(`gh api repos/{owner}/{repo}/issues/<epic>/sub_issues --jq 'map(.number)'`, one call per open epic); (c)
`docs/PRDs/` changed on `main` since the bookmark `docs/reconcile-state.json` records, not counting the reconcile's
own commits: a commit in `git log --format=%H <reconciled_at>..origin/main -- docs/PRDs/` that is **not** also in
`git log --format=%H <reconciled_at>..origin/main -- docs/reconcile-state.json` is drift (the reconcile's pull request
edits the PRD and the bookmark in one commit, so without that filter every reconcile would look like drift; no
bookmark and at least one PRD → counts as changed, once, until a first reconcile writes it). Any sign → the summary ends with the line
`Drift found: run /reconcile-issue-map`, after the `Harvest due` and `QA due` lines if they apply. Probing only; this skill never
reconciles and never edits an issue for it.

Then print **ten lines per issue, no more** (the second touchpoint): issue and title · what shipped · pull request link · suite result ·
CI result · anything labelled `needs-human` and why · what is on deck next.

The run then ends with a **close-out**, always last, after the `Harvest due`, `QA due` and `Drift found` lines if there are any.
It tells the human whether anything in this session still waits on them:

- **Something waits on them** → `For you in this session:` followed by a numbered list, one action per line, most
  urgent first — a question left on a `needs-human` issue, a branch and worktree left for a human, a pull request left
  open, red or pending CI, a merge slot still held, a failed audit write, `Harvest due`, `QA due`, `Drift found`. Each line names
  the thing in plain words and says what to do.
- **Nothing waits on them** → exactly: `All good: everything merged, nothing to report, nothing left for you. You can
  close this session.` Only when every claimed issue merged and closed, no pull request is open, the in-flight entries
  and the merge slot are released, the audit was written and there is no `Harvest due`, `QA due` or `Drift found` line.

The close-out only offers; the human closes the session, never the skill.

---

## Rules that are not negotiable

0. **Never push to `main`.** Every change lands as a pull request that is then merged. Full autonomy means you may open,
   review and merge it yourself — never that you may skip it. This skill merges only its own pull requests; every other
   pull request is merged by a human unless the project's `CLAUDE.md` says otherwise.
1. **Never wait for a human after preflight.** The first touchpoint (phase 0 steps 2 and 8, phase 2) is the one place
   questions are asked; from phase 3 on: label it, explain it, release it, move on.
2. **The reviewer is always fresh.** Enforced here, not left to good intentions.
3. **Never merge on red or pending**, and "no checks reported" is red.
4. **Assign first, comment second.** The assignee is the claim.
5. **Never auto-resume** an issue already assigned to you — another of your terminals may still own it.
6. **The orchestrator never writes application code.** If you are editing a source file, you have taken the dev agent's job.
7. **Parallel never means shared.** Issues in flight never share a worktree, branch, database, port or agent, and never merge at the same time.
8. **This terminal is not the machine.** The merge queue lives in the in-flight file; a terminal that skips it is
   running blind next to the others. There is no machine-wide cap on issues — only on merges, one at a time.
9. **An `outside-change` issue is never picked by this skill.** It touches a repository this team does not own and ends
   at a pull request for that repository's reviewer, driven by a human. The eligibility filter excludes it.
10. **No production, customer or personal data in the repository, ever.** A dev or review agent that finds any in a
    diff stops and reports it as a blocking finding.
11. **Never schedule a wakeup or a `/loop`.** A finished sub-agent or background command re-invokes the orchestrator
    on its own; a wakeup carrying this skill's prompt starts a second run beside the first.

## References — load on demand, not up front

| File | Load at |
|---|---|
| `references/in-flight.md` | phase 0, and again at the phase 1 claim and before phase 5 |
| `references/eligibility.md` | phase 1 |
| `references/dev-agent.md` | phase 3 |
| `references/review-agent.md` | phase 4 |
| `references/new-issue.md` | phase 4, whenever a `Critical:` line becomes an issue; phases 3 and 5, whenever a red `main` becomes a `bug` issue |
| `references/merge-and-ci.md` | phase 5 |
| `references/audit.md` | phase 6 — the run report and the QA record |
| `references/shell-traps.md` | whenever a shell command behaves strangely |
