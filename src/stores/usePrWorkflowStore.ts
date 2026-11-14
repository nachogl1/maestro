import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { WorkflowGraph } from "@/lib/workflowGraphTypes";

/**
 * The user's edited PR review workflow — the graph whose steps are the
 * checkboxes in the PR monitor's action dropdown. Persisted across app
 * restarts through the Tauri store plugin, mirroring
 * `useSamuraiWorkflowStore` (its own file, so the two workflows never
 * overwrite each other).
 *
 * `null` means "never edited": `DEFAULT_PR_WORKFLOW` (frontend-owned — no
 * Rust command compiles this graph) then governs, and future changes to that
 * default apply. A graph only lands here once the user actually edits.
 */

type PrWorkflowState = {
  /** The edited graph, or null when DEFAULT_PR_WORKFLOW still governs. */
  graph: WorkflowGraph | null;
  setGraph: (graph: WorkflowGraph) => void;
  /** Back to "never edited" — the default workflow governs again. */
  resetGraph: () => void;
};

const lazyStore = new LazyStore("pr-workflow.json");

/**
 * A failed WRITE of the edited graph. Its own store rather than a field on
 * the persisted one: writing the error back there would trigger another
 * persist write on every failure.
 */
type PrWorkflowSaveErrorState = {
  saveError: string | null;
  setSaveError: (message: string | null) => void;
};

export const usePrWorkflowSaveError = create<PrWorkflowSaveErrorState>()((set) => ({
  saveError: null,
  setSaveError: (saveError) => set({ saveError }),
}));

function reportSaveError(message: string | null): void {
  if (usePrWorkflowSaveError.getState().saveError !== message) {
    usePrWorkflowSaveError.getState().setSaveError(message);
  }
}

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    try {
      const raw = (await lazyStore.get<string>(name)) ?? null;
      if (raw === null) return null;
      // The persist middleware parses this with an unguarded `JSON.parse`,
      // and zustand never marks a FAILED hydration as finished — a corrupt
      // file would leave `hasHydrated()` false forever and hang every read
      // gated on it. Degrade to "never edited" instead.
      JSON.parse(raw);
      return raw;
    } catch (error) {
      console.error("Failed to read the persisted PR workflow:", error);
      return null;
    }
  },
  setItem: async (name, value) => {
    // An unhandled rejection here left the canvas showing an edit that was
    // never written: the next app start would silently use the OLD graph.
    try {
      await lazyStore.set(name, value);
      await lazyStore.save();
      reportSaveError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to save the PR workflow:", error);
      reportSaveError(message);
    }
  },
  removeItem: async (name) => {
    try {
      await lazyStore.delete(name);
      await lazyStore.save();
      reportSaveError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to clear the PR workflow:", error);
      reportSaveError(message);
    }
  },
};

/**
 * Hydration gate: the LazyStore read is async, so for a brief startup window
 * the store still holds `graph: null` while a persisted edit is on its way
 * in. Two hazards, both closed here:
 *  - an edit made inside that window would be clobbered when rehydration
 *    lands (persist merges storage OVER current state) → the edit is
 *    remembered and re-applied the moment hydration finishes;
 *  - a read inside that window would wrongly fall back to the default
 *    workflow → {@link prWorkflowGraphForLaunch} awaits hydration.
 */
let pendingEdit: { graph: WorkflowGraph | null } | null = null;

/**
 * Hydration-FAILURE latch — see `useSamuraiWorkflowStore`. zustand marks only
 * a SUCCESSFUL hydration as finished, so without this a failed read left
 * every gated PR action waiting forever. Cleared when an attempt starts.
 */
let hydrationFailed = false;
const hydrationFailureWaiters = new Set<() => void>();

function markHydrationFailed(): void {
  hydrationFailed = true;
  for (const waiter of [...hydrationFailureWaiters]) waiter();
}

export const usePrWorkflowStore = create<PrWorkflowState>()(
  persist(
    (set) => ({
      graph: null,
      setGraph: (graph) => {
        if (!usePrWorkflowStore.persist.hasHydrated()) pendingEdit = { graph };
        set({ graph });
      },
      resetGraph: () => {
        if (!usePrWorkflowStore.persist.hasHydrated()) pendingEdit = { graph: null };
        set({ graph: null });
      },
    }),
    {
      name: "maestro-pr-workflow",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ graph: state.graph }),
      onRehydrateStorage: () => {
        // Called when an attempt STARTS; the returned callback when it ends.
        hydrationFailed = false;
        return (_state, error) => {
          if (error === undefined) return;
          console.error("Failed to load the persisted PR workflow:", error);
          markHydrationFailed();
        };
      },
    },
  ),
);

// Re-apply an edit that raced rehydration — registered before any reader's
// waiter, so a concurrently-gated read resolves AFTER the re-apply.
usePrWorkflowStore.persist.onFinishHydration(() => {
  if (pendingEdit === null) return;
  const { graph } = pendingEdit;
  pendingEdit = null;
  // setState goes through the persist middleware, so the re-apply is also
  // written back to disk.
  usePrWorkflowStore.setState({ graph });
});

/**
 * The graph a PR action should compile from: waits for the persisted edit (if
 * any) to finish loading, so an action fired right after app start cannot
 * fall back to the default while an edit exists on disk. `null` still means
 * "never edited" — the caller falls back to `DEFAULT_PR_WORKFLOW`.
 */
export async function prWorkflowGraphForLaunch(): Promise<WorkflowGraph | null> {
  const { persist: persistApi } = usePrWorkflowStore;
  if (!persistApi.hasHydrated()) {
    await new Promise<void>((resolve) => {
      let unsubscribe: () => void = () => {};
      const settle = () => {
        unsubscribe();
        hydrationFailureWaiters.delete(settle);
        resolve();
      };
      unsubscribe = persistApi.onFinishHydration(settle);
      // Hydration may have finished between the check and the subscribe —
      // and a FAILED one fires no finish listener at all, so the failure
      // latch has to settle the gate or the read waits forever.
      if (persistApi.hasHydrated() || hydrationFailed) settle();
      else hydrationFailureWaiters.add(settle);
    });
  }
  return usePrWorkflowStore.getState().graph;
}
