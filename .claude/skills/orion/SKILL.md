---
name: orion
description: ORION - Manage the orion files installed in this repository (the orion-managed skills under .claude/skills, the orion rules file imported by CLAUDE.md, and the session-start update check). Shows what is installed and at which version, checks whether a newer orion exists, ships an update through its own pull request, or uninstalls everything orion owns while leaving the project's own rules and skills alone. Use when the user says "/orion", "update orion", "orion status", "is orion up to date", "check for orion updates", "remove orion", or when a session-start message reports that an orion update is available or that orion's files were left uncommitted.
argument-hint: status | check | update | branches | uninstall
---

# orion

The orion files in this repository are managed by one script, `.claude/orion/orion.sh`. This skill is a thin wrapper
around it: pick the sub-command from the argument (default `status`), run it from the project root with bash, and report
the outcome in the user's preferred shape. All commands work on Windows too, through Git Bash.

## Sub-commands

| Argument | Command to run | Then |
|---|---|---|
| `status` (default) | `bash .claude/orion/orion.sh status` | Report version, update mode and skill count in one line each. |
| `check` | `bash .claude/orion/orion.sh check --force` | Empty output means up to date — say so. JSON output means a newer orion exists — say so and offer `update`. |
| `update` | Follow *Ship an update* below: `bash .claude/orion/orion.sh update` runs in a worktree of its own, never in the folder the session opened in. | Report the pull request and whether it merged, in one line. |
| `branches` | **Ask first** with AskUserQuestion, naming both branches and saying it may change the repository's default branch on GitHub, then `bash .claude/orion/orion.sh branches --dev <development branch> --release <release branch>` | Report the two names, what changed on GitHub and any step it printed for a person to do by hand. |
| `uninstall` | **Ask first** with AskUserQuestion ("Remove everything orion owns from this repository? Your CLAUDE.md rules and your own skills stay."), then `bash .claude/orion/orion.sh uninstall --yes` | List what was removed. Remind the user to commit. |

## Ship an update

An accepted update (a yes to the session-start offer, or any update under `updateMode: auto`) and orion's files left
uncommitted in the main folder both reach the default branch the same way: through a pull request of their own,
merged on green. The folder the session opened in is never updated or committed to.

1. **Read the project's `CLAUDE.md`** for the worktree root, the default branch (the one daily work starts from), the
   build, lint, typecheck and full-suite commands, how a fresh worktree is prepared, and the changelog rule.
2. **Name the versions.** `<old>` is line 5 of `.claude/orion/VERSION` in the last commit
   (`git show HEAD:.claude/orion/VERSION`); `<new>` is the newer version the session-start message names, or, for
   files left uncommitted, line 5 of the main folder's own `.claude/orion/VERSION`. A line 5 that is empty counts as
   the short commit on line 1. **When the last commit has no `.claude/orion/VERSION`** (that command fails), the
   uncommitted files are a first install nobody saved: there is no `<old>`, and steps 4, 8 and 9 say what changes.
3. **Make the worktree, or pick up the one a stopped run left.** `git fetch origin`. When the branch
   `feat/orion-update-v<new>` already exists (`git branch --list` and `git ls-remote --heads origin` show it), never
   make a second one; look for its pull request with `gh pr list --head feat/orion-update-v<new> --state all` (the
   newest, when there are several):
   - open: report its link and state in one line; when its checks are green carry on from step 9, otherwise stop;
   - merged: carry on from step 10, which removes this stale worktree and branch and ends the run only when the
     files no longer differ;
   - closed without a merge: report its link and stop; the user decides whether it is tried again;
   - none: carry on in its worktree (`git worktree list`; `git worktree add <worktree root>/orion-update-v<new>
     feat/orion-update-v<new>` when the folder is gone) from step 4.

   Otherwise run
   `git worktree add -b feat/orion-update-v<new> <worktree root>/orion-update-v<new> origin/<default branch>`, and
   prepare it as the project's `CLAUDE.md` says.
