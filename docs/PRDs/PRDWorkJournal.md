# PRD: Work Journal

Date: 2026-10-14 · Decision map: [Wayfinder map: Work Journal](https://github.com/nachogl1/maestro/issues/286)

Every requirement below comes from a closed ticket on that map, a later user
correction on a ticket, or the map itself. Details first written as "derived"
were all confirmed by the user on 2026-10-14 in the agent-ready pass (see
"Splitting into agent-ready issues"), so this PRD holds no open decision. The
user's corrections made while reviewing this PRD (fonts dropped, temporary
file, source tags) and the agent-ready pass (schedule, badge, report HTML,
Granola time) are folded in and linked in the Decision trace.

## Glossary

- **Work Journal:** the feature in this PRD. One journal per user, across all
  projects. Always called "Work Journal" in the UI and in code.
- **Samurai Journal (not this feature):** Maestro already has a "Journal" in
  Second Brain. It holds operational notes written by Samurai agents
  (bottlenecks, errors, concerns) for harvest triage. It lives in
  `<app data>/journal/journal.jsonl`. The two must never be mixed, in UI or
  code.
- **Page:** the journal entry for one calendar date. A date has at most one
  page.
- **Candidate:** a one-line entry Claude proposes for a page. The user accepts
  or rejects it.
- **Candidate run:** the background Claude run that produces candidates.
- **Connector:** an optional outside data source for candidates. In v1 there is
  exactly one: Granola (a meeting-notes app), on its free tier.
- **Supervisor report:** an AI-written HTML summary of a date range, meant to
  be shared upward.

## Problem

1. Maestro has no place where a user records what they did each day. Notes are
   per project and free-form; nothing is organised by date.
2. Maestro already holds signals about the user's work (Claude conversations,
   git and GitHub activity, terminals), but no feature turns them into a
   journal. Users rebuild their day from memory.
3. Sharing progress with a supervisor means writing a summary by hand.

## Goals

- A Work Journal icon in the right-side pane opens a journal with one page per
  day, created automatically.
- Rich editing of each page: per-selection text colour and highlight, plus the
  basics and checklists.
- Claude proposes candidate entries from the user's Maestro activity, on a
  schedule, and the user accepts or rejects each one.
- Granola meeting notes (free tier) can feed candidates when the user has
  connected Granola and opted in.
- The journal is one local JSON file with a daily overwrite-in-place backup and
  a safe restore.
- An achievement-focused HTML report for a chosen date range, saved to a folder
  of the user's choice.
- Everything works with no connector, and costs the user nothing beyond their
  existing Claude plan.

## Non-goals

- **Learning from journal history and past accept/reject choices, and
  next-work suggestions.** Dropped by the user. Candidates come only from
  activity, never from past pages or past verdicts. There is no learning
  memory, style profile or verdict log.
- **Calendar connector (Outlook and Google).** Dropped from v1 as too hard to
  build and maintain. The research on free access paths stays on its ticket as
  a starting point if this is ever reconsidered.
- **Granola transcripts (paid tier).** Only the free tier is in v1: notes from
  the last 30 days, no transcripts, no folder or search tools. The paid public
  API is not used.
