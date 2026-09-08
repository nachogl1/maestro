import { render } from "@testing-library/react";
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

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: async () => () => {},
  }),
}));

// xterm.js cannot mount in happy-dom; no TerminalView renders here anyway
// (the default slot stays pre-launch), but keep the import graph inert.
vi.mock("../TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));

vi.mock("@/lib/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp")>();
  return { ...actual, getProjectMcpServers: vi.fn(async () => []) };
});

vi.mock("@/lib/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plugins")>();
  return { ...actual, getProjectPlugins: vi.fn(async () => ({ plugins: [], skills: [] })) };
});

import { TerminalGrid } from "../TerminalGrid";

/**
 * Spotlight mode: an INACTIVE project that owns a pinned terminal renders that
 * one terminal into the pinned strip and nothing else. The grid gets there by
 * flattening itself (`display: contents`) exactly as it does in eagle view, so
 * the live xterm is repositioned by CSS instead of being remounted somewhere
 * else in the tree.
 */
describe("TerminalGrid pinned spotlight", () => {
  // A pin for a session this grid does not own — enough to put the grid in
  // spotlight mode while leaving its own (pre-launch) slot unmatched.
  const styles = new Map([[999, { bottom: 8, height: 174 }]]);

  it("flattens the grid so an ancestor can place the pinned tile", () => {
    const { container } = render(
      <TerminalGrid
        projectPath="C:/proj"
        tabId="tab-1"
        isActive={false}
        pinnedTileStyles={styles}
      />,
    );

    expect(container.firstElementChild?.className).toBe("contents");
  });

  it("hides every pane that is not the pinned one", () => {
    const { container } = render(
      <TerminalGrid
        projectPath="C:/proj"
        tabId="tab-1"
        isActive={false}
        pinnedTileStyles={styles}
      />,
    );

    // The eagleHidden branch renders className="hidden" exactly. A hidden tile
    // also drops its drag ids, so it is not a drop target for the active
    // project's pane-swap drag.
    const hidden = container.querySelector("div.hidden");
    expect(hidden).not.toBeNull();
    expect(container.querySelector("[data-slot-id][data-grid-id]")).toBeNull();
  });

  it("keeps its normal split layout when nothing of its is pinned", () => {
    const { container } = render(
      <TerminalGrid projectPath="C:/proj" tabId="tab-1" isActive={false} pinnedTileStyles={null} />,
    );

    expect(container.firstElementChild?.className).not.toBe("contents");
    expect(container.querySelector("div.hidden")).toBeNull();
  });
});
