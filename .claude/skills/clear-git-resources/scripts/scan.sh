#!/usr/bin/env bash
# scan.sh - the read-only half of /clear-git-resources.
#
# Lists the git resources of ONE project that look stale, says for each one whether it is the person's own,
# and the exact command that would delete it. It deletes nothing itself: the skill deletes the person's own
# safe items, asks about the rest of the stale ones, and never runs a command for a kept one.
#
# usage: bash scan.sh [--project <dir>] [--wt-root <dir>] [--fetch] [--days <n>] [--limit <n>] [--wt-limit <n>]
#   --project   any folder inside the project (main checkout or a worktree); default: the current folder
#   --wt-root   the worktree root the project's CLAUDE.md names; default: C:\wt on Windows, ~/wt elsewhere
#   --fetch     run `git fetch --prune origin` first, so remote branches deleted elsewhere drop out
#   --days      a folder or file in the worktree root is offered only when older than this (default 2)
#   --limit     the branch limit the session-start hook uses (default 20); only echoed in the COUNT line
#   --wt-limit  the worktree limit the session-start hook uses (default 20); only echoed in the COUNT line
#
# Output, one record per line, tab-separated:
#   SCAN    project=<main checkout> default=<branch> remote=<name|none> wt_root=<dir> fetched=yes|no pruned=<n> gh=yes|no
#   COUNT   local=<n> remote=<n> total=<n> limit=<n> worktrees=<n> wt_limit=<n> over=yes|no   (the counts the hook uses)
#   GROUP   <id>  <n>  stale|kept  <title>                                  (only groups that have items)
#   ITEM    <id>  <name>  auto|ask|keep  <why it is here>  <command that deletes it>   (command empty for keep)
#   NOTE    <something the person should know>
#   SUMMARY auto=<n> ask=<n> keep=<n>
# Whose it is: the person's own when the first commit on the branch that is not on the default branch (for a branch
#       merged with a merge commit, its tip) carries the email of their git identity (`git var GIT_AUTHOR_IDENT`).
#       A branch with no commits of its own is nobody's. A worktree on no branch lives on this computer only, so
#       it is the person's own.
# auto: stale, the person's own, and its work cannot be lost: every commit on the default branch, its pull request
#       merged at exactly this commit, a clean checkout on no branch whose commit a branch holds, a worktree entry
#       whose folder is gone, a loose file in the worktree root unchanged for --days days. Never a locked worktree.
# ask:  stale, but someone else's or nobody's; or the person's own with a pull request closed without merge, a
#       branch changed after its pull request merged, a deleted remote branch, a lock; or a folder in the worktree
#       root that is not a worktree (its repository may only have moved).
# keep: never offered, no command: unmerged commits with no pull request, commits on no branch, uncommitted changes,
#       the default branch, audit/* and qa/* branches, audit-* and qa-* worktrees and folders, open pull requests,
#       anything in flight, other repositories' checkouts, worktree-root entries with anything changed in the last
#       --days days.
#
# Portable bash: runs under Git Bash, macOS bash and Linux. No GNU-only flags.

set -uo pipefail

PROJECT_ARG="." WT_ROOT="" FETCH=0 DAYS=2 LIMIT=20 WT_LIMIT=20
while [ $# -gt 0 ]; do
    case "$1" in
        --project) PROJECT_ARG="$2"; shift 2 ;;
        --wt-root) WT_ROOT="$2"; shift 2 ;;
        --fetch) FETCH=1; shift ;;
        --days) DAYS="$2"; shift 2 ;;
        --limit) LIMIT="$2"; shift 2 ;;
        --wt-limit) WT_LIMIT="$2"; shift 2 ;;
        -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
        *) printf 'scan.sh: unknown option %s\n' "$1" >&2; exit 2 ;;
    esac
done

command -v git >/dev/null 2>&1 || { printf 'NOTE\tgit is not on the path; nothing can be scanned\n'; exit 1; }

# --- where we are ---------------------------------------------------------------------------------------
MAIN=$(cd "$PROJECT_ARG" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd -P)
[ -n "$MAIN" ] && [ -d "$MAIN/.git" ] || { printf 'NOTE\t%s is not inside a git repository\n' "$PROJECT_ARG"; exit 1; }
g() { git -C "$MAIN" "$@"; }

