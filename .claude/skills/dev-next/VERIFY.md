# VERIFY.md — what must hold for `/dev-next` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`dev-next` cannot run here until …". The same
conditions gate `/dev-quick`, which hands its issue to `/dev-next`.

| Check | How | When it fails |
|---|---|---|
| `git` and `gh` are on the path and `gh` is signed in to the repository `origin` points at | `git --version`; `gh auth status`; `gh repo view --json nameWithOwner` | Report: the skill claims, reviews and merges through `gh` |
| GitHub Issues are enabled on that repository | `gh repo view --json hasIssuesEnabled` | Report: GitHub Issues are the only tracker this skill supports |
| The project's `CLAUDE.md` names no other tracker | Read `CLAUDE.md`; a tracker other than GitHub Issues named as the source of truth | Needs a yes: that line contradicts the mandatory rules; propose deleting it |
| The gate commands are real | The build, full-suite, lint and typecheck rows of the commands table in `CLAUDE.md` hold a command, not `TBD` | Report: a row still reading `TBD` means the stack decision has not landed and the skill stops in preflight |
| The worktree root is named | The worktrees section of `CLAUDE.md` names a root outside the project and the port rule | Report: the skill cannot create a worktree without it |
