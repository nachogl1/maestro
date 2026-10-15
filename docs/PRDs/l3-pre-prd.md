# L3 Software Factory — pre-PRD

| | |
|---|---|
| **Status** | Pre-PRD. States what is wanted and what exists. Decides nothing about how. |
| **Date** | 2026-10-15 |
| **Owner** | the repository owner |
| **Supersedes, once a PRD exists** | `docs/samurai/prd.md` (Samurai v1 design, 2026-08-06) as the autonomy design for Maestro |
| **Inputs** | Maestro `main` at `22e5ee2`; Orion `main` at `22748fe`; Claude Code and Agent SDK documentation as of 2026-10-15 |

This document is deliberately a **what**, not a **how**. It records the intent, the experience wanted, the
rules that bind it, the facts about what exists today, the gaps, the things that can go wrong, and the
decisions still open. The PRD that follows it will choose mechanisms. Nothing in here is a mechanism choice,
and where a mechanism is named it is named as an existing fact, not as the design.

---

## 1. Intent in one paragraph

The owner wants to hand Maestro a project and a PRD, or a project whose backlog is already cut into tickets,
and have the software **built to completion by agents without the owner's attention**, except at a small
number of points that are known in advance and front-loaded. The process the agents follow is the one the
owner already follows by hand and has written down as **Orion**, the per-project framework of skills and
rules. Maestro becomes the **harness** that triggers, supervises, heals, audits and reports on that process.
The owner calls this the **Software Factory**, and the generation of Maestro that delivers it **L3**.

What the owner is moving away from: the current **Samurai launches** and the **Second Brain** panel. They
exist, they work in parts, and they were built for a different unit of work. The owner's judgement from using
them is that they are clunky, require too much attention, and are not automatic. That judgement is backed by
the code facts in section 7.

---

## 2. Problem statement

1. **Starting work is a human act, every time.** Orion's skills start when a person types a slash command.
   A `/dev-next` run takes up to four stories and then stops. Nobody restarts it. Samurai's launcher needs a
   person to write free text, pick a model, read a preflight and click. Nothing in either system queues work
   or picks the next thing up when the last thing finishes.
2. **Recovery is a human act, every time.** A parked, interrupted or crashed Samurai run waits for a click
   on Recover or Resume now. Cold start never spawns by design. A crashed `/dev-next` run is resumed by a
   person typing `/dev-next #N`.
3. **The harness and the process do not know each other.** Samurai carries its own workflow text (a seven
   step linear graph compiled into every brief) and has no notion of Orion's labels, phases, audit branch,
   in-flight file or merge queue. Orion has no notion of allowance windows, context health, a dead terminal,
   or another machine. Each side re-solves problems the other already solved, and they can disagree.
4. **The owner's attention is spent in the wrong place.** Instead of a batch of decisions at the start, the
   owner is interrupted mid-run by things that could have been known up front: an unlabelled ticket, a
   missing gate command, a red main, a prototype that does not exist, a secret that was never set.
5. **Audits are split.** Orion writes one JSON per issue per run on a per-developer audit branch, with
   tokens, phase seconds, review rounds, friction, lessons and deferred findings. Samurai writes a per-project
   JSONL of supervisor events. Neither view shows what a story cost once supervision, parks and crashes are
   included, and neither is visible without a terminal or a file manager.
6. **The Second Brain is a file manager, not a view of the work.** It lists handoffs, briefs, run configs,
   timers and log slices with size and age. It answers "what files did the supervisor create" and not "what
   is the factory doing, what is blocked, what did it cost".

---

## 3. Goals

Each goal is phrased so that the eventual PRD can turn it into acceptance criteria.

- **G1. Trigger and walk away.** From one action in Maestro, a project with a ready backlog is built story by
  story until no eligible story remains, with no further input from the owner except at the points in G3.
- **G2. Two intake modes.** (a) From a PRD: planning happens with the owner present, as Orion's rules require,
  then the build runs unattended. (b) From a cut backlog: the build runs unattended from the start.
- **G3. Human needed first, and only where the rules say so.** Every decision a human must take is surfaced
  before the autonomous phase starts, as one readiness checklist. During the run the owner is needed only
  for: a story labelled `needs-human`, a PRD change, and the Orion skills the owner keeps reserved for a
  person (see section 6 and decision D3).
- **G4. Self-healing without a human.** Allowance exhaustion, a crashed or hung session, an expired `gh`
  login, a red `main` inherited from someone else, a context window filling up, and an app restart (including
  the Windows self-update) are all survived by the factory on its own, and resumed from where work stopped.
- **G5. Orion is the process. Maestro never carries a workflow of its own.** When the owner changes Orion, the
  factory follows without a Maestro change. Maestro's job is when, who, how long, health, retries, human
  gates and the audit view.
- **G6. One audit per job, down to the story.** Cost, time, outcome, interventions, friction, lessons and
  deferred findings are visible in Maestro per job, per run, per story, and the data Orion's `/harvest` and
  `/harvest-qa` consume is readable from the same place.
- **G7. A chain of command.** Agents can tell Maestro things and ask Maestro for things through one defined
  surface, and Maestro can tell agents things without typing blindly into a terminal.
- **G8. Everything that can go wrong has a named owner and a named outcome** (section 8). "It depends" is
  not an outcome.
