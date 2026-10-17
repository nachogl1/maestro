import { describe, expect, it } from "vitest";

import {
  autoPack,
  compareRowMajor,
  dropBesideTile,
  EAGLE_UNITS,
  fitsFree,
  insertColumnAtEdge,
  largestEmptyRect,
  layoutEagleTiles,
  MIN_TILE_UNITS,
  placeTileAt,
  rectsOverlap,
  resizeTile,
  type TileRect,
} from "../eagleLayout";
import { STAGE_EDGE_RATIO } from "../paneMoves";

const U = EAGLE_UNITS;

describe("autoPack", () => {
  it("fills the grid with a square-ish layout of equal tiles", () => {
    expect(autoPack(1)).toEqual([{ x: 0, y: 0, w: U, h: U }]);
    expect(autoPack(2)).toEqual([
      { x: 0, y: 0, w: 30, h: U },
      { x: 30, y: 0, w: 30, h: U },
    ]);
    const five = autoPack(5);
    expect(five).toHaveLength(5);
    // 3 columns × 2 rows; the last row is incomplete.
    expect(five[0]).toEqual({ x: 0, y: 0, w: 20, h: 30 });
    expect(five[2]).toEqual({ x: 40, y: 0, w: 20, h: 30 });
    expect(five[4]).toEqual({ x: 20, y: 30, w: 20, h: 30 });
  });

  it("splits the cells as evenly as whole numbers allow for 7 columns", () => {
    const rects = autoPack(49);
    const widths = rects.slice(0, 7).map((r) => r.w);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(U);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });
});

describe("largestEmptyRect", () => {
  it("finds the biggest hole and null when the grid is full", () => {
    expect(largestEmptyRect([])).toEqual({ x: 0, y: 0, w: U, h: U });
    expect(largestEmptyRect([{ x: 0, y: 0, w: U, h: U }])).toBeNull();
    const hole = largestEmptyRect([
      { x: 0, y: 0, w: 30, h: U },
      { x: 30, y: 0, w: 30, h: 20 },
    ]);
    expect(hole).toEqual({ x: 30, y: 20, w: 30, h: 40 });
  });
});

describe("layoutEagleTiles", () => {
  it("uses the automatic layout when nothing is stored, cards after sessions", () => {
    const layout = layoutEagleTiles({
      sessionIds: [7, 8],
      pendingByTab: [["tab-a", 1]],
      stored: {},
    });
    const auto = autoPack(3);
    expect(layout.tiles.get(7)).toEqual(auto[0]);
    expect(layout.tiles.get(8)).toEqual(auto[1]);
    expect(layout.pending.get("tab-a")).toEqual([auto[2]]);
    expect(layout.occupied).toHaveLength(3);
    expect(layout.reset).toBe(false);
  });

  it("keeps stored rects and drops a new tile into the largest hole, default-sized", () => {
    const stored: Record<number, TileRect> = {
      1: { x: 0, y: 0, w: 30, h: U },
      2: { x: 30, y: 0, w: 30, h: 30 },
    };
    const layout = layoutEagleTiles({ sessionIds: [1, 2, 3], pendingByTab: [], stored });
    expect(layout.tiles.get(1)).toEqual(stored[1]);
    expect(layout.tiles.get(2)).toEqual(stored[2]);
    // The hole is 30×30 at (30,30); a 3-tile automatic layout (2×2) also gives 30×30.
    expect(layout.tiles.get(3)).toEqual({ x: 30, y: 30, w: 30, h: 30 });
    expect(layout.reset).toBe(false);
  });

  it("splits the biggest tile when the grid has no room left", () => {
    const stored: Record<number, TileRect> = {
      1: { x: 0, y: 0, w: 40, h: U },
      2: { x: 40, y: 0, w: 20, h: U },
    };
    const layout = layoutEagleTiles({ sessionIds: [1, 2, 3], pendingByTab: [], stored });
    // Tile 1 is taller than wide, so it is split top/bottom.
    expect(layout.tiles.get(1)).toEqual({ x: 0, y: 0, w: 40, h: 30 });
    expect(layout.tiles.get(3)).toEqual({ x: 0, y: 30, w: 40, h: 30 });
    expect(layout.tiles.get(2)).toEqual(stored[2]);
    expect(layout.reset).toBe(false);
  });

  it("places a new session in the hole without moving later projects' stored tiles", () => {
    const stored: Record<number, TileRect> = {
      1: { x: 0, y: 0, w: 19, h: 30 },
      2: { x: 30, y: 0, w: 30, h: 30 },
      3: { x: 0, y: 30, w: 30, h: 30 },
      4: { x: 30, y: 30, w: 30, h: 30 },
    };
    // Session 5 belongs to the first project, so it comes before 3 and 4 in the order.
    const layout = layoutEagleTiles({ sessionIds: [1, 2, 5, 3, 4], pendingByTab: [], stored });
    expect(layout.tiles.get(3)).toEqual(stored[3]);
    expect(layout.tiles.get(4)).toEqual(stored[4]);
    expect(layout.tiles.get(5)).toEqual({ x: 19, y: 0, w: 11, h: 30 });
  });

  it("re-places a stored rect that collides with an earlier tile", () => {
    const stored: Record<number, TileRect> = {
      1: { x: 0, y: 0, w: 30, h: U },
      2: { x: 10, y: 0, w: 30, h: U },
    };
    const layout = layoutEagleTiles({ sessionIds: [1, 2], pendingByTab: [], stored });
    expect(layout.tiles.get(1)).toEqual(stored[1]);
    expect(layout.tiles.get(2)).toEqual({ x: 30, y: 0, w: 30, h: U });
  });

  it("falls back to the automatic layout and asks for a reset when nothing can be split", () => {
    // 100 stored tiles of the minimum size leave no room and nothing splittable.
    const stored: Record<number, TileRect> = {};
    const ids: number[] = [];
    let id = 1;
    for (let y = 0; y < U; y += MIN_TILE_UNITS) {
      for (let x = 0; x < U; x += MIN_TILE_UNITS) {
        stored[id] = { x, y, w: MIN_TILE_UNITS, h: MIN_TILE_UNITS };
        ids.push(id);
        id++;
      }
    }
    ids.push(id);
    const layout = layoutEagleTiles({ sessionIds: ids, pendingByTab: [], stored });
    expect(layout.reset).toBe(true);
    expect(layout.tiles.size).toBe(ids.length);
  });
});

