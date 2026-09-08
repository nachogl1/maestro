import { describe, expect, it } from "vitest";

import {
  PIN_STRIP_HEIGHT,
  PIN_STRIP_LABEL,
  PIN_STRIP_PAD,
  type PinnedStripTab,
  pinnedStripLayout,
} from "../pinnedStrip";

function tab(
  id: string,
  sessionIds: number[],
  opts: { active?: boolean; launched?: boolean } = {},
): PinnedStripTab {
  return {
    id,
    active: opts.active ?? false,
    sessionsLaunched: opts.launched ?? true,
    sessionIds,
  };
}

describe("pinnedStripLayout", () => {
  const tabs = [tab("a", [1, 2], { active: true }), tab("b", [3, 4]), tab("c", [5])];

  it("returns null when nothing is pinned", () => {
    expect(pinnedStripLayout(tabs, [], [])).toBeNull();
  });

  it("places a pinned terminal of an inactive project in the strip", () => {
    const layout = pinnedStripLayout(tabs, [3], []);

    expect(layout?.get("b")?.has(3)).toBe(true);
    // Only the pinned one — its project's other terminals stay hidden.
    expect(layout?.get("b")?.size).toBe(1);
    expect(layout?.has("a")).toBe(false);
  });

  it("ignores pins in the ACTIVE project — those terminals are already on screen", () => {
    expect(pinnedStripLayout(tabs, [1, 2], [])).toBeNull();
  });

  it("ignores a pinned terminal that is parked (its pane is hidden by design)", () => {
    expect(pinnedStripLayout(tabs, [3], [3])).toBeNull();
  });

  it("ignores a project whose grid is not mounted", () => {
    const idle = [tab("a", [1], { active: true }), tab("b", [3], { launched: false })];

    expect(pinnedStripLayout(idle, [3], [])).toBeNull();
  });

  it("splits the strip across every pinned terminal, in tab order", () => {
    const layout = pinnedStripLayout(tabs, [5, 3], []);

    const b = layout?.get("b")?.get(3);
    const c = layout?.get("c")?.get(5);
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    // Two cells of equal width; the first starts at the strip's padding and
    // the second one cell + one gap further in.
    expect(b?.width).toBe(c?.width);
    expect(b?.left).toContain(`${PIN_STRIP_PAD}px`);
    expect(b?.left).not.toBe(c?.left);
  });

  it("sizes every tile to the strip minus its caption row and padding", () => {
    const layout = pinnedStripLayout(tabs, [3], []);

    expect(layout?.get("b")?.get(3)?.height).toBe(
      PIN_STRIP_HEIGHT - PIN_STRIP_LABEL - PIN_STRIP_PAD,
    );
    expect(layout?.get("b")?.get(3)?.bottom).toBe(PIN_STRIP_PAD);
  });

  it("groups several pinned terminals of one project under that project's tab", () => {
    const layout = pinnedStripLayout(tabs, [3, 4], []);

    expect(layout?.size).toBe(1);
    expect([...(layout?.get("b")?.keys() ?? [])]).toEqual([3, 4]);
  });
});
