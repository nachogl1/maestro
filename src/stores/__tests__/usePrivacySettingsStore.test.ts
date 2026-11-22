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

import { isPrivacyFeatureAllowed, usePrivacySettingsStore } from "../usePrivacySettingsStore";

const OFF = { workshop: false, historySummaries: false };

describe("usePrivacySettingsStore", () => {
  beforeEach(() => {
    lazy.get.mockReset().mockResolvedValue(null);
    lazy.set.mockReset().mockResolvedValue(undefined);
    lazy.save.mockReset().mockResolvedValue(undefined);
    lazy.delete.mockReset().mockResolvedValue(undefined);
    invoke.mockReset().mockResolvedValue(undefined);
    usePrivacySettingsStore.setState({ workshop: null, historySummaries: null, confirmed: OFF });
  });

  it("starts unanswered with both features off", () => {
    const initial = usePrivacySettingsStore.getInitialState();
    expect(initial.workshop).toBeNull();
    expect(initial.historySummaries).toBeNull();
    expect(isPrivacyFeatureAllowed("workshop")).toBe(false);
    expect(isPrivacyFeatureAllowed("historySummaries")).toBe(false);
  });

  it("allows a feature only once the backend has confirmed the choice", async () => {
    let answer: () => void = () => {};
    invoke.mockReturnValue(
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
    );

    usePrivacySettingsStore.getState().setChoice({ workshop: true, historySummaries: false });

    expect(invoke).toHaveBeenCalledWith("set_privacy_consent", {
      workshop: true,
      historySummaries: false,
    });
    expect(isPrivacyFeatureAllowed("workshop")).toBe(false);
    answer();
    await vi.waitFor(() => expect(isPrivacyFeatureAllowed("workshop")).toBe(true));
    expect(isPrivacyFeatureAllowed("historySummaries")).toBe(false);
  });

  it("stops a feature switched off at once, before the backend answers", () => {
    usePrivacySettingsStore.setState({ workshop: true, confirmed: { ...OFF, workshop: true } });
    invoke.mockReturnValue(new Promise(() => {}));

    usePrivacySettingsStore.getState().setChoice({ workshop: false });

    expect(isPrivacyFeatureAllowed("workshop")).toBe(false);
    expect(invoke).toHaveBeenCalledWith("set_privacy_consent", OFF);
  });

  it("keeps a feature off when the backend could not be told", async () => {
    invoke.mockRejectedValue(new Error("backend gone"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    usePrivacySettingsStore.getState().setChoice({ workshop: true, historySummaries: true });

    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(usePrivacySettingsStore.getState().confirmed).toEqual(OFF);
  });

  it("persists only the answers to its own Tauri store file", async () => {
    usePrivacySettingsStore.getState().setChoice({ workshop: false, historySummaries: true });
    await vi.waitFor(() => expect(lazy.save).toHaveBeenCalled());
    const [name, value] = lazy.set.mock.calls.at(-1) as [string, string];
    expect(name).toBe("maestro-privacy-settings");
    expect(JSON.parse(value).state).toEqual({ workshop: false, historySummaries: true });
  });

  it("tells the backend a saved choice when it is read back", async () => {
    lazy.get.mockResolvedValue(
      JSON.stringify({ state: { workshop: true, historySummaries: false }, version: 0 }),
    );
    await usePrivacySettingsStore.persist.rehydrate();
    expect(invoke).toHaveBeenCalledWith("set_privacy_consent", {
      workshop: true,
      historySummaries: false,
    });
    await vi.waitFor(() => expect(isPrivacyFeatureAllowed("workshop")).toBe(true));
  });

  it("treats a missing saved choice (an update from an earlier version) as unanswered and off", async () => {
    await usePrivacySettingsStore.persist.rehydrate();
    expect(usePrivacySettingsStore.getState().workshop).toBeNull();
    expect(usePrivacySettingsStore.getState().historySummaries).toBeNull();
    expect(invoke).toHaveBeenCalledWith("set_privacy_consent", OFF);
  });
});
