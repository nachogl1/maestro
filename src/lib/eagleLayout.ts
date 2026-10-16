/**
 * Eagle view free grid. The grid is always EAGLE_UNITS × EAGLE_UNITS cells;
 * every tile has a place and a size in those cells, so one terminal can be
 * resized or moved without touching the others. Pure functions only — the
 * components hand in ids, counts and rects, so everything here is unit tested.
 */

import type { PaneEdge } from "./paneMoves";

/** Cells per axis. 60 divides evenly by 1–6 columns/rows (the automatic layouts). */
export const EAGLE_UNITS = 60;
/** Smallest tile on either axis, in cells (10% of the grid). */
export const MIN_TILE_UNITS = 6;

/** A tile's place and size in grid cells. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A tile the layout placed: a launched session or a pre-launch card (null id). */
export interface PlacedTile {
  sessionId: number | null;
  rect: TileRect;
}

export interface EagleLayout {
  /** Launched tiles by session id. */
  tiles: ReadonlyMap<number, TileRect>;
  /** Pre-launch card rects per workspace tab id, in card order. */
  pending: ReadonlyMap<string, readonly TileRect[]>;
  /** Every placed tile (sessions and cards) — the collision set for moves and resizes. */
  occupied: readonly PlacedTile[];
  /**
   * The stored rects could not be honoured (nothing could even be split to
   * make room), so the layout fell back to the automatic one. The caller
   * should clear the stored rects so the store agrees with what is shown.
   */
  reset: boolean;
}

export interface EagleLayoutInput {
  /** Visible launched sessions, in project tab order. */
  sessionIds: readonly number[];
  /** Visible pre-launch cards per workspace tab id, in tab order. */
  pendingByTab: readonly (readonly [tabId: string, count: number])[];
  /** The user's placements (empty = automatic layout). */
  stored: Readonly<Record<number, TileRect>>;
  units?: number;
}

export function rectsEqual(a: TileRect | undefined, b: TileRect | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export function rectsOverlap(a: TileRect, b: TileRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whole cells, at least the minimum size, and inside the grid. */
export function rectInGrid(r: TileRect, units: number = EAGLE_UNITS): boolean {
  return (
    Number.isInteger(r.x) &&
    Number.isInteger(r.y) &&
    Number.isInteger(r.w) &&
    Number.isInteger(r.h) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.w >= MIN_TILE_UNITS &&
    r.h >= MIN_TILE_UNITS &&
    r.x + r.w <= units &&
    r.y + r.h <= units
  );
}

/** Inside the grid and clear of every other tile. */
export function fitsFree(
  r: TileRect,
  others: readonly TileRect[],
  units: number = EAGLE_UNITS,
): boolean {
  return rectInGrid(r, units) && !others.some((o) => rectsOverlap(r, o));
}

/** Column count of the automatic layout: the square-ish grid Maestro always used. */
export function autoColumns(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))));
}

/**
 * The automatic layout: `count` tiles in a square-ish grid, row by row, each
 * tile an equal share of the width and height (the cells split as evenly as
 * whole numbers allow). An incomplete last row leaves its cells empty.
 */
export function autoPack(count: number, units: number = EAGLE_UNITS): TileRect[] {
  if (count <= 0) return [];
  const cols = autoColumns(count);
  const rows = Math.max(1, Math.ceil(count / cols));
  const xs = Array.from({ length: cols + 1 }, (_, i) => Math.round((i * units) / cols));
  const ys = Array.from({ length: rows + 1 }, (_, i) => Math.round((i * units) / rows));
  const out: TileRect[] = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: xs[c], y: ys[r], w: xs[c + 1] - xs[c], h: ys[r + 1] - ys[r] });
  }
  return out;
}

/**
 * The largest empty rectangle of the grid (by area), or null when every cell
 * is taken. Row-by-row histogram scan: O(units²).
 */
export function largestEmptyRect(
  occupied: readonly TileRect[],
  units: number = EAGLE_UNITS,
): TileRect | null {
  const taken = new Uint8Array(units * units);
  for (const r of occupied) {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(units, r.x + r.w);
    const y1 = Math.min(units, r.y + r.h);
    for (let y = y0; y < y1; y++) {
      taken.fill(1, y * units + x0, y * units + x1);
    }
  }
  const heights = new Int32Array(units);
  let best: TileRect | null = null;
  let bestArea = 0;
  for (let y = 0; y < units; y++) {
    for (let x = 0; x < units; x++) {
      heights[x] = taken[y * units + x] ? 0 : heights[x] + 1;
    }
    // Largest rectangle in the histogram `heights` (stack of rising columns).
    const stack: number[] = [];
    for (let x = 0; x <= units; x++) {
      const h = x === units ? 0 : heights[x];
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop() as number;
        const height = heights[top];
        const left = stack.length > 0 ? stack[stack.length - 1] + 1 : 0;
        const width = x - left;
        const area = width * height;
        if (area > bestArea) {
          bestArea = area;
          best = { x: left, y: y - height + 1, w: width, h: height };
        }
      }
      stack.push(x);
    }
  }
  return best;
}

