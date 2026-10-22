# Audit — phase 6

Token cost and run timings **cannot be reconstructed afterwards** — local transcripts age out. The audit runs on every
run from the first, or the data is gone for good. It is also the evidence a team needs when it asks whether the agents
are saving time, and the only record the process can be improved from.

## Where it goes

A branch of your own, never `main`: `audit/<your github login>`. It is the one branch exempt from the pull-request and
`feat/` rules: pushed directly, never merged. Each run appends one file:

```
audit/<login>  →  runs/<run id>/issue-<N>.json
```

Your own branch means no two developers ever conflict, and it never touches the product's history.

## What it contains

```json
{
  "run_id": "<repo>-20250106-141233-a4f1",
  "issue": 31,
  "title": "Parse the settings section of an input file",
  "login": "<login>",
  "started_at": "2025-01-06T14:12:33Z",
  "finished_at": "2025-01-06T15:04:02Z",
  "outcome": "merged",
  "pr": 47,
  "summary": "Parses the settings section of an input file into the internal model; 6 new tests, no change to the output writer.",
  "agents": [
    { "name": "ready-check-31", "model": "sonnet", "tokens_total": 9100 },
    { "name": "dev-31",         "model": "opus",   "tokens_total": 163400 },
    { "name": "review-31-r1",   "model": "opus",   "tokens_total": 41100 }
  ],
  "phases": { "qa_seconds": 0, "dev_seconds": 2140, "review_seconds": 480, "ci_seconds": 190 },
  "rounds": { "review": 1, "ci": 1 },
  "friction": [
    "the review ran four rounds because each fresh reviewer found one new small thing — 40 min; the rule now stops at the confirming review"
  ],
  "lessons_learned": [
    "Input files need an explicit empty-section fixture; the parser's edge cases hide there"
  ],
  "deferred": [
    {
      "severity": "medium",
      "area": "src/<Area>/",
      "what": "The parser accepts a section with no fields and emits an empty element, which the downstream loader rejects",
      "why": "Out of scope for this issue; no fixture exercises it yet",
      "owner": "unowned — next harvest"
    }
  ]
}
```

The numbers in the example (issue, pull request, timestamps) are illustrative only.

- `outcome` is one of `merged`, `needs-human`, `failed`, `inherited-red` (the gate was already red on `main`; the story
  was released without blame and a `bug` issue opened — `SKILL.md` phase 3).
- `summary` is one or two sentences: what the issue was about and what shipped. Written for someone who never read the issue.
- `lessons_learned` is what the next run should do differently or know up front — about the code, the domain or the
  process. Empty list if none.
- **`friction`** is one line per thing that cost real time and should not have: a rediscovered command, a flaky step, a
  tool off PATH, a conflict that a smaller issue would have avoided. This is what the process gets improved from.
- **`deferred`** is every `Defer:` line the run produced — from the reviewer's verdict or the dev agent's report
  (`SKILL.md` phase 4, the findings rubric): a real problem outside the issue, too big for this pull request, that a
  later story or harvest should pick up. One object per finding: `severity` (`medium` or `high`; a `Critical:` becomes
  a GitHub issue instead, `SKILL.md` phase 4), `area` (the folder or module it lives in, so the harvest can group it
  and spot an open story on the same seam), `what` (one concrete sentence: what goes wrong and what a user or the next
  story would see), `why` (why it was not fixed here) and `owner` (a story only when that story's seam includes the
  fix, otherwise `"unowned — next harvest"`). Written by the **orchestrator**, never by a dev agent, and never as a
  file in the product tree. Empty list if none.

**The bar for all three lists — important or critical only.** A line goes in when leaving it would cost the next run
real time (ten minutes or a review round, not thirty seconds), mislead a user, lose data, or block another story.
Routine waits are not recorded: the merge slot, CI minutes, a fresh worktree's dependency install, a retry that worked
second time. A `low` finding is not recorded anywhere; if you are tempted to write it, it was either a `Fix now:` or
nothing. **Empty lists are the normal outcome of a clean run** — a harvest spends a person's time on every line, so a
line that does not change what someone does next is a cost, not a record.

All three lists are the **only** pile `/harvest` reads (the QA record below is `/harvest-qa`'s, and the two never cross); it decides with a person where each item goes — a fix, a
ticket, a rule, or nowhere. Nothing here is harvested automatically. Which run each branch has been harvested through
is kept in `docs/harvest-state.json` on `main`, written only by the harvest.

## The QA record — `qa-<N>.json`, beside the run report

A merged story also leaves one QA record on the same branch, `runs/<run id>/qa-<N>.json`, written by the orchestrator
from the dev agent's `QA checks` blocks and story (`dev-agent.md`). It is the only file `/harvest-qa` reads, and
`/harvest` never reads it; the two skills keep separate bookmarks on `main` (`docs/harvest-qa-state.json` and
`docs/harvest-state.json`). Only a `merged` outcome gets one.

```json
{
  "run_id": "<repo>-20250106-141233-a4f1",
  "issue": 31,
  "title": "Parse the settings section of an input file",
  "login": "<login>",
  "pr": 47,
  "merged_at": "2025-01-06T15:04:02Z",
  "merge_commit": "<sha of main after the merge>",
  "seam": "src/<Area>/",
  "story": "Before this story the importer ignored the settings section of an input file. It now reads the section into the model and shows its values on the import summary screen; an empty section shows 'no settings' where the screen used to be blank.",
  "checks": [
    {
      "key": "src/<Area>/import-summary",
      "criterion": "The import summary shows the settings read from the file",
      "steps": "Start the product. Open the import screen. Import the fixture input-03. Open its summary.",
      "expected": "A settings box listing every field of the fixture's settings section, in file order."
    }
  ],
  "no_qa_reason": null
}
```

- `seam` is the issue's `### Seam` line; `key` is `<seam>/<short flow name>` and the same flow keeps the same key
  across stories — that is how a later record supersedes an earlier one.
- `story` is the dedupe context: what changed, which screens or commands, what it replaced. Two to four sentences in a
  user's words, never a diff summary.
- `checks` is empty, with `no_qa_reason` filled, when the dev reported `QA checks: none` (a documentation-only story,
  a library with no surface). The record is still written, so the QA skill can log it as nothing to test.
- Steps carry made-up values or shipped fixtures only; a check that would need real data is not a check.

## What the token figures are — and what they are not

`tokens_total` is the one figure the Agent tool reports per sub-agent (it gives no input/output split), or `null`
when the tool reported nothing. A resumed agent reports a cumulative figure: record its last one.

The figure the Agent tool reports for a sub-agent is input + output + cache-write tokens. It **excludes cache reads**,
which are the bulk of an agent loop, and the orchestrator is not in this file at all. Treat the numbers as relative
(this run against that run), not as a bill. This file is the cost and timing record.

## Writing it without breaking anything

Use a separate worktree for the audit branch so the run's own worktree is untouched:

```
git -C <main checkout> worktree add <wt root>/audit-<login> audit/<login>
# write the file, commit, push
git -C <main checkout> worktree remove <wt root>/audit-<login>
```

If the branch does not exist yet, create it as an **orphan** — it carries no product history — straight into its
worktree, so no checkout ever switches branch:

```
git -C <main checkout> worktree add --orphan -b audit/<login> <wt root>/audit-<login>
```

Never let the audit block the run. If it fails, print the JSON into the run summary and carry on.
