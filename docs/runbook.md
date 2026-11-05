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

## History tab: order and last message time

- Inside each project, the directory groups (the checkout, each worktree, and any other directory a conversation
  ran in) are ordered by their newest message, whatever kind of directory they are. A worktree with a conversation
  from five minutes ago sits above a checkout last used yesterday.
- Groups with no conversations yet (an unused worktree, say) come last.
- Each conversation shows its last message time beside the relative label: `3h ago · 14:32` for today, and the date
  as well for an earlier day, such as `yesterday · Nov 4, 09:10`. Hover the label for the full date and time.
