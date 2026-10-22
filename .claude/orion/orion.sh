#!/usr/bin/env bash
# orion - a repo-level utility framework for Claude Code projects.
#
# Everything orion ships is copied INTO the project (skills, a rules file, this
# script, the status line baseline) and committed, so teammates get it with a
# plain git clone/pull. The only per-computer piece is the optional status line
# in ~/.claude/statusline: a newer baseline in the project is offered at session
# start and taken (merged into an edited copy) only on its owner's word.
#
# Usage (run inside the project, or pass --project <dir>):
#   orion.sh init      [--source <git url|path>] [--ref <branch>] [--update-mode ask|auto|off]
#                      [--statusline|--no-statusline] [--force]
#   orion.sh update    [--force]        # fetch the latest orion and re-copy the files orion owns
#   orion.sh update    --skip           # decline the newest orion: the hook stays quiet until a newer one
#   orion.sh check     [--force]        # session-start hook: pull the branch and look for a newer orion (every
#                                       # session); too many branches or worktrees? (once a day each)
#   orion.sh verify                     # mechanical post-install checks, one line per finding, no fixes
#   orion.sh status                     # what is installed, which version, which update mode
#   orion.sh uninstall [--yes]          # remove everything orion owns, keep everything yours
#   orion.sh statusline merge|skip      # take orion's newer status line (keeping your edits), or decline it
#   orion.sh help
#
# First-time bootstrap, no clone needed (run inside the project):
#   curl -fsSL https://raw.githubusercontent.com/nachogl1/orion/main/orion.sh | bash -s -- init
#
# After init, the next Claude Code session start is asked ONCE to run the
# /orion-verify skill: it runs `verify`, fixes what is mechanical, reviews
# CLAUDE.md against BASE_CLAUDE.md and the skills, and reports the rest.
#
# What orion owns in a project (overwritten on update, removed on uninstall):
#   .claude/skills/<skill>/           every folder carrying a `.orion-managed` marker
#   .claude/orion/orion.sh            this script
#   .claude/orion/BASE_CLAUDE.md      the mandatory rules, imported by CLAUDE.md
#   .claude/orion/statusline/         the status line baseline each computer's copy follows
#   .claude/orion/global/             GLOBAL_CLAUDE.md, the personal rules offered for ~/.claude/CLAUDE.md
#   .claude/orion/VERSION             commit the files came from (its commit time, and orion's version number)
#   .claude/orion/.orion-manifest     the list above
# What orion creates ONCE and never touches again (yours):
#   CLAUDE.md                         created with the project-specific slots if missing; otherwise
#                                     only the import line for BASE_CLAUDE.md is added at the top
#   .claude/orion/config.json         updateMode: ask | auto | off (chosen during init), source/ref, and
#                                     branchLimit and worktreeLimit (default 20 each, or off): the branch
#                                     or worktree count at which the session-start hook offers
#                                     /clear-git-resources
#   .claude/settings.json             one SessionStart hook entry is added (removed on uninstall)

set -euo pipefail

ORION_DEFAULT_SOURCE="https://github.com/nachogl1/orion.git"
ORION_DEFAULT_REF="main"
MARKER=".orion-managed"
IMPORT_LINE="Mandatory rules, owned and refreshed by orion (never edit the copy): @.claude/orion/BASE_CLAUDE.md"
OLD_IMPORT_LINE="@.claude/orion/ORION.md"   # what orion wrote before the rules moved to BASE_CLAUDE.md
HOOK_NEEDLE="/.claude/orion/orion.sh"
HOOK_CMD='bash "${CLAUDE_PROJECT_DIR}/.claude/orion/orion.sh" check'
# The session-start hook's time budget in seconds: 8 s pull fetch + 8 s update check + 10 s fetch + copying the
# files, which under Git Bash on Windows alone can take over 10 s. Installs that carry a lower value are raised
# on update.
HOOK_TIMEOUT=60
CHECK_INTERVAL_SECONDS=86400
BRANCH_LIMIT_DEFAULT=20
WORKTREE_LIMIT_DEFAULT=20

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
warn() { printf 'orion: %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

usage() { sed -n '2,44p' "$0" 2>/dev/null || true; exit 0; }

# The documented install is `curl ... | bash`, so stdin is the script itself: a question is still possible
# when the terminal can be opened directly (/dev/tty), which is what ask() reads from in that case.
is_tty() { [ -t 1 ] && { [ -t 0 ] || ( : </dev/tty ) 2>/dev/null; }; }
ask() {  # prompt -> sets $resp; reads from the terminal even when stdin is a pipe
    if [ -t 0 ]; then read -r -p "$1" resp; else read -r -p "$1" resp </dev/tty; fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# Resolve the project root: --project > $CLAUDE_PROJECT_DIR > the project this
# script is installed in (<project>/.claude/orion/orion.sh) > git toplevel > cwd.
resolve_project() {
    local p="${1:-}" here
    if [ -z "$p" ] && [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then p="$CLAUDE_PROJECT_DIR"; fi
    if [ -z "$p" ]; then
        here="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" 2>/dev/null && pwd || true )"
        if [ -n "$here" ] && [ -f "$here/.orion-manifest" ] && [ "$(basename "$here")" = "orion" ]; then
            p="$( cd "$here/../.." && pwd )"
        fi
    fi
    if [ -z "$p" ]; then p="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; fi
    [ -d "$p" ] || die "project directory not found: $p"
    ( cd "$p" && pwd )
}

# Read a flat value from config.json without jq: a quoted string, or else a bare number.
config_get() {  # file key default
    local v=""
    if [ -f "$1" ]; then
        v=$(sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n1)
        [ -n "$v" ] || v=$(sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$1" | head -n1)
        v=$(printf '%s' "$v" | sed 's/\\\\/\\/g')   # JSON writes one backslash (a Windows path) as two
    fi
    printf '%s' "${v:-$3}"
}

# A string made safe to sit between double quotes in JSON: backslashes and double quotes escaped.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# Rewrite the value of one `"key": "string"` line of config.json in place; 1 when there is no such line.
config_set() {  # file key value
    local v tmp
    grep -q "^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"" "$1" || return 1
    v=$(json_escape "$3" | sed 's/[\\&|]/\\&/g')   # then escaped once more for the sed replacement below
    tmp=$(mktemp)
    sed "s|^\([[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\).*\(\"[[:space:]]*,\{0,1\}[[:space:]]*\)\$|\1$v\2|" "$1" > "$tmp" && mv "$tmp" "$1"
}

# The branch count the /clear-git-resources hook and scanner share: local branches plus
# remote-tracking branches of every remote, HEAD excluded, read from the local ref store (no network).
# skills/clear-git-resources/scripts/scan.sh runs this exact expression for its total: change both together.
branch_count() {  # project-dir
    git -C "$1" for-each-ref --format='%(refname)' refs/heads refs/remotes 2>/dev/null | grep -vc '/HEAD$' || true
}

# The worktree count they share: every worktree but the main checkout, entries whose folder is gone included.
# scan.sh runs this exact expression for its worktree total: change both together.
worktree_count() {  # project-dir
    local n
    n=$(git -C "$1" worktree list --porcelain 2>/dev/null | grep -c '^worktree ' || true)
    [ "${n:-0}" -gt 0 ] && n=$((n-1))
    printf '%s' "${n:-0}"
}

version_sha() { sed -n '1p' "$1" 2>/dev/null || true; }

# orion's version number: ORION_VERSION in the source, line 5 of the project's VERSION. Empty when the source or the
# install predates it, or when the value is not a whole number.
whole_number() { case "$1" in ""|*[!0-9]*) ;; *) printf '%s' "$1" ;; esac; }
version_number() { whole_number "$(sed -n '5p' "$1" 2>/dev/null | tr -d '\r')"; }
source_number() { whole_number "$(tr -d ' \t\r\n' < "$1/ORION_VERSION" 2>/dev/null || true)"; }
version_label() {  # sha number -> "orion <number>", or the short sha when there is no number
    if [ -n "$2" ]; then printf 'orion %s' "$2"; else short "$1"; fi
}

short() { printf '%s' "${1:0:7}"; }

# Per-computer, per-project state that must never be committed (the orion version the person
# declined with `update --skip`, the one-shot "post-install check pending" marker, the rules fingerprint last checked).
cache_file() {  # suffix
    printf '%s/orion/%s.%s' "${XDG_CACHE_HOME:-$HOME/.cache}" "$(printf '%s' "$PROJECT" | cksum | cut -d' ' -f1)" "$1"
}

# A fingerprint of the rules orion ships into this project: BASE_CLAUDE.md and every .md file of every
# orion-managed skill. The session-start hook asks for /orion-verify once each time it changes on this computer.
# One find and one cat for all of it: a process per file costs seconds under Git Bash, on every session start.
rules_sum() {
    local entry f dirs=() files=()
    if [ -f "$PROJECT/.claude/orion/BASE_CLAUDE.md" ]; then files+=("$PROJECT/.claude/orion/BASE_CLAUDE.md"); fi
    for entry in "$PROJECT"/.claude/skills/*/; do
        [ -f "${entry%/}/$MARKER" ] || continue
        dirs+=("${entry%/}")
    done
    if [ ${#dirs[@]} -gt 0 ]; then
        while IFS= read -r f; do files+=("$f"); done < <(find "${dirs[@]}" -type f -name '*.md' | LC_ALL=C sort)
    fi
    if [ ${#files[@]} -gt 0 ]; then cat "${files[@]}" 2>/dev/null || true; fi | cksum | cut -d' ' -f1
}

rules_mark() {  # [sum]: records that this computer has checked these rules
    local f; f="$(cache_file rules-checked)"
    mkdir -p "$(dirname "$f")" 2>/dev/null && printf '%s' "${1:-$(rules_sum)}" > "$f" || true
}

# The `name:` value of a skill's front matter (quotes stripped), or nothing.
skill_name() {  # SKILL.md
    awk 'NR==1 && $0 !~ /^---\r?$/ {exit} NR>1 && $0 ~ /^---\r?$/ {exit}
         /^name:/ { sub(/^name:[ \t]*/, ""); sub(/\r$/, ""); gsub(/^["'"'"']|["'"'"']$/, ""); print; exit }' "$1" 2>/dev/null
}

# Fetch orion into a temp dir. Sets SRC_DIR and SRC_SHA. If this script sits in
# an orion checkout (skills/ and baselines/ beside it) that checkout is used.
TMP_DIR=""
cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR" || true; }
trap cleanup EXIT
trap 'exit 143' TERM   # a timed-out run still cleans up: exiting on the signal runs the EXIT trap
trap 'exit 130' INT

