import { describe, expect, it } from "vitest";
import {
  buildGridTree,
  collectSlotIds,
  createLeaf,
  equalizeTree,
  gridDimensions,
  MAX_SESSIONS,
  moveSlotToSide,
  moveSlotToTreeEdge,
  removeLeaf,
  splitLeaf,
  swapSlots,
  type TreeNode,
  tidyIntoRow,
  updateRatio,
} from "../splitTree";

describe("gridDimensions", () => {
  it("keeps the classic layouts for 1-6 panes", () => {
    expect(gridDimensions(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridDimensions(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridDimensions(3)).toEqual({ cols: 3, rows: 1 });
    expect(gridDimensions(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridDimensions(5)).toEqual({ cols: 3, rows: 2 });
    expect(gridDimensions(6)).toEqual({ cols: 3, rows: 2 });
  });

  it("always provides enough cells for every pane (no silently dropped panes)", () => {
    for (let count = 1; count <= 16; count++) {
      const { cols, rows } = gridDimensions(count);
      expect(cols * rows).toBeGreaterThanOrEqual(count);
    }
  });

  it("uses square-ish grids beyond 6 panes", () => {
    expect(gridDimensions(9)).toEqual({ cols: 3, rows: 3 });
    expect(gridDimensions(12)).toEqual({ cols: 4, rows: 3 });
  });
});

describe("buildGridTree", () => {
  it("places every slot in the tree up to MAX_SESSIONS", () => {
    for (let count = 1; count <= MAX_SESSIONS; count++) {
      const ids = Array.from({ length: count }, (_, i) => `s${i}`);
      expect(collectSlotIds(buildGridTree(ids))).toEqual(ids);
    }
  });
});

describe("swapSlots", () => {
  it("swaps two leaves in a 2-pane horizontal split", () => {
    const tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    const swapped = swapSlots(tree, "a", "b");

    expect(collectSlotIds(swapped)).toEqual(["b", "a"]);
  });

  it("preserves split ratio when swapping (does not rebuild layout)", () => {
    let tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    if (tree.type !== "split") throw new Error("expected split node");
    tree = updateRatio(tree, tree.id, 0.7);

    const swapped = swapSlots(tree, "a", "b");
    if (swapped.type !== "split") throw new Error("expected split node");

    expect(swapped.ratio).toBe(0.7);
  });

  it("returns the original tree when swapping a slot with itself", () => {
    const tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    const result = swapSlots(tree, "a", "a");
    expect(result).toBe(tree);
  });

  it("returns the original tree if either slot is not present", () => {
    const tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    expect(swapSlots(tree, "a", "missing")).toBe(tree);
    expect(swapSlots(tree, "missing", "b")).toBe(tree);
  });

  it("swaps correctly inside a deep tree without disturbing ordering elsewhere", () => {
    // Build a 4-pane grid: [a, b], [c, d]
    const tree = buildGridTree(["a", "b", "c", "d"]);
    expect(collectSlotIds(tree)).toEqual(["a", "b", "c", "d"]);

    const swapped = swapSlots(tree, "b", "c");
    expect(collectSlotIds(swapped)).toEqual(["a", "c", "b", "d"]);
  });

  it("does not mutate the input tree", () => {
    const tree = splitLeaf(createLeaf("a"), "a", "b", "vertical");
    const before = collectSlotIds(tree).join(",");
    swapSlots(tree, "a", "b");
    expect(collectSlotIds(tree).join(",")).toBe(before);
  });

  it("survives sibling removal afterwards", () => {
    let tree = buildGridTree(["a", "b", "c"]);
    tree = swapSlots(tree, "a", "c");
    expect(collectSlotIds(tree)).toEqual(["c", "b", "a"]);

    const after = removeLeaf(tree, "b");
    expect(after).not.toBeNull();
    if (!after) throw new Error("expected removeLeaf to return a tree");
    expect(collectSlotIds(after)).toEqual(["c", "a"]);
  });
});

describe("moveSlotToSide", () => {
  // a | (b over c)
  const tree = (): TreeNode => ({
    type: "split",
    id: "root",
    direction: "vertical",
    ratio: 0.5,
    children: [
      createLeaf("a"),
      {
        type: "split",
        id: "right",
        direction: "horizontal",
        ratio: 0.5,
        children: [createLeaf("b"), createLeaf("c")],
      },
    ],
  });

  it("takes the moved pane out and splits the target on the given side", () => {
    const after = moveSlotToSide(tree(), "a", "c", "bottom");
    // a's old sibling (the b/c stack) is promoted to the root.
    expect(after.type).toBe("split");
    if (after.type !== "split") throw new Error("expected split root");
    expect(after.direction).toBe("horizontal");
    expect(collectSlotIds(after)).toEqual(["b", "c", "a"]);
    const cSplit = after.children[1];
    expect(cSplit.type).toBe("split");
    if (cSplit.type !== "split") throw new Error("expected c to be split");
    expect(cSplit.direction).toBe("horizontal");
    expect(cSplit.ratio).toBe(0.5);
    expect(collectSlotIds(cSplit)).toEqual(["c", "a"]);
  });

  it("puts the moved pane first for left/top and second for right/bottom", () => {
    expect(collectSlotIds(moveSlotToSide(tree(), "a", "b", "left"))).toEqual(["a", "b", "c"]);
    expect(collectSlotIds(moveSlotToSide(tree(), "a", "b", "right"))).toEqual(["b", "a", "c"]);
    const left = moveSlotToSide(tree(), "c", "a", "left");
    expect(left.type).toBe("split");
    if (left.type !== "split") throw new Error("expected split root");
    expect(left.children[0].type).toBe("split");
    if (left.children[0].type !== "split") throw new Error("expected a to be split");
    expect(left.children[0].direction).toBe("vertical");
  });

  it("keeps the tree for a missing slot or a self-drop", () => {
    const t = tree();
    expect(moveSlotToSide(t, "a", "a", "left")).toBe(t);
    expect(moveSlotToSide(t, "zz", "a", "left")).toBe(t);
    expect(moveSlotToSide(t, "a", "zz", "left")).toBe(t);
  });
});

describe("moveSlotToTreeEdge", () => {
  it("makes the pane a full column or row beside everything else", () => {
    const t: TreeNode = {
      type: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      children: [createLeaf("a"), createLeaf("b")],
    };
    const right = moveSlotToTreeEdge(t, "a", "right");
    expect(right.type).toBe("split");
    if (right.type !== "split") throw new Error("expected split root");
    expect(right.direction).toBe("vertical");
    expect(collectSlotIds(right)).toEqual(["b", "a"]);
    expect(right.ratio).toBeCloseTo(0.67);

    const top = moveSlotToTreeEdge(t, "b", "top", 0.25);
    if (top.type !== "split") throw new Error("expected split root");
    expect(top.direction).toBe("horizontal");
    expect(collectSlotIds(top)).toEqual(["b", "a"]);
    expect(top.ratio).toBe(0.25);
  });

  it("keeps a single pane or a missing slot unchanged", () => {
    const single = createLeaf("a");
    expect(moveSlotToTreeEdge(single, "a", "left")).toBe(single);
    const t: TreeNode = {
      type: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      children: [createLeaf("a"), createLeaf("b")],
    };
    expect(moveSlotToTreeEdge(t, "zz", "left")).toBe(t);
  });
});

describe("equalizeTree", () => {
  it("leaves a single leaf untouched", () => {
    const single = createLeaf("a");
    expect(equalizeTree(single)).toBe(single);
  });

  it("resets a lopsided two-pane split to an even share", () => {
    const t: TreeNode = {
      type: "split",
      id: "root",
      direction: "vertical",
      ratio: 0.8,
      children: [createLeaf("a"), createLeaf("b")],
    };
    const even = equalizeTree(t);
    if (even.type !== "split") throw new Error("expected split root");
    expect(even.ratio).toBe(0.5);
    expect(collectSlotIds(even)).toEqual(["a", "b"]);
  });

  it("weights each side by its pane count so every pane gets the same room", () => {
    // [a | [b | c]] with a hogging 70%: a should end at 1/3, b and c at 1/3 each.
    const t: TreeNode = {
      type: "split",
      id: "root",
      direction: "vertical",
      ratio: 0.7,
      children: [
        createLeaf("a"),
        {
          type: "split",
          id: "inner",
          direction: "vertical",
          ratio: 0.2,
          children: [createLeaf("b"), createLeaf("c")],
        },
      ],
    };
    const even = equalizeTree(t);
    if (even.type !== "split") throw new Error("expected split root");
    expect(even.ratio).toBeCloseTo(1 / 3);
    const inner = even.children[1];
    if (inner.type !== "split") throw new Error("expected inner split");
    expect(inner.ratio).toBe(0.5);
  });

  it("keeps the arrangement, node ids and directions; only ratios change", () => {
    // d moved to the left edge of [a b / c d]: d | ([a b] / c). The right side
    // is two columns wide (a, b), so d gets one column of three.
    const t = moveSlotToTreeEdge(buildGridTree(["a", "b", "c", "d"]), "d", "left", 0.2);
    const even = equalizeTree(t);
    expect(collectSlotIds(even)).toEqual(collectSlotIds(t));
    if (even.type !== "split" || t.type !== "split") throw new Error("expected split root");
    expect(even.id).toBe(t.id);
    expect(even.direction).toBe(t.direction);
    expect(even.ratio).toBeCloseTo(1 / 3);
    const right = even.children[1];
    if (right.type !== "split") throw new Error("expected right split");
    // [a b] over c: one row each, so the same height.
    expect(right.ratio).toBe(0.5);
  });

  it("gives every row the same height when the last row has fewer panes", () => {
    // 5 panes: a row of 3 over a row of 2, squashed to 80/20 by a drag.
    const five = buildGridTree(["a", "b", "c", "d", "e"]);
    if (five.type !== "split") throw new Error("expected split root");
    const even = equalizeTree({ ...five, ratio: 0.8 });
    if (even.type !== "split") throw new Error("expected split root");
    expect(even.direction).toBe("horizontal");
    expect(even.ratio).toBe(0.5);

    // 7 panes: rows of 3, 3 and 1 — the lone pane's row is as tall as the others.
    const seven = equalizeTree(buildGridTree(["a", "b", "c", "d", "e", "f", "g"]));
    if (seven.type !== "split") throw new Error("expected split root");
    expect(seven.ratio).toBeCloseTo(2 / 3);
  });

  it("returns the same tree when every ratio is already even", () => {
    const t = buildGridTree(["a", "b", "c", "d"]);
    expect(equalizeTree(t)).toBe(t);
  });

  it("does not mutate the input tree", () => {
    const t: TreeNode = {
      type: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.9,
      children: [createLeaf("a"), createLeaf("b")],
    };
    equalizeTree(t);
    expect(t.ratio).toBe(0.9);
  });
});

describe("tidyIntoRow", () => {
  /** Each pane's [width, height] share of the layout, in layout order. */
  function paneShares(node: TreeNode, w = 1, h = 1): [string, number, number][] {
    if (node.type === "leaf") return [[node.slotId, w, h]];
    const [a, b] = node.children;
    const r = node.ratio;
    return node.direction === "vertical"
      ? [...paneShares(a, w * r, h), ...paneShares(b, w * (1 - r), h)]
      : [...paneShares(a, w, h * r), ...paneShares(b, w, h * (1 - r))];
  }

  it.each([
    2, 3, 4, 5, 6,
  ])("puts %i panes in one row of equal full-height columns, keeping their order", (count) => {
    const ids = ["a", "b", "c", "d", "e", "f"].slice(0, count);
    // Start from a resized grid with a pane moved to an edge.
    const edged = moveSlotToTreeEdge(buildGridTree(ids), ids[0], "bottom", 0.2);
    const messy = updateRatio(edged, edged.id, 0.9);
    const order = collectSlotIds(messy);

    const shares = paneShares(tidyIntoRow(messy));

    expect(shares.map(([id]) => id)).toEqual(order);
    for (const [, w, h] of shares) {
      expect(w).toBeCloseTo(1 / count);
      expect(h).toBe(1);
    }
  });

  it("keeps each pane's leaf so the panes stay where they are in the DOM", () => {
    const grid = buildGridTree(["a", "b", "c", "d"]);
    const leafIds = (n: TreeNode): string[] =>
      n.type === "leaf" ? [n.id] : [...leafIds(n.children[0]), ...leafIds(n.children[1])];
    expect(leafIds(tidyIntoRow(grid))).toEqual(leafIds(grid));
  });

  it("leaves a single pane untouched", () => {
    const single = createLeaf("a");
    expect(tidyIntoRow(single)).toBe(single);
  });

  it("can still be resized and rearranged afterwards", () => {
    const row = tidyIntoRow(buildGridTree(["a", "b", "c", "d"]));
    if (row.type !== "split") throw new Error("expected split root");
    const resized = updateRatio(row, row.id, 0.7);
    expect(resized.type === "split" && resized.ratio).toBe(0.7);
    const moved = moveSlotToSide(resized, "a", "d", "bottom");
    expect(collectSlotIds(moved)).toEqual(["b", "c", "d", "a"]);
  });
});
