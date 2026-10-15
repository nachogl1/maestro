# Work Journal — live QA of the happy paths (2026-10-15)

Scope: the most important happy paths of the Work Journal feature (PRD: `docs/PRDs/PRDWorkJournal.md`),
exercised in a running dev build of Maestro, not in unit tests. Base: `main` at 251b6d6.

How it was run: an orchestrator planned eight cases; one fresh tester agent per case started its own
devtest copy of Maestro (identifier `com.maestro.app.wjqa`, own journal folder through
`MAESTRO_WORK_JOURNAL_DIR`, a throwaway git repo with three dated commits) and drove it over the
Chrome DevTools Protocol with real clicks and typing. Every expected line was checked against a
screenshot, the DOM or the journal files. A failure went to a fix agent, then to a fresh review agent,
then back to a fresh tester on the fixed build. The installed Maestro was never touched.

## Summary

| Case | Result | Notes |
|---|---|---|
| T1 First run, day pages, delete, restart | PASS | one plan expectation corrected (arrows, see Decisions) |
| T2 Rich editing persists | PASS | bold, colour, highlight, checklist, title survive a restart |
| T3 Pop-out window in sync with the pane | PASS | both directions, day list follows |
| T4 Suggestions from git: run, tags, accept, reject, badge | FAIL → FIXED → PASS | F1 below |
| T5 Backup now, restore, undo | PASS | one backup file, safety copies, one-shot undo |
| T6 Supervisor report to the chosen folder | PASS | self-contained HTML, overwritten per range |
| T7 Settings persist across a restart | FAIL (step 4) → FIXED → PASS | F2 below |
| T8 Granola opt-in prompt | PASS | meeting-line format not exercised (no meeting in the window) |

Two bugs found, both fixed in this PR, both re-verified live:

### F1 — A fresh journal never suggested the morning's work
- **Seen:** on a journal that had never run suggestions, the automatic first run and "run now" produced
  nothing although the open repo had two commits made that day. Rows only appeared after the last-run
  time was back-dated by hand.
- **Cause:** with no `last_run_at`, the run window started one run interval back (default one hour),
  so anything earlier that day was outside it (`src-tauri/src/core/work_journal_run.rs`, `uncapped_start`).
- **Fix (9d5ad04):** a never-run journal covers everything since local midnight of today (still capped
  at the 7-day catch-up limit). An unreadable or future last-run time keeps the one-interval fallback;
  later runs still continue from where the previous one ended. Tests cover UTC+2, UTC-5, UTC and a
  clock-change day.
- **Re-test (T4c):** the automatic catch-up listed both of today's commits as `Git` rows 27 s after
  launch; accept wrote `11:40 - Fixed the CSV export truncating long names` to the page; reject marked
  the other candidate rejected; the badge went 2 → 1 → gone.

### F2 — "Open Settings" did not land on the Work Journal section
- **Seen:** the pane's "No backup folder yet … Open Settings" button opened Settings scrolled to the
  top; the Work Journal section sat out of view.
- **Cause:** `MaestroSettingsModal` scrolled the section into view once, on mount; rows above it
  (version, update settings, Samurai thresholds) load a moment later and pushed it back down.
- **Fix (4f28607):** for 1.5 s after opening with a focus section, the modal re-scrolls to the section
  whenever content above it changes size, and stops as soon as the user scrolls, clicks, touches or
  presses a key. No observer is set up when Settings opens normally.
- **Re-test (T7b):** the scroll box opened at its maximum (193/193) with the Work Journal heading and
  its backup rows visible.

## Decisions made during the run (for the user to confirm or reverse)

1. **First-run window = since local midnight today.** The PRD only said "since the last run"; this
   fills the gap for a first install. Side effect noted by the reviewer: a restore or undo clears
   `last_run_at`, so the next run also starts at midnight and may re-suggest a line that was accepted
   earlier that day but is missing from the restored page (the duplicate check only sees the current
   page and today's pending/rejected candidates).
2. **Previous/Next arrows move between existing pages, not calendar days.** Found in T1: on a fresh
   journal both arrows are disabled; the empty-day "create" state is reached through "Jump to date".
   This is how the store was written and documented; the PRD only says "previous and next day arrows".
   Left as is; the QA plan's expectation was corrected.

## Observations (not bugs, not changed)

- The fresh-start catch-up runs before the user can answer the Granola question, so that first run
  is always Granola-off; the first Granola-on run only looks back a few hours for meetings.
- Restore and undo clear `last_backup_at` and `last_run_at` by design ("Never backed up",
  "Last run: never" afterwards).
- "next run" counts from the moment a run started, not when it finished (seconds of difference).
- A non-existent backup folder gives a native "Work Journal backup failed" warning plus a red line in
  Settings; the pane reminder is hidden as soon as any non-empty folder is set, even a bad one.
- A repo whose newest commit carries an older committer date than the commits beneath it loses
  in-window commits (git stops walking at the first too-old commit). Rare in real repos; it is what
  blocked the first T4 re-test until the throwaway repo was rebuilt in date order.
- The pop-out window can only be closed from its title bar (its capability grants `allow-destroy`
  only); the "Saved to …" path keeps the folder exactly as chosen (slash style included).
- Every backend log line is printed twice in the dev build (logger setup, outside this feature).

## What was NOT covered

- Native dialogs (folder pickers, delete/restore confirms) cannot be driven over CDP: the folder was set
  through the store action and the delete/restore were started through the store; the "Yes" path of
  the delete confirm was not exercised (the undo confirm was answered through the OS and worked).
- Midnight rollover while running, the daily automatic backup timer, Claude-conversation and
  terminal-session sources, and a Granola meeting line on the page.
- Unit, lint and clippy suites were green before and after both fixes.

## Evidence

Screenshots, per-case journal folders, logs and the harness live in
`C:\Users\ig118337\AppData\Local\Temp\wjqa\` (`shots\T<n>-*.png`, `data-T<n>\`, `logs\`,
`harness\`, `QA-PLAN.md`, `RESULTS.md`).