- **G9. Maestro is built by its own factory** (dogfooding). Orion is installed on Maestro and the factory
  ships its own stories once L3 exists at the level that allows it.
- **G10. The owner stops thinking about it.** The measurable version: the owner opens Maestro, sees what
  moved since last time, what is waiting on them, and what it cost. That screen is the product.

---

## 4. Non-goals

- Replacing GitHub Issues as the tracker. Orion is GitHub-only by rule; so is the factory.
- Replacing Orion's skills with Maestro-side logic. If a step is wrong, the fix is in Orion.
- Running on a server, in the cloud, or on several machines in v1. The decision is open (D6) but the
  default assumption is one Windows machine, one login, as today.
- Model routing, cost optimisation across models, and spend-budget parking for enterprise plans. Out of scope
  as they were for Samurai v1.
- Auto-approving a PRD, auto-creating a PRD, or filing tickets agent-ready without a person. These are Orion
  rules and they stand.
- Merging to `main` by any route other than the one Orion defines (a squash-merged pull request, green CI,
  fresh-agent review). A human still makes the merge decision wherever Orion says a human does.
- Keeping the Samurai launcher or the Second Brain as products. They are replaced, not polished.

---

## 5. The experience wanted, as scenarios

These are written as the owner would want to live them. They are requirements in narrative form.

### 5.1 Mode A: a new project from a PRD

1. The owner has a repository with Orion installed and a PRD approved under `docs/PRDs/`.
2. In Maestro the owner creates a **job** for that project and points it at the PRD.
3. Maestro runs the **readiness check** and shows one list. Red lines are human tasks, each with the reason
   and a one-click way to start the session that resolves it. For a new project the list typically says:
   the gate commands are `TBD`; there is no CI; the backlog is empty; a UX prototype is needed.
4. The owner starts the planning session from that list. It is an Orion `/prd-to-tickets` session, with the
   owner present as the rule requires. Maestro hosts it like any terminal. When it ends, the backlog exists,
   every story is `agent-ready` or `needs-human`, both blocker forms are set, the prototype pull request is
   open.
5. The owner merges the prototype pull request and the scaffold story runs (it may be the first story the
   factory builds; the readiness list says which).
6. The readiness list goes green. The owner presses **Start**. The owner walks away.
7. Hours or days later the owner opens Maestro. The job view shows: stories merged since last visit,
   stories in flight, stories waiting on a human and why, the harvest and QA counters, parks and recoveries
   that happened, the cost so far. Nothing else needed the owner.
8. The job ends when no open story is eligible. If stories remain and all are `needs-human` or blocked by
   one, the job is **waiting on the owner**, says so, and lists them.

### 5.2 Mode B: a backlog already cut

Steps 1 to 5 are already done. The owner creates the job, sees the readiness list (ideally all green), presses
Start, and walks away. Everything from step 7 applies.

### 5.3 A story that cannot be finished by an agent

A dev or review agent hits something an agent may not decide (an irreversible choice, a missing credential,
a repository the team does not own). Orion's rule applies: the story is labelled `needs-human`, the reason is
its last comment, the run carries on with other stories. Maestro **notices** the label change, raises one
notification, and shows the story in the job's "waiting on you" list. When the owner answers (on GitHub, in the
story) and flips it back to `agent-ready`, the factory picks it up on its next pass without being told.

### 5.4 The allowance runs out at 03:00

The factory winds down new work before the hard limit, parks what is running at a safe point, records the
park, and resumes at the reset time on its own. The owner sees a park and a resume in the audit the next
morning, and nothing waiting on them. If the laptop rebooted in between, the result is the same.

### 5.5 A session dies silently

A claude process crashes and its terminal sits at a shell prompt. The factory detects it, records it, and
restarts the work for the stories that session had claimed, in the way Orion defines for a crashed run. The
owner is told after the fact, not asked.

### 5.6 `main` goes red because of someone else

A story's gate fails on a `main` that was already failing. Orion's rule applies: the story is released without
blame and one `bug` issue names the failures. The factory ranks that bug first on its next pass (Orion's
ranking already does), builds the fix, and the released story is retried afterwards. The owner sees one line
about it.

### 5.7 Harvest, QA and drift come due

Orion's counters trip: ten unharvested findings, five untested QA records, or drift between PRD and issues.
What happens next depends on the level the owner chooses (section 6): either the job pauses that strand and
asks the owner to run the skill, or the factory runs it and brings the owner a batch to approve.

### 5.8 The owner wants to see or steer

At any time the owner can open the live session of any story, read its stream, and either leave it or stop
it. Stopping a story releases it the Orion way. The owner can pause the whole job, which finishes atomic
steps and stops claiming. The owner can change the level of the job. None of this needs a terminal command.

---

## 6. Levels of autonomy, and what "L3" names

The owner's own word for this generation is **L3**. This section fixes what the levels mean so the word has
one meaning in every later document. The ladder is chosen so that each level is usable before the next
exists.

