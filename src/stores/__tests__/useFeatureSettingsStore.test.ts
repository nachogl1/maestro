import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the mock factory and the assertions share one LazyStore stub.
const lazy = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => lazy),
}));

import { useFeatureSettingsStore } from "../useFeatureSettingsStore";

describe("useFeatureSettingsStore", () => {
  beforeEach(() => {
    lazy.get.mockReset().mockResolvedValue(null);
    lazy.set.mockReset().mockResolvedValue(undefined);
    lazy.save.mockReset().mockResolvedValue(undefined);
    lazy.delete.mockReset().mockResolvedValue(undefined);
    useFeatureSettingsStore.setState({ samuraiLaunchEnabled: true, secondBrainEnabled: true });
  });

  it("keeps Samurai launch and Second Brain on by default", () => {
    const initial = useFeatureSettingsStore.getInitialState();
    expect(initial.samuraiLaunchEnabled).toBe(true);
    expect(initial.secondBrainEnabled).toBe(true);
  });

  it("turns each feature off on its own", () => {
    useFeatureSettingsStore.getState().setSamuraiLaunchEnabled(false);
    expect(useFeatureSettingsStore.getState().samuraiLaunchEnabled).toBe(false);
    expect(useFeatureSettingsStore.getState().secondBrainEnabled).toBe(true);
    useFeatureSettingsStore.getState().setSecondBrainEnabled(false);
    expect(useFeatureSettingsStore.getState().secondBrainEnabled).toBe(false);
  });

  it("persists the switches to their own Tauri store", async () => {
    useFeatureSettingsStore.getState().setSecondBrainEnabled(false);
    await vi.waitFor(() => expect(lazy.save).toHaveBeenCalled());
    const [name, value] = lazy.set.mock.calls.at(-1) as [string, string];
    expect(name).toBe("maestro-feature-settings");
    expect(JSON.parse(value).state).toEqual({
      samuraiLaunchEnabled: true,
      secondBrainEnabled: false,
    });
  });

  it("rehydrates saved switches", async () => {
    lazy.get.mockResolvedValue(
      JSON.stringify({
        state: { samuraiLaunchEnabled: false, secondBrainEnabled: false },
        version: 0,
      }),
    );
    await useFeatureSettingsStore.persist.rehydrate();
    expect(useFeatureSettingsStore.getState().samuraiLaunchEnabled).toBe(false);
    expect(useFeatureSettingsStore.getState().secondBrainEnabled).toBe(false);
  });

  it("keeps the features on when the stored read throws", async () => {
    lazy.get.mockRejectedValue(new Error("disk gone"));
    await useFeatureSettingsStore.persist.rehydrate();
    expect(useFeatureSettingsStore.getState().samuraiLaunchEnabled).toBe(true);
    expect(useFeatureSettingsStore.getState().secondBrainEnabled).toBe(true);
  });
});
