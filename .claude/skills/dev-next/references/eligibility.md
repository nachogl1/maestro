# Eligibility and ranking — phase 1

## Gather

```
gh issue list --state open --limit 100 --json number,title,labels,assignees,body
gh pr list --state open --json number,headRefName
git ls-remote --heads origin "feat/*"
gh api repos/{owner}/{repo}/issues/N/dependencies/blocked_by --jq 'map(.number)'   # per candidate: native blockers
```

One issue read in full uses the sanctioned form, because the plain one drops the body:

```
gh issue view N --json title,body,labels,comments
```

## Eligible — every one of these must hold

| Test | Why |
|---|---|
| Open | Closed work is done. |
| **Not** labelled `epic` | Epics are containers. Agents implement stories only. |
| Labelled `agent-ready` | Nothing is left to ask. An issue with no readiness label at all was put to the human in preflight (`SKILL.md` phase 0 step 8); if it is still unlabelled, it is not eligible. |
| **Not** labelled `needs-human` | Somebody has to answer it first. The reason is in the issue's last comment. |
| **Not** labelled `outside-change` | It touches a repository this team does not own; a human drives it to a pull request for that repository's reviewer. |
| **Not** carrying any `wayfinder:*` label (`wayfinder:map`, `wayfinder:research`, …) | Planning tickets belong to the planning skill, not to development. |
| No assignee | The assignee is the claim. Someone owns it. A run that gave up on a story unassigned itself (`SKILL.md`, the release rule at the top); an assignee left behind is a live claim. The `in-progress` label alone never blocks: it is a hint to people, removed on release with the assignee. |
| No open pull request with head `feat/N-*` | Work is already in flight. |
| No remote branch `feat/N-*` | A run may have crashed mid-flight; do not trample it. A released story whose branch stays for a human becomes eligible again once that person deletes the branch or takes it over. |
| Every blocker is **CLOSED** — in the body **and** in GitHub's native relation | Not "nearly done". Closed. Either place blocks. |

Blockers come from two places and the union counts. The body: take every `#N` on the lines under a `### Blocked by`
heading until the next heading. The native relation: the `dependencies/blocked_by` call above. An empty section, no
section, and an empty native list together mean nothing blocks it. If a referenced issue does not exist, treat the issue
as **not** eligible and say so — a typo'd blocker is a real problem, not an absent one.

## Rank the eligible ones

**A `bug` that turns the gate on `main` green comes before everything below.** Every story behind a red gate stops at
`INHERITED RED`, and a bug filed late carries a high number, so lowest-number ranking alone would put it last. This
skill files that bug as `story` + `bug` + `tier:bug` + `needs-human` (`new-issue.md`, the mid-run rule), so it passes the filter
above only once a person has confirmed the failures and flipped it to `agent-ready`; from then on it ranks first.

1. **An epic nobody else is working in.** Two people inside one epic collide even with no `Blocked by` between them —
   they invent the same seam and whoever lands second pays for the redesign. Prefer an empty epic over a busy one.
   **When another terminal holds a sibling of the same family** (stories that each extend one shared contract), prefer
   a candidate outside that family.
2. **Clustered with the first pick, but not overlapping it** — same epic, different seam. This only applies
   when more than one issue was asked for; the default run picks one and stops. Issues in one run share vocabulary; they
   must never share files, because they are developed **in parallel** and the second to merge pays for every conflict.
   If two bodies plausibly touch the same files, take the next candidate; if no safe extra pick exists, run fewer and
   say so. An issue `Blocked by` the first pick is never its pair. **Two stories that edit one shared file** — a
   project or build file, a shared configuration or threshold file, a shared contract type — are never a pair either.
3. **Labelled `agent-ready` before this run** ahead of one labelled in this run's preflight. The first runs straight
   through with no questions; the second gets a ready-check (`SKILL.md` phase 2).
4. **Lowest number.** Issues are numbered roughly in build order; lower means earlier.

## Zero eligible

Never report a bare "nothing to do". Diagnose and name:

- If everything is blocked → the blocking issue, its title, and who it is assigned to.
- If everything is claimed → who holds what.
- If only `outside-change` stories remain → say so: they need a human and the other repository's reviewer, not this skill.
- If the backlog is empty → say so plainly: the requirements have not been cut into issues yet, and that is the blocker.

## Claim contention

Re-read the issue immediately before the first write. If the assignee is now somebody else, it is theirs — pick the next
candidate and say nothing. If it is another of **your** runs, leave the assignment alone and pick the next candidate:
this terminal cannot tell whether that run is still alive.

**Same-second claims between two of your own runs:** the claim comment with the lower comment id is the earlier claim
and wins; the later run deletes its own comment, keeps the shared assignee and takes the next candidate.

`index.lock` means another terminal is mid-command. Wait 5 seconds and retry, up to 3 times.
