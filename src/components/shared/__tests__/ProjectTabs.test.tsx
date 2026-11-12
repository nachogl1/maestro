import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

import { outsideDropPoint, type ProjectTab, ProjectTabs, tearOffPosition } from "../ProjectTabs";

const TABS: ProjectTab[] = [
  { id: "t1", name: "alpha", active: true },
  { id: "t2", name: "beta", active: false },
];

function renderTabs(onPopOutTab?: (id: string) => void, onCloseTab = vi.fn()) {
  render(
    <ProjectTabs
      tabs={TABS}
      onSelectTab={vi.fn()}
      onCloseTab={onCloseTab}
      onNewTab={vi.fn()}
      onToggleSidebar={vi.fn()}
      sidebarOpen
      onReorderTab={vi.fn()}
      onMoveTab={vi.fn()}
      onPopOutTab={onPopOutTab}
    />,
  );
  return { onCloseTab };
}

describe("ProjectTabs — move to new window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves a tab to a new window from its button", () => {
    const onPopOutTab = vi.fn();
    renderTabs(onPopOutTab);
    fireEvent.click(screen.getByRole("button", { name: "Move beta to a new window" }));
    expect(onPopOutTab).toHaveBeenCalledWith("t2");
  });

  it("moves a tab to a new window from its right-click menu", () => {
    const onPopOutTab = vi.fn();
    renderTabs(onPopOutTab);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to new window" }));
    expect(onPopOutTab).toHaveBeenCalledWith("t1");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes a project from its right-click menu", () => {
    const { onCloseTab } = renderTabs(vi.fn());
    fireEvent.contextMenu(screen.getByRole("tab", { name: /beta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close project" }));
    expect(onCloseTab).toHaveBeenCalledWith("t2");
  });

  it("dismisses the right-click menu on Escape", () => {
    renderTabs(vi.fn());
    fireEvent.contextMenu(screen.getByRole("tab", { name: /alpha/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves the focused tab with Cmd/Ctrl+Shift+N", () => {
    const onPopOutTab = vi.fn();
    renderTabs(onPopOutTab);
    fireEvent.keyDown(screen.getByRole("tab", { name: /alpha/ }), {
      key: "N",
      shiftKey: true,
      ctrlKey: true,
    });
    expect(onPopOutTab).toHaveBeenCalledWith("t1");
  });

  it("offers no move action when the handler is omitted", () => {
    renderTabs(undefined);
    expect(screen.queryByRole("button", { name: /to a new window/ })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /alpha/ }));
    expect(screen.queryByRole("menuitem", { name: "Move to new window" })).toBeNull();
  });
});

describe("tearOffPosition — dragging a tab out of the window", () => {
  const viewport = { width: 1200, height: 800 };

  it("keeps a drop inside the window as a reorder", () => {
    expect(
      tearOffPosition({ clientX: 300, clientY: 20, screenX: 400, screenY: 120 }, viewport),
    ).toBeNull();
  });

  it("opens the window where the tab was dropped on another screen", () => {
    expect(
      tearOffPosition({ clientX: 2000, clientY: 300, screenX: 2100, screenY: 400 }, viewport),
    ).toEqual({ x: 2020, y: 388 });
  });

  it("treats a drop above or left of the window as outside it", () => {
    expect(
      tearOffPosition({ clientX: -50, clientY: 10, screenX: -1500, screenY: 200 }, viewport),
    ).toEqual({ x: -1580, y: 188 });
    expect(
      tearOffPosition({ clientX: 100, clientY: -5, screenX: 200, screenY: 95 }, viewport),
    ).not.toBeNull();
  });
});

describe("outsideDropPoint — where a tab dragged out of the window was dropped", () => {
  const viewport = { width: 1200, height: 800 };

  it("gives the exact screen point of a drop outside the window, and null inside it", () => {
    expect(
      outsideDropPoint({ clientX: 2000, clientY: 300, screenX: 2100, screenY: 400 }, viewport),
    ).toEqual({ x: 2100, y: 400 });
    expect(
      outsideDropPoint({ clientX: 300, clientY: 20, screenX: 400, screenY: 120 }, viewport),
    ).toBeNull();
  });
});
