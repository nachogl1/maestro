import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import { WorkJournalSettingsHost } from "../WorkJournalSettingsHost";

// Settings itself has its own tests; here only whether it opens, and where.
vi.mock("@/components/settings/SettingsDialog", () => ({
  SettingsDialog: ({
    initialSection,
    theme,
    onClose,
  }: {
    initialSection?: string;
    theme?: string;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Settings" data-section={initialSection} data-theme={theme}>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

const INITIAL_STATE = useWorkJournalBackupStore.getState();

describe("WorkJournalSettingsHost", () => {
  beforeEach(() => {
    useWorkJournalBackupStore.setState(INITIAL_STATE, true);
  });

  it("shows Settings at the Work Journal section while requested, and closes it", () => {
    render(<WorkJournalSettingsHost theme="light" onToggleTheme={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => useWorkJournalBackupStore.getState().openSettings());
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("data-section", "work-journal");
    expect(dialog).toHaveAttribute("data-theme", "light");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useWorkJournalBackupStore.getState().settingsRequested).toBe(false);
  });
});
