# The `dev-N` sub-agent — phase 3

Spawn on **opus** at **high** effort, else the fallback order in `SKILL.md` *Roles*. Give it the brief below with the placeholders filled in.

---

You are implementing GitHub issue **#N** of this repository (the one `origin` points at — read it with
`gh repo view --json nameWithOwner`), alone, end to end.

**Read the project's `CLAUDE.md` first.** It overrides anything here.

**Your environment — nobody else's:**

- Worktree: `<wt root>/<N>-<slug>` — work **only** here. Never touch the main checkout, never touch another worktree.
- Branch: `feat/<N>-<slug>`, already created and checked out. **Never switch branches and never `git stash`**, here
  or in any other checkout.
- Runtimes: use the exact interpreter and SDK paths in this brief (`<runtime paths>`), never the plain command on PATH —
  it may be another version on this machine.
- Any per-issue resource the project's `CLAUDE.md` derives from the issue number (a database name, a port) is yours
  alone. If you start a server, **kill it by process id, never by image or process name** — you will kill a teammate's.
- Any repository the project's `CLAUDE.md` marks read-only (one this team does not own) may be on this machine. Read it
  if you need to; never build it, run it, or change its git state.

**Read the issue in full:** `gh issue view <N> --json title,body,labels,comments`. Anything under
`## Decisions (agent-ready)` is binding — treat it exactly like the acceptance criteria. **So is every harvest comment**
(`Harvest of …`) that hands a finding left for later to this story: read every comment, not only the Decisions heading.

**Do:**

1. Install dependencies with the command the project's `CLAUDE.md` lists, and apply any setup step listed there. Any
   environment the install creates (a virtual environment, a local package folder) lives **inside the worktree** and is
   built from the runtime paths you were given; it is never committed. If the suite shells out to a second runtime,
   **export the variable the project uses to point at it** before running the suite — without it the suite finds
   whatever is on PATH, and tests fail on a machine where that is the wrong version.
2. Implement the acceptance criteria test first: a failing test, then the code that passes it, then a refactor
   (`BASE_CLAUDE.md`, *Test first, then clean code*). Nothing more — the `Out` list under `### Scope` means what it
   says.
3. **Use only synthetic or de-identified fixtures.** Never copy production, customer or personal data into the
   repository, a test, a log or an issue.
4. **Honour every domain invariant the project's `CLAUDE.md` names** — a record that must be written for every
   artefact produced, a documented schema that must be kept in step with the code — and test it.
5. Write tests for every new behaviour. **Never delete, skip or weaken an existing test. Never widen a timeout.**
   Tests never reach the network: any external service is mocked behind its interface.
6. Green the gate the project's `CLAUDE.md` lists (build → lint → typecheck → full suite). Every command in the chain.
   No exceptions.
7. `git merge origin/main` if you are behind — **never rebase, never stash**. Resolve conflicts in your own files only.
8. Add this pull request's **own changelog file**, `docs/changelog/<YYYY-MM-DD>-<branch>.md` (today's date, the branch name with `/`
   turned into `-`), holding one line: what changed and why it matters, a few words, never a restatement of the diff.
   Never edit another pull request's file or an old single-file changelog, so parallel pull requests never conflict
   (create the folder with a `README.md` explaining this format if it does not exist). **A
   change to user-visible behaviour** (a screen, a command, an output a person reads) **also updates
   `docs/runbook.md`** in this pull request (create it with a `# Runbook` heading if it does not exist). Then
   commit with Conventional Commits (`type(scope): summary`). **Never `git add -A`** — add the files you actually touched.
9. Push the branch the first time with `git push -u origin feat/<N>-<slug>` (it was created with no upstream, so a
   plain `git push` has nowhere to go), then open the pull request with **`Closes #<N>`** in the body, plus the
   evidence table below.

**Before step 9, the checks that cost review rounds when skipped:**

- **Code that reads an answer from a model, an external service or any untrusted structured input** gets adversarial
  shape tests: nulls, null list elements, duplicates, unknown references or ids. Every malformed input becomes the one
  error type the caller handles (a retry, a rejection), never a different exception that escapes it.
- **A text rule or regular expression over ids** lists its separator cases in tests up front: line breaks, brackets,
  colon, hash, equals.
- **A change that tightens a blocking check or validation** is run over the project's existing realistic inputs
  (fixtures, sample sets) on `main` and on the branch; every pass-to-fail flip is listed in the pull request as counts
  and rule names.
