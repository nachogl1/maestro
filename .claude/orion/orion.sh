#!/usr/bin/env bash
# orion - a repo-level utility framework for Claude Code projects.
#
# Everything orion ships is copied INTO the project (skills, a rules file, this
# script, the status line baseline, the mods) and committed, so teammates get it
# with a plain git clone/pull. The per-computer pieces are the optional status
# line in ~/.claude/statusline and the optional mods in ~/.claude/orion-mods: a
# newer copy in the project is offered at session start and taken (merged into an
# edited status line; a mod is replaced whole) only on its owner's word.
#
# Usage (run inside the project, or pass --project <dir>):
#   orion.sh init      [--source <git url|path>] [--ref <branch>] [--update-mode ask|auto|off]
#                      [--statusline|--no-statusline] [--mods|--no-mods] [--force] [--yes]
#                      [--dev-branch <name>] [--release-branch <name>]
#                                       # asks for the development and release branches at a terminal (both default
#                                       # to the current default branch) and runs `branches` on a first install;
#                                       # shows what orion's agents do on their own and asks to go on;
#                                       # --yes goes on without asking (needed where there is no terminal)
#   orion.sh update    [--force]        # fetch the latest orion and re-copy the files orion owns
#   orion.sh update    --skip           # decline the newest orion: the hook stays quiet until a newer one
#   orion.sh repair    [--force]        # re-copy the files orion owns from the commit already installed, in every
#                                       # update mode, never changing its version; --force also replaces a project
#                                       # skill without the orion marker in an orion skill's place (on the person's word)
#   orion.sh check     [--force]        # session-start hook: pull the branch, look for a newer orion and for
#                                       # orion files left uncommitted (every session); too many branches or
#                                       # worktrees? (once a day each)
#   orion.sh branches --dev <name> --release <name>
#                                       # declare the development and release branches in config.json, create a
#                                       # missing one on origin and make the development branch GitHub's default
#   orion.sh verify                     # mechanical post-install checks, one line per finding, no fixes
#   orion.sh status                     # what is installed, which version, which update mode
#   orion.sh uninstall [--yes]          # remove everything orion owns, keep everything yours
#   orion.sh statusline merge|skip      # take orion's newer status line (keeping your edits), or decline it
#   orion.sh mod install|skip <name>    # install orion's mod on this computer (or take its newer copy), or decline it
#   orion.sh mod remove <name>          # uninstall the mod and delete this computer's copy
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
#   .claude/orion/mods/<name>.tar     the optional Claude Code mods each computer may install, one archive each
#   .claude/orion/VERSION             commit the files came from (its commit time, and orion's version number)
#   .claude/orion/.orion-manifest     the list above
# What orion creates ONCE and never touches again (yours):
#   CLAUDE.md                         created with the project-specific slots if missing; otherwise
#                                     only the import line for BASE_CLAUDE.md is added at the top
#   .claude/orion/config.json         updateMode: ask | auto | off (chosen during init), source/ref, and
#                                     branchLimit and worktreeLimit (default 20 each, or off): the branch
#                                     or worktree count at which the session-start hook offers
#                                     /clear-git-resources; developBranch and releaseBranch, written
#                                     only by `orion.sh branches`
#   .claude/settings.json             one SessionStart hook entry is added (removed on uninstall)

set -euo pipefail

ORION_DEFAULT_SOURCE="https://github.com/nachogl1/orion.git"
ORION_DEFAULT_REF="main"
MARKER=".orion-managed"
IMPORT_LINE="Mandatory rules, owned and refreshed by orion (never edit the copy): @.claude/orion/BASE_CLAUDE.md"
OLD_IMPORT_LINE="@.claude/orion/ORION.md"   # what orion wrote before the rules moved to BASE_CLAUDE.md
HOOK_NEEDLE="/.claude/orion/orion.sh"
HOOK_CMD='bash "${CLAUDE_PROJECT_DIR}/.claude/orion/orion.sh" check'
# The session-start hook's time budget in seconds: 8 s pull fetch + 8 s update check, with room to spare. It was
# sized when the hook still ran the update itself and is kept, so no install's limit goes down. Installs that
# carry a lower value are raised on update.
HOOK_TIMEOUT=60
CHECK_INTERVAL_SECONDS=86400
# How the agent ships orion's files: never in the folder the session opens in, always through a pull request of
# their own. The steps live in the orion skill; check's messages point there.
SHIP_STEPS="Ship it through its own pull request, following the 'Ship an update' steps of the /orion skill (.claude/skills/orion/SKILL.md) exactly as written: a worktree at the project's worktree root on feat/orion-update-v<new> from the default branch, 'bash .claude/orion/orion.sh update' there and never in this folder, the project's changelog file and gate, a pull request titled 'chore(orion): update orion from <old> to <new>' merged on green under the project's merge bar ('no checks reported' counts as red), then 'git pull --ff-only' in this folder. A run that cannot finish reports, stops and leaves its worktree for /clear-git-resources."
# The time this orion.sh pins in global-offered once the personal rules were offered (2100-01-01 UTC): an older
# orion.sh offers when that time is a day old, so a time in the future keeps it quiet for good.
GLOBAL_OFFER_PIN=4102444800
# The last orion version whose orion.sh offered the personal rules once a day: such a script carries no clause above it.
LAST_DAILY_OFFER_VERSION=17
BRANCH_LIMIT_DEFAULT=20
WORKTREE_LIMIT_DEFAULT=20
# The branches the starter CLAUDE.md names (the release branch in its deploy line): init sets them from the declared names.
STARTER_DEVELOP="main" STARTER_RELEASE="main"

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
warn() { printf 'orion: %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

usage() { sed -n '2,/^$/p' "$0" 2>/dev/null || true; exit 0; }  # the comment block at the top

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

# The update mode, read in this one place: check, the personal rules offer, verify and status all use it. One pass
# over config.json, no subshell, sets UPDATE_MODE to ask, auto or off, ignoring letter case and spaces around the
# value; a missing config.json or a missing key is ask. A value orion does not understand (false, never, an empty
# string), or a config.json it cannot read as plain text (one saved as UTF-16 holds NUL bytes), is off, and
# UPDATE_MODE_PROBLEM then says why in one sentence. UPDATE_MODE_RAW is the value as written (a string's text, or a
# bare value such as false); UPDATE_MODE_UNREADABLE is 1 for a file that is not plain text.
UPDATE_MODE="" UPDATE_MODE_RAW="" UPDATE_MODE_PROBLEM="" UPDATE_MODE_UNREADABLE=0
read_update_mode() {  # file
    local v
    UPDATE_MODE=ask UPDATE_MODE_RAW="" UPDATE_MODE_PROBLEM="" UPDATE_MODE_UNREADABLE=0
    [ -f "$1" ] || return 0
    if [ "$(LC_ALL=C tr -d '\000' < "$1" | wc -c)" != "$(wc -c < "$1")" ]; then
        UPDATE_MODE=off UPDATE_MODE_UNREADABLE=1
        UPDATE_MODE_PROBLEM="orion cannot read .claude/orion/config.json as plain text (it looks saved as UTF-16, as Windows PowerShell 5.1 writes it), so it treats updateMode as off and offers or runs no update until the file is saved again as UTF-8 with updateMode set to ask, auto or off: tell the user so in one line."
        return 0
    fi
    # "=" marks the key as found, so an empty value is told apart from a missing key
    v="$(sed -n 's/.*"updateMode"[[:space:]]*:[[:space:]]*/=/p' "$1" | head -n1)"
    [ -n "$v" ] || return 0
    v="${v#=}"; v="${v%$'\r'}"
    case "$v" in
        \"*) v="${v#\"}"; v="${v%%\"*}" ;;
        *) v="${v%%[,\}]*}" ;;
    esac
    UPDATE_MODE_RAW="$v"
    v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
    case "$v" in
        [Aa][Ss][Kk]) UPDATE_MODE=ask ;;
        [Aa][Uu][Tt][Oo]) UPDATE_MODE=auto ;;
        [Oo][Ff][Ff]) UPDATE_MODE=off ;;
        *) UPDATE_MODE=off
           UPDATE_MODE_PROBLEM="orion does not understand updateMode '$(json_escape "$(printf '%s' "$UPDATE_MODE_RAW" | LC_ALL=C tr -d '\000-\037')")' in .claude/orion/config.json, so it treats it as off and offers or runs no update until it is set to ask, auto or off: tell the user so in one line." ;;
    esac
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

# Set one `"key": "string"` of config.json, adding the key before the closing brace when the file lacks it
# (config_set only rewrites a key already there); 1 when the file has no closing brace line to add it before.
config_put() {  # file key value
    local tmp
    config_set "$1" "$2" "$3" && return 0
    [ -f "$1" ] || return 1
    tmp=$(mktemp)
    if KEY="$2" VAL="$(json_escape "$3")" awk '
        { line[NR] = $0 }
        /^[[:space:]]*}[[:space:]]*$/ { close_at = NR }
        END {
            if (!close_at) exit 1
            for (i = close_at - 1; i > 0 && line[i] ~ /^[[:space:]]*$/; i--) ;
            if (i > 0 && line[i] !~ /[{,][[:space:]]*$/) { sub(/[[:space:]]*$/, "", line[i]); line[i] = line[i] "," }
            for (j = 1; j < close_at; j++) print line[j]
            printf "  \"%s\": \"%s\"\n", ENVIRON["KEY"], ENVIRON["VAL"]
            for (j = close_at; j <= NR; j++) print line[j]
        }' "$1" > "$tmp"; then mv "$tmp" "$1"; else rm -f "$tmp"; return 1; fi
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

whole_number() { case "$1" in ""|*[!0-9]*) ;; *) printf '%s' "$1" ;; esac; }

# orion's version: major.minor.patch (2.0.0 on), held in the release tags v<version> and on line 5 of a project's
# VERSION. A whole number from before three-part versions (16, v2) still reads as a version: older than any
# three-part one, and two of them compare as numbers. A personal rule's note may end in "+" ("changed after"): newer
# than its version, older than any later one. Sets VKEY to "<kind> <major> <minor> <patch> <plus>", kind 0 for no
# version, 1 for a whole number, 2 for three parts; no subshell, as the hook compares many.
version_key() {  # version
    local v="${1#v}" plus=0 rest
    case "$v" in *+) plus=1; v="${v%+}" ;; esac
    case "$v" in
        ""|*[!0-9.]*|.*|*.|*..*|*.*.*.*) VKEY=(0 0 0 0 0) ;;
        *.*.*) rest="${v#*.}"; VKEY=(2 $((10#${v%%.*})) $((10#${rest%.*})) $((10#${rest#*.})) "$plus") ;;
        *.*) VKEY=(0 0 0 0 0) ;;
        *) VKEY=(1 $((10#$v)) 0 0 "$plus") ;;
    esac
}
version_gt() {  # a b -> 0 when version a is newer than version b (any version is newer than no version)
    local a i
    version_key "$1"; a=("${VKEY[@]}"); version_key "$2"
    for i in 0 1 2 3 4; do
        [ "${a[i]}" -gt "${VKEY[i]}" ] && return 0
        [ "${a[i]}" -lt "${VKEY[i]}" ] && return 1
    done
    return 1
}
# The version a release or an install carries (no "+"), without a leading v; nothing when it is none.
version_of() { version_key "$1"; [ "${VKEY[0]}" = 0 ] || [ "${VKEY[4]}" = 1 ] || printf '%s' "${1#v}"; }
# A personal rule's version (a "+" allowed); nothing when it is none.
rule_version_of() { version_key "$1"; [ "${VKEY[0]}" = 0 ] || printf '%s' "${1#v}"; }
version_number() { version_of "$(sed -n '5p' "$1" 2>/dev/null | tr -d '\r')"; }
# The highest release among "<sha> refs/tags/v<version>" lines on stdin (the shape ls-remote and for-each-ref print).
highest_release() {
    local sha ref v top=""
    while read -r sha ref; do
        case "$ref" in refs/tags/v*) v="${ref#refs/tags/}" ;; *) continue ;; esac
        version_key "$v"; [ "${VKEY[0]}" != 0 ] && [ "${VKEY[4]}" = 0 ] || continue
        if [ -z "$top" ] || version_gt "$v" "$top"; then top="$v"; fi
    done
    printf '%s' "${top#v}"
}
version_label() {  # sha number -> "orion <number>", or the short sha when there is no number
    if [ -n "$2" ]; then printf 'orion %s' "$2"; else short "$1"; fi
}

short() { printf '%s' "${1:0:7}"; }

# Per-computer, per-repository state that must never be committed (the orion version the person declined with
# `update --skip`, the one-shot "post-install check pending" marker, the rules fingerprint last checked, the last
# branch count). Keyed on the repository's shared git folder, so every worktree of one clone shares it; a folder
# that is not the top of a git checkout keeps its path as the key. A record an older orion keyed on the main
# checkout's path is carried over on first use.
CACHE_KEY="" CACHE_KEY_OF="" LEGACY_KEY=""
cache_key_set() {  # sets CACHE_KEY and LEGACY_KEY for $PROJECT; call it outside $(...) once, so later calls reuse it
    [ "$CACHE_KEY_OF" = "$PROJECT" ] && return 0
    local out common="" main
    # git prints the prefix (an empty line at the top of a checkout), then the shared git folder: ".git" in the main
    # checkout, the physical path from a worktree, so the folder is resolved physically (pwd -P) in both
    out="$(cd "$PROJECT" 2>/dev/null && git rev-parse --show-prefix --git-common-dir 2>/dev/null)" || out=""
    case "$out" in
        ($'\n'?*) out="${out#$'\n'}"; common="$(cd "$PROJECT" 2>/dev/null && cd "$out" 2>/dev/null && pwd -P)" || common="" ;;
    esac
    CACHE_KEY_OF="$PROJECT" LEGACY_KEY=""
    if [ -n "$common" ]; then
        CACHE_KEY="$(printf '%s' "$common" | cksum | cut -d' ' -f1)"
        # an older orion keyed the main checkout on the path it was opened by: that path in the main checkout itself
        main="${common%/.git}"; [ "$out" = .git ] && main="$PROJECT"
        case "$common" in */.git) LEGACY_KEY="$(printf '%s' "$main" | cksum | cut -d' ' -f1)" ;; esac
    else
        CACHE_KEY="$(printf '%s' "$PROJECT" | cksum | cut -d' ' -f1)"
    fi
}
cache_file() {  # suffix
    local dir="${XDG_CACHE_HOME:-$HOME/.cache}/orion"
    cache_key_set
    # copied, so an older orion.sh still running in the main checkout keeps its own; the one-shot marker moves
    if [ -n "$LEGACY_KEY" ] && [ ! -e "$dir/$CACHE_KEY.$1" ] && [ -e "$dir/$LEGACY_KEY.$1" ]; then
        case "$1" in
            verify-pending) mv "$dir/$LEGACY_KEY.$1" "$dir/$CACHE_KEY.$1" ;;
            *) cp "$dir/$LEGACY_KEY.$1" "$dir/$CACHE_KEY.$1" ;;
        esac 2>/dev/null || true
    fi
    printf '%s' "$dir/$CACHE_KEY.$1"
}

