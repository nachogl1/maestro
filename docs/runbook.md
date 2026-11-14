# Runbook

## Notes editor: indenting bullets

- **Tab** indents the bullet the caret is on by one level, together with its own nested bullets. The bullets
  after it stay where they are.
- **Shift+Tab** outdents a nested bullet by one level, together with its own nested bullets, and places it just
  after the bullet that held it. The bullets that followed it stay where they are, under that same bullet and at
  their level, so a later Tab never carries them along. On a top-level bullet, Shift+Tab turns the line into
  plain text, as before.
- **With a selection**, Tab and Shift+Tab move exactly the bullets whose lines are selected, each one level.
  A bullet that cannot move (Tab on the first bullet of a list, Shift+Tab on a top-level bullet inside a mixed
  selection) stays where it is while the others move.
- Tab on a bullet that cannot be indented, such as the first bullet of a list, does nothing and keeps the caret
  in the editor.

## Issue map: data problems

The issue map's data-problems pane lists every "blocked by" link it could not draw and every issue whose two
blocker sources (the body's `### Blocked by` section and GitHub's own blocked-by relation) disagree.

- A `### Blocked by` section that names something that is not a loaded issue, most often a pull request, shows
  one problem, "not an issue on the map". It is not also counted as a disagreement, because GitHub's own relation
  can never name a pull request. Fix it by naming the issue that pull request serves instead.
- Closed issues never appear in the list or its count. Their links still place them on the map.
- An open issue whose two sources name different issues is still reported as a disagreement.

## Issue map: search, labels, zoom and pan

- **Search box** (next to the filter menus): `#123` or `123` keeps only issue 123; any other text keeps the issues
  whose title contains every word typed, ignoring case. It narrows the map together with the filter menus.
  Clearing the box, pressing Esc in it, or "show all" brings the issues back. Esc closes the map only once
  the search is empty.
- **Labels menu** lists every label defined in the repository, orion's labels (`agent-ready`, `needs-human`,
  `epic`, ...) included, even labels no loaded issue carries yet (they show `0/0`). "only" next to a label keeps
  the issues that carry it. "no label" covers issues with no label at all; an issue whose only label is an orion
  label is listed under that label, not under "no label". If the repository's labels cannot be read, the menu
  falls back to the labels on the loaded issues.
- With every filter at its default, every open issue that is not an epic is on the map, whatever its labels.
- **Zoom and pan** are set once, when the map first opens (fit to the width), and again only when you press
  **Fit**. Changing a filter, typing a search or pressing Reload keeps the zoom and position you chose.

## Issue map: opening it with Alt+M, and the project list

- **Alt+M** (Option+M on a Mac) opens the issue map from anywhere, the same as the map button in the git panel's
  Issues tab. It shows the project the git panel is on: the active project tab, or in eagle view the project of the
  git panel's carousel card. If the map window is already open, it switches to that project and comes to the front.
  The shortcut is listed in Settings → Shortcuts.