| Level | Who starts work | Where a human is needed | Orion rule changes needed |
|---|---|---|---|
| **L0** | a person types `/dev-next` | everywhere Orion says, plus starting and restarting | none. This is today's Orion by hand. |
| **L1** | a person clicks once per run in Maestro | same as L0 minus the typing; Maestro supervises, parks, audits one run | none. This is roughly Samurai today, if it drove Orion. |
| **L2** | Maestro, until the backlog has no eligible story | readiness gate; `needs-human` stories; the four person-only skills (`prd-to-tickets`, `harvest`, `harvest-qa`, `reconcile-issue-map`) | none. The factory stops at those four and tells the owner. |
| **L3** | Maestro | readiness gate; `needs-human` stories; PRD changes; approving a batch from harvest | `harvest-qa` may run without a person and file `bug` issues; `harvest` may run without a person but only proposes; a person approves. |
| **L4** | Maestro | PRD approval only | `harvest` files tickets and rule edits as pull requests; `reconcile-issue-map` runs on drift and proposes fixes; the factory feeds its own backlog. |

**What the owner wants is L3 as the destination and a path through L2.** L2 is the first level at which
"trigger and walk away" is literally true, and it needs no change to Orion. L3 is the first level at which the
owner's "fully built by agents" sentence is true for a whole PRD including its follow-ups. Which level v1
ships at is decision D3.

---

## 7. What exists today, in detail

Everything here was read from the code or the official documentation, not from design documents. File
references are to Maestro `main` at `22e5ee2` and Orion `main` at `22748fe`.

### 7.1 Samurai (Maestro)

**What it is.** A supervisor for one long-lived orchestrator agent per run, written in Rust under
`src-tauri/src/core/samurai_*.rs` (about 59k lines with tests) with a React launcher and badges.

**Launch surface** (`src/components/sidebar/LaunchSection.tsx`): one free-text box that accepts `#N` refs or
prose; a model picker from a hard-coded list showing weekly allowance left; a per-run handoff percent; a
skip-test-gate box; a launch-anyway-on-warnings box; a schedule-for-later field; a workflow graph editor.
Preflight rows: `gh_auth`, `usage_windows`, `allowance_headroom` (warn at 5h ≥ 78 or 7d ≥ 90, fail at
5h ≥ 90 or 7d ≥ 95), `duplicate_run`. A Rust-only test gate (`npm install`, build the MCP server crate,
`cargo test --workspace`) runs before the run config is written.

**Run identity.** The free text becomes a label (`issues #7, #9` or `<slug>-<hash>`), which names the
branch `<project-slug>-<epic-slug>`, the worktree under `<data>/worktrees/`, the run config under
`<data>/runs/<project>-<hash12>/<slug>.json`, the handoff files and the timers.

**Brief.** A gen-1 brief (`core/samurai_prompts.rs`, about 3k lines) that tells the orchestrator to read
issues with `gh --repo <pin>`, assess agent-readiness, plan, use small idempotent subagent commits, comment
progress, open one pull request with `Closes #N`, never touch another branch; then an ORDER contract (one
issue at a time), a WORKFLOW section compiled from a seven-step linear graph (implement, review, qa-report,
push, batch-review, batch-qa, batch-pr), a completion clause (`<samurai-run-complete>`), a prohibition on
local scheduling, the user text as untrusted data, and a journal rider. Briefs over 500 bytes are written to
`<worktree>/.maestro/briefs/` and delivered as a one-line "Read this file" pointer.

**How a session opens.** The backend never opens a terminal. It emits `samurai-spawn-successor`; the
frontend's pending-launch flow opens a grid slot, builds the CLI line with `--dangerously-skip-permissions`
and `--model`, registers the session as supervised before typing, and either puts the brief pointer on the
command line or lets the backend type it on `SessionStarted`. An open project tab is required; without one
the launch is lost and an ALERT is written.

**Supervision after launch.**

| Module | What it does today |
|---|---|
| `supervisor.rs` | per-session state machine: WORKING → HANDOFF_REQUESTED → HANDOFF_WRITTEN → KILLED; WORKING → PARK_REQUESTED → PARKED; any → DEAD. One in-flight instruction; handoff and park mutually exclusive. |
| `samurai_context.rs` | context percent per session derived from the transcript. |
| `samurai_injector.rs` | at `handoff_context_pct` (default 40), waits for the Stop hook (idle) and types the handoff instruction; ACK ladder; validates handoff file + WIP commit; also types wind-down and park instructions. |
| `samurai_replicator.rs` | kills gen-N after a validated handoff, stages gen-N+1, stages gen-1 and DEAD-recovery successors, emits spawn events, raises `successor_no_start`. |
| `allowance_watcher.rs` | polls an undocumented OAuth usage endpoint about every 60 s; edge-triggered soft/hard crossings; latches persisted in `samurai/latches.json`. |
| `samurai_parker.rs` | soft: wind-down instruction. hard: sequential park sweep, highest context first, one resume timer per epic at `resets_at + 5 min + jitter`. |
| `samurai_schedule.rs` | single `samurai/schedule.json`, 30 s tick, self-cleaning entries; also holds one-shot scheduled launches with 15-minute backoff up to 8 attempts. |
| `samurai_resumer.rs` | timer fire → fresh generation from the handoff if the config is still ACTIVE. Restored timers resume. |
| `samurai_watchdog.rs` | DEAD only when the transcript is stale (120 s) **and** no claude process is alive under the session's shell; chains to recovery. |
| `samurai_progress.rs` | circuit breaker: 5 agent audit rows with unchanged HEAD → park with a `parked` stamp; handoff churn detection. Commits are the only progress signal. |
| `samurai_completion.rs` | on `<samurai-run-complete>`, verifies PR and issue state via `gh`, flips ACTIVE → COMPLETED, tears the agent down. |
| `samurai_auth_watch.rs` | `gh auth status` every 5 min while anything is ACTIVE; loss → park with `gh_auth_lost`; return → resume. |
| `samurai_reconciler.rs` | cold start: for each ACTIVE config with no timer and no live session, ALERT only. **Never spawns.** |
| `samurai_audit.rs` | per-project JSONL under `<data>/audit/`, single writer task, rolls at 2 MiB keeping one previous generation; events SPAWN, HANDOFF, PARK, RESUME, COMPLETE, ALERT, INJECT, KILL. |
| `samurai_brief.rs`, `samurai_pty.rs` | brief file delivery; typed delivery in chunked frames with a scaled submit delay and a re-sent Enter. INJECT `receipt` is logged when the agent's Read tool names the brief; an unread brief gets one nudge after `ack_timeout_secs` (180), then the run goes fatal. |