describe("resizeTile", () => {
  const others: TileRect[] = [
    { x: 30, y: 0, w: 30, h: 30 }, // right of the tile, top half
    { x: 0, y: 40, w: 30, h: 20 }, // below the tile
  ];
  const tile: TileRect = { x: 0, y: 0, w: 30, h: 30 };

  it("grows and shrinks the right edge within the grid and up to the next tile", () => {
    expect(resizeTile(tile, "right", 5, [])).toEqual({ ...tile, w: 35 });
    expect(resizeTile(tile, "right", 50, [])).toEqual({ ...tile, w: U });
    expect(resizeTile(tile, "right", 5, others)).toEqual(tile);
    expect(resizeTile(tile, "right", -100, others)).toEqual({ ...tile, w: MIN_TILE_UNITS });
  });

  it("grows the bottom edge into the gap and stops at the tile below", () => {
    expect(resizeTile(tile, "bottom", 20, others)).toEqual({ ...tile, h: 40 });
    expect(resizeTile(tile, "bottom", 4, others)).toEqual({ ...tile, h: 34 });
  });

  it("moves the left and top edges, keeping the far edge in place", () => {
    const inner: TileRect = { x: 20, y: 20, w: 20, h: 20 };
    expect(resizeTile(inner, "left", -10, [])).toEqual({ x: 10, y: 20, w: 30, h: 20 });
    expect(resizeTile(inner, "top", 30, [])).toEqual({ x: 20, y: 34, w: 20, h: MIN_TILE_UNITS });
    const blocker: TileRect = { x: 0, y: 20, w: 15, h: 20 };
    expect(resizeTile(inner, "left", -10, [blocker])).toEqual({ x: 15, y: 20, w: 25, h: 20 });
  });
});

