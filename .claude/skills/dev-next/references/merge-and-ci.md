# Merge and CI — phase 5

Many repositories have no branch protection configured (a private repository under a personal account, say). Then
nothing on GitHub's side stops a bad merge, or a direct push. Whether or not protection exists, this file is the
enforcement. Follow it exactly.

**Never push to `main`.** Every change lands through `gh pr merge` on a pull request that exists and has been reviewed.
Full autonomy means the agent may open, review and merge that pull request — never that it may skip it.

## 0 · Take the merge slot

Read the in-flight file (`in-flight.md`). `merging` held with a `since` under 30 minutes → wait, re-read every 60
seconds; no elapsed-time limit — a live holder is bounded by its own 30-minute CI cap below, and a `since` older than
30 minutes is a dead holder whose slot is free. Free → write this issue **and your run id** into `merging`, wait 5
seconds, then **re-read**: any run id but yours means you lost the race — back off and wait again. Only your own run
id on the read-back means you hold the slot, and you **re-confirm that on every poll in step 2 and again immediately
before the merge command in step 4**. Hold it through steps 1-4, so the CI run in step 2 is on the `main` this branch
will actually land on, and no other terminal lands in between.

## 1 · Merge `main` in first, then push

```
git -C <wt root>/<N>-<slug> fetch origin
git -C <wt root>/<N>-<slug> merge origin/main       # never rebase, never stash
git -C <wt root>/<N>-<slug> push
```

CI must run on **what will actually land**, not on a stale base. When the merge says `Already up to date` and the push
has nothing to send, the CI run the reviewer read on the pull request's head is already the run for what lands: poll
that one, do not wait for a new one. If the merge conflicts, release `merging` and hand it
back to `dev-N` — the orchestrator does not resolve conflicts in application code.

## 2 · Poll for the check run, then watch it

GitHub can take **up to four minutes** to register a run. The first "no checks reported" is **not a verdict**.

```
# poll until a run id exists, up to ~5 minutes — find it here, never with `gh run list --commit <sha>`,
# which returns nothing on some gh versions (a run can then wait its full 30-minute cap on CI that finished long ago)
gh pr checks <P> --json name,state,link
# then, every 2-5 minutes until status is completed — a loop, not a blocking watch, at most 30 minutes in total
gh run view <run id> --json status,conclusion
```

Only once a run id exists does its state mean anything. Poll in a loop rather than `gh run watch`, because on every
poll you do two things in the in-flight file: **refresh `merging.since` to now** (a slot not refreshed for 30 minutes
is treated as dead by the others) and **re-read `merging.run`** — not yours → you lost the slot, stop polling, do not
merge, re-queue at step 0. **The poll loop is capped at 30 minutes**: a run still not completed by then is treated
exactly as red below, so a hung run can never hold the machine-wide queue.

**Every poll also reads `gh pr view <P> --json mergeable,mergeStateStatus`.** `CONFLICTING` or `DIRTY` → release
`merging` at once and hand the conflict to `dev-N` (step 1). GitHub registers no CI run on a conflicting head, so
waiting for one only burns the slot.

## 3 · The gate

CI is the project's own workflow (`.github/workflows/`), running the same gate chain the project's `CLAUDE.md` lists
(build → lint → typecheck → full suite). If the project's `CLAUDE.md` names the check that gates a merge, **that check
on the pull request is the gate**; otherwise every check that ran on the pull request must be green. A check that
shows `SKIPPED` on pull requests (a job that runs only on `main`, such as a publish or deploy job) is not red. Nobody
runs the suite locally a second time — the suite runs once per gate, never once locally and once in CI. If no CI exists,
or it does not run the full suite, the orchestrator runs the gate on the merged branch in the worktree before merging,
and that run is the gate.

- **Green** → merge.
- **Red** → release `merging`, then send the failure back to a fresh `dev-N` round; the branch re-takes the slot when
  it is ready again. **After two red rounds**: label `needs-human`, leave the branch, and **release the issue** — the
  failure as the last comment, `gh issue edit <N> --remove-label in-progress --remove-assignee @me`, its entry removed
  from the in-flight file (step 5 is never reached on this path) — then move on. A story still assigned is never
  eligible again, even once a person re-marks it `agent-ready`; a leftover `in-progress` only misleads the team.
