import { beforeEach, describe, expect, it } from "vitest";
import type { GridSnapshot } from "@/lib/projectWindow";
import { useProjectWindowStore } from "@/stores/useProjectWindowStore";

function grid(slotId: string): GridSnapshot {
  return { slots: [], layoutTree: { type: "leaf", id: `leaf-${slotId}`, slotId } };
}

describe("useProjectWindowStore", () => {
  beforeEach(() => {
    useProjectWindowStore.setState({ poppedOut: {}, latestGrids: {}, dockSeeds: {} });
  });

  it("marks a tab popped out with the window holding it and the grid it left with", () => {
    useProjectWindowStore.getState().markPoppedOut("t1", grid("a"), "w1");
    const state = useProjectWindowStore.getState();
    expect(state.poppedOut).toEqual({ t1: "w1" });
    expect(state.latestGrids.t1).toEqual(grid("a"));
  });

  it("keeps the latest grid reported by the pop-out and seeds the dock with it", () => {
    const store = useProjectWindowStore.getState();
    store.markPoppedOut("t1", grid("a"), "w1");
    store.setLatestGrid("t1", grid("b"));
    store.dock("t1");
    const state = useProjectWindowStore.getState();
    expect(state.poppedOut).toEqual({});
    expect(state.latestGrids).toEqual({});
    expect(state.dockSeeds.t1).toEqual(grid("b"));
  });

  it("ignores grid reports for tabs that are not popped out", () => {
    useProjectWindowStore.getState().setLatestGrid("t1", grid("a"));
    expect(useProjectWindowStore.getState().latestGrids).toEqual({});
  });

  it("docks without a seed when the pop-out never launched terminals", () => {
    const store = useProjectWindowStore.getState();
    store.markPoppedOut("t1", null, "w1");
    store.dock("t1");
    expect(useProjectWindowStore.getState().dockSeeds).toEqual({});
  });

  it("treats docking a tab that is not popped out as a no-op", () => {
    const before = useProjectWindowStore.getState();
    before.dock("missing");
    expect(useProjectWindowStore.getState()).toBe(before);
  });

  it("consumes a dock seed once", () => {
    const store = useProjectWindowStore.getState();
    store.markPoppedOut("t1", grid("a"), "w1");
    store.dock("t1");
    store.consumeDockSeed("t1");
    expect(useProjectWindowStore.getState().dockSeeds).toEqual({});
  });

  it("drops a stale dock seed when the tab pops out again", () => {
    const store = useProjectWindowStore.getState();
    store.markPoppedOut("t1", grid("a"), "w1");
    store.dock("t1");
    store.markPoppedOut("t1", grid("c"), "w1");
    expect(useProjectWindowStore.getState().dockSeeds).toEqual({});
  });

  it("seeds a pop-out's grid with the handed-over layout until it is consumed", () => {
    const store = useProjectWindowStore.getState();
    store.seedGrid("t1", grid("a"));
    expect(useProjectWindowStore.getState().dockSeeds.t1).toEqual(grid("a"));
    store.consumeDockSeed("t1");
    expect(useProjectWindowStore.getState().dockSeeds).toEqual({});
  });

  it("moves a popped-out tab into another window, and never moves a docked one", () => {
    const store = useProjectWindowStore.getState();
    store.markPoppedOut("t1", grid("a"), "w1");
    store.moveToWindow("t1", "w2");
    store.moveToWindow("docked", "w2");
    const state = useProjectWindowStore.getState();
    expect(state.poppedOut).toEqual({ t1: "w2" });
    expect(state.latestGrids.t1).toEqual(grid("a"));
  });
});
