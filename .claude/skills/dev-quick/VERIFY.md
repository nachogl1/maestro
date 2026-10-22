# VERIFY.md — what must hold for `/dev-quick` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`dev-quick` cannot run here until …". `/dev-quick`
files the issue and then hands it to `/dev-next`, so everything `/dev-next`'s own `VERIFY.md` checks applies too.

| Check | How | When it fails |
|---|---|---|
| `gh` is on the path and signed in to the repository `origin` points at | `gh auth status`; `gh repo view --json nameWithOwner` | Report: the skill searches, files and links issues through `gh` |
| GitHub Issues are enabled on that repository | `gh repo view --json hasIssuesEnabled` | Report: GitHub Issues are the only tracker this skill supports |
| `dev-next` is installed beside it | `.claude/skills/dev-next/SKILL.md` and `.claude/skills/dev-next/references/new-issue.md` exist | Report: the issue shape and the engine the issue is handed to live there; `orion update` restores them |