4. **Bring orion's files in, inside the worktree only.**
   - An update: run `bash .claude/orion/orion.sh update` there.
   - Files left uncommitted: copy every file `git status --porcelain --untracked-files=all` lists among orion's paths
     (each folder under `.claude/skills/` carrying an `.orion-managed` marker, and `.claude/orion/<line>` for each line of
     `.claude/orion/.orion-manifest`) from the main folder into the worktree, and delete in the worktree the ones the
     main folder deleted. Never change the main folder's copies.
   - A first install nobody saved (step 2): copy also the three files `init` writes outside that list, when the
     main folder has them uncommitted: `.claude/orion/config.json` (the update mode), `.claude/settings.json` (the
     session-start hook) and `CLAUDE.md` (the import line). Without them the install would land with no hook and no
     rules. Show the user the diff of `.claude/settings.json` and `CLAUDE.md`, since either may also hold edits of
     their own.
5. **Check the rules still fit.** If `.claude/orion/BASE_CLAUDE.md` changed (`git diff -- .claude/orion/BASE_CLAUDE.md`),
   read the project's `CLAUDE.md` against it and list to the user any rule that now contradicts it, with a proposed
   rewrite. Never edit `CLAUDE.md` yourself in this pull request: the only change to it this pull request may carry
   is the main folder's own copy from a first install (step 4).
6. **Add the changelog file** the project's rules ask for (one line, such as "orion updated from `<old>` to `<new>`"),
   when the project keeps one.
7. **Run the project's gate** (build, lint, typecheck, full suite) in the worktree with the commands its `CLAUDE.md`
   lists. Red means stop (step 11).
8. **Commit and open the pull request.** Add only the files this run changed (never `git add -A`), commit as
   `chore(orion): update orion from <old> to <new>` (a first install: `chore(orion): install orion <new>`), push the
   branch and open a pull request with that title against the default branch, listing the changed files and the gate
   result.
9. **Merge on green** under the project's merge bar: wait for the checks to report, never merge on red or pending
   ones ("no checks reported" counts as red), squash-merge and delete the branch, then remove the worktree. When the
   project's rules say a person merges this pull request (one that changes `CLAUDE.md`, as a first install does,
   always does), stop at the pull request, give the user its link and say so.
10. **Bring the main folder up to date.** When it is on the default branch, run `git pull --ff-only` there. If git
    refuses because files step 4 copied are still uncommitted there (the files-left-uncommitted case), compare each
    one with the merged commit: a tracked file with `git diff --quiet origin/<default branch> -- <path>`, an untracked
    one with `git show origin/<default branch>:<path> | cmp -s - <path>`. Only when every one is identical are they
    already on the default branch: restore the tracked ones (`git checkout -- <path>`), remove the untracked ones and
    pull again. If any differs, stop and name them to the user. Never discard a file that differs from what merged.
    When the main folder is on another branch, leave it there and say so. After a merged pull request picked up at
    step 3, remove its worktree and its branch, locally and on the remote (`git worktree remove`, `git branch -D`,
    `git push origin --delete`). Then, if orion's files in the main folder still differ from the last commit (edits
    made after that pull request, at the same version), it did not carry them: go back to step 3, which now finds no
    branch and makes a new one.
11. **A failed run reports and stops.** Say which step failed and the exact error, change nothing else, and leave the
    worktree and branch for `/clear-git-resources` (or for the next run, which picks them up at step 3). Never fall
    back to updating the main folder.

## Rules

- Run the script, do not re-implement it. If `.claude/orion/orion.sh` is missing, orion is not installed here: say so
  and say it is installed by running orion's `init` against this project, instead of inventing files.
- `update` and `uninstall` change tracked files. Never commit for the user unless they ask (a yes to an update, or
  `updateMode: auto`, is that ask for *Ship an update* only); never commit to the default branch.
- The update mode lives in `.claude/orion/config.json` (`updateMode`: `ask` = offer at session start, `auto` = ship
  each newer orion through its own pull request without asking, `off` = never check). When the user wants to change
  it, edit that one key and nothing else. `update` never touches that file.
- Keep the reply short: problems first, then the result, then exactly one next step.
