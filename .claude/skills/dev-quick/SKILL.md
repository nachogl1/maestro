---
name: dev-quick
description: ORION - Turn a change you want right now, with no ticket yet, into an agent-ready GitHub issue and ship it end to end. A clear request ships with no questions; an unclear one gets an interview until nothing is left to ask, a list of anything you must prepare first (a secret in .env, a service, a decision from someone else) and one look at the draft. It files the issue per the dev-next issue shape, then hands it to /dev-next as the engine — claim, worktree, fresh-agent review, merge on green CI, close, audit — with no further questions. Works with GitHub Issues only, like dev-next. Use when the user types /dev-quick, says "I want to change this now, there is no ticket for it", or says yes when offered /dev-quick for a code change asked for in chat.
argument-hint: "What you want changed, in your own words"
---

# /dev-quick

> [!NOTE]
> **Editing this skill?** Keep everything here **general**: no project, person, company or stack names — the project's own `CLAUDE.md` supplies those at run time. It works with GitHub Issues only, like `dev-next`, whose `SKILL.md` and `references/new-issue.md` it relies on.

`/dev-next` takes an issue that already exists. This skill is for the change you want **now**, that nobody has written
down yet: a fix you just spotted, a small feature a conversation produced, a tweak that is not worth a planning
session. It turns your words into an issue an agent can build unattended, then runs `/dev-next` on exactly that issue.

**It is a front door, not a second engine.** Everything from the claim onwards — worktree, dev agent, fresh-agent
review, merge on green CI, closing the issue, the audit report, the close-out — is `/dev-next`'s, invoked as a
sub-skill on the issue this skill files. Nothing in that pipeline is copied here, and nothing in it is done by hand.

**The human is in the loop until the issue is filed, and never after.** Three things happen with you present: the
interview (as many rounds as it takes until there is nothing left to ask), the ground preparation (things only you can
do before an agent starts), and one look at the drafted issue before it is filed — none of them when the request is
already clear (*The fast path* below). From the moment `/dev-next` takes
over, the run is autonomous: anything it cannot resolve becomes `needs-human` on the issue, and you hear about it in
the close-out, not mid-run.

Read the project's `CLAUDE.md` first. It overrides this file where they disagree.

## Prerequisites

- `.claude/skills/dev-next/` is installed in this project (orion ships both; `orion update` restores it). Missing →
  stop and say so: there is no engine to hand the issue to.
- Everything `/dev-next` needs: GitHub Issues as the tracker, `gh` logged in, the gate commands known from the
  project's `CLAUDE.md` or derivable from CI. This skill checks the first two in its own preflight; `/dev-next`
  checks the rest when it starts, and stops if they are missing — the issue stays filed, nothing is lost.

## Arguments

| Form | Meaning |
|---|---|
| `/dev-quick <what you want>` | One change, in your own words — a sentence or a pasted paragraph. The interview starts from it, unless it takes the fast path. |
| `/dev-quick` | No words yet → the first question is "What do you want changed?", then the interview as below. |

**One change per run.** A description that turns out to hold two independent changes is split into two issues, each
with its own interview, and `/dev-next #<A> #<B>` is handed both; two changes that depend on each other become one
issue blocked by the other, and only the unblocked one is handed over now.

## What "quick" means — and when this is the wrong skill

Quick means **one story**: one owner folder or module (its `### Seam`), one pull request, no requirements document.
The interview decides this, not the length of the description. The moment it shows the change needs **two seams**, a
**shared contract** several stories would extend, a **screen the prototype in `docs/ux/` lacks**, or a product
decision nobody has made, it is not quick:

