# VERIFY.md — what must hold for `/generate-project-writeup` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`generate-project-writeup` cannot run here until …".

| Check | How | When it fails |
|---|---|---|
| `git` is on the path and the project is a git repository | `git --version`; `git rev-parse --show-toplevel` | Report: the skill measures commits, authors and duration from git history; without it the metrics are all "not measured" |
| Python 3.8 or newer is on the path | `python3 --version`, or `python --version`, or on Windows `py -3 --version`; the version printed is 3.8 or higher | WARN only: the Word generator cannot run; the skill falls back to `pandoc`, then to Word-openable HTML, and says which it used. The skill needs only the standard library, so no package is required |
| The bundled generator is installed and parses (skip when no Python passed the row above) | `python -m py_compile .claude/skills/generate-project-writeup/assets/build_docx.py` (use the `python3` or `py -3` that passed above) | Report: the installed copy is damaged; `bash .claude/orion/orion.sh update --force` restores it |
| A Downloads folder exists | `~/Downloads` exists (Windows: `%USERPROFILE%\Downloads`) | WARN only: the skill asks the user where to write the one `.docx` |
