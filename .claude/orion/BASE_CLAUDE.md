# BASE_CLAUDE.md — mandatory rules shipped by orion

> **Owned by orion.** `orion init` copies this file to `.claude/orion/BASE_CLAUDE.md` and every `orion update`
> overwrites it there. Never edit the copy: a change to these rules is a pull request to orion.
>
> **The project's `CLAUDE.md` imports this file and adds the project's own facts and rules** (what it must state is
> listed at the end). **The two must never contradict each other**: before writing or changing a rule in the project's
> `CLAUDE.md`, check it against this file; after every `orion update` that changed this file, re-read the project's
> `CLAUDE.md` for new conflicts and fix them in the same commit. If a contradiction slips through anyway, this file wins.
>
> **A person's own rules file (their user-level `CLAUDE.md`) is different: when it contradicts this file, neither wins
> silently.** With the person present, name the clash (quote both rules and say where each lives) and offer to fix
> it for good: edit their own file, or open a pull request to orion for this one (never the copy); follow their
> choice. In a run nobody is watching (`/dev-next`), never stop to ask: follow this file and add the clash to the
> `friction` list of the run's report.

## Communication

- TLDR first, after any problem. One-liners. Numbered steps, one action per line. End with exactly one next action.
- Several topics become one line each, never casualties.
- Never refer to a thing by its number alone — `issue #12 (parse the dataset section)`, never a bare `#12`. A pull
  request is named by the issue it serves: `the pull request for issue #12 (parse the dataset section)`, never
  `PR #47` alone; one with no issue says what it changes.
- No preamble, no recap, no sign-off. Problems (bugs, risks, failures) come first and are never cut for length.
- Never guess. Check the code, the docs or the running command before stating something; label assumptions as such.
- **Accuracy beats brevity, brevity beats shape.** A fact, a caveat or an admitted failure is never cut to fit a
  format: it becomes a shorter line. Something critical (data loss, security, a broken release, a wrong decision about
  to be made) gets as many words as it needs.
- Shape the reply to its job. A report: the problems, then the result, no choices. A decision (only one you may not
  take yourself): the problems, up to three options each with its downside, then your pick and why in one sentence,
  asked as the clickable-options list below. An answer to a question: the answer first, then any problem the person
  must know — the one case where problems come second.
- Full, correct sentences in plain, everyday words — no telegraph style, no arrows for verbs. Jargon gets a
  two-to-four word explanation in brackets on first use.
- While work is in flight (agents out, steps running, something blocked), each reply carries one status line: what is
  done, what is in progress, what is blocked and on whom. A win is said plainly and concretely (`suite green, 62/62`);
  an error is matter-of-fact: what broke, why, and the fix.
- Radical candor: care personally, challenge directly. No flattery, no sugar-coating; a bad idea is called a bad idea,
  with the reason.
- When you need the person's answer, ask questions as one list with clickable options (the AskUserQuestion tool):
  distinct options per question, the recommended one marked. Word every question and option for a junior developer
  who knows neither the stack nor the business: plain words, every term of jargon or acronym explained on first use.

## Work tracking

- **GitHub Issues in the project's own repository are the only source of truth.** PRD → epic → story:
  `/prd-to-tickets` cuts a PRD into epics and stories built for parallel work (scaffold → contract stories →
  fan-out). Agents implement **stories** only, never an epic. (`/prd-to-tickets`, `/dev-next`, `/dev-quick`,
  `/harvest`, `/harvest-qa`, `/issue-map`, `/reconcile-issue-map` and `/wayfinder` drive GitHub Issues and nothing
  else.)
- **The assignee owns the issue.** Assign yourself *before* writing any code. Never work on, edit or unassign someone
  else's. Two claims can land in the same second, so re-read after claiming: a second assignee, or an earlier
  "claimed by run …" comment from another run, means the earlier claim wins. The later run deletes its claim comment,
  drops its in-flight entry, unassigns itself only when the other assignee is a different login (two of your own
  terminals share one assignee, which stays), and takes the next issue.
- **Blocked means blocked in either place.** An issue waits until every blocker is CLOSED — not "nearly done" —
  whether listed under a `### Blocked by` heading in the body or set as GitHub's native "blocked by" relation.
  Whoever writes a ticket sets **both**: the native relation for people, the body section for agents.
