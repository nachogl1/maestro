import { create } from "zustand";
import { getClaudeAccount, type ClaudeAccount } from "@/lib/usageParser";

interface ClaudeAccountState {
  account: ClaudeAccount | null;
  loaded: boolean;
  fetch: () => Promise<void>;
}

export const useClaudeAccountStore = create<ClaudeAccountState>()((set, get) => ({
  account: null,
  loaded: false,
  fetch: async () => {
    if (get().loaded) return;
    try {
      const account = await getClaudeAccount();
      set({ account, loaded: true });
    } catch (err) {
      console.error("Failed to fetch Claude account:", err);
      set({ loaded: true });
    }
  },
}));
