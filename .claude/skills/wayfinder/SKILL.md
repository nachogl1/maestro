---
name: wayfinder
description: 'ORION - Turn an idea that is too large for a single agent session into a plan kept on GitHub Issues: one map issue that states the DESTINATION (one of two: PRD, every decision a PRD needs, which the person then writes; or TICKETS, the work filed as stories ready to build) and a set of small decision tickets hung under it, then settle those tickets one per session until every open question has an answer. Questions that can already be asked precisely become tickets; questions that cannot be asked precisely yet are written down as fog on the map and become tickets later; anything beyond the destination is recorded as out of scope. Every ticket has one kind — research (the agent reads and cites), prototype (a rough thing for the person to react to), grilling (a conversation with the person), task (hands-on work needed before a decision) — and the steps for each kind are written here, so the skill runs no other skill (it only reads dev-next''s references/new-issue.md for the issue links and the shape of a TICKETS map''s stories). It DECIDES, IT DOES NOT BUILD. GitHub Issues only, like dev-next: tickets are native sub-issues of the map and every blocker is set as GitHub''s native relation and as a Blocked by section in the body. One ticket per session, research tickets excepted. Started by hand only: use when the user types /wayfinder; when they say "help me plan this big thing", "this is too big for one session", "chart the work", "work the map", or bring a vague idea with no clear path to the end, suggest they type /wayfinder.'
argument-hint: "An idea to plan, or the URL or number of an existing map"
disable-model-invocation: true
---

# wayfinder

> [!NOTE]
> **Editing this skill?** Keep everything here **general**: no project, person, company or stack names. It works with GitHub Issues only, like `dev-next`, and is **started by hand only** (`disable-model-invocation: true`): the model never starts it on its own, and no other skill invokes it — they only point the person at `/wayfinder`.

Some ideas are too large to finish in a single session, and at the start nobody can see every step between today
and the end. This skill does not try to reach the end in one go. It writes the plan down as issues in the project's
GitHub repository — one **map** and many small **decision tickets** — and then settles the tickets, one per session,
until every open question has an answer and the work can be handed to whoever builds it.

## Words this skill uses

