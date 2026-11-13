# Maestro — Product Requirements Document v1

Status: draft for the maintainer's approval. Written from the code on `main` (2026-11-13) and from every decision
settled on the planning map [Wayfinder map: November 2026 corrections and new features](https://github.com/nachogl1/maestro/issues/476).
Where the code and an older document disagree, the code is what this file describes as shipped.

## 1. What Maestro is

Maestro is a desktop app (Windows and macOS; Linux built from source) for one developer who runs many AI coding
agents at once — mostly Claude Code, also other AI command lines — across several projects. It puts every agent's
terminal on one screen, tells the person which agent needs them, keeps agents that need nobody out of the way, and
keeps a daily work journal of what was done.

**Who it is for:** a developer supervising several agents in parallel, often in several git worktrees of one
project, who wants to notice the moment an agent needs an answer and otherwise not look.

**What it is not:** an editor or IDE, a hosted service, or a team tool. Everything runs on the person's computer;
nothing is sent anywhere except through the tools the person already uses (git, `gh`, the Claude CLI, Granola),
plus one read of the person's Claude usage limits with their existing Claude Code sign-in (§3.9).

## 2. Vocabulary

| Word | Meaning |
|---|---|
| Project | A folder (or a multi-repo workspace) opened as a tab at the top of the window. |
| Terminal | One agent session (or plain shell) in a project, shown as a pane with a header. |
| Worktree | A separate checkout folder of the same repository; a terminal can run in one. |
| Eagle view | One screen showing every open project's terminals as tiles. |
| Zoom view | One terminal maximised, with a tab strip of the others. |
| Park / parked shelf | Hiding a terminal without stopping it; the shelf is the strip of pills for parked terminals. |
| Status | What a terminal is doing: Starting, Idle, Working, NeedsInput, Done, Error, Timeout. |
| Injector | Sending one message to several terminals at once. |
| Trigger | A rule that sends a message when a terminal's context use reaches a percent. |
| Samurai | Supervised autonomous runs: an orchestrator agent works through an epic and is handed off to a fresh successor when its context fills. |
| Second Brain | The panel showing Samurai's audit stream, ops journal and managed files. |
| Issue map | The blocked-by graph of a project's GitHub issues, level by level. |
| Work Journal | One rich-text page per day, with AI suggestions of entries and a supervisor report. |
| Suggestion | A proposed journal entry not yet accepted ("candidate" in the code). |
| Entry card | (decided, §4.7) A journal entry shown as a card: bold time, project chip, source tag, one text box. |
| Icon strip / panel | (decided, §4.4) The column of icons on the far left; each icon opens one panel. |
| Scratch project | (decided, §4.10) A throwaway project folder Maestro creates for work that belongs to no real project. |

## 3. Shipped today

### 3.1 Projects, terminals and views

- Projects open as tabs (the `+` button, or a folder passed to the `maestro` terminal command); Ctrl+Tab and
  Ctrl+Shift+Tab cycle them; Mod+Shift+Left/Right moves a tab (Mod = Ctrl, or Cmd on macOS). Hidden projects keep
  their terminals running. A multi-repo workspace gets a repository-and-branch picker when a terminal is created.
- Mod+T adds a terminal card with the cursor in its name box; Enter launches it. Alt+R renames, Alt+W closes (after
  asking), Alt+Shift+P pins (a pinned terminal stays visible in a strip while other projects are shown), Alt+Shift+F
  flags it yellow. Font size has a setting and View-menu zoom from 25 to 500 %.
- Eagle view (Mod+G) shows every project's terminals; its `+` asks which project. Zoom (Mod+1) maximises the
  focused terminal; Alt+Left/Right switch while zoomed. Tidy up (Alt+T) puts every terminal in one row of
  full-height columns. Mod+Alt+Left/Right moves focus in every view; Alt+Shift+arrows swap the focused terminal with
  its neighbour. Terminals, project tabs, the zoom strip and the parked pills can be dragged.
- The header shows a red "Context threshold reached" pill (an icon only with many terminals) and a blinking red frame
  when a Claude terminal's context use reaches the alert percent (default 35 %, set in the sidebar's Settings tab).

### 3.2 Status, parking and attention