**Configuration** (`samurai_config.rs`, Settings → Samurai Thresholds): handoff 40 %, soft 5h 78 %, hard
5h 90 %, hard 7d 95 %, ack timeout 180 s, max turn wait 1800 s, staleness 120 s, handoff retention 14 days,
breaker 5 events, size warning 5 MiB.

**Run config statuses:** ACTIVE, COMPLETED (verified, awaiting cleanup), ARCHIVED (Abandon keeps the work;
Clean up removes worktree and branch).

**Kinds of runs today:** epic/issues/prose run (supervised); scheduled launch (supervised once fired, and it
silently overrides preflight warnings); recover and resume-now (next generation of an existing run);
PR-review run from the Git tab (**not supervised**, no config, worktree, gate or preflight); harvest triage
(not supervised).

**Where the code says it is limited** (no literal TODO markers exist): the test gate is Rust-only; the
workflow graph is instruction only and nothing enforces it; commits are the only progress signal; scheduled
launches silently override warnings; a crash between config write and spawn leaves a run that reconciliation
flags and a human must relaunch; an unreadable run config cannot be cleared by Abandon or Cleanup; gen-1 and
successors need an open project tab; at the session cap a claimed launch is dropped; recover/resume double
staging is guarded only on the frontend; only the handoff percent is per run, park thresholds are global; the
model list is hard-coded.

**Where the Samurai PRD is stale** (`docs/samurai/prd.md`, code wins): it says cold start respawns live epics
(the reconciler only alerts); it says work lands on the `samurai` staging branch (that branch no longer
exists; everything is on `main` since PR #81); it describes repo/epic/model/threshold launcher fields (now
one free-text box); it has no test gate (one exists); it describes a two-section Second Brain (there are
three cards); it says harvest reports are listed in Files (they moved under the Journal card); it says journal
entries flip to consumed at injection (they go PENDING and settle at the next harvest); it says the audit log
is never trimmed (it rolls at 2 MiB); it does not mention PR-review runs or scheduled launches.

### 7.2 Second Brain (Maestro)

A right-side panel (`BrainCircuit` icon, no keyboard shortcut) stacking three cards in
`src/components/sidebar/SecondBrainSection.tsx`:

- **Audit** (`AuditSection.tsx`): tail of 200 rows for the active project merged with live events,
  clustered per run, with plain-language sentences for about 34 ALERT sub-kinds; clear with confirm.
- **Journal** (`JournalSection.tsx`): newest 50 ops-journal entries (categories BOTTLENECK, ERROR,
  IMPROVEMENT, SKILL, CONCERN; status UNCONSUMED, PENDING, CONSUMED, ARCHIVED), add form, delete per row,
  "Harvest now" which opens a real terminal in the project checkout and injects a triage prompt (brief file,
  up to 120 KB of entries) that runs `/insights`, saves `~/Downloads/maestro-harvest-insights-<date>.md`,
  reads it back and discusses keep/file/discard. Legacy headless reports under `<data>/harvest/` are listed
  here when any exist.
