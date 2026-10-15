import { describe, expect, it } from "vitest";

import {
  clampSpan,
  eagleAutoColumns,
  eagleDropZone,
  moveInOrder,
  neighbourInDirection,
  nextTileSpan,
  paneDropZone,
  reorderTiles,
  stageEdgeAt,
  tileSpanLabel,
} from "../paneMoves";

const rect = { left: 100, top: 100, width: 400, height: 200 };

describe("paneDropZone", () => {
  it("maps the outer quarters to edges and the middle to swap", () => {
    expect(paneDropZone(rect, 110, 200)).toBe("left");
    expect(paneDropZone(rect, 490, 200)).toBe("right");
    expect(paneDropZone(rect, 300, 110)).toBe("top");
    expect(paneDropZone(rect, 300, 290)).toBe("bottom");
    expect(paneDropZone(rect, 300, 200)).toBe("swap");
  });

  it("lets left/right win in the corners", () => {
    expect(paneDropZone(rect, 110, 110)).toBe("left");
  });

  it("falls back to swap for a zero-size pane", () => {
    expect(paneDropZone({ ...rect, width: 0 }, 100, 100)).toBe("swap");
  });
});

describe("eagleDropZone", () => {
  it("maps the outer thirds to before/after and the middle to swap", () => {
    expect(eagleDropZone(rect, 150)).toBe("before");
    expect(eagleDropZone(rect, 450)).toBe("after");
    expect(eagleDropZone(rect, 300)).toBe("swap");
  });
});

describe("stageEdgeAt", () => {
  it("finds the edge band inside and just outside the area", () => {
    expect(stageEdgeAt(rect, 105, 200)).toBe("left");
    expect(stageEdgeAt(rect, 95, 200)).toBe("left");
    expect(stageEdgeAt(rect, 495, 200)).toBe("right");
    expect(stageEdgeAt(rect, 300, 105)).toBe("top");
    expect(stageEdgeAt(rect, 300, 295)).toBe("bottom");
  });

  it("returns null in the middle and far outside", () => {
    expect(stageEdgeAt(rect, 300, 200)).toBeNull();
    expect(stageEdgeAt(rect, 50, 200)).toBeNull();
  });
});

describe("neighbourInDirection", () => {
  // Layout: A | B over C (B and C stacked in the right column)
  const a = { left: 0, top: 0, width: 100, height: 200 };
  const b = { left: 100, top: 0, width: 100, height: 100 };
  const c = { left: 100, top: 100, width: 100, height: 100 };
  const others = (self: "a" | "b" | "c") =>
    (
      [
        { id: "a", rect: a },
        { id: "b", rect: b },
        { id: "c", rect: c },
      ] as const
    ).filter((o) => o.id !== self);

  it("picks the nearest pane on that side that shares the other axis", () => {
    expect(neighbourInDirection(a, others("a"), "right")).toBe("b");
    expect(neighbourInDirection(b, others("b"), "down")).toBe("c");
    expect(neighbourInDirection(c, others("c"), "up")).toBe("b");
    expect(neighbourInDirection(c, others("c"), "left")).toBe("a");
  });

  it("returns null when nothing is in that direction", () => {
    expect(neighbourInDirection(a, others("a"), "left")).toBeNull();
    expect(neighbourInDirection(a, others("a"), "up")).toBeNull();
    expect(neighbourInDirection(b, others("b"), "up")).toBeNull();
  });
});

describe("moveInOrder", () => {
  const order = [1, 2, 3, 4, 5, 6];

  it("swaps one place sideways and one row vertically", () => {
    expect(moveInOrder(order, 2, "right", 3)).toEqual([1, 3, 2, 4, 5, 6]);
    expect(moveInOrder(order, 2, "left", 3)).toEqual([2, 1, 3, 4, 5, 6]);
    expect(moveInOrder(order, 2, "down", 3)).toEqual([1, 5, 3, 4, 2, 6]);
    expect(moveInOrder(order, 5, "up", 3)).toEqual([1, 5, 3, 4, 2, 6]);
  });

  it("leaves the order alone at the grid's edge or for an unknown id", () => {
    expect(moveInOrder(order, 1, "left", 3)).toEqual(order);
    expect(moveInOrder(order, 6, "down", 3)).toEqual(order);
    expect(moveInOrder(order, 42, "right", 3)).toEqual(order);
  });
});

describe("reorderTiles", () => {
  const order = ["a", "b", "c", "d"];

  it("inserts before or after the target", () => {
    expect(reorderTiles(order, "a", "c", "before")).toEqual(["b", "a", "c", "d"]);
    expect(reorderTiles(order, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(reorderTiles(order, "d", "a", "before")).toEqual(["d", "a", "b", "c"]);
  });

  it("swaps the two tiles", () => {
    expect(reorderTiles(order, "a", "d", "swap")).toEqual(["d", "b", "c", "a"]);
  });

  it("ignores a drop on itself or on an unknown tile", () => {
    expect(reorderTiles(order, "a", "a", "after")).toEqual(order);
    expect(reorderTiles(order, "a", "zz", "after")).toEqual(order);
  });
});

describe("tile spans", () => {
  it("cycles normal → wide → big → tall → normal", () => {
    expect(nextTileSpan(undefined)).toEqual([2, 1]);
    expect(nextTileSpan([2, 1])).toEqual([2, 2]);
    expect(nextTileSpan([2, 2])).toEqual([1, 2]);
    expect(nextTileSpan([1, 2])).toEqual([1, 1]);
  });

  it("clamps the width to the column count", () => {
    expect(clampSpan([2, 2], 1)).toEqual([1, 2]);
    expect(clampSpan([2, 1], 3)).toEqual([2, 1]);
  });

  it("labels the size", () => {
    expect(tileSpanLabel(undefined)).toBe("1×1");
    expect(tileSpanLabel([2, 2])).toBe("2×2");
  });
});

describe("eagleAutoColumns", () => {
  it("keeps the square-ish grid and never goes below 2 with a wide tile", () => {
    expect(eagleAutoColumns(1, false)).toBe(1);
    expect(eagleAutoColumns(1, true)).toBe(2);
    expect(eagleAutoColumns(6, false)).toBe(3);
    expect(eagleAutoColumns(10, false)).toBe(4);
  });
});