- **Pending** → wait. Never merge on pending.
- **No checks reported, after the poll window expired** → this is **red**. Do not merge. Something is wrong with the
  workflow itself; **release `merging`**, label `needs-human` and **release the issue** exactly as for red (comment,
  `in-progress` removed, unassigned, in-flight entry removed), saying so in the comment.

## 4 · Merge and verify

```
# first: re-read the in-flight file — merging.run must be yours, else do NOT merge (in-flight.md, The merge slot, step 3)
gh pr merge <P> --squash               # no --delete-branch: step 5 deletes the branches
gh pr view <P> --json state           # must be MERGED; judge by this, not by the exit code
gh issue view <N> --json title,body,labels,comments,state   # state must be CLOSED
```

Use the merge method the project's `CLAUDE.md` names; squash is the default.

**As soon as `gh pr merge` returns — merged or failed — set `merging` to `null` in the in-flight file.** The slot is
held for minutes, never across the clean-up below. A **failed** `gh pr merge` is treated exactly as red in step 3: back
to step 0 once the cause is fixed, and after two failures `needs-human` with the issue released as in step 3.

If the issue did not close, the `Closes #N` line was missing or malformed. Close it manually and note it on the pull request.

## 5 · Clean up

```
git -C <main checkout> worktree remove <wt root>/<N>-<slug>   # "not a working tree" means already gone: fine
git -C <main checkout> worktree prune
git -C <main checkout> branch -D feat/<N>-<slug>            # "not found": fine
git -C <main checkout> push origin --delete feat/<N>-<slug> # "remote ref does not exist": fine
```

`worktree remove` refuses a worktree with untracked files. When the only ones are the dev agent's local environment
or build output (a virtual environment, a dependency folder, build output that is gitignored — the branch is merged
and pushed), `worktree remove --force` is expected; anything else untracked is reported, not forced.
List them with `git -C <wt> status --porcelain`, **never `--ignored`**: walking a dependency or build-output folder can
run past the shell timeout.

Why not `gh pr merge --delete-branch`: it cannot delete a local branch a worktree still holds, then skips the remote
delete and exits 1 after a successful merge; on some machines it removes the worktree itself. So the branches are
deleted here, after the worktree is gone.

Drop any per-issue resource the project's `CLAUDE.md` derives from the issue number (database, port). Kill any server
**by process id**, never by image or process name. Remove the issue's entry from the in-flight file — so the other
terminals see it is done.

## 6 · After the merge

If the project deploys from `main`, the gate in step 3 is the deployment gate too: a red or pending run never ships.
A bad deployment is corrected by the next pull request, never by rewriting history. Whatever the project's `CLAUDE.md`
says is never auto-applied (infrastructure, a migration against a shared database) stays that way; a migration that
has run against a shared database is corrected by a new one, never by rewriting the old one.

If a merge breaks `main` for everyone (the gate goes red on `main` itself), that is a `bug` issue opened immediately,
not a deferred line, **per `new-issue.md`**: every heading, the failing tests under `### Acceptance criteria`, labels
`story` + `bug` + `tier:bug` + `needs-human` (filed mid-run; the reason comment, its last, asks a person to confirm the failures and
flip it to `agent-ready`, after which `eligibility.md` ranks it first), native sub-issue of the merged story's epic,
and linked from that story's pull request. A second report of the same failures — another dev agent's `INHERITED RED` in the same run, or a
later run — links the existing issue instead of opening another.

**`main` can turn red with no commit.** A newly published dependency security advisory fails an install or audit step
the build treats as an error, while a local install stays green on cached advisory data. Re-run the package manager's
vulnerability listing with fresh data to reproduce what CI sees. The fix is a pin with a comment naming the advisory,
never switching the audit off; the red `main` is a `bug` issue as above.
