import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/**
 * The Settings switch "Play a sound when a terminal needs you" (issue #496),
 * off by default. Read by the session store before it plays the attention
 * tone (`src/lib/attentionSound.ts`).
 */
interface AttentionSoundState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

// --- Tauri LazyStore-backed StateStorage adapter (same shape as the other settings stores) ---

const lazyStore = new LazyStore("attention-sound-settings.json");

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

export const useAttentionSoundStore = create<AttentionSoundState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "maestro-attention-sound-settings",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ enabled: state.enabled }),
    },
  ),
);
