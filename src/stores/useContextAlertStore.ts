import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/**
 * Context-usage alert: when a Claude terminal's context window fills past the
 * chosen percentage, its frame blinks red (see `.terminal-cell-context-alert`
 * in globals.css). Picked in the sidebar Settings tab (ContextAlertSection).
 */

/** Selectable thresholds, in percent of the model's context window. */
export const CONTEXT_ALERT_THRESHOLDS: readonly number[] = [50, 60, 70, 75, 80, 85, 90, 95];

/** Threshold used until the user picks one. */
export const DEFAULT_CONTEXT_ALERT_THRESHOLD = 80;

/**
 * True when the frame should blink: a threshold is set and the session's
 * last-known context usage has reached it. Sessions with no usage data yet
 * (undefined percent) never alert.
 */
export function isContextAlert(
  contextPercent: number | undefined,
  threshold: number | null,
): boolean {
  if (threshold === null || contextPercent === undefined) return false;
  return contextPercent >= threshold;
}

interface ContextAlertState {
  /** Percent (0-100) that triggers the alert, or null when the alert is off. */
  threshold: number | null;
  setThreshold: (threshold: number | null) => void;
}

// --- Tauri LazyStore-backed StateStorage adapter (same shape as the other settings stores) ---

const lazyStore = new LazyStore("context-alert-settings.json");

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

export const useContextAlertStore = create<ContextAlertState>()(
  persist(
    (set) => ({
      threshold: DEFAULT_CONTEXT_ALERT_THRESHOLD,
      setThreshold: (threshold) => set({ threshold }),
    }),
    {
      name: "maestro-context-alert-settings",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ threshold: state.threshold }),
    },
  ),
);