describe("placeTileAt / fitsFree", () => {
  it("centres the tile on the cell and keeps it inside the grid", () => {
    const size: TileRect = { x: 0, y: 0, w: 20, h: 10 };
    expect(placeTileAt(size, 30, 30)).toEqual({ x: 20, y: 25, w: 20, h: 10 });
    expect(placeTileAt(size, 0, 0)).toEqual({ x: 0, y: 0, w: 20, h: 10 });
    expect(placeTileAt(size, U, U)).toEqual({ x: 40, y: 50, w: 20, h: 10 });
  });

  it("rejects a rect that overlaps another tile or leaves the grid", () => {
    const other: TileRect = { x: 0, y: 0, w: 30, h: 30 };
    expect(fitsFree({ x: 30, y: 0, w: 30, h: 30 }, [other])).toBe(true);
    expect(fitsFree({ x: 20, y: 0, w: 30, h: 30 }, [other])).toBe(false);
    expect(fitsFree({ x: 40, y: 0, w: 30, h: 30 }, [])).toBe(false);
    expect(rectsOverlap(other, { x: 29, y: 29, w: 5, h: 5 })).toBe(true);
    expect(rectsOverlap(other, { x: 30, y: 0, w: 5, h: 5 })).toBe(false);
  });
});

describe("compareRowMajor", () => {
  it("orders top to bottom, then left to right", () => {
    const rects: TileRect[] = [
      { x: 30, y: 0, w: 30, h: 30 },
      { x: 0, y: 30, w: 30, h: 30 },
      { x: 0, y: 0, w: 30, h: 30 },
    ];
    expect([...rects].sort(compareRowMajor)).toEqual([rects[2], rects[0], rects[1]]);
  });
});

/** Every tile is whole-celled, at least the minimum size, inside the grid and clear of the rest. */
function expectValidLayout(tiles: ReadonlyMap<number, TileRect>): void {
  const rects = [...tiles.values()];
  rects.forEach((r, i) => {
    expect(
      fitsFree(
        r,
        rects.filter((_, j) => j !== i),
      ),
    ).toBe(true);
  });
}

describe("dropBesideTile", () => {
  // Three tiles auto-packed 2×2: 00, 01 and 10.
  const tiles = new Map<number, TileRect>([
    [1, { x: 0, y: 0, w: 30, h: 30 }],
    [2, { x: 30, y: 0, w: 30, h: 30 }],
    [3, { x: 0, y: 30, w: 30, h: 30 }],
  ]);

  it("puts the dragged tile in the target's left half and keeps the target in the right half", () => {
    const next = dropBesideTile(tiles, 3, 2, "left");
    expect(next).not.toBeNull();
    expect(next?.get(3)).toEqual({ x: 30, y: 0, w: 15, h: 30 });
    expect(next?.get(2)).toEqual({ x: 45, y: 0, w: 15, h: 30 });
    expect(next?.get(1)).toEqual(tiles.get(1));
    expectValidLayout(next as Map<number, TileRect>);
  });

  it("handles the right, top and bottom sides", () => {
    expect(dropBesideTile(tiles, 3, 2, "right")?.get(3)).toEqual({ x: 45, y: 0, w: 15, h: 30 });
    expect(dropBesideTile(tiles, 3, 2, "right")?.get(2)).toEqual({ x: 30, y: 0, w: 15, h: 30 });
    expect(dropBesideTile(tiles, 3, 2, "top")?.get(3)).toEqual({ x: 30, y: 0, w: 30, h: 15 });
    expect(dropBesideTile(tiles, 3, 2, "top")?.get(2)).toEqual({ x: 30, y: 15, w: 30, h: 15 });
    expect(dropBesideTile(tiles, 3, 2, "bottom")?.get(3)).toEqual({ x: 30, y: 15, w: 30, h: 15 });
    expect(dropBesideTile(tiles, 3, 2, "bottom")?.get(2)).toEqual({ x: 30, y: 0, w: 30, h: 15 });
  });

  it("splits an odd size into whole cells, the target keeping the larger part", () => {
    const odd = new Map<number, TileRect>([
      [1, { x: 0, y: 0, w: 13, h: 60 }],
      [2, { x: 13, y: 0, w: 47, h: 60 }],
    ]);
    const next = dropBesideTile(odd, 2, 1, "right");
    expect(next?.get(2)).toEqual({ x: 7, y: 0, w: 6, h: 60 });
    expect(next?.get(1)).toEqual({ x: 0, y: 0, w: 7, h: 60 });
  });

  it("is invalid when the half would be smaller than the minimum tile size", () => {
    const narrow = new Map<number, TileRect>([
      [1, { x: 0, y: 0, w: 2 * MIN_TILE_UNITS - 1, h: 60 }],
      [2, { x: 11, y: 0, w: 49, h: 60 }],
    ]);
    expect(dropBesideTile(narrow, 2, 1, "left")).toBeNull();
    expect(dropBesideTile(narrow, 2, 1, "right")).toBeNull();
    // Height is fine, so top/bottom still work.
    expect(dropBesideTile(narrow, 2, 1, "top")).not.toBeNull();
  });

  it("is invalid for an unknown tile or a drop onto itself", () => {
    expect(dropBesideTile(tiles, 3, 3, "left")).toBeNull();
    expect(dropBesideTile(tiles, 3, 99, "left")).toBeNull();
    expect(dropBesideTile(tiles, 99, 3, "left")).toBeNull();
  });
});

