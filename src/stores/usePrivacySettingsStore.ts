import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/** The two features that send the text of Claude conversations to Claude (issue #684). */
export type PrivacyFeature = "workshop" | "historySummaries";

/** One on/off answer per feature. */
export type PrivacyChoice = Record<PrivacyFeature, boolean>;

const ALL_OFF: PrivacyChoice = { workshop: false, historySummaries: false };

type PrivacySettingsState = {
  /** Whether the user let the Workshop run. `null` until they answer; off while unanswered. */
  workshop: boolean | null;
  /** Whether the user let History write summaries. `null` until they answer; off while unanswered. */
  historySummaries: boolean | null;
  /**
   * What the backend has confirmed it was told. A feature sends text only once
   * it is on here, so the front end never asks the backend before the backend
   * agrees. A feature switched off drops here at once.
   */
  confirmed: PrivacyChoice;
  /** Records the user's answer for one or both features. */
  setChoice: (choice: Partial<PrivacyChoice>) => void;
  /** True while the main window shows Settings opened at the Privacy section. */
  settingsRequested: boolean;
  /** Opens Settings at the Privacy section (main window only). */
  openSettings: () => void;
  closeSettings: () => void;
};

const lazyStore = new LazyStore("privacy-settings.json");

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

/** What the user's answers allow right now; unanswered counts as off. */
function allowedByChoice(state: PrivacySettingsState): PrivacyChoice {
  return { workshop: state.workshop === true, historySummaries: state.historySummaries === true };
}

function sameChoice(a: PrivacyChoice, b: PrivacyChoice): boolean {
  return a.workshop === b.workshop && a.historySummaries === b.historySummaries;
}

/**
 * Tells the backend what the user allows, then confirms it here. Anything
 * switched off stops in the front end before the backend is even told; a
 * failed call leaves the features that were not yet confirmed off.
 */
async function syncBackend(): Promise<void> {
  const store = usePrivacySettingsStore;
  const sent = allowedByChoice(store.getState());
  store.setState((s) => ({
    confirmed: {
      workshop: s.confirmed.workshop && sent.workshop,
      historySummaries: s.confirmed.historySummaries && sent.historySummaries,
    },
  }));
  try {
    await invoke("set_privacy_consent", sent);
  } catch (err) {
    console.error("Failed to tell the backend the privacy settings:", err);
    return;
  }
  // A newer change confirms itself with its own call.
  if (sameChoice(allowedByChoice(store.getState()), sent)) store.setState({ confirmed: sent });
}

export const usePrivacySettingsStore = create<PrivacySettingsState>()(
  persist(
    (set) => ({
      workshop: null,
      historySummaries: null,
      confirmed: ALL_OFF,
      setChoice: (choice) => {
        set(choice);
        void syncBackend();
      },
      settingsRequested: false,
      openSettings: () => set({ settingsRequested: true }),
      closeSettings: () => set({ settingsRequested: false }),
    }),
    {
      name: "maestro-privacy-settings",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        workshop: state.workshop,
        historySummaries: state.historySummaries,
      }),
      onRehydrateStorage: () => () => {
        void syncBackend();
      },
    },
  ),
);

/**
 * True once the saved choice has been read back from disk (or the read
 * failed). Uses zustand's own hydration state, like the Work Journal setting.
 */
export function usePrivacySettingsLoaded(): boolean {
  const [loaded, setLoaded] = useState(() => usePrivacySettingsStore.persist.hasHydrated());
  useEffect(() => {
    if (loaded) return;
    const stop = usePrivacySettingsStore.persist.onFinishHydration(() => setLoaded(true));
    // Hydration may have finished between the first render and this effect.
    if (usePrivacySettingsStore.persist.hasHydrated()) setLoaded(true);
    return stop;
  }, [loaded]);
  return loaded;
}

/** True only when the user let `feature` send text and the backend confirmed it. */
export function isPrivacyFeatureAllowed(feature: PrivacyFeature): boolean {
  return usePrivacySettingsStore.getState().confirmed[feature];
}

/** The same as {@link isPrivacyFeatureAllowed}, as a React hook. */
export function usePrivacyFeatureAllowed(feature: PrivacyFeature): boolean {
  return usePrivacySettingsStore((s) => s.confirmed[feature]);
}