/**
 * Where a tile new to a custom layout goes: the top-left corner of the
 * largest hole, no bigger than a tile of the automatic layout would be. When
 * no hole is big enough, the biggest tile gives up half its room (split along
 * its longer side). Null when not even that is possible.
 */
function placeNewTile(
  placed: PlacedTile[],
  total: number,
  units: number,
): { rect: TileRect; shrunk?: { index: number; rect: TileRect } } | null {
  const hole = largestEmptyRect(
    placed.map((p) => p.rect),
    units,
  );
  if (hole && hole.w >= MIN_TILE_UNITS && hole.h >= MIN_TILE_UNITS) {
    const cols = autoColumns(total);
    const rows = Math.max(1, Math.ceil(total / cols));
    const maxW = Math.max(MIN_TILE_UNITS, Math.round(units / cols));
    const maxH = Math.max(MIN_TILE_UNITS, Math.round(units / rows));
    return {
      rect: { x: hole.x, y: hole.y, w: Math.min(hole.w, maxW), h: Math.min(hole.h, maxH) },
    };
  }
  let bigIndex = -1;
  let bigArea = 0;
  placed.forEach((p, i) => {
    const area = p.rect.w * p.rect.h;
    if (area > bigArea) {
      bigArea = area;
      bigIndex = i;
    }
  });
  if (bigIndex < 0) return null;
  const big = placed[bigIndex].rect;
  if (big.w >= big.h) {
    if (big.w < 2 * MIN_TILE_UNITS) return null;
    const half = Math.floor(big.w / 2);
    return {
      rect: { x: big.x + half, y: big.y, w: big.w - half, h: big.h },
      shrunk: { index: bigIndex, rect: { ...big, w: half } },
    };
  }
  if (big.h < 2 * MIN_TILE_UNITS) return null;
  const half = Math.floor(big.h / 2);
  return {
    rect: { x: big.x, y: big.y + half, w: big.w, h: big.h - half },
    shrunk: { index: bigIndex, rect: { ...big, h: half } },
  };
}

function packed(
  sessionIds: readonly number[],
  pendingByTab: EagleLayoutInput["pendingByTab"],
  reset: boolean,
  units: number,
): EagleLayout {
  const total = sessionIds.length + pendingByTab.reduce((sum, [, n]) => sum + n, 0);
  const rects = autoPack(total, units);
  const tiles = new Map<number, TileRect>();
  const occupied: PlacedTile[] = [];
  let i = 0;
  for (const id of sessionIds) {
    tiles.set(id, rects[i]);
    occupied.push({ sessionId: id, rect: rects[i] });
    i++;
  }
  const pending = new Map<string, TileRect[]>();
  for (const [tabId, count] of pendingByTab) {
    const list: TileRect[] = [];
    for (let k = 0; k < count; k++) {
      list.push(rects[i]);
      occupied.push({ sessionId: null, rect: rects[i] });
      i++;
    }
    pending.set(tabId, list);
  }
  return { tiles, pending, occupied, reset };
}

/**
 * Lays out every visible tile. With no stored rects it is the automatic
 * square-ish grid. Otherwise each session keeps its stored rect when that
 * still fits (inside the grid, clear of the tiles placed before it); every
 * other tile — new sessions, cards, a tile whose old place is taken — goes
 * into the largest hole (see placeNewTile).
 */
