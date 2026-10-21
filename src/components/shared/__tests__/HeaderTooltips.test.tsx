import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@/lib/platform", () => ({ isMac: () => false }));
vi.mock("@/hooks/useProjectStatus", () => ({
  STATUS_COLORS: { idle: "bg-idle" },
  useProjectStatus: () => ({ status: "idle", sessionCount: 0 }),
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

import { TerminalHeader } from "@/components/terminal/TerminalHeader";
import { ProjectTabs } from "../ProjectTabs";
import { TopBar } from "../TopBar";

/** Every button on screen, with its tooltip. */
function tooltips(): { name: string; title: string | null }[] {
  return screen.getAllByRole("button").map((b) => ({
    name: b.getAttribute("aria-label") ?? b.textContent ?? "",
    title: b.getAttribute("title"),
  }));
}

function titleOf(name: string): string | null {
  return screen.getByRole("button", { name }).getAttribute("title");
}

describe("header tooltips", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(cleanup);

  it("gives every top-bar button a tooltip, with its shortcut in brackets", () => {
    render(
      <TopBar
        sidebarOpen
        onToggleSidebar={vi.fn()}
        onToggleGitPanel={vi.fn()}
        hasActiveProject
        onAddSession={vi.fn()}
        onTidyLayout={vi.fn()}
        onToggleEagleView={vi.fn()}
        onToggleNotesPanel={vi.fn()}
        onToggleSecondBrainPanel={vi.fn()}
        onToggleLaunchPanel={vi.fn()}
        onToggleWorkJournalPanel={vi.fn()}
        onToggleWorkshopPanel={vi.fn()}
        onToggleInjectPanel={vi.fn()}
      />,
    );

    for (const { name, title } of tooltips()) {
      expect(title, `${name} has no tooltip`).toBeTruthy();
    }
    expect(titleOf("Toggle sidebar")).toBe("Toggle sidebar (Alt+1–3)");
    expect(titleOf("Tidy up terminals")).toMatch(/\(Alt\+T\)$/);
    expect(titleOf("Add session")).toBe("New terminal (Ctrl+T)");
    expect(titleOf("Eagle view")).toBe("Eagle view (Ctrl+G)");
    expect(titleOf("Notes")).toBe("Notes (Ctrl+5)");
    expect(titleOf("Injector")).toMatch(/\(Alt\+4\)$/);
    expect(titleOf("Git")).toBe("Git (Ctrl+2)");
    expect(titleOf("Close")).toBe("Close Maestro (Alt+F4)");
  });

  it("gives every project-tab bar button a tooltip", () => {
    render(
      <ProjectTabs
        tabs={[{ id: "a", name: "alpha", active: true }]}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
        onToggleSidebar={vi.fn()}
        sidebarOpen={false}
        onReorderTab={vi.fn()}
        onMoveTab={vi.fn()}
      />,
    );

    for (const { name, title } of tooltips()) {
      expect(title, `${name} has no tooltip`).toBeTruthy();
    }
    expect(titleOf("Toggle sidebar")).toBe("Toggle sidebar (Alt+1–3)");
    expect(titleOf("Close alpha")).toBe("Close project alpha");
    expect(titleOf("Close")).toBe("Close Maestro (Alt+F4)");
  });

  it("gives every terminal-header button a tooltip, with park and zoom shortcuts", () => {
    render(
      <TerminalHeader
        sessionId={3}
        onKill={vi.fn()}
        onRename={vi.fn()}
        onToggleZoom={vi.fn()}
        onPark={vi.fn()}
        onTogglePin={vi.fn()}
        zoomLevel={125}
        onSetZoomLevel={vi.fn()}
      />,
    );

    for (const { name, title } of tooltips()) {
      expect(title, `${name} has no tooltip`).toBeTruthy();
    }
    expect(titleOf("Park session 3")).toMatch(/\(Alt\+P\)$/);
    expect(titleOf("Zoom terminal")).toBe("Zoom terminal (Ctrl+1)");
  });
});
