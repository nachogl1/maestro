import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { samePath } from "@/lib/path";
import { isScratchPath } from "@/lib/scratch";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/** One scratch project as the backend lists it. */
export interface ScratchProject {
  name: string;
  /** Absolute path: the scratch folder joined with the name. */
  path: string;
  /** When the folder was made, in milliseconds since 1970. */
  createdAtMs: number;
}

interface ScratchListing {
  folder: string;
  projects: ScratchProject[];
}

/** What led to the delete-or-keep question. */
export type ScratchCloseReason = "last-terminal" | "close-tab";

/** The open delete-or-keep question for one scratch project. */
export interface ScratchQuestion {
  tabId: string;
  name: string;
  path: string;
  reason: ScratchCloseReason;
  /** Terminals still running in the tab; closing the tab stops them. */
  runningCount: number;
}

/** The person's answer: Delete, Keep, or dismissing the question. */
export type ScratchAnswer = "delete" | "keep" | "cancel";

type ScratchState = {
  /** The scratch folder chosen in Settings; null means the default one. */
  folderSetting: string | null;
  /** The scratch folder in use, as the backend resolved it (null until listed). */
  folder: string | null;
  /** Every scratch project, newest first. */
  projects: ScratchProject[];
  /** The last failure, as one plain sentence. */
  error: string | null;
  question: ScratchQuestion | null;
  /** Re-reads the scratch folder's projects. */
  refresh: () => Promise<void>;
  /** Makes a scratch project; resolves to its path, rejects with the reason as an Error. */
  create: (name: string) => Promise<string>;
  /** Closes the project's tab (and its terminals) if open, then deletes its folder. */
  remove: (path: string) => Promise<boolean>;
  setFolderSetting: (folder: string | null) => Promise<void>;
  isScratch: (path: string) => boolean;
  /** Raises the question when the tab is a scratch project; true when it did. */
  askBeforeClosingTab: (tabId: string) => boolean;
  /** Raises the question when a scratch project's last terminal was just closed. */
  askAfterTerminalClosed: (tabId: string) => void;
  answer: (choice: ScratchAnswer) => Promise<void>;
};

const lazyStore = new LazyStore("scratch-settings.json");

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await lazyStore.get<string>(name)) ?? null;
    } catch {
      return null;
    }
  },
  // Persist writes on every change and never awaits them: a failed save is
  // logged here rather than left as an unhandled rejection.
  setItem: async (name, value) => {
    try {
      await lazyStore.set(name, value);
      await lazyStore.save();
    } catch (err) {
      console.error("Failed to save the scratch folder setting:", err);
    }
  },
  removeItem: async (name) => {
    try {
      await lazyStore.delete(name);
      await lazyStore.save();
    } catch (err) {
      console.error("Failed to clear the scratch folder setting:", err);
    }
  },
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Only the newest listing lands, so a slow older one never overwrites it. */
let refreshSeq = 0;

export const useScratchStore = create<ScratchState>()(
  persist(
    (set, get) => {
      /** The open tab of a scratch project, if any. */
      const tabFor = (path: string) =>
        useWorkspaceStore.getState().tabs.find((t) => samePath(t.projectPath, path));

      const raise = (tabId: string, reason: ScratchCloseReason): boolean => {
        const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
        if (!tab || !get().isScratch(tab.projectPath)) return false;
        set({
          error: null,
          question: {
            tabId,
            name: tab.name,
            path: tab.projectPath,
            reason,
            runningCount: tab.sessionIds.length,
          },
        });
        return true;
      };

      return {
        folderSetting: null,
        folder: null,
        projects: [],
        error: null,
        question: null,

        refresh: async () => {
          const seq = ++refreshSeq;
          try {
            const listing = await invoke<ScratchListing>("scratch_list", {
              folder: get().folderSetting,
            });
            if (seq !== refreshSeq) return;
            set({ folder: listing.folder, projects: listing.projects, error: null });
          } catch (err) {
            if (seq !== refreshSeq) return;
            console.error("Failed to list scratch projects:", err);
            set({ projects: [], error: errorMessage(err) });
          }
        },

        create: async (name) => {
          let path: string;
          try {
            path = await invoke<string>("scratch_create", { folder: get().folderSetting, name });
          } catch (err) {
            throw new Error(errorMessage(err));
          }
          await get().refresh();
          return path;
        },

        remove: async (path) => {
          const tab = tabFor(path);
          if (tab) useWorkspaceStore.getState().closeTab(tab.id);
          let failure: string | null = null;
          try {
            await invoke("scratch_delete", { folder: get().folderSetting, path });
          } catch (err) {
            console.error("Failed to delete scratch project:", err);
            failure = errorMessage(err);
          }
          await get().refresh();
          if (failure) set({ error: failure });
          return failure === null;
        },

        setFolderSetting: async (folder) => {
          set({ folderSetting: folder });
          await get().refresh();
        },

        isScratch: (path) => isScratchPath(path, get().folder),

        askBeforeClosingTab: (tabId) => raise(tabId, "close-tab"),

        askAfterTerminalClosed: (tabId) => {
          const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
          if (tab && tab.sessionIds.length === 0) raise(tabId, "last-terminal");
        },

        answer: async (choice) => {
          const question = get().question;
          if (!question) return;
          if (choice === "delete") {
            // The question stays open on failure so its error shows there.
            if (await get().remove(question.path)) set({ question: null });
            return;
          }
          set({ question: null, error: null });
          if (choice === "keep" && question.reason === "close-tab") {
            useWorkspaceStore.getState().closeTab(question.tabId);
          }
        },
      };
    },
    {
      name: "maestro-scratch-settings",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ folderSetting: state.folderSetting }),
      // The saved folder setting arrives after the first render: list with it.
      onRehydrateStorage: () => (state) => {
        void state?.refresh();
      },
    },
  ),
);
