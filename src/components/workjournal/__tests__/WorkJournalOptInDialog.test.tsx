import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { WorkJournalOptInDialog } from "../WorkJournalOptInDialog";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  })),
}));

describe("WorkJournalOptInDialog", () => {
  beforeEach(() => {
    useWorkJournalSettingsStore.setState({ enabled: null, hasHydrated: true });
  });

  it("asks whether to enable the Work Journal when the user has not answered yet", () => {
    render(<WorkJournalOptInDialog />);
    expect(screen.getByRole("dialog", { name: "Enable the Work Journal?" })).toBeTruthy();
  });

  it("stays hidden until the saved choice has been read", () => {
    useWorkJournalSettingsStore.setState({ hasHydrated: false });
    render(<WorkJournalOptInDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays hidden once the user has answered", () => {
    useWorkJournalSettingsStore.setState({ enabled: false });
    render(<WorkJournalOptInDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enable turns the journal on and closes the dialog", () => {
    render(<WorkJournalOptInDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Not now keeps the journal off and records the answer", () => {
    render(<WorkJournalOptInDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closing the dialog counts as Not now", () => {
    render(<WorkJournalOptInDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(false);
  });
});