if [ -z "$WT_ROOT" ]; then
    case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) WT_ROOT="/c/wt" ;; *) WT_ROOT="$HOME/wt" ;; esac
fi

REMOTE=origin
g remote get-url "$REMOTE" >/dev/null 2>&1 || REMOTE=""

DEFAULT=""
[ -n "$REMOTE" ] && DEFAULT=$(g symbolic-ref -q --short "refs/remotes/$REMOTE/HEAD" 2>/dev/null | sed "s#^$REMOTE/##")
if [ -z "$DEFAULT" ]; then
    for c in main master; do
        if { [ -n "$REMOTE" ] && g show-ref --verify -q "refs/remotes/$REMOTE/$c" 2>/dev/null; } || g show-ref --verify -q "refs/heads/$c" 2>/dev/null; then DEFAULT=$c; break; fi
    done
fi
[ -n "$DEFAULT" ] || DEFAULT=$(g rev-parse --abbrev-ref HEAD 2>/dev/null)
BASE="refs/heads/$DEFAULT"
[ -n "$REMOTE" ] && g show-ref --verify -q "refs/remotes/$REMOTE/$DEFAULT" 2>/dev/null && BASE="refs/remotes/$REMOTE/$DEFAULT"

PRUNED=0 FETCHED=no
if [ "$FETCH" = "1" ] && [ -n "$REMOTE" ]; then
    PRUNED=$(g fetch --prune "$REMOTE" 2>&1 | grep -c '\[deleted\]' || true)
    FETCHED=yes
fi

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t clear-git); trap 'rm -rf "$TMP"' EXIT

# --- pull requests, one call ----------------------------------------------------------------------------
GH=no
if [ -n "$REMOTE" ] && command -v gh >/dev/null 2>&1; then
    if (cd "$MAIN" && gh pr list --state all --limit 500 --json headRefName,state,number,headRefOid \
            --jq '.[] | "\(.headRefName)\t\(.state)\t\(.number)\t\(.headRefOid)"' > "$TMP/prs" 2>/dev/null); then
        GH=yes
    fi
fi
pr_state() {  # branch -> "OPEN <n> <sha>" | "MERGED <n> <sha>" | "CLOSED <n> <sha>" | ""   (open wins, then merged)
    [ "$GH" = "yes" ] || return 0
    local rows; rows=$(awk -F'\t' -v b="$1" '$1==b {print $2, $3, $4}' "$TMP/prs")
    [ -n "$rows" ] || return 0
    printf '%s\n' "$rows" | grep -m1 '^OPEN'   && return 0
    printf '%s\n' "$rows" | grep -m1 '^MERGED' && return 0
    printf '%s\n' "$rows" | head -n1
}

# --- what is never offered ------------------------------------------------------------------------------
INFLIGHT=""
if [ -f "$WT_ROOT/in-flight.json" ]; then
    INFLIGHT=$(grep -oE '"issue"[[:space:]]*:[[:space:]]*[0-9]+' "$WT_ROOT/in-flight.json" 2>/dev/null | grep -oE '[0-9]+$' | sort -u | tr '\n' ' ')