- **Files**: one collapsible card per group, backend-ordered (live first, then newest), groups being runs
  (`run:<project-hash>:<slug>`) and PR reviews (`pr:<owner/repo>#N`), "Account-wide" being a real run group.
  Kinds: BRIEF and HANDOFF (in the worktree's `.maestro/`), RUN_CONFIG and PR_REVIEW_RUN (`<data>/runs/`),
  TIMER (rows of `<data>/samurai/schedule.json`), AUDIT_LOG and JOURNAL (per-group slices of shared files).
  Actions: open (read-only viewer, 2 MB cap), show audit, clean this epic, cancel timer (two dialogs: resume
  now, or stay parked), delete (in-use refusal then a DANGER confirm which forces). `schedule.json` is never
  deletable.

**Health:** the only rule is file size ≥ 5 MiB, checked 30 s after start and every 3 minutes, shown as a
"Health — Second Brain" toast and as reason lines under the row. Because the audit log rolls at 2 MiB it can
never trip the default. No age rule, no in-use rule, dismissals not persisted. Startup sweeps remove handoffs
and briefs of ARCHIVED runs older than the retention days.

### 7.3 Orion (per-project framework, `nachogl1/orion`)

**What it is.** A bash installer (`orion.sh`, with a PowerShell launcher) that copies skills into a project's
`.claude/skills/`, one rules file into `.claude/orion/BASE_CLAUDE.md` which the project's `CLAUDE.md`
imports, a `config.json` (`updateMode`, `branchLimit`) and one `SessionStart` hook (`orion.sh check`) that
offers updates and the git clean-up. Skills carry an `.orion-managed` marker; the project's own skills are
never touched. The repository is public and distributable; its own rules forbid any project-specific data.

**The loop the skills form.** `/wayfinder` (loose idea → destination → decision tickets) → a PRD under
`docs/PRDs/` (approved by a person, never auto-created) → `/prd-to-tickets` (PRD → epics and stories built
for parallel work, with the person present; scaffold first, then contract stories, then fan-out; every story
names its `### Seam`; both blocker forms set; nothing filed `agent-ready` with a question left; drafts a UX
prototype in parallel when the PRD has screens) → `/dev-next` (the engine) → `/harvest-qa` and `/harvest`
(run by a person at thresholds) → `/reconcile-issue-map` (run by a person on drift). Side skills: `/dev-quick`
(a change with no ticket), `/issue-map` (blocked-by graph, rebuilt silently after every claim and merge),
`/clear-git-resources`, `/handoff`, `/project-handover`, `/generate-project-writeup`, `/orion`,
`/orion-verify`.

**`/dev-next` in detail** (`skills/dev-next/SKILL.md` and `references/`). Two touchpoints with a human: one
batch of questions at the start and a ten-line summary at the end. The run never waits for a person: anything
it cannot resolve is labelled `needs-human` with the reason as the last comment, released, and the run
carries on. Phases:

0. Preflight: tools and runtimes; questions to settle before the first story (asked as one batch, applied by
   this session on a `feat/` branch, then stop); gate commands known or stop; run id
   `<repo>-<yyyymmdd-hhmmss>-<4 hex>` in UTC; latest `main` fast-forwarded or stop; labels created; snapshot
   of everyone else's work; unlabelled issues put to the human in one batch; in-flight file created and this
   run's issue-less entry written.
1. Pick and claim: sibling-terminal stagger; eligibility (open, not epic, `agent-ready`, not `needs-human`,
   not `outside-change`, no assignee, no open `feat/N-*` pull request or remote branch, every blocker CLOSED
   in both forms); ranking (a `bug` that greens `main` first; an empty epic; clustered but not overlapping;
   pre-labelled before freshly labelled; lowest number); claim by assignee (the only atomic claim), then
   `in-progress`, then a claim comment, then the in-flight entry; re-read before and after.
2. Q&A: nothing asked for a pre-labelled story; a `ready-check-N` agent for a freshly labelled one; answers
   written under `## Decisions (agent-ready)`.
3. Develop: `git worktree add <wt root>/<N>-<slug> -b feat/<N>-<slug>`; per-issue resources from the issue
   number; `dev-N` (opus, high) with the brief in `references/dev-agent.md`; the orchestrator never writes
   application code. FAILED → `needs-human`, branch left for a human. INHERITED RED → one `bug` issue for
   `main`, story released without blame.
4. Review: a brand-new `review-N` (opus, xhigh) per round, never the author; findings rubric (small, safe and
   in a changed file → fix now; Critical → a GitHub issue; medium or high → the run's `deferred` list; low →
   nowhere); CHANGES REQUESTED goes back to the same `dev-N`; after the first APPROVED the confirming review
   is the last; three rounds → `needs-human`.
5. Merge: take the machine-wide `merging` slot in `<wt root>/in-flight.json`; merge `origin/main` in and
   push so CI runs on what lands; poll the check run (30-minute cap; "no checks reported" is red); squash
   merge; release the slot; verify the issue closed; delete worktree and branch; rebuild the issue map. Red
   after two rounds → `needs-human`.
6. Audit and report: `runs/<run id>/issue-<N>.json` and `qa-<N>.json` on the orphan branch `audit/<login>`
   (pushed directly, never merged); count the harvest pile (≥ 10 → `Harvest due`), the QA pile (≥ 5 →
   `QA due`), probe three drift signs (→ `Drift found`); print ten lines per issue.

Roles and models: orchestrator (opus, the user's effort), `ready-check-N` (sonnet, low), `dev-N` (opus,
high), `review-N` (opus, xhigh); an HTTP 429 steps a role one model down for the rest of the run.
Parallelism: up to four stories per run, each with its own worktree, branch and agents; no cap on agents
alive; merges serialised machine-wide through the in-flight file; one failure never takes down the others.

**The audit record** (`references/audit.md`): per issue, `run_id`, `issue`, `title`, `login`, `started_at`,
`finished_at`, `outcome` (`merged`, `needs-human`, `failed`, `inherited-red`), `pr`, `summary`, `agents[]`
(name, model, `tokens_total`), `phases` (qa, dev, review, ci seconds), `rounds` (review, ci), `friction[]`,
`lessons_learned[]`, `deferred[]` (severity, area, what, why, owner). The bar for the three lists is
important or critical only; empty lists are the normal outcome. A merged story also leaves `qa-<N>.json`:
seam, a user-level story, and `checks[]` (key, criterion, steps, expected) that `/harvest-qa` drives against
`main`. Token figures exclude cache reads and the orchestrator; they are relative, not a bill.

**The in-flight file** (`references/in-flight.md`): one per machine, beside the worktrees, never committed;
`issues[]` (issue, run, startedAt) and `merging` (issue, run, since); stale after 4 hours (issues) or 30
minutes (merging, refreshed on every CI poll); write whole, re-read after writing, re-check ownership before
the merge command. Documented residual: two machines are serialised by GitHub alone.

**Rules that bind every project** (`baselines/BASE_CLAUDE.md`), the ones that matter to a factory: GitHub
Issues are the only source of truth; the assignee owns the issue; blocked means blocked in either form; epic
→ story is a native sub-issue; every story names a seam; the PRD is the north star and is never created
automatically; every reversible decision is taken by the agent, only an irreversible one becomes
`needs-human`; never push to `main`; only `/dev-next` merges its own pull requests, every other pull request
is merged by a human; squash-merge then delete the branch; work in a worktree outside the project; never
rebase, stash, force-push or bypass hooks; never merge on red or pending; full build and suite green before a
pull request opens, run for real; never delete, skip or weaken a test; a fresh agent reviews every pull
request; one pile for deferred findings; `/harvest`, `/harvest-qa` and `/reconcile-issue-map` are run by a
person, never by another skill; sub-agents are named after what they do, mechanical work on a cheap model,
decisions and reviews on the top model.

**What the project's `CLAUDE.md` must state** (the slots Orion seeds): commands (build, full suite, one
file, one test, typecheck, lint, deterministic checks, dev server); stack and layout; worktree root and port
rule; boundaries (deploy target, external read-only repositories, sensitive data classes, boundaries an
agent must not move, working language); questions pending until PRD v1.

