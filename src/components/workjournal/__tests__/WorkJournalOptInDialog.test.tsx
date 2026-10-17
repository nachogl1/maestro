import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { WorkJournalOptInDialog } from "../WorkJournalOptInDialog";

// The settings persist through the Tauri store plugin; happy-dom has no
// Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

describe("WorkJournalOptInDialog", () => {
  beforeEach(async () => {
    await useWorkJournalSettingsStore.persist.rehydrate();
    useWorkJournalSettingsStore.setState({ enabled: null });
    // The automatic-updates question was already answered.
    useUpdateStore.setState({ autoInstallOnLaunch: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks whether to enable the Work Journal when the user has not answered yet", () => {
    render(<WorkJournalOptInDialog />);
    expect(screen.getByRole("dialog", { name: "Enable the Work Journal?" })).toBeTruthy();
  });

  it("stays hidden until the saved choice has been read", () => {
    vi.spyOn(useWorkJournalSettingsStore.persist, "hasHydrated").mockReturnValue(false);
    vi.spyOn(useWorkJournalSettingsStore.persist, "onFinishHydration").mockReturnValue(() => {});
    render(<WorkJournalOptInDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waits for the automatic-updates question, so the two never stack", () => {
    useUpdateStore.setState({ autoInstallOnLaunch: null });
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
