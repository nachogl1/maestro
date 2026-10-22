# Writing a new issue

The checklist for every issue this skill files — a `Critical:` finding (`SKILL.md` phase 4) or the `bug` for a red
gate on `main` (`SKILL.md` phase 3, `merge-and-ci.md` *After the merge*) — and the shape it expects
of every issue it takes, whoever filed it: a harvest ticket (`/harvest`), a story cut by a planning process, a
ticket a person writes by hand, or one an agent files from a chat request with no skill running ("file this bug")
(this file **is** the shape; there is no separate issue template to keep in step with it). Where the project's
`CLAUDE.md` defines its own issue shape, that wins. **No step here is optional**: an
issue missing a blocker looks unblocked and is taken too early; one missing a readiness label stops the dev skill's
preflight; one missing its epic link is invisible to anyone browsing the epic.

## 1 · Body — the headings every story carries

Copy the shape of the existing stories. Headings, in this order:

| Heading | What goes under it |
|---|---|
| `### Epic` | `#<N> — <title>` of the parent epic. One line. The native sub-issue link (step 3) is set as well — this line is for the reader, the link is for GitHub. |
| `### Goal` | One or two lines: what is true when the story is done, with the requirements section it serves (if the project keeps a requirements document). |
| `### Scope` | `**In**` and `**Out**` bullet lists. Name what the story **reuses** — an existing configuration option, a record type and whether its fields may be null — and say plainly when something it builds on does not exist yet. Each of these otherwise surfaces only in review. |
| `### Seam` | **The folder or module this story owns** (`src/<Area>/`, `.claude/skills/<name>/`, …). Two open stories on the same folder, **record type or interface** are merged into one, or one blocks the other — never left to collide (two stories in different folders that both stored the same records still collided at merge). Check with `gh issue list --state open --label story --search "<folder>"` before filing. |
| `### Acceptance criteria` | Checkbox list; every behaviour has a test. A criterion an agent cannot meet alone — one that needs credentials it does not hold, a call to a live service, or a person's act — is **split into its own `needs-human` story naming the person**, which the agent-ready story does not wait for; left inside an `agent-ready` story it closes on merge still open. Before labelling `agent-ready`, read every criterion against the project's standing rules (its `CLAUDE.md`): one that needs a repository the team does not own built or run, or a skipped test, makes the story `needs-human`. A story that changes user-visible behaviour carries the criterion "`docs/runbook.md` updated in the same pull request". |
| `### References` | The requirements sections and the issues the story came from. A harvest ticket names the audit runs its items came from (`audit/<login>`, run id, issue); an issue filed while working on another names that work's pull request (step 5). |
| `### Blocked by` | One line per blocker, `#<N> — <title>`, or `(none)`. Every line here is also set as a native relation (step 4). An existing open issue that already covers part of the work is a blocker here, never a duplicate ticket. |
| `### External reference` | **Only** when the work touches a repository this team does not own: that repository's own work-item key or change number. Its presence means the labels in step 2 are `outside-change` + `needs-human`. |
| `### Evidence expected` | What the pull request's evidence table must show. |

**A family of sibling stories that each extend one shared contract** (a shared type, a shared project file, a shared
threshold or configuration file) gets the shared contract as **its own first story**, and every sibling is blocked by
it. Filed without it, the siblings cost review rounds and merge conflicts. **Check what the ticket names against
`main`**: every folder under `### Seam` exists (`ls`), and every file the ticket says to delete still exists.

End with a process footer:

```
---
Process: claim by assigning yourself; start only when every issue under `### Blocked by` is CLOSED; worktree, `feat/<issue>-<slug>`, fresh-agent review, merge on green, evidence table in the PR.
```

Write the body to a UTF-8 file and pass `--body-file` (PowerShell adds a byte-order mark; bash heredocs break on
apostrophes — `shell-traps.md`). Names, not bare numbers, in the title and the body: say what a referenced issue is
about, never only its number.

## 2 · Labels — `story` plus exactly one readiness label

| Situation | Labels | Where the reason lives |
|---|---|---|
| Nothing is left to ask; an agent can build it unattended | `story`, `agent-ready` | — |
| A person must act or decide first | `story`, `needs-human` | The **last comment** on the issue says what the person must do. Post it right after creating the issue. |
| Touches a repository this team does not own (has an `### External reference`) | `story`, `outside-change`, `needs-human` | Last comment, as above. `outside-change` never travels alone. |

