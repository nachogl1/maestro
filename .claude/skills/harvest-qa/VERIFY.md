# VERIFY.md — what must hold for `/harvest-qa` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`harvest-qa` cannot run here until …".

| Check | How | When it fails |
|---|---|---|
| `git` and `gh` are on the path and `gh` is signed in to the repository `origin` points at | `git --version`; `gh auth status`; `gh repo view --json nameWithOwner` | Report: the skill reads the audit branches through `git` and files the bugs the person chooses through `gh` |
| GitHub Issues are enabled on that repository | `gh repo view --json hasIssuesEnabled` | Report: GitHub Issues are the only tracker this skill supports |
| The product can be started | The dev-server row of the commands table in `CLAUDE.md` holds a command, not `TBD` | Report: every QA check starts the product; without that row the skill stops in its first step |
| The worktree root and the port rule are named | The worktrees section of `CLAUDE.md` names a root outside the project and the `<base port> + issue number` rule | Report: the skill tests `main` in a worktree of its own on the base port; it cannot without them |
| `/dev-next` is installed | `.claude/skills/dev-next/references/audit.md` exists | Report: the QA records this skill reads are written by `/dev-next`; without it there is nothing to test |
