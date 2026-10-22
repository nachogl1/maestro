# VERIFY.md — what must hold for `/prd-to-tickets` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`prd-to-tickets` cannot run here until …".

| Check | How | When it fails |
|---|---|---|
| `gh` is on the path and signed in to the repository `origin` points at | `gh auth status`; `gh repo view --json nameWithOwner` | Report: the skill files epics, stories, sub-issue links and blocked-by relations through `gh` |
| GitHub Issues are enabled on that repository | `gh repo view --json hasIssuesEnabled` | Report: GitHub Issues are the only tracker this skill supports |
| The project's `CLAUDE.md` names no other tracker | Read `CLAUDE.md`; a tracker other than GitHub Issues named as the source of truth | Needs a yes: that line contradicts the mandatory rules; propose deleting it |
| The issue shape it files to is installed | `.claude/skills/dev-next/references/new-issue.md` exists | Report: `dev-next` ships it; `orion update` restores it |
| A PRD exists to split | At least one `docs/PRDs/*.md` | Report (not a failure of the install): the skill has nothing to split until a PRD exists; `/wayfinder` helps find the way to one |
| The worktree root is named | The worktrees section of `CLAUDE.md` names a root outside the project | Report: the prototype sub-agent and a PRD update each need a worktree |
