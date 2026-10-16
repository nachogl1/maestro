# PRD: Eagle view free grid (resize one terminal at a time)

Date: 2026-10-16

## Problem

1. Eagle view sized terminals with one drag handle per column gap and per
   row gap: moving a gap resized every terminal in that column or row. With
   three columns where the middle one had more rows than the sides, the side
   terminals could not be made taller without changing the middle ones.
2. The column picker ("Auto cols / 1-6 cols") and the per-terminal tile-size
   button (1×1 → 2×1 → 2×2 → 1×2) were two more things to learn for a job
   the mouse should do directly.
3. The "group by project" button had no tooltip the user could find.

## Goals

- Resize one terminal with the mouse, by dragging any of its four edges, and
  only that terminal changes. The edge stops at the free space around it: the
  grid border, the next terminal, and a minimum size.
- Move terminals anywhere: drop on another terminal to swap, drop on empty
  grid space to move there.
- No column picker and no tile-size button. One button, "Sort terminals by
  project", returns to the automatic layout and says so in its tooltip.

## Non-goals

- Pushing neighbours when an edge reaches them (the user asked for "as long
  as there is space for that terminal", nothing more).
- Remembering the layout across app restarts (session ids do not survive one).
- Changing the per-project split view: its dividers already resize one pair
  of panes at a time.

## Design

- The eagle grid is a fixed 60 × 60 cell CSS grid (60 divides evenly by 1-6,
  so every automatic layout is exact). A tile is a rect in cells (x, y, w, h);
  the smallest tile is 6 × 6 cells.
- The grid has no track gap (60 tracks would eat the screen); every tile pads
  itself by 4 px and the grid pads its border by 4 px, giving the old 8 px
  visual gap.
- Store: `eagleTileRects` (session id → rect). Empty means the automatic
  layout: the square-ish grid Maestro always used, project by project. The
  first move or resize commits every launched tile's rect, freezing the
  layout the user started from.
- Derived layout (`layoutEagleTiles`): a stored rect is kept while it still
  fits (inside the grid, clear of tiles placed before it). Everything else —
  a new session, a pre-launch card, a tile whose old place is taken — goes to
  the top-left of the largest hole, no bigger than an automatic tile. When
  there is no hole, the biggest tile gives up half its room. When not even
  that works, the view falls back to the automatic layout and clears the store.
- Resize: four 6 px handles on each tile's edges. Pointer travel is turned
  into whole cells; `resizeTile` clamps against the collision set captured
  when the drag started, so a card re-placed mid-drag cannot block the edge.
- Move: drop on a launched tile swaps the two rects (positions AND sizes);
  drop on free cells centres the tile on the pointer, pulled back inside the
  grid, and only if it does not overlap anything. A preview rectangle shows
  the target. Alt+Shift+Arrow swaps with the nearest neighbour in that
  direction; dropping a tab on another in the zoom strip also swaps.
- The zoom tab strip and Alt+Arrow follow the on-screen reading order (top to
  bottom, left to right).

## Known limitations

- Pre-launch cards have no id, so their rect is never stored: after a resize
  elsewhere a card can hop into a different hole. Launch it to pin it.
- A tile cannot grow into a neighbour; shrink or move the neighbour first.

## Verification

- Unit tests for the layout engine (automatic packing, largest hole, split,
  reset, resize clamps, placement) and the kept pane-move helpers.
- Full Vitest suite green; Biome clean.
- Live dev build: resize one tile on every edge, blocked by neighbours; swap
  and move-to-empty drops; sort button resets; zoom strip order follows.