- Maestro writes its own Claude Code hooks (SessionStart, SessionEnd, PreToolUse, PostToolUse, Stop, Notification,
  UserPromptSubmit) into the project's `settings.local.json`, marked so the person's own hooks are left alone; they
  report to a local status server. Agents can also report through the `maestro_status` tool of the bundled
  `maestro-mcp-server`. Without hook data, status is guessed from terminal output.
- Alt+P parks a terminal; clicking its pill restores it. Alt+U enters the shelf (Left/Right pick, Enter restores,
  Alt+U or Esc leaves). Pills can be reordered by dragging.
- A parked terminal comes back by itself when it finishes, errors or needs an answer (a permission prompt, a
  question, a quota wait that will not resume); notifications that need nobody leave it parked; at a turn end it
  stays parked while Claude Code still lists running background work, unless its last message ends with `?`; every
  new question brings it back even when it already showed waiting.
- Attention cues: an optional beep when a terminal needs the person (off by default), a brighter red glow on a
  waiting terminal and its pill, and blinking yellow zoom-strip and project tabs for a terminal that came back from
  parking until it is selected.

### 3.3 Injector and triggers

- The Injector panel (Alt+4) sends one message (Ctrl+Enter) to every ticked running terminal across projects and
  reports which sends failed; the text stays when any send failed so it can be resent.
- A trigger watches ticked terminals' context percent (1–100) and sends its message to all watched terminals or only
  to the one that reached it; it fires once per terminal and re-arms when context drops below the percent. Triggers
  keep working with the panel closed. The row shows watched terminals, message and last firing. **Triggers live in
  memory only and are lost on restart** (changed by §4.3).

### 3.4 Samurai and Second Brain

- Launch starts, schedules, recovers, resumes, abandons and cleans up Samurai epic runs, with a preflight check and
  an editable workflow graph. A supervised terminal shows a `gen-N · state · context %` badge; parked Samurai tiles
  beyond the newest three are disposed of. Some backend commands are written for manual testing and are not all
  wired to the interface.
- Second Brain shows the Samurai audit stream, the ops journal (add and delete entries), harvest reports and the
  managed files (briefs, handoffs, run configs, review records, timers) in a read-only viewer; timers can be
  cancelled or resumed. Samurai Launch and Second Brain can be hidden in Settings → Features.

### 3.5 Git panel, GitHub and the issue map

- The Git panel (Mod+2) has Commits (graph and changed files), Branches (search, check out, create, rename, delete,
  fetch with prune, worktrees with an unsaved-work warning), Status (changed files per worktree, side-by-side diff,
  discard), and — with `gh` signed in — PRs (filters, detail, a configurable PR workflow menu), Issues (filter,
  search, comment, close, reopen, assignees) and Discussions (read and comment). In eagle view it is a per-project
  carousel. A top-bar badge totals review requests and assigned issues, polled every 5 minutes.
- The issue map (Alt+M, or "Show issue map" in Issues) opens in its own window for the focused project, with a
  picker for every open project and each repository of a multi-repo project. Issues sit in columns by level, epics on
  the left, coloured by who takes them (agent-ready, needs-human, outside-change, no label, epic), with a progress
  icon. Filters: orion labels, progress, assignee, every repository label; search by `#number` or words; zoom and pan
  survive filter changes. A click traces an issue's chain and opens a draggable details card; assignees can be
  edited; Save writes a standalone HTML copy. A data-problems list explains link problems in plain words. At most
  1000 issues are fetched. The map must match orion's `issue-map` skill: a change is built here first, then copied
  there by an orion story.

### 3.6 Infra: plugins, skills and MCP servers

- Infra (sidebar tab) manages Claude plugins and skills, a plugin marketplace, context documents (`CLAUDE.md`) and
  MCP servers per project by scope (Project `.mcp.json`, User and Local `~/.claude.json`, or Maestro-only).
- **Boundary:** edits go to Claude Code's real configuration files; only the addressed entry changes, the first write
  of a run makes a `.maestro-backup` copy, and writes are atomic. What Maestro writes there is never widened without a
  ticket. At session launch Maestro adds its status server and the enabled servers to a session `.mcp.json` and
  removes its own entries on close (`opencode.json` likewise for OpenCode).

