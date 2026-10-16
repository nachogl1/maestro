/**
 * Pure helpers behind "move a terminal wherever you like": where a dragged
 * pane would land, which neighbour a keyboard move targets, and the eagle
 * view keyboard moves. Nothing here touches the DOM — the
 * callers hand in rectangles and ids so this can be unit tested.
 */

/** An edge of a pane or of the whole split area. */
export type PaneEdge = "left" | "right" | "top" | "bottom";

/** Where a drop lands on a pane of the split (per-project) layout. */
export type PaneDropZone = PaneEdge | "swap";

/** Direction of a keyboard move. */
export type MoveDirection = "left" | "right" | "up" | "down";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Share of a pane's width/height that counts as its edge for a drop. */
const PANE_EDGE_SHARE = 0.25;
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