### 7.4 The Maestro MCP server and status server

`maestro-mcp-server` exposes one tool, `maestro_status`, which POSTs to Maestro's local status server. The
status server (`src-tauri/src/core/status_server.rs`) receives that and the Claude Code hooks
(`session-start`, `session-end`, `pre-tool`, `post-tool`, `stop`, `notification`, `user-prompt`), each
guarded by a per-instance secret header. There is no surface through which an agent can ask Maestro for
anything.

### 7.5 Maestro itself

Maestro has no `.claude/` folder and no Orion installed. Its `AGENTS.md` carries its own working rules
(build, test, lint commands; a changelog rule; a seven-step development workflow). Its PRDs live in
`docs/PRDs/`. The Samurai PRD lives apart in `docs/samurai/`.

### 7.6 What Claude Code and the Agent SDK offer today (verified 2026-10-15)

Facts, not choices. Flags and URLs are in the companion capability inventory in the design notes; the
headline facts are:

- **Structured headless sessions exist.** `claude -p` with `--input-format stream-json` and
  `--output-format stream-json` is a bidirectional, machine-readable session. The Agent SDK (TypeScript and
  Python) wraps the same with streaming input, `interrupt()`, `getContextUsage()`, `maxTurns`,
  `maxBudgetUsd`, hooks and a `canUseTool` callback. Result subtypes name success, max turns, max budget and
  execution error. Everything Samurai does by typing into a PTY and watching for an ACK has a structured
  equivalent.
- **Hooks are rich.** 33 events including `SessionStart`, `Stop`, `SubagentStart`, `SubagentStop`,
  `PreCompact`, `PostCompact`, `WorktreeCreate`, `PreToolUse`, `PostToolUse`. A hook can be an `http` POST
  to a URL. A `Stop` hook can keep a session working (capped at 8 continuations). A `PreToolUse` hook in
  `-p` mode can return `defer`: the turn ends with `stop_reason: "tool_deferred"` and can be resumed later
  with the answer. `additionalContext` injects a system reminder, never a user message.
- **Sessions persist and resume.** Transcripts under `~/.claude/projects/`, 30-day retention by default;
  `--resume`, `--continue`, `--fork-session`, `--session-id`; a crash restores history and flags a cut-off
  tool call for verification. `--mcp-config`, `--settings` and `--add-dir` are not restored on resume.
- **Context is observable.** Statusline JSON carries `context_window.used_percentage`; the SDK exposes it
  directly. Auto-compaction has a configurable window; `PreCompact` and `PostCompact` fire around it.
- **Subagents:** `.claude/agents/*.md` or `--agents` JSON; 20 concurrent, 3 levels deep; per-agent model,
  tools, effort, worktree isolation.
- **Scheduling exists but is not a supervisor.** Session cron tasks fire only while idle (7-day expiry).
  Routines run in the cloud on a schedule (minimum one hour) or on an API call, one fresh session each. Cloud
  sessions keep running when the laptop closes, with an undocumented duration limit. `claude --bg`
  background sessions survive a closed terminal and sleep, not a reboot. Dynamic workflows orchestrate
  subagents in one session and pause on a usage limit. None of these is a loop that relaunches work for
  days.
- **Subscription quota is not an API.** The 5h and 7d windows appear only in the statusline JSON for Pro
  and Max. `--max-budget-usd` is a client-side estimate that resets on resume. Samurai's usage endpoint is
  undocumented.