fetch_source() {  # source ref
    local here
    here="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" 2>/dev/null && pwd || true )"
    if [ -n "$here" ] && [ -d "$here/skills" ] && [ -d "$here/baselines" ] && [ -f "$here/orion.sh" ]; then
        SRC_DIR="$here"
        SRC_SHA="$(git -C "$here" rev-parse HEAD 2>/dev/null || printf 'local')"
        SRC_TIME="$(git -C "$here" log -1 --format=%ct 2>/dev/null || printf '0')"
        return
    fi
    have git || die "git is required to fetch orion"
    TMP_DIR="$(mktemp -d)"
    say "fetching orion ($2) from $1 ..."
    # ORION_FETCH_SECONDS (set by the session-start hook) time-limits the network fetch only, never the copy
    # that follows: a copy cut short half-way would leave the project with a half-updated orion.
    if [ -n "${ORION_FETCH_SECONDS:-}" ]; then
        limited "$ORION_FETCH_SECONDS" git clone --quiet --depth 1 --branch "$2" "$1" "$TMP_DIR/orion" 2>/dev/null \
            || die "could not fetch orion from $1 (ref $2) within $ORION_FETCH_SECONDS s"
    else
        git clone --quiet --depth 1 --branch "$2" "$1" "$TMP_DIR/orion" 2>/dev/null \
            || die "could not fetch orion from $1 (ref $2)"
    fi
    SRC_DIR="$TMP_DIR/orion"
    SRC_SHA="$(git -C "$SRC_DIR" rev-parse HEAD)"
    SRC_TIME="$(git -C "$SRC_DIR" log -1 --format=%ct 2>/dev/null || printf '0')"
}

# Run a command for at most N seconds, so the session-start hook ends inside its HOOK_TIMEOUT. Git never
# waits on a password prompt; with no SSH command of the person's own (GIT_SSH_COMMAND, GIT_SSH or
# core.sshCommand), plain ssh never waits on a passphrase or host-key prompt and gives up on an unreachable
# host after 5 s. Without timeout or gtimeout (macOS has neither) git also aborts a stalled transfer.
limited() {  # seconds command...
    local s="$1"; shift
    if [ -z "${GIT_SSH_COMMAND:-}${GIT_SSH:-}" ] && ! git -C "${PROJECT:-.}" config core.sshCommand >/dev/null 2>&1; then
        set -- env GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5" "$@"
    fi
    if have timeout; then GIT_TERMINAL_PROMPT=0 timeout "$s" "$@"
    elif have gtimeout; then GIT_TERMINAL_PROMPT=0 gtimeout "$s" "$@"
    else GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=10 "$@"; fi
}

# The newest orion's name for the declined-update record: its release number when updates go by number (as
# check_update_ctx decides), otherwise its commit. Needs latest_remote first.
latest_key() {  # installed-number ref
    if [ -n "$LATEST_NUM" ] && [ -n "$1" ] && [ "$2" = "$ORION_DEFAULT_REF" ]; then printf 'v%s' "$LATEST_NUM"; else printf '%s' "$LATEST_SHA"; fi
}

# One call for both: LATEST_SHA, the ref's commit, and LATEST_NUM, the highest release tag (v<N>, pushed by the
# release workflow each time ORION_VERSION rises). Either is empty when the source has none.
latest_remote() {  # source ref
    local out=""
    out=$(limited 8 git ls-remote "$1" "refs/heads/$2" 'refs/tags/v*' 2>/dev/null || true)
    LATEST_SHA="$(printf '%s\n' "$out" | awk -v r="refs/heads/$2" '$2 == r { print $1; exit }')"
    LATEST_NUM="$(printf '%s\n' "$out" | awk '$2 ~ /^refs\/tags\/v[0-9]+$/ { n = substr($2, 12) + 0; if (!f || n > m) m = n; f = 1 } END { if (f) print m }')"
}

# --------------------------------------------------------------------------
# JSON edits on settings files (jq > python3 > powershell > manual note)
# --------------------------------------------------------------------------
json_tool() {
    # python is probed by running it: on Windows a "python3" alias stub can exist without a real install
    if [ -n "${ORION_JSON_TOOL:-}" ]; then echo "$ORION_JSON_TOOL"
    elif have jq; then echo jq
    elif python3 -c 'import json' >/dev/null 2>&1; then echo python3
    elif python -c 'import json' >/dev/null 2>&1; then echo python
    elif have powershell.exe; then echo powershell
    else echo none; fi
}

# Every reader below tolerates a UTF-8 byte-order mark (jq skips it, python reads utf-8-sig, PowerShell
# reads -Encoding UTF8); every writer drops it. jq and python both write two-space indentation.
json_valid() {  # file -> 0 when it parses (or when no JSON tool exists to tell)
    local tool; tool=$(json_tool)
    case "$tool" in
        jq) jq empty "$1" >/dev/null 2>&1 ;;
        python3|python) "$tool" -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8-sig"))' "$1" >/dev/null 2>&1 ;;
        powershell) powershell.exe -NoProfile -NonInteractive -Command "Get-Content -Raw -Encoding UTF8 '$(cygpath -w "$1" 2>/dev/null || printf '%s' "$1")' | ConvertFrom-Json | Out-Null" >/dev/null 2>&1 ;;
        *) return 0 ;;
    esac
}

# How many SessionStart hook commands run orion's script. Reads the hooks themselves, so a permission
# rule or any other setting that merely mentions the script does not count. Prints nothing when the
# file does not parse. Native Windows jq, python and PowerShell end their output with \r, so it is stripped.
hook_count() { hook_count_raw "$1" | tr -d '\r'; }
hook_count_raw() {  # settings-file
    local f="$1" tool
    [ -f "$f" ] || { echo 0; return; }
    tool=$(json_tool)
    # The script path sits inside the program text, never as an argument of its own: Git Bash rewrites an
    # argument that starts with / into a Windows path before a native jq or python sees it.
    case "$tool" in
        jq) jq '[.hooks.SessionStart[]?.hooks[]?.command // "" | select(contains("/.claude/orion/orion.sh"))] | length' "$f" 2>/dev/null || true ;;
        python3|python)
            "$tool" - "$f" 2>/dev/null <<'PY' || true
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8-sig"))
ss = (d.get("hooks") or {}).get("SessionStart") or []
print(sum(1 for g in ss for x in (g.get("hooks") or []) if "/.claude/orion/orion.sh" in (x.get("command") or "")))
PY
            ;;
        powershell)
            powershell.exe -NoProfile -NonInteractive -Command "
                \$d = Get-Content -Raw -Encoding UTF8 '$(cygpath -w "$f" 2>/dev/null || printf '%s' "$f")' | ConvertFrom-Json
                @(\$d.hooks.SessionStart | ForEach-Object { \$_.hooks } | Where-Object { \$_.command -like '*$HOOK_NEEDLE*' }).Count
            " 2>/dev/null || true ;;
        *) grep -cF "$HOOK_NEEDLE" "$f" || true ;;
    esac
}

settings_add_hook() {  # settings-file
    local f="$1" tool
    mkdir -p "$(dirname "$f")"
    if [ "$(hook_count "$f")" -gt 0 ] 2>/dev/null; then
        say "  =    update check hook already present in ${f#"$PROJECT"/}"
        settings_raise_hook_timeout "$f"
        return
    fi
    [ -f "$f" ] || printf '{}\n' > "$f"
    tool=$(json_tool)
    case "$tool" in
        jq)
            local tmp; tmp=$(mktemp)
            jq --arg cmd "$HOOK_CMD" --argjson t "$HOOK_TIMEOUT" '.hooks = (.hooks // {}) | .hooks.SessionStart = ((.hooks.SessionStart // []) + [{matcher:"startup|resume", hooks:[{type:"command", command:$cmd, timeout:$t}]}])' "$f" > "$tmp" && mv "$tmp" "$f" ;;
        python3|python)
            "$tool" - "$f" "$HOOK_CMD" "$HOOK_TIMEOUT" <<'PY'
import json, sys
f, cmd, t = sys.argv[1], sys.argv[2], int(sys.argv[3])
d = json.load(open(f, encoding="utf-8-sig"))
h = d.setdefault("hooks", {})
h.setdefault("SessionStart", []).append({"matcher": "startup|resume", "hooks": [{"type": "command", "command": cmd, "timeout": t}]})
open(f, "w", encoding="utf-8").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
            ;;
        powershell)
            powershell.exe -NoProfile -NonInteractive -Command "
                \$f = '$(cygpath -w "$f" 2>/dev/null || printf '%s' "$f")'; \$cmd = '$HOOK_CMD'
                \$d = Get-Content -Raw -Encoding UTF8 \$f | ConvertFrom-Json
                if (-not \$d.PSObject.Properties['hooks']) { \$d | Add-Member -NotePropertyName hooks -NotePropertyValue (New-Object PSObject) }
                if (-not \$d.hooks.PSObject.Properties['SessionStart']) { \$d.hooks | Add-Member -NotePropertyName SessionStart -NotePropertyValue @() }
                \$entry = [PSCustomObject]@{ matcher = 'startup|resume'; hooks = @([PSCustomObject]@{ type = 'command'; command = \$cmd; timeout = $HOOK_TIMEOUT }) }
                \$d.hooks.SessionStart = @(\$d.hooks.SessionStart) + @(\$entry)
                [IO.File]::WriteAllText(\$f, (\$d | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
            " >/dev/null ;;
        *)
            warn "no jq/python/powershell found - add this SessionStart hook to $f by hand:"
            warn "  {\"hooks\":{\"SessionStart\":[{\"matcher\":\"startup|resume\",\"hooks\":[{\"type\":\"command\",\"command\":\"$HOOK_CMD\",\"timeout\":$HOOK_TIMEOUT}]}]}}"
            return ;;
    esac
    say "  +    update check hook in ${f#"$PROJECT"/}"
}

# Earlier installs gave the hook "timeout": 20, too little for an auto-update on Windows: every orion hook
# whose numeric timeout is below HOOK_TIMEOUT is raised to it. The file is rewritten only when something changes.
settings_raise_hook_timeout() {  # settings-file
    local state
    state=$(raise_hook_timeout "$1" | tr -d '\r' || true)
    case "$state" in [1-9]*) say "  ~    update check hook time limit raised to $HOOK_TIMEOUT s in ${1#"$PROJECT"/}" ;; esac
}
raise_hook_timeout() {  # settings-file -> prints "<raised> <orion hooks>" as found BEFORE the raise, or nothing
    local f="$1" tool
    [ -f "$f" ] || return 0
    tool=$(json_tool)
    case "$tool" in
        jq)
            local orion='.hooks.SessionStart[]?.hooks[]? | select((.command // "") | contains("/.claude/orion/orion.sh"))'
            local low="$orion | select((.timeout | type) == \"number\" and .timeout < \$t)" state
            state=$(jq -r --argjson t "$HOOK_TIMEOUT" "\"\\([$low] | length) \\([$orion] | length)\"" "$f" 2>/dev/null | tr -d '\r' || true)
            [ -n "$state" ] || return 0
            case "$state" in
                [1-9]*) local tmp; tmp=$(mktemp)
                        jq --argjson t "$HOOK_TIMEOUT" "($low | .timeout) |= \$t" "$f" > "$tmp" && mv "$tmp" "$f" || return 0 ;;
            esac
            echo "$state" ;;
        python3|python)
            "$tool" - "$f" "$HOOK_TIMEOUT" 2>/dev/null <<'PY' || true
import json, sys
f, t = sys.argv[1], int(sys.argv[2])
d = json.load(open(f, encoding="utf-8-sig"))
n = total = 0
for g in (d.get("hooks") or {}).get("SessionStart") or []:
    for x in g.get("hooks") or []:
        if "/.claude/orion/orion.sh" not in (x.get("command") or ""):
            continue
        total += 1
        to = x.get("timeout")
        if type(to) in (int, float) and to < t:
            x["timeout"] = t
            n += 1
if n:
    open(f, "w", encoding="utf-8").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
