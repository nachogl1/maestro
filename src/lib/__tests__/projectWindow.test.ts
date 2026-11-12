import { describe, expect, it } from "vitest";
import {
  getProjectWindowTabId,
  projectWindowLabel,
  projectWindowTabFields,
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
});