- **Project list** (the picker in the map's header, shown when more than one project is open) holds every open
  project tab. A tab that holds several repositories lists each repository as its own entry, named
  `<tab> / <repository>`. A tab marked "not a git project" is listed too, because a failed detection can mark a
  real repository that way; if it really has no repository, the map shows an error for it.
- Opening or closing a project tab updates the list in an open map window; there is no need to reopen the map.
  Projects whose tab is closed are not listed.

## Issue map: who opened an issue

- Clicking a box opens its details card. The card's grey line reads
  `<Level N or Epics> · GitHub state: <STATE> · opened by <login> · assigned to <logins>`, or ends in
  `· nobody assigned`. The exported HTML map shows the same line in the same place.
- `opened by unknown` means GitHub gave no author login: the login is missing or empty, or the account was
  deleted (GitHub reports a deleted account as `ghost`).

## Issue map: closing an issue's details card

- A click anywhere outside the details card closes it and clears the highlighted chain, the same as Esc: an empty
  spot on the map, the header (search, project picker, Save HTML, Reload), the filter menus and the zoom buttons.
  The clicked control still does its own job in that same click, so a filter still filters and Zoom in still zooms.
- A click on another box switches the card to that issue; a second click on the same box closes it.
- Clicks inside the card, and a press that starts in it (dragging its title, selecting its text), keep it open.
- Dragging the map to pan it is not a click: the issue stays selected and its chain stays lit. The card hides
  during the pan unless you had moved it, in which case it stays up.
- The card's hint reads "Click outside to close". The saved HTML map behaves the same way.

## Terminals: moving focus between terminals

**Ctrl+Alt+Right** and **Ctrl+Alt+Left** (Cmd+Alt on a Mac) move the focus to the next and previous terminal,
and the cursor goes with it, so typing lands in the newly focused terminal. They work in every view:

- **Project view**: the project's terminals in layout order.
- **Project view, zoomed**: the zoom tabs in their order; the zoom moves to the newly focused terminal.
- **Eagle view**: every project's terminals in the order the tiles read on screen, top to bottom and left to
  right.
- **Eagle view, zoomed**: the same tile order; the zoom moves to the newly focused terminal.

From the last terminal the keys wrap to the first, and from the first to the last. Parked terminals and
unlaunched cards are skipped. In eagle view the keys act from the terminal the cursor is in; with the cursor in
an unlaunched card they do nothing.

## New terminal from the keyboard (Cmd/Ctrl+T)

- **Cmd/Ctrl+T** adds a new terminal card and puts the cursor in its **Window Name** box, in every view: an idle
  project, a project that already has terminals, while a terminal is zoomed, and in eagle view once a project is
  picked in the "New terminal" picker.
- Type a name and press **Enter** to launch the terminal straight away; the name is optional, so Enter on an
  empty box launches too. Tab still walks to the working-directory choice and the Launch button.
- For about a second after the card appears, the name box keeps the cursor even if a terminal tries to take it
  back. Clicking somewhere, pressing a shortcut, or tabbing to another field in that time leaves the cursor where
  you put it.

## Terminals: Tidy up (Alt+T)

The **Tidy up** button at the top right (or **Alt+T**) puts every terminal side by side in **one row of equal,
full-height columns**:

- **Project view**: the project's terminals, in the order they had (left to right, then top to bottom). It also
  works while a terminal is zoomed; the new layout shows when you leave the zoom. Parked terminals take no
  column; one you unpark later comes back beside the terminal that was next to it.
- **Eagle view**: every tile, in the order the tiles read on screen (top to bottom, then left to right). With more
  than ten tiles a column would be too narrow, so the tiles go back to the automatic grid instead.

After tidying, terminals still move and resize as usual: drag a divider or a tile edge, or drag a terminal onto
another one or onto an edge of the screen.

## Terminals: the header in narrow columns

Each terminal header follows the width of its own column, not the number of terminals open, so two terminals in
narrow columns look the same as six. As the column gets narrower, the header gives way in this order:

- **Below 480 px**: park, pin, zoom and font size fold into one **⋯** menu (More terminal actions). Each item does
  what its button did and shows the same shortcut; Alt+Shift+P still pins while the menu is closed. Close and
  Launch stay visible, and the AI icon shrinks to a small icon.
- **Below 360 px**: the git branch hides.
- **Below 260 px**: the project name hides (eagle view).
- The terminal name stays longest and is cut with **…** only when nothing else is left to give. Hover over the
  name to read in full whatever is hidden or cut: the name, the project and the branch.

The AI icon and the Samurai badge show at every width. When the context threshold is reached, a small red warning
icon blinks right after the terminal name; hover over it for "Context threshold reached" and the percentage.

## Terminals: the message icon on the header

When you send a message from the **Injector** panel or the **Conclave** dialog, or a trigger sends one, every
terminal that received it shows
a small amber envelope icon on its header, right after the name (after the red context icon when that shows). From
two messages on, it carries a count, such as `3`.

- Hover over the icon to see every message, newest first: who sent it (`Injector`, `Conclave`, or `Trigger at 50%`), the time
  (`14:20`) and the message's first line. The last line reads `Click to dismiss`.
- Click the icon to clear all of that terminal's messages. Nothing else clears it: clicking, focusing or typing in
  the terminal leaves it in place, and it stays through tab switches, zoom and parking.
- A failed send adds nothing (the Injector panel and the trigger row show failures). Samurai instructions, the Work
  Journal harvest prompt and the first prompt at launch never add one.
- The icons are kept in memory only: they clear when Maestro restarts, and a closed terminal's messages go with it.

## Injector: triggers

Under the Injector, **Triggers** send a message on their own when a terminal's context reaches a percent.

- The form: an optional **Name** (left empty, the trigger is called by the message's first four words); **Watch**
  either `All terminals, also new ones` or `Only the ones ticked above (N)` (the Injector's ticks); then "When a
  terminal reaches [80]% context, send the message to [only that terminal | every terminal it watches]" (the
  default is `only that terminal`); the **Message**; **+ Add trigger**. A ticked trigger needs at least one tick.
- Each row shows the name with an edit (pencil) and a delete button, `At 80% → only that terminal`, a `Watches`
  pill (`3 terminals` or `all terminals`; click it to list them as `name · project`), the message, and
  `Last fired 14:32 by api: sent to 1` (red with a failure count when some sends failed) or `Not fired yet`.
- The pencil turns the row into the same form, filled in, with **Cancel** and **Save**. Saving a ticked trigger
  watches the terminals ticked in the Injector at that moment.
- A trigger fires once per terminal and fires again only after that terminal's context drops below the percent.
- Triggers are saved in Maestro's app data (`injector-triggers.json`) and come back after a restart, re-armed. A
  ticked trigger comes back marked `watches nothing, edit to pick terminals`, because terminals never survive a
  restart; edit it to pick terminals. The same mark shows when every ticked terminal has closed. A damaged or
  unreadable file loads as no triggers and the panel keeps working; the last-fired line is not saved.

### Trigger history

- **History** (`· kept 1 week`), under the add form, lists every firing of the last week: newest day first, then
  one group per terminal that reached the percent, headed `name · project`. A line reads
  `14:32 Compact reminder: 81%, sent to api, delivered`, or `sent to 4 terminals, 3 delivered, 1 failed (docs:
  terminal closed)` in red when a send failed. Hover a firing to see the first words of its message. "Delivered"
  means the text reached the terminal.
- When a delivered recipient's context drops below the percent (for a terminal that was already under it: below
  where it was when the message arrived), one green line follows under that recipient's own group:
  `14:35 context dropped to 22% (worked)`, or `(worked, from the 11:02 firing by ui)` for another terminal. No line
  means it has not dropped yet; follow-ups are only watched while Maestro runs.
- Click a row's `Last fired …` line, or pick a trigger in the filter, to show only that trigger's lines; `All
  triggers` shows everything. A deleted trigger keeps its lines (listed as `name (deleted)` in the filter) until
  they are a week old. **Clear history** empties the list now.
- The history is one app-wide file in Maestro's app data (`trigger-history/trigger-history.json`), never inside a
  project. It keeps names as they were at firing time and only a short excerpt of the message, never terminal
  output. Lines older than seven days are dropped; a damaged file loads as an empty history.

## Conclave: asking agents to coordinate (Alt+C)

**Alt+C** (Option+C on a Mac) opens the Conclave dialog from anywhere, whether or not the Injector panel is open.
Conclave sends one message to the Claude Code terminals you tick, asking those agents to message each other (with
Claude Code's own `ListAgents` and `SendMessage`), say what they are working on, offer help, and agree how to share
ports, files, worktrees and long-running commands so nobody blocks anybody. There is no button for it; Settings →
Shortcuts lists the key.

- The title reads "Do you want to invoke Conclave?"; hover over or tab to the (i) icon after it for a one-line
  explanation.
- The list shows every running Claude Code terminal of every open project, grouped by project; parked ones carry a
  small `parked` tag. Other CLIs (Gemini, Codex, OpenCode, plain shells) are never listed. Nothing is ticked when it
  opens; **All** ticks every one.
- The text box opens with the default Conclave message every time, even after an earlier edit; edit it freely for
  this one send. When it is sent, Maestro adds one line you never edit, such as
  `Agents in this Conclave: fox (alpha-app), owl (beta-app)`, naming each ticked agent by the name Claude knows it by.
- **Invoke Conclave** stays off until at least two terminals are ticked and the text is not empty. **Cancel** or Esc
  closes the dialog without sending.
- When the Claude Code setting launches terminals with skip permissions and at least one terminal is ticked, a
  warning reads: "These agents will ask you to approve each message. Set crossSessionInbound to accept in Claude Code
  settings to stop that." Maestro never changes that setting for you. The warning follows the current launch setting,
  so a terminal started before that setting changed may be judged wrong.
- A clean send closes the dialog. When some terminals fail, the dialog stays open and lists each failure by name;
  the ones reached still get the message.
- Every terminal reached shows the amber message icon on its header with sender `Conclave` (see "Terminals: the
  message icon on the header").

## Tabs: dragging one onto another swaps the two

In all four rows you can reorder by dragging (project tabs in the top bar, terminal tabs while a terminal is
zoomed, the eagle view's zoom strip and the parked strip), dropping a tab onto another swaps just those two; every
other tab stays where it was. With `A B C D E`, dropping B on D gives `A D C B E`. While you drag, the tab under
the pointer slides into the dragged tab's old spot, so what you see is what you get on drop. Moving a project tab
one place left or right from the keyboard works as before.

## Panels: the icon strip on the far left

Every panel opens from the thin column of icons on the far left, below the project tabs. There is no left sidebar,
no right-hand panel and no panel button in the top bar any more.

- The icons, top to bottom, in three groups: **History**, **Files** and **Git**; **Notes**, **Work Journal**, **Injector**,
  **Launch**, **Second Brain** and **Workshop**; **Infra** and **Settings**. Hover an icon for its name and shortcut.
- Click an icon to open its panel to the right of the strip; click it again, or the panel's **✕**, to close it. An
  open panel's icon is red with a small red bar beside it.
- Several panels can be open at once. They always sit side by side in the strip's order, whatever order you opened
  them in.
- Drag a panel's right edge to resize it, from 240 to 640 pixels. Each panel keeps its own width.
- The terminals always keep at least 520 pixels. A panel that would leave them less does not open: its icon shakes
  and a message says to close a panel or make one narrower. When the window gets narrower, the most recently opened
  panels close first, and a message names them.
- The open panels and their widths come back after a restart. On a first start only History is open.
- The shortcuts are unchanged and each toggles its panel: **Alt+1** History, **Alt+2** Infra, **Alt+3** Settings,
  **Alt+4** Injector, **Ctrl+2** (Cmd+2 on a Mac) Git, which opens on its Status tab, and **Ctrl+5** (Cmd+5) Notes.
- The Settings panel holds what the sidebar's Settings tab held: **Open Settings**, the Agents list and **Stop All**.
  The Git panel shows its tab name, commit count and refresh button in its header, and keeps its per-project
  carousel in eagle view.
- **Settings → Features → Panel icons** chooses whether the Launch, Second Brain and Work Journal icons show;
  switching one off also closes its panel.

## Files panel: the focused terminal's folder

The **Files** icon (second in the strip, after History) opens a panel showing the folder the focused terminal works
in, so you see exactly what that agent sees. It has no keyboard shortcut (Alt+4 stays the Injector's).

- The **Showing files of** box names the terminal and its project. A green **WORKTREE** chip means the terminal runs
  in its own worktree and the tree shows that worktree; a grey **PROJECT** chip means it shows the project folder.
  The path below is cut from the left when long; the copy button at the right of the box copies it.
- Click another terminal and the panel switches to its folder. With no terminal open (or the focused one closed) the
  box says so and asks you to start or click one.
- Click a folder to open it one level; a big one shows **Loading…** for a moment. A folder is read again each time
  you open it, so close and reopen it to see files an agent added since. Every file shows, hidden ones such as
  `.env` included; files and folders matching the `.gitignore` rules are only dimmed, never hidden (a tracked file
  that matches them is dimmed too).
- Click a file to preview it below the tree, read-only, with its path, a **READ-ONLY** mark and copy, open and close
  buttons. A file over about 1 MB, or one that is not text, shows **Can't preview** with the reason and an **Open in
  default app** button.
- Double-click a file to open it in the computer's default app. Hover a file for two buttons: copy its full path and
  open it. Right-click a file for **Preview**, **Open in default app** and **Copy full path**; a folder for **Copy
  full path** and **Open in default app** (it opens in the file manager). A line under the tree confirms a copy.
- The panel never changes a file: it cannot edit, rename or delete anything.

## PROJECTS pill: open issues per label

The **PROJECTS** pill in the top bar, beside the GitHub badge, opens a list you step into one level at a time. The
back arrow and the path at the top (click **Projects** or the project's name) take you back up.

- **Projects:** every open project tab with its number of open issues. A project whose folder has no GitHub
  repository is greyed out with **no GitHub repository** and cannot be opened.
- **Labels:** every label of that repository with its open-issue count. A label with no open issue shows **0** and
  cannot be opened.
- **Issues:** that label's open issues by number and title; click one to open it on GitHub in your browser.
- **Lock button** (top right of the list): **Blocked counted** (the default) counts and lists blocked issues too, each
  with a small lock mark; **Ready only** leaves them out. Hover it for the explanation. The choice is remembered
  after a restart. "Blocked" is the issue map's rule: an open blocker by GitHub's own "blocked by" link or the
  issue's `### Blocked by` section, so the pill and the map always agree.
- The list asks GitHub each time you open it, with a spinner while it loads; nothing refreshes in the background.
  When a repository fails to load, its labels level shows the error and **Try again**. A repository with more than
  1000 issues says its counts may be low, because only the newest 1000 are read (the issue map's limit).

## History tab: order and last message time

- Inside each project, the directory groups (the checkout, each worktree, and any other directory a conversation
  ran in) are ordered by their newest message, whatever kind of directory they are. A worktree with a conversation
  from five minutes ago sits above a checkout last used yesterday.
- Groups with no conversations yet (an unused worktree, say) come last.
- Each conversation shows its last message time beside the relative label: `3h ago · 14:32` for today, and the date
  as well for an earlier day, such as `yesterday · Nov 4, 09:10`. Hover the label for the full date and time.

## Work Journal suggestions: project and Accept or Reject

- A suggestion that comes from work in a project shows that project's name in a small pill, in the project's own
  colour (the same colour its terminals have). The name is the project folder's name.
- A suggestion with no project shows no pill: a Granola meeting, and any suggestion made before this change.
- Each suggestion takes two lines: its text on top, across the full width of the box; underneath, the project pill
  and the source tag on the left and the Accept and Reject buttons on the right.
- The green tick accepts a suggestion (adds it to the page as an entry card); the red cross rejects it (hides it for
  today).
  The two sit apart, with more than a button's width between them, so one is not hit for the other.
- A project the suggestion run names that does not appear in that day's activity is left out, so a pill only ever
  names a real project.

## Work Journal: entry cards

- Each entry on a day's page is a card among your free notes. Left to right: a drag handle, the time in bold, then
  the project chip and the source tag above the card's text, and a delete cross on the right.
- In the card's text, everything up to and including the first colon shows bold as you type; with no colon all of it
  is bold. The text keeps the page's formatting buttons. Enter in a card starts a free note right below it.
- Click the time to change it: type `9:05` or `09:05` and press Enter or click away. A blank time means no time; a
  value that is not a time goes back to the old one.
- Click the project chip to pick another open project, or **No project** (a dashed grey "no project" chip).
- The source tag cannot be changed. A card you add yourself says **Typed**; an accepted suggestion keeps its own tag
  (Git · commit, Claude, Granola and so on) in the same colours as the Suggestions box.
- **+ Add entry**, at the right end of the formatting toolbar, adds an empty Typed card at the end of the page with
  the current time, no project, and the cursor in its text.
- Accept in the Suggestions box adds a card at the end of the page with the suggestion's time, project and source.
- Drag a card by its handle: a red line shows where it lands, between cards or between free notes.
- The cross deletes a card at once, with no question; Ctrl+Z brings it back.
- Pages written before cards keep their plain `HH:MM - ...` lines exactly as they were.

## Work Journal: the spelling fixer

- The spell-check icon sits just left of **+ Add entry** in the formatting toolbar; **Ctrl+Shift+F** in the page does
  the same. Its tooltip reads "Fix spelling and grammar (selection, or the whole page)  Ctrl+Shift+F".
- With text selected only the selection is fixed; with nothing selected the whole day page is, cards and free notes.
- Claude fixes spelling, grammar and punctuation in each text's own language, never translating, and keeps your
  quick-note style. It uses your own Claude CLI and the Work Journal model setting, like the suggestions and the report.
- Times, numbers, links, inline code, a card's project and the card's colon are never changed, so the bold part of a
  card still ends at the first colon. A card's time, project chip and source tag are never sent.
- While it runs the page cannot be edited and the icon spins. The fix lands all at once: one **Ctrl+Z** puts the page
  back as it was.
- A short line under the toolbar then says `N fixes made`, or `Not fixed:` and why (Claude Code not installed, no
  network, Claude's own error, or the page changed meanwhile), and fades. A failure changes nothing.
- A reply that rewrites a text instead of fixing it (repeated, swapped, emptied, or with most words changed) is
  refused whole: `Not fixed: Claude's reply could not be read. Try again.`, and nothing changes.

## Work Journal suggestions: one summary per project per day

- Each project gets one entry per day, built from all its work (commits, pull requests, issues, Claude sessions and
  terminal work): one sentence of about 120 characters on the outcomes, with no commit, file or pull request names.
  Granola meetings keep their own entries.
- A summary still waiting in the Suggestions box is rewritten in place by the next run, never shown twice.
- Once the project has a card on the page (one not typed by hand; the earliest if there are several), later work
  that day comes as an update suggestion headed "Updates your HH:MM <project> entry". It shows the card's current
  text grey and struck through, with the new text below it.
- Accept rewrites that card's text; its time, project chip and source tag stay. Reject leaves the card exactly as it
  is, and the same update is not suggested again that day.
- The card's current text, your own edits included, is what the next summary builds on.
- If you change, retime, move or delete the card before you accept, Accept leaves every card as it is and says so;
  reject the update to clear it.
- Cards you typed yourself never get an update suggestion. On a page with no card for the project yet (old plain
  lines), the summary comes as a normal suggestion.

## Work Journal suggestions: accept or reject several at once

- Each suggestion has a tick box, and the `Suggestions (N)` header line has a select-all box. From two pending
  suggestions the header also shows **Accept all** and **Reject all**; while some are ticked they read
  **Accept N** and **Reject N** and act only on the ticked ones.
- They act on the day shown only. Accept adds the cards in list order, one after the other, each with the same
  checks as its own Accept (an update whose card changed since is left alone).
- Accept all is greyed out for the same reasons as a single Accept: no page yet, a read-only page, a restore or a
  suggestion run in progress; hovering it says why.
- Reject asks **Reject N? Yes / No** in place first; No keeps everything. A reject is final for the day.
- If one fails, the others still go through; the failed ones stay ticked and the error line says how many and why.
- Ticks stay across new runs and new suggestions arrive unticked. A suggestion a run rewrote loses its tick, so
  text you have not read is never accepted. Going to another day clears the ticks.

## Work Journal suggestions: Granola meetings

- With Granola turned on (the Yes answer to the Granola question), each suggestion run looks up that day's meetings
  in Granola and suggests one line per meeting, tagged `Granola`. A meeting already on the page, or already
  suggested or rejected, is not suggested again.
- Each run checks that Granola still offers the two tools Maestro uses (searching the day's meetings and reading
  them). When Granola is connected but one of them is missing, the suggestions box shows: "Granola is connected,
  but Maestro could not read your meetings. Maestro needs an update." Suggestions from git, GitHub, Claude and
  terminals still arrive. The line goes away after the next run that finds both tools.
- When Granola did not connect during a run (a slow or failed connection), that day is tried again on the next runs,
  like any other failed day; the "needs an update" line does not show.

## Work Journal: the (i) explanation

- An (i) icon sits right after the title of the first-run question "Enable the Work Journal?", and right after the
  Work Journal heading in Settings → Work Journal. Both show the same text.
- Hovering the icon, or reaching it with Tab, opens a small box; moving away or tabbing on closes it. Escape closes
  the box and leaves the first-run question open and unanswered.
- The box says what the Work Journal does (one page per day; Claude suggests short lines from your activity and
  nothing is added until you accept it), then lists the sources it reads with the setup each needs: Claude
  conversations and terminal sessions in Maestro, git commits (needs your git name/email set), pull requests and
  issues (needs gh signed in), and Granola meetings (off until turned on in Settings, and Granola connected to
  Claude). It ends with "Suggestions are written by the Claude CLI."
- The text is fixed: it does not check whether each source is set up on this computer.

## Attention cues: sound, glow and blinking tabs

When a terminal needs you, Maestro tells you in three ways:

- **Sound (optional)**: Settings → Notifications → **Play a sound when a terminal needs you** (off by default).
  With it on, a short beep plays once when a parked terminal comes back by itself (it finished, failed, or waits
  for an answer) and once when a terminal starts waiting for your input. A reminder about a turn you already saw
  does not beep again.
- **Glow**: a terminal waiting for input has a brighter red glow around its frame, and its parking-tray chip
  glows brighter too.
- **Blinking tabs**: a terminal that came back from the parking tray by itself makes its tab in the zoom strip and
  its project tab at the top blink yellow, at the same moment and rhythm. Select the terminal (click it, its tab,
  or move focus to it) to stop the blink. A red context alert takes the place of the blink, and a warning flag you
  set by hand stays solid yellow. With reduced motion turned on in the system, or on Linux, the tabs stay solid
  yellow instead of blinking.

## Parked strip: reordering and picking from the keyboard (Alt+U)

- **Drag a pill onto another** and the two swap places; every other pill stays where it was, on this shelf and
  on every other one. The order holds while other terminals park and unpark: a terminal you park later joins
  the end, and one you unpark leaves the others where they were. The order lasts until the app closes. A
  plain click on a pill still restores its terminal; a drag never does.
- **Alt+U** moves the cursor to the first pill. **← →** pick a pill, and **Enter** restores its terminal while
  the cursor stays in the strip on the next pill (or the one before it, at the end of the row), so several
  terminals can be restored in a row.
- **Alt+U** again, or **Esc**, leaves the strip and puts the cursor back where it was before. While a terminal is
  zoomed, each restored terminal takes over the zoom, so leaving puts the cursor in the last one restored.
- Restoring the last pill leaves the strip and puts the cursor in that terminal, the same as clicking it.

## Parking: which notifications bring a parked terminal back

Claude Code sends a notification with a type. Maestro reads the type to decide whether a parked terminal comes back
into the grid.

- **Brings it back (its status turns to waiting for you):** a permission prompt (`permission_prompt`), a question
  dialog from an MCP server (`elicitation_dialog`, `elicitation_url_dialog`), and a usage-limit wait that will not
  resume by itself, so you must resume it by hand (`quota_auto_resume_stale`, `quota_auto_resume_disabled`).
- **Never brings it back, and the status stays as it was:** sign-in done (`auth_success`), an MCP question answered
  (`elicitation_complete`, `elicitation_response`), a background agent that finished or needs input in agent view
  (`agent_completed`, `agent_needs_input`), a usage-limit wait that resumed by itself (`quota_auto_resume_fired`),
  and a plugin's own message (`plugin_notification`).
- **The 60-second reminder** (`idle_prompt`) repaints the status but never brings a parked terminal back.
- **A type Maestro does not know yet**, or a notification with no type, still counts as a wait and brings the
  terminal back, so a new kind of prompt is never missed. Its type name is written to the app log as
  `unknown type`.

## Parking: when a parked terminal comes back at a turn end

When the agent ends its turn, Claude Code lists the work it left running: background commands, subagents, monitors,
workflows, scheduled wakeups and loops. Maestro counts that list to decide whether a parked terminal comes back.

- **Stays parked, status green ("working"):** the list still holds running work. The status line names it, for
  example "Waiting on 1 background command". This holds for as long as the work runs, even past 30 minutes,
  until the agent's next turn end or until the agent's process ends.
- **Comes back (status turns to waiting for you):** the list is empty, so the agent has really finished.
- **Comes back even while work runs:** the agent's last message ends with a question mark (spaces and new lines
  after it do not count). It asked you something in plain text.
- **An older Claude Code that sends no list** (or a list Maestro cannot read): Maestro counts the background work
  it saw in the conversation file instead, as before. That count stops trusting work after 30 minutes, and the
  terminal then comes back with "Background work stopped reporting" or "Subagents stopped reporting".
- **The agent reported "finished" itself during that turn:** the terminal shows done and comes back, even when
  its last message ends with a question mark.

## Parking: every new question brings a parked terminal back

- **Each new question brings it back**, even when its status already showed waiting for you: the agent's question
  dialog, a new permission prompt, a turn end that waits for you, a "finished" report and an error. Parking the
  terminal again keeps it parked only until the next such question.
- **The 60-second reminder does not count**: a terminal you park again after a turn end stays parked when the
  reminder arrives.
- **A question right after "finished"**: when the agent reports it finished and then opens its question dialog,
  the status turns to waiting for you and the terminal comes back.

## Work Journal header: Today and the page actions menu

- The header shows **Previous day**, the page title, the **page actions** button (three dots, right of the title),
  **Next day** and **Today**. The same header shows in the side pane and in the pop-out window.
- **Today** goes to today's page from any other date, earlier or later.
- The **page actions** menu holds Jump to date, New page for a date, Delete page, Report and Pop out. Pop out is
  not in the menu inside the pop-out window. An action that cannot run now (Delete page on a day with no page, or
  Delete and New page while a restore runs) is greyed out and skipped.
- **Keyboard**: on the page actions button, Enter, Space or ↓ opens the menu on its first action, and ↑ on its
  last. In the menu, ↑ and ↓ move (wrapping round), Home and End go to the first and last action, Enter or Space
  runs the action, and Esc closes the menu and puts the cursor back on the button. Tab closes the menu and moves
  on. A click anywhere else also closes it.
- Jump to date and New page for a date open their date row under the header with the cursor already in the date
  field, so a date can be typed straight away.

## Work Journal report: one heading per project, dated bullets

- Page actions → Report makes the supervisor report for a date range. It has no overview paragraph and no theme
  sections: one heading per project, the project with the most bullets first, and work with no project (a
  meeting, helping someone) under a last heading **Other**.
- The projects come from the entry cards' project chips. A heading that names no card's project goes under Other,
  so pages written before cards (no chips) give a report under Other only.
- Inside each project the bullets run oldest day first. Each starts with its day, like `Mon 3 Nov — …`, plus the
  time (`Mon 3 Nov, 14:20 — …`) only when it rests on exactly one timed entry. Work from several days lists each
  day with no time (`Mon 3 Nov, Wed 5 Nov — …`) and sorts by its first day.
- A date Claude gives outside the chosen range is left out; a bullet with no date left still shows, without a
  date, at the end of its project.
- The wording rules (the page's own words, no added praise words, first person, past tense), the page's look and
  the date range dialog are unchanged.

## Work Journal backup: on close, and a readable copy

- The backup still runs once a day (checked every hour while Maestro is open) and from **Back up now** in Settings.
  It now also runs once when Maestro closes, right after the journal windows save their last text, so the day's last
  writing reaches the backup.
- The close backup waits at most 2 seconds. If it fails or takes longer, the reason goes to Maestro's log and
  Maestro still closes. A crash, a forced shutdown or the macOS app-menu Quit skips it.
- It follows the automatic backup's rules: it never replaces a backup another computer wrote, or one this Maestro
  has never written. With no backup folder set, nothing is written.
- Every backup now writes two files in the backup folder: `work-journal.json` (the backup restore reads) and
  `work-journal.md`, a copy you can open in any text editor and search by eye. It holds every page, newest day
  first; an entry card reads `**09:15** project (source) text`, and free notes keep their text and formatting.
- `work-journal.md` is written only together with the JSON, and is never read back: **Restore from backup** reads
  only `work-journal.json`. Editing the Markdown file changes nothing in Maestro.

## Windows: the touch-text "Paste" box is off

- The small white box with **Paste** and **⋯** that the Windows web engine (WebView2) can show after a touch or pen
  long press in a text box is turned off in every Maestro window: the main window, the issue map and the
  Work Journal pop-out.
- When no text cursor is on screen, the web engine also refuses to show it, so it can no longer appear stuck at the
  window's top-left corner.
- Right-click menus, the keyboard menu key and Ctrl+V paste work as before.
- If the box still appears, Maestro cannot close it: the web engine draws it outside the page. Note what you were
  doing and report it.

## Scratch projects: throwaway folders from eagle view

A scratch project is a plain folder (not a git repository) for work that belongs to no real project.

- **Make one:** in eagle view, open the new-terminal list (**Cmd/Ctrl+T**, or the top bar's **+**) and pick
  **+ New scratch project**. The box offers a name such as `scratch-13-nov-1822`; press **Enter** to accept it
  or type another, **Esc** to cancel. A name already taken (in any letter case), or one that is not a valid
  folder name (empty, `.` or `..`, ending with a dot, a reserved name such as `con`, or holding
  `< > : " / \ | ? *`), is refused with a short message in the box and nothing is made.
- Maestro makes the folder inside the scratch folder, opens it as a project tab with a small flask mark, and adds
  a terminal card to it.
- **See them all:** the **Scratch projects** pill in the same list shows how many there are; click it for every
  scratch folder, open or kept, with its age. Click a row to add a terminal to it (its tab opens first if it was
  closed). The bin icon asks **Delete? Yes / No**; Yes closes its tab and terminals first, then deletes the folder.
- **Delete or keep:** closing a scratch project's last terminal (Stop All included), or its tab, asks "Delete the scratch project's
  files, or keep them?". **Keep** leaves the folder (closing the tab when that is what you asked); **Delete**
  removes the folder and its files and closes the tab. Esc or the close button answers neither. Closing one of
  several terminals, or any terminal of a normal project, never asks; quitting Maestro never asks either.
- **Where they live:** Settings → **Scratch projects** → **Scratch folder**. The default is `Maestro Scratch` in
  your home folder, made on first use. **Choose folder** picks another one and the pill then lists that folder's
  subfolders; **Use default** goes back. Every folder directly inside the scratch folder counts as a scratch
  project.
- Delete removes only the folder. Claude Code's own conversation records and Maestro's History rows stay, but
  those rows can no longer be resumed.