export function layoutEagleTiles(input: EagleLayoutInput): EagleLayout {
  const { sessionIds, pendingByTab, stored } = input;
  const units = input.units ?? EAGLE_UNITS;
  if (Object.keys(stored).length === 0) return packed(sessionIds, pendingByTab, false, units);

  const total = sessionIds.length + pendingByTab.reduce((sum, [, n]) => sum + n, 0);
  const placed: PlacedTile[] = [];
  const place = (sessionId: number | null, wanted: TileRect | undefined): boolean => {
    if (
      wanted &&
      fitsFree(
        wanted,
        placed.map((p) => p.rect),
        units,
      )
    ) {
      placed.push({ sessionId, rect: wanted });
      return true;
    }
    const spot = placeNewTile(placed, total, units);
    if (!spot) return false;
    if (spot.shrunk)
      placed[spot.shrunk.index] = { ...placed[spot.shrunk.index], rect: spot.shrunk.rect };
    placed.push({ sessionId, rect: spot.rect });
    return true;
  };

  // Two passes: every stored rect that still fits is placed first, so a new
  // session earlier in the project order cannot push a later project's
  // tiles out of their places; then the rest go into the holes left.
  const unplaced: number[] = [];
  for (const id of sessionIds) {
    const wanted = stored[id];
    if (
      wanted &&
      fitsFree(
        wanted,
        placed.map((p) => p.rect),
        units,
      )
    ) {
      placed.push({ sessionId: id, rect: wanted });
    } else {
      unplaced.push(id);
    }
  }
  for (const id of unplaced) {
    if (!place(id, undefined)) return packed(sessionIds, pendingByTab, true, units);
  }
  const pending = new Map<string, TileRect[]>();
  for (const [tabId, count] of pendingByTab) {
    const list: TileRect[] = [];
    for (let k = 0; k < count; k++) {
      if (!place(null, undefined)) return packed(sessionIds, pendingByTab, true, units);
      list.push(placed[placed.length - 1].rect);
    }
    pending.set(tabId, list);
  }
  // Cards were appended after the sessions, so read them back from `placed`
  // (a split may have shrunk an earlier tile, so re-read the sessions too).
  const tiles = new Map<number, TileRect>();
  for (const p of placed) {
    if (p.sessionId !== null) tiles.set(p.sessionId, p.rect);
  }
  let cardIndex = sessionIds.length;
  for (const list of pending.values()) {
    for (let k = 0; k < list.length; k++) {
      list[k] = placed[cardIndex].rect;
      cardIndex++;
    }
  }
  return { tiles, pending, occupied: placed, reset: false };
}

/**
 * Drag one edge of a tile by `delta` cells. Only this tile changes: the edge
 * stops at the grid border, at the nearest tile in its way, and at the tile's
 * own minimum size.
 */
export function resizeTile(
  start: TileRect,
  edge: PaneEdge,
  delta: number,
  others: readonly TileRect[],
  units: number = EAGLE_UNITS,
): TileRect {
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  const besideRows = (o: TileRect) => o.y < bottom && start.y < o.y + o.h;
  const besideCols = (o: TileRect) => o.x < right && start.x < o.x + o.w;
  switch (edge) {
    case "right": {
      let max = units;
      for (const o of others) if (besideRows(o) && o.x >= right) max = Math.min(max, o.x);
      const next = Math.min(max, Math.max(start.x + MIN_TILE_UNITS, right + delta));
      return { ...start, w: next - start.x };
    }
    case "left": {
      let min = 0;
      for (const o of others)
        if (besideRows(o) && o.x + o.w <= start.x) min = Math.max(min, o.x + o.w);
      const next = Math.max(min, Math.min(right - MIN_TILE_UNITS, start.x + delta));
      return { ...start, x: next, w: right - next };
    }
    case "bottom": {
      let max = units;
      for (const o of others) if (besideCols(o) && o.y >= bottom) max = Math.min(max, o.y);
      const next = Math.min(max, Math.max(start.y + MIN_TILE_UNITS, bottom + delta));
      return { ...start, h: next - start.y };
    }
    case "top": {
      let min = 0;
      for (const o of others)
        if (besideCols(o) && o.y + o.h <= start.y) min = Math.max(min, o.y + o.h);
      const next = Math.max(min, Math.min(bottom - MIN_TILE_UNITS, start.y + delta));
      return { ...start, y: next, h: bottom - next };
    }
  }
}

/**
 * The rect a dragged tile would take with its centre on cell (cx, cy): same
 * size, pulled back inside the grid. The caller checks it is free.
 */
export function placeTileAt(
  size: TileRect,
  cx: number,
  cy: number,
  units: number = EAGLE_UNITS,
): TileRect {
  const x = Math.min(units - size.w, Math.max(0, Math.round(cx - size.w / 2)));
  const y = Math.min(units - size.h, Math.max(0, Math.round(cy - size.h / 2)));
  return { x, y, w: size.w, h: size.h };
}

/** Row-major reading order of the tiles (top to bottom, then left to right). */
export function compareRowMajor(a: TileRect, b: TileRect): number {
  return a.y - b.y || a.x - b.x;
}
