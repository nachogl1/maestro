import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

type WorkJournalSettingsState = {
  /**
   * Whether the user turned the Work Journal on. `null` until they answer the
   * first-run question; the journal stays off while unanswered.
   */
  enabled: boolean | null;
  setEnabled: (enabled: boolean) => void;
};

const lazyStore = new LazyStore("work-journal-settings.json");

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

/** Tells the backend whether to record terminal activity for the journal. */
async function syncBackend(enabled: boolean | null): Promise<void> {
  try {
    await invoke("set_work_journal_enabled", { enabled: enabled === true });
  } catch (err) {
    console.error("Failed to tell the backend the Work Journal setting:", err);
  }
}

export const useWorkJournalSettingsStore = create<WorkJournalSettingsState>()(
  persist(
    (set) => ({
      enabled: null,
      setEnabled: (enabled) => {
        set({ enabled });
        void syncBackend(enabled);
      },
    }),
    {
      name: "maestro-work-journal-settings",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ enabled: state.enabled }),
      onRehydrateStorage: () => (state) => {
        void syncBackend(state?.enabled ?? null);
      },
    },
  ),
);

/**
 * True once the saved choice has been read back from disk (or the read
 * failed). Uses zustand's own hydration state, so loading never writes the
 * settings file.
 */
export function useWorkJournalSettingsLoaded(): boolean {
  const [loaded, setLoaded] = useState(() => useWorkJournalSettingsStore.persist.hasHydrated());
  useEffect(() => {
    if (loaded) return;
    const stop = useWorkJournalSettingsStore.persist.onFinishHydration(() => setLoaded(true));
    // Hydration may have finished between the first render and this effect.
    if (useWorkJournalSettingsStore.persist.hasHydrated()) setLoaded(true);
    return stop;
  }, [loaded]);
  return loaded;
}

/** True only when the user opted in to the Work Journal. */
export function useWorkJournalEnabled(): boolean {
  return useWorkJournalSettingsStore((s) => s.enabled === true);
}
