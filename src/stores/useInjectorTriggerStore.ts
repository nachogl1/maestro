import { create } from "zustand";
import type {
  InjectorTrigger,
  InjectorTriggerFire,
  InjectorTriggerTarget,
} from "@/lib/injectorTriggers";

/**
 * Injector triggers (see `lib/injectorTriggers.ts`). Watched by
 * `useInjectorTriggers`, which is mounted for the whole app so triggers keep
 * firing while the Injector panel is closed.
 *
 * Runtime-only like the Injector selection: session ids never survive an app
 * restart, so nothing here is persisted.
 */
interface InjectorTriggerState {
  triggers: InjectorTrigger[];
  addTrigger: (input: {
    watchIds: number[];
    threshold: number;
    message: string;
    target: InjectorTriggerTarget;
  }) => void;
  removeTrigger: (id: string) => void;
  /** Replaces the `firedIds` of the listed triggers in one update. */
  setFiredIds: (firedIds: Map<string, number[]>) => void;
  setLastFire: (id: string, fire: InjectorTriggerFire) => void;
}

let nextTriggerId = 1;

export const useInjectorTriggerStore = create<InjectorTriggerState>((set) => ({
  triggers: [],
  addTrigger: ({ watchIds, threshold, message, target }) =>
    set((s) => ({
      triggers: [
        ...s.triggers,
        {
          id: `trigger-${nextTriggerId++}`,
          watchIds: Array.from(new Set(watchIds)),
          threshold,
          message,
          target,
          firedIds: [],
          lastFire: null,
        },
      ],
    })),
  removeTrigger: (id) => set((s) => ({ triggers: s.triggers.filter((t) => t.id !== id) })),
  setFiredIds: (firedIds) =>
    set((s) => ({
      triggers: s.triggers.map((t) =>
        firedIds.has(t.id) ? { ...t, firedIds: firedIds.get(t.id) ?? [] } : t,
      ),
    })),
  setLastFire: (id, fire) =>
    set((s) => ({
      triggers: s.triggers.map((t) => (t.id === id ? { ...t, lastFire: fire } : t)),
    })),
}));
