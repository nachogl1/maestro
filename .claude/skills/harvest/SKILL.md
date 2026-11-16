---
name: harvest
description: 'ORION - Work through the one pile agents leave behind — the audit reports on every developer''s audit branch, which hold three kinds of note (a product problem left for later, something that slowed a run down, a tip for the next run) — with the person running it, most important first: every note rated high, medium or low by fixed tests, notes about the same area grouped, one short three-line question per high group and then per medium group, the question of how many tasks in all, and every low note in one closing question. Every item is explained as if the person had never heard of the project, with its kind and how much it matters said out loud (the long explanation only on request), never proposing anything an open task already covers, and grouping what belongs together into as few tickets as possible. Nothing is filed or dropped without the person''s word. Its own pull request merges on green unless it touches the PRD, an ADR, the prototype or CLAUDE.md, which a person merges. Use when the user types /harvest, or when a /dev-next run ended with `Harvest due: run /harvest`.'
argument-hint: "(no arguments)"
disable-model-invocation: true
---

# /harvest

> [!NOTE]
> **Editing this skill?** Keep everything here **general**: no project, person, company or stack names. It works with GitHub Issues only, like `dev-next`, whose `references/new-issue.md` and `references/audit.md` it relies on.

A person runs this. It is never started by another skill: `/dev-next` only counts the pile and prints
`Harvest due: run /harvest` when it reaches ten (the findings-left-for-later rule). Every decision below is the
human's; this skill prepares, groups, recommends, and then does what was decided.

Read the project's `CLAUDE.md` first. It overrides this file where they disagree.

## Who you are talking to — assume they know nothing

The person running the harvest has **no context of anything**: not the project's vocabulary, not what the product does,
not what any story built, not what any run did, not what any file or folder is for. Treat every item as the first thing
they have ever heard about this project. They are a developer, so they understand "a test", "a file", "a screen" — but
not "the ledger", "a seam", "the merge slot" or "issue #<N>" until you have said, in one plain sentence, what that
thing is and does. If a sentence would only make sense to someone who had read the ticket, rewrite it.

**Say which kind of note an item is, every time, before anything else.** The pile holds three kinds, and the person
cannot tell them apart unless you do it for them:

| Kind, in the words you use | What it is | Where it comes from |
|---|---|---|
| **A product problem left for later** | Something wrong or missing in the product itself (the code, a screen, a document) that an agent saw while building a story and was not allowed to fix on the spot | the `deferred` list of a run's audit report |
| **Something that slowed a run down** | A step in *how we work* that wasted an agent's time: a flaky command, a missing tool, a rule that two runs tripped over. Not a bug in the product | the `friction` list |
| **A tip for the next run** | Advice the agent wrote for whoever works on this next: about the code, the domain or the process. Not a bug either | the `lessons_learned` list |

The first words of every item's first line name its kind, in exactly those phrases. A group that mixes kinds says
so ("two product problems and one slow-down about the same screen").

## How to explain each item — plain language, every time

**The question: three lines.** Every group is asked in three lines, in this order, one or two short sentences each:

1. **The problem, with what that part does.** The kind first (the phrases above), then what that part of the product
   or process does and who it is for, then the problem in everyday words. A group of several items says how many of
   each kind it holds and gives the problem of the group as a whole.
2. **How much it matters, and why.** **"Worth doing soon"**, **"worth doing some day"** or **"probably never
   matters"** (the rating of Phase 1, step 3), then its reasoning line in concrete terms: the test it meets, how many
   runs hit it, what a user would see, what happens if we leave it. This is the line the person cares most about;
   never leave it out or make it vague.
3. **What I suggest, and what it would touch.** The recommendation and its size in plain words: "fix it now: one line
   in one file, no test changes", "a task for later: three files in the import code, clashes with the open search
   story".

