import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The persisted zustand stores hydrate through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

// useTerminalDragDrop subscribes to the real Tauri window on mount, and runs
// in eagle mode even when the grid isn't the active project (eagleMode ||
// isActive) — this test relies on exactly that to exercise the eagle render path.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: async () => () => {},
  }),
}));

// xterm.js cannot mount in happy-dom — irrelevant here anyway since the
// default slot stays pre-launch (no TerminalView renders), but keeping the
// grid's import graph side-effect-free matches the sibling suite's pattern.
vi.mock("../TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));

// The grid fetches MCP servers and plugins for the project as soon as it
// mounts (not gated on isActive) — stub the network-shaped calls so that
// fetch doesn't reject against the absent Tauri backend.
vi.mock("@/lib/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp")>();
  return {
    ...actual,
    getProjectMcpServers: vi.fn(async () => []),
  };
});

vi.mock("@/lib/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plugins")>();
  return {
    ...actual,
    getProjectPlugins: vi.fn(async () => ({ plugins: [], skills: [] })),
  };
});

import { TerminalGrid } from "../TerminalGrid";

/**
 * Regression cover for issue: adding a terminal in eagle view used to leave
 * eagle view entirely (App.tsx's handleAddSessionToProject called
 * setEagleView(false)), because TerminalGrid rendered every pre-launch slot
 * with eagleHidden={eagleMode}. The pre-launch pane should now tile into the
 * eagle grid just like a launched one.
 */
describe("TerminalGrid eagle pre-launch tile", () => {
  it("renders the default pre-launch slot as a visible eagle tile, not eagleHidden", async () => {
    // isActive=false: branch fetching (which needs a real Tauri backend) is
    // gated on it, and this test only cares about eagle tiling, not branches.
    const { container } = render(
      <TerminalGrid
        projectPath="C:/proj"
        tabId="tab-1"
        isActive={false}
        eagleMode
        eagleTileCount={1}
      />,
    );

    // DraggablePane only stamps [data-slot-id][data-grid-id] on a wrapper
    // when eagleMode is on AND eagleHidden is false — the same selector its
    // own drag-and-drop hit-testing uses to find visible eagle tiles.
    const tile = container.querySelector("[data-slot-id][data-grid-id]");
    expect(tile).not.toBeNull();
    // The eagleHidden branch renders className="hidden" exactly (nothing
    // else) — a substring check would false-positive on "overflow-hidden".
    expect(tile?.className).not.toBe("hidden");
    expect(tile?.className).toContain("relative");

    // Flush the mount-time MCP/plugin fetch promises (stubbed above) inside
    // act() so their state updates don't warn after the test has finished.
    await act(async () => {});
  });
});
