#!/usr/bin/env bash
# orion status line for Claude Code (baseline)
#
# Segments (left to right):
#   - session alive time (cyan)
#   - session or agent name (bold white; the agent's name when run with
#     --agent, else the session's name from --name, /rename or its AI title)
#   - context usage % (green/yellow/red)
#   - git branch (or "detached:<short commit id>" on a detached HEAD) + state
#     words (stashed / untracked / modified / unpushed)
#   - cost: API-equivalent USD for the open session (green) + current
#     calendar month to date across all projects (blue), aggregated from
#     local transcripts by ccusage (cached, background-refreshed via `npx`)
#   - model name (cyan)
#   - reasoning effort (color-coded by level; omitted when unsupported)
#   - subscription usage limits, rightmost: 5-hour window (bright magenta) and
#     7-day window (bright blue), each "used % + time until it resets"
#   - second line: current working directory, then "wkt:<name>" when the
#     session itself runs inside a linked git worktree (omitted otherwise)
#
# Requirements: bash (Git Bash on Windows), jq. Optional:
# node/npx (month-to-date cost segment — shows "$..." until available).
# Caches live under ~/.cache/claude-statusline/.
#
# Install: `orion init --statusline` copies this folder to
# ~/.claude/statusline. Each newer orion version is offered and taken only on
# your word; an edited copy keeps your edits when it is merged in.
# See baselines/statusline/README.md.

input=$(cat)