print(n, total)
PY
            ;;
        powershell)
            powershell.exe -NoProfile -NonInteractive -Command "
                \$f = '$(cygpath -w "$f" 2>/dev/null || printf '%s' "$f")'
                \$d = Get-Content -Raw -Encoding UTF8 \$f | ConvertFrom-Json
                \$n = 0; \$total = 0
                foreach (\$g in @(\$d.hooks.SessionStart)) { foreach (\$x in @(\$g.hooks)) {
                    if (-not (\$x.command -like '*$HOOK_NEEDLE*')) { continue }
                    \$total++
                    \$to = \$x.timeout
                    \$num = (\$to -is [int]) -or (\$to -is [long]) -or (\$to -is [double]) -or (\$to -is [decimal])
                    if (\$num -and \$to -lt $HOOK_TIMEOUT) { \$x.timeout = $HOOK_TIMEOUT; \$n++ }
                } }
                if (\$n -gt 0) { [IO.File]::WriteAllText(\$f, (\$d | ConvertTo-Json -Depth 10) + [Environment]::NewLine) }
                [string]\$n + ' ' + \$total
            " 2>/dev/null || true ;;
        *)
            warn "no jq/python/powershell found - if the orion SessionStart hook in $f has a \"timeout\" below $HOOK_TIMEOUT, set it to $HOOK_TIMEOUT by hand" ;;
    esac
}

settings_remove_hook() {  # settings-file
    local f="$1" tool
    [ "$(hook_count "$f")" -gt 0 ] 2>/dev/null || return 0
    tool=$(json_tool)
    case "$tool" in
        jq)
            local tmp; tmp=$(mktemp)
            jq '.hooks.SessionStart = [ (.hooks.SessionStart // [])[] | select(([.hooks[]?.command // ""] | any(contains("/.claude/orion/orion.sh"))) | not) ] | if (.hooks.SessionStart | length) == 0 then del(.hooks.SessionStart) else . end | if (.hooks | length) == 0 then del(.hooks) else . end' "$f" > "$tmp" && mv "$tmp" "$f" ;;
        python3|python)
            "$tool" - "$f" <<'PY'
import json, sys
f = sys.argv[1]
d = json.load(open(f, encoding="utf-8-sig"))
ss = d.get("hooks", {}).get("SessionStart", [])
ss = [g for g in ss if not any('/.claude/orion/orion.sh' in (x.get("command") or "") for x in g.get("hooks", []))]
if ss: d["hooks"]["SessionStart"] = ss
else:
    d.get("hooks", {}).pop("SessionStart", None)
    if not d.get("hooks"): d.pop("hooks", None)
open(f, "w", encoding="utf-8").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
            ;;
        powershell)
            powershell.exe -NoProfile -NonInteractive -Command "
                \$f = '$(cygpath -w "$f" 2>/dev/null || printf '%s' "$f")'
                \$d = Get-Content -Raw -Encoding UTF8 \$f | ConvertFrom-Json
                \$keep = @(\$d.hooks.SessionStart | Where-Object { -not (\$_.hooks | Where-Object { \$_.command -like '*/.claude/orion/orion.sh*' }) })
                if (\$keep.Count -gt 0) { \$d.hooks.SessionStart = \$keep } else { \$d.hooks.PSObject.Properties.Remove('SessionStart') }
                if (@(\$d.hooks.PSObject.Properties).Count -eq 0) { \$d.PSObject.Properties.Remove('hooks') }
                [IO.File]::WriteAllText(\$f, (\$d | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
            " >/dev/null ;;
        *)
            warn "no jq/python/powershell found - remove the orion SessionStart hook from $f by hand"
            return ;;
    esac
    say "  -    update check hook removed from ${f#"$PROJECT"/}"
}

settings_set_statusline() {  # settings-file command
    local f="$1" cmd="$2" tool
    mkdir -p "$(dirname "$f")"
    [ -f "$f" ] || printf '{}\n' > "$f"
    tool=$(json_tool)
    case "$tool" in
        jq)
            local tmp; tmp=$(mktemp)
            jq --arg cmd "$cmd" '.statusLine = {type: "command", command: $cmd}' "$f" > "$tmp" && mv "$tmp" "$f" ;;
        python3|python)
            "$tool" - "$f" "$cmd" <<'PY'
import json, sys
f, cmd = sys.argv[1], sys.argv[2]
d = json.load(open(f, encoding="utf-8-sig"))
d["statusLine"] = {"type": "command", "command": cmd}
open(f, "w", encoding="utf-8").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
            ;;
        powershell)
            powershell.exe -NoProfile -NonInteractive -Command "
                \$f = '$(cygpath -w "$f" 2>/dev/null || printf '%s' "$f")'; \$cmd = '$cmd'
                \$d = Get-Content -Raw -Encoding UTF8 \$f | ConvertFrom-Json
                \$sl = [PSCustomObject]@{ type = 'command'; command = \$cmd }
                if (\$d.PSObject.Properties['statusLine']) { \$d.statusLine = \$sl } else { \$d | Add-Member -NotePropertyName statusLine -NotePropertyValue \$sl }
                [IO.File]::WriteAllText(\$f, (\$d | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
            " >/dev/null ;;
        *)
            warn "no jq/python/powershell found - set this in $f by hand:"
            warn "  {\"statusLine\":{\"type\":\"command\",\"command\":\"$cmd\"}}"
            return ;;
    esac
    say "statusLine configured in $f"
}

# --------------------------------------------------------------------------
# apply: copy everything orion owns from SRC_DIR into the project
# --------------------------------------------------------------------------
copy_managed() {  # src dst
    rm -rf "$2"
    mkdir -p "$2"
    # marker first: an interrupted copy still looks orion-managed and gets redone next time
    printf '%s' "orion" > "$2/$MARKER"
    cp -R "$1"/. "$2"
    # a local checkout that ran Python carries compiled caches; they are not part of the skill
    find "$2" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
}

apply_skills() {  # mode(init|update) force(0|1)
    local mode="$1" force="$2" skills_dir="$PROJECT/.claude/skills" src_skills="$SRC_DIR/skills"
    local added=0 updated=0 pruned=0 skipped=0 entry name skill dest is_ours resp
    mkdir -p "$skills_dir"
    shopt -s nullglob
    for entry in "$skills_dir"/*/; do
        name=$(basename "$entry")
        [ -f "${entry%/}/$MARKER" ] || continue
        if [ ! -d "$src_skills/$name" ]; then
            rm -rf "${entry%/}"
            say "  -    $name (orion no longer ships it)"
            pruned=$((pruned+1))
        fi
    done
    for skill in "$src_skills"/*/; do
        name=$(basename "$skill"); dest="$skills_dir/$name"
        is_ours=0; [ -f "$dest/$MARKER" ] && is_ours=1
        if [ -e "$dest" ] && [ "$is_ours" != "1" ]; then
            if [ "$mode" = "update" ] || { [ "$force" != "1" ] && ! is_tty; }; then
                say "  skip $name (exists and is not an orion copy)"; skipped=$((skipped+1)); continue
            fi
            if [ "$force" != "1" ]; then
                ask "  !  $name exists and is not an orion copy. Overwrite? [y/N] "
                if [[ ! "$resp" =~ ^[Yy]$ ]]; then say "  skip $name"; skipped=$((skipped+1)); continue; fi
            fi
        fi
        copy_managed "${skill%/}" "$dest"
        if [ "$is_ours" = "1" ]; then say "  ~    $name"; updated=$((updated+1)); else say "  +    $name"; added=$((added+1)); fi
    done
    shopt -u nullglob
    say "  skills: $added added, $updated updated, $pruned removed, $skipped skipped"
}

apply_core() {  # source ref update-mode
    local dir="$PROJECT/.claude/orion" tmp mode="${3:-ask}"
    mkdir -p "$dir"
    # orion.sh may be the script currently running: write beside, then mv (atomic).
    tmp="$dir/.orion.sh.new"; cp "$SRC_DIR/orion.sh" "$tmp"; chmod +x "$tmp"; mv -f "$tmp" "$dir/orion.sh"
    cp "$SRC_DIR/baselines/BASE_CLAUDE.md" "$dir/BASE_CLAUDE.md"
    [ -f "$dir/ORION.md" ] && { rm -f "$dir/ORION.md"; say "  -    .claude/orion/ORION.md (the rules now live in BASE_CLAUDE.md)"; }
    # every project carries orion's status line, so each computer can follow the newest one it sees
    rm -rf "$dir/statusline"; cp -R "$SRC_DIR/baselines/statusline" "$dir/statusline"
    # only the offer of orion's personal rules: nothing imports it, the person takes clauses on their word
    rm -rf "$dir/global"; cp -R "$SRC_DIR/baselines/global" "$dir/global"
    # line 4, the source's commit time, is for information only; line 5, orion's version number, tells the
    # update check whether a release is newer, and the computer's status line whether this project's copy is
    printf '%s\n%s\n%s\n%s\n%s\n' "$SRC_SHA" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SRC_TIME:-0}" "$(source_number "$SRC_DIR")" > "$dir/VERSION"
    { printf '%s\n' "orion.sh" "BASE_CLAUDE.md" "VERSION" ".orion-manifest"
      ( cd "$SRC_DIR/baselines" && find statusline global -type f | LC_ALL=C sort ); } > "$dir/.orion-manifest"
    if [ ! -f "$dir/config.json" ]; then
        printf '{\n  "updateMode": "%s",\n  "source": "%s",\n  "ref": "%s",\n  "branchLimit": %s,\n  "worktreeLimit": %s\n}\n' \
            "$(json_escape "$mode")" "$(json_escape "$1")" "$(json_escape "$2")" "$BRANCH_LIMIT_DEFAULT" "$WORKTREE_LIMIT_DEFAULT" > "$dir/config.json"
        say "  +    .claude/orion/config.json (yours: updateMode $mode, edit to ask | auto | off; branchLimit $BRANCH_LIMIT_DEFAULT and worktreeLimit $WORKTREE_LIMIT_DEFAULT, a number or off)"
    fi
    say "  ~    .claude/orion/{orion.sh, BASE_CLAUDE.md, VERSION, statusline/, global/} @ $(version_label "$SRC_SHA" "$(source_number "$SRC_DIR")") ($(short "$SRC_SHA"))"
}

