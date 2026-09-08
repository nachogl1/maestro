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

import { sortPinnedFirst, useWorkspaceStore, type WorkspaceTab } from "../useWorkspaceStore";

function setTabs(tabs: Array<{ id: string; name: string; active?: boolean; pinned?: boolean }>) {
  useWorkspaceStore.setState({
    tabs: tabs.map(
      (t): WorkspaceTab => ({
        id: t.id,
        name: t.name,
        active: t.active ?? false,
        pinned: t.pinned ?? false,
        projectPath: `/path/${t.name}`,
        sessionIds: [],
        sessionsLaunched: false,
        workspaceType: "single-repo",
        repositories: [],
        selectedRepoPath: null,
        worktreeBasePath: null,
      }),
    ),
  });
}

const ids = () => useWorkspaceStore.getState().tabs.map((t) => t.id);

describe("pinned project tabs", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [], zoomTabOrders: {} });
  });

  describe("toggleTabPin", () => {
    it("pins a tab and sorts it to the front of the strip", () => {
      setTabs([
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ]);

      useWorkspaceStore.getState().toggleTabPin("c");

      expect(ids()).toEqual(["c", "a", "b"]);
      expect(useWorkspaceStore.getState().tabs[0].pinned).toBe(true);
    });

    it("unpins in place when no pinned tab is left to sit in front of it", () => {
      // Unpinning releases the constraint; it does not reorder. There is no
      // remembered pre-pin position to restore the tab to.
      setTabs([
        { id: "c", name: "C", pinned: true },
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ]);

      useWorkspaceStore.getState().toggleTabPin("c");

      expect(ids()).toEqual(["c", "a", "b"]);
      expect(useWorkspaceStore.getState().tabs.every((t) => !t.pinned)).toBe(true);
    });

    it("pushes an unpinned tab behind the tabs still pinned", () => {
      setTabs([
        { id: "p1", name: "P1", pinned: true },
        { id: "p2", name: "P2", pinned: true },
        { id: "a", name: "A" },
      ]);

      useWorkspaceStore.getState().toggleTabPin("p1");

      expect(ids()).toEqual(["p2", "p1", "a"]);
    });

    it("keeps pinned tabs in the order they were pinned", () => {
      setTabs([
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ]);

      useWorkspaceStore.getState().toggleTabPin("b");
      useWorkspaceStore.getState().toggleTabPin("c");

      expect(ids()).toEqual(["b", "c", "a"]);
    });

    it("does not change which tab is active", () => {
      setTabs([
        { id: "a", name: "A", active: true },
        { id: "b", name: "B" },
      ]);

      useWorkspaceStore.getState().toggleTabPin("b");

      expect(useWorkspaceStore.getState().tabs.find((t) => t.active)?.id).toBe("a");
    });

    it("is a no-op for an unknown tab id", () => {
      setTabs([{ id: "a", name: "A" }]);

      useWorkspaceStore.getState().toggleTabPin("nope");

      expect(ids()).toEqual(["a"]);
    });
  });

  describe("ordering composes with manual reorder", () => {
    it("still reorders within the pinned group", () => {
      setTabs([
        { id: "p1", name: "P1", pinned: true },
        { id: "p2", name: "P2", pinned: true },
        { id: "a", name: "A" },
      ]);

      useWorkspaceStore.getState().reorderTabs("p1", "p2");

      expect(ids()).toEqual(["p2", "p1", "a"]);
    });

    it("still reorders within the unpinned group", () => {
      setTabs([
        { id: "p1", name: "P1", pinned: true },
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ]);

      useWorkspaceStore.getState().reorderTabs("a", "b");

      expect(ids()).toEqual(["p1", "b", "a"]);
    });

    it("refuses a drag across the pinned boundary instead of pinning silently", () => {
      setTabs([
        { id: "p1", name: "P1", pinned: true },
        { id: "a", name: "A" },
      ]);

      useWorkspaceStore.getState().reorderTabs("a", "p1");

      expect(ids()).toEqual(["p1", "a"]);
      expect(useWorkspaceStore.getState().tabs.find((t) => t.id === "a")?.pinned).toBe(false);
    });

    it("refuses a keyboard move across the pinned boundary", () => {
      setTabs([
        { id: "p1", name: "P1", pinned: true },
        { id: "a", name: "A" },
      ]);

      useWorkspaceStore.getState().moveTab("a", "left");

      expect(ids()).toEqual(["p1", "a"]);
    });

    it("still moves a pinned tab within the pinned group", () => {
      setTabs([
        { id: "p1", name: "P1", pinned: true },
        { id: "p2", name: "P2", pinned: true },
        { id: "a", name: "A" },
      ]);

      useWorkspaceStore.getState().moveTab("p2", "left");

      expect(ids()).toEqual(["p2", "p1", "a"]);
    });
  });

  describe("sortPinnedFirst", () => {
    it("returns the same array reference when nothing is pinned", () => {
      const tabs = useWorkspaceStore.getState().tabs;
      expect(sortPinnedFirst(tabs)).toBe(tabs);
    });

    it("is a stable partition", () => {
      setTabs([
        { id: "a", name: "A" },
        { id: "p1", name: "P1", pinned: true },
        { id: "b", name: "B" },
        { id: "p2", name: "P2", pinned: true },
      ]);

      const sorted = sortPinnedFirst(useWorkspaceStore.getState().tabs);

      expect(sorted.map((t) => t.id)).toEqual(["p1", "p2", "a", "b"]);
    });
  });
});
