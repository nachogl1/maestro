import { describe, expect, it } from "vitest";

import { createEmptySlot, sessionConfigDir } from "../slots";

describe("createEmptySlot", () => {
  it("defaults the working directory to the original project path", () => {
    expect(createEmptySlot().worktreeMode).toBe("project");
  });
});

describe("sessionConfigDir", () => {
  it("cleans the repo folder launch wrote into, not the multi-repo project folder", () => {
    const slot = { configDir: "C:/work/project/repo-a", worktreePath: null };
    expect(sessionConfigDir(slot, "C:/work/project")).toBe("C:/work/project/repo-a");
  });

  it("falls back to the worktree, then the project, for slots launched before configDir", () => {
    expect(sessionConfigDir({ worktreePath: "C:/wt/feat" }, "C:/work/project")).toBe("C:/wt/feat");
    expect(sessionConfigDir({ worktreePath: null }, "C:/work/project")).toBe("C:/work/project");
    expect(sessionConfigDir(undefined, "C:/work/project")).toBe("C:/work/project");
  });
});
