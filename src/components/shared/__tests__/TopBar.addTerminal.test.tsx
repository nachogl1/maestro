import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({}),
}));

// The badges poll stores/Tauri on mount; they are not what these tests cover.
vi.mock("../GitHubWatchdogBadge", () => ({ GitHubWatchdogBadge: () => null }));
vi.mock("../HealthAttentionBadge", () => ({ HealthAttentionBadge: () => null }));
vi.mock("../WorkJournalSuggestionsBadge", () => ({
  useWorkJournalButtonLabel: () => "Work Journal",
  WorkJournalSuggestionsBadge: () => null,
  WorkJournalUnsavedDot: () => null,
}));

import { TopBar } from "../TopBar";

const baseProps = {
  hideWindowControls: true,
};

describe("TopBar add-terminal button", () => {
  afterEach(cleanup);

  it("shows the plus for an idle project and adds a terminal on click", () => {
    const onAddSession = vi.fn();
    render(<TopBar {...baseProps} hasActiveProject slotCount={0} onAddSession={onAddSession} />);

    fireEvent.click(screen.getByRole("button", { name: "Add session" }));

    expect(onAddSession).toHaveBeenCalledTimes(1);
  });

  it("hides the plus when no project is open", () => {
    render(<TopBar {...baseProps} onAddSession={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Add session" })).toBeNull();
  });

  it("shows the project dropdown plus in eagle view", () => {
    render(
      <TopBar
        {...baseProps}
        hasActiveProject
        eagleView
        eagleProjects={[{ tabId: "a", name: "alpha", color: "#f00", atMax: false }]}
        onAddSessionToProject={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Add terminal to project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add session" })).toBeNull();
  });

  it("adds the scratch-project row and pill to the eagle view drop-down only", () => {
    const onOpenScratch = vi.fn();
    const { unmount } = render(
      <TopBar
        {...baseProps}
        hasActiveProject
        onAddSession={vi.fn()}
        onOpenScratch={onOpenScratch}
      />,
    );
    expect(screen.queryByRole("button", { name: "New scratch project" })).toBeNull();
    unmount();

    render(
      <TopBar
        {...baseProps}
        hasActiveProject
        eagleView
        eagleProjects={[{ tabId: "a", name: "alpha", color: "#f00", atMax: false }]}
        onAddSessionToProject={vi.fn()}
        onOpenScratch={onOpenScratch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add terminal to project" }));

    expect(screen.getByRole("button", { name: "New scratch project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Scratch projects \(\d+\)$/ })).toBeTruthy();
  });
});

describe("TopBar tidy-up button", () => {
  afterEach(cleanup);

  it("sits left of the action icons outside eagle view and tidies on click", () => {
    const onTidyLayout = vi.fn();
    render(
      <TopBar {...baseProps} hasActiveProject onAddSession={vi.fn()} onTidyLayout={onTidyLayout} />,
    );

    const tidy = screen.getByRole("button", { name: "Tidy up terminals" });
    const add = screen.getByRole("button", { name: "Add session" });
    expect(tidy.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(tidy);
    expect(onTidyLayout).toHaveBeenCalledTimes(1);
  });

  it("shows in eagle view and tidies on click", () => {
    const onTidyLayout = vi.fn();
    render(<TopBar {...baseProps} hasActiveProject eagleView onTidyLayout={onTidyLayout} />);

    fireEvent.click(screen.getByRole("button", { name: "Tidy up terminals" }));
    expect(onTidyLayout).toHaveBeenCalledTimes(1);
  });

  it("hides when no project is open", () => {
    render(<TopBar {...baseProps} onTidyLayout={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Tidy up terminals" })).toBeNull();
  });
});

describe("TopBar PROJECTS pill", () => {
  afterEach(cleanup);

  it("shows the PROJECTS pill in the bar", () => {
    render(<TopBar {...baseProps} />);

    expect(screen.getByRole("button", { name: /PROJECTS/ })).toBeTruthy();
  });
});
