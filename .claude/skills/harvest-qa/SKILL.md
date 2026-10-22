---
name: harvest-qa
description: 'ORION - Run the QA checks that every merged /dev-next story leaves behind on the developers'' audit branches — against main, one agent at a time, in as many rounds as it takes until every record is tested — dropping records a later story has superseded or made obsolete, showing the person each confirmed failure with its importance and filing a bug issue only for the ones they choose, and keeping a log on main of what was tested, when, on which commit and with what result. Reads only the QA records; never the notes /harvest works through. Use when the user types /harvest-qa, or when a /dev-next run ended with `QA due: run /harvest-qa`.'
argument-hint: "(no arguments)"
disable-model-invocation: true
---

# /harvest-qa

> [!NOTE]
> **Editing this skill?** Keep everything here **general**: no project, person, company or stack names. It works with GitHub Issues only, like `dev-next`, whose `references/new-issue.md` and `references/audit.md` it relies on.

`/dev-next` builds, reviews and merges a story, but nobody starts the product and checks the acceptance criteria the way
a user would. This skill does that **later, against `main`**, from the QA record `/dev-next` writes for every merged
story (`.claude/skills/dev-next/references/audit.md`, *The QA record*). A person starts it; it then runs unattended
until every record is tested, asks the person what to do with each confirmed failure, and ends with one pull request
carrying its log.

It is the twin of `/harvest`, and the two never overlap: `/harvest` reads `runs/<run id>/issue-<N>.json` and writes
`docs/harvest-state.json`; this skill reads `runs/<run id>/qa-<N>.json` and writes `docs/harvest-qa-state.json`.
Neither reads the other's file, and neither writes an audit branch.

Read the project's `CLAUDE.md` first. It overrides this file where they disagree.

## Why one agent at a time

Every check starts the product. Two agents starting it at once share a port, a database and a build folder, and each
breaks the other's run in ways that look like product bugs. So the checks run in **rounds**: one `qa-<seam>` agent
alive at a time, the next spawned only when the previous has reported and stopped the product. Slow and right beats
fast and wrong here.

## Phase 0 — Gather

1. `gh auth status`; `git fetch origin` plus `git fetch origin 'refs/heads/audit/*:refs/remotes/origin/audit/*'` to see
   every developer's audit branch. Missing tool → stop and print the command that fixes it.
2. **The way to start the product.** The dev-server row of the commands table in the project's `CLAUDE.md`, plus the
   port rule from its worktrees section. Row missing or `TBD` → stop with one line: this skill cannot run until the
   project's `CLAUDE.md` names how to start the product. Nothing is logged, nothing is filed.
3. Read `docs/harvest-qa-state.json` if it exists:
   ```json
   {
     "tested_through": { "<login>": "<last run id tested>" },
     "carried": [ { "login": "<login>", "run": "<run id>", "issue": "<N>", "key": "<seam>/<flow>", "why": "<why it was not tested last time>" } ],
     "log": [
       { "login": "<login>", "run": "<run id>", "issue": "<N>", "key": "<seam>/<flow>", "result": "pass", "commit": "<main sha tested>", "date": "<yyyy-mm-dd>" },
       { "login": "<login>", "run": "<run id>", "issue": "<N>", "key": "<seam>/<flow>", "result": "fail", "bug": "<issue number>", "commit": "<main sha tested>", "date": "<yyyy-mm-dd>" },
       { "login": "<login>", "run": "<run id>", "issue": "<N>", "key": "<seam>/<flow>", "result": "fail", "dropped": "<the person's reason, or \"dropped by the person\">", "commit": "<main sha tested>", "date": "<yyyy-mm-dd>" },
       { "login": "<login>", "run": "<run id>", "issue": "<N>", "key": "<seam>/<flow>", "result": "superseded", "by": "<run id>/<N>", "date": "<yyyy-mm-dd>" }
     ],
     "last_qa": "<yyyy-mm-dd>"
   }
   ```
   No file → nothing has been tested yet. `carried` holds checks a previous run could not test (the product would
   not start, a check needs something the agent does not have); they are part of the pile again this run.
