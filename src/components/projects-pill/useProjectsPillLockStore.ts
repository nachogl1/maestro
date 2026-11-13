import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/**
 * The PROJECTS pill's one lock button: "Blocked counted" (the default) counts
 * and lists blocked issues too; "Ready only" leaves them out. Remembered
 * across restarts.
 */
interface ProjectsPillLockState {
  countBlocked: boolean;
  setCountBlocked: (countBlocked: boolean) => void;
}

// --- Tauri LazyStore-backed StateStorage adapter (same shape as the other settings stores) ---

const lazyStore = new LazyStore("projects-pill-settings.json");

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const value = await lazyStore.get<string>(name);
      return value ?? null;
    } catch (err) {
      console.error(`tauriStorage.getItem("${name}") failed:`, err);
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      await lazyStore.set(name, value);
      await lazyStore.save();
    } catch (err) {
      console.error(`tauriStorage.setItem("${name}") failed:`, err);
      throw err;
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await lazyStore.delete(name);
      await lazyStore.save();
    } catch (err) {
      console.error(`tauriStorage.removeItem("${name}") failed:`, err);
      throw err;
    }
  },
};

export const useProjectsPillLockStore = create<ProjectsPillLockState>()(
  persist(
    (set) => ({
      countBlocked: true,
      setCountBlocked: (countBlocked) => set({ countBlocked }),
    }),
    {
      name: "maestro-projects-pill-settings",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ countBlocked: state.countBlocked }),
    },
  ),
);
