import { create } from "zustand";
import { getClaudeUsage, type UsageData } from "@/lib/usageParser";

const POLL_INTERVAL_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 300_000;

interface UsageState {
  usage: UsageData | null;
  isLoading: boolean;
  error: string | null;
  lastFetch: Date | null;
  needsAuth: boolean;

  fetchUsage: (force?: boolean) => Promise<void>;
  /** Subscribe to polling. Ref-counted across mounts; returns cleanup. */
  startPolling: () => () => void;
}

let globalTimeoutId: ReturnType<typeof setTimeout> | null = null;
let pollingRefCount = 0;
let consecutiveErrors = 0;

export const useUsageStore = create<UsageState>()((set, get) => ({
  usage: null,
  isLoading: false,
  error: null,
  lastFetch: null,
  needsAuth: false,

  fetchUsage: async (force = false) => {
    if (get().isLoading) return;
    set({ isLoading: true, error: null });
    try {
      const usage = await getClaudeUsage(force);
      const needsAuth = usage.needsAuth;
      const hasError = !needsAuth && !!usage.errorMessage;
      if (hasError) consecutiveErrors++;
      else consecutiveErrors = 0;
      set({
        usage,
        needsAuth,
        isLoading: false,
        lastFetch: new Date(),
        error: needsAuth ? null : usage.errorMessage,
      });
    } catch (err) {
      console.error("Failed to fetch Claude usage:", err);
      consecutiveErrors++;
      set({ error: String(err), isLoading: false });
    }
  },

  startPolling: () => {
    pollingRefCount++;
    if (pollingRefCount === 1) {
      get().fetchUsage();
      const scheduleNext = () => {
        const backoffMs =
          consecutiveErrors > 0
            ? Math.min(POLL_INTERVAL_MS * 2 ** consecutiveErrors, MAX_POLL_INTERVAL_MS)
            : POLL_INTERVAL_MS;
        globalTimeoutId = setTimeout(() => {
          get().fetchUsage();
          scheduleNext();
        }, backoffMs);
      };
      scheduleNext();
    }
    return () => {
      pollingRefCount = Math.max(0, pollingRefCount - 1);
      if (pollingRefCount === 0 && globalTimeoutId) {
        clearTimeout(globalTimeoutId);
        globalTimeoutId = null;
        consecutiveErrors = 0;
      }
    };
  },
}));
