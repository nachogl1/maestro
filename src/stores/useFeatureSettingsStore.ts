import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/**
 * Which optional tools show in the top bar. Off hides the tool's button and
 * closes its side pane; the Samurai supervisor itself keeps running.
 */
type FeatureSettingsState = {
  samuraiLaunchEnabled: boolean;
  secondBrainEnabled: boolean;
  setSamuraiLaunchEnabled: (enabled: boolean) => void;
  setSecondBrainEnabled: (enabled: boolean) => void;
};

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
      samuraiLaunchEnabled: true,
      secondBrainEnabled: true,
      setSamuraiLaunchEnabled: (enabled) => set({ samuraiLaunchEnabled: enabled }),
      setSecondBrainEnabled: (enabled) => set({ secondBrainEnabled: enabled }),
    }),
    {
      name: "maestro-feature-settings",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        samuraiLaunchEnabled: state.samuraiLaunchEnabled,
        secondBrainEnabled: state.secondBrainEnabled,
      }),
    },
  ),
);
