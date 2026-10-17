import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { WorkJournalSettingsGate } from "../WorkJournalSettingsGate";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  })),
}));
vi.mock("../WorkJournalSettingsSection", async () => {
  const { WorkJournalEnabledToggle } = await import("../WorkJournalEnabledToggle");
  return {
    WorkJournalSettingsSection: () => (
      <div data-testid="journal-settings">
        <WorkJournalEnabledToggle />
      </div>
    ),
  };
});

function journalSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "Enable the Work Journal" });
}

describe("WorkJournalSettingsGate", () => {
  beforeEach(() => {
    useWorkJournalSettingsStore.setState({ enabled: null });
  });

  it("shows only the switch, turned off, while the journal is off", () => {
    useWorkJournalSettingsStore.setState({ enabled: false });
    render(<WorkJournalSettingsGate />);
    expect(journalSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("journal-settings")).toBeNull();
  });

  it("treats an unanswered first-run question as off", () => {
    render(<WorkJournalSettingsGate />);
    expect(journalSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("journal-settings")).toBeNull();
  });

  it("turning the switch on enables the journal and shows its settings", () => {
    useWorkJournalSettingsStore.setState({ enabled: false });
    render(<WorkJournalSettingsGate />);
    fireEvent.click(journalSwitch());
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(true);
    expect(screen.getByTestId("journal-settings")).toBeTruthy();
  });

  it("turning the switch off disables the journal and hides its settings", () => {
    useWorkJournalSettingsStore.setState({ enabled: true });
    render(<WorkJournalSettingsGate />);
    expect(journalSwitch().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(journalSwitch());
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(false);
    expect(screen.queryByTestId("journal-settings")).toBeNull();
  });
});