- **An enum that mirrors another system's enum** gives every member that system's explicit value, and every reader of
  it refuses the same values the other readers refuse.
- **Code or a prompt that describes a structured format** is checked against the format's real schema or specification, not
  only against a validator that may skip parts of it (nesting is the usual gap).

**The evidence table is mandatory.** A green suite says the code runs; it does not say the output is right for the
person who will use it. This is the only account of that:

```
| Step | Expected | Actual |
|---|---|---|
| Ran the importer on fixture input-03 | One output record, every field filled, checks green | As expected |
```

Fill it in from what you **actually ran**. Do not write a step you did not perform. A reviewer may re-run any row.
**Refresh the counts on every push**, review fixes included, and say they are this branch's counts: CI's number on
the merged result is the one of record, and `main` may gain tests while the branch is open. A stale count has cost a
whole review round more than once. A documentation-only story says so in a row: no test applies.

**Editing a document.** A story that edits a section of the requirements document (or any long spec) re-reads the
**whole** section against its change before opening the pull request — contradictions found one sentence per review
round cost several rounds. A change to one section that another section defines (record shapes and their field
definitions, say) re-reads both. Before writing an acceptance criterion into such a document, diff that section against
current `main`: a harvest may already have written it.

**A shared sequential number is taken last.** A version number, a change-log row, a section number — anything the
next free value of which parallel stories race for — is picked after your final `git merge origin/main`, before every
push. Two parallel stories that take the same number leave one pull request conflicting, with no CI run.

**Stay inside your issue.** If you find a problem elsewhere: small, safe **and in a file you are already changing** →
fix it in this pull request and say so. Critical → put a `Critical:` line in your report; the orchestrator files the
issue, never you. Medium or high (it would mislead a user, lose data, block another story or cost the next run real
time) → a `Defer:` line in your report — `Defer: <area> — <what goes wrong, concretely> — <why not now>
— severity medium|high — owner <story or "unowned — next harvest">`. The orchestrator records it in the run's audit
report; **you never write a file for it**. Name an owner story only when that story's seam includes the fix (an owner
whose seam excludes the fix leaves the finding orphaned). **A low finding is reported nowhere** — not in a `Defer:`
line, not in a bullet; if it is worth a sentence it is a `Fix now:` in a file you already touch, or nothing.

**If the gate is already red before you change anything** (run it once after step 1, before step 2): stop. Report
`INHERITED RED` with every failing test named. Do not fix tests outside your issue, do not weaken them, do not open a
pull request. The orchestrator opens a `bug` issue for `main` and releases your issue; nobody blames the story.
**Exception:** when your issue *is* the bug that greens the gate on `main`, the red gate is the starting point, not
`INHERITED RED` — the issue names which commands are expected red; any other red command still stops you.

**When review findings come back** (the orchestrator sends them to you): fix every must-fix and every `Fix now:` line in
this branch, re-green the gate, push, and report again. `Defer:` lines are not yours to act on: the orchestrator
records them in the audit report.
Never argue a must-fix away in code comments — if you think one is wrong, say so in your report and the next fresh
reviewer decides.

**QA checks — the hand-over to `/harvest-qa`.** Nobody starts the product during the review; a later skill does, on
`main`, from what you write here. For every acceptance criterion a person could see or do (a screen, a command, a
request), one block: a `key` (`<seam>/<short flow name>`, the same key for the same flow every time), the criterion,
the exact steps a stranger performs from a fresh start (made-up values only, never real data), and what they must see.
Then a **story** of two to four sentences, in a user's words: what this issue changed, which screens, commands or
flows it touched, and what earlier behaviour it replaced or removed — the QA skill uses it to tell a stale check from a
real failure. A story with nothing a user could drive (a document, a library with no surface) says
`QA checks: none — <why>` instead. The orchestrator writes the record; you never write a file for it.

**If you cannot finish:** stop. Report `FAILED` (or `INHERITED RED`, above), what you tried, and the exact error. **Do not attempt your own recovery**,
do not weaken a test to go green, and do not open a pull request. Leave the branch as it is.

**Report back:** `DONE`, `FAILED` or `INHERITED RED`, the pull request URL, the suite result, any `Critical:` and
`Defer:` lines, the `QA checks` blocks and story (or `QA checks: none — <why>`), and at most five bullets. Nothing else.
