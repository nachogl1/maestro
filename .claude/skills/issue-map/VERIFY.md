# VERIFY.md — what must hold for `/issue-map` to work in this project

Read and run by `/orion-verify` after install (and whenever the user runs it). Every check is read-only: nothing here
installs, changes or sends anything. A failed check is reported as "`issue-map` cannot run here until …".

| Check | How | When it fails |
|---|---|---|
| Python 3.9 or newer is on the path | `python --version`, then `python3 --version` if the first is missing; on Windows an answer that is an install prompt from the Store stub counts as missing | Report: the map generator is a Python script with no packages; name the version found, if any |
| `gh` is signed in to the repository `origin` points at | `gh auth status`; `gh repo view --json nameWithOwner` | Report: the map reads issues through `gh` and cannot be built without it |
| GitHub Issues are enabled on that repository | `gh repo view --json hasIssuesEnabled` | Report: this skill works with GitHub Issues only |
| The snapshot is kept out of git | `docs/issue_map/` is absent, or `git check-ignore -q docs/issue_map/issue_map.html` succeeds | Report: the map is a transient snapshot and must never be committed; the skill excludes it itself on its first run, so this fails only when someone force-added it |