# Parse every needed stdin field in ONE jq pass (one process per redraw, not
# six). Values are emitted one per line; none of them can contain a newline.
# tr strips the \r that native-Windows jq builds append to every output line.
_fields=$(echo "$input" | jq -r '
  (.context_window.used_percentage // ""),
  (.cwd // ""),
  (.transcript_path // ""),
  (.session_name // ""),
  (.agent.name // ""),
  (.model.display_name // ""),
  (.effort.level // ""),
  (.cost.total_cost_usd // ""),
  (.rate_limits.five_hour.used_percentage // ""),
  (.rate_limits.five_hour.resets_at // ""),
  (.rate_limits.seven_day.used_percentage // ""),
  (.rate_limits.seven_day.resets_at // ""),
  (.workspace.git_worktree // .worktree.name // "")
' | tr -d '\r')
{
  read -r used_pct
  read -r cwd
  read -r transcript_path
  read -r session_name
  read -r agent_name
  read -r model_name
  read -r effort_level
  read -r session_cost
  read -r five_h_pct
  read -r five_h_reset
  read -r seven_d_pct
  read -r seven_d_reset
  read -r worktree_name
} <<< "$_fields"

# Compute elapsed time since session start (transcript file birth/creation time)
alive_segment=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  # Use stat -c %W (birth time on Linux) or %Y (mtime fallback); on macOS use -f %SB
  # Try GNU stat first (Linux/Git-Bash/WSL), then BSD stat (macOS)
  birth=$(stat -c %W "$transcript_path" 2>/dev/null)
  # %W may return 0 if birth time is unsupported — fall back to mtime (%Y)
  if [ -z "$birth" ] || [ "$birth" = "0" ]; then
    birth=$(stat -c %Y "$transcript_path" 2>/dev/null)
  fi
  # BSD/macOS fallback
  if [ -z "$birth" ]; then
    birth=$(stat -f %B "$transcript_path" 2>/dev/null)
    if [ -z "$birth" ] || [ "$birth" = "0" ]; then
      birth=$(stat -f %m "$transcript_path" 2>/dev/null)
    fi
  fi

  if [ -n "$birth" ] && [ "$birth" != "0" ]; then
    now=$(date +%s)
    elapsed=$(( now - birth ))
    if [ "$elapsed" -lt 0 ]; then elapsed=0; fi

    hours=$(( elapsed / 3600 ))
    mins=$(( (elapsed % 3600) / 60 ))
    secs=$(( elapsed % 60 ))

    if [ "$hours" -gt 0 ]; then
      alive_segment="${hours}h${mins}m"
    elif [ "$mins" -gt 0 ]; then
      alive_segment="${mins}m"
    else
      alive_segment="${secs}s"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Name segment — who this bar belongs to, so parallel sessions are told apart.
# The agent's name wins when Claude Code runs with --agent; otherwise the
# session's name (set with --name or /rename, or the AI-generated title).
# Both come from the stdin JSON and are absent until one exists, in which
# case the segment is omitted rather than faked.
# ---------------------------------------------------------------------------
name_segment=""
if [ -n "$agent_name" ]; then
  name_segment="[1;37m${agent_name}[0m"
elif [ -n "$session_name" ]; then
  name_segment="[1;37m${session_name}[0m"
fi

# ---------------------------------------------------------------------------
# Cost segment — API-equivalent USD for this session (from stdin JSON) plus a
# current-calendar-month-to-date total aggregated from local transcripts by
# ccusage (e.g. on Jun 23 it sums Jun 1 → Jun 23, resetting on the 1st).
# The month figure is cached (10-min TTL) and refreshed in the background — same
# non-blocking pattern as the other cached segments — so it never waits on npx.
# ---------------------------------------------------------------------------
cost_segment=""
if [ -n "$session_cost" ]; then
  session_cost_fmt=$(printf '%.2f' "$session_cost" 2>/dev/null)
  cost_segment="\033[0;32m\$${session_cost_fmt}\033[0m"
fi

month_cache="$HOME/.cache/claude-statusline/cost-mtd.txt"
mkdir -p "$(dirname "$month_cache")" 2>/dev/null

_month_fresh=false
if [ -f "$month_cache" ]; then
  _cmtime=$(stat -c %Y "$month_cache" 2>/dev/null)
  if [ -z "$_cmtime" ]; then
    _cmtime=$(stat -f %m "$month_cache" 2>/dev/null)
  fi
  if [ -n "$_cmtime" ]; then
    _cage=$(( $(date +%s) - _cmtime ))
    if [ "$_cage" -lt 600 ]; then
      _month_fresh=true
    fi
  fi
fi

if ! $_month_fresh; then
  # Bump mtime first so concurrent status-line refreshes don't stampede npx,
  # then recompute in the background (stale value keeps showing meanwhile).
  touch "$month_cache" 2>/dev/null
  (
    # First day of the current calendar month (YYYYMM01) — month-to-date, not
    # a rolling 30-day window. Pure strftime, so GNU and BSD `date` both work.
    _since=$(date +%Y%m01)
    _total=$(npx -y ccusage daily --json --since "$_since" 2>/dev/null | jq -r '.totals.totalCost // empty' | tr -d '\r')
    if [ -n "$_total" ]; then
      _tmp="${month_cache}.tmp.$$"
      printf '%.2f' "$_total" > "$_tmp" 2>/dev/null && mv "$_tmp" "$month_cache"
    fi
  ) &
  disown 2>/dev/null || true
fi

month_val=""
if [ -f "$month_cache" ]; then
  month_val=$(cat "$month_cache" 2>/dev/null)
fi
if [ -n "$month_val" ]; then
  month_part="\033[0;34m\$${month_val}\033[0m"
else
  month_part="\033[0;34m\$...\033[0m"   # first run — background refresh pending
fi
if [ -n "$cost_segment" ]; then
  cost_segment="${cost_segment} ${month_part}"
else
  cost_segment="${month_part}"
fi

# Build context segment with color coding
if [ -n "$used_pct" ]; then
  used_int=${used_pct%.*}

  if [ "$used_int" -ge 90 ]; then
    color="\033[0;31m"   # red
  elif [ "$used_int" -ge 70 ]; then
    color="\033[0;33m"   # yellow
  else
    color="\033[0;32m"   # green
  fi
  reset="\033[0m"

  ctx_segment="${color}ctx: ${used_pct}%${reset}"
else
  ctx_segment="ctx: --"
fi

# ---------------------------------------------------------------------------
# Git segment — branch + state words (never icons: a word needs no legend). The git commands are cached
# per cwd (10s TTL) so redraw storms don't relaunch git every time; on a stale
# cache they are recomputed inline (git is local and fast enough once) and the
# cache is rewritten. Cache layout: line 1 = branch (or detached label), line 2 = indicators.
# ---------------------------------------------------------------------------
git_branch=""
git_indicators=""
_git_cache_id=$(printf '%s' "$cwd" | cksum | tr -cd '0-9')
git_cache="$HOME/.cache/claude-statusline/git-${_git_cache_id}.txt"
mkdir -p "$(dirname "$git_cache")" 2>/dev/null

_git_fresh=false
if [ -f "$git_cache" ]; then
  _gmtime=$(stat -c %Y "$git_cache" 2>/dev/null)
  if [ -z "$_gmtime" ]; then
    _gmtime=$(stat -f %m "$git_cache" 2>/dev/null)
  fi
  if [ -n "$_gmtime" ] && [ "$(( $(date +%s) - _gmtime ))" -lt 10 ]; then
    _git_fresh=true
  fi
fi

if $_git_fresh; then
  git_branch=$(sed -n '1p' "$git_cache")
  git_indicators=$(sed -n '2p' "$git_cache")
else
  # Get current git branch (skip optional locks to avoid contention)
  git_branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)

  # A detached HEAD has no branch name: name the commit instead (prints nothing outside a repository)
  if [ -z "$git_branch" ]; then
    _git_commit=$(git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
    [ -n "$_git_commit" ] && git_branch="detached:${_git_commit}"
  fi

  # Build git state indicators (only when inside a git repo, i.e. the label is known)
  if [ -n "$git_branch" ]; then
    # ANSI color codes
    _mag="\033[0;35m"   # magenta — stashes
    _yel="\033[0;33m"   # yellow  — untracked
    _red="\033[0;31m"   # red     — modifications
    _blu="\033[0;34m"   # blue    — ahead
    _rst="\033[0m"

    # 1. Stashes (magenta stashed:N) — always shown
    stash_count=$(git -C "$cwd" --no-optional-locks stash list 2>/dev/null | wc -l | tr -d ' ')
    git_indicators="${git_indicators} ${_mag}stashed:${stash_count:-0}${_rst}"

    # 2. Untracked files (yellow untracked:N) — always shown
    untracked_count=$(git -C "$cwd" --no-optional-locks ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
    git_indicators="${git_indicators} ${_yel}untracked:${untracked_count:-0}${_rst}"

    # 3. Uncommitted modifications — staged + unstaged tracked (red modified:N) — always shown
    #    Count lines from `git status --porcelain` where the first two chars are NOT "??"
    mod_count=$(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null | grep -v '^??' | wc -l | tr -d ' ')
    git_indicators="${git_indicators} ${_red}modified:${mod_count:-0}${_rst}"

    # 4. Commits ahead of upstream, i.e. not pushed yet (blue unpushed:N) — always shown; default to 0 when no upstream
    ahead_count=$(git -C "$cwd" --no-optional-locks rev-list --count '@{u}..HEAD' 2>/dev/null)
    git_indicators="${git_indicators} ${_blu}unpushed:${ahead_count:-0}${_rst}"
  fi

  _tmp="${git_cache}.tmp.$$"
  printf '%s\n%s\n' "$git_branch" "$git_indicators" > "$_tmp" 2>/dev/null && mv "$_tmp" "$git_cache"
fi

# Build git segment (branch + state words)
if [ -n "$git_branch" ]; then
  git_segment="[$git_branch]  | ${git_indicators# }"
else
  git_segment=""
fi

# ---------------------------------------------------------------------------
# Model segment — current model display name (cyan)
# ---------------------------------------------------------------------------
model_segment=""
if [ -n "$model_name" ]; then
  model_segment="\033[0;36m${model_name}\033[0m"
fi

# ---------------------------------------------------------------------------
# Effort segment — reasoning effort level, color-coded by level.
# Absent from stdin JSON when the model doesn't support effort — omit entirely.
# ---------------------------------------------------------------------------
effort_segment=""
if [ -n "$effort_level" ]; then
  case "$effort_level" in
    low|medium) _ecol="\033[0;32m" ;;   # green
    high)       _ecol="\033[0;33m" ;;   # yellow
    *)          _ecol="\033[0;31m" ;;   # red — xhigh / max
  esac
  effort_segment="${_ecol}effort:${effort_level}\033[0m"
fi

# ---------------------------------------------------------------------------
# Usage-limit segments — the subscription rate-limit windows, read straight
# from the stdin JSON (no external command, so these never block): the 5-hour
# rolling window and the 7-day (weekly) window, each shown as "used % + time
# until that window refreshes".
#
# `rate_limits` is only present for Claude.ai subscription (Pro/Max) sessions,
# and only after the first API response of the session; each window can be
# absent independently. Every field is therefore optional and its segment is
# omitted rather than faked. Each window gets its OWN color so the two are
# never confused at a glance.
# ---------------------------------------------------------------------------

# Echo " ↻<time-left>" for a Unix-epoch reset timestamp — "3d5h" / "2h14m" /
# "12m" / "now". Echoes nothing when the timestamp is missing or not an integer.
_reset_suffix() {
  local _epoch=${1%.*}
  case "$_epoch" in
    ''|*[!0-9]*) return ;;
  esac

  local _left=$(( _epoch - $(date +%s) ))
  if [ "$_left" -le 0 ]; then
    printf ' ↻now'
    return
  fi

  local _d=$(( _left / 86400 ))
  local _h=$(( (_left % 86400) / 3600 ))
  local _m=$(( (_left % 3600) / 60 ))
  if [ "$_d" -gt 0 ]; then
    printf ' ↻%dd%dh' "$_d" "$_h"
  elif [ "$_h" -gt 0 ]; then
    printf ' ↻%dh%dm' "$_h" "$_m"
  else
    printf ' ↻%dm' "$_m"
  fi
}

# Echo "<color><label>:<pct>% ↻<reset><reset-color>" for one window, or nothing
# when the percentage is missing/non-numeric. Colors stay as literal \033 text
# here — the final printf '%b' expands them, same as every other segment.
_usage_segment() {
  local _label="$1" _pct="$2" _reset="$3" _color="$4"
  local _pct_int=${_pct%.*}
  case "$_pct_int" in
    ''|*[!0-9]*) return ;;
  esac
  printf '%s%s:%s%%%s\\033[0m' "$_color" "$_label" "$_pct_int" "$(_reset_suffix "$_reset")"
}

usage_5h_segment=$(_usage_segment "5h" "$five_h_pct" "$five_h_reset" '\033[1;35m')   # bright magenta
usage_7d_segment=$(_usage_segment "7d" "$seven_d_pct" "$seven_d_reset" '\033[1;34m') # bright blue

# ---------------------------------------------------------------------------
# Assemble output
# ---------------------------------------------------------------------------
if [ -n "$cost_segment" ]; then
  cost_suffix="  |  ${cost_segment}"
else
  cost_suffix=""
fi

# Model + effort sit to the right of cost: | modelname | effort:level
if [ -n "$model_segment" ]; then
  cost_suffix="${cost_suffix}  |  ${model_segment}"
fi
if [ -n "$effort_segment" ]; then
  cost_suffix="${cost_suffix}  |  ${effort_segment}"
fi
# Usage-limit windows sit rightmost of all, after effort
if [ -n "$usage_5h_segment" ]; then
  cost_suffix="${cost_suffix}  |  ${usage_5h_segment}"
fi
if [ -n "$usage_7d_segment" ]; then
  cost_suffix="${cost_suffix}  |  ${usage_7d_segment}"
fi

if [ -n "$alive_segment" ]; then
  prefix="\033[0;36m${alive_segment}\033[0m  |  "
else
  prefix=""
fi

if [ -n "$name_segment" ]; then
  prefix="${prefix}${name_segment}  |  "
fi

if [ -n "$git_segment" ]; then
  line1="${prefix}${ctx_segment}  |  ${git_segment}${cost_suffix}"
else
  line1="${prefix}${ctx_segment}${cost_suffix}"
fi

# Worktree tag — "wkt:<name>" after the path when the session itself runs in
# a linked git worktree. Claude Code sends the name (workspace.git_worktree,
# else worktree.name in a --worktree session), so it costs no git call; it is
# absent in the main checkout or on an older Claude Code: nothing is drawn.
line2="$cwd"
if [ -n "$worktree_name" ]; then
  line2="${line2}  |  wkt:${worktree_name}"
fi

# %b expands the \033 color literals in the segments; the second line (cwd and
# worktree name) goes through %s verbatim, so a % or \ in a path (or branch or
# worktree name) can never be treated as a printf format directive and corrupt
# the line.
printf '%b\n%s' "$line1" "$line2"
