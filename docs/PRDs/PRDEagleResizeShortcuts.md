# PRD: Eagle view resizing and keyboard zoom/park

Date: 2026-10-14 · PR #285

## Problem

1. With the keyboard focus inside a terminal in eagle view, Ctrl+1 (zoom) did
   nothing and Alt+P (park) was typed into the shell instead. The per-project
   keyboard handler is switched off in eagle view, and nothing replaced it.
2. Eagle view always splits the screen into equal tiles. With many terminals
   the user cannot give one terminal more room than another.

## Goals

- Ctrl+1 and Alt+P work in eagle view on the terminal holding keyboard focus,
  with the same keys as the per-project view (the approved shortcut scheme is
  kept; no new keys).
- The user can resize eagle columns and rows by dragging the gaps between
  terminals, and reset them.

## Non-goals

- Changing the per-project view: it already has draggable split dividers.
- Remembering sizes across app restarts.
- Per-tile sizes that break the grid (each column and each row has one size).

## Behaviour

- **Zoom:** Ctrl+1 (⌘1 on macOS) in a launched terminal toggles eagle zoom on
  it. Pre-launch cards ignore it.
- **Park:** Alt+P in a launched terminal parks it, exactly like its park button.
- **Resize:** each gap between two columns (or rows) is a drag handle. Dragging
  moves size between those two tracks only; neither drops below 15% of their
  combined size. Double-click a handle to make that axis equal again.
- Sizes hold while the grid keeps its shape. When the column or row count
  changes (terminals added, closed or parked), that axis starts equal again.
- Handles are hidden while a terminal is eagle-zoomed or only one tile shows.

## Constraints

- No terminal may remount (that loses scrollback): the handles are the grid's
  last child and are absolutely positioned, so they take no grid cell.
- xterm stops propagation of keys it handles, so the shortcuts listen in the
  capture phase.

## Verification

- Unit tests for the size math and the eagle keyboard hook.
- Live dev build: drag resize with terminals refitting, Ctrl+1 zoom/unzoom and
  Alt+P park in eagle view, per-project Ctrl+1 unchanged, eagle toggle keeps
  the same terminal elements.