- **Updates can be pinned.** `DISABLE_UPDATES=1` blocks CLI updates; the Maestro app updates itself from
  every push to `main` through the release workflow, and the owner has chosen not to suppress that.
- **Managed Agents** (platform API, beta) run server-side with hard dollar budgets, outcome rubrics,
  scheduled deployments and multiagent rosters. They bill at API rates rather than against a subscription,
  do not read `.claude/`, and run in Anthropic's sandbox unless self-hosted.

---

## 8. Gaps between today and the intent

| Gap | Today | Wanted |
|---|---|---|
| Nothing triggers the next unit of work | a person types or clicks | Maestro keeps the backlog moving until no story is eligible (G1) |
| Human decisions arrive mid-run | preflight checks four things; everything else surfaces as an ALERT or a `needs-human` during the run | one readiness list before the run, red lines as tasks (G3) |
| Harness and process are strangers | Samurai carries its own workflow text; Orion does not know Maestro exists | Maestro drives Orion skills; Orion is the only workflow (G5) |
| Recovery is manual | Recover and Resume now buttons; `/dev-next #N` by hand | automatic for allowance, crash, auth loss, red main, restart (G4) |
| Unit of work mismatch | Samurai: one orchestrator for days; Orion: one run of up to four stories | one definition, chosen in the PRD (D1) |
| Blind control of sessions | typing into a PTY with idle gates, ACKs, brief files, receipts | structured control, available in Claude Code today (D8) |
| Two audits, no join | Orion JSON per story on `audit/<login>`; Samurai JSONL per project | one job view down to the story, both sources joined (G6) |
| No agent → Maestro channel | one status tool | a chain of command (G7) |
| Merge queue is a file | `in-flight.json` per machine, documented races | a queue the factory owns, still honouring Orion's rules |
| Maestro does not dogfood | no Orion on Maestro | Orion installed, Maestro built by its factory (G9) |
| Second Brain shows files | handoffs, briefs, timers, slices | the job: moved, in flight, waiting on you, cost (G10) |
| Subscription quota is read from an undocumented endpoint | works today, may break silently | a documented or at least observable source, with a safe fallback |

---

## 9. What can go wrong, and the outcome wanted

Requirements, not solutions. For each: what the owner wants to be true afterwards.

| Failure | Outcome wanted |
|---|---|
| Allowance exhausted mid-run | work winds down before the hard line, parks at a safe point, resumes at reset without a human; the audit shows both |
| Context window fills during one story | the story is finished or handed over without quality loss; the ticket size is reported as the root cause if it recurs |
| Session crashes silently | detected within minutes; the claimed stories are restarted the Orion way; the owner is told afterwards |
| `gh` login expires | work parks; resumes when the login returns; one notification |
| `main` is red before a story starts | the story is released without blame; one `bug` issue; the bug is built first; the story is retried; no human needed unless the bug is `needs-human` |
| Two sessions want to merge at once | exactly one merges at a time on the whole machine; CI ran on the `main` the branch lands on |
| Two sessions claim the same story | the earlier claim wins; the later one backs off silently; no story is built twice |
| A review loop never converges | three rounds then `needs-human`; the owner sees the three verdicts |
| CI never reports | treated as red; the story waits or goes `needs-human`; never merged |
| A brief or instruction is not read by the agent | the factory knows within the ACK window and corrects once, then stops the story |
| Maestro restarts (self-update, reboot) | active jobs re-arm themselves; nothing is started that the owner did not start; nothing is lost |
| A story is vaguer than it looked | `ready-check` questions or `needs-human`; never hours of guessing |
| The `needs-human` pile grows while the owner is away | the job is visibly waiting on the owner with a list; one notification, not one per story |
| Tokens burn with no commits | the circuit breaker parks the story and the owner is told why |
| PRD and issues drift | the drift is visible in the job view; at L4 a reconcile is proposed |
| Orion changes | the factory follows without a Maestro release; if it cannot, the readiness check says so |
| The usage endpoint stops working | the factory degrades to a safe mode (no new claims, no parks) and says so rather than failing silently |
| A story touches a repository the team does not own | never built autonomously; `outside-change` plus `needs-human` |
| The owner changes a rule in `CLAUDE.md` mid-job | the next run reads it; the current run finishes its atomic step on the old rule |

---

## 10. Principles the PRD must keep

1. **Orion rules are key.** Every rule in `BASE_CLAUDE.md` holds inside the factory. A factory feature that
   needs a rule to bend is a change request to Orion first, with the owner's decision, not a Maestro
   workaround.
2. **Maestro never carries workflow text.** The factory invokes skills. If a step is wrong, the fix is in
   Orion.
3. **GitHub is the only source of truth for work.** Maestro keeps state about jobs and sessions, never about
   what a story is or whether it is done.
4. **Human attention is spent at the start.** Everything that can be known before the run is asked before
   the run, once, in one place.
5. **Every intervention is recorded.** A park, a restart, an injected instruction, a human answer: one audit
   row each, visible in the job.
6. **Audits of runs are audits of `/dev-next`.** The Orion run report is the primary record; Maestro's
   supervision events annotate it. Nothing is reconstructed later from transcripts.
