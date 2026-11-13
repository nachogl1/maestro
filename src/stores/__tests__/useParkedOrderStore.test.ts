import { beforeEach, describe, expect, it } from "vitest";
import { sortByParkedOrder, useParkedOrderStore } from "../useParkedOrderStore";

const ids = (items: { id: number }[]): number[] => items.map((item) => item.id);
const parked = (...sessionIds: number[]): { id: number }[] => sessionIds.map((id) => ({ id }));

function shown(...natural: number[]): number[] {
  return ids(sortByParkedOrder(parked(...natural), useParkedOrderStore.getState().order));
}

describe("useParkedOrderStore", () => {
  beforeEach(() => {
    useParkedOrderStore.setState({ order: [] });
  });

  it("keeps the natural order until the user moves a pill", () => {
    useParkedOrderStore.getState().syncParked([3, 1, 2]);
    expect(shown(1, 2, 3)).toEqual([1, 2, 3]);
  });

  it("swaps a pill with the one it is dropped on, in both directions", () => {
    useParkedOrderStore.getState().move([1, 2, 3], 3, 1, [1, 2, 3]);
    expect(shown(1, 2, 3)).toEqual([3, 2, 1]);

    useParkedOrderStore.getState().move([3, 2, 1], 3, 1, [1, 2, 3]);
    expect(shown(1, 2, 3)).toEqual([1, 2, 3]);
  });

  it("keeps the moved order while other terminals park and unpark", () => {
    useParkedOrderStore.getState().move([1, 2, 3], 3, 1, [1, 2, 3]);

    // Terminal 4 parks: it joins the end, the dragged order stays.
    useParkedOrderStore.getState().syncParked([1, 2, 3, 4]);
    expect(shown(1, 2, 3, 4)).toEqual([3, 2, 1, 4]);

    // Terminal 1 unparks: the others keep their places.
    useParkedOrderStore.getState().syncParked([2, 3, 4]);
    expect(shown(2, 3, 4)).toEqual([3, 2, 4]);

    // Parked again, terminal 1 is a newcomer and joins the end.
    useParkedOrderStore.getState().syncParked([1, 2, 3, 4]);
    expect(shown(1, 2, 3, 4)).toEqual([3, 2, 4, 1]);
  });

  it("a move in one project's shelf leaves the other projects' pills where they were", () => {
    // Sessions alpha 1, beta 5, alpha 2, beta 6, all parked: the eagle shelf shows 1, 5, 2, 6.
    const allParked = [1, 5, 2, 6];

    // The first drag ever, in alpha's own shelf (it shows only 1 and 2).
    useParkedOrderStore.getState().move([1, 2], 2, 1, allParked);
    expect(shown(1, 2)).toEqual([2, 1]);
    expect(shown(...allParked)).toEqual([2, 5, 1, 6]);

    // A later drag in the eagle shelf, then another in alpha's.
    useParkedOrderStore.getState().move([2, 5, 1, 6], 6, 5, allParked);
    expect(shown(...allParked)).toEqual([2, 6, 1, 5]);
    useParkedOrderStore.getState().move([2, 1], 1, 2, allParked);
    expect(shown(...allParked)).toEqual([1, 6, 2, 5]);
  });

  it("ignores a drop on itself or on an id the shelf does not show", () => {
    useParkedOrderStore.getState().move([1, 2, 3], 2, 2, [1, 2, 3]);
    useParkedOrderStore.getState().move([1, 2, 3], 2, 9, [1, 2, 3]);
    expect(useParkedOrderStore.getState().order).toEqual([]);
  });
});