### 3.7 Notes, History and Workshop

- Notes (Mod+5): tabs of rich markdown notes, added, renamed, deleted and reordered by hand, saved across restarts;
  Tab and Shift+Tab indent only the bullet the cursor is on; markdown the editor cannot represent is protected from
  being overwritten.
- History (sidebar tab): Claude conversations per project, grouped by checkout and worktree, ordered by latest
  message, each with an AI name, summary and last message time; search; resume in its own folder.
- Workshop: a read-only weekly Claude Code `/insights` report with its run history and a manual run.

### 3.8 Work Journal

- Opt-in once on first run (after the auto-update question); changeable in Settings → Work Journal.
- One rich-text page per day (formatting toolbar, task lists, links, colours); weekend pages are created with the
  text "Weekend". Header: previous day, title, page-actions menu (Jump to date, New page for a date, Delete page,
  Report, Pop out), next day, Today. Pop out opens the journal in its own window, kept in sync.
- Suggestions: a headless Claude CLI run — shortly after start, then every N hours, or "Run now" — reads the day's
  Claude conversations, the configured git user's commits, the person's GitHub pull requests and issues through
  `gh`, terminal sessions, and optionally Granola meetings, and proposes one line per project. Each suggestion shows
  its text on its own line, a project pill in the project's colour and a source tag; Accept (green) appends a plain
  `HH:MM - text` line to the page, Reject (red) hides it for the day. A missing Granola tool shows a warning.
- Report: for a date range (default 7 days, up to 92), a facts-only, first-person, past-tense HTML report written to
  the chosen report folder, leaving out empty and weekend pages.
- Backup: `work-journal.json` in a chosen folder, written when a day has passed (checked hourly) or on "Back up now";
  restore from it or another file, with one safety copy and Undo restore. A reminder shows until a folder is chosen.

### 3.9 Window, settings and updates

- Top bar: sidebar toggle, Tidy up, new terminal, eagle view, then buttons for the right-hand panels (Notes, Second
  Brain, Launch, Work Journal, Workshop, Injector, Git; which ones show is chosen in Settings → Features), the GitHub
  badge, and the window controls. Left sidebar tabs: History (Alt+1), Infra (Alt+2), Settings (Alt+3).
- A usage bar at the bottom of the window shows the Claude account's usage limits, read from Anthropic's usage
  endpoint with the Claude Code sign-in already stored on the computer.
- Settings dialog: Appearance, Features, Notifications, Updates, Terminal, AI command lines, Samurai, Work Journal,
  Keyboard shortcuts, Changelog (read at build time from `docs/changelog/`).
- Updates: every push to `main` builds a signed Windows `.msi` and macOS `.dmg` as a GitHub Release on
  `nachogl1/maestro`; the app checks, offers "Download and Install" (warning first when terminals are open), and can
  install on launch.

## 4. Decided, not yet built

Each item is settled on the planning map; the linked ticket holds the full decision. UX prototypes for new screens
are in `docs/ux/prototypes/` and are the layout to build.

### 4.1 Parking and terminal tabs