`agent-ready` and `needs-human` never sit on one issue together. An issue filed mid-run — a `Critical:` finding or the
`bug` for a red `main` — is `needs-human` by default: nobody has yet checked that nothing is left to ask. Pass the labels on creation
(`gh issue create --label story --label needs-human --label tier:<name> …`); `bug` is added when the issue reports a defect.

**Every story also carries exactly one tier label, `tier:<name>`**: what the story is for, so anyone reading the list
sees it. An epic never carries one. The first line that fits decides:

| The story | Tier |
|---|---|
| Was cut from a PRD (by `/prd-to-tickets`, `/reconcile-issue-map` or a person writing PRD work) | The tier the PRD gives that work, lowercase with spaces as hyphens: `tier:mvp`, `tier:stretch`, `tier:stretch-2`. A PRD that gives that work no tier → ask the person, `mvp` recommended. |
| Reports or fixes a defect (a red `main`, a QA failure, a defect found anywhere else) | `tier:bug` |
| Was filed by a skill for any other reason | The skill's name: `tier:dev-quick`, `tier:harvest`, `tier:wayfinder`, `tier:dev-next` (a `Critical:` finding that is not a defect) |
| Was written by a person, outside any PRD, or asked for in chat with no skill running | `tier:manual` |

A tier label the repository does not have yet is created before the issue is filed: when
`gh label list --limit 200 --json name --jq '.[].name'` does not list it, `gh label create "tier:<name>" --description
"Tier: <name>" --force` (`--force` so a run that created it a moment earlier is no error). The tier is for readers
only: **nothing picks or orders work by it**.

Verify: `gh issue view <N> --json labels --jq '.labels[].name'` lists `story`, exactly one readiness label and exactly
one `tier:*` label (plus `bug` when the issue reports a defect). A label missing here is added with `gh issue edit <N>
--add-label <name>` before the issue is left.

## 3 · Epic link — native sub-issue, never a text list

The API takes the issue's database `id`, not its number. Look the id up, then add the child to the parent:

```
gh api repos/{owner}/{repo}/issues/<child number> --jq .id
gh api repos/{owner}/{repo}/issues/<epic number>/sub_issues -X POST -F sub_issue_id=<child id>
```

Verify: `gh api repos/{owner}/{repo}/issues/<epic number>/sub_issues --jq 'map(.number)'` lists the child.
When no epic fits, the human picks one; a story never hangs loose.

## 4 · Blockers — both forms, same pass

For every line under `### Blocked by`:

```
gh api repos/{owner}/{repo}/issues/<blocker number> --jq .id
gh api repos/{owner}/{repo}/issues/<new number>/dependencies/blocked_by -X POST -F issue_id=<blocker id>
```

Verify: `gh api repos/{owner}/{repo}/issues/<new number>/dependencies/blocked_by --jq 'map(.number)'` matches the
body section exactly. The dev skill blocks on the union of the two (`eligibility.md`), so a mismatch is a bug in the
ticket, not a tolerance.

## 5 · After filing

- An issue filed while working on another — a `Critical:` finding (`SKILL.md` phase 4) or one a person files
  mid-session — is linked from that work's pull request, and names it under `### References`. Without both links
  nobody can tell later when or why it was filed. No pull request open yet → add the link to its body when it opens.
- A session with a person present that keeps a requirements document asks once, after its batch of tickets: **"Should
  we update the PRD with this too?"**, one line per change naming the PRD section it touches. The dev skill's
  `Critical:` and red-`main` filing runs unattended and never asks.
- The issue map (`/issue-map`) draws the new issue, its epic link and its blockers on its next run; a body section
  and a native relation that disagree show up in the map's footer as a mismatch.