7. **Orion stays distributable and Maestro stays optional.** A project with Orion and no Maestro keeps
   working by hand. Any Maestro-aware behaviour in Orion is additive and falls back to today's files.
8. **Fail loud, recover quiet.** Recoveries happen without asking. Failures that need a person are one
   notification and one list.

---

## 11. Open decisions (to be taken before the PRD, not in it)

Listed neutrally, with the trade-off each way. A recommendation is marked where the author has one; it is a
recommendation and not a decision.

| # | Decision | Options and trade-offs |
|---|---|---|
| D1 | Unit of autonomy | (a) one `/dev-next` run, relaunched until the backlog is empty: short, restartable, matches Orion, more session starts, parallelism capped at four per run. (b) a days-long orchestrator as Samurai does: fewer starts, needs the full handoff and replication machinery, its own workflow text, and diverges from Orion. Recommended: (a). |
| D2 | What to do with Samurai | (a) keep the supervision backend, drop the launcher, the run-config concept, the prompt text and the Second Brain. (b) remove everything and rebuild. (c) keep everything and add the factory beside it. Recommended: (a). |
| D3 | Target level for v1 | L2 needs no Orion change and already means "trigger and walk away". L3 needs Orion to let `harvest-qa` and `harvest` run without a person. Recommended: L2 shipped, L3 as the next PRD. |
| D4 | Chain of command surface | (a) extend the existing MCP server (agents already load it, one secret, local only). (b) HTTP from hooks only. (c) both. Recommended: (a). |
| D5 | Where the specification lives and who approves it | `docs/PRDs/PRD<Name>.md` in Maestro, approved by the owner before any ticket, per Orion's own rule. `docs/samurai/prd.md` marked historical. |
| D6 | Machines | (a) one Windows machine, one login, as today: the merge queue stays machine-wide. (b) several machines or a cloud runner from the start: the queue and the in-flight picture must be shared. Needs a fact from the owner. |
| D7 | Dogfooding | install Orion on Maestro before the pilot, or pilot on another project first. Recommended: install first; the readiness gaps found on Maestro are the ones every project will hit. |
| D8 | Worker transport | (a) headless structured sessions driven from Maestro's Rust backend over stdio, rendered as a log pane, PTY kept for human-attended sessions. (b) PTY terminals with injection as today. (c) the Agent SDK through a sidecar process. (a) removes the blind-typing machinery; (b) keeps the eagle view for workers and every fragile mechanism; (c) is the richest API and adds a runtime. Recommended: (a). |
| D9 | Pilot project | the owner has named "Vigil" and "DaVinci". Neither is a repository in the owner's GitHub account as seen from this session. Needs a fact from the owner. |
| D10 | Harvest at L3 | when `harvest` runs without a person, does it file tickets, propose a batch for approval, or only write a report. This is an Orion rule change and the owner's call. |

Questions the owner is asked to answer alongside the decisions: what "SOM" means in "PRD, tickets and SOM";
whether "L3" is meant as a level in the ladder of section 6 or as the generation name, or both.

---

## 12. Success criteria for the eventual PRD

The PRD that follows this document is complete when it can answer, with acceptance criteria:

- How a job is created, what the readiness list contains, and what "green" means for each line.
- What one unit of work is, how it is started, how its end is detected, and how the next one is chosen.
- Which Orion skills the factory invokes, with which arguments, at which level.
- How each failure in section 9 is detected, what the factory does, and what the owner sees.
- What the chain-of-command surface offers in each direction, and how Orion uses it with a fallback.
- What the job view shows and what the audit record contains per job, run and story.
- What of Samurai and the Second Brain is removed, what is kept, and in which order.
- How Maestro is built by its own factory from that point on.

---

## 13. Glossary

- **Factory, job, run, story.** A *job* is one project under the factory. A *run* is one invocation of an
  Orion skill by the factory. A *story* is one GitHub issue labelled `story`.
- **Readiness list.** The pre-run checklist of human decisions and project facts.
- **Harness.** Maestro's role: trigger, supervise, heal, audit, report.
- **Process.** Orion's role: what to do, in what order, under which rules.
- **Chain of command.** The defined surface through which agents and Maestro talk.
- **Level (L0 to L4).** Section 6.
- **Park, resume, handoff, generation, allowance window, circuit breaker.** As in `docs/samurai/prd.md`
  section 2; the mechanisms exist and are listed in section 7.1 here.

## 14. References

- `docs/samurai/prd.md` — Samurai v1 design (historical; code wins where they differ, section 7.1).
- `src-tauri/src/core/samurai_*.rs`, `src-tauri/src/commands/samurai.rs`, `src/components/sidebar/LaunchSection.tsx`, `src/components/sidebar/SecondBrainSection.tsx` — the code described in 7.1 and 7.2.
- `nachogl1/orion`: `README.md`, `baselines/BASE_CLAUDE.md`, `skills/dev-next/SKILL.md` and `references/`, `skills/prd-to-tickets/SKILL.md` — the process described in 7.3.
- Claude Code documentation under `code.claude.com/docs` (headless, hooks, sessions, context window, sub-agents, scheduled tasks, routines, agent view, remote control, workflows, costs, setup) and the Agent SDK pages; Managed Agents under `platform.claude.com/docs` — the facts in 7.6.
