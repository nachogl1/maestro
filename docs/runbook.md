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

## Tabs: dragging one onto another swaps the two

In all four rows you can reorder by dragging (project tabs in the top bar, terminal tabs while a terminal is
zoomed, the eagle view's zoom strip and the parked strip), dropping a tab onto another swaps just those two; every
other tab stays where it was. With `A B C D E`, dropping B on D gives `A D C B E`. While you drag, the tab under
the pointer slides into the dragged tab's old spot, so what you see is what you get on drop. Moving a project tab
one place left or right from the keyboard works as before.

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
- The green tick accepts a suggestion (adds its line to the page); the red cross rejects it (hides it for today).
  The two sit apart, with more than a button's width between them, so one is not hit for the other.
- A project the suggestion run names that does not appear in that day's activity is left out, so a pill only ever
  names a real project.

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
