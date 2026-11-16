# The in-flight file — one per machine, shared by every terminal

Every `/dev-next` terminal on this machine counts its own agents and serialises its own merges. Without this file, none
of them can see the others, and two terminals can squash-merge to `main` in the same second. This file is the only
thing that makes the merge queue **machine-wide**, and the only place a terminal can see what the others hold. Read it
before starting an issue, before merging, and write to it at every transition below.

## Where and what

`<wt root>/in-flight.json` — by default `C:\wt\in-flight.json` on Windows, `~/wt/in-flight.json` elsewhere. Beside the
worktrees, outside every checkout, never committed.

```json
{
  "issues": [
    { "issue": 41, "run": "<repo>-20250106-101500-3f2a", "startedAt": "2025-01-06T10:15:00Z",
      "terminal": "<terminal name>", "step": "phase 4 · review round 1",
      "agents": [ { "name": "dev-41", "status": "done" }, { "name": "review-41-r1", "status": "running" } ] },
    { "issue": null, "run": "<repo>-20250106-101502-7c4d", "startedAt": "2025-01-06T10:15:02Z",
      "step": "phase 1 · picking an issue" }
  ],
  "merging": { "issue": 43, "run": "<repo>-20250106-093000-9b1c", "since": "2025-01-06T11:02:00Z" }
}
```

- `issues` — one entry per issue that some terminal is developing right now, plus one **issue-less entry**
  (`"issue": null`) per run that has started but not yet claimed (*Run entries* below). `terminal`, `step` and
  `agents` are optional (*Progress fields* below); the second entry above has no `terminal` because its name could not
  be found.
- `merging` — the one issue currently between phase 5 step 1 (merge `origin/main` in) and step 4 (squash-merge landed),
  or `null`.

**Every read tolerates a missing, empty or malformed file** — treat it as `{ "issues": [], "merging": null }` and
rewrite it whole. Always write the whole file; never append. **Keep every field you did not change, in every entry**,
your own and other terminals', including fields you do not know: a newer or older run may write fields this file does
not list, and a reader that does not know a field ignores it.

**Several machines, several files.** Each machine has its own file, so the queue below is per machine. Merges from two
machines in the same minute are ordered by GitHub alone (the second one lands on a `main` its CI did not see). Accepted
for a small team; the day it bites, move the file to a shared location and record the path in the project's `CLAUDE.md`.

## Progress fields

Each run's entries say which terminal runs them and how far each one is, so the other terminals and the Control Tower pane (the
optional mod that reads this file) can show it. All three are optional; a reader that does not know them ignores them.

| Field | Shape | What it holds |
|---|---|---|
| `terminal` | string | This terminal's name: the name this session goes by in the agent list (its own entry in ListAgents, where that tool exists). **No name found → leave the field out**, never write a guess or an empty string: the pane then keeps saying "not reported yet". Found once per run and written into each of its entries. |
| `step` | string | What the run does now for this issue, a few plain words led by the phase: `phase 1 · picking an issue`, `phase 3 · building`, `phase 4 · review round 2`, `phase 5 · waiting for CI`, `phase 5 · merging`. |
| `agents` | list of `{ "name": string, "status": string }` | Every sub-agent this run spawned for this issue, in spawn order: `name` is its name from `SKILL.md` *Roles* (`dev-<N>`, `review-<N>-r<round>`, `ready-check-<N>`), `status` is `running` (spawned, or resumed with SendMessage), `done` (it reported) or `failed` (it reported `FAILED` or `INHERITED RED`, or its spawn failed for good). No other keys. |

**When:** at every phase change (`step`), and every spawn, resume and report (`agents`, and `step` when it moves on).
A sub-agent that is resumed keeps its one item and goes back to `running`; a replacement spawn of the same name does
the same. An issue-less entry carries `terminal` and `step` only. These writes follow *Read-modify-write* below and
never touch `startedAt`: an entry still goes stale 4 hours after it started.

## Run entries

A run writes its own issue-less entry in phase 0 step 9, **before ranking**: write, wait 5 s, re-read. Sibling
terminals started together then see each other before any has claimed, and the phase 1 stagger counts every other run
that started in the last 5 minutes and before this one, issue-less entries included. Counting only claimed entries lets
siblings rank the same top candidate. The first claim fills the issue number into the run's entry; a further claim adds
an entry of its own. A run that ends without claiming anything drops its issue-less entry.

## Stale entries

An `issues` entry whose `startedAt` is **older than 4 hours** belongs to a crashed terminal — an issue-less one too. Ignore it when counting and
drop it on the next write. A `merging` slot whose `since` is **older than 30 minutes** is stale the same way — but a
live holder **refreshes `since` on every poll** while it waits for CI (see below), so a live merge is never stale however
long CI queues. Never drop an entry younger than that: it is someone's live run.

## No cap

