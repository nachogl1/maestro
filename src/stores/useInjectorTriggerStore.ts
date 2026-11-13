import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
  type InjectorTrigger,
  type InjectorTriggerFire,
  type InjectorTriggerTarget,
  type InjectorTriggerWatch,
  parseSavedTriggers,
  toSavedTrigger,
} from "@/lib/injectorTriggers";
import { useSessionStore } from "@/stores/useSessionStore";

/**
 * Injector triggers (see `lib/injectorTriggers.ts`). Watched by
 * `useInjectorTriggers`, which is mounted for the whole app so triggers keep
 * firing while the Injector panel is closed.
 *
 * Saved in Maestro's app data and loaded back on the next launch, re-armed.
 * Terminal ids are not saved (they start again from 1 on every launch), so a
 * trigger that watched ticked terminals comes back watching nothing until it
 * is edited.
 */

/** What the add and edit forms hand the store. */
export interface InjectorTriggerInput {
  /** Optional; empty shows the message's first words instead. */
  name?: string;
  /** Defaults to "ticked", the form's default. */
  watch?: InjectorTriggerWatch;
  /** The ticked terminals, used when `watch` is "ticked". */
  watchIds: number[];
  threshold: number;
  message: string;
  target: InjectorTriggerTarget;
}

interface InjectorTriggerState {
  triggers: InjectorTrigger[];
  addTrigger: (input: InjectorTriggerInput) => void;
  /** Replaces what defines a trigger, keeping its firing state. */
  updateTrigger: (id: string, input: InjectorTriggerInput) => void;
  removeTrigger: (id: string) => void;
  /** Replaces the `firedIds` of the listed triggers in one update. */
  setFiredIds: (firedIds: Map<string, number[]>) => void;
  setLastFire: (id: string, fire: InjectorTriggerFire) => void;
}

/** The fields of a trigger that an input sets. */
function fromInput(input: InjectorTriggerInput) {
  const watch = input.watch ?? "ticked";
  return {
    name: input.name?.trim() ?? "",
    watch,
    watchIds: watch === "ticked" ? Array.from(new Set(input.watchIds)) : [],
    threshold: input.threshold,
    message: input.message,
    target: input.target,
  };
}

let nextTriggerId = 1;

/** A trigger id no current trigger (loaded ones included) already has. */
function newTriggerId(triggers: InjectorTrigger[]): string {
  let id = `trigger-${nextTriggerId++}`;
  while (triggers.some((t) => t.id === id)) id = `trigger-${nextTriggerId++}`;
  return id;
}

// --- Tauri LazyStore-backed StateStorage adapter (same shape as the other settings stores) ---

const lazyStore = new LazyStore("injector-triggers.json");

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

export const useInjectorTriggerStore = create<InjectorTriggerState>()(
  persist(
    // Block bodies on purpose: the persisted `set` returns the save's promise,
    // which must not leak out of actions typed as returning nothing.
    (set) => ({
      triggers: [],
      addTrigger: (input) => {
        set((s) => ({
          triggers: [
            ...s.triggers,
            { id: newTriggerId(s.triggers), ...fromInput(input), firedIds: [], lastFire: null },
          ],
        }));
      },
      updateTrigger: (id, input) => {
        set((s) => ({
          triggers: s.triggers.map((t) => (t.id === id ? { ...t, ...fromInput(input) } : t)),
        }));
      },
      removeTrigger: (id) => {
        set((s) => ({ triggers: s.triggers.filter((t) => t.id !== id) }));
      },
      setFiredIds: (firedIds) => {
        set((s) => ({
          triggers: s.triggers.map((t) =>
            firedIds.has(t.id) ? { ...t, firedIds: firedIds.get(t.id) ?? [] } : t,
          ),
        }));
      },
      setLastFire: (id, fire) => {
        set((s) => ({
          triggers: s.triggers.map((t) => (t.id === id ? { ...t, lastFire: fire } : t)),
        }));
      },
    }),
    {
      name: "maestro-injector-triggers",
      version: 1,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ triggers: state.triggers.map(toSavedTrigger) }),
      // Any other saved version is read the same way: `merge` keeps only what it can use.
      migrate: (persisted) => persisted,
      // The saved file is untrusted: anything it holds goes through the parser,
      // and a trigger added before loading finished is kept.
      merge: (persisted, current) => {
        const saved = (persisted as { triggers?: unknown } | null | undefined)?.triggers;
        const loaded = parseSavedTriggers(saved);
        const added = current.triggers.filter((t) => !loaded.some((l) => l.id === t.id));
        return { ...current, triggers: [...loaded, ...added] };
      },
    },
  ),
);

// A closed terminal leaves every trigger that watched it, so a later terminal
// given the same number is never watched by accident (the rule the session
// store applies to its parked and pinned ids).
useSessionStore.subscribe((sessionState) => {
  const { triggers } = useInjectorTriggerStore.getState();
  const liveIds = new Set(sessionState.sessions.map((s) => s.id));
  if (!triggers.some((t) => t.watchIds.some((id) => !liveIds.has(id)))) return;
  useInjectorTriggerStore.setState({
    triggers: triggers.map((t) => ({ ...t, watchIds: t.watchIds.filter((id) => liveIds.has(id)) })),
  });
});