# The project's own CLAUDE.md: created once with the project-specific slots the
# mandatory rules rely on (see the last section of BASE_CLAUDE.md), never
# overwritten. An existing CLAUDE.md only gets the import line at the top.
write_claude_md_starter() {  # file
    cat > "$1" <<EOF
$IMPORT_LINE

# CLAUDE.md — <project name>

Project-specific facts the mandatory rules rely on. Fill every \`<angle-bracket>\` slot; delete a line the project
has no use for. A rule written here must not contradict the mandatory rules.

## Build and test commands

| Purpose | Command |
|---|---|
| Build | \`TBD\` |
| **The full suite** | \`TBD\` |
| One file | \`TBD\` |
| One test | \`TBD\` |
| Typecheck / static analysis | \`TBD\` |
| Lint | \`TBD\` |
| Deterministic checks on generated output (if any) | \`TBD\` |
| Dev server (if the review surface needs one) | \`TBD\` |

## Stack and layout

- Stack: **<language and version, pinned in <pin file>>**, **<test framework>**; CI runs on <runner>.
- Layout: \`<application code path>\` and \`<test code path>\`. Skip-count baseline: <N>.

## Worktrees

- Worktree root (outside the project): \`<worktree root>\`. Port = \`<base port> + issue number\`, written to the
  worktree's \`.env\` as \`<port variable>\`.

## Boundaries

- Deploys to: <environment>, from \`main\`.
- External read-only repositories: <none, or list them with their work-item key format>.
- Sensitive data classes that never enter the repository: <customer records, partner-owned schemas, …>.
- Boundaries an agent must not move: <none, or list them>.
- Working language for code, comments, commits, issues and docs: <language>.

## Pending until PRD v1

| # | File and section | Question | Decided by |
|---|---|---|---|
| P1 | \`CLAUDE.md\` build and test commands | <e.g. Which stack, and so which build/test/lint commands?> | <role> |
EOF
}

apply_claude_md() {
    local f="$PROJECT/CLAUDE.md" tmp
    if [ ! -f "$f" ]; then
        write_claude_md_starter "$f"
        say "  +    CLAUDE.md (project slots to fill in; it is yours now and imports the mandatory rules)"
    elif grep -qxF "$OLD_IMPORT_LINE" "$f"; then
        tmp=$(mktemp); sed "s|^$OLD_IMPORT_LINE\$|$IMPORT_LINE|" "$f" > "$tmp"; mv "$tmp" "$f"
        say "  ~    CLAUDE.md (import line now points at BASE_CLAUDE.md; nothing else touched)"
    elif ! grep -qxF "$IMPORT_LINE" "$f"; then
        tmp=$(mktemp); { printf '%s\n\n' "$IMPORT_LINE"; cat "$f"; } > "$tmp"; mv "$tmp" "$f"
        say "  ~    CLAUDE.md (import line added at the top; nothing else touched)"
    else
        say "  =    CLAUDE.md (already imports the mandatory rules)"
    fi
}

# Earlier orion versions copied skills to ~/.claude/skills (user level). A
# user-level copy with the same name as a project copy is confusing, and those
# copies carry orion's own marker, so init retires them.
retire_user_level_copies() {
    local entry
    shopt -s nullglob
    for entry in "$HOME"/.claude/skills/*/; do
        if [ -f "${entry%/}/$MARKER" ]; then
            rm -rf "${entry%/}"
            say "  -    ~/.claude/skills/$(basename "$entry") (old user-level orion copy retired)"
        fi
    done
    shopt -u nullglob
}

# --------------------------------------------------------------------------
# status line (optional, per computer). Every project carries orion's copy in .claude/orion/statusline; the
# computer's copy is offered the newest one it sees and takes it (or merges it in) only on the person's word.
#   ~/.claude/statusline/.orion-baseline   orion version number and checksum of the newest baseline this computer took or skipped
#   ~/.claude/statusline/.orion-base/      the baseline the computer's copy was made from (the merge base)
# --------------------------------------------------------------------------
SL_STAMP=".orion-baseline"
SL_BASE=".orion-base"
# An orion before version numbers stamped a Unix commit time (ten digits) instead: no version number comes near it.
SL_OLD_STAMP_MIN=1000000000
sl_home() { printf '%s' "$HOME/.claude/statusline"; }

# One line per file (orion's own bookkeeping left out): its path and the checksum of its text without carriage
# returns, so a copy checked out with Windows line endings still counts as the same.
tree_sum() {  # dir
    ( cd "$1" 2>/dev/null && find . -type f ! -path "./$SL_BASE/*" ! -name "$SL_STAMP" ! -name .DS_Store ! -name Thumbs.db \
        | LC_ALL=C sort | while IFS= read -r f; do
        printf '%s %s\n' "$f" "$(tr -d '\r' < "$f" | cksum)"; done ) || true
}

# Copy a folder's files without carriage returns: bash cannot run a script with Windows line endings.
copy_text_tree() {  # src dst
    local f
    mkdir -p "$2"
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        mkdir -p "$2/$(dirname "$f")"; tr -d '\r' < "$1/$f" > "$2/$f"
        case "$f" in *.sh) chmod +x "$2/$f" ;; esac
    done <<< "$(cd "$1" && find . -type f ! -path './.*')"
}

# Make the computer's copy exactly the baseline in <src> and record it as the merge base. Built beside the
# copy and swapped in, so a run cut short never leaves half a status line; sl_restore finishes a cut swap.
sl_seed() {  # src stamp
    local dest; dest="$(sl_home)"
    rm -rf "$dest.new"; copy_text_tree "$1" "$dest.new"; copy_text_tree "$1" "$dest.new/$SL_BASE"
    sl_mark "$2" "$1" "$dest.new"
    rm -rf "$dest.old"; [ ! -d "$dest" ] || mv "$dest" "$dest.old"
    mv "$dest.new" "$dest"; rm -rf "$dest.old"
}
sl_restore() { local dest; dest="$(sl_home)"; [ -d "$dest" ] || [ ! -d "$dest.old" ] || mv "$dest.old" "$dest"; }

# Record the newest baseline this computer has seen (taken, merged or skipped): its orion version number, then its checksum.
sl_mark() {  # stamp src [statusline-dir]
    printf '%s\n%s\n' "$1" "$(tree_sum "$2" | cksum)" > "${3:-$(sl_home)}/$SL_STAMP"
}

sl_number() { case "$1" in ""|*[!0-9]*) printf '0' ;; *) printf '%s' "$1" ;; esac; }
# A commit time on line 1 counts as version 0, so newer status lines are offered again. The bound is not this
# project's own version number: a real, newer one stamped by another project on this computer must still win.
sl_stamp() {
    local n; n="$(sl_number "$(sed -n '1p' "$(sl_home)/$SL_STAMP" 2>/dev/null | tr -d '\r')")"
    [ "$n" -lt "$SL_OLD_STAMP_MIN" ] || n=0
    printf '%s' "$n"
}
sl_seen() { sed -n '2p' "$(sl_home)/$SL_STAMP" 2>/dev/null | tr -d '\r'; }
project_stamp() { sl_number "$(version_number "$PROJECT/.claude/orion/VERSION")"; }

# Compare the computer's status line with this project's copy when that copy is newer. It never changes what
# the status line shows without the person's word. Prints "new" (an unedited copy: taking orion's waits for
# their word), "offer" (the person edited theirs: a merge waits for their word) or nothing.
statusline_sync() {
    local dest src t; dest="$(sl_home)"; src="$PROJECT/.claude/orion/statusline"
    sl_restore
    { [ -f "$dest/$SL_STAMP" ] && [ -d "$src" ]; } || return 0
    t="$(project_stamp)"
    # never step back: another project on this computer may carry an older orion
    [ "$t" -gt "$(sl_stamp)" ] || return 0
    if [ "$(tree_sum "$dest")" = "$(tree_sum "$src")" ]; then
        # already the same files: only the bookkeeping moves forward
        sl_seed "$src" "$t"
    elif [ "$(tree_sum "$src" | cksum)" = "$(sl_seen)" ]; then
        # a newer orion whose status line did not change since the one last taken or skipped: nothing to offer
        sl_mark "$t" "$src"
    elif [ -d "$dest/$SL_BASE" ] && [ "$(tree_sum "$dest")" = "$(tree_sum "$dest/$SL_BASE")" ]; then
        printf 'new'
    else
        printf 'offer'
    fi
}

# Merge this project's baseline into the computer's copy: the person's edits stay, orion's changes come in.
statusline_merge() {
    local dest src t f mine new rc conflicts=""; dest="$(sl_home)"; src="$PROJECT/.claude/orion/statusline"; t="$(project_stamp)"
    if [ ! -d "$dest/$SL_BASE" ]; then
        # installed before orion kept a merge base: nothing tells the person's edits from an older baseline
        rm -rf "$dest.bak"; cp -R "$dest" "$dest.bak"; sl_seed "$src" "$t"
        say "status line: replaced with orion's newest; your old copy is in ~/.claude/statusline.bak - carry over any change of your own from there"
        return
    fi
    if [ "$(tree_sum "$dest")" = "$(tree_sum "$dest/$SL_BASE")" ]; then
        # no edits of the person's own (line endings aside): nothing to keep, take orion's as it is
        sl_seed "$src" "$t"
        say "status line: orion's newest taken"
        return
    fi
    have git || die "git is required to merge the status line"
    new="$(mktemp)"
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        mine="$dest/$f"; tr -d '\r' < "$src/$f" > "$new"
        if [ ! -f "$mine" ]; then
            # deleted by the person and left alone by orion: stays deleted
            [ -f "$dest/$SL_BASE/$f" ] && [ "$(cksum < "$new")" = "$(tr -d '\r' < "$dest/$SL_BASE/$f" | cksum)" ] && continue
            mkdir -p "$(dirname "$mine")"; cp "$new" "$mine"; continue
        fi
        [ -f "$dest/$SL_BASE/$f" ] || { mkdir -p "$(dirname "$dest/$SL_BASE/$f")"; : > "$dest/$SL_BASE/$f"; }
        rc=0; git merge-file -L yours -L "orion before" -L "orion now" "$mine" "$dest/$SL_BASE/$f" "$new" || rc=$?
        [ "$rc" -eq 0 ] || conflicts="$conflicts ~/.claude/statusline/${f#./}"
    done <<< "$(cd "$src" && find . -type f ! -path './.*')"
    rm -f "$new"
    # a file orion dropped goes too, unless the person changed it
    while IFS= read -r f; do
        if [ -n "$f" ] && [ ! -f "$src/$f" ] && [ -f "$dest/$f" ] \
           && [ "$(tr -d '\r' < "$dest/$f" | cksum)" = "$(tr -d '\r' < "$dest/$SL_BASE/$f" | cksum)" ]; then
            rm -f "$dest/$f"
        fi
    done <<< "$(cd "$dest/$SL_BASE" && find . -type f)"
    rm -rf "${dest:?}/$SL_BASE"; copy_text_tree "$src" "$dest/$SL_BASE"; sl_mark "$t" "$src"
    if [ -n "$conflicts" ]; then
        say "status line: merged, but your edits and orion's touch the same lines in:$conflicts"
        say "resolve the <<<<<<< / >>>>>>> markers there; the status line does not run until they are gone"
        return 1
    fi
    say "status line: orion's changes merged into your copy; your edits kept"
}

install_statusline() {  # force
    local src="$SRC_DIR/baselines/statusline" dest; dest="$(sl_home)"
    [ -d "$src" ] || { warn "status line baseline not found in source"; return; }
    if [ -f "$dest/statusline.sh" ] && [ "$1" != "1" ]; then
        say "  =    statusline (already installed - yours to edit; newer orion versions are merged in on your word)"
    else
        sl_seed "$src" "$(sl_number "$(source_number "$SRC_DIR")")"
        say "  +    statusline -> ~/.claude/statusline"
    fi
    settings_set_statusline "$HOME/.claude/settings.json" "bash \"$dest/statusline.sh\""
    if have npx && have jq; then
        say "warming the month-to-date cost cache (one-time, best effort)..."
        ( since=$(date +%Y%m01); cache="$HOME/.cache/claude-statusline/cost-mtd.txt"
          mkdir -p "$(dirname "$cache")" 2>/dev/null
          total=$(npx -y ccusage daily --json --since "$since" 2>/dev/null | jq -r '.totals.totalCost // empty')
          [ -n "$total" ] && printf '%.2f' "$total" > "$cache" ) || true
    fi
}

# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------
cmd_init() {
    local source="$ORION_DEFAULT_SOURCE" ref="$ORION_DEFAULT_REF" force=0 statusline="prompt" project="" resp mode=""
    local source_given=0 ref_given=0 key val old n
    while [ $# -gt 0 ]; do
        case "$1" in
            --source) source="$2"; source_given=1; shift 2 ;;
            --ref) ref="$2"; ref_given=1; shift 2 ;;
            --update-mode) mode="$2"; shift 2 ;;
            --project) project="$2"; shift 2 ;;
            --force) force=1; shift ;;
            --statusline) statusline=yes; shift ;;
            --no-statusline) statusline=no; shift ;;
            -h|--help) usage ;;
            *) die "unknown option for init: $1" ;;
        esac
    done
    PROJECT="$(resolve_project "$project")"
    local cfg="$PROJECT/.claude/orion/config.json"
    if [ -f "$cfg" ]; then
        [ "$source_given" = "1" ] || source="$(config_get "$cfg" source "$source")"
        [ "$ref_given" = "1" ] || ref="$(config_get "$cfg" ref "$ref")"
    fi
    case "$mode" in ""|ask|auto|off) ;; *) die "--update-mode must be ask, auto or off (got: $mode)" ;; esac
    say "orion init -> $PROJECT"
    # config.json is yours, but a --source or --ref given on the command line is an explicit request to change it.
    if [ -f "$cfg" ]; then
        for key in source ref; do
            if [ "$key" = "source" ]; then [ "$source_given" = "1" ] || continue; val="$source"
            else [ "$ref_given" = "1" ] || continue; val="$ref"; fi
            old="$(config_get "$cfg" "$key" "")"
            [ "$old" = "$val" ] && continue
            if config_set "$cfg" "$key" "$val"; then say "  ~    .claude/orion/config.json: $key changed from '$old' to '$val' (from --$key)"
            else warn "could not set $key in .claude/orion/config.json; set \"$key\": \"$val\" there by hand"; fi
        done
    fi
    # config.json is written once and never touched again, so the update mode is chosen here.
    if [ -z "$mode" ] && [ ! -f "$cfg" ] && is_tty; then
        say "When a newer orion exists, what should happen at session start?"
        say "  1) ask   - offer the update and let you say yes or no (default)"
        say "  2) auto  - update by itself and tell you in one line"
        say "  3) off   - never check"
        ask "Choose [1/2/3] (Enter = ask): "
        case "$resp" in 2|auto) mode=auto ;; 3|off) mode=off ;; *) mode=ask ;; esac
    fi
    fetch_source "$source" "$ref"
    retire_user_level_copies
    apply_skills init "$force"
    apply_core "$source" "$ref" "${mode:-ask}"
    apply_claude_md
    settings_add_hook "$PROJECT/.claude/settings.json"
    if [ "$statusline" = "prompt" ]; then
        statusline=no
        if is_tty; then
            ask "Also install the orion status line for this computer (~/.claude/statusline, optional)? [y/N] "
            [[ "$resp" =~ ^[Yy]$ ]] && statusline=yes
        fi
    fi
    [ "$statusline" = "yes" ] && install_statusline "$force"
    # One-shot: the next session start asks Claude Code to run the post-install check.
    pending="$(cache_file verify-pending)"
    mkdir -p "$(dirname "$pending")" 2>/dev/null && printf '%s' "$(date +%s)" > "$pending" || true
    n="$(ignored_orion_paths | grep -c . || true)"
    [ "$n" -gt 0 ] 2>/dev/null && say "  !    $n file(s) orion installed are ignored by .gitignore, so teammates will not get them: /orion-verify proposes the fix"
    say ""
    say "done. Next: in Claude Code, run /orion-verify BEFORE your first commit. It checks that CLAUDE.md, the imported"
    say "rules, the skills and the settings fit together, fixes what is mechanical, and offers to fill the blank commands,"
    say "move folders the rules expect elsewhere and un-ignore orion's files. If you skip it, the next session start asks"
    say "for it once. Then review 'git status' and commit the new files on a branch so your team gets them."
}

# Every file orion installed that git ignores, one per line: a teammate's clone would miss it. Tracked files never count.
ignored_orion_paths() {
    git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
    local f entry paths=()
    for f in CLAUDE.md .claude/settings.json .claude/orion/config.json; do [ -e "$PROJECT/$f" ] && paths+=("$f"); done
    while IFS= read -r f; do
        f="${f%$'\r'}"; [ -n "$f" ] && [ -e "$PROJECT/.claude/orion/$f" ] && paths+=(".claude/orion/$f")
    done < <(cat "$PROJECT/.claude/orion/.orion-manifest" 2>/dev/null || true)
    for entry in "$PROJECT"/.claude/skills/*/; do
        [ -f "${entry%/}/$MARKER" ] || continue
        while IFS= read -r f; do paths+=("${f#"$PROJECT"/}"); done < <(find "${entry%/}" -type f)
    done
    [ ${#paths[@]} -gt 0 ] || return 0
    git -C "$PROJECT" check-ignore -- "${paths[@]}" 2>/dev/null || true
}

# A folder the mandatory rules name (docs/PRDs/, docs/ux/prototypes/, …) that the project keeps under another path:
# the first folder, among the files git tracks or would track, whose path ends with every part after `docs/`
# (`…/PRDs`, `…/ux/prototypes`), any case. Prints its path, or nothing. awk reads to the end: stopping early would
# kill git with SIGPIPE, and pipefail would end verify.
misplaced_folder() {  # expected-folder
    local tail; tail="${1%/}"; tail="${tail#docs/}"
    git -C "$PROJECT" ls-files --cached --others --exclude-standard 2>/dev/null | awk -F/ -v t="$tail" '
        BEGIN { k = split(tolower(t), want, "/") }
        found || /^\.claude\// { next }
        { for (i = k; i < NF && !found; i++) {
              ok = 1; for (j = 1; j <= k; j++) if (tolower($(i - k + j)) != want[j]) { ok = 0; break }
              if (ok) { p = $1; for (j = 2; j <= i; j++) p = p "/" $j; found = 1 }
          } }
        END { if (found) print p }'
}

# The folder among .claude, .claude/orion and .claude/skills that a .gitignore line ignores as a whole (`.claude/`,
# `/.claude`, `orion/`, …), not just its contents (`.claude/*`). git cannot re-include a file inside such a folder.
# Prints it with a trailing slash, or nothing.
ignored_whole_folder() {
    local f pat
    for f in .claude .claude/orion .claude/skills; do
        pat="$(git -C "$PROJECT" check-ignore -v -- "$f/" 2>/dev/null | cut -f1 | cut -d: -f3-)" || true
        pat="${pat#/}"; pat="${pat#\*\*/}"; pat="${pat%/}"
        if [ -n "$pat" ] && { [ "$pat" = "$f" ] || [ "$pat" = "$(basename "$f")" ]; }; then printf '%s/' "$f"; return; fi
    done
}

