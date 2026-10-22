---
name: harvest
description: 'ORION - Work through the one pile agents leave behind — the audit reports on every developer''s audit branch, which hold three kinds of note (a product problem left for later, something that slowed a run down, a tip for the next run) — with the person running it, in three waves (fix now, throw away or keep, then tasks), every item explained as if the person had never heard of the project, with its kind and how much it matters said out loud, never proposing anything an open task already covers, and grouping what belongs together into as few tickets as possible. Nothing is filed or dropped without the person''s word. Use when the user types /harvest, or when a /dev-next run ended with `Harvest due: run /harvest`.'
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

The first two words of every item's first line name its kind, in exactly those phrases. A group that mixes kinds says
so ("two product problems and one slow-down about the same screen").

## How to explain each item — plain language, every time

Every group and every item is shown in this shape, in this order, one short sentence per line:

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
   now open will hit it. The severity in the report is an input, not the answer: a medium three runs have hit is
   "worth doing soon"; a high that a merged story already removed is never shown at all (Phase 1, step 1).
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

Good: "A product problem left for later. The product keeps a record of every file it generates and who approved it,
so auditors can later prove where a change came from. Two agents noticed that this record does not save the time in
the same format everywhere. Both saw it while building the stories that write those records, last week, in one
developer's runs. Worth doing soon: three runs lost time over it, and the report auditors will read sorts generated
files by that time. If we leave it, that report will list files in the wrong order. I suggest a task for later: it
touches four files in that one area and nothing else is working there."

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
3. **Rate how much it matters** — `high` ("worth doing soon"), `medium` ("worth doing some day"), `low` ("probably
   never matters") — and write one line of concrete reasoning per item: runs hit, user impact, open stories affected.
   This line is shown to the person word for word (*How to explain each item*, line 5). Severity in the report is an
   input, not the answer.
4. **Group.** Items that touch the same folder, module, file, rule or skill phase become **one group**. Slow-downs
   repeated across runs are one group, ranked first. A group is what becomes a ticket, never a single item when a
   neighbour exists; in wave 3 the human may merge groups into one ticket. A group's rating is its highest item's. A
   group names how many of each kind it holds.
5. **Measure what acting on each group would touch** — counted, not guessed: the files and folders it changes, the
   tests that cover them (and whether a new test is needed), the open stories and in-flight issues that own the same
   folder (`### Seam` in their bodies, and the in-flight file — the list `/dev-next` keeps of stories being worked on
   right now), and whether it touches a repository this team does not own. One line, in plain words, e.g. "2 files in
   the import code, 1 test class, collides with the open search story".
6. **Write the explanation** in the shape and words of *How to explain each item*, for every item and every group.
   Without it the human cannot decide, and the harvest turns into a lesson; with it, most groups take one answer.
7. **Recommend a destination per group:**
   - **Fix now** — small, safe, clear; goes in this harvest's pull request.
   - **Rule change** — a line in the project's `CLAUDE.md`, a skill or a reference file; goes in this harvest's pull
     request. The usual home for a slow-down or a tip.
   - **Ticket** — real work for later; one GitHub issue per group (or per set of groups merged in wave 3), written to
     `.claude/skills/dev-next/references/new-issue.md` (the body headings, `story` plus exactly one readiness label
     and one tier label (`tier:bug` for a defect, else `tier:harvest`), the labels and the `### External reference`
     heading it prescribes when the work touches a repository this team does not own, native sub-issue of its epic,
     both blocker forms). The epic is the one the items came from when they share one, otherwise the human picks. `### References` names the audit runs the items came from.
   - **Add to an existing task** — an open story already owns the area but not this exact problem: a comment on that
     story (Phase 3, step 2); never on a `needs-human` story.
   - **Drop** — only on the human's explicit word, but **the recommendation for every item rated "probably never
     matters"**, with the reason it is not worth keeping said plainly; for any other item it is only offered as the
     alternative. An item is acted on, handed to a task, dropped, or carried to the next harvest.

## Phase 2 — Present and decide in waves (the touchpoint)

Nothing is filed, fixed or dropped automatically: the human decides every group. The aim is that deciding is fast and
easy — the explanation does the work, the recommendation is ready to accept, and questions are welcome.

1. Open with this, in these words or simpler, every run:
   - **What this does.** While agents build stories they write three kinds of note: a product problem they saw but
     were not allowed to fix, something that slowed their run down, and a tip for the next run. Today we go through the
     new notes together and decide, for each one: fix it now, make it a task for later, add it to a task that exists,
     or throw it away.
   - **What I already took off the list.** One line per item that an open task already covers or a merged story
     already fixed, each named in plain words — so the person knows these were seen and where they went — then the
     counts: items read, items taken off the list, items to decide, by kind.
   - **The goal.** As few new tasks as possible. Notes about the same part of the project become one task. Nothing is
     thrown away unless you say so.
2. Print the overview: every group as one line — kind(s), a plain title, how much it matters, the recommended
   destination, what it would touch — sorted into the three waves below.
3. Work the waves in order. Each wave: print its groups — per group and per item the seven lines of *How to explain
   each item*. Never a bare number (names, not bare numbers). Then ask with clickable options (`AskUserQuestion`, up
   to four groups per call, one question per group, the recommendation first and marked "(Recommended)", every label
   in plain words). The tool takes at most four options, so each wave offers only the ones named below; any other
   destination the human types under "Other". Tell the human what each wave is for in one plain sentence before it
   starts: wave 1 "quick fixes and rule changes I can do today", wave 2 "notes that are probably not worth keeping",
   wave 3 "bigger things that need a task for later".
   - **Wave 1 — fix now.** The small, safe fixes and rule changes proposed for this harvest's pull request. Options:
     fix now (or rule change), make it a task, throw it away, not this time.
   - **Wave 2 — throw away or keep.** The groups rated "probably never matters" — unless the fix is small and safe,
     which puts the group in wave 1: throw it away is the recommendation, with the reason. Options: throw it away,
     make it a task, add it to an existing task, not this time.
   - **Wave 3 — tasks.** The bigger groups. Options: make it a task, add it to an existing task, throw it away, not
     this time. Then one more question: how many tickets in all, with the recommended merge of groups that share an
     area.
   "Not this time" means the group is counted again next harvest (step 5).
4. **Expect questions and discussion.** A question gets a short plain answer — open the code or the run report to back
   it — and the wave carries on where it stopped; it never restarts. If the human asks "what does that mean?", the
   explanation was not plain enough: answer, then keep the rest simpler. A decision changed mid-wave replaces the
   earlier one.
5. Record every decision before acting on any. A group the human skips is written to `carried` in
   `docs/harvest-state.json` (Phase 3, step 5), because the branch pointer moves past it.

## Phase 3 — Act

All file changes go through **one** pull request on `feat/harvest-<yyyymmdd>` in a worktree (the project's git
rules: worktree root, branch pattern, who merges):

```
git -C <main checkout> worktree add <wt root>/harvest-<yyyymmdd> -b feat/harvest-<yyyymmdd> origin/main
```

`<wt root>` is `C:\wt` on Windows and `~/wt` elsewhere, unless the project's `CLAUDE.md` names another. A human merges
the pull request — this skill has no merge autonomy.

1. **Fix now** → make the change. **Rule change** → edit the rule file. Both in this pull request.
2. **Ticket** → create the issue exactly as `.claude/skills/dev-next/references/new-issue.md` says — body file,
   labels, native sub-issue, both blocker forms, verified with the read-back calls there — naming the audit runs the
   items came from under `### References`. Once, after the last ticket is created or edited, if the project keeps
   a PRD, ask the PRD question: **"Should we update the PRD with this too?"**, followed by one line per ticket saying
   what changed and which PRD section it touches.
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
   `carried` = every item the human skipped this run **plus every item carried in step 2** because its task was
   claimed or owned by someone (previous `carried` entries that were decided drop out);
   `last_harvest` = today. Audit branches are never written to.
6. **Run the gate** (the gate commands the project's `CLAUDE.md` lists: build → lint → typecheck → full suite) before
   the pull request opens. A fix that turns it red is undone, and the human is asked what it becomes instead (a task,
   or not this time); a new ticket asks the PRD question of step 2 again. The gate then runs again, and the pull
   request opens only on green.
7. Add the harvest's own changelog file, `docs/changelog/<YYYY-MM-DD>-<branch>.md` (one line; every pull request carries one), then commit with
   Conventional Commits (`chore(harvest): …`), **never `git add -A`**, push, open the pull request with the table below,
   and tell the human it waits for their merge.

```
| Group | Kind(s) and items | How much it matters | What it would touch | Decision | Where it went |
|---|---|---|---|---|---|
```

## Rules

- **Never start from `/dev-next`.** It counts; a person harvests.
- **One pile.** The audit branches are the only source — their `issue-<N>.json` reports only. The `qa-<N>.json`
  records beside them and `docs/harvest-qa-state.json` belong to `/harvest-qa` and are never read or written here.
- **Nothing already tracked is shown.** An item an open task covers, or a merged story fixed, goes straight to the
  pull request table.
- **Fewer tickets.** A single-item ticket needs a reason written in the issue body.
- **Nothing dropped silently.** Drop is the human's word, recorded in the commit message.
- **Nothing filed automatically.** Every ticket is the human's word, given in one of the waves or when a red fix is
  undone.
- **Kind and importance with every item.** The first words say which of the three kinds it is; one line says how much
  it matters and why. An item shown without both is not ready to ask.
- **Assume no context.** Everyday words, short sentences, the product part explained before the problem in it, no
  internal names (*Who you are talking to*, *How to explain each item*).
- **Audit branches are read-only here.** `git show`, never checkout, never commit, never merge.
- **No production, customer or personal data.** An item carrying any is reported as a blocking finding and copied
  nowhere (the project's data rules).
- **Names, not numbers**, in everything the human reads.
