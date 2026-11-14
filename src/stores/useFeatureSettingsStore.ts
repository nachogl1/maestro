import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/**
 * Which optional tools show in the strip on the left. Off hides the tool's
 * icon and closes its panel.
 */
type FeatureSettingsState = {
  secondBrainEnabled: boolean;
  setSecondBrainEnabled: (enabled: boolean) => void;
};

/** The saved switches this version still knows; older files may carry more. */
type SavedFeatureSettings = Pick<FeatureSettingsState, "secondBrainEnabled">;

const lazyStore = new LazyStore("feature-settings.json");

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await lazyStore.get<string>(name)) ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    await lazyStore.set(name, value);
    await lazyStore.save();
  },
  removeItem: async (name) => {
    await lazyStore.delete(name);
    await lazyStore.save();
  },
};

export const useFeatureSettingsStore = create<FeatureSettingsState>()(
  persist(
    (set) => ({
      secondBrainEnabled: true,
      setSecondBrainEnabled: (enabled) => set({ secondBrainEnabled: enabled }),
    }),
    {
      name: "maestro-feature-settings",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state): SavedFeatureSettings => ({
        secondBrainEnabled: state.secondBrainEnabled,
      }),
      // A file saved before Samurai was removed still carries its launch
      // switch; only the switches that still exist are taken from it.
      merge: (saved, current) => {
        const value = (saved ?? {}) as Partial<SavedFeatureSettings>;
        return typeof value.secondBrainEnabled === "boolean"
          ? { ...current, secondBrainEnabled: value.secondBrainEnabled }
          : current;
      },
    },
  ),
);