4. **The pile:** for every `origin/audit/<login>` branch, `git ls-tree -r --name-only origin/audit/<login> runs/`
   lists its files; keep `runs/<run id>/qa-<N>.json` whose run id is newer than that login's `tested_through` entry
   (run ids sort by time: `<repo>-<yyyymmdd-hhmmss>-<hex>`, in UTC). Read each with
   `git show origin/audit/<login>:runs/<run id>/qa-<N>.json` — **never check the branch out, never read an
   `issue-<N>.json`**. Collect every check with its `key`, the record's `story`, `seam`, `merged_at`, run id, issue
   number and login, plus every `carried` entry.

Nothing gathered → say so in one line, with the count, and stop.

## Phase 1 — Dedupe before anything runs (this is where the judgement is)

Records age. A later story often changes the same screen or command, and then an older record describes behaviour that
no longer exists. Testing it would file a false bug. Every record's `story` field says, in a user's words, what the
story changed and what it replaced — read it; it is there for this step.

1. **Superseded.** Two checks with the same `key` → the one from the record with the newest `merged_at` is tested; the
   older is logged `superseded` with `by` and counts as tested. Two checks whose keys differ but whose `story` texts say
   the later one replaced the earlier one's flow → same rule; say so in the log entry's `why`.
2. **Obsolete.** A check whose flow no longer exists on `main` (the story that removed it says so, or the screen or
   command is gone — confirm with a read of the code, never a guess) → logged `obsolete` with one sentence of evidence;
   counts as tested.
3. **Already tracked.** A check whose flow is the subject of an **open** `bug` issue (`gh issue list --state open
   --label bug --search "<key words>"`, plus the issues whose `### Seam` names the same folder) → not run; logged
   `tracked` with the issue number. A closed issue never counts: run the check.
4. **Nothing to test.** A record with an empty `checks` list (a documentation-only story) → logged `none` with the
   record's `no_qa_reason`; counts as tested.

Everything left is the plan. Group it by `seam`, and inside a seam keep the record order. Print the plan in one
table — check, where it came from (a run on <date> by <their name>, the story in plain words), what will be driven —
then start, saying in one line that the person is asked about each confirmed failure at the end, so they stay or
come back for it. No question is asked before the findings in phase 3; a person started this skill and expects it to
finish.

## Phase 2 — Rounds

