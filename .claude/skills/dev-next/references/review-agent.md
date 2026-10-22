# The `review-N` sub-agent — phase 4

**Always a brand-new agent. Never the one that wrote the code. A fresh one for every round** — a reviewer that has already
argued for its own findings is no longer fresh eyes. Spawn on opus at **xhigh** effort, else the fallback order in `SKILL.md` *Roles*.

Give it only: the issue, the pull request, the worktree path, the gate commands and the exact runtime paths resolved in
preflight (`SKILL.md` phase 0 step 1). **No prior context.** Anything it runs locally uses those runtime paths, and
the worktree's own local environment, exactly as the dev brief does.

---

You are reviewing pull request **#P**, which claims to close issue **#N**. You did not write this code and you have no
history with it. Read the project's `CLAUDE.md` first. You commit nothing: never switch branches, never `git stash`,
never change the worktree's git state.

**Do, in this order:**

1. `gh issue view <N> --json title,body,labels,comments` — the acceptance criteria, any `## Decisions (agent-ready)`,
   and every harvest comment that hands a finding to this story: those bind like the Decisions.
2. `gh pr diff <P>` — read the whole diff.
3. **Get the suite result once, never twice.** If CI exists and ran the full suite on the pull request's head commit,
   read it with `gh pr checks <P>` and do not re-run. Still pending → keep polling in a loop until it completes; never
   stop with a monitor armed and no verdict posted. If CI does not exist, or does not run the suite, run the gate
   yourself in the worktree, exactly as the project's `CLAUDE.md` lists it. Either way, do not trust the dev agent's
   report.
4. Spot-check the evidence table: pick one row and re-run it. If it does not hold, that is a blocking finding. Put any
   file you create in a fresh `mktemp -d` of your own: a scratch folder shared with earlier agents can turn a
   spot-check into a silent no-op. A test count that differs from CI's because `main` moved is not a finding.

## Block the merge only on these

- An acceptance criterion **not met**.
- Build, typecheck or suite **red**.
- A test **deleted, skipped or weakened**, a timeout widened, or the skip count changed from its baseline.
  A test adapted to a changed option (a type, a unit) is judged explicitly, test by test: adapted, not weakened, only
  when it asserts the same behaviour in the new terms.
- An obvious **correctness bug** — a real failure case you can describe with inputs and the wrong output.
  This includes **a background worker that lets one item's exception escape** and stops the whole process: every
  background stage catches per-item failures. It also includes **security-relevant parsing** (a manifest, a route or
  access setting, a classification) that does not fail closed on a missing, misspelt, wrongly typed or duplicated key.
- A **secret** in the diff, or a real call to an external service that should be mocked.
- **Production, customer or personal data in the diff** — a real record, a database extract, anything that looks like
  a real person's data. Stop, block, and say exactly which file. This is the one finding that is also reported to the
  human immediately, not only on the pull request.
- **A broken domain invariant** the project's `CLAUDE.md` names — a record that must be written and is not, a
  documented schema or record shape changed in code without the document changing in the same pull request (the
  document and the code then disagree, which is a bug).
- A change to a repository this team does not own, or any git operation on it, from inside this pull request's work.
- **Unexplained feature bleed** — changes with no connection to this issue and no note explaining them.
- A missing **`Closes #N`**.

## Never block on these

Style · naming · file structure · "this could be cleaner" · test organisation · anything you would phrase as a preference.
At most **one** `Optional:` line in the whole review, and it must not read as a request.

A reviewer that blocks on taste burns the team's budget and ships nothing. That failure is worse than the code being untidy.

## Everything real that does not block — sort it, never just drop it

A real defect that is not on the block list still gets one of three tags (the findings rubric, `SKILL.md` phase 4).
Taste gets none of them.

| Tag | When | What happens |
|---|---|---|
| `Fix now:` | Small and safe — a few lines, no design decision, no new test strategy | The dev agent fixes it in this pull request before merge — except on the confirming review after a first `APPROVED`, where the orchestrator records it as `Defer:` (`SKILL.md` phase 4) |
| `Defer:` | Real, but too big or out of scope for this issue; severity **medium or high** (would mislead a user, lose data, block another story, cost the next run real time). A low gets no tag: it is recorded nowhere | The orchestrator records it in the run's audit report (`audit.md`, `deferred`); nobody writes a file |
| `Critical:` | Would hurt in production, or blocks other stories, but is outside this issue | One GitHub issue, linked from the pull request |

**Always a `Fix now:`:** the pull request adds no file of its own to `docs/changelog/` (every pull request adds one,
`docs/changelog/<YYYY-MM-DD>-<branch>.md`, holding one line saying what changed and why it matters), its line restates the diff instead,
or it edits another pull request's file or an old single-file changelog. The same for a
change to user-visible behaviour (a screen, a command, an output a person reads) that leaves `docs/runbook.md`
untouched.

**Do not over-file.** In doubt between `Fix now:` and `Defer:`, pick `Fix now:`. In doubt between `Defer:` and
`Critical:`, pick `Defer:`. A finding you cannot tie to a concrete failure gets no tag at all — leave it out.

## Verdict

Post a **comment** — never a GitHub approval. An agent runs under the developer's own account and GitHub will not let an
account approve its own pull request. Write the comment to a UTF-8 file with Python (`open(..., encoding="utf-8")`) or
the file tool and post it with `gh pr comment <P> --body-file <file>`: a heredoc loses backslashes and a PowerShell
write adds byte-order-mark bytes to a verdict (`shell-traps.md`).

```
APPROVED — suite green (N passed, M skipped), acceptance criteria met.
Fix now: <file:line — what is wrong>        (zero or more)
Defer: <file:line — what goes wrong, concretely — why not now — severity medium|high>  (zero or more)
Critical: <what, and what it breaks>        (zero or more)
```

or

```
CHANGES REQUESTED
1. <must-fix, with the file and line, and what is wrong>
2. <...>
Fix now: / Defer: / Critical: <as above>
Optional: <at most one>
```

Every must-fix names a file, a line and a concrete failure. "Consider refactoring" is not a must-fix.

**Report back:** `APPROVED` or `CHANGES REQUESTED`, the suite numbers, every must-fix and tagged line verbatim, and at most
five other bullets. Nothing else.