cmd_update() {
    local force=0 project="" quiet=0 skip=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) project="$2"; shift 2 ;;
            --force) force=1; shift ;;
            --quiet) quiet=1; shift ;;
            --skip) skip=1; shift ;;
            -h|--help) usage ;;
            *) die "unknown option for update: $1" ;;
        esac
    done
    PROJECT="$(resolve_project "$project")"
    local dir="$PROJECT/.claude/orion" cfg="$PROJECT/.claude/orion/config.json" source ref current
    [ -f "$dir/VERSION" ] || die "orion is not installed in $PROJECT (run: orion.sh init)"
    source="$(config_get "$cfg" source "$ORION_DEFAULT_SOURCE")"; ref="$(config_get "$cfg" ref "$ORION_DEFAULT_REF")"
    if [ "$skip" = "1" ]; then
        latest_remote "$source" "$ref"
        [ -n "$LATEST_SHA" ] || die "could not reach $source to see which orion is the newest"
        mkdir -p "$(dirname "$(cache_file update-skipped)")"
        latest_key "$(version_number "$dir/VERSION")" "$ref" > "$(cache_file update-skipped)"
        say "orion update declined on this computer: the session start stays quiet until a newer orion comes out"
        return
    fi
    current="$(version_sha "$dir/VERSION")"
    fetch_source "$source" "$ref"
    # the hint is printed only without --quiet, so an auto-update (capped at 10 s on older hooks) skips the cost
    local rules_before=""; [ "$quiet" = "1" ] || rules_before="$(rules_sum)"
    # an update run by an older orion.sh left out the status line or the personal rules: redo it once
    { [ -d "$dir/statusline" ] && [ -d "$dir/global" ]; } || force=1
    if [ "$SRC_SHA" = "$current" ] && [ "$force" != "1" ]; then
        say "orion is already at $(short "$current") - nothing to do (pass --force to re-copy anyway)"
        settings_raise_hook_timeout "$PROJECT/.claude/settings.json"
        return
    fi
    say "orion update $(short "$current") -> $(short "$SRC_SHA") in $PROJECT"
    apply_skills update 0
    apply_core "$source" "$ref"
    apply_claude_md
    settings_add_hook "$PROJECT/.claude/settings.json"
    case "$(statusline_sync)" in
        new) say "  !    orion's status line changed and yours was left alone: 'bash .claude/orion/orion.sh statusline merge' takes it ('statusline skip' declines this version)" ;;
        offer) say "  !    your status line has edits of your own, so it was left alone: 'bash .claude/orion/orion.sh statusline merge' takes orion's changes and keeps yours ('statusline skip' declines this version)" ;;
    esac
    if [ "$quiet" != "1" ]; then
        say "done. Review with 'git status' / 'git diff', then commit on a branch so your team gets it."
        [ "$(rules_sum)" = "$rules_before" ] || say "orion's rules or skill instructions changed: run /orion-verify to check they still fit with CLAUDE.md, the project's own skills and your own rules file."
    fi
}

# Session-start hook. Never fails the session: any problem -> silent exit 0.
cmd_check() {
    local force=0 project=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) project="$2"; shift 2 ;;
            --force) force=1; shift ;;
            *) shift ;;
        esac
    done
    PROJECT="$(resolve_project "$project")" || exit 0
    local dir="$PROJECT/.claude/orion" now ctx tidy pending pulled global
    [ -f "$dir/VERSION" ] || exit 0
    pulled="$(check_pull_ctx)"
    # A fresh init leaves a one-shot marker: ask for the post-install check instead of an update.
    # Without the /orion-verify skill there is nothing to ask for, so the marker waits for it (or for `verify`).
    pending="$(cache_file verify-pending)"
    if [ -f "$pending" ] && [ -f "$PROJECT/.claude/skills/orion-verify/SKILL.md" ]; then
        rm -f "$pending" 2>/dev/null || true
        rules_mark
        ctx="orion was just installed in this project and its post-install check has not run yet. Before anything else, run the /orion-verify skill (.claude/skills/orion-verify/SKILL.md) exactly as written: it checks that CLAUDE.md, the imported BASE_CLAUDE.md, the skills under .claude/skills and the settings are consistent after the install, fixes what is mechanical, asks before touching anything the project owns, and reports in a few lines. Then continue with the user's request."
        global="$(check_global_ctx 1 "$(date +%s)")"
        [ -n "$global" ] && ctx="$ctx After /orion-verify: $global"
        [ -n "$pulled" ] && ctx="$ctx After that: $pulled"
        printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx"
        exit 0
    fi
    now=$(date +%s)
    ctx="$(check_update_ctx "$force")"
    for tidy in "$(check_rules_ctx)" "$(check_statusline_ctx)" "$(check_global_ctx "$force" "$now")" "$(check_branches_ctx "$force" "$now")" "$pulled"; do
        [ -n "$tidy" ] || continue
        if [ -n "$ctx" ]; then ctx="$ctx After that: $tidy"; else ctx="$tidy"; fi
    done
    [ -n "$ctx" ] || exit 0
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx"
}