- **Epic → story is a native GitHub sub-issue**, never a plain text list.
- **Every story names the folder or module it owns** under `### Seam`, so two stories on one folder are spotted
  before they collide (merged into one, or one blocks the other).
- **Every new issue, whoever files it and however it comes up, follows
  `.claude/skills/dev-next/references/new-issue.md`**: body headings, labels, the native parent and blocking links
  with their read-back checks. A person writing a ticket by hand follows the same file; there is no separate issue
  template to keep in step. **An agent asked in chat to file a bug or open a ticket, with no skill running, is no
  exception**: it reads `new-issue.md` before its first `gh issue create`, files to that shape (`story` plus exactly
  one readiness label, `agent-ready`, `needs-human` or `outside-change` with `needs-human`; one tier label,
  `tier:bug` for a defect, else `tier:manual`; `bug` when it reports a defect; the native epic link and both blocker
  forms) and reads the labels back as `new-issue.md` says. **Never run `gh issue create` without those labels**: an
  issue with no readiness label is never taken by `/dev-next`, sits on the issue map as a yellow box with no owner
  and no epic, and is lost to the workflow. When the person did not say who takes it, ask once with clickable
  options, `needs-human` recommended because nobody has yet checked that nothing is left to ask. When no epic fits,
  ask which one; a story never hangs loose. Filing a ticket is not a request to build it: offer `/dev-quick` only
  when the person wants the change made now. **A change wanted now that has no ticket goes through `/dev-quick`**:
  it files the issue to that shape and hands it to `/dev-next` — never built by hand in the chat. **When the person
  asks for a code change in chat without starting a skill, ask once whether to ship it with `/dev-quick`** (only
  when `.claude/skills/dev-quick/` is installed and no gate command reads `TBD`): yes runs it end to end, merging on
  green with no further questions (it interviews only when the request is unclear); no means no change is made, by
  hand or otherwise.
- **An issue filed while working on another is tied to where it came from**: the pull request in hand links the new
  issue, and the new issue names that pull request (or the issue, if no pull request is open yet) under
  `### References`.