# A fingerprint of the rules orion ships into this project: BASE_CLAUDE.md and every .md file of every
# orion-managed skill, without carriage returns as in tree_sum, so line endings never count as a change ("raw": with
# them, the fingerprint an older orion stored). The session-start hook asks for /orion-verify once each time it
# changes on this computer. One find and one cat for all of it: a process per file costs seconds under Git Bash.
rules_sum() {  # [raw]
    local entry f dirs=() files=()
    if [ -f "$PROJECT/.claude/orion/BASE_CLAUDE.md" ]; then files+=("$PROJECT/.claude/orion/BASE_CLAUDE.md"); fi
    for entry in "$PROJECT"/.claude/skills/*/; do
        [ -f "${entry%/}/$MARKER" ] || continue
        dirs+=("${entry%/}")
    done
    if [ ${#dirs[@]} -gt 0 ]; then
        while IFS= read -r f; do files+=("$f"); done < <(find "${dirs[@]}" -type f -name '*.md' | LC_ALL=C sort)
    fi
    if [ ${#files[@]} -gt 0 ]; then cat "${files[@]}" 2>/dev/null || true; fi \
        | if [ "${1:-}" = raw ]; then cat; else tr -d '\r'; fi | cksum | cut -d' ' -f1
}

# The rules-checked record holds every fingerprint this computer has checked for the repository, one per line, newest
# last, the last RULES_KEPT kept: a main checkout and a worktree on different orion rules both stay checked. A record
# an older orion wrote holds one fingerprint and reads the same way.
RULES_KEPT=20
rules_checked() {  # sum: 0 when this computer has checked these rules for the repository
    grep -qxF -- "$1" "$(cache_file rules-checked)" 2>/dev/null
}
rules_mark() {  # [sum]: adds these rules to the ones this computer has checked
    local f sum; f="$(cache_file rules-checked)"; sum="${1:-$(rules_sum)}"
    mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
    # stderr goes for the whole write: a cache folder that cannot be written is no error for the hook, and neither
    # is the "Broken pipe" a hook runner that ignores SIGPIPE gets when tail cannot open its file
    { { { grep -vxF -- "$sum" "$f" || true; printf '%s\n' "$sum"; } | tail -n "$RULES_KEPT" > "$f.new" \
        && mv "$f.new" "$f"; } 2>/dev/null; } || true
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

# SRC_VERSION is the source's version: in a checkout, the highest release tag its commit contains; fetched from the
# default branch, the highest release tag of the source, read before the clone, so a release tagged in between is
# never claimed for older files; fetched from another ref, the release tag on the commit it fetched (release tags
# mark the default branch only). Empty when there is none.
fetch_source() {  # source ref
    local here
    here="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" 2>/dev/null && pwd || true )"
    if [ -n "$here" ] && [ -d "$here/skills" ] && [ -d "$here/baselines" ] && [ -f "$here/orion.sh" ]; then
        SRC_DIR="$here"
        SRC_SHA="$(git -C "$here" rev-parse HEAD 2>/dev/null || printf 'local')"
        SRC_TIME="$(git -C "$here" log -1 --format=%ct 2>/dev/null || printf '0')"
        SRC_VERSION="$(git -C "$here" for-each-ref --merged HEAD --format='%(objectname) %(refname)' 'refs/tags/v*' 2>/dev/null | highest_release || true)"
        return
    fi
    have git || die "git is required to fetch orion"
    TMP_DIR="$(mktemp -d)"
    say "fetching orion ($2) from $1 ..."
    latest_remote "$1" "$2"
    git clone --quiet --depth 1 --branch "$2" "$1" "$TMP_DIR/orion" 2>/dev/null \
        || die "could not fetch orion from $1 (ref $2)"
    SRC_DIR="$TMP_DIR/orion"
    SRC_SHA="$(git -C "$SRC_DIR" rev-parse HEAD)"
    SRC_TIME="$(git -C "$SRC_DIR" log -1 --format=%ct 2>/dev/null || printf '0')"
    if [ "$2" = "$ORION_DEFAULT_REF" ]; then
        SRC_VERSION="$LATEST_NUM"
    else
        SRC_VERSION="$(release_on "$SRC_SHA")"
    fi
}

# The highest release tag on one commit, from the lines latest_remote kept; nothing when no release tag marks it.
release_on() {  # sha
    # an annotated tag's commit comes as its peeled line, <tag>^{}
    printf '%s\n' "$LATEST_REFS" | awk -v s="$1" '$1 == s { sub(/\^\{\}$/, "", $2); print $1, $2 }' | highest_release
}

# The release number of an installed commit as the source names it (latest_remote first): the highest release tag on
# that commit, else, when it is the newest commit of the default branch, the source's highest release, the number an
# update from there records. Nothing when the source names none.
installed_release() {  # sha ref
    local v
    v="$(release_on "$1")"
    if [ -z "$v" ] && [ "$1" = "$LATEST_SHA" ] && [ "$2" = "$ORION_DEFAULT_REF" ]; then v="$LATEST_NUM"; fi
    printf '%s' "$v"
}

# Write orion's version number on line 5 of a VERSION file, keeping lines 1 to 4 as they are.
version_line_set() {  # file number
    awk -v v="$2" 'NR < 5 { print } END { for (i = NR + 1; i < 5; i++) print ""; print v }' "$1" > "$1.new" && mv -f "$1.new" "$1"
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

# One call for both: LATEST_SHA, the ref's commit, and LATEST_NUM, the highest release tag (v<major.minor.patch>,
# pushed by the release workflow after each release; the old v<N> tags count as older). Either is empty when the
# source has none. LATEST_REFS keeps every line the call printed.
latest_remote() {  # source ref
    local out=""
    out=$(limited 8 git ls-remote "$1" "refs/heads/$2" 'refs/tags/v*' 2>/dev/null || true)
    LATEST_SHA="$(printf '%s\n' "$out" | awk -v r="refs/heads/$2" '$2 == r { print $1; exit }')"
    LATEST_NUM="$(printf '%s\n' "$out" | highest_release)"
    LATEST_REFS="$out"
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

# One key binding in Claude Code's keybindings file ({"bindings": [{"context": ..., "bindings": {key: action}}]}),
# keys compared without case. bind adds key -> action to the first Global block (a new one when there is none)
# only when no block binds that key yet; unbind deletes key -> action wherever it sits and drops a block it left
# empty. The file is rewritten only when something changes. Prints the outcome: bind -> added | present |
# taken<TAB><the action already there>; unbind -> removed | removed-empty (nothing is left but orion's empty
# starter) | none; either -> bad when the file is not a keybindings file: not an object, a top-level "bindings"
# that is neither a list nor null (or missing), or, for bind, a first Global block whose "bindings" is neither an
# object nor null (or missing). The three editors give the same answer for every shape. Native Windows tools end
# it with \r.
keys_edit() { keys_edit_raw "$@" | tr -d '\r'; }
keys_edit_raw() {  # bind|unbind file key action
    local op="$1" f="$2" k="$3" a="$4" tool
    tool=$(json_tool)
    case "$tool" in
        jq)
            local tmp sel state
            jq -e 'type == "object" and ((.bindings | type) as $t | $t == "array" or $t == "null")' "$f" >/dev/null 2>&1 || { echo bad; return; }
            sel='.bindings[]? | objects | (.bindings // {}) | objects | to_entries[] | select((.key | ascii_downcase) == $k)'
            tmp=$(mktemp)
            if [ "$op" = bind ]; then
                state=$(jq -r --arg k "$k" --arg a "$a" "[$sel | .value] as \$v | if (\$v | index(\$a)) != null then \"present\" elif (\$v | length) > 0 then \"taken\t\" + (\$v[0] | if type == \"string\" then . else tojson end) elif ([.bindings[]? | objects | select(.context == \"Global\")][0].bindings | type) as \$t | \$t == \"object\" or \$t == \"null\" then \"free\" else \"bad\" end" "$f" 2>/dev/null | tr -d '\r')
                [ "$state" = free ] || { rm -f "$tmp"; echo "$state"; return; }
                jq --arg k "$k" --arg a "$a" '((.bindings // []) | map(type == "object" and .context == "Global") | index(true)) as $i
                    | if $i == null then .bindings = ((.bindings // []) + [{context: "Global", bindings: {($k): $a}}])
                      else .bindings[$i].bindings = ((.bindings[$i].bindings // {}) + {($k): $a}) end' "$f" > "$tmp" && mv "$tmp" "$f" && echo added
            else
                state=$(jq -r --arg k "$k" --arg a "$a" "[$sel | select(.value == \$a)] | length" "$f" 2>/dev/null | tr -d '\r')
                [ "$state" != 0 ] || { rm -f "$tmp"; echo none; return; }
                jq --arg k "$k" --arg a "$a" '.bindings |= map(
                        if type == "object" and ((.bindings | type) == "object") and (.bindings | to_entries | any((.key | ascii_downcase) == $k and .value == $a))
                        then (.bindings |= with_entries(select(((.key | ascii_downcase) == $k and .value == $a) | not))) | select((.bindings | length) > 0)
                        else . end)' "$f" > "$tmp" && mv "$tmp" "$f" || return
                jq -r 'if ((keys - ["$schema", "$docs", "bindings"]) | length) == 0 and ((.bindings // []) | length) == 0 then "removed-empty" else "removed" end' "$f"
            fi ;;
        python3|python)
            "$tool" - "$op" "$f" "$k" "$a" 2>/dev/null <<'PY'
import json, sys
op, f, k, a = sys.argv[1:5]
try:
    d = json.load(open(f, encoding="utf-8-sig"))
except Exception:
    d = None
if not isinstance(d, dict) or not isinstance([] if d.get("bindings") is None else d["bindings"], list):
    print("bad"); sys.exit()
if d.get("bindings") is None: d["bindings"] = []
blocks = d["bindings"]
owned = [b for b in blocks if isinstance(b, dict) and isinstance(b.get("bindings"), dict)]
def save():
    open(f, "w", encoding="utf-8").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
if op == "bind":
    vals = [v for b in owned for key, v in b["bindings"].items() if key.lower() == k]
    if a in vals: print("present")
    elif vals: print("taken\t" + (vals[0] if isinstance(vals[0], str) else json.dumps(vals[0])))
    else:
        g = next((b for b in blocks if isinstance(b, dict) and b.get("context") == "Global"), None)
        if g is None: blocks.append({"context": "Global", "bindings": {k: a}})
        elif g.get("bindings") is None: g["bindings"] = {k: a}
        elif isinstance(g["bindings"], dict): g["bindings"][k] = a
        else: print("bad"); sys.exit()
        save(); print("added")
else:
    hit = [b for b in owned if any(key.lower() == k and v == a for key, v in b["bindings"].items())]
    if not hit: print("none"); sys.exit()
    for b in hit:
        b["bindings"] = {key: v for key, v in b["bindings"].items() if not (key.lower() == k and v == a)}
    d["bindings"] = [b for b in blocks if not (any(b is h for h in hit) and not b["bindings"])]
    save()
    print("removed-empty" if not d["bindings"] and not set(d) - {"$schema", "$docs", "bindings"} else "removed")
PY
            ;;
        powershell)
            powershell.exe -NoProfile -NonInteractive -Command "
                \$f = '$(cygpath -w "$f" 2>/dev/null || printf '%s' "$f")'; \$k = '$k'; \$a = '$a'
                try { \$d = Get-Content -Raw -Encoding UTF8 \$f | ConvertFrom-Json } catch { 'bad'; exit }
                if (-not (\$d -is [Management.Automation.PSCustomObject])) { 'bad'; exit }
                \$has = [bool]\$d.PSObject.Properties['bindings']
                if (\$has -and \$null -ne \$d.bindings -and -not (\$d.bindings -is [array])) { 'bad'; exit }
                \$blocks = @(); if (\$has -and \$null -ne \$d.bindings) { \$blocks = @(\$d.bindings) }
                function Get-Own(\$b) { (\$b -is [Management.Automation.PSCustomObject]) -and (\$b.bindings -is [Management.Automation.PSCustomObject]) }
                function Save-Keys { [IO.File]::WriteAllText(\$f, (\$d | ConvertTo-Json -Depth 10) + [Environment]::NewLine) }
                if ('$op' -eq 'bind') {
                    \$vals = @(); foreach (\$b in \$blocks) { if (Get-Own \$b) { foreach (\$p in @(\$b.bindings.PSObject.Properties)) { if (\$p.Name -eq \$k) { \$vals += ,\$p.Value } } } }
                    if (\$vals -ccontains \$a) { 'present'; exit }
                    if (\$vals.Count -gt 0) { if (\$null -eq \$vals[0]) { \"taken\`tnull\" } else { \"taken\`t\" + \$vals[0] }; exit }
                    \$g = \$null; foreach (\$b in \$blocks) { if ((\$b -is [Management.Automation.PSCustomObject]) -and \$b.context -ceq 'Global') { \$g = \$b; break } }
                    if (\$null -eq \$g) {
                        \$entry = [PSCustomObject]@{ context = 'Global'; bindings = [PSCustomObject]@{ \$k = \$a } }
                        if (\$has) { \$d.bindings = @(\$blocks) + @(\$entry) } else { \$d | Add-Member -NotePropertyName bindings -NotePropertyValue @(\$entry) }
                    } else {
                        if (\$null -eq \$g.bindings) { \$g | Add-Member -Force -NotePropertyName bindings -NotePropertyValue (New-Object PSObject) }
                        elseif (-not (\$g.bindings -is [Management.Automation.PSCustomObject])) { 'bad'; exit }
                        \$g.bindings | Add-Member -NotePropertyName \$k -NotePropertyValue \$a
                    }
                    Save-Keys; 'added'
                } else {
                    \$n = 0; \$keep = @()
                    foreach (\$b in \$blocks) {
                        \$hit = \$false
                        if (Get-Own \$b) { foreach (\$p in @(\$b.bindings.PSObject.Properties)) { if (\$p.Name -eq \$k -and \$p.Value -is [string] -and \$p.Value -ceq \$a) { \$b.bindings.PSObject.Properties.Remove(\$p.Name); \$hit = \$true; \$n++ } } }
                        if (\$hit -and @(\$b.bindings.PSObject.Properties).Count -eq 0) { continue }
                        \$keep += ,\$b
                    }
                    if (\$n -eq 0) { 'none'; exit }
                    \$d.bindings = \$keep
                    Save-Keys
                    \$others = @(\$d.PSObject.Properties | Where-Object { @('\$schema', '\$docs', 'bindings') -notcontains \$_.Name })
                    if (\$keep.Count -eq 0 -and \$others.Count -eq 0) { 'removed-empty' } else { 'removed' }
                }
            " 2>/dev/null ;;
        *) echo none-tool ;;
    esac
}

# --------------------------------------------------------------------------
# apply: copy everything orion owns from SRC_DIR into the project
# --------------------------------------------------------------------------
copy_managed() {  # src dst
    rm -rf "$2"
    mkdir -p "$2"
    # marker first: an interrupted copy still looks orion-managed and gets redone next time
    printf 'orion\n' > "$2/$MARKER"
    cp -R "$1"/. "$2"
    # a local checkout that ran Python carries compiled caches; they are not part of the skill
    find "$2" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
}

apply_skills() {  # mode(init|update|repair) force(0|1)
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
    # and orion's mods, which a computer installs only on the person's word
    apply_mods
    # line 4, the source's commit time, is for information only; line 5, orion's version number, tells the
    # update check whether a release is newer, and the computer's status line whether this project's copy is
    printf '%s\n%s\n%s\n%s\n%s\n' "$SRC_SHA" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SRC_TIME:-0}" "$SRC_VERSION" > "$dir/VERSION"
    { printf '%s\n' "orion.sh" "BASE_CLAUDE.md" "VERSION" ".orion-manifest"
      ( cd "$SRC_DIR/baselines" && find statusline global -type f | LC_ALL=C sort )
      mod_dirs "$SRC_DIR/mods" | sed 's|.*|mods/&.tar|'; } > "$dir/.orion-manifest"
    if [ ! -f "$dir/config.json" ]; then
        printf '{\n  "updateMode": "%s",\n  "source": "%s",\n  "ref": "%s",\n  "branchLimit": %s,\n  "worktreeLimit": %s\n}\n' \
            "$(json_escape "$mode")" "$(json_escape "$1")" "$(json_escape "$2")" "$BRANCH_LIMIT_DEFAULT" "$WORKTREE_LIMIT_DEFAULT" > "$dir/config.json"
        say "  +    .claude/orion/config.json (yours: updateMode $mode, edit to ask | auto | off; branchLimit $BRANCH_LIMIT_DEFAULT and worktreeLimit $WORKTREE_LIMIT_DEFAULT, a number or off)"
    fi
    say "  ~    .claude/orion/{orion.sh, BASE_CLAUDE.md, VERSION, statusline/, global/, mods/} @ $(version_label "$SRC_SHA" "$SRC_VERSION") ($(short "$SRC_SHA"))"
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

- Development branch (daily work starts from it and merges into it): \`$STARTER_DEVELOP\`.
- Deploys to: <environment>, from the release branch \`$STARTER_RELEASE\`.
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

# The starter's own <placeholder> slots, one per line, for verify to look for. A <...> the project wrote itself (a
# test filter's <test-name>) is a real command, never a slot. <angle-bracket> only names the slots in the starter's
# intro, and the bare <N> is looked for with its label, as a branch pattern's <N> is no slot.
starter_slots() {
    local tmp; tmp=$(mktemp)
    write_claude_md_starter "$tmp"
    grep -oE '<[^<>]+>' "$tmp" | grep -vxF -e '<angle-bracket>' | sed 's/^<N>$/baseline: <N>/' | sort -u
    rm -f "$tmp"
}

# The commands-table rows the mandatory rules rely on, one key word each, in lower case. A row of the project's table
# whose label holds the word counts as that row, so a reworded label still does. A note in brackets is left out of a
# label first, so a note that names another row ("(run before the full suite)") never reads as that row. The starter's
# rows marked "(if ...)" are optional and have no key word. The suite checks every key word is in exactly one starter
# row and every other starter row has one.
COMMAND_ROW_KEYS=(build suite file "one test" type lint)
# A commands-table row an older starter wrote and nothing reads any more ("Test copies": how the full suite took a
# number of parallel workers). Still reading TBD, it is no unfilled slot: verify never asks for it.
RETIRED_ROW_RE='^[[:space:]]*\|[[:space:]]*\**[Tt]est copies'

# One line per row of the commands table in a CLAUDE.md: the label in lower case without bold marks or notes in
# brackets, a tab, then the label as written without bold marks. The table is the one under the first heading that
# names commands (up to the next heading of its level or higher), or every table in the file when no heading does.
# A header row (the row right above a |---| separator) and lines inside a code block are skipped.
command_row_labels() {  # file
    awk '
        /^[ \t]*(```|~~~)/ { fence = !fence; next }
        fence { next }
        /^#+[ \t]/ {
            lvl = match($0, /[^#]/) - 1
            if (in_sec && lvl <= sec_lvl) { in_sec = 0; done = 1 }
            if (!done && !in_sec && tolower($0) ~ /command/) { in_sec = 1; found = 1; sec_lvl = lvl }
            next
        }
        /^[ \t]*\|/ {
            split($0, cell, "|"); raw = cell[2]
            gsub(/\*/, "", raw); gsub(/^[ \t]+|[ \t]+$/, "", raw)
            # a separator row: the row right above it was the header, not a command row
            if (raw ~ /^[-: ]+$/) { if (last_nr == NR - 1) { na--; if (last_in_sec) ns-- }; next }
            if (raw == "") next
            key = tolower(raw); gsub(/\([^)]*\)/, "", key); gsub(/[ \t]+/, " ", key)
            all[++na] = key "\t" raw
            if (in_sec) sec[++ns] = key "\t" raw
            last_nr = NR; last_in_sec = in_sec
        }
        END { if (found) for (i = 1; i <= ns; i++) print sec[i]; else for (i = 1; i <= na; i++) print all[i] }
    ' "$1"
}

