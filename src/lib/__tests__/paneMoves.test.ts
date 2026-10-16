import { describe, expect, it } from "vitest";

import { neighbourInDirection, paneDropZone, stageEdgeAt } from "../paneMoves";

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