1. One worktree of `main` for the whole run, so every round tests the same commit and no story's worktree is touched:
   `git -C <main checkout> worktree add --detach <wt root>/qa-<yyyymmdd-hhmmss> origin/main`. Record its commit:
   that is `commit` in every log entry this run writes. Resolve the runtime paths the way `/dev-next` does in its
   preflight (the pinned version's real interpreter and SDK, never the plain command on PATH) and pass them to every
   agent. **Keep the `qa-` prefix in the folder name**: it is how `/clear-git-resources` recognises a QA run's
   worktree and never touches it, so a sweep run mid-QA can never remove it.
2. The port: the project's port rule applied to issue number **0** (`<base port>` itself), which no story can hold.
   Any per-issue resource the rule derives (a database name) the same way.
3. **One agent per seam group, strictly in sequence.** Spawn `qa-<seam>` with the brief in
   `references/qa-agent.md`: the worktree, the start command, the port, the runtime paths, and that group's checks
   verbatim (steps, expected, the record's `story`). Wait for its report. Only then spawn the next. A finished agent
   re-invokes you on its own — **never schedule a wakeup or a `/loop`**.
4. An agent that reports the product would not start → every check in its group is `carried` with the reason, the
   remaining groups still run (a later group may start a different part of the product), and the close-out names the
   start failure first: that is a person's problem before it is a QA problem.
5. A `FAIL` is confirmed only when the agent reproduced it twice in the same session. Once is `carried` with
   `why: "could not reproduce"`, never a bug.
6. After the last round: `git -C <main checkout> worktree remove <wt root>/qa-<...>`.

## Phase 3 — Decide, log, ship

1. **The person decides every confirmed failure; this skill never files on its own judgement.** Two failures in the
   same flow are one finding. Search the open issues once more for each finding — the dedupe in phase 1 ran before the
   product was driven, and a teammate may have filed meanwhile. Then show the findings one at a time, most important
   first, each as one AskUserQuestion question in plain words: what was checked, what was expected, what was seen, the
   open issue that already covers it (if any) and its **importance** with one sentence on why — `critical` (data loss,
   security, a core flow unusable), `high` (a feature broken with no workaround), `medium` (broken, with a workaround)
   or `low` (cosmetic or minor). The options are `File a bug` and `Drop`, the recommended one marked (`Drop` when an
   open issue already covers it). No confirmed failure → straight to step 3.
2. **`File a bug`** → one `bug` issue, shaped per `.claude/skills/dev-next/references/new-issue.md`: the
   story's epic as the native parent; `### Seam` from the record; `### Acceptance criteria` = the check's expected
   behaviour; the body carries the exact steps, what was expected, what was seen, the commit tested and the record it
   came from (`audit/<login>`, run id, issue). Labels: `story`, `bug`, `tier:bug` and `needs-human`. That is this skill's choice
   for every QA bug it files: the failure was reproduced by an agent, not yet confirmed by a person, so nobody has
   checked that nothing is left to ask. Post its last comment right after creating it, saying what a person must
   confirm before flipping it to `agent-ready` (the steps reproduce for them, and nothing is left to ask). Read every
   issue back the way `new-issue.md` verifies it. **`Drop`** → nothing is filed; the check is logged `tracked` + `bug`
   when an open issue covers it, otherwise `fail` + `dropped` with the person's reason.
3. Write `docs/harvest-qa-state.json`: for every login read, `tested_through` = the newest run id seen this run;
   `log` = the existing log plus one entry per check this run decided (`pass`, `fail` + `bug` or `dropped`,
   `superseded` + `by`, `obsolete`, `tracked` + `bug`, `none`); `carried` = every check this run could not decide, each with its `why`;
   `last_qa` = today. A check in `carried` is **not** in `log`. Audit branches are never written to.
4. Branch `feat/harvest-qa-<yyyymmdd>` off `origin/main`, in a worktree of its own (never the main checkout);
   write the state file there and add the run's own changelog file,
   `docs/changelog/<YYYY-MM-DD>-<branch>.md` (one line; create the folder with a `README.md` explaining the format if it does not
   exist). **Run the
   gate** (the gate commands the project's `CLAUDE.md` lists: build → lint → typecheck → full suite) in that worktree
   before the pull request opens. Red → do not open it: this pull request only adds a state file and a changelog file,
   so red means `main` itself is red; the close-out names the failing command first, for a person to fix, and the
   worktree is kept so the log is not lost. Green → commit those two files (never `git add -A`), push, open the pull
   request; its body is the table below. **A human merges it** (or the agent, on the person's explicit word for this pull request) — this skill never merges on its own.

```
| Check (plain words) | From | Result | Where it went |
|---|---|---|---|
```

5. Close-out, always last, in plain words: how many checks were read, tested, passed, failed, dropped as superseded or
   obsolete, already tracked, carried; every bug issue filed, named by what it is about, and every failure the person
   chose not to file; the pull request link; and,
   first of all if it happened, that the product would not start and what the agent saw.

## Rules

- **Never start from `/dev-next`.** It counts; a person starts the QA.
- **`main` only.** A check runs against the merged result, never a branch; a failure is a bug on `main`.
- **One agent alive at a time.** The product is a shared resource; rounds are sequential, always.
- **QA records only.** `qa-<N>.json` is the one source; `issue-<N>.json` and `docs/harvest-state.json` are
  `/harvest`'s and are never read or written here.
- **A deduped check counts as tested.** Superseded, obsolete, tracked and nothing-to-test all go to the log with their
  reason, so the same record is never read twice.
- **Fewer bugs.** One issue per flow; nothing filed without the person's word; a failure reproduced once is carried,
  never shown as a finding.
- **Nothing dropped silently.** Every check this run read is in `log` or `carried`, each with a reason a person can
  check.
- **Audit branches are read-only here.** `git show`, never checkout, never commit, never merge.
- **No production, customer or personal data.** A check that needs real data is carried with that reason and reported
  in the close-out; the agent uses fixtures or made-up values only.
- **Never schedule a wakeup or a `/loop`.** A finished agent re-invokes you.