# One WARN per commands-table row the rules rely on that the project's CLAUDE.md lacks, naming the starter's row.
verify_command_rows() {  # CLAUDE.md
    local tmp starter labels key row missing=0
    tmp=$(mktemp); write_claude_md_starter "$tmp"; starter="$(command_row_labels "$tmp")"; rm -f "$tmp"
    labels="$(command_row_labels "$1")"
    for key in "${COMMAND_ROW_KEYS[@]}"; do
        awk -F'\t' -v k="$key" 'index($1, k) { hit = 1 } END { exit !hit }' <<< "$labels" && continue
        row="$(awk -F'\t' -v k="$key" '!row && index($1, k) { row = $2 } END { print row }' <<< "$starter")"
        v_warn claude-md-row "CLAUDE.md's commands table has no row for \"$row\" (no row label holds the word '$key'); /orion-verify works out the command from the project's files and proposes the row"
        missing=$((missing+1))
    done
    [ "$missing" -gt 0 ] || v_ok claude-md-rows "CLAUDE.md's commands table has every row the rules rely on"
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

sl_number() { local v; v="$(version_of "$1")"; printf '%s' "${v:-0}"; }
# A commit time on line 1 counts as version 0, so newer status lines are offered again. The bound is not this
# project's own version number: a real, newer one stamped by another project on this computer must still win.
sl_stamp() {
    local n; n="$(sl_number "$(sed -n '1p' "$(sl_home)/$SL_STAMP" 2>/dev/null | tr -d '\r')")"
    case "$n" in *.*) ;; *) [ "$n" -lt "$SL_OLD_STAMP_MIN" ] || n=0 ;; esac
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
    version_gt "$t" "$(sl_stamp)" || return 0
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
        sl_seed "$src" "$(sl_number "$SRC_VERSION")"
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
# mods (optional, per computer). Every project carries orion's copy of each mod as one archive,
# .claude/orion/mods/<name>.tar, so no tool of the project's own (a test runner, a linter, TypeScript) ever collects
# the mod's sources. A computer gets its own copy, unpacked, only on the person's word, in a folder Claude Code
# installs it from at user scope (never through the project's settings). A newer copy replaces the computer's whole,
# with no merge.
#   ~/.claude/orion-mods/<name>/                          the computer's copy of the mod
#   ~/.claude/orion-mods/<name>.orion-baseline            orion version number and checksum of the newest copy taken or skipped
#   ~/.claude/orion-mods/.claude-plugin/marketplace.json  lists every copy, so the folder is a local marketplace
# --------------------------------------------------------------------------
MOD_MARKET="orion-mods"
mod_home() { printf '%s' "$HOME/.claude/$MOD_MARKET"; }
mod_stamp() { printf '%s' "$(mod_home)/$1$SL_STAMP"; }
mod_src() { printf '%s' "$PROJECT/.claude/orion/mods/$1.tar"; }
mod_name_ok() { case "$1" in ""|-*|*[!a-z0-9-]*) return 1 ;; esac; }
# The mod folders in a folder, one name per line: orion's source (mods/) or this computer's copies (mod_copies).
mod_dirs() { local d; for d in "$1"/*/; do [ -d "$d" ] && basename "$d"; done; return 0; }
mod_copies() { mod_dirs "$(mod_home)"; }
# The mods this project carries, one name per line.
mod_names() { local f; for f in "$PROJECT"/.claude/orion/mods/*.tar; do [ -f "$f" ] && basename "$f" .tar; done; return 0; }
mod_unpack() { mkdir -p "$2" && tar -xf "$1" -C "$2"; }  # archive dest
# The checksum of the files an archive holds (line endings aside), never of the archive's own bytes, which carry
# the time each file was packed.
mod_sum() {  # archive
    local t s=""; t="$(mktemp -d)"
    if mod_unpack "$1" "$t" 2>/dev/null; then s="$(tree_sum "$t" | cksum)"; fi
    rm -rf "$t"; printf '%s' "$s"
}

# Pack every mod orion ships into the project, one archive each. An archive is rewritten only when its files
# changed, so an update that leaves a mod alone leaves its archive byte for byte as it was; anything else in the
# folder (a mod orion no longer ships) goes.
apply_mods() {
    local dir="$PROJECT/.claude/orion/mods" src="$SRC_DIR/mods" f name
    [ -d "$src" ] || { rm -rf "$dir"; return 0; }
    mkdir -p "$dir"
    for f in "$dir"/* "$dir"/.[!.]*; do
        [ -e "$f" ] || continue
        name="$(basename "$f" .tar)"
        { [ "$f" = "$dir/$name.tar" ] && [ -d "$src/$name" ]; } || rm -rf "$f"
    done
    for name in $(mod_dirs "$src"); do
        f="$dir/.$name.tar.new"
        # macOS tar would add AppleDouble ._* entries for files with extended attributes; elsewhere a no-op
        ( cd "$src/$name" && COPYFILE_DISABLE=1 tar -cf - . ) > "$f"
        if [ -f "$dir/$name.tar" ] && [ "$(mod_sum "$f")" = "$(mod_sum "$dir/$name.tar")" ]; then rm -f "$f"; else mv -f "$f" "$dir/$name.tar"; fi
    done
}
# The orion version number of the newest copy this computer took or skipped.
mod_taken() { sl_number "$(sed -n '1p' "$(mod_stamp "$1")" 2>/dev/null | tr -d '\r')"; }

# Record the newest copy of a mod this computer has seen (installed or skipped): its orion version number, then its checksum.
mod_mark() {  # name stamp
    printf '%s\n%s\n' "$2" "$(mod_sum "$(mod_src "$1")")" > "$(mod_stamp "$1")"
}

# Prints "offer" when this project's copy of a mod this computer installed comes from a higher orion version and
# differs from the copy last taken or skipped; a copy that did not change only moves the record forward.
mod_sync() {  # name
    local t
    { [ -f "$(mod_stamp "$1")" ] && [ -f "$(mod_src "$1")" ]; } || return 0
    t="$(project_stamp)"
    version_gt "$t" "$(mod_taken "$1")" || return 0
    if [ "$(mod_sum "$(mod_src "$1")")" = "$(sed -n '2p' "$(mod_stamp "$1")" | tr -d '\r')" ]; then
        mod_mark "$1" "$t"
    else
        printf 'offer'
    fi
}

# The shortcut a mod's README names, which installing the mod binds in the person's own keybindings file:
# key, action and how a person reads the key, tab-separated; nothing for a mod with none.
mod_shortcut() {  # name
    case "$1" in
        control-tower) printf 'ctrl+x p\tcommand:control-tower\tCtrl+X then P' ;;
    esac
}
mod_keys_file() { printf '%s' "$HOME/.claude/keybindings.json"; }
# A key already bound to something else stays as it is, and the person is told how to bind the mod by hand.
mod_bind_keys() {  # name
    local name="$1" sc k a human f state
    sc="$(mod_shortcut "$name")"; [ -n "$sc" ] || return 0
    IFS="$(printf '\t')" read -r k a human <<< "$sc"
    f="$(mod_keys_file)"
    if [ "$(json_tool)" = none ]; then
        warn "no jq/python/powershell found - to show and hide mod $name with $human, add \"$k\": \"$a\" to a \"Global\" block of $f by hand"
        return 0
    fi
    if [ ! -f "$f" ]; then
        mkdir -p "$(dirname "$f")"
        printf '{\n  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",\n  "$docs": "https://code.claude.com/docs/en/keybindings",\n  "bindings": []\n}\n' > "$f"
    fi
    state="$(keys_edit bind "$f" "$k" "$a")"
    case "$state" in
        added) say "mod $name: $human now shows and hides it (added to ~/.claude/keybindings.json)" ;;
        present) say "mod $name: $human already shows and hides it" ;;
        taken*) warn "mod $name: $human ($k) is already bound to ${state#*$(printf '\t')} in ~/.claude/keybindings.json, so it was left as it is; to bind the pane by hand, add \"<your key>\": \"$a\" to a \"Global\" block there" ;;
        *) warn "mod $name: ~/.claude/keybindings.json could not be read as a keybindings file, so it was left as it is; to bind the pane by hand, add \"$k\": \"$a\" to a \"Global\" block there" ;;
    esac
}
# Takes the mod's key away only while it still runs the mod's action.
mod_unbind_keys() {  # name
    local name="$1" sc k a human f
    sc="$(mod_shortcut "$name")"; [ -n "$sc" ] || return 0
    IFS="$(printf '\t')" read -r k a human <<< "$sc"
    f="$(mod_keys_file)"
    [ -f "$f" ] || return 0
    if [ "$(json_tool)" = none ]; then
        warn "no jq/python/powershell found - remove \"$k\": \"$a\" from $f by hand"
        return 0
    fi
    case "$(keys_edit unbind "$f" "$k" "$a")" in
        removed) say "mod $name: $human taken out of ~/.claude/keybindings.json" ;;
        removed-empty) rm -f "$f"; say "mod $name: $human taken out, and ~/.claude/keybindings.json, empty without it, deleted" ;;
        none) ;;
        *) warn "mod $name: ~/.claude/keybindings.json could not be read as a keybindings file; if it still binds \"$k\" to \"$a\", remove that by hand" ;;
    esac
}

mod_write_market() {
    local dir name sep=""; dir="$(mod_home)"
    mkdir -p "$dir/.claude-plugin"
    { printf '{\n  "name": "%s",\n  "description": "orion mods, copied to this computer on its owner%ss word",\n' "$MOD_MARKET" "'"
      printf '  "owner": { "name": "orion" },\n  "plugins": ['
      for name in $(mod_copies); do printf '%s\n    { "name": "%s", "source": "./%s" }' "$sep" "$name" "$name"; sep=","; done
      printf '\n  ]\n}\n'; } > "$dir/.claude-plugin/marketplace.json"
}

# Unpack this project's mod on the computer and install it from there at user scope; one already installed is
# replaced and reinstalled. Never steps back to an older orion version's copy.
mod_install() {  # name
    local name="$1" src dir t; src="$(mod_src "$1")"; dir="$(mod_home)"
    { mod_name_ok "$name" && [ -f "$src" ]; } || { warn "this project carries no orion mod named '$name' (run: orion.sh update)"; return 1; }
    have claude || { warn "Claude Code's 'claude' command was not found, so mod $name was not installed and nothing changed"; return 1; }
    t="$(project_stamp)"
    # a copy deleted by hand counts as not installed, whatever the record says
    if [ -f "$(mod_stamp "$name")" ] && [ -d "$dir/$name" ] && ! version_gt "$t" "$(mod_taken "$name")"; then
        say "mod $name: nothing to install - this computer's copy already follows this project's orion version or a newer one"
        return 0
    fi
    mkdir -p "$dir"
    rm -rf "$dir/.$name.new"
    mod_unpack "$src" "$dir/.$name.new" || { rm -rf "$dir/.$name.new"; warn "could not unpack mod $name from $src; nothing changed"; return 1; }
    rm -rf "${dir:?}/$name"; mv "$dir/.$name.new" "$dir/$name"
    mod_write_market
    if [ -f "$(mod_stamp "$name")" ]; then
        # the person may have uninstalled it by hand: a failure here is no reason to stop
        claude plugin uninstall "$name@$MOD_MARKET" --scope user || true
        claude plugin marketplace update "$MOD_MARKET" >/dev/null 2>&1 || true
    fi
    claude plugin install "$name" --marketplace "$dir" --scope user \
        || { warn "Claude Code could not install mod $name (its message is above): run 'orion.sh mod install $name' again once that is fixed"; return 1; }
    mod_mark "$name" "$t"
    say "mod $name: installed for this computer from ~/.claude/$MOD_MARKET; Claude Code loads it in its next session"
    mod_bind_keys "$name"
}

mod_skip() {  # name
    local name="$1"
    [ -f "$(mod_stamp "$name")" ] || die "mod $name is not installed on this computer (run: orion.sh mod install $name)"
    [ "$(mod_sync "$name")" = offer ] || { say "mod $name: nothing to skip - no newer copy waits in this project"; return 0; }
    mod_mark "$name" "$(project_stamp)"
    say "mod $name: this computer's copy kept as it is; this orion version will not be offered again"
}

# Uninstall the mod and delete the computer's copy; the last one removed takes the marketplace folder with it.
mod_remove() {  # name
    local name="$1" dir; dir="$(mod_home)"
    # a record whose copy was deleted by hand still names a plugin to uninstall
    { mod_name_ok "$name" && { [ -d "$dir/$name" ] || [ -f "$(mod_stamp "$name")" ]; }; } \
        || { warn "no orion mod named '$name' is installed on this computer"; return 1; }
    have claude || { warn "Claude Code's 'claude' command was not found, so mod $name was not removed and nothing changed"; return 1; }
    claude plugin uninstall "$name@$MOD_MARKET" --scope user \
        || warn "Claude Code could not uninstall mod $name (its message is above); its copy is deleted all the same"
    rm -rf "${dir:?}/$name"; rm -f "$(mod_stamp "$name")"
    mod_unbind_keys "$name"
    if [ -n "$(mod_copies)" ]; then
        mod_write_market
    else
        claude plugin marketplace remove "$MOD_MARKET" || warn "Claude Code could not forget the $MOD_MARKET marketplace (its message is above)"
        rm -rf "$dir"
    fi
    say "mod $name: uninstalled, and its copy deleted from this computer"
}

mod_description() {  # name
    local t d=""; t="$(mktemp -d)"
    if mod_unpack "$(mod_src "$1")" "$t" 2>/dev/null; then d="$(config_get "$t/.claude-plugin/plugin.json" description "")"; fi
    rm -rf "$t"; printf '%s' "$d"
}

# init offers every mod the project carries: --mods takes them all, a terminal is asked mod by mod, else none.
offer_mods() {  # yes|no|prompt
    local name resp
    [ "$1" != no ] || return 0
    for name in $(mod_names); do
        if [ -f "$(mod_stamp "$name")" ]; then
            say "  =    mod $name (already on this computer; a newer copy is offered at session start)"; continue
        fi
        if [ "$1" = prompt ]; then
            is_tty || continue
            say "  mod $name: $(mod_description "$name")"
            ask "Also install the orion mod $name for this computer (a Claude Code plugin at user scope, optional)? [y/N] "
            [[ "$resp" =~ ^[Yy]$ ]] || continue
        fi
        mod_install "$name" || true
    done
}

# What whoever installs orion must know first: it is experimental and the user carries the responsibility, and its agents act on their own (the baseline's Who merges rule).
autonomy_notice() {
    say ""
    say "DISCLAIMER: orion is an experimental framework, provided as-is with no warranty."
    say "You are responsible for how you use it and for every change its agents make in your projects."
    say ""
    say "orion is built for agent autonomy. Once it is installed, its agents in this project:"
    say "  - claim open issues and build them end to end,"
    say "  - file new tickets for what they find,"
    say "  - merge their own pull requests once the checks are green."
    say "A person still merges a pull request that touches the PRD, an ADR, the UX prototype or CLAUDE.md."
    say ""
}

# --------------------------------------------------------------------------
# the declared branches: the development branch (daily work) and the release branch (deploys)
# --------------------------------------------------------------------------
# The repository's default branch as this clone last saw it (origin/HEAD), else the branch checked out, else main.
# Local only: no network.
current_default_branch() {
    local b
    b="$(git -C "$PROJECT" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)" && [ -n "$b" ] && { printf '%s' "${b#origin/}"; return; }
    b="$(git -C "$PROJECT" symbolic-ref -q --short HEAD 2>/dev/null)" && [ -n "$b" ] && { printf '%s' "$b"; return; }
    printf 'main'
}

# origin's owner/name when origin's host is github.com (read as written, before any insteadOf rewrite), else nothing.
# Only <scheme>://[user@]github.com[:port]/<owner>/<name> or [user@]github.com:<owner>/<name> counts: a mirror whose
# path or user part holds github.com, a host that only starts with it, or a user part holding ? or # (a URL that
# reaches another host) is no GitHub remote.
github_repo() {
    local url host slug
    url="$(git -C "$PROJECT" config --get remote.origin.url 2>/dev/null)" || return 0
    case "$url" in
        *://*)
            case "${url%%://*}" in ""|*[!a-z+]*) return 0 ;; esac
            slug="${url#*://}"; host="${slug%%/*}"; [ "$host" != "$slug" ] || return 0
            case "$host" in *[?#]*|*@*@*) return 0 ;; esac
            slug="${slug#*/}"; host="${host##*@}"
            case "$host" in github.com) ;; github.com:*) case "${host#github.com:}" in ""|*[!0-9]*) return 0 ;; esac ;; *) return 0 ;; esac ;;
        *:*)
            host="${url%%:*}"; slug="${url#*:}"
            case "$host" in */*|*[?#]*|*@*@*) return 0 ;; esac
            [ "${host##*@}" = github.com ] || return 0 ;;
        *) return 0 ;;
    esac
    slug="${slug%/}"; slug="${slug%.git}"
    case "$slug" in ""|/*|*/|*/*/*|*[!A-Za-z0-9._/-]*) return 0 ;; */*) printf '%s' "$slug" ;; esac
}