describe("insertColumnAtEdge", () => {
  const tiles = new Map<number, TileRect>([
    [1, { x: 0, y: 0, w: 30, h: 30 }],
    [2, { x: 30, y: 0, w: 30, h: 30 }],
    [3, { x: 0, y: 30, w: 30, h: 30 }],
  ]);
  const share = Math.round(STAGE_EDGE_RATIO * U);

  it("moves the third of a 2×2 pack to a new full-height column on the right", () => {
    const next = insertColumnAtEdge(tiles, 3, "right");
    expect(next).not.toBeNull();
    expect(share).toBe(20);
    expect(next?.get(3)).toEqual({ x: U - share, y: 0, w: share, h: U });
    expect(next?.get(1)).toEqual({ x: 0, y: 0, w: 20, h: 30 });
    expect(next?.get(2)).toEqual({ x: 20, y: 0, w: 20, h: 30 });
    expectValidLayout(next as Map<number, TileRect>);
  });

  it("inserts a column on the left, shifting the others right", () => {
    const next = insertColumnAtEdge(tiles, 3, "left");
    expect(next?.get(3)).toEqual({ x: 0, y: 0, w: share, h: U });
    expect(next?.get(1)).toEqual({ x: share, y: 0, w: 20, h: 30 });
    expect(next?.get(2)).toEqual({ x: share + 20, y: 0, w: 20, h: 30 });
    expectValidLayout(next as Map<number, TileRect>);
  });

  it("inserts a full-width row at the top or bottom, scaling the others vertically", () => {
    const top = insertColumnAtEdge(tiles, 3, "top");
    expect(top?.get(3)).toEqual({ x: 0, y: 0, w: U, h: share });
    expect(top?.get(1)).toEqual({ x: 0, y: share, w: 30, h: 20 });
    expect(top?.get(2)).toEqual({ x: 30, y: share, w: 30, h: 20 });
    expectValidLayout(top as Map<number, TileRect>);
    const bottom = insertColumnAtEdge(tiles, 3, "bottom");
    expect(bottom?.get(3)).toEqual({ x: 0, y: U - share, w: U, h: share });
    expect(bottom?.get(1)).toEqual({ x: 0, y: 0, w: 30, h: 20 });
    expectValidLayout(bottom as Map<number, TileRect>);
  });

  it("keeps neighbouring tiles touching after scaling (no gaps, no overlaps)", () => {
    const seven = new Map<number, TileRect>(autoPack(7).map((r, i) => [i + 1, r]));
    const next = insertColumnAtEdge(seven, 7, "right");
    expect(next).not.toBeNull();
    expectValidLayout(next as Map<number, TileRect>);
    const row = [1, 2, 3].map((id) => next?.get(id) as TileRect);
    expect(row[0].x + row[0].w).toBe(row[1].x);
    expect(row[1].x + row[1].w).toBe(row[2].x);
    expect(row[2].x + row[2].w).toBe(U - share);
  });

  it("is invalid when scaling would make a tile smaller than the minimum", () => {
    const skinny = new Map<number, TileRect>([
      [1, { x: 0, y: 0, w: MIN_TILE_UNITS, h: 60 }],
      [2, { x: MIN_TILE_UNITS, y: 0, w: U - MIN_TILE_UNITS, h: 60 }],
    ]);
    expect(insertColumnAtEdge(skinny, 2, "right")).toBeNull();
    expect(insertColumnAtEdge(skinny, 2, "top")).not.toBeNull();
  });

  it("is invalid for an unknown tile", () => {
    expect(insertColumnAtEdge(tiles, 99, "right")).toBeNull();
  });
});
