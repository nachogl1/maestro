import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import { WorkJournalSettingsHost } from "../WorkJournalSettingsHost";

// Settings itself has its own tests; here only whether it opens, and where.
vi.mock("@/components/settings/MaestroSettingsModal", () => ({
  MaestroSettingsModal: ({
    focusSection,
    onClose,
  }: {
    focusSection?: string;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Maestro Settings" data-focus={focusSection}>
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
    render(<WorkJournalSettingsHost />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => useWorkJournalBackupStore.getState().openSettings());
    expect(screen.getByRole("dialog", { name: "Maestro Settings" })).toHaveAttribute(
      "data-focus",
      "work-journal",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useWorkJournalBackupStore.getState().settingsRequested).toBe(false);
  });
});