branch_name_ok() { case "$1" in ""|-*) return 1 ;; esac; git check-ref-format --branch "$1" >/dev/null 2>&1; }

# A step orion could not take: the one thing the person does by hand. Never fails the install.
branches_manual() { say "  !    $1"; }

# The default branch origin/HEAD records, or nothing when this clone has none.
origin_head_branch() {
    local b
    b="$(git -C "$PROJECT" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)" || return 0
    printf '%s' "${b#origin/}"
}

# The branch names the starter CLAUDE.md writes: the declared ones, else the current default branch.
starter_branches() {
    local cfg="$PROJECT/.claude/orion/config.json" cur
    cur="$(current_default_branch)"
    STARTER_DEVELOP="$(config_get "$cfg" developBranch "$cur")" STARTER_RELEASE="$(config_get "$cfg" releaseBranch "$cur")"
}

# The only writer of developBranch and releaseBranch, and the only code that changes GitHub: stores both names,
# creates a declared branch the remote lacks (from the current default branch), and makes the development branch
# GitHub's default, then refreshes origin/HEAD. A name left empty is not named: it is taken from config.json, else
# the current default branch. With no name at all it only stores them, with no network call. Before any write to
# GitHub the current default branch is the one the remote names now (origin/HEAD is always refreshed first, so a
# stale or missing one is never taken for it), never a guess from the branch checked out; when the refresh fails,
# nothing is pushed or switched.
apply_branches() {  # dev release
    local dev="$1" rel="$2" named="$1$2" cfg="$PROJECT/.claude/orion/config.json" cur slug b rc key val dev_missing=0
    slug="$(github_repo)"
    if [ -n "$named" ] && [ -n "$slug" ]; then
        cur=""
        if limited 15 git -C "$PROJECT" remote set-head origin --auto </dev/null >/dev/null 2>&1; then cur="$(origin_head_branch)"; fi
    else
        cur="$(current_default_branch)"
    fi
    [ -n "$dev" ] || dev="$(config_get "$cfg" developBranch "$cur")"
    [ -n "$rel" ] || rel="$(config_get "$cfg" releaseBranch "$cur")"
    for key in developBranch releaseBranch; do
        if [ "$key" = developBranch ]; then val="$dev"; else val="$rel"; fi
        [ -n "$val" ] || continue
        if config_put "$cfg" "$key" "$val"; then say "  ~    .claude/orion/config.json: $key '$val'"
        else warn "could not write $key into .claude/orion/config.json; add \"$key\": \"$val\" there by hand"; fi
    done
    [ -n "$dev" ] && [ "$dev" = "$rel" ] && say "       (one branch for both: no release pull request)"
    [ -n "$named" ] || return 0
    if [ -z "$cur" ]; then
        branches_manual "could not tell GitHub's default branch (git remote set-head origin --auto could not read it from origin), so nothing was pushed or switched: run git fetch origin, then git remote set-head origin --auto, then bash .claude/orion/orion.sh branches --dev ${dev:-<development branch>} --release ${rel:-<release branch>}"
        return 0
    fi
    [ "$dev" = "$cur" ] && [ "$rel" = "$cur" ] && return 0
    if [ -z "$slug" ]; then
        branches_manual "no GitHub remote (origin), so GitHub was not changed: create the branches '$dev' and '$rel' if they are missing and make '$dev' the repository's default branch by hand"
        return 0
    fi
    for b in $( { printf '%s\n' "$dev" "$rel"; } | awk '!seen[$0]++' ); do
        [ "$b" = "$cur" ] && continue
        rc=0; limited 15 git -C "$PROJECT" ls-remote --exit-code --heads origin "refs/heads/$b" </dev/null >/dev/null 2>&1 || rc=$?
        [ "$rc" = 0 ] && continue
        if [ "$rc" = 2 ] && limited 30 git -C "$PROJECT" fetch --quiet origin "refs/heads/$cur:refs/remotes/origin/$cur" </dev/null >/dev/null 2>&1 \
            && limited 30 git -C "$PROJECT" push --quiet origin "refs/remotes/origin/$cur:refs/heads/$b" </dev/null >/dev/null 2>&1; then
            say "  +    branch '$b' created on origin from '$cur'"
        else
            branches_manual "could not create the branch '$b' on origin: create it from '$cur' by hand (git push origin origin/$cur:refs/heads/$b)"
            [ "$b" = "$dev" ] && dev_missing=1
        fi
    done
    [ "$dev" = "$cur" ] && return 0
    # GitHub's default is never pointed at a branch origin lacks.
    if [ "$dev_missing" = 1 ]; then
        branches_manual "GitHub's default branch was not changed: '$dev' must exist on origin first; once it does, run bash .claude/orion/orion.sh branches --dev $dev --release $rel"
        return 0
    fi
    if ! have gh; then
        branches_manual "gh is not installed, so GitHub's default branch is still '$cur': make '$dev' the default branch in the repository's settings (Settings, General, Default branch), then run git fetch origin, then git remote set-head origin --auto"
    elif ! GH_PROMPT_DISABLED=1 limited 30 gh repo edit "github.com/$slug" --default-branch "$dev" </dev/null >/dev/null 2>&1; then
        branches_manual "gh could not make '$dev' the default branch of $slug (only a repository admin can): ask one to change it in the repository's settings, or run gh repo edit github.com/$slug --default-branch $dev, then git fetch origin, then git remote set-head origin --auto"
    else
        say "  ~    GitHub's default branch of $slug is now '$dev' (was '$cur')"
        limited 15 git -C "$PROJECT" remote set-head origin --auto </dev/null >/dev/null 2>&1 \
            || branches_manual "could not refresh origin/HEAD: run git fetch origin, then git remote set-head origin --auto"
        say "       orion changed nothing else; three things to know:"
        say "       - open pull requests keep their base '$cur': move each one with gh pr edit <N> --base $dev"
        say "       - a workflow that runs only on a push to '$cur' gets no run for a merge into '$dev' until you add that branch to it"
        say "       - a workflow started by hand or on a schedule now runs on '$dev', and a deploy environment that allows only '$cur' rejects it"
    fi
}

# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------
cmd_init() {
    local source="$ORION_DEFAULT_SOURCE" ref="$ORION_DEFAULT_REF" force=0 statusline="prompt" project="" resp mode="" yes=0
    local source_given=0 ref_given=0 key val old n mods="prompt" dev="" rel="" first=0 cur
    while [ $# -gt 0 ]; do
        case "$1" in
            --source) source="$2"; source_given=1; shift 2 ;;
            --ref) ref="$2"; ref_given=1; shift 2 ;;
            --update-mode) mode="$2"; shift 2 ;;
            --dev-branch) dev="${2:-}"; branch_name_ok "$dev" || die "--dev-branch needs a valid branch name (got: $dev)"; shift 2 ;;
            --release-branch) rel="${2:-}"; branch_name_ok "$rel" || die "--release-branch needs a valid branch name (got: $rel)"; shift 2 ;;
            --project) project="$2"; shift 2 ;;
            --force) force=1; shift ;;
            --yes|-y) yes=1; shift ;;
            --statusline) statusline=yes; shift ;;
            --no-statusline) statusline=no; shift ;;
            --mods) mods=yes; shift ;;
            --no-mods) mods=no; shift ;;
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
    autonomy_notice
    if [ "$yes" != "1" ]; then
        is_tty || die "refusing to init without --yes in a non-interactive shell (an assistant running this: show the person the notice above, then run again with --yes once they agree)"
        ask "Install orion in $PROJECT on these terms? [y/N] "
        [[ "$resp" =~ ^[Yy]$ ]] || { say "aborted"; return; }
    fi
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
        say "  2) auto  - an agent ships it through its own pull request without asking"
        say "  3) off   - never check"
        ask "Choose [1/2/3] (Enter = ask): "
        case "$resp" in 2|auto) mode=auto ;; 3|off) mode=off ;; *) mode=ask ;; esac
    fi
    # The two branch names: asked on a first install at a terminal, as the update mode is; both default to the
    # repository's current default branch, and the same name for both is a one-branch project.
    [ -f "$cfg" ] || first=1
    if [ "$first" = 1 ] && [ -z "$dev$rel" ] && is_tty; then
        # The questions name GitHub's default as the remote gives it now, never a stale origin/HEAD: with origin on
        # GitHub it is refreshed first (time-limited), and a failed refresh names no branch at all.
        cur="$(current_default_branch)"
        if [ -n "$(github_repo)" ]; then
            cur="GitHub's current default branch"
            if limited 15 git -C "$PROJECT" remote set-head origin --auto </dev/null >/dev/null 2>&1; then
                [ -z "$(origin_head_branch)" ] || cur="$(origin_head_branch)"
            fi
        fi
        say "Which branch does daily work start from and merge into (the development branch)?"
        say "A name other than $cur is created on origin if it is missing and becomes the repository's default branch on GitHub."
        ask "Development branch (Enter = $cur): " || resp=""
        dev="$resp"; [ -z "$dev" ] || branch_name_ok "$dev" || die "not a valid branch name: $dev"
        say "Which branch does the project deploy from (the release branch)? The same name means one branch."
        ask "Release branch (Enter = $cur): " || resp=""
        rel="$resp"; [ -z "$rel" ] || branch_name_ok "$rel" || die "not a valid branch name: $rel"
    fi
    # orion.sh branches runs on a first install, and on an existing one only when a branch flag asks for it.
    local run_branches=0
    { [ "$first" = 1 ] || [ -n "$dev$rel" ]; } && run_branches=1
    fetch_source "$source" "$ref"
    retire_user_level_copies
    apply_skills init "$force"
    apply_core "$source" "$ref" "${mode:-ask}"
    [ "$run_branches" = 1 ] && apply_branches "$dev" "$rel"
    starter_branches
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
    offer_mods "$mods"
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
    # the hint is printed only without --quiet, which then skips its cost
    local rules_before=""; [ "$quiet" = "1" ] || rules_before="$(rules_sum)"
    # an update run by an older orion.sh left out the status line, the personal rules or the mods: redo it once
    { [ -d "$dir/statusline" ] && [ -d "$dir/global" ] && { [ -d "$dir/mods" ] || [ ! -d "$SRC_DIR/mods" ]; }; } || force=1
    if [ "$SRC_SHA" = "$current" ] && [ "$force" != "1" ]; then
        say "orion is already at $(short "$current") - nothing to do (pass --force to re-copy anyway)"
        # installed before its release was tagged: only the version on line 5 is behind
        if [ -n "$SRC_VERSION" ] && [ "$SRC_VERSION" != "$(version_number "$dir/VERSION")" ]; then
            version_line_set "$dir/VERSION" "$SRC_VERSION"
            say "  ~    .claude/orion/VERSION records orion $SRC_VERSION, the newest release on that commit"
        fi
        settings_raise_hook_timeout "$PROJECT/.claude/settings.json"
        return
    fi
    say "orion update $(short "$current") -> $(short "$SRC_SHA") in $PROJECT"
    apply_skills update 0
    apply_core "$source" "$ref"
    starter_branches
    apply_claude_md
    settings_add_hook "$PROJECT/.claude/settings.json"
    case "$(statusline_sync)" in
        new) say "  !    orion's status line changed and yours was left alone: 'bash .claude/orion/orion.sh statusline merge' takes it ('statusline skip' declines this version)" ;;
        offer) say "  !    your status line has edits of your own, so it was left alone: 'bash .claude/orion/orion.sh statusline merge' takes orion's changes and keeps yours ('statusline skip' declines this version)" ;;
    esac
    local name
    for name in $(mod_names); do
        if [ "$(mod_sync "$name")" = offer ]; then
            say "  !    orion's mod $name changed and this computer's copy was left alone: 'bash .claude/orion/orion.sh mod install $name' takes it ('mod skip $name' declines this version)"
        fi
    done
    if [ "$quiet" != "1" ]; then
        say "done. Review with 'git status' / 'git diff', then commit on a branch so your team gets it."
        [ "$(rules_sum)" = "$rules_before" ] || say "orion's rules or skill instructions changed: run /orion-verify to check they still fit with CLAUDE.md, the project's own skills and your own rules file."
    fi
}

