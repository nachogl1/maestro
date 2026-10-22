---
name: orion
description: ORION - Manage the orion files installed in this repository (the orion-managed skills under .claude/skills, the orion rules file imported by CLAUDE.md, and the session-start update check). Shows what is installed and at which version, checks whether a newer orion exists, applies an update, or uninstalls everything orion owns while leaving the project's own rules and skills alone. Use when the user says "/orion", "update orion", "orion status", "is orion up to date", "check for orion updates", "remove orion", or when a session-start message reports that an orion update is available.
argument-hint: status | check | update | uninstall
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
| `update` | `bash .claude/orion/orion.sh update` | Summarise the changed files from `git status --short`. If `.claude/orion/BASE_CLAUDE.md` changed (`git diff -- .claude/orion/BASE_CLAUDE.md`), read the project's `CLAUDE.md` against it and list any rule that now contradicts it, with a proposed rewrite; the two files must never disagree. Remind the user to commit on a branch (never straight to `main`) so the team gets the update by pulling. |
| `uninstall` | **Ask first** with AskUserQuestion ("Remove everything orion owns from this repository? Your CLAUDE.md rules and your own skills stay."), then `bash .claude/orion/orion.sh uninstall --yes` | List what was removed. Remind the user to commit. |

## Rules

- Run the script, do not re-implement it. If `.claude/orion/orion.sh` is missing, orion is not installed here: say so
  and say it is installed by running orion's `init` against this project, instead of inventing files.
- `update` and `uninstall` change tracked files. Never commit for the user unless they ask; never commit to `main`.
- The update mode lives in `.claude/orion/config.json` (`updateMode`: `ask` = offer at session start, `auto` = update
  silently at session start, `off` = never check). When the user wants to change it, edit that one key and nothing else.
- Keep the reply short: problems first, then the result, then exactly one next step.
