import { describe, expect, it } from "vitest";
import {
  canMoveTab,
  getProjectWindowId,
  getProjectWindowTabId,
  projectWindowLabel,
  projectWindowTabFields,
  tabsInWindow,
  windowHoldsTab,
} from "@/lib/projectWindow";
import type { WorkspaceTab } from "@/stores/useWorkspaceStore";

describe("projectWindow helpers", () => {
  it("reads the pop-out tab id from the query string", () => {
    expect(getProjectWindowTabId("?projectWindow=abc-123")).toBe("abc-123");
  });

  it("returns null in the main window", () => {
    expect(getProjectWindowTabId("")).toBeNull();
    expect(getProjectWindowTabId("?projectWindow=")).toBeNull();
  });

  it("reads the pop-out's own window id from the query string", () => {
    expect(getProjectWindowId("?projectWindow=t1&windowId=w-9")).toBe("w-9");
    expect(getProjectWindowId("?projectWindow=t1")).toBeNull();
  });

  it("builds the same window label as the Rust side", () => {
    expect(projectWindowLabel("3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b")).toBe(
      "project-3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b",
    );
    expect(projectWindowLabel("a/b c")).toBe("project-a_b_c");
  });

  it("reports only the tab fields a pop-out may change", () => {
    const tab: WorkspaceTab = {
      id: "t1",
      name: "proj",
      projectPath: "/p",
      active: true,
      sessionIds: [1, 2],
      sessionsLaunched: true,
      workspaceType: "single-repo",
      repositories: [],
      selectedRepoPath: "/p",
      worktreeBasePath: null,
    };
    expect(projectWindowTabFields(tab)).toEqual({
      sessionIds: [1, 2],
      sessionsLaunched: true,
      selectedRepoPath: "/p",
      repositories: [],
      workspaceType: "single-repo",
      worktreeBasePath: null,
    });
  });

  describe("which pop-out holds which tab", () => {
    // t1 and t2 share pop-out w1; t3 is alone in w2.
    const poppedOut = { t1: "w1", t2: "w1", t3: "w2" };

    it("lists every tab a closing window holds, so they all dock", () => {
      expect(tabsInWindow(poppedOut, "w1")).toEqual(["t1", "t2"]);
      expect(tabsInWindow(poppedOut, "gone")).toEqual([]);
    });

    it("only lets the window holding a tab dock it or speak for it", () => {
      expect(windowHoldsTab(poppedOut, { tabId: "t1", windowId: "w1" })).toBe(true);
      expect(windowHoldsTab(poppedOut, { tabId: "t1", windowId: "w2" })).toBe(false);
      expect(windowHoldsTab(poppedOut, { tabId: "docked", windowId: "w1" })).toBe(false);
    });

    it("moves a tab only from the window holding it into another open pop-out", () => {
      expect(canMoveTab(poppedOut, { tabId: "t1", fromWindowId: "w1", toWindowId: "w2" })).toBe(
        true,
      );
      for (const move of [
        { tabId: "t1", fromWindowId: "w2", toWindowId: "w1" },
        { tabId: "t1", fromWindowId: "w1", toWindowId: "w1" },
        { tabId: "t1", fromWindowId: "w1", toWindowId: "closed" },
        { tabId: "docked", fromWindowId: "w1", toWindowId: "w2" },
      ]) {
        expect(canMoveTab(poppedOut, move)).toBe(false);
      }
    });
  });
});