- **Read an issue only with `gh issue view <N> --json title,body,labels,comments`.** Shorter forms drop the body.
- Labels: `epic` `story` `agent-ready` `needs-human` `in-progress` `outside-change` `bug`, plus the `wayfinder:*` set
  the planning skill owns and the `tier:*` set. `/dev-next` creates any of the seven that are missing in its preflight.
  - `tier:*`: what a story is for, so anyone reading the list sees it. Every story carries exactly one; an epic never
    does. A story cut from a PRD takes the tier the PRD gives that work (`tier:mvp`, `tier:stretch`,
    `tier:stretch-2`); any other names where it came from (`tier:bug`, `tier:dev-quick`, …; the full list is in
    `new-issue.md`). Whoever files the story creates a missing tier label. **Nothing picks or orders work by tier.**
  - `wayfinder:*`: a planning ticket, never a story. `/dev-next` never takes an issue carrying one, and the drift
    checks (`/dev-next`'s probe, `/reconcile-issue-map`) leave such issues out.
  - `agent-ready`: nothing is left to ask. An agent claims it, builds it, gets a fresh-agent review and merges with no
    human. **An issue with none of `agent-ready`, `needs-human` or `outside-change` is not taken automatically**:
    `/dev-next` stops in preflight and asks the human what it is. A label given then earns one ready-check before
    building.
  - `needs-human`: a person must act or decide first, then flips it to `agent-ready` — or the ticket is human-only
    work for good. The reason is the issue's **last comment**. Labelling `needs-human` removes `agent-ready`; the two
    never sit together.
  - **`outside-change`: the work touches a repository this team does not own. It never runs autonomously and always
    ends at a pull request for that repository's own reviewer.** It always also carries `needs-human`, so one filter
    catches every issue an agent must not take. The issue names the external work item under `### External reference`
    and the pull request title carries it.

## Standing decisions — never ask about these

**The PRD is the north star for what we build.** Every product fact — vocabulary, scope, the do-not-build list, the
acceptance bar, the build decisions — is read from `docs/PRDs/PRD.md` (every PRD under `docs/PRDs/`, if more than
one), never restated in a rules file. Until PRD v1 exists the pre-PRDs there stand in. **Disagreement is a bug**: the
PRD wins on product, the rules files win on process.

- **Three sizes of change, three kinds of record.**
  - **A fix or a tweak:** no document.
  - **A hard-to-reverse decision** (a new mechanism, a format, a dependency, a change of scope: something costly to
    undo, or that a later reader will ask "why?" about) gets an **ADR** (a short decision record: context, decision,
    consequences, alternatives) at `docs/ADRs/adr-<change-name>.md`. The agent proposes it and the person confirms
    one is needed; the person approves the ADR before any ticket or code for that change exists.
  - **A big change or a product update:** the agent only asks whether the person wants a PRD. Creating or updating a
    PRD is the person's process, on their terms — planned with `/wayfinder`, then written or provided by the person.
    **An agent never drafts a PRD on its own.**
- **No real production data in the repository.** The project's `CLAUDE.md` names the sensitive data classes. Synthetic
  or de-identified fixtures only. **No personal data anywhere** — not in prompts, logs, tests, fixtures, issues or git
  history — and never run anything against production.
- **Secrets only in `.env`** (gitignored; `.env.example` lists the names). Never in code, issues, pull requests or
  committed files. A committed secret is rotated by its owner, not just deleted: git history keeps it.
- **A boundary the project's `CLAUDE.md` draws is never moved by an agent.**
- **A repository the project's `CLAUDE.md` lists as external is read-only from here.** Never build it, run it, commit
  to it or change its git state. A change that must land there is an `outside-change` issue: it stops at a pull
  request its own reviewer merges.
- **Never change another project without asking first.** This project, its worktrees and their root are the only
  projects an agent changes on its own: any other repository or project folder, even one on the same computer, is
  edited, committed to or pushed to only after the person says yes to that change, and one listed as external stays
  read-only even then (rule above). Reading it is fine, and so is a file a skill is built to write elsewhere (a
  report in `~/Downloads`). In a run nobody is watching, the answer is no.
- **If the project calls an AI model, the model provider sits behind one swappable interface.** Tests never reach
  the network; a test that needs the model mocks the interface. No API key is ever committed or written into an
  issue.
- **The project deploys only to the place its `CLAUDE.md` names, from `main`.** No other hosting unless the PRD
  names it.
- **No meeting recordings, transcripts or notes exports in the repository, ever** — they carry personal data. What a
  meeting decided goes onto the ticket it concerns, as a comment in the participant's own words.
- **Code, comments, commits, issues and docs in the language the project's `CLAUDE.md` names.**
- **Front-end development is led by the UX prototype in `docs/ux/prototypes/`.** A story that adds or changes a
  screen implements the prototype's screen, never a layout of its own, and names that screen under `### References`;
  a screen the prototype lacks is a UX change first (pull request on `docs/ux/prototypes/`), then a story. The
  prototype exists before any front-end story starts: the user provides it, or `/prd-to-tickets` drafts one from the
  PRD in parallel with the split (a pull request a human merges) and blocks every front-end story on it until it is
  on `main`.
- **Take every reversible decision yourself** — simplest option that meets the acceptance criteria, recorded in the
  pull request. Only a genuinely irreversible one becomes `needs-human`. A run that waits costs money doing nothing.
- **Two sources of truth, kept in step.** Issues track the work; the PRD holds the product. In a session with a person
  present — planning, harvest, hand-written tickets — after the batch of ticket creations or edits ask once:
  **"Should we update the PRD with this too?"**, one line per change naming the PRD section it touches. "No" ends it;
  "yes" ships the PRD edit in the pull request the work already has, or in a `docs(prd)` pull request when the work
  was only tickets. The dev skill's mechanical writes — labels, claim comments, `## Decisions (agent-ready)`,
  `Critical:` issues, closing — never trigger the question, nor does `/dev-quick`'s fast path, which runs only when
  nothing the PRD describes changes.

## Git

- **NEVER push to `main`.** Not a fix, not a typo, not "only a doc". Every change reaches `main` as a merged pull
  request from a `feat/<desc>` / `fix/<desc>` branch (or the project's own branch pattern). Nothing but you enforces
  this where branch protection is off.
- **Who merges.** `/dev-next` merges its own pull requests on its own (a `/dev-quick` run merges through it,
  nothing else), and only once the project's build and test commands are filled in. Every other pull request —
  planning, scaffolding, documentation, anything outside the dev skill — is merged by a human, or by the agent on
  the person's explicit word to merge that one pull request, once its checks are green. Never auto-merge beyond
  that, and never merge an `outside-change` pull request: its repository's own reviewer does.
- **Squash-merge only, then delete the branch** (`--delete-branch` breaks on a worktree; see
  `.claude/skills/dev-next/references/merge-and-ci.md`). One commit on `main` per pull request.
- **Work in a worktree on `feat/<slug>` or `fix/<slug>`** (`feat/<issue>-<slug>` when the branch serves one
  issue). A pull request may cover one issue or several related ones. Never work in the main checkout. **One exemption:** the
  per-developer branch `audit/<login>` that `/dev-next` writes run reports to is pushed directly, has no pull request
  and never merges into `main` (`.claude/skills/dev-next/references/audit.md`).
- Worktrees live **outside the project**, at the root the project's `CLAUDE.md` names. The in-flight file
  (`<worktree root>/in-flight.json`, never committed) lives beside them; format in
  `.claude/skills/dev-next/references/in-flight.md`.
- Update a branch with `git merge origin/main` — **never rebase, never stash**. Never force-push unless the person
  explicitly asks for that push, never bypass hooks (`--no-verify`), never `git add -A`, never rebase or stash
  someone else's work, never delete work you did not create.
- Never merge on red or pending checks; "no checks reported" counts as red — poll for the check run first, the host can
  take minutes.
- **Leave nothing behind.** A merged branch is deleted, locally and on the remote; a worktree whose work landed is
  removed. What slips through (a failed run, a pull request a human merged) is swept by `/clear-git-resources`, which
  the session-start hook offers once a day when the project reaches its branch limit (local plus remote branches) or
  its worktree limit (`branchLimit` / `worktreeLimit` in `.claude/orion/config.json`, 20 each by default, a number or
  `off`). Each stale item is yours or someone else's: yours when the first commit on its branch that is not on `main`
  carries your `git config user.email`.
  - **Deleted without asking:** your items whose work is already safe (on `main`, pull request merged, a clean
    checkout whose commit a branch holds, a dead worktree entry, an old loose file in the worktree root).
  - **Asked first:** anyone else's stale item or one with no commits of its own, yours whose pull request closed
    unmerged or whose remote branch is gone, a locked worktree, and an old leftover folder in the worktree root.
  - **Never touched:** unmerged commits, commits on no branch, uncommitted changes, `main`, the `audit/*` and `qa/*` branches, the `audit-*`
    and `qa-*` worktrees, an open pull request, anything in flight, other repositories' checkouts.
- **Every session starts up to date.** The session-start hook runs `git pull --ff-only` (only moves the branch forward,
  never makes a merge commit) on the branch the session opens in. It is skipped when the branch has no remote copy. A
  refused pull (the branch went its own way, or local changes block it) is reported in one line and never forced.
- Conventional Commits: `type(scope): summary`.

## Definition of done

- **Full build and full suite green before the pull request opens, run for real** — reading the code is not proof.
  Every new behaviour has a test.
- **Test first, then clean code.** Every new behaviour starts as a failing test, then gets the smallest code that
  makes it pass, then is refactored with the suite green. Clean code: names that say what a thing does, small units
  with one job each, no dead or commented-out code, no magic values (an unexplained number or string); follow the
  idiom of the code around it.
- **Every new test earns its place.** It checks behaviour a user or caller relies on, through the public way in, never
  the internals; it fails if that behaviour breaks; it repeats no other test (the same behaviour over several inputs is
  one test over a list of inputs); it never tests a library, trivial code or the test's own mocks. The number of tests
  follows the story: a few per acceptance criterion plus its edge cases, never dozens.
- **Never delete, skip or weaken a test. Never widen a timeout to make a run pass. The skip count is baselined; a
  change to it fails.**
- **Pre-existing failures are still your responsibility:** fix them or surface them explicitly and get an
  acknowledgement. Never "those were already failing".
- **When something fails twice, stop and find the root cause** instead of retrying.
- **The gate, before any pull request opens:** build → lint → typecheck → full suite, with exactly the commands the
  project's `CLAUDE.md` lists (the same chain as CI). A command still reading `TBD` means the stack decision has not
  landed and `/dev-next` cannot run.
- **If the project produces generated output, it is gated by evaluation, not by a passing build.** The project's
  `CLAUDE.md` names the deterministic checks, the evaluation harness and its baselined threshold. A run that cannot
  execute the evaluation is **red**, never "not applicable".
- The pull request body carries the **evidence table** — what you did, what you expected, what you saw. A green suite
  alone is *not* evidence that the output works for its user.
- A **fresh agent** reviews every pull request — never the one that wrote the code.
- **The suite runs once per gate, never twice.** If CI runs the full suite, its result is the evidence: on the pull
  request for the reviewer, on the merged branch for the merge. If not, the reviewer runs it in the worktree and the
  merge runs it on the merged branch. Never both.
- **A story that changes user-visible behaviour updates the run-book** (`docs/runbook.md`) in the same pull request.
- **Every pull request adds its own changelog file**, `docs/changelog/<YYYY-MM-DD>-<branch>.md` (the day it is
  written, the branch name with `/` turned into `-`), so pull requests merged at the same time never touch the same
  file and never conflict; never edit another pull request's file or an old single-file changelog, which stays as the
  history before the folder. Newest first is the names sorted in reverse (by the day written; the folder's
  `README.md` is not an entry). The file holds one line saying what changed and why it matters, nothing more. No
  prose, no restating the diff, no entry that only repeats another one. A pull request that changes nothing a reader of the changelog would care about (typo, CI
  plumbing) still gets its line, kept to a few words.

## Working

- **Invoking a skill is the go:** a person who starts a skill authorises everything that skill's own rules let it
  do, end to end, and the go ends with that run. No skill overrides the Git or Definition of done rules: never push
  to `main`, never merge on red or pending checks, never skip hooks, never force-push without the person's explicit
  word for that push.
- **Smallest change that works:** what was asked and no more. No refactors of untouched code, no speculative
  abstractions. **Stay on the issue you claimed.** A side-fix belongs in the pull request only if it is small, safe
  **and** in a file you are already changing.
- **Deferred findings:** small, safe **and** in a file already being changed → fix now. Critical → a GitHub issue,
  linked from the pull request. Everything else goes to the run's report, written once, never filed "to be safe": a
  backlog nobody drains is worse than no backlog. Before filing any issue, search the code and the open issues for
  something that already covers it; never defer to a **closed** issue.
- **One pile.** Every `/dev-next` story ends with one report file for that run, pushed to `audit/<login>` — a
  per-developer branch that collects reports and never merges into `main`. Each report has three lists: product
  problems left for later, things that slowed the run down, and tips for the next run. Reports are named by date and
  time, so they sort in order.
- **Harvesting.** `/harvest` is run by a person, never by another skill. A bookmark file on `main` records, per
  developer, the newest report already harvested; the harvest reads only newer reports, works through them with the
  human one item at a time, then moves the mark forward and ships it in its own pull request together with any
  tickets or rule edits it made. It groups items touching the same area into one ticket (the fewer the better) and
  drops an item only when the human says so. `/dev-next` only counts: at **10 unharvested items** it ends its run
  with `Harvest due: run /harvest`.
- **QA, later and on `main`.** Nobody drives the product during a story's review. Instead every merged story leaves a
  QA record beside its run report on `audit/<login>`: the user-level checks for its acceptance criteria and a short
  story of what it changed. `/harvest-qa` is run by a person, never by another skill: it reads the records newer than
  its own bookmark on `main`, drops the ones a later story superseded or made obsolete, drives the rest against `main`
  one agent at a time, shows the person each confirmed failure with its importance and files a `bug` issue only for
  the ones the person chooses, and ships its log in its own pull request. A deduped record counts as tested. `/harvest` and `/harvest-qa` never read each other's files.
  `/dev-next` only counts: at **5 untested records** it ends its run with `QA due: run /harvest-qa`.
- **Reconciling.** `/reconcile-issue-map` is run by a person, never by another skill. It reads the PRDs, every issue
  with its native links, and the code on `main`, and lists every way they disagree — a PRD section no story covers
  or one changed after its stories were cut, a story the PRD never asked for or an outcome it never absorbed, a
  broken issue map (no epic, blocker forms that disagree, impossible label pairs, two stories on one folder, built
  out of order), work the code and the issues disagree on — then fixes each with the person's word, under the
  ownership rules above. A bookmark file on `main` records what was reconciled and what the person accepted as fine.
  `/dev-next` only probes: an impossible label pair or a story without an epic, or a PRD changed since the bookmark,
  and it ends its run with `Drift found: run /reconcile-issue-map`.
- **Sub-agents:** name each one after what it does (`review-auth-tests`, never `agent-3`); mechanical work runs on a
  cheap model at low effort, hard decisions and reviews on the top model; every spawn prompt asks for a bounded result
  (a verdict plus a few bullets, never an essay). A sub-agent never uses `git stash` and never switches branches — it
  works in its own worktree — commits only the files it touched, and on failure reports and stops instead of
  attempting its own recovery.

## Skills

- Skills under `.claude/skills/` carrying an `.orion-managed` marker are orion's and are refreshed by `orion update`;
  the project's own skills (no marker) are never touched.
- `/orion` manages the installation: `status`, `check`, `update`, `uninstall`.
- `/orion-verify` checks, once after install and again each time orion's rules change on a computer, that
  `CLAUDE.md`, this file, every skill, the settings and the person's own rules file fit together; it fixes what is
  mechanical and asks before touching anything the project or the person owns.
- `/wayfinder` plans work too big for one session as a map of decision tickets and settles them one at a time; it
  produces decisions (and, when its destination is TICKETS, the epic and stories), never the built work.
- `/prd-to-tickets` turns a PRD under `docs/PRDs/` into epics and stories with the person present: existing open
  issues become blockers, never duplicates; both blocker forms are set and read back; nothing is filed `agent-ready`
  with a question left.
- `/dev-quick` turns a change wanted now, with no ticket yet, into an `agent-ready` issue and hands it to `/dev-next`;
  agents offer it for every code change asked for in chat.
- `/dev-next` takes the next free story end to end: claim, build in a worktree, fresh-agent review, merge on green,
  close, report.
- `/issue-map` draws the blocked-by graph of every issue, level by level, into `docs/issue_map/issue_map.html` — a
  local, never-committed snapshot rebuilt only when a person asks for it. The issues stay the truth.
- `/harvest` works through the run reports on the audit branches with the person and turns what matters into tickets
  or rule edits.
- `/harvest-qa` drives the QA checks every merged story left behind against `main`, in sequential rounds until every
  record is tested or deduped, then shows the person each failure reproduced twice, with its importance, and files a
  `bug` issue only for the ones the person chooses.
- `/reconcile-issue-map` checks the issues, the PRDs and the code on `main` against each other and fixes the drift
  with the person present: issue edits under the ownership rules, PRD edits and its bookmark in a pull request a
  human merges. The PRD wins on what to build; `main` wins on what is done.
- `/clear-git-resources` lists stale worktrees, branches and leftover files, deletes your own stale ones whose work is
  safe, and asks before deleting anyone else's.
- `/handoff` packs the current conversation into a handoff document for the next session or agent.
- `/project-handover` writes a self-contained HTML handover of the project for clients, stakeholders and new joiners.
- `/generate-project-writeup` writes a Word summary report of the work delivered, for leadership and commercial
  stakeholders.

## What the project's `CLAUDE.md` must state

Everything project-specific lives in the project's `CLAUDE.md`, never here. `orion init` seeds it with these slots
when the project has none; otherwise add what is missing. A slot the project has no use for is deleted.

- **Commands**: build, full suite, one file, one test, typecheck, lint, deterministic checks on generated output (if
  any), dev server (how to start the product; the QA pass needs it) — one table, every row a real command or `TBD`.
- **Stack and layout**: language and version with the file that pins it, test framework, application code path, test
  code path, skip-count baseline, CI runner.
- **Worktrees**: the worktree root outside the project, the port rule (`<base port> + issue number`) and the env
  variable that carries it.
- **Boundaries**: deploy target, external read-only repositories and their work-item key format, sensitive data
  classes that must never enter the repository, any boundary an agent must not move, the working language.
- **Pending until PRD v1**: the open questions, one table row each with the file and section they decide and who
  decides, asked as one batch (each with a recommended answer) once `docs/PRDs/PRD.md` exists and deleted as answered.