- Tables and images in pages.
- **Font changes.** Dropped by the user while reviewing this PRD ("I don't
  need to modify fonts"): no font-family picker, no font-size picker, no
  journal-wide default font setting, no curated font list.
- Edit-before-accept on a candidate. Accepted lines are ordinary page text and
  can be edited in the page afterwards.
- A preview or edit step for the supervisor report.
- Using the OS scheduler (cron, Task Scheduler) for backups or candidate runs.
- Reusing the Notes markdown editor or the Notes LazyStore storage.
- Reading Granola's local cache files or reusing its desktop login token.
- Per-project journals. The journal is global.

## Behaviour

### Day pages

- **One page per date.** The date is the unique key. There is at most one page
  per date.
- **Auto-create on start.** On start, Maestro creates a page for every day
  missing since the last auto-created day, up to today, weekends included.
  Missed weekdays stay empty for the user or candidates to fill.
- **Delete is final.** A deleted page never comes back on its own. Maestro keeps
  a list of deleted dates for this (see the exception below). The user can
  create that date again by hand.
- **Weekends.** Saturday and Sunday each get their own page. The title is the
  date, like any other day. The body is pre-filled with "Weekend"; the user
  overwrites it if they worked.
- **Title.** Defaults to `Wed 14 Oct 2026` (short weekday, day, short month,
  year). The user can edit it freely. The page list sorts by the stored date,
  not by the title.
- **Manual pages.** The user can create a page for any date, past or future,
  that has no page.
- Confirmed by the user (2026-10-14):
  - **Midnight while running:** Maestro also creates the new day's page when
    the date changes while it is open.
  - **First run:** the first launch creates only today's page, with no
    back-fill into the past.
  - **Gap-fill anchor:** gap-filling counts from the last auto-created date,
    not from the newest existing page. Otherwise deleting yesterday would make
    it come back.
  - **Title language:** English on every machine, not the system date format.
    Translation is not part of v1.
- Decided during the 2026-10-15 audit fixes, flagged for the user to confirm:
  deleting a manual page for a future date does not block that date's
  automatic page.

### Editing

- **On selected text:** text colour and highlight (background colour).
- **Basics:** bold, italic, underline, headings, bullet and numbered lists,
  links.
- **Checklists:** lists with tick boxes.
- **Not included:** tables, images, and any font change (family or size). The
  user dropped fonts while reviewing this PRD; see the Decision trace.
- **Editor:** TipTap, with its own setup (not the Notes markdown pipeline).
  Checklists come from `@tiptap/extension-list` (`TaskList`, `TaskItem`,
  already installed). Text colour and highlight need
  `@tiptap/extension-text-style`, a new dependency; its font-family and
  font-size parts are not used.
- Confirmed by the user (2026-10-14): text colour is kept because the user's
  correction named fonts only.

### Candidates

- **Sources (all four, from Maestro activity):**
  1. Claude conversations, using the AI name and two-sentence summary that
     History already makes and caches.
  2. Git commits.
  3. PRs and issues, through the GitHub CLI (`gh`).
  4. Terminal sessions.
  Granola comes in through the optional connector (see below).
- **Timing:** one setting, "run every X hours" (default 1), and only while
  Maestro is open. Nothing runs while Maestro is closed. There is no
  active-hours window, no weekday filter and no cron expression (user, in the
  agent-ready pass: "run the job every X hours during maestro open").
- **Where they appear:** in a suggestions box under the page body of the day
  page. The user keeps writing in the page while candidates wait below it.
- **Each candidate shows:** its text, a source tag, an Accept icon and a Reject
  icon. The box also shows "next run · run now".
- **Source tags:** five, one per source: GitHub, Git, Claude, Terminal,
  Granola.
- **Accept:** the candidate is added to that day's page as one line in the
  form `time - action`, for example `14:05 - Merged the PR for the login fix`.
  Granola lines use the meeting's `meeting_at` time, for example
  `14:30 - Meeting: Design sync, agreed the backup plan`. If a meeting has no
  time, the line falls back to `Meeting - Design sync: agreed the backup plan`.
- **Reject:** the candidate is removed from the box.
- **Badge:** the Work Journal pane icon shows the number of pending candidates
  for today only.
- **Model:** the user's own default Claude model, changeable in Settings (user
  correction: not Haiku by default). Runs use the user's existing Claude plan,
  so there is no extra bill.
- **No learning.** The run never sees journal history or past verdicts.
- Confirmed by the user (2026-10-14):
  - **Time:** the time in `time - action` is when the activity happened, taken
    from transcript, commit or GitHub times, not when the candidate was made.
  - **No repeats within a day:** each run is given today's page text and
    today's accepted, rejected and pending candidates so it does not propose
    the same thing twice. This is same-day duplicate removal only, not the
    learning that was dropped.
  - **Terminal sessions need new capture:** Maestro keeps terminal sessions in
    memory only, and ids are reassigned each launch. The journal keeps a small
    record per terminal: project name, branch, opened-at and closed-at. Nothing
    typed in the terminal is stored.
  - Confirmed by the coordinator, flagged for the user (2026-10-15): each
    terminal record also stores the folder the shell ran in (for a multi-repo
    workspace, the selected repo), and `work-journal.json` gains a
    `known_projects` list in its settings: every project a candidate run has
    covered. A run covers the open tabs (every repo of a multi-repo tab), the
    repos of terminals open inside its window, and `known_projects`, so a closed
    tab is still covered. A remembered folder that cannot be reached right now is
    skipped for that run but kept; one whose parent folder still exists but which
    is itself gone is dropped. The list is this machine's own and is kept through
    restore and undo. Coverage of a project starts once a run sees it after this
    change.
  - Confirmed by the coordinator, flagged for the user (2026-10-15): a
    recorded folder inside a linked git worktree (new terminals default to a new
    worktree) is collected as the same place in its main repository, under the
    main project's name, so a worktree is not a project of its own (a bare
    repository's worktrees are collected under the bare repository, named
    without `.git`; a folder inside the main checkout or a submodule stays as
    it is). Every worktree of a project, and every folder a terminal ran in
    during the window (a removed worktree included), is searched for Claude
    conversations, as History does. The folder itself stays as recorded in
    `known_projects` and is dropped once the worktree is removed.
