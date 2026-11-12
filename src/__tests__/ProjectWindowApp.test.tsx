import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectHandoff, ProjectWindowHost } from "@/lib/projectWindow";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const emitTo = vi.fn((..._args: unknown[]) => Promise.resolve());
const closeWindow = vi.fn(() => Promise.resolve());

/** A window on a 2x display, given its logical bounds. */
function fakeWindow(label: string, x: number, y: number, width: number, height: number) {
  return {
    label,
    outerPosition: () => Promise.resolve({ x: x * 2, y: y * 2 }),
    outerSize: () => Promise.resolve({ width: width * 2, height: height * 2 }),
    scaleFactor: () => Promise.resolve(2),
  };
}

// This pop-out (w1) sits on top of the main window; another pop-out (w2) is
// on a second screen to the right. Other Maestro windows never take a drop.
const WINDOWS = [
  fakeWindow("main", 100, 50, 1200, 800),
  fakeWindow("project-w1", 300, 200, 600, 400),
  fakeWindow("project-w2", 1500, 50, 800, 600),
  fakeWindow("issue-map", 0, 0, 3000, 3000),
];
const getAll = vi.fn(() => Promise.resolve(WINDOWS));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  }),
  emitTo: (...args: unknown[]) => emitTo(...args),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    close: closeWindow,
  }),
  Window: {
    getAll: () => getAll(),
  },
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

// The full layout is out of scope here: capture what the wrapper hands it.
let lastHost: ProjectWindowHost | undefined;
vi.mock("../App", () => ({
  default: ({ projectWindow }: { projectWindow?: ProjectWindowHost }) => {
    lastHost = projectWindow;
    return <div>full maestro layout</div>;
  },
}));

import { ProjectWindowApp } from "../ProjectWindowApp";
import { useProjectWindowStore } from "../stores/useProjectWindowStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";

function handoff(tabId: string, name: string, windowId = "w1"): ProjectHandoff {
  return {
    windowId,
    tab: {
      id: tabId,
      name,
      projectPath: `/p/${name}`,
      active: false,
      sessionIds: [7],
      sessionsLaunched: true,
      workspaceType: "single-repo",
      repositories: [],
      selectedRepoPath: null,
      worktreeBasePath: null,
    },
    grid: { slots: [], layoutTree: { type: "leaf", id: `leaf-${tabId}`, slotId: tabId } },
    parkedSessionIds: [],
  };
}

const ALPHA = handoff("t1", "alpha");

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function receive(event: string, payload: unknown) {
  act(() => listeners.get(event)?.({ payload }));
}

/** Renders pop-out w1 and hands it its first project. */
async function openWithAlpha() {
  render(<ProjectWindowApp tabId="t1" windowId="w1" />);
  await flush();
  receive("project-window-handoff", ALPHA);
}

function tabIds() {
  return useWorkspaceStore.getState().tabs.map((t) => t.id);
}

/** The drop requests this window sent to the main window. */
function dropRequests() {
  return emitTo.mock.calls.filter(([, event]) =>
    ["project-window-dock-tab", "project-window-move-tab"].includes(event as string),
  );
}

