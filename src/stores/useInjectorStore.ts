import { create } from "zustand";
import type { InjectorRunResult } from "@/lib/injector";

/**
 * Injector sidebar tab state. Lives in a store (not component state) so the
 * draft message and the ticked terminals survive switching sidebar tabs —
 * every tab's content unmounts when another tab is shown.
 *
 * Runtime-only: session ids never survive an app restart, so nothing here
 * is persisted.
 */
interface InjectorState {
  /** The message to type into every ticked terminal. */
  message: string;
  /** Session ids ticked for the next injection. */
  selectedIds: number[];
  /** Outcome of the last Inject click, or null before the first one. */
  lastRun: InjectorRunResult | null;
  /** True while an injection is in flight (disables the button). */
  injecting: boolean;
  setMessage: (message: string) => void;
  toggleSession: (sessionId: number) => void;
  /** Replaces the whole selection (All / None / per-project toggles). */
  setSelected: (ids: number[]) => void;
  setLastRun: (result: InjectorRunResult | null) => void;
  setInjecting: (injecting: boolean) => void;
}

export const useInjectorStore = create<InjectorState>((set) => ({
  message: "",
  selectedIds: [],
  lastRun: null,
  injecting: false,
  setMessage: (message) => set({ message }),
  toggleSession: (sessionId) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(sessionId)
        ? s.selectedIds.filter((id) => id !== sessionId)
        : [...s.selectedIds, sessionId],
    })),
  setSelected: (ids) => set({ selectedIds: Array.from(new Set(ids)) }),
  setLastRun: (lastRun) => set({ lastRun }),
  setInjecting: (injecting) => set({ injecting }),
}));