fi
in_flight() {  # branch or folder name -> 0 when it belongs to an issue in flight (feat/<N>-..., <N>-...)
    local n; n=$(printf '%s' "$1" | sed -n 's#^\(feat/\)\{0,1\}\([0-9][0-9]*\)-.*#\2#p')
    [ -n "$n" ] && case " $INFLIGHT " in *" $n "*) return 0 ;; esac
    return 1
}
HEAD_BRANCH=$(g rev-parse --abbrev-ref HEAD 2>/dev/null)
protected_branch() {  # branch -> 0 when never offered
    case "$1" in "$DEFAULT"|audit/*|qa/*|HEAD) return 0 ;; esac
    [ "$1" = "$HEAD_BRANCH" ] && return 0
    in_flight "$1"
}
protected_folder() {  # worktree or folder path -> 0 for the audit worktree and a QA run's worktree (other skills use them)
    case "$(basename "$1")" in audit-*|qa-*) return 0 ;; esac
    return 1
}
merged() { g merge-base --is-ancestor "$1" "$BASE" 2>/dev/null; }
ahead()  { g rev-list --count "$BASE..$1" 2>/dev/null || echo '?'; }
when()   { g log -1 --format=%cs "$1" 2>/dev/null; }
norm()   { (cd "$1" 2>/dev/null && pwd -P); }
recent() { [ -n "$(find "$1" -mtime -"$DAYS" 2>/dev/null | head -n1)" ]; }   # path -> 0 when it or anything inside changed lately
reachable() { merged "$1" || [ -n "$(g for-each-ref --count=1 --contains "$1" 2>/dev/null)" ]; }   # commit -> 0 when a ref holds it
tip()    { g rev-parse -q --verify "$1^{commit}" 2>/dev/null; }

# --- whose it is ----------------------------------------------------------------------------------------
ME=$(g var GIT_AUTHOR_IDENT 2>/dev/null | sed -n 's/.*<\([^>]*\)>.*/\1/p' | tr 'A-Z' 'a-z')
# The default branch's own commits (its first-parent line): a merged branch whose tip is one of them has no commits
# of its own (a fresh start, or fast-forwarded), so nobody can be told to own it.
g rev-list --first-parent "$BASE" 2>/dev/null > "$TMP/first-parent"
owner() {  # ref -> mine | other
    local e t
    e=$(g log --reverse --format=%ae "$BASE..$1" 2>/dev/null | head -n1)
    if [ -z "$e" ]; then
        t=$(tip "$1")
        [ -n "$t" ] && ! grep -qxF "$t" "$TMP/first-parent" && e=$(g log -1 --format=%ae "$t" 2>/dev/null)
    fi
    e=$(printf '%s' "$e" | tr 'A-Z' 'a-z')
    if [ -n "$ME" ] && [ "$e" = "$ME" ]; then echo mine; else echo other; fi
}
act() {  # mine|other sure(1|0) -> auto (the person's own, nothing can be lost) | ask
    if [ "$1" = mine ] && [ "$2" = 1 ]; then echo auto; else echo ask; fi
}
whose() { [ "$1" = mine ] && echo yours || echo "someone else's"; }

item() {  # group name action why cmd
    printf 'ITEM\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >> "$TMP/g.$1"
}

# --- worktrees ------------------------------------------------------------------------------------------
: > "$TMP/wt-branches"; : > "$TMP/wt-paths"
wt_path="" wt_branch="" wt_head="" wt_detached=0 wt_locked=0 wt_prunable=0
flush_wt() {
    [ -n "$wt_path" ] || return 0
    local n="$wt_path" why="" dirty=0 a st pst pnum poid who sure rm_cmd br_cmd
    if [ "$(norm "$wt_path")" = "$(norm "$MAIN")" ]; then
        :  # the main checkout itself
    elif [ "$wt_prunable" = "1" ]; then
        if protected_folder "$wt_path" || { [ -n "$wt_branch" ] && protected_branch "$wt_branch"; }; then
            item wt-protected "$n" keep "an audit, QA or protected worktree entry whose folder is gone (never touched)" ""
        elif [ "$wt_detached" = "1" ] && ! { [ -n "$wt_head" ] && reachable "$wt_head"; }; then
            item wt-active "$n" keep "its folder is gone, but it was on no branch with commits no branch holds (removing it would lose them)" ""
        else
            item wt-prunable "$n" auto "registered as a worktree but its folder is gone" "git -C \"$MAIN\" worktree remove --force \"$wt_path\""
        fi
    else
        norm "$wt_path" >> "$TMP/wt-paths"
        [ -n "$wt_branch" ] && printf '%s\n' "$wt_branch" >> "$TMP/wt-branches"
        [ -d "$wt_path" ] && [ -n "$(git -C "$wt_path" status --porcelain 2>/dev/null | head -n1)" ] && dirty=1
        rm_cmd="git -C \"$MAIN\" worktree remove \"$wt_path\" && git -C \"$MAIN\" worktree prune"
        br_cmd=""; [ -n "$wt_branch" ] && br_cmd=" && git -C \"$MAIN\" branch -D \"$wt_branch\""
        [ "$wt_locked" = "1" ] && rm_cmd="git -C \"$MAIN\" worktree unlock \"$wt_path\" && $rm_cmd"
        if [ -n "$wt_branch" ] && in_flight "$wt_branch"; then
            item wt-protected "$n" keep "branch $wt_branch belongs to an issue in flight (in-flight.json)" ""
        elif [ -n "$wt_branch" ] && protected_branch "$wt_branch"; then
            case "$wt_branch" in
                audit/*) item wt-protected "$n" keep "branch $wt_branch is an audit branch: it holds the run reports the dev skill writes (never touched)" "" ;;
                qa/*) item wt-protected "$n" keep "branch $wt_branch is a QA branch another skill uses (never touched)" "" ;;
                *) item wt-protected "$n" keep "branch $wt_branch is the default branch (never touched)" "" ;;
            esac
        elif protected_folder "$wt_path"; then
            item wt-protected "$n" keep "an audit or QA run's worktree; another skill may be using it (never touched)" ""
        elif [ "$dirty" = "1" ]; then
            why="has uncommitted changes"; [ -n "$wt_branch" ] && why="branch $wt_branch, $why"
            [ "$wt_locked" = "1" ] && why="$why, locked"
            item wt-dirty "$n" keep "$why" ""
        elif [ "$wt_detached" = "1" ]; then
            if [ -n "$wt_head" ] && reachable "$wt_head"; then
                item wt-detached "$n" "$(act mine $((1 - wt_locked)))" "on no branch (a temporary checkout), clean$([ "$wt_locked" = "1" ] && echo ', locked')" "$rm_cmd"
            else
                item wt-active "$n" keep "on no branch, with commits no branch holds (deleting would lose them)" ""
            fi
        else
            st=$(pr_state "$wt_branch"); read -r pst pnum poid <<< "$st"
            who=$(owner "refs/heads/$wt_branch")
            if [ "$pst" = "OPEN" ]; then
                item wt-open-pr "$n" keep "branch $wt_branch has an open pull request #$pnum" ""
            elif merged "$wt_branch"; then
                why="branch $wt_branch is already on $DEFAULT, $(whose "$who")"; [ "$wt_locked" = "1" ] && why="$why, locked"
                item wt-done "$n" "$(act "$who" $((1 - wt_locked)))" "$why" "$rm_cmd$br_cmd"
            elif [ "$pst" = "MERGED" ] && [ "$(tip "refs/heads/$wt_branch")" = "$poid" ]; then
                why="branch $wt_branch: pull request #$pnum merged, $(whose "$who")"; [ "$wt_locked" = "1" ] && why="$why, locked"
                item wt-done "$n" "$(act "$who" $((1 - wt_locked)))" "$why" "$rm_cmd$br_cmd"
            elif [ "$pst" = "MERGED" ] || [ "$pst" = "CLOSED" ]; then
                why="branch $wt_branch: pull request #$pnum closed without merge"
                [ "$pst" = "MERGED" ] && why="branch $wt_branch changed after pull request #$pnum merged"
                why="$why, $(whose "$who"), last change $(when "$wt_branch")"; [ "$wt_locked" = "1" ] && why="$why, locked"
                item wt-pr-closed "$n" ask "$why" "$rm_cmd$br_cmd"
            else
                a=$(ahead "$wt_branch"); why="branch $wt_branch has $a commit(s) not on $DEFAULT and no pull request, last change $(when "$wt_branch")"
                [ "$wt_locked" = "1" ] && why="$why, locked"
                item wt-active "$n" keep "$why" ""
            fi
        fi
    fi
    wt_path="" wt_branch="" wt_head="" wt_detached=0 wt_locked=0 wt_prunable=0
}
g worktree list --porcelain 2>/dev/null > "$TMP/worktrees"
while IFS= read -r line; do
    case "$line" in
        "worktree "*) flush_wt; wt_path="${line#worktree }" ;;
        "HEAD "*) wt_head="${line#HEAD }" ;;
        "branch refs/heads/"*) wt_branch="${line#branch refs/heads/}" ;;
        detached) wt_detached=1 ;;
        locked*) wt_locked=1 ;;
        prunable*) wt_prunable=1 ;;
    esac
done < "$TMP/worktrees"
flush_wt

checked_out() { grep -qxF "$1" "$TMP/wt-branches" 2>/dev/null; }

# --- local branches -------------------------------------------------------------------------------------
# Fields are split on \001, not tab: tab is IFS whitespace, so an empty field (no upstream) would collapse.
g for-each-ref refs/heads --format='%(refname:short)%01%(upstream:short)%01%(upstream:track)%01%(committerdate:short)' 2>/dev/null > "$TMP/heads"
while IFS=$'\001' read -r b up track date; do
    [ -n "$b" ] || continue
    local_cmd="git -C \"$MAIN\" branch -D \"$b\""
    if protected_branch "$b"; then
        case "$b" in "$DEFAULT"|audit/*|qa/*) continue ;; esac   # never listed, never offered
        if in_flight "$b"; then item br-protected "$b" keep "belongs to an issue in flight (in-flight.json)" ""
        elif [ "$b" = "$HEAD_BRANCH" ]; then item br-protected "$b" keep "checked out in the main checkout" ""; fi
        continue
    fi
    checked_out "$b" && continue   # listed with its worktree above
    st=$(pr_state "$b"); read -r pst pnum poid <<< "$st"
    who=$(owner "refs/heads/$b")
    if [ "$pst" = "OPEN" ]; then item br-open-pr "$b" keep "open pull request #$pnum" ""
    elif merged "$b"; then item br-merged "$b" "$(act "$who" 1)" "every commit is on $DEFAULT, $(whose "$who") (last change $date)" "$local_cmd"
    elif [ "$pst" = "MERGED" ] && [ "$(tip "refs/heads/$b")" = "$poid" ]; then
        item br-pr-closed "$b" "$(act "$who" 1)" "pull request #$pnum merged, $(whose "$who") (last change $date)" "$local_cmd"
    elif [ "$pst" = "MERGED" ]; then item br-pr-closed "$b" ask "changed after pull request #$pnum merged, $(whose "$who") (last change $date)" "$local_cmd"
    elif [ "$track" = "[gone]" ]; then item br-gone "$b" ask "its remote branch $up was deleted, $(whose "$who") (last change $date)" "$local_cmd"
    elif [ "$pst" = "CLOSED" ]; then item br-pr-closed "$b" ask "pull request #$pnum closed without merge, $(whose "$who") (last change $date)" "$local_cmd"
    else
        why="$(ahead "$b") commit(s) not on $DEFAULT and no pull request, last change $date"; [ -z "$up" ] && why="$why, never pushed"
        item br-unmerged "$b" keep "$why" ""
    fi
done < "$TMP/heads"

# --- remote branches ------------------------------------------------------------------------------------
if [ -n "$REMOTE" ]; then
    g for-each-ref "refs/remotes/$REMOTE" --format='%(refname)%01%(committerdate:short)%01%(authorname)' 2>/dev/null > "$TMP/remotes"
    while IFS=$'\001' read -r ref date author; do
        [ -n "$ref" ] || continue
        rb="${ref#refs/remotes/}"           # origin/<branch>; refname:short would print origin/HEAD as plain origin
        [ "$rb" = "$REMOTE/HEAD" ] && continue
        b="${rb#$REMOTE/}"
        case "$b" in "$DEFAULT"|audit/*|qa/*) continue ;; esac
        remote_cmd="git -C \"$MAIN\" push \"$REMOTE\" --delete \"$b\""
        if in_flight "$b"; then item rb-protected "$rb" keep "belongs to an issue in flight (in-flight.json)" ""; continue; fi
        st=$(pr_state "$b"); read -r pst pnum poid <<< "$st"
        who=$(owner "$ref")
        if [ "$pst" = "OPEN" ]; then item rb-open-pr "$rb" keep "open pull request #$pnum" ""
        elif merged "$ref"; then item rb-merged "$rb" "$(act "$who" 1)" "every commit is on $DEFAULT, $(whose "$who") (last change $date by $author)" "$remote_cmd"
        elif [ "$pst" = "MERGED" ] && [ "$(tip "$ref")" = "$poid" ]; then
            item rb-pr-closed "$rb" "$(act "$who" 1)" "pull request #$pnum merged, $(whose "$who") (last change $date by $author)" "$remote_cmd"
        elif [ "$pst" = "MERGED" ]; then item rb-pr-closed "$rb" ask "changed after pull request #$pnum merged, $(whose "$who") (last change $date by $author)" "$remote_cmd"
        elif [ "$pst" = "CLOSED" ]; then item rb-pr-closed "$rb" ask "pull request #$pnum closed without merge, $(whose "$who") (last change $date by $author)" "$remote_cmd"
        else item rb-unmerged "$rb" keep "$(ahead "$ref") commit(s) not on $DEFAULT, no pull request known, last change $date by $author" ""
        fi
    done < "$TMP/remotes"
fi

# --- the worktree root ----------------------------------------------------------------------------------
if [ -d "$WT_ROOT" ]; then
    for p in "$WT_ROOT"/* "$WT_ROOT"/.[!.]*; do
        [ -e "$p" ] || continue
        n=$(basename "$p")
        [ "$n" = "in-flight.json" ] && continue
        old=1; recent "$p" && old=0
        if [ -d "$p" ]; then
            grep -qxF "$(norm "$p")" "$TMP/wt-paths" 2>/dev/null && continue   # one of ours, listed above
            if [ -f "$p/.git" ]; then
                gitdir=$(sed -n 's/^gitdir: //p' "$p/.git" 2>/dev/null | head -n1)
                case "$gitdir" in /*|[A-Za-z]:*) ;; *) gitdir="$p/$gitdir" ;; esac
                if [ -d "$gitdir" ]; then item root-other "$p" keep "a worktree of another repository" ""
                elif protected_folder "$p"; then item root-other "$p" keep "an audit or QA run's folder another skill may use (never touched)" ""
                elif [ "$old" = "1" ]; then item root-orphan "$p" ask "was a worktree, but the repository it belonged to no longer knows it (its repository may only have moved)" "rm -rf \"$p\""
                else item root-recent "$p" keep "was a worktree, changed in the last $DAYS days" ""; fi
            elif [ -d "$p/.git" ]; then item root-other "$p" keep "a full clone of a repository" ""
            elif in_flight "$n"; then item root-other "$p" keep "folder of an issue in flight (in-flight.json)" ""
            elif protected_folder "$p"; then item root-other "$p" keep "an audit or QA run's folder another skill may use (never touched)" ""
            elif [ "$old" = "1" ]; then item root-orphan "$p" ask "a plain folder, not a worktree, nothing in it changed for $DAYS days" "rm -rf \"$p\""
            else item root-recent "$p" keep "a plain folder changed in the last $DAYS days" ""; fi
        else
            if [ "$old" = "1" ]; then item root-file "$p" auto "a loose file older than $DAYS days" "rm -f \"$p\""
            else item root-recent "$p" keep "a loose file changed in the last $DAYS days" ""; fi
        fi
    done
else
    printf 'NOTE\tworktree root %s does not exist; nothing to check there\n' "$WT_ROOT"
fi

# --- print -----------------------------------------------------------------------------------------------
# The totals are the exact expressions of branch_count and worktree_count in orion.sh (the session-start hook):
# local branches plus the remote-tracking branches of every remote, HEAD excluded; every worktree but the main
# checkout. Change both together.
TOTAL=$(g for-each-ref --format='%(refname)' refs/heads refs/remotes 2>/dev/null | grep -vc '/HEAD$' || true)
LOCAL_N=$(g for-each-ref --format='%(refname)' refs/heads 2>/dev/null | grep -vc '/HEAD$' || true)
REMOTE_N=$(g for-each-ref --format='%(refname)' refs/remotes 2>/dev/null | grep -vc '/HEAD$' || true)
WT_N=$(g worktree list --porcelain 2>/dev/null | grep -c '^worktree ' || true)
[ "${WT_N:-0}" -gt 0 ] && WT_N=$((WT_N-1))
OVER=no
{ [ "$TOTAL" -ge "$LIMIT" ] || [ "${WT_N:-0}" -ge "$WT_LIMIT" ]; } 2>/dev/null && OVER=yes
printf 'SCAN\tproject=%s default=%s remote=%s wt_root=%s fetched=%s pruned=%s gh=%s\n' "$MAIN" "$DEFAULT" "${REMOTE:-none}" "$WT_ROOT" "$FETCHED" "$PRUNED" "$GH"
printf 'COUNT\tlocal=%s remote=%s total=%s limit=%s worktrees=%s wt_limit=%s over=%s\n' "$LOCAL_N" "$REMOTE_N" "$TOTAL" "$LIMIT" "${WT_N:-0}" "$WT_LIMIT" "$OVER"
[ "$GH" = "yes" ] || printf 'NOTE\tgh is missing or not signed in: pull request states are unknown, so a squash-merged branch is only recognised when its remote branch was deleted, and then it is asked about\n'
[ -n "$ME" ] || printf 'NOTE\tno git identity (git config user.email) is set: nothing counts as yours, so every stale item is asked about\n'
[ -z "$REMOTE" ] && printf 'NOTE\tno remote named origin: remote branches were not checked\n'
[ -n "$INFLIGHT" ] && printf 'NOTE\tissues in flight (never offered): %s\n' "$INFLIGHT"

AU=0 AS=0 K=0
emit() {  # id stale|kept title
    local f="$TMP/g.$1" n
    [ -s "$f" ] || return 0
    n=$(wc -l < "$f" | tr -d ' ')
    AU=$((AU + $(awk -F'\t' '$4=="auto"' "$f" | wc -l)))
    AS=$((AS + $(awk -F'\t' '$4=="ask"' "$f" | wc -l)))
    K=$((K + $(awk -F'\t' '$4=="keep"' "$f" | wc -l)))
    printf 'GROUP\t%s\t%s\t%s\t%s\n' "$1" "$n" "$2" "$3"
    cat "$f"
}
emit wt-prunable  stale "Worktree entries whose folder is already gone"
emit wt-done      stale "Worktrees whose branch is already on $DEFAULT"
emit wt-detached  stale "Temporary worktrees on no branch"
emit wt-pr-closed stale "Worktrees whose pull request closed without merge, or that changed after it merged"
emit br-merged    stale "Local branches already on $DEFAULT"
emit br-pr-closed stale "Local branches whose pull request is merged or closed"
emit br-gone      stale "Local branches whose remote branch was deleted"
emit rb-merged    stale "Remote branches already on $DEFAULT"
emit rb-pr-closed stale "Remote branches whose pull request is merged or closed"
emit root-orphan  stale "Folders in the worktree root that are not worktrees"
emit root-file    stale "Loose files in the worktree root"
emit wt-active    kept  "Worktrees with work that is not on $DEFAULT and no pull request (kept)"
emit wt-dirty     kept  "Worktrees with uncommitted changes (kept)"
emit br-unmerged  kept  "Local branches with commits not on $DEFAULT and no pull request (kept)"
emit rb-unmerged  kept  "Remote branches with commits not on $DEFAULT and no pull request (kept)"
emit wt-open-pr   kept  "Worktrees with an open pull request (kept)"
emit br-open-pr   kept  "Local branches with an open pull request (kept)"
emit rb-open-pr   kept  "Remote branches with an open pull request (kept)"
emit wt-protected kept  "Worktrees of audit or QA runs, protected branches or issues in flight (kept)"
emit br-protected kept  "Local branches checked out or in flight (kept)"
emit rb-protected kept  "Remote branches of issues in flight (kept)"
emit root-recent  kept  "Recent folders and files in the worktree root (kept)"
emit root-other   kept  "Other repositories' checkouts and other skills' folders in the worktree root (kept)"
printf 'SUMMARY\tauto=%s ask=%s keep=%s\n' "$AU" "$AS" "$K"
