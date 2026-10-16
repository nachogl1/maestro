import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({}),
}));

// The badges poll stores/Tauri on mount; they are not what these tests cover.
vi.mock("../ParkedRunsBadge", () => ({ ParkedRunsBadge: () => null }));
vi.mock("../GitHubWatchdogBadge", () => ({ GitHubWatchdogBadge: () => null }));
vi.mock("../HealthAttentionBadge", () => ({ HealthAttentionBadge: () => null }));
vi.mock("../WorkJournalSuggestionsBadge", () => ({
  useWorkJournalButtonLabel: () => "Work Journal",
  WorkJournalSuggestionsBadge: () => null,
  WorkJournalUnsavedDot: () => null,
}));

import { TopBar } from "../TopBar";

const baseProps = {
  sidebarOpen: true,
  onToggleSidebar: vi.fn(),
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
});
