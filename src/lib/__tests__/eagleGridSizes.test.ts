import { describe, expect, it } from "vitest";

import {
  boundaryOffsets,
  dragBoundary,
  equalWeights,
  MIN_PAIR_SHARE,
  resolveWeights,
  trackTemplate,
} from "../eagleGridSizes";

describe("eagleGridSizes", () => {
  it("keeps stored weights while the track count matches", () => {
    expect(resolveWeights([2, 1], 2)).toEqual([2, 1]);
  });

  it("falls back to equal weights when the track count changes", () => {
    expect(resolveWeights([2, 1], 3)).toEqual([1, 1, 1]);
    expect(resolveWeights([], 2)).toEqual(equalWeights(2));
  });

  it("rejects stored weights that are not positive numbers", () => {
    expect(resolveWeights([0, 1], 2)).toEqual([1, 1]);
  });

  it("builds a minmax fr track list", () => {
    expect(trackTemplate([1, 2])).toBe("minmax(0, 1fr) minmax(0, 2fr)");
  });

  it("moves weight between the two tracks next to the dragged gap only", () => {
    // 3 equal tracks over 300px: 100px per weight unit of 1.
    const next = dragBoundary([1, 1, 1], 0, 50, 300);
    expect(next[0]).toBeCloseTo(1.5);
    expect(next[1]).toBeCloseTo(0.5);
    expect(next[2]).toBe(1);
  });

  it("never shrinks a track below the minimum share of its pair", () => {
    const next = dragBoundary([1, 1], 0, -10_000, 200);
    expect(next[0]).toBeCloseTo(2 * MIN_PAIR_SHARE);
    expect(next[0] + next[1]).toBeCloseTo(2);
  });

  it("ignores a boundary index with no track after it", () => {
    expect(dragBoundary([1, 1], 1, 40, 200)).toEqual([1, 1]);
  });

  it("puts each boundary in the middle of its gap", () => {
    // Two tracks sharing 200px (after the 8px gap): first ends at 100.
    expect(boundaryOffsets([1, 1], 200, 8)).toEqual([104]);
    expect(boundaryOffsets([3, 1], 200, 8)).toEqual([154]);
  });
});