- A zoomed terminal stops above the parked pills; pills scroll sideways with no scroll bar
  ([Parked shelf: the tabs cover the pills](https://github.com/nachogl1/maestro/issues/534)).
- In every drag row, dropping a tab on another swaps just those two, previewed while dragging
  ([Terminal tabs: dragging one tab moves only that tab](https://github.com/nachogl1/maestro/issues/538)).

### 4.2 Terminal header

- The header follows its column width: when narrow, park, pin, zoom and font size fold into one `⋯` menu (close
  stays), the branch hides first, then the project, the name last; the context warning becomes a red icon after the
  name ([Many terminals in several columns](https://github.com/nachogl1/maestro/issues/535)).
- An amber message icon with a count shows after the name when the Injector or a trigger sent the terminal a message;
  hover lists sender, time and first line; a click clears it; memory only
  ([Injected messages: a warning on the terminal header](https://github.com/nachogl1/maestro/issues/537)).

### 4.3 Triggers

- Optional name (else the message's first words); watch all terminals, including new ones, or only the ticked ones;
  "When a terminal reaches N% context, send the message to only that terminal (default) or every terminal it
  watches"; a full row with a clickable watched-terminals pill; edit in the row; saved across restarts, a ticked
  trigger whose terminals are gone marked "watches nothing"
  ([Triggers: their name, the 'send to' wording](https://github.com/nachogl1/maestro/issues/480)).
- A History list under the triggers records every firing (time, trigger, terminal and percent, message excerpt,
  recipients, delivered or failed) and a follow-up line when context drops again; grouped by day, then terminal;
  kept one week across restarts in one app-wide file; filter by trigger; Clear history
  ([Trigger audit trail](https://github.com/nachogl1/maestro/issues/481)).
- Prototype: `docs/ux/prototypes/triggers-panel/`.

### 4.4 Panels: the left icon strip

- Every panel (History, Files, Git / Notes, Work Journal, Injector, Launch, Second Brain, Workshop / Infra,
  Settings) gets its own icon in one strip on the far left; panels open beside it, several side by side in strip
  order, each resizable from 240 to 640 px; terminals keep at least 520 px and a panel that does not fit does not
  open; open panels and widths are remembered; existing shortcuts keep opening the same panels. The sidebar tabs,
  the right-hand panel slot and the top-bar panel buttons go
  ([Sidebar placement](https://github.com/nachogl1/maestro/issues/509)). Prototype: `docs/ux/prototypes/left-panels/`.

### 4.5 Files panel

- A Files panel shows the focused terminal's folder (its worktree, else the project) under a "Showing files of" box
  with a WORKTREE or PROJECT chip and copy-path; every file shows, git-ignored ones dimmed; folders load when opened;
  a click previews text files up to about 1 MB read-only below the tree, a double-click opens in the default app,
  hover and right-click offer copy path and open
  ([Project file explorer](https://github.com/nachogl1/maestro/issues/483),
  [Prototype: the Files tab](https://github.com/nachogl1/maestro/issues/508)). Prototype:
  `docs/ux/prototypes/files-tab/` (opened from the icon strip, not as a sidebar tab).

### 4.6 PROJECTS pill

- A PROJECTS pill beside the GitHub badge opens a list you step into: open projects, then every label of that
  repository with its open-issue count, then that label's issues, which open on GitHub; back arrow and path; one lock
  button ("Blocked counted" / "Ready only", remembered, default counted) using the issue map's blocked rule; loads on
  open with a spinner; no Settings and no combined-label rules
  ([Label pills](https://github.com/nachogl1/maestro/issues/482),
  [Prototype: the PROJECTS pill](https://github.com/nachogl1/maestro/issues/507)). Prototype:
  `docs/ux/prototypes/projects-pill/`.

### 4.7 Work Journal

- **Entry cards:** a card among free notes with a drag handle, bold editable time, project chip (changeable), fixed
  source tag (`Typed` for hand-made), one text box bold up to the first colon (all bold with no colon), delete; + Add
  entry at the right of the toolbar; Accept adds a card at the end; old plain lines stay plain
  ([Work Journal entries as editable cards](https://github.com/nachogl1/maestro/issues/485),
  [Prototype: Work Journal cards](https://github.com/nachogl1/maestro/issues/528)). Prototype:
  `docs/ux/prototypes/journal-cards/`.
- **One summary per project per day:** about 120 characters, outcomes only, from all the project's work except
  meetings; later work comes as an update suggestion (old text struck through above the new); Accept rewrites the
  card; typed cards never get updates
  ([one running summary per project per day](https://github.com/nachogl1/maestro/issues/486)).
- **Bulk accept and reject:** a tick box per suggestion and select-all; from two pending, Accept all / Reject all,
  reading Accept N / Reject N with ticks; the day shown only; bulk reject asks Yes / No in place; an updated
  suggestion loses its tick ([accept or reject all, or only the selected ones](https://github.com/nachogl1/maestro/issues/503)).
- **Report:** one heading per project, most bullets first, Other last; bullets oldest day first, one sentence of
  about 120 characters, each starting with its day (`Mon 3 Nov`) plus `, 14:20` when it rests on one timed entry;
  no overview, no themes; wording rules, look and dialog unchanged
  ([show the day, and the time when known](https://github.com/nachogl1/maestro/issues/504),
  [what a good report looks like](https://github.com/nachogl1/maestro/issues/539)).
- **Backup:** also once when Maestro closes; every backup also writes a readable `work-journal.md` with every page,
  newest first; restore still reads only the JSON
  ([how soon a new entry reaches it, and a readable copy](https://github.com/nachogl1/maestro/issues/505)).
- **Spelling fixer:** an icon left of + Add entry (Ctrl+Shift+F) has Claude fix spelling, grammar and punctuation of
  the selection, else the whole page, in its own language, keeping the bold split; applied at once, one Ctrl+Z
  undoes; the page locks with a spinner; a short line reports the result
  ([one icon that fixes all my spelling and grammar](https://github.com/nachogl1/maestro/issues/545)).
- **(i) explanation** on the first-run question and in Settings: what it does, each source and its setup, and that
  the Claude CLI writes suggestions ([first-run question: a tooltip](https://github.com/nachogl1/maestro/issues/542)).
- Decided not to change: assigned pull requests and issues stay as sources; the commit filter stays
  ([only my own commits](https://github.com/nachogl1/maestro/issues/543)).

### 4.8 Issue map

- The details card shows `opened by <login>` after the state
  ([show who opened each issue](https://github.com/nachogl1/maestro/issues/536)).
- Any click outside the card closes it and clears the chain, in the app and the saved HTML map; the hint reads
  "Click outside to close" ([clicking outside an issue's details card](https://github.com/nachogl1/maestro/issues/544)).
- Both are mirrored into orion's `issue-map` skill.

### 4.9 Public page

- The `website/` docs site is published on GitHub Pages from `main`, cut to Home, Installation, Features and
  Troubleshooting and brought up to date; it holds the only install steps and the README links to it; every link
  points to `nachogl1/maestro`; the footer carries the author credit the maintainer chose
  ([Maestro's public GitHub page](https://github.com/nachogl1/maestro/issues/484)).

### 4.10 Scratch projects

- Eagle view's new-terminal list (Mod+T or the top bar's `+`) gains a **Scratch projects** pill and a
  **+ New scratch project** row; nothing changes outside eagle view.
- New asks for a name with a ready default, makes a plain folder (no git) under a scratch folder set in Settings
  (default `Maestro Scratch` in the home folder), and opens it as a normal project tab with a small scratch mark.
- Closing its last terminal, or its project tab, asks whether to delete the folder or keep it; quitting never asks.
- The pill lists every scratch folder with its age; a click opens it, a bin deletes it after a Yes / No.
- Delete removes the folder only; Claude Code's records and History rows stay, no longer resumable
  ([Scratch projects](https://github.com/nachogl1/maestro/issues/586)).

## 5. Out of scope

- A Linux installer; Linux stays build-it-yourself.
- The Work Journal as a separate modal dialog (the pop-out window covers it).
- Closed projects in the issue map's project list (Maestro keeps no list of closed tabs).
- Choosing labels in Settings and combined-label rules for the PROJECTS pill.
- Saving terminal output in the trigger history.

## 6. Acceptance bar

- Every change passes the gate in `CLAUDE.md` (build, lint, typecheck, Vitest and `cargo test`) on CI.
- Every new behaviour has a test; the skip count stays 0.
- A change to a screen follows its prototype under `docs/ux/prototypes/`.
- A user-visible change updates `docs/runbook.md` and adds its changelog line.
- Nothing personal or secret enters the repository (see `CLAUDE.md`, Boundaries).

## 7. Build decisions

- Tauri desktop app: React 18 and TypeScript on Vite for the interface, Rust 1.89 for the backend, a bundled
  `maestro-mcp-server` sidecar.
- Releases: signed installers on GitHub Releases of `nachogl1/maestro`, from `main`; self-update from those releases.
  The public page (§4.9) adds GitHub Pages, built from `main`, once its story lands.
- Data stays on the person's computer (app data folder); the Work Journal backup goes only to the folder they pick.
- AI calls go through the person's own Claude CLI (`claude -p`) — suggestions, report, spelling fixer — never an
  API key stored by Maestro; the usage bar reuses the Claude Code sign-in and stores nothing of its own.
- The upstream `its-maestro-baby/maestro` is read-only; every pull request targets the fork.