**There is no limit on how many issues are in flight on the machine.** The `issues` list exists so terminals can see
each other and so the merge queue below has a picture of what is coming; it never turns a claim away and a terminal
**never waits** on its length. In phase 1 a terminal reads the file, claims its issue (phase 1 steps 1-3), then fills in its
entry and writes the file.

There is no per-terminal agent cap either: every issue a session picks runs at once. Nothing caps how many runs start
but the one-at-a-time merge queue; what each run's tests take of the machine is sized by *Test copies* below.

## Test copies

Runs sharing one computer each size their own test load (the baseline's *Test copies* rule), so neither one waits long
nor do they clash. **This is the one place the recipe is written**; every local run of the full suite follows it: the
dev agent's gate (`dev-agent.md`), the reviewer's run when it runs the suite itself (`review-agent.md`) and the
orchestrator's run on the merged branch (`merge-and-ci.md` step 3). Work it out fresh, right before each run, never
once per session:

1. `cores` = the computer's physical cores, not its logical ones.
2. `runs` = the live entries in this file's `issues` list: issue-less ones included, stale ones (*Stale entries* above)
   left out, and never fewer than 1, since your own run is one of them.
3. copies = the smaller of `cores ÷ runs` and `cores ÷ 2`, rounded down, and at least 1.
4. Less than 2 GB of memory free → copies = 1, whatever step 3 says.

| Computer | `cores` | `runs` | Free memory | Copies |
|---|---|---|---|---|
| A laptop testing alone | 4 | 1 | plenty | 2 (the half-the-cores ceiling) |
| The same laptop, two runs | 4 | 2 | plenty | 2 each |
| The same laptop, four runs | 4 | 4 | plenty | 1 each |
| Any computer with memory almost full | any | any | under 2 GB | 1 each |
| A desktop, two runs | 16 | 2 | plenty | 8 each |

**Passing the count.** The project's `CLAUDE.md` has a *Test copies* row in its commands table: how the full suite
takes `<copies>` (a flag such as `-n <copies>`, or a whole command or variable that holds it). Run the full suite with
that `<copies>` replaced by the number. A row reading `none` or `TBD`, or no row at all, changes nothing: the suite runs
exactly as listed. Say the copies and how they were worked out (`cores`, `runs`, free memory) in the evidence table.

**Reading the computer** — portable bash; Windows means Git Bash:

```bash
case "$(uname -s)" in
  Linux)  cores=$(lscpu -p=Core,Socket | grep -v '^#' | sort -u | wc -l)
          free_mb=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo) ;;
  Darwin) cores=$(sysctl -n hw.physicalcpu)
          free_mb=$(vm_stat | awk '/page size of/ {ps=$8} /^Pages free:/ {f=$3} /^Pages inactive:/ {i=$3}
                                   /^Pages speculative:/ {s=$3} END {print int((f+i+s)*ps/1048576)}') ;;
  MINGW*|MSYS*|CYGWIN*)
          cores=$(powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum" | tr -d '\r')
          free_mb=$(powershell -NoProfile -Command "[int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)" | tr -d '\r') ;;
esac
# runs: the live entries of the in-flight file. Windows often has a python3 that is only a store alias, so test it
python3 -c 'import json' >/dev/null 2>&1 && PY=python3 || PY=python
runs=$("$PY" - "<wt root>/in-flight.json" <<'PY'
import json, sys, datetime as dt
try: issues = json.load(open(sys.argv[1], encoding="utf-8-sig")).get("issues") or []
except Exception: issues = []
now = dt.datetime.now(dt.timezone.utc)
def live(e):
    try: return now - dt.datetime.fromisoformat(e["startedAt"].replace("Z", "+00:00")) < dt.timedelta(hours=4)
    except Exception: return False
print(max(1, sum(1 for e in issues if isinstance(e, dict) and live(e))))
PY
)
# a reading that printed no number: half the logical cores, one run, and memory counted as not free
case "$cores" in ''|*[!0-9]*|0) cores=$(( $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2) / 2 )) ;; esac
case "$runs" in ''|*[!0-9]*|0) runs=1 ;; esac
case "$free_mb" in ''|*[!0-9]*) free_mb=0 ;; esac
copies=$(( cores / runs )); [ $(( cores / 2 )) -lt "$copies" ] && copies=$(( cores / 2 ))
[ "$copies" -lt 1 ] && copies=1
[ "$free_mb" -lt 2048 ] && copies=1
```

A reading that fails or prints no number (a minimal container without `lscpu`, a missing Python, say) never stops
the run: `cores` falls back to half the logical cores from `getconf _NPROCESSORS_ONLN`, `runs` to 1, and free memory
to none, so copies = 1. Inside a virtual machine or WSL the readings are what that machine is given, not the host's.

## The merge slot

Before `merge-and-ci.md` step 1 for an issue:

1. Read the file. `merging` non-null with a **fresh** `since` (under 30 minutes) → **wait**, re-read every 60 seconds,
   one line each time. There is no elapsed-time limit on this wait: the queue is bounded by the holder, not the waiter.
   A live holder refreshes `since` and its own CI poll is capped at 30 minutes (`merge-and-ci.md` step 2), so every
   holder either lands or releases within about 35 minutes, and a healthy queue of four moves on. A `since` older than
   30 minutes is a dead holder: treat the slot as free.
2. Free (or stale) → write your issue **and run id** into `merging`, **wait 5 seconds**, then **re-read the file**.
   `merging.run` is not your run id → another terminal wrote in the same window and **you lost the race**: back off and
   wait as in step 1. Only a read-back that shows your own run id means you hold the slot — for now.
3. **Ownership is re-checked, never assumed.** The 5-second settle is not atomic: a terminal that read "free" just
   before your write can overwrite you and read back *its* id. So, on **every `since` refresh** during the CI poll
   (`merge-and-ci.md` step 2), and **immediately before `gh pr merge`** in step 4, re-read and confirm `merging.run` is
   yours. Not yours → you lost it: do **not** merge, do not touch the slot, go back to step 1 and re-take it later;
   `merge-and-ci.md` step 1 then runs again on the new `main`.
4. While waiting for CI, **refresh `merging.since` to now on every poll** (at least every 5 minutes). This is what tells
   the other terminals you are alive. The holder's CI poll itself is capped at 30 minutes; past that the holder releases
   the slot as red (`merge-and-ci.md` step 2).
5. Immediately after step 4 (`gh pr merge` returned, merged or failed) → set `merging` to `null` and write. **Also on
   red, on "no checks reported", or on a conflict** handed back to `dev-N`: release the slot; the branch re-takes it
   when it is ready again.

Holding the slot from `merge-and-ci.md` step 1 through step 4 — and confirming, before the merge command, that you still
hold it — is what guarantees CI ran on the `main` that the branch actually lands on.

## Transitions — who writes when

| Moment | Write |
|---|---|
| Phase 0 preflight | Create the file if missing (`{ "issues": [], "merging": null }`). |
| Phase 0 step 9, before ranking | Add this run's issue-less entry (`"issue": null`, with `terminal` and `step`), wait 5 s, re-read. |
| Every phase change, and every spawn, resume or report of a sub-agent | Update `step` and `agents` in that issue's entry (*Progress fields*). |
| Phase 1, before the claim | Re-read it for the stagger and for visibility — never wait. |
| Phase 1, after the claim | Fill the issue into the issue-less entry (first claim) or add the issue entry. |
| Phase 1, zero eligible, or the run ends having claimed nothing | Remove the issue-less entry. |
| Phase 1, lost the claim race on the second re-read | Remove the issue entry; a run holding no other claim turns it back into its issue-less entry while it picks the next candidate. |
| Phase 3, dev reports `FAILED` or `INHERITED RED` → stopped, `agent-ready` kept | Remove the issue entry. |
| Phase 5, before step 1 | Take `merging` (write, wait 5 s, re-read, confirm your run id). |
| Phase 5, during step 2 | Refresh `merging.since` on every CI poll, re-confirming `merging.run` is yours each time; poll capped at 30 min. |
| Phase 5, just before `gh pr merge` | Re-read; `merging.run` not yours → do not merge, re-queue. |
| Phase 5, no checks reported → stopped | Release `merging` and remove the issue entry. |
| Phase 4, three review rounds → stopped | Remove the issue entry. |
| Phase 5, after step 4 or on red / conflict | Release `merging`. |
| Phase 5 step 5 clean-up | Remove the issue entry. |
| Phase 5, two red rounds → stopped | Release `merging` and remove the issue entry — step 5 is never reached on this path. |
| Phase 5, an `owner-merges` story green → stopped at its pull request | Remove the issue entry; `merging` was never taken. |
| Any stop (`SKILL.md`, the stop rule at the top), `needs-human` or not | Remove the issue entry, and release `merging` if held. The assignee stays on the issue. |

## Read-modify-write

Two terminals can write within the same second. Keep the window small: read, change, write in one step — never hold the
contents across a long command. For the `issues` list a lost write costs one missing entry in the visibility list until
its owner's next write. For `merging` a lost write would cost a bad merge, which is why step 2 above **re-reads after writing**, step 3
**re-checks on every refresh and right before the merge command**, and anything but your own run id means "not mine".
Never assume you hold the slot because your write did not error, and never assume you still hold it because you did a
minute ago.

**What the re-checks do and do not buy.** The file is a plain JSON file; nothing here is atomic. Two windows stay open:
the second or so between the pre-merge re-check and `gh pr merge` returning, and a whole-file write from a stale
snapshot (a phase 1 claim, say) that nulls a live `merging`. Neither produces a bad merge — in both cases the terminal
that lost detects "not mine" on its next re-check, does not merge or has already merged on a CI run of the correct
`main`, and re-queues — but both can cost one extra wait. That is the accepted residual: a race costs a wait, never a
merge onto a `main` CI did not see.