# Under off (read_update_mode, once per session start), nothing newer from orion is offered: no update, no rules
# check, no status line, no mod, no personal rules.
updates_off() { [ "${UPDATE_MODE:-}" = off ]; }

# Fetch exactly one commit of orion into a temp dir: SRC_DIR, SRC_SHA and SRC_TIME, as fetch_source sets them.
# Prints nothing; 1 when that commit cannot be fetched (no network, or the source no longer serves it).
fetch_commit() {  # source sha
    case "$2" in ""|*[!0-9a-f]*) return 1 ;; esac
    have git || return 1
    TMP_DIR="$(mktemp -d)"
    { git init -q "$TMP_DIR/orion" && limited 120 git -C "$TMP_DIR/orion" fetch -q --depth 1 "$1" "$2" \
        && git -C "$TMP_DIR/orion" checkout -q --detach "$2"; } >/dev/null 2>&1 || return 1
    SRC_DIR="$TMP_DIR/orion"; SRC_SHA="$2"
    SRC_TIME="$(git -C "$SRC_DIR" log -1 --format=%ct 2>/dev/null || printf '0')"
}

# The same-version repair: re-copy everything orion owns from the commit already installed (line 1 of VERSION),
# fetched from the source in config.json, in every update mode. VERSION keeps its commit, time and version number
# (an empty number is filled when the source names the installed commit's release), and an existing config.json is
# never touched. A project skill without the orion marker in an orion skill's place is asked about at a terminal and
# skipped elsewhere, unless --force (given on the person's word) replaces it. When the installed commit cannot be
# fetched, nothing changes: one line, exit 1.
cmd_repair() {
    local force=0 project=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) project="$2"; shift 2 ;;
            --force) force=1; shift ;;
            -h|--help) usage ;;
            *) die "unknown option for repair: $1" ;;
        esac
    done
    PROJECT="$(resolve_project "$project")"
    local dir="$PROJECT/.claude/orion" cfg="$PROJECT/.claude/orion/config.json" source ref sha number
    [ -f "$dir/VERSION" ] || die "orion is not installed in $PROJECT (run: orion.sh init)"
    source="$(config_get "$cfg" source "$ORION_DEFAULT_SOURCE")"; ref="$(config_get "$cfg" ref "$ORION_DEFAULT_REF")"
    sha="$(version_sha "$dir/VERSION" | tr -d '\r')"
    fetch_commit "$source" "$sha" \
        || die "could not fetch the installed orion commit $(short "$sha") from $source, so nothing was changed (orion.sh update moves to the newest orion instead)"
    number="$(version_number "$dir/VERSION")"
    if [ -z "$number" ]; then latest_remote "$source" "$ref"; number="$(installed_release "$sha" "$ref")"; fi
    SRC_VERSION="$number"
    cp "$dir/VERSION" "$TMP_DIR/VERSION.kept"
    say "orion repair at $(version_label "$sha" "$number") ($(short "$sha")) in $PROJECT"
    apply_skills repair "$force"
    apply_core "$source" "$ref"
    # the install stays as it was: the same commit, install time and version number
    cp "$TMP_DIR/VERSION.kept" "$dir/VERSION"
    if [ -n "$number" ] && [ -z "$(version_number "$dir/VERSION")" ]; then version_line_set "$dir/VERSION" "$number"; fi
    starter_branches
    apply_claude_md
    settings_add_hook "$PROJECT/.claude/settings.json"
    say "done: orion's files are as $(version_label "$sha" "$number") ships them. Review with 'git status' / 'git diff'."
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
    local dir="$PROJECT/.claude/orion" now ctx tidy pending pulled global head problem
    [ -f "$dir/VERSION" ] || exit 0
    cache_key_set
    pulled="$(check_pull_ctx)"
    # Read after the pull, so a mode a teammate changed is obeyed in this same session start. A value orion does
    # not understand behaves as off, and says so at every session start until it is fixed.
    read_update_mode "$dir/config.json"; problem="$UPDATE_MODE_PROBLEM"
    now=$(date +%s)
    head="$(check_head_ctx "$force" "$now")"
    [ -n "$head" ] && pulled="${pulled:+$pulled After that: }$head"
    # A fresh init leaves a one-shot marker: ask for the post-install check instead of an update.
    # Without the /orion-verify skill there is nothing to ask for, so the marker waits for it (or for `verify`).
    pending="$(cache_file verify-pending)"
    if [ -f "$pending" ] && [ -f "$PROJECT/.claude/skills/orion-verify/SKILL.md" ]; then
        rm -f "$pending" 2>/dev/null || true
        rules_mark
        ctx="orion was just installed in this project and its post-install check has not run yet. Before anything else, run the /orion-verify skill (.claude/skills/orion-verify/SKILL.md) exactly as written: it checks that CLAUDE.md, the imported BASE_CLAUDE.md, the skills under .claude/skills and the settings are consistent after the install, fixes what is mechanical, asks before touching anything the project owns, and reports in a few lines. Then continue with the user's request."
        global="$(check_global_ctx 1 "$(date +%s)")"
        [ -n "$global" ] && ctx="$ctx After /orion-verify: $global"
        [ -n "$problem" ] && ctx="$ctx After that: $problem"
        [ -n "$pulled" ] && ctx="$ctx After that: $pulled"
        printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx"
        exit 0
    fi
    ctx="$(check_update_ctx "$force")"
    for tidy in "$problem" "$(check_uncommitted_ctx)" "$(check_rules_ctx)" "$(check_statusline_ctx)" "$(check_mods_ctx)" "$(check_global_ctx "$force" "$now")" "$(check_branches_ctx "$force" "$now")" "$pulled"; do
        [ -n "$tidy" ] || continue
        if [ -n "$ctx" ]; then ctx="$ctx After that: $tidy"; else ctx="$tidy"; fi
    done
    [ -n "$ctx" ] || exit 0
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx"
}

# The update check, every session. Prints the context for Claude Code, or nothing when there is nothing to say.
check_update_ctx() {  # force
    local cfg="$PROJECT/.claude/orion/config.json" dir="$PROJECT/.claude/orion" mode source ref current latest
    local installed newer=0
    mode="$UPDATE_MODE"
    updates_off && return 0
    # An update run by an older orion.sh cannot raise the hook's time limit (bash had already read the old
    # script), so the first check by the new script heals it, silently.
    raise_hook_timeout "$PROJECT/.claude/settings.json" >/dev/null 2>&1 || true
    source="$(config_get "$cfg" source "$ORION_DEFAULT_SOURCE")"; ref="$(config_get "$cfg" ref "$ORION_DEFAULT_REF")"
    current="$(version_sha "$dir/VERSION")"; installed="$(version_number "$dir/VERSION")"
    latest_remote "$source" "$ref"
    [ -n "$LATEST_SHA" ] || return 0
    # An update by an older orion.sh (one that read its number from a file the source no longer ships) left line 5
    # empty: fill it with the installed commit's release number when the source names one, silently.
    if [ -z "$installed" ]; then
        installed="$(installed_release "$current" "$ref")"
        [ -z "$installed" ] || version_line_set "$dir/VERSION" "$installed" 2>/dev/null || true
    fi
    # A release raises the version number, so a merge that changes nothing a project receives is not offered. Release
    # tags mark the default branch only; without a number on both sides any new commit counts, as before numbers.
    if [ -n "$LATEST_NUM" ] && [ -n "$installed" ] && [ "$ref" = "$ORION_DEFAULT_REF" ]; then
        # the installed commit is the newest even when its release was tagged after the install: nothing to offer
        version_gt "$LATEST_NUM" "$installed" && [ "$LATEST_SHA" != "$current" ] && newer=1
        latest="$(version_label "$LATEST_SHA" "$LATEST_NUM")"
    else
        [ "$LATEST_SHA" != "$current" ] && newer=1
        latest="$(short "$LATEST_SHA")"
    fi
    current="$(version_label "$current" "$installed")"
    # Nothing newer: nothing to offer. A status line or personal rules folder an older orion.sh left out is copied
    # again by the next update, which re-copies everything when either is missing.
    [ "$newer" = 1 ] || return 0
    # declined with `update --skip`: quiet until a newer orion, unless the person asked for the check (--force)
    [ "$mode" = "auto" ] || [ "$1" = "1" ] || [ "$(cat "$(cache_file update-skipped)" 2>/dev/null)" != "$(latest_key "$installed" "$ref")" ] || return 0
    # Never updated in the folder the session opens in: the agent ships it through its own pull request
    case "$mode" in
        auto)
            printf '%s' "A newer orion is available for this project ($current -> $latest) and the project's updateMode is 'auto', so do not ask the user. $SHIP_STEPS Tell the user in one line when it has merged, or what stopped it." ;;
        *)
            printf '%s' "A newer orion is available for this project ($current -> $latest). Before anything else, ask the user with the AskUserQuestion tool whether to update orion now (options: 'Update now' recommended, 'Not now'). If they say yes: $SHIP_STEPS If they say no, run 'bash .claude/orion/orion.sh update --skip' from the project root, so this version is not offered again on this computer, and continue with their request." ;;
    esac
}

# Every session, local only: once each time orion's rules change on this computer (an update, or a pull that
# brought one), ask for /orion-verify. Runs after the session-start pull, so rules a pull brought are seen in the
# same session.
# A repository with no record on this computer (a fresh clone) is asked once too, worded as new, not as changed.
# Silent under off, and the fingerprint is not recorded then, so the question comes once the mode is ask or auto again.
check_rules_ctx() {
    local sum f
    updates_off && return 0
    [ -f "$PROJECT/.claude/skills/orion-verify/SKILL.md" ] || return 0
    sum="$(rules_sum)"; f="$(cache_file rules-checked)"
    if [ ! -f "$f" ]; then
        rules_mark "$sum"
        printf '%s' "orion is new on this computer for this repository: its rules (.claude/orion/BASE_CLAUDE.md) and the instructions of its skills have not been checked here yet. Before anything else, ask the user with the AskUserQuestion tool whether to check now that they fit with the project's CLAUDE.md, the project's own skills and the user's own rules file (options: 'Check now' recommended, 'Not now'). If they say yes, run the /orion-verify skill (.claude/skills/orion-verify/SKILL.md) exactly as written. If they say no, continue with their request: it is not asked again until the rules change, and /orion-verify runs the check any time."
        return 0
    fi
    rules_checked "$sum" && return 0
    # the fingerprint an older orion took of these same rules, line endings included: nothing changed
    if rules_checked "$(rules_sum raw)"; then rules_mark "$sum"; return 0; fi
    rules_mark "$sum"
    printf '%s' "orion's rules (.claude/orion/BASE_CLAUDE.md) or the instructions of its skills have changed since they were last checked on this computer, after an update or a pull that brought one. Before anything else, ask the user with the AskUserQuestion tool whether to check now that they still fit with the project's CLAUDE.md, the project's own skills and the user's own rules file (options: 'Check now' recommended, 'Not now'). If they say yes, run the /orion-verify skill (.claude/skills/orion-verify/SKILL.md) exactly as written. If they say no, continue with their request: it is not asked again until the rules change, and /orion-verify runs the check any time."
}

