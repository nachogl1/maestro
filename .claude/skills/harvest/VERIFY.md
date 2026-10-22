# VERIFY.md — what must hold for `/harvest` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`harvest` cannot run here until …".

| Check | How | When it fails |
|---|---|---|
| `git` and `gh` are on the path and `gh` is signed in to the repository `origin` points at | `git --version`; `gh auth status`; `gh repo view --json nameWithOwner` | Report: the skill reads the audit branches through `git` and files tickets, sub-issue links and blocked-by relations through `gh` |
| GitHub Issues are enabled on that repository | `gh repo view --json hasIssuesEnabled` | Report: GitHub Issues are the only tracker this skill supports |
| The project's `CLAUDE.md` names no other tracker | Read `CLAUDE.md`; a tracker other than GitHub Issues named as the source of truth | Needs a yes: that line contradicts the mandatory rules; propose deleting it |
| `/dev-next` is installed | `.claude/skills/dev-next/references/new-issue.md` and `.claude/skills/dev-next/references/audit.md` exist | Report: the reports this skill reads are written by `/dev-next`, and its tickets follow `new-issue.md`; `orion update` restores both |
| The labels its tickets carry exist | `gh label list --limit 200 --json name --jq '.[].name'` lists `story`, `agent-ready`, `needs-human`, `outside-change` | Report (not a failure of the install): `/dev-next` creates any that are missing in its preflight |
| The gate commands are real | The build, full-suite, lint and typecheck rows of the commands table in `CLAUDE.md` hold a command, not `TBD` | Report: the harvest's pull request runs the gate before it opens; with a `TBD` row it cannot |
| The worktree root is named | The worktrees section of `CLAUDE.md` names a root outside the project | Report: the harvest's fixes, rule changes and bookmark are written in a worktree and land as a pull request |
| The bookmark, when present, is sound | `docs/harvest-state.json` parses as JSON | Report: a broken bookmark makes every report look new; the next `/harvest` run rewrites it |
