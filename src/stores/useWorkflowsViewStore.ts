import { create } from "zustand";

/**
 * Open/closed state of the full-screen workflow editor overlay
 * (`WorkflowsView`, issue #91 follow-up).
 *
 * The trigger button lives in the sidebar's Launch tab, several components
 * below `App`; the overlay itself renders at the `App` level, next to
 * the terminals. A store sidesteps prop-drilling an `onOpen` callback
 * through `Sidebar` — the same shape `useFDAStore` uses to let a deeply
 * nested caller pop the FDA dialog `App` renders.
 */
interface WorkflowsViewState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useWorkflowsViewStore = create<WorkflowsViewState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