describe("ProjectWindowApp — full Maestro layout in a pop-out", () => {
  beforeEach(() => {
    listeners.clear();
    emitTo.mockClear();
    closeWindow.mockClear();
    getAll.mockClear();
    lastHost = undefined;
    useProjectWindowStore.setState({ poppedOut: {}, latestGrids: {}, dockSeeds: {} });
    useWorkspaceStore.setState({ tabs: [] });
  });

  it("asks the main window for the project, then shows the full layout in pop-out mode", async () => {
    render(<ProjectWindowApp tabId="t1" windowId="w1" />);
    await flush();
    expect(emitTo).toHaveBeenCalledWith("main", "project-window-ready", { tabId: "t1" });
    expect(screen.getByText("Loading project…")).toBeTruthy();

    receive("project-window-handoff", ALPHA);

    expect(screen.getByText("full maestro layout")).toBeTruthy();
    expect(lastHost?.tabId).toBe("t1");
    expect(useWorkspaceStore.getState().tabs).toEqual([{ ...ALPHA.tab, active: true }]);
    // The grid is rebuilt from the handed-over layout.
    expect(useProjectWindowStore.getState().dockSeeds.t1).toEqual(ALPHA.grid);
  });

  it("reports each project's state to the main window, signed with this window's id", async () => {
    await openWithAlpha();
    await flush();
    expect(emitTo).toHaveBeenCalledWith(
      "main",
      "project-window-update",
      expect.objectContaining({ tabId: "t1", windowId: "w1" }),
    );
  });

  it("adds a project joining this window as a new, selected tab", async () => {
    await openWithAlpha();

    receive("project-window-handoff", handoff("t2", "beta"));

    expect(tabIds()).toEqual(["t1", "t2"]);
    expect(useWorkspaceStore.getState().tabs.find((t) => t.active)?.id).toBe("t2");
    expect(useProjectWindowStore.getState().dockSeeds.t2).toBeDefined();
  });

  it("ignores projects handed to another pop-out", async () => {
    await openWithAlpha();

    receive("project-window-handoff", handoff("t2", "beta", "w2"));

    expect(tabIds()).toEqual(["t1"]);
  });

  it("lets a tab go when it leaves, and closes the window once the last one has", async () => {
    await openWithAlpha();
    receive("project-window-handoff", handoff("t2", "beta"));

    receive("project-window-release-tab", { tabId: "t2", windowId: "w2" });
    expect(tabIds()).toEqual(["t1", "t2"]);

    receive("project-window-release-tab", { tabId: "t1", windowId: "w1" });
    await flush();
    expect(tabIds()).toEqual(["t2"]);
    expect(useWorkspaceStore.getState().tabs[0].active).toBe(true);
    expect(closeWindow).not.toHaveBeenCalled();

    receive("project-window-release-tab", { tabId: "t2", windowId: "w1" });
    await flush();
    expect(closeWindow).toHaveBeenCalled();
  });

  it("closes a project here, keeping the window while it holds other projects", async () => {
    await openWithAlpha();
    receive("project-window-handoff", handoff("t2", "beta"));

    useWorkspaceStore.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== "t2") }));
    lastHost?.onProjectClosed("t2");
    await flush();
    await flush();
    expect(emitTo).toHaveBeenCalledWith("main", "project-window-close-tab", "t2");
    expect(closeWindow).not.toHaveBeenCalled();

    useWorkspaceStore.setState({ tabs: [] });
    lastHost?.onProjectClosed("t1");
    await flush();
    await flush();
    expect(emitTo).toHaveBeenCalledWith("main", "project-window-close-tab", "t1");
    expect(closeWindow).toHaveBeenCalled();
  });

  it("joins a tab dropped on another pop-out to that window", async () => {
    await openWithAlpha();

    await lastHost?.onTabDroppedOutside("t1", { x: 1800, y: 300 });

    expect(dropRequests()).toEqual([
      ["main", "project-window-move-tab", { tabId: "t1", fromWindowId: "w1", toWindowId: "w2" }],
    ]);
  });

  it("docks a tab dropped on the main window, title bar included", async () => {
    await openWithAlpha();

    for (const point of [
      { x: 1000, y: 700 },
      { x: 150, y: 50 },
    ]) {
      await lastHost?.onTabDroppedOutside("t1", point);
    }

    const dock = ["main", "project-window-dock-tab", { tabId: "t1", windowId: "w1" }];
    expect(dropRequests()).toEqual([dock, dock]);
  });

  it("does nothing when a tab is dropped on no other Maestro window", async () => {
    await openWithAlpha();

    for (const point of [
      { x: 3500, y: 300 },
      { x: 50, y: 300 },
      // Its own title bar, which also lies over the main window.
      { x: 400, y: 205 },
    ]) {
      await lastHost?.onTabDroppedOutside("t1", point);
    }

    expect(dropRequests()).toEqual([]);
  });

  it("does nothing, without throwing, when the windows can't be read", async () => {
    await openWithAlpha();
    getAll.mockRejectedValueOnce(new Error("not allowed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(lastHost?.onTabDroppedOutside("t1", { x: 1000, y: 700 })).resolves.toBeUndefined();

    expect(dropRequests()).toEqual([]);
    consoleError.mockRestore();
  });
});
