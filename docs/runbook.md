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
  Clearing the box, or "show all", brings the issues back.
- **Labels menu** lists every label defined in the repository, orion's labels (`agent-ready`, `needs-human`,
  `epic`, ...) included, even labels no loaded issue carries yet (they show `0/0`). "only" next to a label keeps
  the issues that carry it. "no label" covers issues with no label at all; an issue whose only label is an orion
  label is listed under that label, not under "no label". If the repository's labels cannot be read, the menu
  falls back to the labels on the loaded issues.
- With every filter at its default, every open issue that is not an epic is on the map, whatever its labels.
- **Zoom and pan** are set once, when the map first opens (fit to the width), and again only when you press
  **Fit**. Changing a filter, typing a search or pressing Reload keeps the zoom and position you chose.
