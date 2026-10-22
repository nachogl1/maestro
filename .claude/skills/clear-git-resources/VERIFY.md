# VERIFY.md — what must hold for `/clear-git-resources` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`clear-git-resources` cannot run here until …".

| Check | How | When it fails |
|---|---|---|
| `git` and `bash` are on the path | `git --version`; `bash --version` (on Windows this is Git Bash, which comes with Git) | Report: the scanner is a bash script driving `git`; without them nothing can be listed |
| The scanner parses | `bash -n .claude/skills/clear-git-resources/scripts/scan.sh` | Report: the installed copy is damaged; `bash .claude/orion/orion.sh update --force` restores it |
| The worktree root is named | The worktrees section of `CLAUDE.md` names a root outside the project | WARN only: the skill falls back to `C:\wt` on Windows and `~/wt` elsewhere, and says so; folders elsewhere are not swept |
| `gh` is signed in to the repository `origin` points at | `gh auth status`; `gh repo view --json nameWithOwner` | WARN only: without pull request states a squash-merged branch is only recognised through its deleted remote branch, so more items land in "needs your word" |
| `branchLimit` is a number or `off` | `.claude/orion/config.json` has no `branchLimit` key (default 20), or its value is a whole number or `off` | Report: the session-start hook cannot read the limit and falls back to 20 |
| `worktreeLimit` is a number or `off` | `.claude/orion/config.json` has no `worktreeLimit` key (default 20), or its value is a whole number or `off` | Report: the session-start hook cannot read the limit and falls back to 20 |
| A git identity is set | `git config user.email` prints an address | WARN only: nothing counts as the person's own, so every stale item is asked about instead of deleted |
