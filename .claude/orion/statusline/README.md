# orion status line (baseline)

A starting-point [Claude Code status line](https://docs.anthropic.com/en/docs/claude-code/statusline) showing, on one line:

| Segment | Color | Source |
|---|---|---|
| Session alive time (`1h23m`) | cyan | transcript file creation time |
| Session or agent name (`my-feature`) | bold white | `agent.name` when Claude Code runs with `--agent`, else `session_name` (set with `--name` or `/rename`, or the AI-generated title) from the stdin JSON; omitted until one exists |
| Context usage (`ctx: 42.5%`) | green / yellow ≥70% / red ≥90% | Claude Code stdin JSON |
| Git branch + state (`[branch] stashed:0 untracked:2 modified:5 unpushed:1`) | per-word (magenta / yellow / red / blue) | `git` in the session's cwd — stashes, untracked files, uncommitted changes, commits not pushed yet |
| **Session cost** (`$1.23`) | green | `cost.total_cost_usd` from Claude Code stdin JSON |
| **Month-to-date cost** (`$345.67`) | blue | [ccusage](https://github.com/ryoppippi/ccusage) over local transcripts, current calendar month to date (resets on the 1st), cached 10 min, refreshed in background |
| **Model** (`Opus`) | cyan | `model.display_name` from Claude Code stdin JSON |
| **Reasoning effort** (`effort:high`) | green low/medium, yellow high, red xhigh/max | `effort.level` from Claude Code stdin JSON; omitted when the model exposes no effort level |
| **5-hour usage** (`5h:23% ↻2h14m`) | bright magenta | `rate_limits.five_hour` from Claude Code stdin JSON |
| **Weekly usage** (`7d:41% ↻3d5h`) | bright blue | `rate_limits.seven_day` from Claude Code stdin JSON |
| **Worktree** (`wkt:feat-login`), second line, after the working directory | plain | `workspace.git_worktree`, else `worktree.name` (a `--worktree` session), from Claude Code stdin JSON; omitted when neither is sent |

On a **detached HEAD** (no branch checked out, as in a worktree made from a commit or a tag) the git segment names the commit instead of a branch, `[detached:<short commit id>]`, with the same four state words; outside a git repository there is no git segment.

Second line: the session's working directory, then `  |  wkt:<name>` when the session is in a linked git worktree.

The **worktree tag** shows only when the Claude Code session itself runs inside a linked git worktree (it opened there, or was started with `--worktree`); in the main checkout, or on a Claude Code too old to send the field, nothing is drawn. An agent that only points its commands at a worktree, or a background agent working in a worktree of its own, does not change it.

The two **usage-limit segments** are the subscription rate-limit windows: how much of the 5-hour rolling window and of the 7-day (weekly) window has been consumed, each followed by `↻` and the time until that window refreshes (`3d5h` / `2h14m` / `12m` / `now`). They come straight from the stdin JSON, so they cost nothing to draw and never block. Each window has its own colour so the two are never confused. They appear **only on a Claude.ai subscription (Pro/Max) session, and only after the first response of the session** — Claude Code omits `rate_limits` for API-key sessions, and either window can be absent on its own, in which case that segment is simply not drawn.

Both cost figures are **API-equivalent USD** — what the usage would cost at API list prices. On a subscription plan this is a value measure, not a bill. The month-to-date figure spans **all projects on the machine**, and can only see transcripts still on disk (Claude Code prunes them after `cleanupPeriodDays`, ~30 days by default).

## Requirements

- `bash` (on Windows: Git Bash, normally present with Git) and `jq` — required.
- `node`/`npx` — optional; powers the month-to-date cost segment via `npx -y ccusage`. Without it the segment shows `$...`.

Cache files live under `~/.cache/claude-statusline/` — delete the folder to force a refresh.

## Install

This is a **baseline** and a **per-computer** setting: `orion init --statusline` copies this folder to `~/.claude/statusline` and points `statusLine` in `~/.claude/settings.json` at it. Installing is **opt-in**, one decision per computer:

```sh
curl -fsSL https://raw.githubusercontent.com/nachogl1/orion/main/orion.sh | bash -s -- init --statusline
```
```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nachogl1/orion/main/orion.ps1))) init --statusline
```

(An interactive `init` also offers it as a y/N prompt.)

Or configure manually — copy the folder wherever you like and point `statusLine` at the script in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash \"<absolute path to home>/.claude/statusline/statusline.sh\""
  }
}
```

> The command must be an absolute path (Claude Code does not expand `~` on all platforms). The installers write the correct per-user path for you.

## Updates

Every project with orion carries this baseline in `.claude/orion/statusline/`, refreshed by `orion update` and committed with the rest. At each session start the computer's copy is compared with the project's:

Your copy never changes without your word, whatever the project's update mode:

- **You never edited your copy:** it is left alone and Claude Code asks whether to take the newer baseline. `orion.sh statusline merge` takes it; `orion.sh statusline skip` declines that version.
- **You edited it:** it is left alone and Claude Code asks whether to merge orion's new changes into yours. `orion.sh statusline merge` does a three-way merge against the baseline your copy came from (kept in `~/.claude/statusline/.orion-base/`), so your edits stay; where you and orion changed the same lines it leaves conflict markers to resolve. `orion.sh statusline skip` declines that version.
- **An older project** (another project on the same computer with an older orion) never steps your copy back.

A copy installed before orion kept a merge base cannot tell your edits from an older baseline: its merge saves it to `~/.claude/statusline.bak` and installs the new baseline, so you can carry your own changes over by hand. A re-run of `init` leaves an installed copy alone; to start again from the baseline, delete the folder (or pass `--force` together with `--statusline`).

## Uninstall

`orion uninstall` works on a project and leaves this per-computer copy alone (it is yours and may carry your edits). To remove it, delete `~/.claude/statusline` and the `statusLine` entry in `~/.claude/settings.json` by hand.