- **Destination** — the end point of the map, always one of two:
  - **PRD** — every decision a PRD (product requirements document) needs has been taken. The person then writes or
    updates the PRD under `docs/PRDs/`; an agent never drafts one. `/prd-to-tickets` cuts it into stories later.
  - **TICKETS** — every decision has been taken **and** the work is filed as an epic with its stories, ready for
    `/dev-next`, with no PRD in between ([Filing the stories](#filing-the-stories-tickets-only)).
- **Map** — a single issue that holds the whole effort in summary. It is the record every session starts from.
- **Ticket** — an issue hung under the map. It asks one question that one session can settle.
- **Fog** — questions you expect to face later but cannot yet write precisely enough to become a ticket.
- **Frontier** — the tickets a session may take now: open, with every blocker closed, and assigned to nobody.
- **With the person / agent alone** — whether a ticket needs a live conversation with the user, or the agent can
  settle it without them.

## Why plan on the issue tracker

What an agent works out in a chat is gone when the session ends. On an effort that runs for weeks, the next session
then starts from nothing, or worse, decides again something that was already decided. Issues outlast the session,
teammates can read them, and several sessions can work on them at once as long as each one claims its ticket first.

## Ground rules

1. **Decide, don't build.** A ticket ends with a decision. The map ends when every decision the builders need has
   been taken. Wanting to start the actual work is a sign that planning is finished and it is time to hand over.
   Filing the stories of a TICKETS map is the last planning step, not building.
2. **Call every issue by its title.** Maps and tickets are issues, so each has a title. Wherever the user reads,
   write the title as a link to the issue; never leave a bare `#<N>` as the only name. The number may sit inside the
   link, never in place of the title.
3. **One ticket per session.** Research tickets are the only exception: they only read, so several may run at once
   as sub-agents.
4. **Every fact needs a source.** What you write on the map or a ticket comes from something you read — a file,
   command output, a cited page — or from the user's own words. A guess goes on the ticket marked as an assumption.
5. **A ticket that needs the person is never settled without them.** If you answer your own grilling questions, the
   skill has failed. Ask, then wait.
6. **Only write down what you can see.** The map is meant to be incomplete; see [Fog](#fog).

## Step 0 — Make sure GitHub Issues work (every session, before anything else)

**GitHub Issues in the project's own repository are the only tracker** (the project's mandatory rules). Read the
project's `CLAUDE.md` first; where it disagrees with this file, it wins. Then, before writing anything:

1. Run `gh auth status` and `gh repo view --json nameWithOwner,hasIssuesEnabled`. If `gh` is not signed in, issues
   are turned off, or `CLAUDE.md` names a different tracker as the source of truth, stop and say this skill needs
   GitHub Issues. Never fall back to another tracker or to local files.
2. **A ticket hangs under its map as a native sub-issue**, added with the same calls and read-back as
   `.claude/skills/dev-next/references/new-issue.md` step 3, with the map in the place of the epic. A checklist in
   the map's body is never a substitute.
3. **Every blocker is recorded twice:** as GitHub's native "blocked by" relation, which people see in GitHub's own
   pages, and as a `### Blocked by` section in the ticket's body, one `#<N> — <title>` line per blocker or `(none)`,
   which agents read. Use the calls and read-back of `new-issue.md` step 4; when the read-back and the body disagree,
   fix it before writing the next ticket.

Then tell the user, in one line, which repository you are using and that both kinds of link work.

## The map issue

One issue with the label `wayfinder:map` (create the label if it is missing). The map only **points**: each decision
is written out once, on its own ticket, and the map holds a one-line summary with a link. Open tickets are never
listed in the map; ask GitHub for the map's open sub-issues instead.

```markdown
## Destination

**<PRD | TICKETS>** — <one or two lines: what is true once this map is finished. Every
session reads this before it picks a ticket.>

## Notes

<Background on the domain; the stack and conventions found in this repository; skills
or documents every session should read; and preferences the user wants kept for the whole effort.>

## Settled

<!-- Each closed ticket gets a line here: its title as a link and the answer in a few words.
     The full reasoning stays on the ticket. -->

- [<title of the closed ticket>](<url>): <the answer in a few words>

## Fog

<!-- Questions inside the destination that cannot be asked precisely yet. Each one
     leaves this list when it becomes a ticket. -->

## Out of scope

<!-- Things deliberately placed beyond the destination. It never becomes a ticket on
     this map. -->
```

A map with `## Decisions so far` / `## Not yet specified` (the earlier names) is read as `## Settled` / `## Fog` and
renamed on its next edit. A map whose Destination names neither PRD nor TICKETS (written before the two kinds) is
read as PRD; ask the person once whether it should be TICKETS instead, and write the answer on the map.

## A ticket

Hung under the map as a sub-issue. The body holds only the question, sized so that one focused session can settle it;
if it would take several, split it.

```markdown
## Question

<The one decision or fact this ticket settles.>

## Why it matters

<One line: which later work cannot start until this is answered.>

## Assumptions

<What was taken on trust instead of checked, so a later session can test it. Leave
the section out when there is nothing to list.>

### Blocked by

<One `#<N> — <title>` line per ticket that must close first, or `(none)`. Each line is
also set as the native relation (Step 0).>
```

How tickets behave:

- **Kind label.** Each ticket has exactly one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`,
  `wayfinder:task`. Create the missing ones once, when the map is first written. Read the label to know the kind;
  the body does not say it.
- **Claim before work.** Claim the ticket before doing anything on it, following [Claiming a ticket](#claiming-a-ticket):
  other sessions skip an assigned ticket, and an unassigned open ticket is free.
- **Blocked or free.** A ticket is free to take once every blocker is closed, checked in both the body section and
  the native relation; a blocker in either one still blocks.
- **The answer goes in a comment.** The body keeps the question unchanged, so the ticket always reads as the
  question it asked.
- **Link things, don't paste them.** A prototype, a branch or a document is linked from the ticket.
- **Split for parallel work.** When one question becomes several tickets, keep the files, modules and areas they
  share as few as possible, so two sessions or two people can work them side by side. Where one ticket truly needs
  another's answer, record that as a blocker.

## Claiming a ticket

All of one person's sessions share one GitHub login, so the assignee alone cannot tell them apart: sessions started
together each read the same frontier, each assign themselves to the same first ticket, and each sees "assigned to me".
A comment that names the session breaks the tie. Claim in this order, every time:

1. **Mint a session id** once per session, in UTC: `wayfinder-<yyyymmdd-hhmmss>-<4 hex>`. Never use the local clock.
2. **Re-read the ticket's assignees** just before claiming (`gh issue view <N> --json assignees`; this narrow read is
   the one exception to reading issues with the full field list). Any assignee means another session has it: write
   nothing on it and take the next ticket on the frontier. When the user named this ticket and it is assigned to
   their own login, tell them and ask whether to take it over (a session that crashed leaves its ticket assigned, and
   this is how it is freed); on a yes, delete the old `Claimed by wayfinder session` comments on it before step 3, so
   the takeover cannot lose to them. When it is assigned to someone else, it is theirs: say who holds it and stop.
3. **Assign yourself** (`gh issue edit <N> --add-assignee @me`), then comment `Claimed by wayfinder session <id>.`
4. **Wait 5 seconds, then read the comments with their numeric ids** (`gh api repos/{owner}/{repo}/issues/<N>/comments
   --paginate --jq '.[] | {id, user: .user.login, created_at, body}'`). Among the `Claimed by wayfinder session`
   comments posted in the 10 minutes up to yours, **the one with the lowest id wins**. If it is not yours, back off:
   delete your own comment by its id (`gh api -X DELETE repos/{owner}/{repo}/issues/comments/<id>`, never
   `--delete-last`, which can delete a sibling session's comment under the same login), unassign yourself only when the
   winning comment's author is a different login (your own sessions share the assignee, which stays), then take the
   next ticket from step 2. When the user named the ticket you lost, tell them another session holds it and ask which
   ticket to take instead.
5. **Letting go of a ticket without closing it** (the session ends early, the user stops it): delete your claim comment
   and unassign yourself, so the ticket is free again.

Older claim comments are ignored in step 4: they belong to sessions that ended, and the assignee check in step 2 is what
keeps a live claim safe.

## The four kinds of ticket, and how to settle each

The steps for every kind are written here, so this skill never calls another one. (If the user already has a skill
installed under one of these names, use theirs and tell them you did.)

### research — agent alone

Finding a fact that a decision depends on, when the fact lives outside this repository: vendor documentation, a
library's own source, an external API.

Steps: write the question in one sentence; read primary sources only (official documentation, the dependency's
source, this repository's code); give a link or `file:line` for every claim; finish with the answer, how sure you
are, and what you could not find out. Never fill a gap from memory. These are the only tickets that run in
parallel: one sub-agent per research ticket, each named for its topic (`research-<topic>`), at most about four at a
time, on a cheap model for plain reading, each asked for a bounded result (a verdict and at most five bullets, with
sources). Each one posts its findings as the answer comment on its own ticket.

### prototype — with the person

Building something quick and disposable so the user can react to a real thing instead of an abstract choice: a page
outline, a mock screen, a function stub, a sketch of the flow. Use it when the open question is about appearance or
behaviour.

Steps: build the least that makes the choice visible, and tell the user it is meant to be thrown away; keep it in a
scratch folder outside the repository, or, when others must see it, on a `feat/wayfinder-<ticket-slug>` branch in a
worktree outside the project (Guardrails, *Git*) — never in the main checkout and never on `main`; show it and ask
what the user thinks of it, not whether they approve it; write down what their reaction decided. The prototype is
evidence for the decision, linked from the ticket, and may be deleted afterwards.

### grilling — with the person (the usual kind)

A conversation that turns a loose wish into a firm decision. Most tickets are this kind.

Steps: ask **one question at a time**, in words a junior developer who knows neither the stack nor the domain would
follow, and explain any term the first time it appears. Use clickable options (`AskUserQuestion`) with your
recommendation marked. Ask why behind every answer, point out the cost of each option, and say so when you disagree.
Finish when the decision fits in one sentence the user agrees is theirs.

Alongside every grilling, sort out the **vocabulary**: list the real things involved, how they relate, and the exact
words the user calls them. When two words seem to mean one thing, or one word two things, ask about it; loose names
are how a plan goes wrong without anyone noticing.

### task — agent alone or with the person

Hands-on work that has to be finished first so that a decision becomes possible, for example creating a trial account
to test a vendor's limits, getting read access to a log store, or exporting a sample of records to look at their
fields. It is the only kind that does work instead of deciding, and it exists only to unblock a decision, never to
deliver the destination.

Steps: the agent does it alone when it can; otherwise it gives the user a numbered list of exact steps and waits. The
ticket closes once the work is finished, and the answer comment records the work carried out and every fact later
tickets will need (where an account's login is stored, the address of a new endpoint, how many records were exported).
**Never put a password, token or personal detail on a ticket** — say where it is kept, never what it is.

## Fog

Some questions clearly lie between here and the destination but depend on answers nobody has yet. They cannot be
written as tickets yet. Each settled ticket sharpens some of them enough to be written as tickets, and they are turned
into tickets as that happens, until there is no fog and no open ticket.

The map's **Fog** section is where these are written down: the question you expect, or the area you will need to
come back to. It also tells a reader what the effort will tackle next.

**Ticket or fog?** Ask whether you can *write the question* precisely today. Being able to *answer* it today is
irrelevant.

- **Ticket**: you can already state the question exactly, even if a blocker means nobody can work on it yet.
- **Fog**: you cannot yet write it that exactly. Do not chop a fog entry up early to look like tickets: one entry
  may later become several tickets, or turn out to need none.

The **Fog** section never holds what is already settled, what is already a ticket, or what is out of scope.

## Out of scope

Everything in the fog sits on this side of the destination. Anything past the destination counts as **out of scope**,
not fog, however clear or vague it is, and it goes in the map's **Out of scope** section. It never becomes a ticket on
this map. Should the destination later be widened to cover it, that is a new map, not this one continued.

If an existing ticket is found to lie beyond the destination — written too eagerly at the start, or shown to be
outside by a later answer — **close it**, so it can no longer appear on the frontier, and add one line to **Out of
scope**: what it was, why it is outside, and a link to the closed ticket. **Settled** gets no line for it, because
nothing was decided on the way.

## Mode A — Start a new map

The user gives an idea. With no argument, ask what they want to plan.

1. **Fix the destination first**, because it decides what is in scope. Read the repository before you ask —
   `CLAUDE.md`, `README.md`, the manifest files, the existing issues, `docs/PRDs/` — so the questions fit this
   project. Then the **first question** is its kind, asked with `AskUserQuestion` offering exactly two options and
   nothing else: **PRD** (the map ends with the decisions a PRD needs, and the person writes the PRD) and
   **TICKETS** (the map ends with the stories filed, ready for `/dev-next`). Recommend PRD when the idea changes what
   the product does or who it is for, TICKETS when the product stays as the PRD describes it. Then grill the user
   (see grilling) and sort out the vocabulary until the end point is clear in one or two lines.
2. **Survey the open questions, wide before deep.** Grill again, touching every area of the effort briefly instead
   of following one thread down, to list the decisions still open and what can be started right away. **If no
   fog appears** — the path is already clear and the whole job fits in one session — say that a map would only add
   overhead, **stop**, and let the user choose how to continue.
3. **Check for duplicates before creating anything** — mandatory, see below.
4. **Create the map** with the `wayfinder:map` label: Destination and Notes written, Settled empty, the fog listed
   under **Fog**.
5. **Create every ticket you can already write** as a sub-issue of the map. Add the blockers **afterwards, in a
   separate pass**, because a ticket must exist before another can point at it; set both forms and read each back
   (Step 0). Tickets with no open blocker form the frontier; what you cannot write yet stays under **Fog**.
6. **Start the research sub-agents** for every `research` ticket just created, as the research steps say. Each posts
   its findings on its own ticket.
7. **Ask the PRD question** once, after the batch ([The PRD question](#the-prd-question)).
8. **Stop.** Writing the map is a whole session; settle nothing else. Report the map's title with its link, the
   frontier tickets by title, and how many fog entries remain.

## Mode B — Settle the next ticket

The user gives a map, as a URL or a number, and may also name a ticket. If they name none, picking the next
ticket is your job; do not ask them to pick.

1. **Read the map body** — the summary, not every ticket.
2. **Pick the ticket.** Use the one the user named; otherwise the first ticket on the frontier, in order. **Claim
   it before doing any work** ([Claiming a ticket](#claiming-a-ticket)); a ticket another session wins is skipped
   for the next one on the frontier, unless the user named it.
3. **Settle it** with the steps for its kind label. Open the full body or answer of a related ticket, open or
   closed, when you need it, and read whatever the map's `## Notes` points at.
4. **Record the answer:** post it as a comment, **close** the ticket, and **add one line** under *Settled* on the map,
   with the ticket's title as a link.
5. **Update the plan:** create any new tickets the answer raised (create first, then link the blockers in both
   forms); turn every fog entry the answer made precise into a ticket and **remove that entry from *Fog*** so it
   exists in one place only; move anything the answer placed beyond the destination to *Out of scope*; update or
   close the tickets the decision made wrong.
6. **File the stories** when this was a TICKETS map's last open ticket and no fog is left
   ([Filing the stories](#filing-the-stories-tickets-only)).
7. **Ask the PRD question** once, when this session created or edited any ticket or story
   ([The PRD question](#the-prd-question)).
8. **Stop after this one ticket** (research excepted). Report the ticket's title, the decision in one line, and what
   is on the frontier now.

**Other sessions may be changing these issues at the same moment**: the user can run free tickets in parallel.
Re-read a ticket just before you write to it, and do not trust the frontier you read in step 1 to still hold by
step 5.

## Filing the stories (TICKETS only)

When the last ticket of a TICKETS map closes and no fog is left, the session that closed it files the work before it
stops, with the person present:

1. Run the dedupe deep-dive below for every story; an open issue that already covers one is linked, not repeated.
2. File one **epic** for the map's destination: the `epic` label only (an epic never carries a tier), and a body
   that states the destination in a line or two and links the map.
3. File one **story** per piece of work, in the shape of `.claude/skills/dev-next/references/new-issue.md` (body
   headings, a `### Seam`, the labels and its readiness label, `tier:wayfinder`, the native sub-issue link to the
   epic, both blocker forms, every read-back). Each story's `### References` links the map and the tickets whose
   answers it rests on. A story that adds or changes a screen names its screen in the UX prototype under
   `### References`; a screen the prototype lacks first gets a `needs-human` story of its own under the epic, "UX
   prototype for <screen>", seam `docs/ux/prototypes/<slug>/`, and the front-end story is blocked on it. **No `wayfinder:*` label on the epic or any story**: `/dev-next` never takes an issue that
   carries one.
4. Add one line under the map's **Settled** linking the epic, then close the map.

A PRD map files nothing: it ends with the decisions, and the person writes the PRD.

## The PRD question

A session with the person present asks it **once, after its batch of ticket creations or edits**, whenever at least one PRD exists under `docs/PRDs/` (before any PRD exists there is nothing to update): **"Should we update the PRD with this too?"**, followed by one line per change, naming the PRD section it touches. "No" ends it. "Yes" → the PRD edit ships in a `docs(prd)` pull request, made under Guardrails, *Git* (worktree, changelog file, gate, merged by a human).

## Asking the user questions

Every question to the user goes through clickable options (`AskUserQuestion`): distinct options per question, your recommendation marked, plain language throughout. Assume zero knowledge of the stack and zero knowledge of the domain — define any technical term or acronym the first time it appears. One question at a time during grilling; batch only genuinely independent questions.

## MANDATORY dedupe deep-dive before creating any map or ticket

Before creating a map, a ticket, or *offering* to create one, confirm nothing already covers it. This gets skipped and gets it wrong; do it properly every time:

- Search the **repository's open and recently-closed issues** with several term variations (`gh issue list --search …`, `gh search issues`) — not one keyword. **Read** the candidates; do not just count them.
- Search the **codebase** for an existing implementation, TODO, ADR, or design doc that already answers or intentionally defers the question.
- **Never defer to a closed issue.** If you point at an existing issue as the reason not to chart something, verify it is actually **open** first — a closed issue means nobody picks the work up and it silently falls through the cracks. If it is closed, or does not really cover the case, chart it anyway.
- If something does cover it, **link to it** instead of creating a duplicate, and say which item and why.

## Guardrails

- **Git.** Never commit to `main` and never work in the main checkout. Anything this skill writes into the repo (rare — usually only a prototype or a PRD edit) goes on a `feat/<slug>` branch (or the project's own branch pattern) in a worktree outside the project, at the worktree root the project's `CLAUDE.md` names: `git -C <main checkout> worktree add <wt root>/<slug> -b feat/<slug> origin/main`. Before the pull request opens, add the pull request's own changelog file, `docs/changelog/<YYYY-MM-DD>-<branch>.md` (one line; every pull request carries one; create the folder with a `README.md` explaining the format if it does not exist), then run **the gate** — the gate commands the project's `CLAUDE.md` lists, build → lint → typecheck → full suite — and open the pull request only on green. Conventional Commit messages (`type(scope): summary`), never `git add -A`, and a pull request a **human** merges. Never force-push, never `--no-verify`, never auto-merge.
- **Sensitive data.** Everyone with access to the repository can read the map and every ticket under it. Never put passwords, tokens, personal data or absolute machine paths on them; say where something is kept, not what it is.
- **Scope does not grow quietly.** If settling a ticket starts to turn into building the destination, stop and tell the user: that is the moment to hand over, not a licence to carry on.
- **Nothing disappears without a yes.** Closing or deleting a ticket someone else wrote, or changing the destination, waits for the user's explicit agreement.
- **Windows note.** When creating issue bodies from files, write them **without a byte-order mark** — PowerShell 5.1's `-Encoding utf8` adds one and it surfaces as stray characters in the issue. Write BOM-free with `[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding $false))` (`$path` must be absolute, e.g. `(Join-Path (Get-Location) '<file>')`, because .NET resolves relative paths against its own current directory, not PowerShell's), or with Python `open(path, "w", encoding="utf-8")`, then pass it via `--body-file`.

## Reporting back

Keep it short, one fact per line:

- **Start with what changed or what comes next**, not with background.
- **Number the steps** of anything with more than one, one action per line.
- **Use titles**, never bare numbers, for maps and tickets.
- **Finish with a single concrete next step**, not a list of options.
- **Say clearly when something is blocked**, by whom, and for how long.

## Mistakes to avoid

| Mistake | What goes wrong |
|---|---|
| Keeping a list of open tickets in the map body | It is out of date at once; GitHub's list of open sub-issues is the real one. |
| Writing a decision out in full on the map | Two copies drift apart. The map has one line and a link; the ticket has the rest. |
| Naming tickets only by number | Nobody reading quickly knows what they are. Use the title. |
| Turning fog into tickets before the question is clear | Those tickets ask questions nobody can state yet. Keep them under *Fog*. |
| Answering a grilling ticket yourself | The point of the ticket is the person's own answer. Ask and wait. |
| Settling several tickets in one session | Each answer changes the map, so the next pick must be made from the changed map. |
| Building the destination inside a ticket | That is execution, not planning. Hand over instead. |
| Working on a ticket someone has claimed | Another session already has it, and the two will clash. |
| Treating "assigned to me" as a won claim | Your other sessions share your login, so every one of them sees the same. Only the claim comment with the lowest id wins. |
| Making a map for a job that fits in one session | All overhead and no benefit. Say so and stop. |

## When it is done

- **Writing a new map is finished** when the map issue states its destination, every ticket that can be written exists
  with its blockers linked, everything else is listed under *Fog*, the research sub-agents are running, and the user
  has the map's title, its link and the current frontier.
- **A working session is done** when exactly one ticket (research excepted) has its answer comment, is closed and has
  its line under *Settled*; *Fog* and *Out of scope* are up to date; and the new frontier has been reported.
- **The whole map is finished** once no ticket is open and no fog is left — every decision the builders need has been
  taken — and, for a TICKETS map, the epic and its stories are filed. Say so plainly and close the map issue.
