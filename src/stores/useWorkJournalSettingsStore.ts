import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

type WorkJournalSettingsState = {
  /**
   * Whether the user turned the Work Journal on. `null` until they answer the
   * first-run question; the journal stays off while unanswered.
   */
  enabled: boolean | null;
  /** True once the saved choice has been read from disk (or the read failed). */
  hasHydrated: boolean;
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
      hasHydrated: false,
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
        useWorkJournalSettingsStore.setState({ hasHydrated: true });
        void syncBackend(state?.enabled ?? null);
      },
    },
  ),
);

/** True only when the user opted in to the Work Journal. */
export function useWorkJournalEnabled(): boolean {
  return useWorkJournalSettingsStore((s) => s.enabled === true);
}