# 0 when $PROJECT sits in a repository's main checkout, not in a linked worktree (an agent's own copy).
in_main_checkout() {
    local g c
    g="$(git -C "$PROJECT" rev-parse --git-dir 2>/dev/null)" && c="$(git -C "$PROJECT" rev-parse --git-common-dir 2>/dev/null)" || return 1
    g="$(cd "$PROJECT" && cd "$g" && pwd -P)" && c="$(cd "$PROJECT" && cd "$c" && pwd -P)" || return 1
    [ "$g" = "$c" ]
}

# Every path orion owns in the project, one per line: each manifest line under .claude/orion/ and each orion skill's
# folder, on disk or in git's index (a skill removed from the folder still counts). A manifest line that names no
# file of its own (blank, only slashes, or a . or .. part) is left out: it could name the whole folder, the
# project's own config.json included, or climb out of the repository and make git refuse the whole list.
orion_paths() {
    local f entry
    while IFS= read -r f || [ -n "$f" ]; do
        f="${f%$'\r'}"
        [ -n "${f//\//}" ] || continue
        case "/$f/" in */../*|*/./*) continue ;; esac
        printf '.claude/orion/%s\n' "$f"
    done < <(cat "$PROJECT/.claude/orion/.orion-manifest" 2>/dev/null || true)
    for entry in "$PROJECT"/.claude/skills/*/; do
        [ -f "${entry%/}/$MARKER" ] && printf '.claude/skills/%s/\n' "$(basename "$entry")"
    done
    git -C "$PROJECT" ls-files -- ".claude/skills/*/$MARKER" 2>/dev/null | sed 's|[^/]*$||' || true
}

# Every session, local only (no network): orion's own files in the main checkout that differ from the last commit
# (an install or update not committed yet, or someone's own edits) are offered for shipping, never discarded.
# Prints the context or nothing.
check_uncommitted_ctx() {
    local f n paths=()
    have git && in_main_checkout || return 0
    while IFS= read -r f; do paths+=("$f"); done < <(orion_paths)
    [ ${#paths[@]} -gt 0 ] || return 0
    # literal pathspecs: a manifest line with a wildcard or pathspec magic names only itself
    n="$(git --literal-pathspecs -C "$PROJECT" status --porcelain --untracked-files=all -- "${paths[@]}" 2>/dev/null | wc -l | tr -d ' ')" || return 0
    [ "${n:-0}" -gt 0 ] || return 0
    printf '%s' "orion's own files in this folder differ from the last commit ($n changed, added or removed among the orion skills under .claude/skills and the files .claude/orion/.orion-manifest lists): an install or update not committed yet, or someone's own edits. Tell the user in one line, then ask with the AskUserQuestion tool whether to ship them through their own pull request (options: 'Ship them' recommended, 'Not now'). If they say yes, follow the 'Ship an update' steps of the /orion skill (.claude/skills/orion/SKILL.md) for files left uncommitted, exactly as written. Never discard, reset, stash or check out these files to get rid of them: they may hold the user's own edits. If they say no, continue with their request; this is asked again at the next session start while they still differ."
}

# Every session, local only: a newer status line in the project is offered, never taken on its own, under ask and
# auto; nothing under off. Prints the context or nothing.
check_statusline_ctx() {
    local sync
    updates_off && return 0
    sync="$(statusline_sync)"
    if [ "$sync" = "new" ]; then
        printf '%s' "orion's status line has changed, and the copy on this computer (~/.claude/statusline) was left as it is: orion never changes it without the user's word. Ask the user with the AskUserQuestion tool whether to take orion's new status line (options: 'Take it' recommended, 'Keep mine as it is'). If yes, run 'bash .claude/orion/orion.sh statusline merge' from the project root: their copy carries no edits of its own, so it simply becomes orion's new one. If no, run 'bash .claude/orion/orion.sh statusline skip' so this version is not offered again."
    elif [ "$sync" = "offer" ]; then
        printf '%s' "orion's status line has changed, and the copy on this computer (~/.claude/statusline) carries the user's own edits, so it was not replaced. Ask the user with the AskUserQuestion tool whether to merge orion's new status line changes into theirs (options: 'Merge them in' recommended, 'Keep mine as it is'). If yes, run 'bash .claude/orion/orion.sh statusline merge' from the project root: it keeps their edits (a copy installed before orion could merge is saved to ~/.claude/statusline.bak and replaced), and if it reports lines both changed, resolve the conflict markers in the named files with the user. If no, run 'bash .claude/orion/orion.sh statusline skip' so this version is not offered again."
    fi
}

# Every session, local only: a newer copy of a mod this computer installed is offered, never taken on its own, under
# ask and auto; nothing under off. Prints the context or nothing.
check_mods_ctx() {
    local name out=""
    updates_off && return 0
    for name in $(mod_names); do
        [ "$(mod_sync "$name")" = offer ] || continue
        out="$out${out:+ }orion's mod $name has changed in this project, and the copy installed on this computer (~/.claude/orion-mods/$name) was left as it is: orion never changes it without the user's word. Ask the user with the AskUserQuestion tool whether to install the new version (options: 'Install it' recommended, 'Keep mine as it is'). If yes, run 'bash .claude/orion/orion.sh mod install $name' from the project root: it replaces the computer's copy and reinstalls the plugin at user scope, and Claude Code loads it in its next session. If no, run 'bash .claude/orion/orion.sh mod skip $name' so this version is not offered again."
    done
    printf '%s' "$out"
}

# --------------------------------------------------------------------------
# personal rules (offered, never written). Every project carries orion's GLOBAL_CLAUDE.md in .claude/orion/global;
# what the person accepts lives in the ORION GLOBAL section at the end of their own ~/.claude/CLAUDE.md, whose
# heading version number is the only record of what was offered. orion.sh only reads that file.
# --------------------------------------------------------------------------
global_copy() { printf '%s' "$PROJECT/.claude/orion/global/GLOBAL_CLAUDE.md"; }
personal_rules() { printf '%s' "$HOME/.claude/CLAUDE.md"; }

# The version on the person's ORION GLOBAL heading line (# ORION GLOBAL — v<version>), or nothing when there is no
# section (a heading in any other form counts as none).
global_stamp() {
    local f; f="$(personal_rules)"
    [ -f "$f" ] || return 0
    rule_version_of "$(tr -d '\r' < "$f" | sed -n 's/^# ORION GLOBAL.* v\([0-9][0-9.]*+\{0,1\}\)[[:space:]]*$/\1/p' | head -n1)"
}

# "<count> <highest>": how many clauses of the project's GLOBAL_CLAUDE.md carry a version note newer than that
# version (all of them without one), and the newest version note in the file (0 when there is none).
global_newer() {
    local f t v n=0 top=""; f="$(global_copy)"
    [ -f "$f" ] || { printf '0 0'; return 0; }
    t="$(global_stamp)"
    while IFS= read -r v; do
        version_key "$v"; [ "${VKEY[0]}" != 0 ] || continue
        if [ -z "$t" ] || version_gt "$v" "$t"; then n=$((n + 1)); fi
        if [ -z "$top" ] || version_gt "$v" "$top"; then top="$v"; fi
    done <<< "$(tr -d '\r' < "$f" | sed -n 's/.* <!-- orion:v\([0-9][0-9.]*+\{0,1\}\) -->$/\1/p')"
    printf '%s %s' "$n" "${top:-0}"
}

# Local only: offer the personal rules discussion while a clause is newer than the person's section, never under
# updateMode off, in any other mode only offered. Once per clause version per computer (any project):
# global-offered-version holds "<highest clause version offered> <when>", and the offer comes back only when a project
# carries a higher one, or on --force; no such record counts as nothing offered. global-offered is the Unix time an
# older orion.sh on this computer reads and writes to offer at most once a day. Once an offer is recorded here, that
# time is pinned to GLOBAL_OFFER_PIN, so an older orion.sh never offers again; a past time there (an older orion.sh
# offered) less than a day old counts as this computer's offer of the project's clauses, recorded without a word,
# unless a clause is newer than any older orion.sh carries (LAST_DAILY_OFFER_VERSION): that one is still offered.
# Prints the context or nothing.
check_global_ctx() {  # force now
    local n top dir offered ours last
    updates_off && return 0
    read -r n top <<< "$(global_newer)"
    [ "${n:-0}" -gt 0 ] 2>/dev/null || return 0
    dir="${XDG_CACHE_HOME:-$HOME/.cache}/orion"
    # stderr goes first in every read and write: a missing or unwritable record is no error for the hook
    read -r offered ours <<< "$(tr -d '\r' 2>/dev/null < "$dir/global-offered-version" || true)"
    offered="$(rule_version_of "${offered:-}")"; ours="$(whole_number "${ours:-}")"
    last="$(whole_number "$(tr -d ' \t\r\n' 2>/dev/null < "$dir/global-offered" || true)")"
    if [ "$1" != "1" ]; then
        if ! version_gt "${top:-0}" "${offered:-0}"; then
            [ "$last" = "$GLOBAL_OFFER_PIN" ] || global_offer_record "$dir" "$offered" "$2"
            return 0
        fi
        if [ -n "$last" ] && [ "$last" != "$ours" ] && [ "$last" -le "$2" ] 2>/dev/null \
            && [ $(($2 - last)) -lt "$CHECK_INTERVAL_SECONDS" ] && ! version_gt "${top:-0}" "$LAST_DAILY_OFFER_VERSION"; then
            global_offer_record "$dir" "$top" "$2"
            return 0
        fi
    fi
    version_gt "${top:-0}" "${offered:-0}" || top="${offered:-0}"   # --force offers again and never lowers the record
    global_offer_record "$dir" "$top" "$2"
    printf '%s' "orion recommends personal rules for the user's own rules file (~/.claude/CLAUDE.md), and $n of them are not in its ORION GLOBAL section yet. Ask the user with the AskUserQuestion tool whether to go through them now (options: 'Go through them now' recommended, 'Not now'). If yes, follow the steps at the top of .claude/orion/global/GLOBAL_CLAUDE.md exactly as written: the user's file changes only inside its ORION GLOBAL section and only on their word. If no, continue with their request: it is offered again only when orion adds or changes one of these rules, and the user can ask to go through orion's personal rules any time."
}

# Records "<version> <now>" as the highest personal rules version offered on this computer and pins an older
# orion.sh's time stamp in the future, so only this record decides from then on. Never an error for the hook.
global_offer_record() {  # dir version now
    mkdir -p "$1" 2>/dev/null || true
    printf '%s %s\n' "$2" "$3" 2>/dev/null > "$1/global-offered-version" || true
    printf '%s' "$GLOBAL_OFFER_PIN" 2>/dev/null > "$1/global-offered" || true
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

# Keeps this clone's origin/HEAD in step with GitHub's default branch, every session, in a time-limited step of its
# own: whatever config.json says, and also on no branch or a branch with no remote copy (where the pull does nothing).
# Only after a successful refresh, when the declared development branch differs from origin/HEAD, it says so, at
# most once a day. Silent otherwise; an unreachable remote proves nothing and says nothing.
check_head_ctx() {  # force now
    local dev head stamp last
    have git || return 0
    git -C "$PROJECT" config --get remote.origin.url >/dev/null 2>&1 || return 0
    limited 8 git -C "$PROJECT" remote set-head origin --auto </dev/null >/dev/null 2>&1 || return 0
    dev="$(config_get "$PROJECT/.claude/orion/config.json" developBranch "")"
    [ -n "$dev" ] || return 0
    head="$(git -C "$PROJECT" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)" || return 0
    head="${head#origin/}"
    [ "$head" = "$dev" ] && return 0
    stamp="$(cache_file declared-branch-check)"
    if [ "$1" != "1" ] && [ -f "$stamp" ]; then
        last=$(cat "$stamp" 2>/dev/null || echo 0)
        [ $(($2 - last)) -lt "$CHECK_INTERVAL_SECONDS" ] && return 0
    fi
    mkdir -p "$(dirname "$stamp")" 2>/dev/null && printf '%s' "$2" 2>/dev/null > "$stamp" || true
    printf '%s' "GitHub's default branch (origin/HEAD) is $(json_escape "$head"), but .claude/orion/config.json declares $(json_escape "$dev") as the development branch, so the skills would merge daily work into $(json_escape "$head"). Tell the user in one line, and say that /orion-verify (.claude/skills/orion-verify/SKILL.md) offers the fix: bash .claude/orion/orion.sh branches, which changes the repository's default branch, run only on their yes. Never change it yourself."
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
    mkdir -p "$(dirname "$stamp")" 2>/dev/null && printf '%s' "$2" 2>/dev/null > "$stamp" || true
    printf '%s' "This project $over, set in .claude/orion/config.json. Before anything else, ask the user with the AskUserQuestion tool whether to tidy up now (options: 'Tidy up now' recommended, 'Not now'). If they say yes, run the /clear-git-resources skill (.claude/skills/clear-git-resources/SKILL.md) exactly as written: it deletes the user's own stale worktrees and branches whose work cannot be lost by itself, asks before deleting anyone else's stale ones, and never touches unmerged work or the audit and QA resources. If they say no, continue with their request and do not mention it again this session."
}

cmd_branches() {
    local project="" dev="" rel=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --dev) dev="${2:-}"; branch_name_ok "$dev" || die "--dev needs a valid branch name (got: $dev)"; shift 2 ;;
            --release) rel="${2:-}"; branch_name_ok "$rel" || die "--release needs a valid branch name (got: $rel)"; shift 2 ;;
            --project) project="$2"; shift 2 ;;
            -h|--help) usage ;;
            *) die "unknown option for branches: $1" ;;
        esac
    done
    [ -n "$dev$rel" ] || die "usage: orion.sh branches --dev <name> --release <name>"
    PROJECT="$(resolve_project "$project")"
    [ -f "$PROJECT/.claude/orion/config.json" ] || die "orion is not installed in $PROJECT (no .claude/orion/config.json): run init first"
    say "orion branches -> $PROJECT"
    apply_branches "$dev" "$rel"
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
    read_update_mode "$cfg"
    say "updateMode: $UPDATE_MODE$( [ -z "$UPDATE_MODE_PROBLEM" ] || printf ' (not understood as written, so treated as off)')   (edit .claude/orion/config.json: ask | auto | off)"
    say "branchLimit: $(config_get "$cfg" branchLimit "$BRANCH_LIMIT_DEFAULT")   (branches now: $(branch_count "$PROJECT"); the hook offers /clear-git-resources at the limit; a number or off)"
    say "worktreeLimit: $(config_get "$cfg" worktreeLimit "$WORKTREE_LIMIT_DEFAULT")   (worktrees now: $(worktree_count "$PROJECT"); the hook offers /clear-git-resources at the limit; a number or off)"
    if [ -n "$(config_get "$cfg" developBranch "")" ] && [ -n "$(config_get "$cfg" releaseBranch "")" ]; then
        say "branches:   development $(config_get "$cfg" developBranch ""), release $(config_get "$cfg" releaseBranch "")   (change with: orion.sh branches --dev <name> --release <name>)"
    else
        say "branches:   not declared (run: orion.sh branches --dev <name> --release <name>)"
    fi
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
    # last-check: the daily update stamp older versions left; the main checkout's records an older orion keyed on its path go too
    cache_key_set
    for f in verify-pending rules-checked update-skipped last-check; do
        rm -f "$(cache_file "$f")" 2>/dev/null || true
        [ -z "$LEGACY_KEY" ] || rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/orion/$LEGACY_KEY.$f" 2>/dev/null || true
    done
    say "done. The status line (if installed) is a per-computer copy under ~/.claude/statusline and was left alone,"
    say "so were the mods installed on this computer (orion.sh mod remove <name> removes one),"
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
    if ! version_gt "$(project_stamp)" "$(sl_stamp)"; then
        say "status line: nothing to $action - the copy on this computer already follows this project's orion version or a newer one"
        return
    fi
    case "$action" in
        merge) statusline_merge ;;
        skip) sl_mark "$(project_stamp)" "$PROJECT/.claude/orion/statusline"; say "status line: yours kept as it is; this orion version will not be offered again" ;;
    esac
}

