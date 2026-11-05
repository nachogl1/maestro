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
