import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }),
}));
vi.mock("@/lib/platform", () => ({ isMac: () => false }));
vi.mock("@/hooks/useProjectStatus", () => ({
  STATUS_COLORS: { idle: "bg-idle" },
  useProjectStatus: (tabId: string) => ({
    status: "idle",
    sessionCount: 0,
    contextAlert: tabId === "tab-1",
    // tab-1 also needs the user, to show the red alert outranks the blink.
    hasAttention: tabId === "tab-1" || tabId === "tab-2",
  }),
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
        onReorderTab={vi.fn()}
        onMoveTab={vi.fn()}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalled();
    const activeTab = screen.getByRole("tab", { selected: true });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(activeTab);
  });

  it("blinks red only the tabs whose project has a terminal past the context alert", () => {
    renderTabs(makeTabs(3));

    const [first, second] = screen.getAllByRole("tab");
    expect(second.className).toContain("project-tab-context-alert");
    expect(second.getAttribute("data-context-alert")).toBe("true");
    expect(first.className).not.toContain("project-tab-context-alert");
    expect(first.hasAttribute("data-context-alert")).toBe(false);
  });

  it("blinks yellow, on the shared clock, the tab whose project has a terminal needing the user", () => {
    vi.spyOn(performance, "now").mockReturnValue(2_300);
    renderTabs(makeTabs(3));

    const [quiet, redAlert, attention] = screen.getAllByRole("tab");
    expect(attention.className).toContain("attention-blink");
    expect(attention.getAttribute("data-attention")).toBe("true");
    expect(attention.style.animationDuration).toBe("1200ms");
    expect(attention.style.animationDelay).toBe("-1100ms");
    expect(redAlert.className).not.toContain("attention-blink");
    expect(quiet.className).not.toContain("attention-blink");
    expect(quiet.style.animationDelay).toBe("");
    vi.restoreAllMocks();
  });

  it("marks a scratch project's tab and no other", () => {
    const tabs = makeTabs(2);
    tabs[1] = { ...tabs[1], scratch: true };
    renderTabs(tabs);

    const [normal, scratch] = screen.getAllByRole("tab");
    expect(scratch.querySelector('[aria-label="Scratch project"]')).not.toBeNull();
    expect(normal.querySelector('[aria-label="Scratch project"]')).toBeNull();
  });
});
