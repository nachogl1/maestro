import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

import { type ProjectTab, ProjectTabs } from "../ProjectTabs";

function renderTabs(tabs: ProjectTab[], onTogglePinTab = vi.fn()) {
  render(
    <ProjectTabs
      tabs={tabs}
      onSelectTab={vi.fn()}
      onCloseTab={vi.fn()}
      onNewTab={vi.fn()}
      onToggleSidebar={vi.fn()}
      sidebarOpen={false}
      onReorderTab={vi.fn()}
      onMoveTab={vi.fn()}
      onTogglePinTab={onTogglePinTab}
    />,
  );
  return onTogglePinTab;
}

describe("ProjectTabs pinning", () => {
  it("offers a pin control on every tab", () => {
    const onTogglePinTab = renderTabs([{ id: "a", name: "Alpha", active: true }]);

    fireEvent.click(screen.getByLabelText("Pin Alpha"));

    expect(onTogglePinTab).toHaveBeenCalledWith("a");
  });

  it("offers the same control as unpin once the tab is pinned", () => {
    const onTogglePinTab = renderTabs([{ id: "a", name: "Alpha", active: true, pinned: true }]);

    expect(screen.queryByLabelText("Pin Alpha")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Unpin Alpha"));

    expect(onTogglePinTab).toHaveBeenCalledWith("a");
  });

  it("keeps the pin control out of the drag gesture", () => {
    // dnd-kit's PointerSensor listens on the tab; a pointerdown that reached
    // it would start a drag instead of toggling the pin.
    renderTabs([{ id: "a", name: "Alpha", active: true }]);

    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(event, "stopPropagation");
    screen.getByLabelText("Pin Alpha").dispatchEvent(event);

    expect(stopPropagation).toHaveBeenCalled();
  });

  it("still closes the tab from its own button", () => {
    const onCloseTab = vi.fn();
    render(
      <ProjectTabs
        tabs={[{ id: "a", name: "Alpha", active: true, pinned: true }]}
        onSelectTab={vi.fn()}
        onCloseTab={onCloseTab}
        onNewTab={vi.fn()}
        onToggleSidebar={vi.fn()}
        sidebarOpen={false}
        onReorderTab={vi.fn()}
        onMoveTab={vi.fn()}
        onTogglePinTab={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Close Alpha"));

    expect(onCloseTab).toHaveBeenCalledWith("a");
  });

  it("renders tabs in the order it is given (the store owns pinned-first)", () => {
    renderTabs([
      { id: "p", name: "Pinned", active: false, pinned: true },
      { id: "a", name: "Alpha", active: true },
    ]);

    const labels = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(labels?.[0]).toContain("Pinned");
    expect(labels?.[1]).toContain("Alpha");
  });
});
