import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the mock factory and the assertions share one LazyStore stub.
const lazy = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
}));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => lazy),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { useWorkJournalSettingsStore } from "../useWorkJournalSettingsStore";

describe("useWorkJournalSettingsStore", () => {
  beforeEach(() => {
    lazy.get.mockReset().mockResolvedValue(null);
    lazy.set.mockReset().mockResolvedValue(undefined);
    lazy.save.mockReset().mockResolvedValue(undefined);
    lazy.delete.mockReset().mockResolvedValue(undefined);
    invoke.mockReset().mockResolvedValue(undefined);
    useWorkJournalSettingsStore.setState({ enabled: null });
  });

  it("starts unanswered, so the journal is off until the user opts in", () => {
    expect(useWorkJournalSettingsStore.getInitialState().enabled).toBeNull();
  });

  it("setEnabled records the user's choice", () => {
    useWorkJournalSettingsStore.getState().setEnabled(true);
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(true);
    useWorkJournalSettingsStore.getState().setEnabled(false);
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(false);
  });

  it("persists the choice to its own Tauri store file", async () => {
    useWorkJournalSettingsStore.getState().setEnabled(true);
    await vi.waitFor(() => expect(lazy.save).toHaveBeenCalled());
    const [name, value] = lazy.set.mock.calls.at(-1) as [string, string];
    expect(name).toBe("maestro-work-journal-settings");
    expect(JSON.parse(value).state).toEqual({ enabled: true });
  });

  it("rehydrates a saved choice", async () => {
    lazy.get.mockResolvedValue(JSON.stringify({ state: { enabled: false }, version: 0 }));
    await useWorkJournalSettingsStore.persist.rehydrate();
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(false);
    expect(useWorkJournalSettingsStore.persist.hasHydrated()).toBe(true);
  });

  it("does not write the settings file back while reading it", async () => {
    lazy.get.mockResolvedValue(JSON.stringify({ state: { enabled: true }, version: 0 }));
    lazy.set.mockClear();
    await useWorkJournalSettingsStore.persist.rehydrate();
    expect(lazy.set).not.toHaveBeenCalled();
  });

  it("stays unanswered when the stored read throws", async () => {
    lazy.get.mockRejectedValue(new Error("disk gone"));
    await useWorkJournalSettingsStore.persist.rehydrate();
    expect(useWorkJournalSettingsStore.getState().enabled).toBeNull();
    expect(useWorkJournalSettingsStore.persist.hasHydrated()).toBe(true);
  });

  it("tells the backend whether to record terminal activity when the choice changes", () => {
    useWorkJournalSettingsStore.getState().setEnabled(true);
    expect(invoke).toHaveBeenCalledWith("set_work_journal_enabled", { enabled: true });
    useWorkJournalSettingsStore.getState().setEnabled(false);
    expect(invoke).toHaveBeenCalledWith("set_work_journal_enabled", { enabled: false });
  });

  it("tells the backend the saved choice after rehydrating", async () => {
    lazy.get.mockResolvedValue(JSON.stringify({ state: { enabled: true }, version: 0 }));
    await useWorkJournalSettingsStore.persist.rehydrate();
    expect(invoke).toHaveBeenCalledWith("set_work_journal_enabled", { enabled: true });
  });
});