# The update check, every session. Prints the context for Claude Code, or nothing when there is nothing to say.
check_update_ctx() {  # force
    local cfg="$PROJECT/.claude/orion/config.json" dir="$PROJECT/.claude/orion" mode source ref current latest hook
    local installed newer=0
    mode="$(config_get "$cfg" updateMode ask)"
    [ "$mode" = "off" ] && return 0
    # An update run by an older orion.sh cannot raise the hook's time limit (bash had already read the old
    # script), so the first check by the new script heals it, silently. Claude Code read the limit when this
    # session started, so this run still goes by the value from BEFORE the heal: "0 <n>" with n > 0 means
    # every orion hook already had HOOK_TIMEOUT; anything else (a lower limit, no hook, no JSON tool) does not.
    hook=$(raise_hook_timeout "$PROJECT/.claude/settings.json" 2>/dev/null | tr -d '\r' || true)
    source="$(config_get "$cfg" source "$ORION_DEFAULT_SOURCE")"; ref="$(config_get "$cfg" ref "$ORION_DEFAULT_REF")"
    current="$(version_sha "$dir/VERSION")"; installed="$(version_number "$dir/VERSION")"
    latest_remote "$source" "$ref"
    [ -n "$LATEST_SHA" ] || return 0
    # A release raises the version number, so a merge that changes nothing a project receives is not offered. Release
    # tags mark the default branch only; without a number on both sides any new commit counts, as before numbers.
    if [ -n "$LATEST_NUM" ] && [ -n "$installed" ] && [ "$ref" = "$ORION_DEFAULT_REF" ]; then
        [ "$LATEST_NUM" -gt "$installed" ] && newer=1
        latest="$(version_label "$LATEST_SHA" "$LATEST_NUM")"
    else
        [ "$LATEST_SHA" != "$current" ] && newer=1
        latest="$(short "$LATEST_SHA")"
    fi
    current="$(version_label "$current" "$installed")"
    # nothing newer, but an update run by an older orion.sh left out the status line or personal rules copy: offer it once more
    [ "$newer" = 0 ] && [ -d "$dir/statusline" ] && [ -d "$dir/global" ] && return 0
    # declined with `update --skip`: quiet until a newer orion, unless the person asked for the check (--force)
    [ "$mode" = "auto" ] || [ "$1" = "1" ] || [ "$(cat "$(cache_file update-skipped)" 2>/dev/null)" != "$(latest_key "$installed" "$ref")" ] || return 0
    case "$mode" in
        auto)
            # A process of its own: a failed fetch ends only that process (this hook still answers and
            # exits 0), and its own exit trap removes the temporary clone. With the full HOOK_TIMEOUT only the
            # fetch is time-limited (10 s): the copy always runs to the end, so the project is never left
            # half-updated, and 8 s check + 10 s fetch + the copy fit in it. While this session's hook still
            # has a lower limit (an install from before the raise), the whole update stays capped at 10 s as
            # before, so the session's own kill cannot land in the middle of the copy instead.
            if run_auto_update "$hook" >/dev/null 2>&1 </dev/null; then
                printf '%s' "orion (the repo-level utility framework in .claude/orion) was updated automatically from $current to $latest, as the project's updateMode is 'auto'. Tell the user in one line, and remind them to review 'git status' and commit the changed orion files on a branch."
            else
                printf '%s' "orion tried to update itself automatically ($current -> $latest) and failed. Tell the user in one line that running 'bash .claude/orion/orion.sh update' by hand will show the error."
            fi ;;
        *)
            printf '%s' "A newer orion is available for this project ($current -> $latest). Before anything else, ask the user with the AskUserQuestion tool whether to update orion now (options: 'Update now' recommended, 'Not now'). If they say yes, run 'bash .claude/orion/orion.sh update' from the project root, summarise the changed files in one line, and remind them to commit on a branch. If they say no, run 'bash .claude/orion/orion.sh update --skip' from the project root, so this version is not offered again on this computer, and continue with their request." ;;
    esac
}

# Every session, local only: once each time orion's rules change on this computer (an update, or a pull that
# brought one), ask for /orion-verify. Runs after the update check, so an auto-update is seen in the same session.
check_rules_ctx() {
    local sum
    [ -f "$PROJECT/.claude/skills/orion-verify/SKILL.md" ] || return 0
    sum="$(rules_sum)"
    [ "$(cat "$(cache_file rules-checked)" 2>/dev/null)" = "$sum" ] && return 0
    rules_mark "$sum"
    printf '%s' "orion's rules (.claude/orion/BASE_CLAUDE.md) or the instructions of its skills have changed since they were last checked on this computer, after an update or a pull that brought one. Before anything else, ask the user with the AskUserQuestion tool whether to check now that they still fit with the project's CLAUDE.md, the project's own skills and the user's own rules file (options: 'Check now' recommended, 'Not now'). If they say yes, run the /orion-verify skill (.claude/skills/orion-verify/SKILL.md) exactly as written. If they say no, continue with their request: it is not asked again until the rules change, and /orion-verify runs the check any time."
}

run_auto_update() {  # hook-timeout-state from raise_hook_timeout
    case "$1" in
        "0 "[1-9]*) ORION_FETCH_SECONDS=10 bash "${BASH_SOURCE[0]:-$0}" update --project "$PROJECT" --quiet ;;
        *) limited 10 bash "${BASH_SOURCE[0]:-$0}" update --project "$PROJECT" --quiet ;;
    esac
}

# Every session, local only: a newer status line in the project is offered, never taken on its own, in every
# update mode. Prints the context or nothing.
check_statusline_ctx() {
    local sync; sync="$(statusline_sync)"
    if [ "$sync" = "new" ]; then
        printf '%s' "orion's status line has changed, and the copy on this computer (~/.claude/statusline) was left as it is: orion never changes it without the user's word. Ask the user with the AskUserQuestion tool whether to take orion's new status line (options: 'Take it' recommended, 'Keep mine as it is'). If yes, run 'bash .claude/orion/orion.sh statusline merge' from the project root: their copy carries no edits of its own, so it simply becomes orion's new one. If no, run 'bash .claude/orion/orion.sh statusline skip' so this version is not offered again."
    elif [ "$sync" = "offer" ]; then
        printf '%s' "orion's status line has changed, and the copy on this computer (~/.claude/statusline) carries the user's own edits, so it was not replaced. Ask the user with the AskUserQuestion tool whether to merge orion's new status line changes into theirs (options: 'Merge them in' recommended, 'Keep mine as it is'). If yes, run 'bash .claude/orion/orion.sh statusline merge' from the project root: it keeps their edits (a copy installed before orion could merge is saved to ~/.claude/statusline.bak and replaced), and if it reports lines both changed, resolve the conflict markers in the named files with the user. If no, run 'bash .claude/orion/orion.sh statusline skip' so this version is not offered again."
    fi
}

# --------------------------------------------------------------------------
# personal rules (offered, never written). Every project carries orion's GLOBAL_CLAUDE.md in .claude/orion/global;
# what the person accepts lives in the ORION GLOBAL section at the end of their own ~/.claude/CLAUDE.md, whose
# heading version number is the only record of what was offered. orion.sh only reads that file.
# --------------------------------------------------------------------------
global_copy() { printf '%s' "$PROJECT/.claude/orion/global/GLOBAL_CLAUDE.md"; }
personal_rules() { printf '%s' "$HOME/.claude/CLAUDE.md"; }

# The version number on the person's ORION GLOBAL heading line (# ORION GLOBAL — v<N>), or nothing when there is no section.
global_stamp() {
    local f; f="$(personal_rules)"
    [ -f "$f" ] || return 0
    tr -d '\r' < "$f" | sed -n 's/^# ORION GLOBAL.* v\([0-9][0-9]*\)[[:space:]]*$/\1/p' | head -n1
}

# How many clauses of the project's GLOBAL_CLAUDE.md carry a version marker higher than that number (all of them without one).
global_newer() {
    local f; f="$(global_copy)"
    [ -f "$f" ] || { printf '0'; return 0; }
    tr -d '\r' < "$f" | sed -n 's/.* <!-- orion:v\([0-9][0-9]*\) -->$/\1/p' | awk -v t="$(global_stamp)" 't == "" || $0 + 0 > t + 0 { n++ } END { print n+0 }'
}

# Local only: offer the personal rules discussion while a clause is newer than the person's section, at most once a
# day per computer (any project) and never under updateMode off, in any other mode only offered. Prints the context or nothing.
check_global_ctx() {  # force now
    local n stamp last
    [ "$(config_get "$PROJECT/.claude/orion/config.json" updateMode ask)" = "off" ] && return 0
    n="$(global_newer)"
    [ "$n" -gt 0 ] 2>/dev/null || return 0
    stamp="${XDG_CACHE_HOME:-$HOME/.cache}/orion/global-offered"
    if [ "$1" != "1" ] && [ -f "$stamp" ]; then
        last=$(cat "$stamp" 2>/dev/null || echo 0)
        [ $(($2 - last)) -lt "$CHECK_INTERVAL_SECONDS" ] && return 0
    fi
    mkdir -p "$(dirname "$stamp")" 2>/dev/null && printf '%s' "$2" > "$stamp" || true
    printf '%s' "orion recommends personal rules for the user's own rules file (~/.claude/CLAUDE.md), and $n of them have not been offered on this computer yet. Ask the user with the AskUserQuestion tool whether to go through them now (options: 'Go through them now' recommended, 'Not now'). If yes, follow the steps at the top of .claude/orion/global/GLOBAL_CLAUDE.md exactly as written: the user's file changes only inside its ORION GLOBAL section and only on their word. If no, continue with their request: it is offered again tomorrow, and the user can ask to go through orion's personal rules any time."
}

# Every session: bring the branch the session opens on up to date with its remote copy, fast-forward only, as
# `git pull --ff-only` does (never a merge commit, never a rebase). Only the fetch is time-limited, so a slow
# network can never cut the checkout short. Silent when it pulled, had nothing to pull, could not reach the
# remote, or the session is on no branch or a branch with no remote copy; prints the context when refused.
check_pull_ctx() {
    local branch out
    have git || return 0
    branch="$(git -C "$PROJECT" symbolic-ref -q --short HEAD 2>/dev/null)" || return 0
    git -C "$PROJECT" config "branch.$branch.remote" >/dev/null 2>&1 || return 0
    limited 8 git -C "$PROJECT" fetch --quiet </dev/null >/dev/null 2>&1 || true
    git -C "$PROJECT" rev-parse -q --verify '@{upstream}' >/dev/null 2>&1 || return 0
    # merge.autoStash off: a pull blocked by local changes is refused and reported, never stashed
    out="$(git -c merge.autoStash=false -C "$PROJECT" merge --ff-only --quiet '@{upstream}' </dev/null 2>&1)" && return 0
    out="$(printf '%s' "$out" | grep -v '^[[:space:]]*$' | head -n1 | tr -d '\000-\037')"
    printf '%s' "At session start, git pull --ff-only on branch $(json_escape "$branch") was refused, so the branch may be behind its remote copy (git said: $(json_escape "$out")). Tell the user in one line; never force, rebase or reset the branch to fix it."
}

