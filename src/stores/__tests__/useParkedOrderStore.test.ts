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

  it("moves a pill onto another one's place, in both directions", () => {
    useParkedOrderStore.getState().move([1, 2, 3], 3, 1);
    expect(shown(1, 2, 3)).toEqual([3, 1, 2]);

    useParkedOrderStore.getState().move([3, 1, 2], 3, 2);
    expect(shown(1, 2, 3)).toEqual([1, 2, 3]);
  });

  it("keeps the moved order while other terminals park and unpark", () => {
    useParkedOrderStore.getState().move([1, 2, 3], 3, 1);

    // Terminal 4 parks: it joins the end, the dragged order stays.
    useParkedOrderStore.getState().syncParked([1, 2, 3, 4]);
    expect(shown(1, 2, 3, 4)).toEqual([3, 1, 2, 4]);

    // Terminal 1 unparks: the others keep their places.
    useParkedOrderStore.getState().syncParked([2, 3, 4]);
    expect(shown(2, 3, 4)).toEqual([3, 2, 4]);

    // Parked again, terminal 1 is a newcomer and joins the end.
    useParkedOrderStore.getState().syncParked([1, 2, 3, 4]);
    expect(shown(1, 2, 3, 4)).toEqual([3, 2, 4, 1]);
  });

  it("a move in one project's shelf leaves the other projects' pills where they were", () => {
    // Eagle order: alpha 1, beta 5, alpha 2, beta 6.
    useParkedOrderStore.getState().move([1, 5, 2, 6], 5, 2);
    expect(shown(1, 2, 5, 6)).toEqual([1, 2, 5, 6]);
    useParkedOrderStore.getState().move([1, 2, 5, 6], 2, 5);
    expect(shown(1, 2, 5, 6)).toEqual([1, 5, 2, 6]);

    // Alpha's own shelf shows only 1 and 2; swapping them must not move beta's.
    useParkedOrderStore.getState().move([1, 2], 2, 1);
    expect(shown(1, 2)).toEqual([2, 1]);
    expect(shown(1, 2, 5, 6)).toEqual([2, 5, 1, 6]);
  });

  it("ignores a drop on itself or on an id the shelf does not show", () => {
    useParkedOrderStore.getState().move([1, 2, 3], 2, 2);
    useParkedOrderStore.getState().move([1, 2, 3], 2, 9);
    expect(useParkedOrderStore.getState().order).toEqual([]);
  });
});
