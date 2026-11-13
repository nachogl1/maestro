import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri dependencies before importing the store
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/terminal", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore } from "../useWorkspaceStore";

function setTabs(tabs: Array<{ id: string; name: string; active: boolean }>) {
  useWorkspaceStore.setState({
    tabs: tabs.map((t) => ({
      ...t,
      projectPath: `/path/${t.name}`,
      sessionIds: [],
      sessionsLaunched: false,
      workspaceType: "single-repo" as const,
      repositories: [],
      selectedRepoPath: null,
      worktreeBasePath: null,
    })),
  });
}

describe("useWorkspaceStore reorder actions", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [], zoomTabOrders: {} });
  });

  describe("reorderTabs", () => {
    it("swaps the tab at position 0 with the one at position 2", () => {
      setTabs([
        { id: "a", name: "A", active: true },
        { id: "b", name: "B", active: false },
        { id: "c", name: "C", active: false },
      ]);

      useWorkspaceStore.getState().reorderTabs("a", "c");

      const ids = useWorkspaceStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["c", "b", "a"]);
    });

    it("is a no-op when activeId equals overId", () => {
      setTabs([
        { id: "a", name: "A", active: true },
        { id: "b", name: "B", active: false },
      ]);

      useWorkspaceStore.getState().reorderTabs("a", "a");

      const ids = useWorkspaceStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["a", "b"]);
    });

    it("is a no-op when activeId does not exist", () => {
      setTabs([
        { id: "a", name: "A", active: true },
        { id: "b", name: "B", active: false },
      ]);

      useWorkspaceStore.getState().reorderTabs("nonexistent", "b");

      const ids = useWorkspaceStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["a", "b"]);
    });
  });

  describe("moveTab", () => {
    it("moves tab one position to the right", () => {
      setTabs([
        { id: "a", name: "A", active: true },
        { id: "b", name: "B", active: false },
        { id: "c", name: "C", active: false },
      ]);

      useWorkspaceStore.getState().moveTab("a", "right");

      const ids = useWorkspaceStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["b", "a", "c"]);
    });

    it("moves tab one position to the left", () => {
      setTabs([
        { id: "a", name: "A", active: false },
        { id: "b", name: "B", active: true },
        { id: "c", name: "C", active: false },
      ]);

      useWorkspaceStore.getState().moveTab("b", "left");

      const ids = useWorkspaceStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["b", "a", "c"]);
    });

    it("is a no-op when moving left at index 0", () => {
      setTabs([
        { id: "a", name: "A", active: true },
        { id: "b", name: "B", active: false },
      ]);

      useWorkspaceStore.getState().moveTab("a", "left");

      const ids = useWorkspaceStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["a", "b"]);
    });

    it("is a no-op when moving right at last index", () => {
      setTabs([
        { id: "a", name: "A", active: false },
        { id: "b", name: "B", active: true },
      ]);

      useWorkspaceStore.getState().moveTab("b", "right");

      const ids = useWorkspaceStore.getState().tabs.map((t) => t.id);
      expect(ids).toEqual(["a", "b"]);
    });

    it("preserves tab properties after move", () => {
      setTabs([
        { id: "a", name: "A", active: true },
        { id: "b", name: "B", active: false },
      ]);

      useWorkspaceStore.getState().moveTab("a", "right");

      const movedTab = useWorkspaceStore.getState().tabs.find((t) => t.id === "a");
      expect(movedTab?.name).toBe("A");
      expect(movedTab?.active).toBe(true);
    });
  });

  describe("setZoomTabOrder", () => {
    it("sets the zoom tab order for a tab", () => {
      useWorkspaceStore.getState().setZoomTabOrder("tab-1", ["s2", "s1", "s3"]);

      expect(useWorkspaceStore.getState().zoomTabOrders["tab-1"]).toEqual(["s2", "s1", "s3"]);
    });

    it("overwrites an existing order", () => {
      useWorkspaceStore.getState().setZoomTabOrder("tab-1", ["s1", "s2"]);
      useWorkspaceStore.getState().setZoomTabOrder("tab-1", ["s2", "s1"]);

      expect(useWorkspaceStore.getState().zoomTabOrders["tab-1"]).toEqual(["s2", "s1"]);
    });

    it("keeps orders for different tabs independent", () => {
      useWorkspaceStore.getState().setZoomTabOrder("tab-1", ["s1", "s2"]);
      useWorkspaceStore.getState().setZoomTabOrder("tab-2", ["x2", "x1"]);

      expect(useWorkspaceStore.getState().zoomTabOrders["tab-1"]).toEqual(["s1", "s2"]);
      expect(useWorkspaceStore.getState().zoomTabOrders["tab-2"]).toEqual(["x2", "x1"]);
    });
  });
});
