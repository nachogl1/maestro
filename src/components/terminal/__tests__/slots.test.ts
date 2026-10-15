import { describe, expect, it } from "vitest";

import { createEmptySlot } from "../slots";

describe("createEmptySlot", () => {
  it("defaults the working directory to a new worktree", () => {
    expect(createEmptySlot().worktreeMode).toBe("new");
  });
});