# The answer to the session-start mod offer, and the way to add a mod to this computer or take it away again.
cmd_mod() {
    local action="${1:-}" name="${2:-}" project=""
    shift 2 2>/dev/null || shift $#
    while [ $# -gt 0 ]; do case "$1" in --project) project="$2"; shift 2 ;; *) die "unknown option for mod: $1" ;; esac; done
    case "$action" in install|skip|remove) ;; *) die "usage: orion.sh mod install|skip|remove <name>" ;; esac
    [ -n "$name" ] || die "usage: orion.sh mod install|skip|remove <name>"
    # removing needs no project: the computer's copy is all there is
    if [ "$action" = remove ]; then mod_remove "$name" || exit 1; return; fi
    PROJECT="$(resolve_project "$project")"
    if [ "$action" = install ]; then mod_install "$name" || exit 1; else mod_skip "$name"; fi
}

# Mechanical post-install checks: one line per finding, never a fix. Exit 1 when
# anything FAILs. The /orion-verify skill runs this first, then fixes and reviews.
# Clears the one-shot marker that init leaves for the session-start hook and records the rules it checked.
VERIFY_FAIL=0; VERIFY_WARN=0
v_ok()   { say "  ok    $1: $2"; }
v_warn() { say "  WARN  $1: $2"; VERIFY_WARN=$((VERIFY_WARN+1)); }
v_fail() { say "  FAIL  $1: $2"; VERIFY_FAIL=$((VERIFY_FAIL+1)); }

# Three warnings, never a FAIL: the names missing from config.json, GitHub's default branch (skipped when gh cannot
# read it) and this checkout's origin/HEAD, each against the declared development branch.
verify_branches() {  # config.json
    local dev rel slug gh_default head fix
    dev="$(config_get "$1" developBranch "")"; rel="$(config_get "$1" releaseBranch "")"
    if [ -z "$dev" ] || [ -z "$rel" ]; then
        v_warn branches-undeclared ".claude/orion/config.json does not name the development and release branches (developBranch, releaseBranch: an install from before orion asked for them); /orion-verify asks for the two names and runs orion.sh branches only on the person's yes"
        return 0
    fi
    v_ok branches "development branch '$dev', release branch '$rel'"
    fix="fix, on the person's yes: bash .claude/orion/orion.sh branches --dev $dev --release $rel"
    slug="$(github_repo)"
    if [ -n "$slug" ] && have gh; then
        gh_default="$(GH_PROMPT_DISABLED=1 limited 15 gh repo view "github.com/$slug" --json defaultBranchRef --jq .defaultBranchRef.name </dev/null 2>/dev/null | tr -d '\r' || true)"
        if [ -z "$gh_default" ]; then v_ok github-default "not compared: gh could not read the default branch of $slug"
        elif [ "$gh_default" = "$dev" ]; then v_ok github-default "GitHub's default branch is the declared development branch '$dev'"
        else v_warn github-default "GitHub's default branch of $slug is '$gh_default', not the declared development branch '$dev', so the skills merge daily work into '$gh_default' ($fix)"; fi
    fi
    head="$(git -C "$PROJECT" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    head="${head#origin/}"
    if [ -n "$head" ] && [ "$head" != "$dev" ]; then
        v_warn origin-head "this checkout's origin/HEAD points at '$head', not the declared development branch '$dev' (run git fetch origin, then git remote set-head origin --auto; if it still points there, GitHub's default branch differs: $fix)"
    fi
}

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
    else v_fail core-files "missing in .claude/orion:$n (fix: bash .claude/orion/orion.sh repair, or init if orion.sh itself is gone)"; fi
    read_update_mode "$cfg"
    if [ "$UPDATE_MODE_UNREADABLE" = 1 ]; then
        v_fail config-update-mode ".claude/orion/config.json is not plain text (saved as UTF-16?), so updateMode reads as off; save it as UTF-8 with updateMode ask, auto or off"
    elif [ -n "$UPDATE_MODE_PROBLEM" ]; then
        v_fail config-update-mode "updateMode is '$UPDATE_MODE_RAW' in .claude/orion/config.json, which reads as off; must be ask, auto or off"
    else
        v_ok config-update-mode "updateMode is '$UPDATE_MODE'"
    fi
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
        v_fail claude-md "CLAUDE.md is missing (fix: bash .claude/orion/orion.sh repair writes the starter)"
    else
        n=$(grep -cxF "$IMPORT_LINE" "$claude" || true)
        case "$n" in
            1) v_ok claude-md-import "CLAUDE.md imports .claude/orion/BASE_CLAUDE.md once" ;;
            0) v_fail claude-md-import "CLAUDE.md does not import the mandatory rules (fix: add this line at the top: $IMPORT_LINE)" ;;
            *) v_fail claude-md-import "CLAUDE.md carries the import line $n times (fix: keep the first, delete the others)" ;;
        esac
        grep -qxF "$OLD_IMPORT_LINE" "$claude" && v_fail claude-md-old-import "CLAUDE.md still imports the retired ORION.md (fix: delete that line; the BASE_CLAUDE.md import replaces it)"
        slots=$(grep -vE "$RETIRED_ROW_RE" "$claude" | grep -cF -e '`TBD`' -f <(starter_slots) || true)
        [ "$slots" -gt 0 ] 2>/dev/null && v_warn claude-md-slots "CLAUDE.md has $slots line(s) with an unfilled slot (TBD or a starter <placeholder>); the rules that rely on them cannot run until they are filled"
        verify_command_rows "$claude"
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
                v_fail rules-reference "the rules rely on $ref, which is not installed (a project skill without the orion marker kept its place, or it was deleted; fix: bash .claude/orion/orion.sh repair --force, on the person's word: the project's copy is theirs)"
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
                if [ "$ours" = "1" ]; then v_fail skill-file "$name (orion-managed) has no SKILL.md (fix: bash .claude/orion/orion.sh repair)"
                else v_warn skill-file "$name (the project's own) has no SKILL.md, so Claude Code ignores it"; fi
                continue
            fi
            sname=$(skill_name "${entry%/}/SKILL.md")
            if [ -z "$sname" ]; then
                if [ "$ours" = "1" ]; then v_fail skill-name "$name (orion-managed) has no name: in its front matter (fix: bash .claude/orion/orion.sh repair)"
                else v_warn skill-name "$name (the project's own) has no name: in its front matter"; fi
            elif [ "$sname" != "$name" ]; then
                if [ "$ours" = "1" ]; then v_fail skill-name "$name (orion-managed) declares name: $sname (fix: bash .claude/orion/orion.sh repair)"
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
        v_fail skills ".claude/skills is missing (fix: bash .claude/orion/orion.sh repair)"
    fi

    # 4. settings: the session-start hook
    if [ ! -f "$settings" ]; then
        v_fail settings-hook ".claude/settings.json is missing, so the update check never runs (fix: bash .claude/orion/orion.sh repair)"
    elif ! json_valid "$settings"; then
        v_fail settings-json ".claude/settings.json is not valid JSON; Claude Code ignores every setting in it (fix: repair it by hand, then re-run)"
    else
        n=$(hook_count "$settings")
        case "$n" in
            1) v_ok settings-hook ".claude/settings.json has the orion SessionStart hook once" ;;
            0) v_fail settings-hook ".claude/settings.json has no orion SessionStart hook (fix: bash .claude/orion/orion.sh repair)" ;;
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

    # 8. the declared branches: config.json names them, GitHub's default branch and this checkout's origin/HEAD follow
    verify_branches "$cfg"

    say "verify: $VERIFY_FAIL fail, $VERIFY_WARN warn"
    [ "$VERIFY_FAIL" -eq 0 ]
}

main() {
    local cmd="${1:-help}"; shift || true
    case "$cmd" in
        init) cmd_init "$@" ;;
        update) cmd_update "$@" ;;
        repair) cmd_repair "$@" ;;
        # the hook contract: whatever goes wrong inside, the session start sees exit 0
        check) set +e; ( set -e; cmd_check "$@" ); exit 0 ;;
        verify) cmd_verify "$@" ;;
        branches) cmd_branches "$@" ;;
        status) cmd_status "$@" ;;
        uninstall) cmd_uninstall "$@" ;;
        statusline) cmd_statusline "$@" ;;
        mod) cmd_mod "$@" ;;
        help|-h|--help) usage ;;
        *) die "unknown command: $cmd (try: orion.sh help)" ;;
    esac
}

main "$@"
