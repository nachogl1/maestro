import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }),
}));
vi.mock("@/lib/platform", () => ({ isMac: () => false }));
vi.mock("@/hooks/useProjectStatus", () => ({
  STATUS_COLORS: { idle: "bg-idle" },
  useProjectStatus: () => ({ status: "idle", sessionCount: 0 }),
}));

import { type ProjectTab, ProjectTabs } from "../ProjectTabs";

function makeTabs(count: number, activeIndex = 0): ProjectTab[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `tab-${i}`,
    name: `project-${i}`,
    active: i === activeIndex,
  }));
}

function renderTabs(tabs: ProjectTab[]) {
  return render(
    <ProjectTabs
      tabs={tabs}
      onSelectTab={vi.fn()}
      onCloseTab={vi.fn()}
      onNewTab={vi.fn()}
      onToggleSidebar={vi.fn()}
      sidebarOpen={false}
      onReorderTab={vi.fn()}
      onMoveTab={vi.fn()}
    />,
  );
}

describe("ProjectTabs layout: window controls and tab strip overflow", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(cleanup);

  it("keeps minimize, maximize and close in a non-shrinking group", () => {
    renderTabs(makeTabs(30));

    const controls = screen.getByRole("button", { name: "Minimize" }).parentElement;
    expect(controls).not.toBeNull();
    expect(controls?.className).toContain("shrink-0");
    expect(controls?.contains(screen.getByRole("button", { name: "Maximize" }))).toBe(true);
    expect(controls?.contains(screen.getByRole("button", { name: "Close" }))).toBe(true);
  });

  it("lets the tab strip shrink and scroll sideways without a visible scrollbar", () => {
    renderTabs(makeTabs(30));

    const tablist = screen.getByRole("tablist", { name: "Open projects" });
    expect(tablist.className).toContain("overflow-x-auto");
    expect(tablist.className).toContain("scrollbar-none");
    expect(tablist.className).toContain("min-w-0");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("shrink-0");
    }
  });

  it("turns a vertical mouse wheel into a sideways scroll of the tab strip", () => {
    renderTabs(makeTabs(30));

    const tablist = screen.getByRole("tablist", { name: "Open projects" });
    tablist.scrollLeft = 0;
    fireEvent.wheel(tablist, { deltaY: 40, deltaX: 0 });

    expect(tablist.scrollLeft).toBe(40);
  });

  it("scrolls the active tab into view when the selection changes", () => {
    const { rerender } = renderTabs(makeTabs(30, 0));
    const scrollIntoView = HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    scrollIntoView.mockClear();

    rerender(
      <ProjectTabs
        tabs={makeTabs(30, 25)}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
        onToggleSidebar={vi.fn()}
        sidebarOpen={false}
        onReorderTab={vi.fn()}
        onMoveTab={vi.fn()}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalled();
    const activeTab = screen.getByRole("tab", { selected: true });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(activeTab);
  });
});