# A limit from config.json: the number, or nothing when it is off (a value that is not a number falls back to the default).
limit_of() {  # key default
    local v
    v="$(config_get "$PROJECT/.claude/orion/config.json" "$1" "$2")"
    case "$v" in off|0) ;; *[!0-9]*|"") printf '%s' "$2" ;; *) printf '%s' "$v" ;; esac
}

# The daily branch- and worktree-count check behind /clear-git-resources: only when that skill is installed,
# local only (no network), silent below both limits. Prints the context or nothing.
check_branches_ctx() {  # force now
    local blimit wlimit stamp last n w over=""
    [ -f "$PROJECT/.claude/skills/clear-git-resources/SKILL.md" ] || return 0
    have git || return 0
    blimit="$(limit_of branchLimit "$BRANCH_LIMIT_DEFAULT")"; wlimit="$(limit_of worktreeLimit "$WORKTREE_LIMIT_DEFAULT")"
    [ -n "$blimit$wlimit" ] || return 0
    stamp="$(cache_file branches-check)"
    if [ "$1" != "1" ] && [ -f "$stamp" ]; then
        last=$(cat "$stamp" 2>/dev/null || echo 0)
        [ $(($2 - last)) -lt "$CHECK_INTERVAL_SECONDS" ] && return 0
    fi
    n="$(branch_count "$PROJECT")"; w="$(worktree_count "$PROJECT")"
    if [ -n "$blimit" ] && [ "${n:-0}" -ge "$blimit" ] 2>/dev/null; then
        over="has $n git branches (local plus remote-tracking; the limit is $blimit, branchLimit)"
    fi
    if [ -n "$wlimit" ] && [ "${w:-0}" -ge "$wlimit" ] 2>/dev/null; then
        [ -n "$over" ] && over="$over and "
        over="${over}has $w git worktrees (the limit is $wlimit, worktreeLimit)"
    fi
    [ -n "$over" ] || return 0
    mkdir -p "$(dirname "$stamp")" 2>/dev/null && printf '%s' "$2" > "$stamp" || true
    printf '%s' "This project $over, set in .claude/orion/config.json. Before anything else, ask the user with the AskUserQuestion tool whether to tidy up now (options: 'Tidy up now' recommended, 'Not now'). If they say yes, run the /clear-git-resources skill (.claude/skills/clear-git-resources/SKILL.md) exactly as written: it deletes the user's own stale worktrees and branches whose work cannot be lost by itself, asks before deleting anyone else's stale ones, and never touches unmerged work or the audit and QA resources. If they say no, continue with their request and do not mention it again this session."
}

cmd_status() {
    local project=""
    while [ $# -gt 0 ]; do case "$1" in --project) project="$2"; shift 2 ;; *) shift ;; esac; done
    PROJECT="$(resolve_project "$project")"
    local dir="$PROJECT/.claude/orion" cfg="$PROJECT/.claude/orion/config.json" n=0 entry
    if [ ! -f "$dir/VERSION" ]; then say "orion is not installed in $PROJECT"; return; fi
    say "project:    $PROJECT"
    say "version:    $(version_label "$(version_sha "$dir/VERSION")" "$(version_number "$dir/VERSION")"), $(short "$(version_sha "$dir/VERSION")") ($(sed -n '2p' "$dir/VERSION") @ $(sed -n '3p' "$dir/VERSION"))"
    say "source:     $(config_get "$cfg" source "$ORION_DEFAULT_SOURCE")"
    say "updateMode: $(config_get "$cfg" updateMode ask)   (edit .claude/orion/config.json: ask | auto | off)"
    say "branchLimit: $(config_get "$cfg" branchLimit "$BRANCH_LIMIT_DEFAULT")   (branches now: $(branch_count "$PROJECT"); the hook offers /clear-git-resources at the limit; a number or off)"
    say "worktreeLimit: $(config_get "$cfg" worktreeLimit "$WORKTREE_LIMIT_DEFAULT")   (worktrees now: $(worktree_count "$PROJECT"); the hook offers /clear-git-resources at the limit; a number or off)"
    shopt -s nullglob
    for entry in "$PROJECT"/.claude/skills/*/; do
        [ -f "${entry%/}/$MARKER" ] && { say "skill:      $(basename "$entry")"; n=$((n+1)); }
    done
    shopt -u nullglob
    say "skills:     $n orion-managed"
    grep -qxF "$IMPORT_LINE" "$PROJECT/CLAUDE.md" 2>/dev/null && say "CLAUDE.md:  imports the mandatory rules" || say "CLAUDE.md:  does NOT import the mandatory rules (run: orion.sh update)"
    [ "$(hook_count "$PROJECT/.claude/settings.json")" -gt 0 ] 2>/dev/null && say "hook:       update check installed" || say "hook:       update check NOT installed"
}

cmd_uninstall() {
    local yes=0 project="" resp entry f line tmp
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) project="$2"; shift 2 ;;
            --yes|-y) yes=1; shift ;;
            -h|--help) usage ;;
            *) die "unknown option for uninstall: $1" ;;
        esac
    done
    PROJECT="$(resolve_project "$project")"
    local dir="$PROJECT/.claude/orion"
    if [ "$yes" != "1" ]; then
        is_tty || die "refusing to uninstall without --yes in a non-interactive shell"
        ask "Remove everything orion owns from $PROJECT (your CLAUDE.md rules and your own skills stay)? [y/N] "
        [[ "$resp" =~ ^[Yy]$ ]] || { say "aborted"; return; }
    fi
    shopt -s nullglob
    for entry in "$PROJECT"/.claude/skills/*/; do
        [ -f "${entry%/}/$MARKER" ] && { rm -rf "${entry%/}"; say "  -    skill $(basename "$entry")"; }
    done
    shopt -u nullglob
    rmdir "$PROJECT/.claude/skills" 2>/dev/null || true
    if [ -f "$dir/.orion-manifest" ]; then
        # a checkout with Windows line endings turns each line into "name\r": strip it, or nothing matches
        while IFS= read -r line || [ -n "$line" ]; do line="${line%$'\r'}"; [ -n "$line" ] && rm -f "$dir/$line"; done < "$dir/.orion-manifest"
        rm -f "$dir/.orion-manifest"
        # the folders the listed files sat in, deepest first; a folder still holding anything stays
        find "$dir" -mindepth 1 -depth -type d -exec rmdir {} \; 2>/dev/null || true
    fi
    rm -f "$dir/config.json"
    rmdir "$dir" 2>/dev/null && say "  -    .claude/orion" || warn "left .claude/orion in place (it holds files orion did not create)"
    f="$PROJECT/CLAUDE.md"
    if [ -f "$f" ] && { grep -qxF "$IMPORT_LINE" "$f" || grep -qxF "$OLD_IMPORT_LINE" "$f"; }; then
        # grep exits 1 when it keeps no line (a CLAUDE.md that held only the import line): not an error here
        tmp=$(mktemp); { grep -vxF "$IMPORT_LINE" "$f" || true; } | { grep -vxF "$OLD_IMPORT_LINE" || true; } | sed '1{/^$/d;}' > "$tmp"; mv "$tmp" "$f"
        say "  ~    CLAUDE.md (import line removed; your rules untouched)"
    fi
    settings_remove_hook "$PROJECT/.claude/settings.json"
    # last-check: the daily update stamp older versions left
    rm -f "$(cache_file verify-pending)" "$(cache_file rules-checked)" "$(cache_file update-skipped)" "$(cache_file last-check)" 2>/dev/null || true
    say "done. The status line (if installed) is a per-computer copy under ~/.claude/statusline and was left alone,"
    say "and so was your own ~/.claude/CLAUDE.md: the personal rules you accepted are yours."
}

# The answer to the session-start status line offer: take orion's changes (merged into an edited copy), or skip this version.
cmd_statusline() {
    local action="${1:-}" project=""
    shift || true
    while [ $# -gt 0 ]; do case "$1" in --project) project="$2"; shift 2 ;; *) die "unknown option for statusline: $1" ;; esac; done
    PROJECT="$(resolve_project "$project")"
    [ -f "$(sl_home)/$SL_STAMP" ] || die "orion's status line is not installed on this computer (run: orion.sh init --statusline)"
    [ -d "$PROJECT/.claude/orion/statusline" ] || die "this project carries no orion status line (run: orion.sh update)"
    case "$action" in merge|skip) ;; *) die "usage: orion.sh statusline merge|skip" ;; esac
    # never step back: a project with an older orion has nothing newer to merge or skip
    if [ "$(project_stamp)" -le "$(sl_stamp)" ]; then
        say "status line: nothing to $action - the copy on this computer already follows this project's orion version or a newer one"
        return
    fi
    case "$action" in
        merge) statusline_merge ;;
        skip) sl_mark "$(project_stamp)" "$PROJECT/.claude/orion/statusline"; say "status line: yours kept as it is; this orion version will not be offered again" ;;
    esac
}

# Mechanical post-install checks: one line per finding, never a fix. Exit 1 when
# anything FAILs. The /orion-verify skill runs this first, then fixes and reviews.
# Clears the one-shot marker that init leaves for the session-start hook and records the rules it checked.
VERIFY_FAIL=0; VERIFY_WARN=0
v_ok()   { say "  ok    $1: $2"; }
v_warn() { say "  WARN  $1: $2"; VERIFY_WARN=$((VERIFY_WARN+1)); }
v_fail() { say "  FAIL  $1: $2"; VERIFY_FAIL=$((VERIFY_FAIL+1)); }

