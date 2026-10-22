# VERIFY.md — what must hold for `/wayfinder` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`wayfinder` cannot run here until …".

| Check | How | When it fails |
|---|---|---|
| `gh` is on the path and signed in to the repository `origin` points at | `gh auth status`; `gh repo view --json nameWithOwner` | Report: the skill writes the map, its tickets, sub-issue links and blocked-by relations through `gh` |
| GitHub Issues are enabled on that repository | `gh repo view --json hasIssuesEnabled` | Report: GitHub Issues are the only tracker this skill supports |
| The project's `CLAUDE.md` names no other tracker | Read `CLAUDE.md`; a tracker other than GitHub Issues named as the source of truth | Needs a yes: that line contradicts the mandatory rules; propose deleting it |
| The issue calls it links with are installed | `.claude/skills/dev-next/references/new-issue.md` exists | Report: `dev-next` ships it; `orion update` restores it |
| The worktree root is named | The worktrees section of `CLAUDE.md` names a root outside the project | Report (not a failure of the install): needed only when a prototype or a PRD edit lands as a pull request |
| The gate commands are real | The build, full-suite, lint and typecheck rows of the commands table in `CLAUDE.md` hold a command, not `TBD` | Report (not a failure of the install): a pull request from this skill runs the gate before it opens; charting and working the map do not need it |
