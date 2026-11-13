import { create } from "zustand";

/**
 * The terminal the person last focused, across every project's grid (the
 * Files panel shows its folder). In-memory only: session ids are reassigned
 * each app launch.
 */
interface FocusedTerminalState {
  focusedSessionId: number | null;
  setFocusedSessionId: (sessionId: number) => void;
}

export const useFocusedTerminalStore = create<FocusedTerminalState>((set) => ({
  focusedSessionId: null,
  setFocusedSessionId: (sessionId) => set({ focusedSessionId: sessionId }),
}));