cmd_verify() {
    local project=""
    while [ $# -gt 0 ]; do case "$1" in --project) project="$2"; shift 2 ;; -h|--help) usage ;; *) die "unknown option for verify: $1" ;; esac; done
    PROJECT="$(resolve_project "$project")"
    local dir="$PROJECT/.claude/orion" cfg="$PROJECT/.claude/orion/config.json" skills="$PROJECT/.claude/skills"
    local claude="$PROJECT/CLAUDE.md" settings="$PROJECT/.claude/settings.json" base="$PROJECT/.claude/orion/BASE_CLAUDE.md"
    local f n mode entry name sname ours names="" dups="" checks="" ref p slots ignored
    rm -f "$(cache_file verify-pending)" 2>/dev/null || true
    rules_mark
    say "orion verify -> $PROJECT"

    # 1. the files orion owns
    n=""
    for f in orion.sh BASE_CLAUDE.md VERSION .orion-manifest config.json global/GLOBAL_CLAUDE.md; do [ -f "$dir/$f" ] || n="$n $f"; done
    if [ -z "$n" ]; then v_ok core-files ".claude/orion/{orion.sh, BASE_CLAUDE.md, VERSION, .orion-manifest, config.json, global/GLOBAL_CLAUDE.md} present"
    else v_fail core-files "missing in .claude/orion:$n (fix: bash .claude/orion/orion.sh update --force, or init if orion.sh itself is gone)"; fi
    mode="$(config_get "$cfg" updateMode ask)"
    case "$mode" in ask|auto|off) v_ok config-update-mode "updateMode is '$mode'" ;;
        *) v_fail config-update-mode "updateMode is '$mode' in .claude/orion/config.json; must be ask, auto or off" ;; esac
    mode="$(config_get "$cfg" branchLimit "$BRANCH_LIMIT_DEFAULT")"
    case "$mode" in
        off) v_ok config-branch-limit "branchLimit is off (the hook never offers /clear-git-resources for branches)" ;;
        ""|*[!0-9]*) v_fail config-branch-limit "branchLimit is '$mode' in .claude/orion/config.json; must be a whole number or off" ;;
        *) v_ok config-branch-limit "branchLimit is $mode (branches now: $(branch_count "$PROJECT"))" ;;
    esac
    mode="$(config_get "$cfg" worktreeLimit "$WORKTREE_LIMIT_DEFAULT")"
    case "$mode" in
        off) v_ok config-worktree-limit "worktreeLimit is off (the hook never offers /clear-git-resources for worktrees)" ;;
        ""|*[!0-9]*) v_fail config-worktree-limit "worktreeLimit is '$mode' in .claude/orion/config.json; must be a whole number or off" ;;
        *) v_ok config-worktree-limit "worktreeLimit is $mode (worktrees now: $(worktree_count "$PROJECT"))" ;;
    esac
    [ ! -f "$cfg" ] || json_valid "$cfg" || v_fail config-json ".claude/orion/config.json is not valid JSON"

    # 2. CLAUDE.md and the rules it imports
    if [ ! -f "$claude" ]; then
        v_fail claude-md "CLAUDE.md is missing (fix: bash .claude/orion/orion.sh update --force writes the starter)"
    else
        n=$(grep -cxF "$IMPORT_LINE" "$claude" || true)
        case "$n" in
            1) v_ok claude-md-import "CLAUDE.md imports .claude/orion/BASE_CLAUDE.md once" ;;
            0) v_fail claude-md-import "CLAUDE.md does not import the mandatory rules (fix: add this line at the top: $IMPORT_LINE)" ;;
            *) v_fail claude-md-import "CLAUDE.md carries the import line $n times (fix: keep the first, delete the others)" ;;
        esac
        grep -qxF "$OLD_IMPORT_LINE" "$claude" && v_fail claude-md-old-import "CLAUDE.md still imports the retired ORION.md (fix: delete that line; the BASE_CLAUDE.md import replaces it)"
        slots=$(grep -cE '`TBD`|<[a-z][^<>]*>' "$claude" || true)
        [ "$slots" -gt 0 ] 2>/dev/null && v_warn claude-md-slots "CLAUDE.md has $slots line(s) with an unfilled slot (TBD or <placeholder>); the rules that rely on them cannot run until they are filled"
        while IFS= read -r p; do
            [ -n "$p" ] && [ ! -e "$PROJECT/$p" ] && v_warn claude-md-reference "CLAUDE.md refers to $p, which does not exist"
        done <<< "$(grep -oE '\.claude/skills/[A-Za-z0-9_./-]+' "$claude" 2>/dev/null | sed 's/[.]*$//' | sort -u || true)"
    fi
    if [ -f "$base" ]; then
        if git -C "$PROJECT" ls-files --error-unmatch -- .claude/orion/BASE_CLAUDE.md >/dev/null 2>&1 \
           && ! git -C "$PROJECT" diff --quiet HEAD -- .claude/orion/BASE_CLAUDE.md 2>/dev/null; then
            v_warn rules-copy-edited ".claude/orion/BASE_CLAUDE.md differs from the committed copy; orion overwrites it on update, so a rule change belongs in a pull request to orion, not here"
        else
            v_ok rules-copy ".claude/orion/BASE_CLAUDE.md is the shipped copy"
        fi
        # every skill and skill file the rules rely on must be installed
        n=0
        while IFS= read -r ref; do
            [ -n "$ref" ] || continue
            if [ ! -e "$PROJECT/$ref" ]; then
                v_fail rules-reference "the rules rely on $ref, which is not installed (a project skill without the orion marker kept its place, or it was deleted; fix: bash .claude/orion/orion.sh init --force)"
                n=$((n+1))
            fi
        done <<< "$( { grep -oE '\.claude/skills/[A-Za-z0-9_./-]+' "$base" | sed 's/[.]*$//'; grep -oE '`/[a-z][a-z0-9-]*' "$base" | sed 's|^`/|.claude/skills/|'; } 2>/dev/null | sort -u || true)"
        [ "$n" -eq 0 ] && v_ok rules-reference "every skill and skill file BASE_CLAUDE.md relies on is installed"
    fi

    # 3. skills: the orion-managed ones and the project's own
    if [ -d "$skills" ]; then
        shopt -s nullglob
        for entry in "$skills"/*/; do
            name=$(basename "$entry"); ours=0; [ -f "${entry%/}/$MARKER" ] && ours=1
            if [ ! -f "${entry%/}/SKILL.md" ]; then
                if [ "$ours" = "1" ]; then v_fail skill-file "$name (orion-managed) has no SKILL.md (fix: bash .claude/orion/orion.sh update --force)"
                else v_warn skill-file "$name (the project's own) has no SKILL.md, so Claude Code ignores it"; fi
                continue
            fi
            sname=$(skill_name "${entry%/}/SKILL.md")
            if [ -z "$sname" ]; then
                if [ "$ours" = "1" ]; then v_fail skill-name "$name (orion-managed) has no name: in its front matter (fix: bash .claude/orion/orion.sh update --force)"
                else v_warn skill-name "$name (the project's own) has no name: in its front matter"; fi
            elif [ "$sname" != "$name" ]; then
                if [ "$ours" = "1" ]; then v_fail skill-name "$name (orion-managed) declares name: $sname (fix: bash .claude/orion/orion.sh update --force)"
                else v_warn skill-name "$name (the project's own) declares name: $sname; folder and name should match"; fi
            fi
            [ -n "$sname" ] && { case " $names " in *" $sname "*) dups="$dups $sname" ;; esac; names="$names $sname"; }
            [ -d "$HOME/.claude/skills/$name" ] && v_warn skill-shadow "$name also exists at user level (~/.claude/skills/$name); two skills with one name are ambiguous - remove one"
            # a skill may ship its own post-install checks; the /orion-verify skill runs them
            if [ -f "${entry%/}/VERIFY.md" ]; then
                if [ -s "${entry%/}/VERIFY.md" ]; then checks="$checks $name"
                else v_warn skill-checks "$name ships an empty VERIFY.md (fill it or delete it)"; fi
            fi
        done
        shopt -u nullglob
        [ -n "$dups" ] && v_fail skill-duplicate "two skill folders declare the same name:$dups (fix: rename or remove one)"
        [ -z "$dups" ] && v_ok skills "every skill under .claude/skills has a SKILL.md whose name matches its folder"
        if [ -n "$checks" ]; then v_ok skill-checks "skills shipping their own VERIFY.md, run by /orion-verify:$checks"
        else v_ok skill-checks "no skill ships a VERIFY.md of its own"; fi
    else
        v_fail skills ".claude/skills is missing (fix: bash .claude/orion/orion.sh update --force)"
    fi

    # 4. settings: the session-start hook
    if [ ! -f "$settings" ]; then
        v_fail settings-hook ".claude/settings.json is missing, so the update check never runs (fix: bash .claude/orion/orion.sh update --force)"
    elif ! json_valid "$settings"; then
        v_fail settings-json ".claude/settings.json is not valid JSON; Claude Code ignores every setting in it (fix: repair it by hand, then re-run)"
    else
        n=$(hook_count "$settings")
        case "$n" in
            1) v_ok settings-hook ".claude/settings.json has the orion SessionStart hook once" ;;
            0) v_fail settings-hook ".claude/settings.json has no orion SessionStart hook (fix: bash .claude/orion/orion.sh update --force)" ;;
            *) v_warn settings-hook ".claude/settings.json has the orion SessionStart hook $n times (fix: delete the duplicates)" ;;
        esac
    fi

    # 5. git: what orion installed must reach the team
    if git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        ignored="$(ignored_orion_paths)"
        if [ -n "$ignored" ]; then
            # git cannot re-include a file inside an ignored folder, so the fix differs when a whole folder is ignored
            p="$(ignored_whole_folder)"
            [ -n "$p" ] && p="; the folder $p is ignored as a whole, so its line must become ${p%/}/* followed by re-includes (!...) for orion's files"
            v_warn git-ignored "$(printf '%s\n' "$ignored" | grep -c .) file(s) orion installed are ignored by .gitignore, e.g. $(printf '%s\n' "$ignored" | head -n 3 | tr '\n' ' ')- teammates will not get them with a clone$p (fix: un-ignore them, keeping personal files such as .claude/settings.local.json ignored)"
        else v_ok git-tracked "nothing orion installed is ignored by git"; fi
    fi

    # 6. the folders the mandatory rules name: a project keeping one elsewhere leaves the skills looking in the wrong place
    if [ -f "$base" ] && git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        n=0
        while IFS= read -r p; do
            [ -n "$p" ] && [ ! -d "$PROJECT/$p" ] || continue   # a folder not made yet is fine: the skills create it
            f="$(misplaced_folder "$p")"
            [ -n "$f" ] || continue
            v_warn folder-misplaced "the rules expect ${p%/}/, but the project keeps it at $f/ (fix, on the person's yes: mkdir -p \"$(dirname "${p%/}")\" && git mv \"$f\" \"${p%/}\")"
            n=$((n+1))
        done <<< "$(grep -oE '`docs/[A-Za-z0-9_./-]+/`' "$base" | tr -d '`' | sort -u || true)"
        [ "$n" -gt 0 ] || v_ok folders "every folder the rules name is where they expect it, or not made yet"
    fi

    # 7. the changelog folder every pull request adds its own file to
    if [ -d "$PROJECT/docs/changelog" ]; then
        v_ok changelog "docs/changelog/ is where every pull request adds its own file"
    else
        f="create docs/changelog/README.md explaining the format"
        [ -f "$PROJECT/docs/CHANGELOG.md" ] && f="$f; docs/CHANGELOG.md stays as the history, closed for new entries"
        v_warn changelog-missing "docs/changelog/ is missing, and every pull request adds its own one-line file there (fix: $f)"
    fi

    say "verify: $VERIFY_FAIL fail, $VERIFY_WARN warn"
    [ "$VERIFY_FAIL" -eq 0 ]
}

main() {
    local cmd="${1:-help}"; shift || true
    case "$cmd" in
        init) cmd_init "$@" ;;
        update) cmd_update "$@" ;;
        # the hook contract: whatever goes wrong inside, the session start sees exit 0
        check) set +e; ( set -e; cmd_check "$@" ); exit 0 ;;
        verify) cmd_verify "$@" ;;
        status) cmd_status "$@" ;;
        uninstall) cmd_uninstall "$@" ;;
        statusline) cmd_statusline "$@" ;;
        help|-h|--help) usage ;;
        *) die "unknown command: $cmd (try: orion.sh help)" ;;
    esac
}

main "$@"