**The long explanation, only when the person asks** ("tell me more", "where did this come from?", "what does that
mean?"): the seven lines below, for the group and, when asked, for each item in it. Never printed unasked.

1. **Kind** — one of the three phrases above.
2. **What part of the product or process this is about** — one sentence on what that part *does and who it is for*,
   as if the person had never heard of it: "the screen a reviewer opens to see one record and who approved it", "the
   step where an agent waits its turn to merge, because only one merge runs at a time".
3. **What it is** — the problem in everyday words, as you would say it to a new colleague. Say what the thing *does*,
   not what it is called: "the screen that lists the saved records", not `RecordListScreen`.
4. **Where it came from** — "an agent noticed it while building the story that adds the review screen, on <date>,
   in one developer's runs"; never a bare issue number or run id.
5. **How much it matters, and why** — this line is the one the person cares most about; never leave it out or make it
   vague. Say one of **"worth doing soon"**, **"worth doing some day"** or **"probably never matters"**, then the
   reason in concrete terms: how many runs hit it, what a user would see, what breaks or gets slower, whether a story
   now open will hit it. The severity in the report is a hint only: a medium three runs have hit is "worth doing
   soon"; a high that a merged story already removed is never shown at all (Phase 1, step 1).
6. **What happens if we leave it** — the real consequence, concrete: "a new developer will run the wrong command and
   lose ten minutes", "nothing, unless someone renames that folder".
7. **What I suggest, and what it would touch** — the recommendation and its size in plain words: "fix it now: one line
   in one file, no test changes", "a task for later: three files in the import code, clashes with the open search
   story".

Words and habits to follow:

- **Use the plain word, never the internal one.** Say "a product problem left for later", not "deferred finding";
  "something that slowed a run down", not "friction"; "a tip for the next run", not "lessons_learned"; "what it would
  touch", not "blast radius"; "the folder a story owns", not "seam"; "the automatic checks", not "CI"; "a task" or
  "a ticket", not "issue #N" alone. A word with no plain replacement gets a two-to-four-word gloss in brackets the
  first time.
- **Explain the product part before the problem in it.** The person does not know what a draft, a ledger, a fallback
  rule or a write-back to another tracker is. One sentence each, every time it first appears in a group.
- **No file names, field names, branch names, run ids or code names** unless the person needs one to act. Run ids and
  logins become "a run on <date> by <their name>".
- **Short sentences, common words.** One idea per sentence. No arrows or symbols in place of verbs. If a sentence needs
  re-reading, rewrite it.
- **Answer options in the same plain words**: "Fix it now", "Make it a task for later", "Add it to an existing task",
  "Throw it away", "Not this time" — never the internal destination name.

Bad: "Group 3 — seam `src/<area>/Ledger`, 2 deferred (#<N>, #<N>), friction ×3 from audit runs; blast radius 4 files;
rec: ticket."

Good (the three-line question):

> A product problem left for later, two notes. The product keeps a record of every file it generates and who approved
> it, so auditors can later prove where a change came from; this record does not save the time in the same format
> everywhere.
>
> Worth doing soon: three runs lost time over it, and the report auditors read sorts files by that time, so it would
> list them in the wrong order.
>
> I suggest a task for later: it touches four files in that one area, and nothing else is working there.

## Phase 0 — Gather

1. `gh auth status`; `git fetch origin` plus `git fetch origin 'refs/heads/audit/*:refs/remotes/origin/audit/*'` to see
   every developer's audit branch. Missing tool → stop and print the command that fixes it.
2. Read `docs/harvest-state.json` if it exists:
   ```json
   {
     "harvested_through": { "<login>": "<last run id harvested>" },
     "carried": [ { "login": "<login>", "run": "<run id>", "issue": "<N>", "field": "friction", "line": "<the line or the deferred entry's what>" } ],
     "last_harvest": "<yyyy-mm-dd>"
   }
   ```
   No file → nothing has been harvested yet. `carried` holds items a previous harvest skipped; they are part of the
   pile again this run.
3. **The pile:** for every `origin/audit/<login>` branch, `git ls-tree -r --name-only origin/audit/<login> runs/`
   lists its reports; keep `runs/<run id>/issue-<N>.json` whose run id is newer than that login's `harvested_through`
   entry (run ids sort by time: `<repo>-<yyyymmdd-hhmmss>-<hex>`, in UTC). Read each with
   `git show origin/audit/<login>:runs/<run id>/issue-<N>.json` — **never check the branch out, and never read a
   `qa-<N>.json`**: those are the QA records `/harvest-qa` works through, with its own bookmark. Collect every
   `deferred` entry, every `friction` line and every `lessons_learned` line with its run id, issue number, login and
   kind, plus every `carried` entry.

Nothing gathered → say so in one line, with the count, and stop.

## Phase 1 — Understand, filter and group (do this well; it is the point)

Before showing anything, work every item through — this is where the value is, and where a careless pass costs the
team a backlog nobody drains, or an hour of a person's attention on things that no longer matter:

1. **Understand it.** For a product problem, open the folder or module it names and confirm the problem is still there
   (a later story may have fixed it — then it is already done and is not shown, only listed in the pull request table).
   For a slow-down or a tip, check whether the cause still exists (a command now among the gate commands the project's
   `CLAUDE.md` lists, a trap already in the project's list of known shell traps, a rule already written).
2. **Check for an existing task — and do not show what is already tracked.** For every item that could become a task,
   search the open issues (`gh issue list --state open --search "<key words>"`, plus the issues whose `### Seam` names
   the same folder, plus the issues the item's own story is blocked by or blocks). An open issue that already covers
   the item, in whole or in the part that matters, means the item is **not proposed to the person at all**: it is
   recorded as "already tracked by <the task, named in plain words>" in the pull request table and counted as
   harvested. The same goes for an item that a merged story has already fixed. The person's time goes only to items
   nobody is acting on yet. When the match is partial — the open task covers the area but not this exact problem —
   the item is shown, with "add it to an existing task" as the recommendation (step 7).
3. **Rate how much it matters, by fixed tests** — the first that holds:
   - `high` ("worth doing soon"): a user would see it, or it broke or blocked a run, or three or more runs hit it.
   - `medium` ("worth doing some day"): it hit once, and an open story or a later user will meet it.
   - `low` ("probably never matters"): everything else — a one-off, a cosmetic point, something already worked around.

   You may lift an item one level (low to medium, medium to high) when the tests miss something concrete, and the
   reasoning line says why; never lower one. The report's own severity is a hint only, never the rating: a product
   problem left for later carries `medium` or `high` (the scale `/dev-next`'s review and its audit report use, which
   records no lows), and a slow-down or a tip carries none. Write one line of concrete reasoning per item: the test it
   meets, runs hit, user impact, open stories affected. This line is shown to the person word for word (line 2 of the
   question in *How to explain each item*).
4. **Group.** Items that touch the same folder, module, file, rule or skill phase become **one group**. Slow-downs
   repeated across runs are one group. A group is what becomes a ticket, never a single item when a neighbour exists;
   in the question on how many tasks in all (Phase 2, step 4) the human may merge groups into one ticket. A group's
   rating is its highest item's. Within one rating, the group more runs hit comes first. A group names how many of
   each kind it holds.
5. **Measure what acting on each group would touch** — counted, not guessed: the files and folders it changes, the
   tests that cover them (and whether a new test is needed), the open stories and in-flight issues that own the same
   folder (`### Seam` in their bodies, and the in-flight file — the list `/dev-next` keeps of stories being worked on
   right now), and whether it touches a repository this team does not own. One line, in plain words, e.g. "2 files in
   the import code, 1 test class, collides with the open search story".
6. **Write the question** in the shape and words of *How to explain each item*: the three lines for every group and
   every low note, and the long explanation kept ready for when the person asks. Without them the human cannot
   decide, and the harvest turns into a lesson; with them, most groups take one answer.
7. **Recommend a destination per group:**
   - **Fix now** — small, safe, clear; goes in this harvest's pull request.
   - **Rule change** — a line in the project's `CLAUDE.md`, a skill or a reference file; goes in this harvest's pull
     request. The usual home for a slow-down or a tip.
   - **Ticket** — real work for later; one GitHub issue per group (or per set of groups merged in the question on how
     many tasks in all), written to
     `.claude/skills/dev-next/references/new-issue.md` (the body headings, `story` plus exactly one readiness label
     and one tier label (`tier:bug` for a defect, else `tier:harvest`), the labels and the `### External reference`
     heading it prescribes when the work touches a repository this team does not own, native sub-issue of its epic,
     both blocker forms). The epic is the one the items came from when they share one, otherwise the human picks. `### References` names the audit runs the items came from.
   - **Add to an existing task** — an open story already owns the area but not this exact problem: a comment on that
     story (Phase 3, step 2); never on a `needs-human` story.
   - **Drop** — only on the human's explicit word, but **the recommendation for every item rated "probably never
     matters"**, with the reason it is not worth keeping said plainly; for any other item it is only offered as the
     alternative. An item is acted on, handed to a task, dropped, or carried to the next harvest.

## Phase 2 — Present and decide, most important first (the touchpoint)

Nothing is filed, fixed or dropped automatically: the human decides every group. The aim is that deciding is fast and
easy — three short lines do the work, the recommendation is ready to accept, and questions are welcome.

1. Open with this, in these words or simpler, every run:
   - **What this does.** While agents build stories they write three kinds of note: a product problem they saw but
     were not allowed to fix, something that slowed their run down, and a tip for the next run. Today we go through the
     new notes together, most important first, and decide, for each group: fix it now, make it a task for later, add
     it to a task that exists, throw it away, or leave it for next time.
   - **What I already took off the list.** One line per item that an open task already covers or a merged story
     already fixed, each named in plain words — so the person knows these were seen and where they went — then the
     counts: items read, items taken off the list, items to decide, by kind and by rating.
   - **The goal.** As few new tasks as possible. Notes about the same part of the project become one task. Nothing is
     thrown away unless you say so.
2. Print the overview: every high and medium group as one line — kind(s), a plain title, how much it matters, the
   recommended destination, what it would touch — high first, then medium; then one line with the number of low
   notes, which come last.
3. **The high groups, then the medium groups, one question per group.** Before the high ones say "first, the notes
   worth doing soon"; before the medium ones, "now, the notes worth doing some day". Per group, its three lines (*How
   to explain each item*), never the long explanation unasked, never a bare number. Then ask with clickable options
   (`AskUserQuestion`, up to four groups per call, one question per group, every label in plain words). The options
   are always the same five: **fix it now** (or the rule change), **make it a task**, **add it to an existing task**,
   **throw it away**, **not this time**. The tool shows at most four, so each question shows the recommendation
   first, marked "(Recommended)", then the next ones in that order, skipping "add it to an existing task" when no
   open task covers the area; the one left out the human types under "Other".
4. **Then how many tasks in all**, right after the medium groups: one question with the recommended merge of the
   groups made a task that share an area into one ticket. Skipped when no group was made a task.
5. **Then every low note, in one question.** A low note here is one in a group rated low; a low item inside a high
   or medium group was decided with that group. One line per note — its kind, the problem in plain words, why it
   probably never matters — and three options: **throw them all away** (Recommended), **keep them all for later**,
   **go through them one by one**. Kept for later → each note is carried (step 7), so the next harvest offers it
   again, and it still counts towards the ten notes that make `/dev-next` say `Harvest due`. One by one → each low
   note gets its own three-line question with the five options of step 3; a low note made a task there joins the
   ticket already decided for its area, or becomes its own. Skipped when there are no low notes.
6. **Expect questions and discussion.** A question gets a short plain answer — open the code or the run report to back
   it — and the questions carry on where they stopped; they never restart. "Tell me more" gets that group's long
   explanation. If the human asks "what does that mean?", the explanation was not plain enough: answer, then keep the
   rest simpler. A decision changed mid-way replaces the earlier one.
7. Record every decision before acting on any. "Not this time" and every low note kept for later are written to
   `carried` in `docs/harvest-state.json` (Phase 3, step 5), because the branch pointer moves past them.

## Phase 3 — Act

All file changes go through **one** pull request on `feat/harvest-<yyyymmdd>` in a worktree (the project's git
rules: worktree root, branch pattern, who merges):

```
git -C <main checkout> worktree add <wt root>/harvest-<yyyymmdd> -b feat/harvest-<yyyymmdd> origin/main
```

`<wt root>` is `C:\wt` on Windows and `~/wt` elsewhere, unless the project's `CLAUDE.md` names another. Who merges
the pull request depends on what it touches (*Who merges*, below).

1. **Fix now** → make the change. **Rule change** → edit the rule file. Both in this pull request.
2. **Ticket** → create the issue exactly as `.claude/skills/dev-next/references/new-issue.md` says — body file,
   labels, native sub-issue, both blocker forms, verified with the read-back calls there — naming the audit runs the
   items came from under `### References`. Once, after the last ticket is created or edited, if the project keeps
   a PRD, ask the PRD question: **"Should we update the PRD with this too?"**, followed by one line per ticket saying
   what changed and which PRD section it touches. "Yes" ships the PRD edit in this pull request, which a person then
   merges (*Who merges*).
   **Add to an existing task** → a comment on that story, headed `Harvest of <date>:`, saying in plain words what the
   item is and which run found it. Never on a `needs-human` issue: under the project's issue rules (the assignee owns
   the issue; a `needs-human` reason is the issue's last comment) its reason must stay the last comment — there, if
   **nobody is assigned**, a line is added to the issue body's `### Scope` instead; if someone is, the issue is theirs
   (never edit someone else's) and the item is carried. **Never comment on a story that is claimed and in flight**
   (assigned, in the in-flight file): the dev agent will not see it and it costs a review round. **Carried** means
   written to `carried` in `docs/harvest-state.json` (step 5) with the task it was meant for, so the next harvest
   offers it again once that task is free.
3. **Drop** → nothing is written; the commit message and the pull request table record the item and "dropped on
   <login>'s decision".
4. **Already tracked / already done** (Phase 1, steps 1 and 2) → nothing is written; the pull request table names the
   task or the merged story.
5. Write `docs/harvest-state.json`: for every login read, `harvested_through` = the newest run id seen this run;
   `carried` = every item the human left for next time this run (a group answered "not this time", and every low
   note kept for later) **plus every item carried in step 2** because its task was claimed or owned by someone
   (previous `carried` entries that were decided drop out);
   `last_harvest` = today. Audit branches are never written to.
6. **Run the gate** (the gate commands the project's `CLAUDE.md` lists: build → lint → typecheck → full suite) before
   the pull request opens. A fix that turns it red is undone, and the human is asked what it becomes instead (a task,
   or not this time); a new ticket asks the PRD question of step 2 again. The gate then runs again, and the pull
   request opens only on green.
7. Add the harvest's own changelog file, `docs/changelog/<YYYY-MM-DD>-<branch>.md` (one line; every pull request carries one), then commit with
   Conventional Commits (`chore(harvest): …`), **never `git add -A`**, push, and open the pull request with the table
   below.
8. **Merge it as *Who merges* says.** One that touches none of the paths a person merges → wait for its checks (the
   host can take minutes to report them; "no checks reported" counts as red), squash-merge on green, then remove the
   worktree and delete the branch, locally and on the remote (`.claude/skills/dev-next/references/merge-and-ci.md`:
   never `--delete-branch` on a worktree). Red or still pending after the wait → say so and stop, naming the pull
   request first. One a person merges → it is not merged: tell the human, with its link, that it waits for their
   merge, and why.

```
| Group | Kind(s) and items | How much it matters | What it would touch | Decision | Where it went |
|---|---|---|---|---|---|
```

## Who merges

The mandatory rules, *Who merges*, decide the pull request this skill opens:

> An agent merges every pull request it makes in the project on its own — `/dev-next`'s stories (a `/dev-quick` run
> merges through it), planning, harvest and QA logs, reconciling, documentation, one made by hand — with
> `/dev-next`'s bar: never on red or pending checks ("no checks reported" counts as red), squash-merge, then delete
> the branch. […] **A person merges** a pull request that touches the PRD (`docs/PRDs/`), an ADR (`docs/ADRs/`:
> merging it is the person's approval), the UX prototype (`docs/ux/prototypes/`) or the project's `CLAUDE.md` (an
> agent never lands its own rules), even when the rest is bookkeeping, and the pull request of an `owner-merges`
> story; the agent merges one of these only on the person's explicit word for that one pull request, once its checks
> are green. Never merge an `outside-change` pull request: its repository's own reviewer does.

So, for the one pull request a harvest opens:

| Pull request | Touches | Merged by |
|---|---|---|
| `chore(harvest): …` — the bookmark, the changelog file, and any fixes and rule edits outside the paths below | none of `docs/PRDs/`, `docs/ADRs/`, `docs/ux/prototypes/` or the project's `CLAUDE.md` | the harvest itself, on green, with `/dev-next`'s bar (Phase 3, step 8) |
| `chore(harvest): …` — with a "yes" to the PRD question, a rule change in the project's `CLAUDE.md`, or a fix in an ADR or the prototype | any of those paths, beside the bookmark and the changelog file | **a person**; the bookmark waits with it |

A fix that would land in a repository this team does not own is never made here: it becomes a ticket carrying
`outside-change` and `needs-human` (Phase 1, step 7). The harvest merges a pull request of the second row only on the
person's explicit word for that one pull request, once its checks are green.

## Rules

- **Never start from `/dev-next`.** It counts; a person harvests.
- **One pile.** The audit branches are the only source — their `issue-<N>.json` reports only. The `qa-<N>.json`
  records beside them and `docs/harvest-qa-state.json` belong to `/harvest-qa` and are never read or written here.
- **Nothing already tracked is shown.** An item an open task covers, or a merged story fixed, goes straight to the
  pull request table.
- **Fewer tickets.** A single-item ticket needs a reason written in the issue body.
- **Nothing dropped silently.** Drop is the human's word, recorded in the commit message.
- **Nothing filed automatically.** Every ticket is the human's word, given in one of the questions or when a red fix
  is undone.
- **Kind and importance with every item.** The first words say which of the three kinds it is; one line says how much
  it matters and why. An item shown without both is not ready to ask.
- **Assume no context.** Everyday words, short sentences, the product part explained before the problem in it, no
  internal names (*Who you are talking to*, *How to explain each item*).
- **Audit branches are read-only here.** `git show`, never checkout, never commit, never merge.
- **No production, customer or personal data.** An item carrying any is reported as a blocking finding and copied
  nowhere (the project's data rules).
- **Names, not numbers**, in everything the human reads.