- Say so in one line, and name what it needs instead — an ADR under `docs/ADRs/` for a hard-to-reverse decision,
  approved by the person before any ticket, or, for a big change, the question whether the person wants a PRD,
  which they write or provide (both the project's standing rule), `/wayfinder` when the way to the result is not
  clear yet, a planning session when it is several stories.
- Offer the one honest alternative: file **only the first story** now, if it stands on its own and is useful alone,
  and leave the rest to planning. Never file the whole thing as one over-sized `agent-ready` issue.

## The fast path — a clear request ships with no questions

The interview exists to remove guesses, not to slow down a change that holds none. After phase 1, take the fast path
**only when every one of these holds**; one doubt means the full path, as below:

- The request is **one** change: nothing to split (*One change per run* above).
- Every phase 2 category — goal, scope, seam, acceptance criteria, blockers, epic, evidence — is evident from the
  request, the code and the project's `CLAUDE.md`, with **one** epic that clearly fits and no open blocker.
- The seam check of phase 2 (*Seam*: another open story on that folder) runs and finds nothing.
- No risk item (phase 2, *Risk*), no standing-rule hit, nothing to prepare (phase 3), and nothing the PRD describes
  changes.

Then say so in one line ("Clear request: filing and shipping it with no questions"), skip the phase 2 questions and
phase 3, and in phase 4 skip the draft look (step 4) and the PRD question (step 6). `## Decisions (agent-ready)` still
records every category, each answer followed by where it was evident from. The dedupe pass of phase 1 runs as always,
and phase 5 runs unchanged.

## Roles

| Role | Model | Effort | Job |
|---|---|---|---|
| this session | opus | the user's own | interviews, prepares, drafts, files, then invokes `/dev-next` and becomes its orchestrator |
| `scout-quick` | sonnet | low | optional: reads the code the change touches and returns a bounded picture (phase 1) |
| everything else | — | — | `/dev-next`'s own roles (`dev-N`, `review-N`), spawned by it, never by this skill |

This session **never writes application code** — not before the hand-over, not after. If you are editing a source
file, you have taken the dev agent's job.

---

## Phase 0 — Preflight (short; `/dev-next` repeats the full one when it starts)

1. `gh auth status`, `gh repo view --json nameWithOwner` — GitHub Issues in the repository `origin` points at is the
   tracker, the only one this skill and `/dev-next` support. A `CLAUDE.md` naming another tracker → stop and say so.
   `.claude/skills/dev-next/SKILL.md` and `.claude/skills/dev-next/references/new-issue.md` exist → else stop.
2. Read the project's `CLAUDE.md`: the worktree root, the gate commands, the issue shape if it defines its own, the
   boundaries an agent must not move, the standing decisions that are never asked about. Every question in phase 2 is
   checked against this file first — a question the project has already answered is not asked.
3. Labels: `gh label list --limit 200 --json name --jq '.[].name'`; create any of `epic`, `story`, `agent-ready`,
   `needs-human`, `in-progress`, `outside-change`, `bug` that is missing, with a one-line description. Never rename or
   delete one. (`/dev-next` does the same; whichever runs first creates them.)
4. **Latest `main`, read only, without switching any branch.** `git fetch origin main`, then read the code as it is
   on `origin/main` (`git show origin/main:<path>`, `git grep <pattern> origin/main`, `git ls-tree -r --name-only
   origin/main <folder>`). The main checkout's own files count only when it is on `main` at `origin/main`. **Never
   `git checkout` or `git switch` in the main checkout**, never stash, never reset: a person may be working there.
   This skill creates no worktree and no branch — `/dev-next` does, in phase 3.

## Phase 1 — Understand before asking

A question grounded in the code is answerable; a question asked blind gets a guess back.

1. **Read what the change touches.** From the description, find the folder or module it lives in, on `origin/main`
   (phase 0 step 4; the project's `CLAUDE.md` layout section). Read enough to know: what exists today, what the change would alter, which
   tests cover it, what else depends on it. A change in an unfamiliar area may go to a `scout-quick` sub-agent with a
   bounded brief ("the folder, the entry points, the tests, the dependants — ten bullets, no essay"); a change you can
   place in a few reads does not need one.
2. **Dedupe — mandatory, never skipped.** Search the open issues (`gh issue list --state open --limit 100 --json
   number,title,labels,assignees,body`, then `gh issue view <N> --json title,body,labels,comments` for the likely ones)
   and the code for something that already covers the change:
   - An **open, unassigned issue already covers it** → do not file a second one. Say which issue it is, by name, and
     run the interview of phase 2 on *that* issue's body instead; the answers go onto it under
     `## Decisions (agent-ready)`, its labels are fixed (phase 4 step 3), and phase 5 hands *it* over.
   - An **open issue is already assigned, has a `feat/<N>-*` branch or an open pull request** → someone is on it.
     Stop and say who, by name. Never claim or edit it.
   - A **closed issue** covered it once → it does not now; say so in one line and carry on (never defer to a closed issue).
   - The **code already does it** → say so, show where, and stop. No issue.
3. **Size it** against *What "quick" means* above. Not quick → say so now, before any question is asked, and offer
   the first-story-only alternative.

## Phase 2 — The interview: every question, nothing left to ask

Full path only; a request on *The fast path* skips this phase.

The point of this phase is that `/dev-next` asks nothing. An unasked question becomes a guess the dev agent bakes into
the code and the reviewer cannot judge; a long interview is cheaper than one wrong guess shipped to `main`.

- **Ask every question you have**, in batches of related ones, through the clickable-options tool
  (`AskUserQuestion`): distinct options per question, your recommended answer **first and marked**, so the person
  can accept a whole batch as-is in seconds. No cap on the number of questions.
- **Plain language, as to a junior developer with no context**: say what a thing does, not what it is called; gloss
  any term in two to four words the first time; never a bare issue number.
- **Rounds.** After a batch, re-read the answers against the code: a new question that *only now* arises goes into
  the next batch. Stop when a round produces no new question. Never re-ask a settled one; never ask what the project's
  `CLAUDE.md` already decides (the worktree root, the merge method, the data rules, the language, the deploy target).
- **The categories to cover — a question in each unless the answer is already evident** (the drafted issue in phase 4
  has a heading for every one of them, so a gap here is a gap there):
  - **Goal** — what is true when this is done, in one sentence the person recognises as theirs.
  - **Scope** — what is in, what is out; what it **reuses** (an existing option, a record type and whether its fields
    may be empty) and what it builds on that does not exist yet.
  - **Seam** — the one folder or module it owns. Check `gh issue list --state open --label story --search "<folder>"`:
    another open story on that folder is either a blocker or a merge, never a collision left for later.
  - **Acceptance criteria** — every behaviour as a checkbox, every checkbox with a test the agent can run. A criterion
    an agent cannot meet alone (needs credentials it does not hold, a live service, a person's act) is a **ground
    preparation item** (phase 3) or a separate `needs-human` story, never left inside the agent-ready one.
  - **Blockers** — an open issue whose result this needs. Blocker in both forms (phase 4), and the issue is not handed
    over until it is closed.
  - **Epic** — which existing epic it belongs under (`gh issue list --state open --label epic`), with your
    recommendation; none fits → the person names a new one, created with the `epic` label. A story never hangs loose.
  - **Evidence** — what the pull request's evidence table must show for the person to believe it works.
  - **Risk** — a user-visible behaviour change, a record format, a migration, a shared file (build or project file,
    a shared type): each one is a question, because each one is what `/dev-next`'s reviewer will ask about.
  - **The project's standing rules** — read every proposed criterion against the project's `CLAUDE.md`: a repository
    the team does not own built or run, a skipped test, production or personal data, a boundary moved. Any hit is
    either rephrased with the person or makes the story `needs-human`.
- **"I don't know, ask <someone>"** as an answer → the story is `needs-human`: it is still drafted and filed (phase 4),
  with the open question and the person's name as its last comment, and **phase 5 does not run**. The run ends by
  saying so. Nothing is guessed on their behalf.
- **Decisions the person could take now, but did not** → recommend one, say it is reversible, and record the answer.
  A run that waits later costs money doing nothing; a choice made now costs one click.

## Phase 3 — Ground preparation: what only the person can do first

Some changes need the ground prepared before an agent can start, and an agent cannot prepare it: a secret in the
gitignored `.env` (never in the issue), a service or account that must exist, a design in `docs/ux/` for a screen, a
dependency or tool installed on this machine, a label or branch protection on the repository, a decision from someone
not in the room.

1. **List every item** the interview surfaced, numbered, one action per line, plain words, most blocking first, and
   say for each how you will verify it (`.env` holds the name, the tool answers `--version`, the file exists, the
   service answers). Secrets are named, never asked for and never echoed.
2. **The person does them.** Suggest `! <command>` in the prompt for anything that must run in their own session
   (an interactive login, say). Wait for their word that an item is done, then **verify it** before ticking it off.
3. **An item that cannot be done now** → the story is filed `needs-human` (phase 4) with the outstanding item and
   who does it as its last comment; phase 5 does not run. The run ends by saying what remains.
4. Nothing to prepare → say so in one line and move on. Most quick changes need nothing here.

## Phase 4 — Draft once, approve once, file

On *The fast path*, steps 4 and 6 are skipped: draft once and file.

1. **Draft the issue per `.claude/skills/dev-next/references/new-issue.md`** — every heading, in its order (`### Epic`,
   `### Goal`, `### Scope`, `### Seam`, `### Acceptance criteria`, `### References`, `### Blocked by`,
   `### Evidence expected`; `### External reference` only for an `outside-change`), the process footer, names not bare
   numbers. The project's `CLAUDE.md` wins where it defines its own shape. Under `### References` name where the change
   came from: "filed by /dev-quick from a request in a session on <date>", plus any issue or document it serves.
2. **Add `## Decisions (agent-ready)`** after the body: every question from phase 2 with its answer, one line each.
   This is what makes `/dev-next` ask nothing — its phase 2 reads this heading as binding on the dev and the reviewer.
   The ground-preparation items, with the verification each passed, go here too.
3. **Labels:** `story` + exactly one readiness label — `agent-ready` when nothing is left to ask and the ground is
   prepared; `needs-human` otherwise (reason as the last comment, posted right after creation). `bug` added when the
   change fixes a defect. `outside-change` + `needs-human` when it touches a repository the team does not own (then
   phase 5 never runs). An issue found in phase 1 step 2 that already carried a readiness label is re-labelled the same
   way, never left with both. One tier label (`new-issue.md` step 2): `tier:bug` when the change fixes a defect, else
   `tier:dev-quick`; an issue found in phase 1 step 2 that already has a tier keeps it.
4. **Show the whole draft to the person once** (skipped on the fast path) — title, labels, body, decisions — and ask for one of: file it as-is,
   change something (then show it again), or stop here (nothing is filed, the answers are printed so they are not
   lost). This is the last look before an autonomous run; it is not a new interview round.
5. **File it:** body to a UTF-8 file, the tier label created first when missing (`new-issue.md` step 2),
   `gh issue create --title "<title>" --label story --label <readiness> --label <tier>
   --body-file <file>` (PowerShell adds a byte-order mark; bash heredocs break on apostrophes —
   `.claude/skills/dev-next/references/shell-traps.md`). Then, exactly as `new-issue.md` steps 3 and 4 say: the native
   sub-issue link to the epic and the native `blocked_by` relation for every `### Blocked by` line, **each read back
   and checked**; a mismatch is fixed before anything else happens. `needs-human` → post the reason as the last
   comment now.
6. **Ask once, after filing** (skipped on the fast path)**:** "Should we update the PRD with this too?" — one line naming the section it would
   touch, only when the project keeps a requirements document and the change alters something a reader of it would
   care about. "No" ends it; "yes" is a line for `/dev-next`'s dev agent, added under `## Decisions (agent-ready)`
   ("also update `<PRD section>` in the same pull request"), so it ships in the story's own pull request.

Print the issue's number and title on one line. From here it exists, whatever happens next.

## Phase 5 — Hand over to `/dev-next`

The issue carries `story` + `agent-ready`, every blocker under `### Blocked by` is **CLOSED**, and the ground is
prepared → invoke the **`dev-next` skill** with the argument `#<N>` (several filed in this run → `#<A> #<B>`): the
Skill tool, or, where it is unavailable, read `.claude/skills/dev-next/SKILL.md` and follow it from its Phase 0 with
that argument. This session is now `/dev-next`'s orchestrator and follows that file alone:

- Its preflight runs in full (tools, gate commands, latest `main`, labels, unlabelled issues, the in-flight file).
  A stop there (a `TBD` gate command, a red install on `main`) is reported in one line; the issue stays filed and
  `agent-ready`, and the person runs `/dev-next #<N>` later.
- Its phase 2 asks nothing: the issue was `agent-ready` before that run started, and its decisions are on the issue.
- Claim, worktree on `feat/<N>-<slug>`, `dev-N`, fresh `review-N` per round, the merge slot, merge on green CI,
  close, clean-up, the audit report on `audit/<login>`, the harvest count and the close-out — **all of it is
  `/dev-next`'s, unchanged.** This skill adds no step, skips no step, and never does one of them by hand.

The issue is **not** handed over, and the run ends after phase 4 saying why, when it is `needs-human` or
`outside-change`, or when a blocker is still open (then: "blocked by <issue name>; run `/dev-next #<N>` once it is
closed").

**The second touchpoint is `/dev-next`'s close-out**, nothing of this skill's own: the ten lines per issue, the
`Harvest due`, `QA due` and `Drift found: run /reconcile-issue-map` lines if any, and `For you in this session:` or `All good: …`.

---

## Rules that are not negotiable

0. **Never push to `main`.** The change lands only as `/dev-next`'s pull request, merged by `/dev-next` on green CI.
1. **Nothing is filed `agent-ready` with a question left.** If you can think of a question, ask it. The interview has
   no cap; the autonomous run has no questions.
2. **Nothing is filed without the person's look at the draft** — except on the fast path, where nothing was left to
   ask. One look, then it is theirs.
3. **The dedupe pass is mandatory.** Never a second issue for something an open issue already covers; never a deferral
   to a closed one.
4. **This session never writes application code** — before or after the hand-over.
5. **`/dev-next` is invoked, never imitated.** Not one of its phases is reproduced here; a change to how issues are
   built is a change to `/dev-next`, not to this file.
6. **A ground item is verified, never taken on trust.** "Done" from the person is followed by the check.
7. **Never schedule a wakeup or a `/loop`** — `/dev-next`'s rule, and this skill's too.

## References — load on demand, not up front

| File | Load at |
|---|---|
| `.claude/skills/dev-next/references/new-issue.md` | phase 4 — the issue shape, labels and native links |
| `.claude/skills/dev-next/references/shell-traps.md` | phase 4 step 5, and whenever a shell command behaves strangely |
| `.claude/skills/dev-next/SKILL.md` | phase 5 — the engine, followed in full from its Phase 0 |
