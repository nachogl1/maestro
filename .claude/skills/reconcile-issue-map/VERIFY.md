# VERIFY.md — what must hold for `/reconcile-issue-map` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`reconcile-issue-map` cannot run here until …".

| Check | How | When it fails |
|---|---|---|
| `git` and `gh` are on the path and `gh` is signed in to the repository `origin` points at | `git --version`; `gh auth status`; `gh repo view --json nameWithOwner` | Report: the skill reads and edits issues, sub-issue links and blocked-by relations through `gh` |
| GitHub Issues are enabled on that repository | `gh repo view --json hasIssuesEnabled` | Report: GitHub Issues are the only tracker this skill supports |
| The project's `CLAUDE.md` names no other tracker | Read `CLAUDE.md`; a tracker other than GitHub Issues named as the source of truth | Needs a yes: that line contradicts the mandatory rules; propose deleting it |
| The issue shape it checks against is installed | `.claude/skills/dev-next/references/new-issue.md` exists | Report: `dev-next` ships it; `orion update` restores it |
| A PRD exists to reconcile against | At least one `docs/PRDs/*.md` | Report (not a failure of the install): without a PRD only the map-health lens runs; `/wayfinder` helps find the way to one |
| The worktree root is named | The worktrees section of `CLAUDE.md` names a root outside the project | Report: the PRD edit and the bookmark are written in a worktree and land as a pull request |
| The bookmark, when present, is sound | `docs/reconcile-state.json` parses as JSON and `git cat-file -e <reconciled_at>` succeeds on `main` | Report: a broken bookmark makes every PRD change look new; the next `/reconcile-issue-map` run rewrites it |
