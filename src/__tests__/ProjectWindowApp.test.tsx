import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectHandoff, ProjectWindowHost } from "@/lib/projectWindow";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const emitTo = vi.fn((..._args: unknown[]) => Promise.resolve());
const closeWindow = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  }),
  emitTo: (...args: unknown[]) => emitTo(...args),
}));

// The main window on a 2x display: physical 2400x1600 at (200, 100), so
// logical 1200x800 at (100, 50).
const mainWindow = {
  outerPosition: () => Promise.resolve({ x: 200, y: 100 }),
  outerSize: () => Promise.resolve({ width: 2400, height: 1600 }),
  scaleFactor: () => Promise.resolve(2),
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: () => Promise.resolve(),
    close: closeWindow,
  }),
  Window: {
    getByLabel: (label: string) => Promise.resolve(label === "main" ? mainWindow : null),
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

const HANDOFF: ProjectHandoff = {
  tab: {
    id: "t1",
    name: "alpha",
    projectPath: "/p/alpha",
    active: false,
    sessionIds: [7],
    sessionsLaunched: true,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
  },
  grid: { slots: [], layoutTree: { type: "leaf", id: "leaf-a", slotId: "a" } },
  parkedSessionIds: [],
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ProjectWindowApp — full Maestro layout in a pop-out", () => {
  beforeEach(() => {
    listeners.clear();
    emitTo.mockClear();
    closeWindow.mockClear();
    lastHost = undefined;
    useProjectWindowStore.setState({ poppedOut: {}, latestGrids: {}, dockSeeds: {} });
    useWorkspaceStore.setState({ tabs: [] });
  });

  it("asks the main window for the project, then shows the full layout in pop-out mode", async () => {
    render(<ProjectWindowApp tabId="t1" />);
    await flush();
    expect(emitTo).toHaveBeenCalledWith("main", "project-window-ready", { tabId: "t1" });
    expect(screen.getByText("Loading project…")).toBeTruthy();

    act(() => listeners.get("project-window-handoff")?.({ payload: HANDOFF }));

    expect(screen.getByText("full maestro layout")).toBeTruthy();
    expect(lastHost?.tabId).toBe("t1");
    expect(useWorkspaceStore.getState().tabs).toEqual([{ ...HANDOFF.tab, active: true }]);
    // The grid is rebuilt from the handed-over layout.
    expect(useProjectWindowStore.getState().dockSeeds.t1).toEqual(HANDOFF.grid);
  });

  it("tells the main window when the project is closed here, then closes the window", async () => {
    render(<ProjectWindowApp tabId="t1" />);
    await flush();
    act(() => listeners.get("project-window-handoff")?.({ payload: HANDOFF }));

    lastHost?.onProjectClosed("t1");
    await flush();
    await flush();

    expect(emitTo).toHaveBeenCalledWith("main", "project-window-close-tab", "t1");
    expect(closeWindow).toHaveBeenCalled();
  });

  it("docks the project back when its tab is dropped on the main window", async () => {
    render(<ProjectWindowApp tabId="t1" />);
    await flush();
    act(() => listeners.get("project-window-handoff")?.({ payload: HANDOFF }));

    await lastHost?.onTabDroppedOutside("t1", { x: 500, y: 300 });

    expect(closeWindow).toHaveBeenCalled();
  });

  it("keeps the pop-out open when its tab is dropped anywhere but the main window", async () => {
    render(<ProjectWindowApp tabId="t1" />);
    await flush();
    act(() => listeners.get("project-window-handoff")?.({ payload: HANDOFF }));

    for (const point of [
      { x: 3000, y: 300 },
      { x: 500, y: 900 },
      { x: 50, y: 300 },
    ]) {
      await lastHost?.onTabDroppedOutside("t1", point);
    }

    expect(closeWindow).not.toHaveBeenCalled();
  });
});
