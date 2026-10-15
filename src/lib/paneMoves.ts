/**
 * Pure helpers behind "move a terminal wherever you like": where a dragged
 * pane would land, which neighbour a keyboard move targets, and the eagle
 * view's free tile order and tile sizes. Nothing here touches the DOM — the
 * callers hand in rectangles and ids so this can be unit tested.
 */

/** An edge of a pane or of the whole split area. */
export type PaneEdge = "left" | "right" | "top" | "bottom";

/** Where a drop lands on a pane of the split (per-project) layout. */
export type PaneDropZone = PaneEdge | "swap";

/** Where a drop lands on a tile of the eagle grid. */
export type EagleDropZone = "before" | "after" | "swap";

/** Direction of a keyboard move. */
export type MoveDirection = "left" | "right" | "up" | "down";

/** Columns × rows a tile spans in the eagle grid. */
export type TileSpan = readonly [cols: number, rows: number];

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Share of a pane's width/height that counts as its edge for a drop. */
const PANE_EDGE_SHARE = 0.25;
/** Share of a tile's width that counts as "insert before/after" in eagle view. */
const EAGLE_EDGE_SHARE = 0.3;
/** Px band around the split area's border that drops a pane as a full column/row. */
export const STAGE_EDGE_PX = 14;
/** Share of the split area a pane gets when dropped on the area's edge. */
export const STAGE_EDGE_RATIO = 0.33;

/**
 * Split layout: the outer quarters of a pane move the dragged pane next to
 * it (taking half its space), the middle swaps the two. Left/right win over
 * top/bottom in the corners so the zone is predictable.
 */
export function paneDropZone(rect: Rect, x: number, y: number): PaneDropZone {
  if (rect.width <= 0 || rect.height <= 0) return "swap";
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  if (rx < PANE_EDGE_SHARE) return "left";
  if (rx > 1 - PANE_EDGE_SHARE) return "right";
  if (ry < PANE_EDGE_SHARE) return "top";
  if (ry > 1 - PANE_EDGE_SHARE) return "bottom";
  return "swap";
}

/** Eagle grid: the outer thirds of a tile insert next to it, the middle swaps. */
export function eagleDropZone(rect: Rect, x: number): EagleDropZone {
  if (rect.width <= 0) return "swap";
  const rx = (x - rect.left) / rect.width;
  if (rx < EAGLE_EDGE_SHARE) return "before";
  if (rx > 1 - EAGLE_EDGE_SHARE) return "after";
  return "swap";
}

/**
 * Which edge of the split area the pointer is on, if any: a thin band just
 * inside (and a little outside) the area's border. Left/right win in corners.
 */
export function stageEdgeAt(
  rect: Rect,
  x: number,
  y: number,
  margin: number = STAGE_EDGE_PX,
): PaneEdge | null {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  if (
    x < rect.left - margin ||
    x > right + margin ||
    y < rect.top - margin ||
    y > bottom + margin
  ) {
    return null;
  }
  if (x < rect.left + margin) return "left";
  if (x > right - margin) return "right";
  if (y < rect.top + margin) return "top";
  if (y > bottom - margin) return "bottom";
  return null;
}

/**
 * The nearest pane in the given direction: its centre must lie on that side
 * and it must overlap the mover on the other axis (so "right" never picks a
 * pane in a different row). Null when nothing is there.
 */
export function neighbourInDirection<T>(
  self: Rect,
  others: readonly { id: T; rect: Rect }[],
  direction: MoveDirection,
): T | null {
  const cx = self.left + self.width / 2;
  const cy = self.top + self.height / 2;
  const sRight = self.left + self.width;
  const sBottom = self.top + self.height;
  let best: T | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const { id, rect } of others) {
    const ox = rect.left + rect.width / 2;
    const oy = rect.top + rect.height / 2;
    const oRight = rect.left + rect.width;
    const oBottom = rect.top + rect.height;
    const overlapsY = oBottom > self.top && rect.top < sBottom;
    const overlapsX = oRight > self.left && rect.left < sRight;
    const ok =
      direction === "left"
        ? ox < cx - 1 && overlapsY
        : direction === "right"
          ? ox > cx + 1 && overlapsY
          : direction === "up"
            ? oy < cy - 1 && overlapsX
            : oy > cy + 1 && overlapsX;
    if (!ok) continue;
    const dist = Math.hypot(ox - cx, oy - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = id;
    }
  }
  return best;
}

/**
 * Eagle grid keyboard move: swap the tile with the one a step away in the
 * order (left/right = one place, up/down = one row of `columns`). Unchanged
 * when the step would leave the grid or the id is not in the order.
 */
export function moveInOrder<T>(
  order: readonly T[],
  id: T,
  direction: MoveDirection,
  columns: number,
): T[] {
  const i = order.indexOf(id);
  if (i < 0) return [...order];
  const step = { left: -1, right: 1, up: -Math.max(1, columns), down: Math.max(1, columns) }[
    direction
  ];
  const j = i + step;
  if (j < 0 || j >= order.length) return [...order];
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * Eagle grid drop: insert `src` before/after `dest`, or swap the two.
 * Unchanged when either id is missing or they are the same tile.
 */
export function reorderTiles<T>(order: readonly T[], src: T, dest: T, zone: EagleDropZone): T[] {
  const next = [...order];
  const i = next.indexOf(src);
  const j = next.indexOf(dest);
  if (i < 0 || j < 0 || src === dest) return next;
  if (zone === "swap") {
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }
  next.splice(i, 1);
  const at = next.indexOf(dest) + (zone === "after" ? 1 : 0);
  next.splice(at, 0, src);
  return next;
}

/** The sizes a tile cycles through: normal → 2 wide → 2×2 → 2 tall → normal. */
export const TILE_SPAN_CYCLE: readonly TileSpan[] = [
  [1, 1],
  [2, 1],
  [2, 2],
  [1, 2],
];

export const DEFAULT_TILE_SPAN: TileSpan = [1, 1];

/** The next size in {@link TILE_SPAN_CYCLE}; an unknown size restarts at normal. */
export function nextTileSpan(span: TileSpan | undefined): TileSpan {
  const cur = span ?? DEFAULT_TILE_SPAN;
  const i = TILE_SPAN_CYCLE.findIndex((s) => s[0] === cur[0] && s[1] === cur[1]);
  return TILE_SPAN_CYCLE[(i + 1) % TILE_SPAN_CYCLE.length];
}

export function isDefaultSpan(span: TileSpan | undefined): boolean {
  return !span || (span[0] === 1 && span[1] === 1);
}

/** A tile can never be wider than the grid has columns. */
export function clampSpan(span: TileSpan | undefined, columns: number): TileSpan {
  const cur = span ?? DEFAULT_TILE_SPAN;
  return [Math.max(1, Math.min(cur[0], Math.max(1, columns))), Math.max(1, cur[1])];
}

/** Label such as "2×1" for the tile-size button. */
export function tileSpanLabel(span: TileSpan | undefined): string {
  const cur = span ?? DEFAULT_TILE_SPAN;
  return `${cur[0]}×${cur[1]}`;
}

/**
 * Column count when the user has not picked one: the square-ish grid Maestro
 * always used, never narrower than 2 once any tile is wider than one cell
 * (a 2-wide tile in a 1-column grid would overflow).
 */
export function eagleAutoColumns(cells: number, hasWideTile: boolean): number {
  const base = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, cells))));
  return hasWideTile ? Math.max(2, base) : base;
}