- **Temporary file (user decision):** pending and rejected candidates and the
  terminal-session record live in a temporary file that is deleted after a
  day. They are not part of `work-journal.json` and are not backed up. The user
  confirmed knowingly that unreviewed (pending) candidates are deleted after a
  day too, even if never seen.
  - **Catch-up on start:** the first run after Maestro starts covers activity
    since the last run (for example commits made from another tool while
    Maestro was closed). Nothing runs while Maestro is closed. Decided during
    the 2026-10-15 audit fixes, flagged for the user to confirm: catch-up
    covers at most 7 days. When the cap cuts a catch-up short, the run says so
    once, in the suggestions box and in Settings: "Only the last 7 days were
    checked; earlier activity was skipped." Settings shows "Last run: <when
    the last run started> (covered up to <how far it got>)"; a failed run
    still updates the start time. Decided during the 2026-10-15 live QA
    (`docs/qa/WorkJournalQA-2026-10-15.md`), flagged for the user to confirm:
    a journal that has never run covers everything since local midnight of
    today, so a first install still suggests that morning's work.
  - **A failing day (fix, 2026-10-15):** a day whose run fails does not hold
    back the others: the run's window still counts as covered, and only the
    failed day is remembered in `work-journal.json` settings (`retry_dates`:
    the day and where its uncovered activity starts), so later runs ask about
    that day alone. After three failed tries the day is given up and the run
    reports "Could not get suggestions for 14 Oct after 3 tries".
  - **Headless run:** the run reuses the History-summary pattern, a headless
    `claude -p` with no built-in tools, no saved session
    (`--no-session-persistence`), a temp-dir working directory and a timeout
    (`src-tauri/src/commands/session_summary.rs`). It must not use `--bare`,
    because bare mode never reads stored OAuth sign-ins (needed for Granola).
  - **Override the system prompt:** the user's personal CLAUDE.md leaks into
    headless runs (seen in the hands-on test; the cause of issue #97). The
    candidate and report runs must pass their own `--system-prompt`, as History
    summaries do (`src-tauri/src/commands/session_summary.rs:42`), or reply
    parsing breaks.
  - **Keep the user's setup out (checked live, Claude Code 2.1.300):**
    `--system-prompt` alone does not keep CLAUDE.md out. Runs without Granola
    pass `--safe-mode` (no CLAUDE.md, hooks, skills, plugins or MCP servers).
    Safe mode also drops a server given by `--mcp-config`, so Granola runs pass
    `--setting-sources ""` instead (no CLAUDE.md and no settings files) plus
    `--strict-mcp-config` with an `--mcp-config` naming only the user's
    `granola` server, which reuses the stored sign-in.

### Granola connector (optional, free tier)

- **Setup is the user's, not Maestro's.** The user adds Granola's official MCP
  server to their own Claude Code setup at user scope and signs in once from
  an interactive session:
  `claude mcp add granola --transport http --scope user https://mcp.granola.ai/mcp`,
  then `/mcp` (or `claude mcp login granola`). A headless run can never sign
  in itself. Maestro keeps no Granola secret and maintains as little as
  possible.
- **Preflight.** Before a run, Maestro checks `claude mcp get granola` and uses
  the Granola path only when its `Status:` line says Connected. Any other status,
  or no Granola tools in the run, means "Granola off": the normal run carries
  on and nothing is treated as an error.
- **Tools allowed.** Only Granola's read tools, listed one by one
  (`mcp__granola__list_meetings`, `mcp__granola__get_meetings`), with
  `--permission-mode dontAsk` so every other tool is denied. Never allow
  `sign_out`, `switch_workspace`, `get_meeting_transcript` (paid) or
  `get_meeting_attachment`. Wildcards like `mcp__granola__*` are not used.
  Every other Granola tool (search, folders, account info) is denied by
  name, and no other MCP server is loaded (see Candidates).
- **What Granola gives:** meeting id, title, date, attendees, private notes and
  summarised notes, for the last 30 days on the free tier. The hands-on test
  (2026-10-14) also saw a `meeting_at` field in `list_meetings`, which the
  earlier research had not found. Granola lines use it as their time (see
  Candidates). Whether `meeting_at` is present on the free plan specifically
  was not confirmed, so the time-less fallback stays.
- Decided during the 2026-10-16 audit fixes, flagged for the user to confirm:
  the model never converts a meeting time. Maestro gives it the exact
  `list_meetings` call (`time_range: custom`, `custom_start` and `custom_end`
  as ISO times carrying the user's UTC offset, for example
  `2026-10-16T09:00:00+01:00`, from the run's window clipped to the date). The
  model copies `meeting_at` verbatim at the start of the line
  (`<meeting_at> - Meeting: <title>, <outcome> | granola`) and Maestro turns
  it into local `HH:MM`. A meeting whose local date is not the run's date
  (one near midnight in another offset) is dropped there; that date's run
  has it. `meeting_at` is read as ISO 8601 with `Z` or an offset (seconds and
  the offset's colon optional) or RFC 2822; without an offset it is taken as
  local time (Granola's own rule for its inputs). "Local" means this PC's
  time zone, which assumes Granola's stored time zone matches it. Its exact
  format was not seen, so a `Meeting: ...` line whose short stamp cannot be
  read (a date only, `Oct 15, 2026 2:30 PM`) is kept without a time on the
  run's date instead of being dropped. A plain
  `HH:MM - Meeting: ... | granola` line is still accepted as before. When
  the run's window misses the date, the whole date is listed
  (`custom_end` is the next date: a date-only end is excluded).
- **Proven on Windows (hands-on test, 2026-10-14):** after one interactive
  `claude mcp login granola`, a separate headless run from the temp folder
  reused the sign-in with no prompt; `--tools ""` plus `--allowedTools` exposed
  only the two read tools; `get_meeting_transcript` was denied. Sign-in itself
  needs a real terminal; it fails with "stdin isn't a terminal" otherwise.
- **Preflight output format (checked):** `claude mcp get granola` prints the
  server's fields, among them `Status: ✔ Connected` (or `Status: ! Needs
  authentication`), `Type: http` and `URL: <url>`; the run uses that URL. A
  missing server prints `No MCP server named "granola"` and exits 1. Changed
  from `claude mcp list` in the 2026-10-16 audit fixes: `list` health-checks
  every MCP server the user has (about 15 s, and it starts local ones such as
  Playwright), while `get` checks only Granola (about 2 s).
- **One-time opt-in (privacy).** The first time Maestro finds Granola
  connected, the suggestions box asks: "Use your Granola meeting notes for
  suggestions? Notes are sent to Claude and not stored." The user answers Yes
  or No and can change it later in settings. Nothing is read until the user
  says yes.
- **Full notes go to Claude** once opted in, so suggestions can name outcomes.
  No note text is saved anywhere. The only thing kept is the one-line
  candidate Claude writes, under the user's Claude plan's normal data terms.
- **Without Granola** the journal works exactly as before.
- Confirmed by the user (2026-10-14):
  - Pending and rejected Granola candidates follow the same rules as all other
    candidates: kept in the temporary file for same-day duplicate removal
    only, one line of text, never note excerpts.
  - The opt-in choice is a Work Journal setting stored in the journal file. A
    "No" means the run does not allow the Granola tools at all, rather than
    calling them and ignoring the result.
  - No note text is written to Maestro logs or error messages. A failed
    Granola call logs only that it failed.

### Layout

Mock (throwaway, evidence only; the user accepted every detail as is):
[work-journal-panel-mock.html on the `wayfinder/work-journal-panel-mock` branch](https://github.com/nachogl1/maestro/blob/wayfinder/work-journal-panel-mock/docs/PRDs/mocks/work-journal-panel-mock.html).

- **Pane icon:** a Work Journal icon among the existing right-side pane icons
  in the top bar, with a badge counting waiting candidates.
- **Side pane (layout A, default):** opens next to the terminals as a
  right-side `UtilityPanel` kind. Header: previous and next day arrows (user
  decision, 2026-10-16: each arrow moves exactly one calendar day, to days
  with or without a page, with no limit either way; a day with no page shows
  the "create a page for this day" state), the editable title, a jump-to-date
  picker, new page for a date, delete, Report, and pop-out. Below: the formatting toolbar and the page body. Under the
  page: the suggestions box with source tags, accept and reject icons, and
  "next run · run now".
- **Own window (layout B):** the pop-out button opens the same journal in its
  own OS window, following the issue map window precedent. A day list on the
  left (weekend pages dimmed, with a short status per day), plus the same
  header, toolbar, page and suggestions box.
- The right pane defaults to 560px and resizes from 340 to 800px
  (`src/components/shared/PanelResizeHandle.tsx`).
- Confirmed by the user (2026-10-14): pane and window show the same live data, so an
  edit or an accept in one shows up in the other.
- Decided during the 2026-10-15 audit fixes, flagged for the user to confirm: a
  save based on an older copy of the page is refused and the user chooses which
  text to keep ("Overwrite with mine" or "Discard mine"). When one window
  changed only the title and the other only the text, both changes are kept
  without asking. Text changed in the other window keeps the cursor where it
  was.
- Decided during the 2026-10-16 audit fixes, flagged for the user to confirm: when
  one window deletes a page while the other still has an unsaved change to it,
  that change is dropped with the page (it is not kept or retried). When the
  other window's save of that change was already sent (or had failed before),
  it shows "The page for <day> was deleted in the other window, so your last
  change to it was not saved." instead of the raw backend error. Text still
  inside the 400 ms typing pause when the page is deleted elsewhere is dropped
  without a notice, and so is a failed save whose page is deleted while that
  window's Work Journal is closed (the notice only shows while it is open).
- Decided during the 2026-10-16 audit fixes, flagged for the user to confirm:
  quitting Maestro from the main window first asks the pane and the pop-out to
  save text (and a page title being edited) still inside the typing pause, and
  to retry a failed save once, and waits up to 1.5 seconds for both to answer
  before the windows close. A save that still fails is lost on quit: the
  pop-out's "Close and lose it / Keep open" question only shows when the
  pop-out itself is closed, not when Maestro quits. Quitting with no
  terminals open can now take up to 1.5 seconds longer when a window does not
  answer. A half-typed page title is also saved when the other window starts a
  restore or undo, the same as page text (it then lands only in the safety
  copy).

### Storage and backup

- **One file:** `work-journal.json` in Maestro's app-data folder, next to its
  other JSON files. It holds all pages, the deleted-dates list and journal
  settings. Pending and rejected candidates and the terminal-session record
  are not in it; they live in the temporary file described under Candidates.
- **Safe write:** every save writes a temporary file first and then swaps it
  in, using the existing helper (`src-tauri/src/core/atomic_write.rs`), so a
  crash cannot leave a half-written journal. The temporary file is flushed to
  disk before the swap, so a power cut cannot empty it; it gets a fresh
  unpredictable name, and stale temps from earlier crashes are cleaned up.
- **Layout version:** the file records its layout version number.
- **Backup folder:** picked by the user in settings. It can be a OneDrive,
  Dropbox or network folder; the cloud sync provides the off-machine copy for
  free. Until a folder is picked there is no backup, and Maestro shows a
  reminder.
- **One backup file,** overwritten each time. Copies never pile up.
- **When:** daily, inside Maestro. While running, once a day. On start, if the
  last backup is more than a day old. Plus a "Back up now" button.
- **No OS scheduler.** The file only changes while Maestro runs, and Maestro
  must work the same on every OS it ships to.
- Confirmed by the user (2026-10-14):
  - The backup copy uses the same temp-then-swap write, so a sync client never
    uploads a half-written file.
  - Maestro records the last successful backup time and shows it next to the
    button. A failed backup (for example, folder missing) shows a visible
    error instead of failing silently.
- Decided during the 2026-10-15 audit fixes, flagged for the user to confirm:
  the backup folder may not be the journal's own folder (exact match only; a
  parent folder is allowed); restore is unchanged.
- Decided during the 2026-10-16 audit fixes, flagged for the user to confirm:
  - Each install has its own journal id (a random UUID, created by its first
    backup, kept local on restore and undo) and writes it into every backup.
    The automatic backup never replaces a backup that carries another id
    (another computer sharing the synced folder); it shows a warning once
    instead. "Back up now" asks "Another computer's backup is in this folder.
    Replace it?" before replacing one.
  - A backup without an id (written by an older Maestro, or by this install
    before the update) counts as this install's own and is replaced as
    before, so existing users are not blocked. The cost: while one computer
    still runs an older Maestro, and for the first backup after updating,
    an overwrite between two computers is not caught.
  - A backup that exists but cannot be read (an online-only file while
    offline, a permission error, a half-synced or otherwise unparseable
    file) counts as "can't tell": the automatic backup skips it with a
    warning shown once, and "Back up now" asks before replacing it. Skipping
    only costs a retry; replacing could wipe another computer's newest
    backup.
  - Restoring over a corrupt local journal loses this install's id; the next
    backup creates a new one (and then asks before replacing the old backup).

### Restore

- **Replace, never merge.** "Restore from backup" replaces the whole current
  journal with the backup. Maestro first saves the current journal as a
  one-off safety copy so a mistaken restore can be undone.
- **Version handling.** A backup from an older Maestro is upgraded
  automatically on restore. One from a newer Maestro is refused with "update
  Maestro first", changing nothing.
- Confirmed by the user (2026-10-14):
  - The "Restore from backup" button lives in Work Journal settings, next to
    the backup folder and "Back up now".
  - The default file is the backup in the configured folder; the user can also
    browse to any backup file (covers a new laptop with no folder set yet).
  - An "Undo restore" action puts the safety copy back. Only one safety copy
    is kept; the next restore overwrites it.
  - Never automatic: Maestro never reads from the backup unless asked. The
    daily backup always writes from the local journal outward, so edits made
    directly to the backup file elsewhere are overwritten by the next backup.
  - The same version check runs when Maestro loads its own local file after an
    update.
- Decided during the 2026-10-15 audit fixes, flagged for the user to confirm:
  - Journal settings are per-machine. Restore and undo keep this computer's
    settings (Granola choice, folders, model, schedule) and take only the
    pages, deleted dates and last auto-created date from the file.
  - On a new laptop no settings come across: the user sets them again and is
    asked about Granola again.
  - User decision (2026-10-16): restore and undo also keep this computer's
    own suggestions-run state (last run time, last attempt time, days waiting
    for a retry), so the next run continues from where it left off instead of
    suggesting the whole day again; the file's run state is never taken. Only
    the last backup time is cleared (automatic backups wait for "Back up now").
  - Undo keeps the journal it replaces as `work-journal.before-undo.json` in
    Maestro's data folder (next to the journal, not the backup folder), so
    the undo itself can be reversed by hand (no redo button). Only one such
    copy is kept; the next undo overwrites it. Undo works once: the safety
    copy is set aside first, and if that is blocked (for example antivirus
    or OneDrive holds it) the undo is refused with an error and nothing
    changes. If a later step fails, the safety copy is put back and the
    journal is unchanged.

### Supervisor report

- **Date range:** two date pickers, from and to, with no preset buttons.
  Decided during the 2026-10-15 audit fixes, flagged for the user to confirm: a
  range is limited to 92 days (both ends counted) and to 200,000 characters of
  page text; a longer range is refused with a plain message before Claude is
  asked, and the dialog disables Generate for ranges over 92 days.
- **Content:** an achievement-focused summary of everything in the range,
  "everything I did that would make me look good, summarised". Not a raw
  day-by-day log.
- **No review step.** The file goes straight into the folder the user chose.
  The user can regenerate at any moment.
- **File naming:** one file per range, named after its dates, for example
  `work-report_2026-10-05_to_2026-10-16.html`. Regenerating the same range
  overwrites that file; a different range makes a new file.
- Confirmed by the user (2026-10-14):
  - **How the HTML is made:** Claude returns the summary as plain text
    sections; Maestro inserts them into one fixed, self-contained HTML
    template. Claude never writes markup, so every report looks the same and
    no script or broken markup can reach the file.
  - **Facts only from the journal:** the prompt tells Claude to state only what
    is written in the journal pages for that range. It may choose and frame
    what to emphasise, but must never invent or inflate results. With no
    review step, this rule is the only guard against overstatement reaching
    the supervisor.
  - **Input:** only the text of the page bodies in the range, converted from
    editor JSON with TipTap's `generateText`. Pages that are empty or still
    only say "Weekend" are skipped. Pending or rejected candidates are not
    used.
  - **Model:** the user's default Claude model, changeable in Settings,
    mirroring candidates.
  - **Self-contained HTML:** styles inside the file, no external links or
    scripts, so it can be emailed or attached as is.
  - **Report folder:** picked once in Settings and remembered. Before the first
    report, Maestro asks for it.
  - **After saving:** a short "Saved to …" confirmation with an action to open
    the folder. The report is not opened automatically.

## Data model

In `work-journal.json` (backed up):

- **Layout version:** a number, for upgrade-or-refuse on load and restore.
- **Page:** date (unique key), title (defaults from the date), body (TipTap
  editor JSON, lossless), origin (auto or manual). Text and HTML for the AI
  and the report are generated on demand with TipTap's `generateText` and
  `generateHTML`; no second copy is stored.
- **Deleted dates:** dates whose page the user removed, except manual pages for
  dates the auto pass has not reached. They block auto-creation only.
- **Last auto-created date:** where gap-filling starts on the next launch.
- **Journal settings:** see Settings. The Granola opt-in is one of them.

In a temporary file, deleted after a day (not backed up):

- **Pending and rejected candidates:** one-line text, source tag, the
  activity time (none for Granola), the date it belongs to, and its state.
  Kept for same-day duplicate removal. Never holds Granola note excerpts.
- **Terminal-session record:** per terminal, project name, branch, opened-at
  and closed-at. Nothing typed in the terminal is stored.

Decided during the 2026-10-16 audit fixes, flagged for the user to confirm:
when the temporary file cannot be read it is moved aside as
`activity.json.damaged` for inspection. The next time the temporary file is
read after that copy's last change is more than a day old, the copy is
deleted, like the expired entries in the temporary file itself. Its age counts from the
original file's last write, and a copy whose age cannot be read is deleted.
So a copy of a file last saved more than a day ago is deleted almost at once,
because everything in it has already expired; only a file damaged within a
day of its last save can be inspected.

Confirmed by the coordinator, flagged for the user (2026-10-15): each
terminal record also stores the folder the shell ran in (for a multi-repo
workspace, the selected repo), and `work-journal.json` gains a
`known_projects` list in its settings: every project a candidate run has
covered. A run covers the open tabs (every repo of a multi-repo tab), the
repos of terminals open inside its window, and `known_projects`, so a closed
tab is still covered. A remembered folder that cannot be reached right now is
skipped for that run but kept; one whose parent folder still exists but which
is itself gone is dropped. The list is this machine's own and is kept through
restore and undo. Coverage of a project starts once a run sees it after this
change.
A recorded worktree folder is collected as its main repository and named
after it; every worktree of a project is searched for Claude conversations
(flagged for the user, see Candidates).

An accepted candidate becomes ordinary page text in `work-journal.json`.

## Settings

A Work Journal section in Maestro Settings holds:

- Candidate schedule: "run every X hours" while Maestro is open (default 1).
- Model for candidate runs and reports (default: the user's default Claude
  model).
  Decided during the 2026-10-16 audit fixes, flagged for the user to confirm: a
  model name a run would refuse (a space, a leading `-`, or a character other
  than ASCII letters, digits and `-._:[]/@`) is refused when it is saved,
  with the same message a run shows, and nothing in that save is changed.
  Blank still means the default model. A name saved before this check stays
  until edited; the run still refuses it with the same message.
- Backup folder, "Back up now", last backup time, "Restore from backup",
  "Undo restore".
- Report folder.
- Granola opt-in (Yes or No), changeable after the one-time prompt.

There is no connector sign-in in Maestro settings. Granola is added by the user
to their own Claude setup.

## Constraints

- **Global, not per project.** One Work Journal per user. Candidates draw on
  activity from every project.
- **Distributed app.** Every connector is optional; the journal must work fully
  with none. Nothing may depend on the host OS in a way that breaks Windows or
  macOS.
- **Free of cost.** Claude runs use the user's existing plan. Granola uses its
  free tier through its official MCP. No paid API.
- **Naming.** "Work Journal" everywhere; never confuse with the Samurai
  Journal.
- **Not the Notes pipeline.** Own TipTap setup (JSON, not markdown) and own
  crash-safe file (not LazyStore).
- **No learning.** The candidate prompt gets activity signals only.
- **Changelog.** Every user-visible step of the build adds a line to
  `src/lib/changelog.ts`. This PRD itself needs none.
- Existing capture facts that shape the build (from the activity-signals
  research, repo at `71d1634`): Claude transcripts are read through the
  History listing (`list_claude_sessions`, capped at 50 sessions per
  project); AI names and summaries are cached in
  `<app data>/history/session_summaries.json`; git and GitHub activity are
  queried on demand (`git log`, `gh pr list`, `gh issue list`); no persistent
  daily activity log exists, so a day is rebuilt from timestamps.

## Known risks

- **Granola on macOS is untested (known gap, accepted by the user).** Windows
  was proven hands-on on 2026-10-14. On macOS, a failed preflight still falls
  back to "Granola off", so the journal keeps working without Granola.
- **`meeting_at` on the free plan is unconfirmed.** Lines fall back to
  `Meeting - ...` when it is missing.
- **The supervisor report has no preview.** The "facts only from the journal"
  prompt rule is the only guard against overstatement reaching a supervisor.
- **Hourly runs on a large default model use more of the user's plan
  allowance** than the Haiku runs History uses today. The user can change the
  model or schedule in Settings.
- **Terminal sessions need new persistent capture.** Today they are
  memory-only with ids reassigned each launch; without new capture, the
  "terminal sessions" source yields nothing after a restart.
- **History listing cap.** The Work Journal reads up to 500 conversations per
  project (History shows 50), across the repo and all its worktrees; a longer
  catch-up window could still exceed it (not verified).
- **Transcript retention** is outside this repo; how long Claude keeps
  `~/.claude/projects` transcripts was not verified.

## Confirmed defaults (formerly "Assumptions to confirm")

Every item that was once an assumption was confirmed by the user on
2026-10-14, or checked against code:

1. Day pages: midnight creation while running, no back-fill on first run,
   gap-fill anchored on the last auto-created date, English titles. Confirmed.
2. Candidates: activity time on each line; same-day duplicate removal by
   feeding today's page and today's candidates; no edit-before-accept;
   catch-up on start. Confirmed.
3. Terminal record fields: project name, branch, opened-at, closed-at.
   Confirmed. Since 2026-10-15 also the folder the shell ran in, with a
   `known_projects` list in the journal settings (confirmed by the
   coordinator, flagged for the user; see Candidates).
4. Granola: opt-in stored in the journal file; "No" never calls Granola; no
   note text in logs; `query_granola_meetings` not used. Confirmed.
5. Backup and restore details (safe backup write, last backup time and visible
   errors, restore location, browse to any file, one undo copy, never
   automatic, version check on load). Confirmed.
6. Report details (facts only, skip empty and "Weekend" pages, default model,
   remembered folder, "Saved to …"); pane and window in live sync; text colour
   and highlight kept. Confirmed.
7. `@tiptap/extension-text-style@3.29.2` exports `Color` and `BackgroundColor`.
   Checked against the published package.

## Verification

- Unit tests: gap-filling from the last auto-created date (including weekends,
  deleted dates and midnight rollover); default title format; `time - action`
  line insertion and the time-less `Meeting - ...` form for Granola; the
  temporary file is deleted after a day and excluded from the backup;
  layout-version upgrade and refuse; report file naming and
  overwrite; "Weekend"/empty page skipping for the report.
- Storage tests: temp-then-swap write for the journal and for the backup;
  daily and on-start backup triggers; restore with safety copy and undo.
- Candidate run tests: the headless command line (no built-in tools,
  `--no-session-persistence`, timeout, `--permission-mode dontAsk`, only the
  two Granola read tools when opted in, nothing Granola-related when not);
  "Granola off" handling of a non-Connected `claude mcp get granola` status.
- Hands-on Granola test: done on Windows on 2026-10-14 (passed; see the
  Granola connector section). macOS is a known, accepted gap. The build still
  checks that an expired sign-in degrades to "Granola off" rather than an
  error (unit test against a `! Needs authentication` line).
- Live dev build (a devtest Maestro instance an agent can run): pane icon and badge; side pane header actions; pop-out
  window with day list, pane and window in sync; per-selection text colour,
  highlight and checklists; the five source tags; accept and reject; "Back up now" and
  "Restore from backup"; a report generated to the chosen folder.

## Splitting into agent-ready issues

The build is split into GitHub issues that an agent can finish alone, with no
human decision. This PRD holds no open decision; if an agent still meets one,
it stops (see "Done means" in the template).

**Split rules:**

- One outcome per issue, sized for one agent session.
- Keep the files two issues touch apart, so issues can run in parallel; where
  they must share, add an explicit blocking edge.
- Every issue gets the labels `agent-ready`, `enhancement` and `work-journal`,
  and is a sub-issue of one Work Journal epic.
- Blocking uses GitHub's native dependency plus a `### Blocked by` section in
  the body (the convention the issue map reads).
- No human-only issues are needed: the Granola hands-on test is done on
  Windows, and macOS is an accepted known gap.

**Issue template (agreed with the user on 2026-10-14):**

```markdown
Title: feat(work-journal): <one outcome>
Labels: agent-ready, enhancement, work-journal

## Outcome
What is true when this is done (1-3 lines).

## Context
- PRD section: <link to docs/PRDs/PRDWorkJournal.md#...>
- Files to touch: <path:line> (verified)
- Existing pattern to copy: <path>

## Out of scope
What this issue must NOT do (handled by <issue title>).

## Acceptance
- Given/When/Then lines
- Unit tests named
- Live dev-build check (devtest instance)

### Blocked by
- <issue title + link>

## Done means
Tests + biome + clippy green, changelog line added, PR to main.
If a human decision turns up: stop, comment the question,
add needs-human-decision, remove agent-ready.

Part of <epic title + link>
```

## Decision trace

Each ticket by title, with what it settled.

- [Work Journal: activity signals Maestro already captures](https://github.com/nachogl1/maestro/issues/293):
  research. Transcripts via History, cached AI names and summaries, git and
  GitHub on demand; no persistent daily log; terminals memory-only.
- [Work Journal: free access paths to Outlook and Google calendars](https://github.com/nachogl1/maestro/issues/291):
  research. Kept as a starting point only; calendar is out of scope.
- [Work Journal: free access paths to Granola notes and transcripts](https://github.com/nachogl1/maestro/issues/292):
  research. Official Granola MCP, free tier gives notes from the last 30 days;
  transcripts and public API are paid; local files unsafe.
- [Work Journal: rules for day pages (auto-create, delete, weekends, titles)](https://github.com/nachogl1/maestro/issues/287):
  the Day pages section.
- [Work Journal: editing scope (fonts and formatting) and content storage format](https://github.com/nachogl1/maestro/issues/288):
  the Editing section and TipTap JSON storage. Later user correction
  ([comment "no font changes"](https://github.com/nachogl1/maestro/issues/288#issuecomment-6176035835)):
  fonts dropped; text colour, highlight and checklists kept.
- [Work Journal: local storage file and the overwrite-in-place backup](https://github.com/nachogl1/maestro/issues/289):
  the Storage and backup section.
- [Work Journal: what "learn from the journal to suggest actions" means](https://github.com/nachogl1/maestro/issues/290):
  no learning; next-work suggestions out of scope.
- [Work Journal: how candidate entries are generated, shown and accepted](https://github.com/nachogl1/maestro/issues/294):
  the Candidates section. Later user correction: the model is the user's own
  default Claude model, changeable in Settings, not Haiku.
- [Work Journal: optional calendar and Granola connectors (none, one or both)](https://github.com/nachogl1/maestro/issues/295):
  calendar dropped from v1. Later user correction: Granola free tier stays in
  v1 as an optional connector.
- [Work Journal: can background Claude runs use the Granola MCP sign-in?](https://github.com/nachogl1/maestro/issues/300):
  research. Works with caveats; user-scope add, sign in once, preflight with
  `claude mcp list`, allow only read tools; Windows reuse needs a hands-on
  test. Its suggestions to keep Haiku and to fall back to the paid API are
  superseded by the user's model correction and by the paid-tier non-goal.
- [Work Journal: supervisor HTML report for a date range](https://github.com/nachogl1/maestro/issues/296):
  the Supervisor report section.
- [Work Journal: panel layout mock (side pane vs own window)](https://github.com/nachogl1/maestro/issues/297):
  the Layout section; mock accepted as is.
- [Work Journal: restoring from the backup (and older file versions)](https://github.com/nachogl1/maestro/issues/299):
  the Restore section.
- [Work Journal: privacy rules for Granola meeting notes](https://github.com/nachogl1/maestro/issues/301):
  the opt-in and privacy rules in the Granola connector section.
- [Work Journal: assemble the PRD](https://github.com/nachogl1/maestro/issues/298):
  this document. The user's review
  ([comment "gaps settled by the user"](https://github.com/nachogl1/maestro/issues/298#issuecomment-6176036241))
  settled four gaps: fonts dropped; Granola lines carry no time (later reversed by the agent-ready pass); pending and
  rejected candidates and the terminal-session record live in a temporary
  file deleted after a day, not in `work-journal.json` and not backed up;
  five source tags (GitHub, Git, Claude, Terminal, Granola).
- Agent-ready pass (2026-10-14, after this PRD merged): the user settled the
  schedule ("run every X hours" while open), the today-only badge, report HTML
  from a fixed template, terminal record fields and catch-up on start, and
  confirmed every former assumption. A hands-on Granola test on Windows passed
  and found a `meeting_at` field, so Granola lines now carry a time
  ([test result](https://github.com/nachogl1/maestro/issues/300#issuecomment-6176493291)).
