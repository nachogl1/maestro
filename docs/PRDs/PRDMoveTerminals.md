# PRD: Move terminals wherever you like

**Status:** implemented (2026-10-15)
**Prototype:** `Downloads/maestro-move-terminals-prototype.html` (approved by the user before the build)

## Problem

Until now a terminal pane could only be **swapped** with another one, using a tiny grip in its
corner. In eagle view a drop on another project's tile moved the **whole project**, so two
projects' terminals could never be mixed. Users want to pick a terminal up and put it wherever
they like, in both views.

## Goals

1. Pick a terminal up by its **whole title bar** (the grip still works too).
2. **Project view** (eagle off): drop on another pane's edge to move next to it, on its middle to
   swap, or on the outer edge of the whole area to make it a full column or row. Keyboard:
   `Alt+Shift+Arrow` swaps the focused pane with its neighbour in that direction.
3. **Eagle view**: tiles have a **free order** across projects. Drop on the outer third of a tile to
   insert before/after it, on the middle to swap. A **tile size** button cycles 1×1 → 2×1 → 2×2 →
   1×2. The top bar offers a **column count** picker and **Group by project** to undo the mixing.
   Keyboard: `Alt+Shift+Arrow` moves the tile one step.
4. Clicks on the title bar keep working (flag toggle, rename, buttons).
5. No terminal ever remounts: every move is a style/tree change on already-mounted panes.

## Non-goals

- Persisting the layout across app restarts. Sessions do not survive a restart, so neither does
  their order or size (same rule as the existing zoom-tab order).
- Moving a terminal to a different project (a terminal's working directory is its project).
- Resizing eagle tiles by dragging their corners (the existing gap resizer stays).

## Design

- **Pure helpers** in `src/lib/paneMoves.ts` decide the drop zone from a rectangle and a point,
  pick the keyboard neighbour, reorder the eagle list and cycle tile sizes. They are unit tested.
- **Split tree** gains `moveSlotToSide` (take a leaf out, split the target) and `moveSlotToTreeEdge`
  (wrap the root). Existing `swapSlots` keeps the swap path.
- **DraggablePane** (TerminalGrid) runs the drag with pointer events, hit-tests with
  `elementFromPoint`, and writes the hover highlight straight into the hovered pane's DOM
  (`data-drop-zone` + a `.pane-drop-zone` overlay every pane renders). A ghost label follows the
  pointer. The click fired on release is swallowed once so a drag never toggles the flag.
- **Eagle order** lives in the workspace store (`eagleTileOrder`, `eagleTileSpans`, `eagleColumns`,
  runtime-only). Each tile gets CSS `order` and `grid-column/row: span`, with `grid-auto-flow:
  dense` so bigger tiles leave no holes. The zoom tab strip shares the same order.
- Pre-launch cards tile after the launched terminals in eagle view and are not draggable there
  (the order is keyed by session id, which they do not have yet).

## Verification

- Unit tests: `paneMoves`, `splitTree` moves, keyboard hooks.
- Full `npm run test`, `tsc`, Biome.
- Live check in `npm run tauri dev` (see the PR).
