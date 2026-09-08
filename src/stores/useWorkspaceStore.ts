import { arrayMove } from "@dnd-kit/sortable";
import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { isParkedPinned, type ParkedPin, parkedPinKey } from "@/lib/parkedPins";
import { killSession } from "@/lib/terminal";
import { useSessionStore } from "@/stores/useSessionStore";

// --- Types ---

/** The type of workspace - single repo, multi-repo, or non-git. */
export type WorkspaceType = "single-repo" | "multi-repo" | "non-git";

/** Information about a detected git repository within a workspace. */
export interface RepositoryInfo {
  /** Absolute path to the repository root. */
  path: string;
  /** Display name (folder name). */
  name: string;
  /** Whether this directory is a git repository. */
  isGitRepo: boolean;
  /** Current branch name (if available). */
  currentBranch: string | null;
  /** Primary remote URL (origin, or first remote if no origin). */
  remoteUrl: string | null;
}

/**
 * Represents a single open project tab in the workspace sidebar.
 *
 * @property id - Random UUID generated on creation; stable across persisted sessions.
 * @property projectPath - Absolute filesystem path; used as the dedup key in `openProject`.
 * @property active - Exactly one tab should be active at a time; enforced by store actions.
 * @property sessionIds - PTY session IDs belonging to this project.
 * @property sessionsLaunched - Whether user has launched sessions for this project.
 * @property workspaceType - Whether this is a single repo, multi-repo workspace, or non-git.
 * @property repositories - Detected repositories within this workspace (empty for single-repo).
 * @property selectedRepoPath - Currently selected repository path for git operations.
 * @property worktreeBasePath - Custom worktree base directory for this project (null = use default).
 * @property pinned - Sorts to the front of the tab strip and stays there; persisted.
 */
export type WorkspaceTab = {
  id: string;
  name: string;
  projectPath: string;
  active: boolean;
  sessionIds: number[];
  sessionsLaunched: boolean;
  workspaceType: WorkspaceType;
  repositories: RepositoryInfo[];
  selectedRepoPath: string | null;
  worktreeBasePath: string | null;
  pinned: boolean;
};

/** Read-only slice of the workspace store; persisted to disk via Zustand `persist`. */
type WorkspaceState = {
  tabs: WorkspaceTab[];
  /**
   * Parked items the user pinned to the always-visible rail. Persisted, and
   * keyed by project + name/epic rather than by session id or fire time — see
   * `lib/parkedPins` for why nothing else survives a restart.
   */
  pinnedParked: ParkedPin[];
  /**
   * Zoom tab strip display order per workspace tab id (values are slot ids).
   * Runtime-only: excluded from persistence (`partialize` only persists `tabs`)
   * because slot ids are ephemeral per app run — sessions never survive restart.
   */
  zoomTabOrders: Record<string, string[]>;
};

/**
 * Mutating actions for workspace tab management.
 * All actions are synchronous and trigger a Zustand persist write-through
 * to the Tauri LazyStore (async, fire-and-forget).
 */
type WorkspaceActions = {
  openProject: (path: string) => Promise<void>;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  addSessionToProject: (tabId: string, sessionId: number) => void;
  removeSessionFromProject: (tabId: string, sessionId: number) => void;
  setSessionsLaunched: (tabId: string, launched: boolean) => void;
  getTabByPath: (projectPath: string) => WorkspaceTab | undefined;
  /** Switch selected repository for a tab (multi-repo workspaces). */
  setSelectedRepo: (tabId: string, repoPath: string) => void;
  /** Update repositories list after recursive scan. */
  updateRepositories: (tabId: string, repositories: RepositoryInfo[]) => void;
  /** Set or clear a custom worktree base path for a project tab. */
  setWorktreeBasePath: (tabId: string, path: string | null) => void;
  /** Reorder tabs by moving activeId to overId's position. Used by drag-and-drop. */
  reorderTabs: (activeId: string, overId: string) => void;
  /** Move a tab one position left or right. Used by keyboard shortcut. */
  moveTab: (tabId: string, direction: "left" | "right") => void;
  /** Pin/unpin a project tab; pinned tabs re-sort to the front of the strip. */
  toggleTabPin: (tabId: string) => void;
  /** Pin/unpin a parked terminal or Samurai run in the always-visible rail. */
  togglePinnedParked: (pin: ParkedPin) => void;
  /** Set the zoom tab strip display order (slot ids) for a workspace tab. */
  setZoomTabOrder: (tabId: string, order: string[]) => void;
  /** Re-scan repositories for all multi-repo tabs after rehydration. */
  rehydrateRepositories: () => Promise<void>;
};

// --- Tauri LazyStore-backed StateStorage adapter ---

/**
 * Singleton LazyStore instance pointing to `store.json` in the Tauri app-data dir.
 * LazyStore lazily initialises the underlying file on first read/write.
 */
const lazyStore = new LazyStore("store.json");

/**
 * Zustand-compatible {@link StateStorage} adapter backed by the Tauri plugin-store.
 *
 * Each `setItem`/`removeItem` call issues an explicit `save()` to flush to disk,
 * because LazyStore only writes on shutdown by default and data would be lost
 * if the app is force-quit.
 */
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
      throw err; // Let Zustand persist middleware handle it
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await lazyStore.delete(name);
      await lazyStore.save();
    } catch (err) {
      console.error(`tauriStorage.removeItem("${name}") failed:`, err);
      throw err; // Re-throw for consistency with setItem
    }
  },
};

// --- Helpers ---

/** Extracts the last path segment to use as a human-readable tab label. */
function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** Strips trailing path separators so equal paths compare equal. */
function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/**
 * Ensures the workspace root itself appears as a selectable entry in a
 * multi-repo repositories list.
 *
 * `detect_repositories` only includes the scanned root when the root is a git
 * repo, so a plain parent folder that merely *contains* repos would otherwise
 * be impossible to select as the working directory — the UI would force one
 * of the nested repos. The root is prepended (first entry) so it is also the
 * default selection when the project is first opened.
 */
export function withWorkspaceRoot(
  projectPath: string,
  repositories: RepositoryInfo[],
): RepositoryInfo[] {
  if (repositories.length === 0) return repositories;
  const root = normalizePath(projectPath);
  if (repositories.some((r) => normalizePath(r.path) === root)) return repositories;
  return [
    {
      path: projectPath,
      name: basename(projectPath),
      isGitRepo: false,
      currentBranch: null,
      remoteUrl: null,
    },
    ...repositories,
  ];
}

/**
 * Pinned tabs first, each group keeping its manual order.
 *
 * The invariant is maintained on the stored array rather than at render time,
 * so every existing consumer — the tab strip, Ctrl+Tab cycling, the eagle
 * project dropdown — sees one agreed order without knowing pins exist.
 * `filter` twice is a stable partition, so a drag inside either group survives
 * the re-sort untouched.
 */
export function sortPinnedFirst(tabs: WorkspaceTab[]): WorkspaceTab[] {
  const pinned = tabs.filter((t) => t.pinned);
  if (pinned.length === 0 || pinned.length === tabs.length) return tabs;
  return [...pinned, ...tabs.filter((t) => !t.pinned)];
}

// --- Store ---

/**
 * Global workspace store managing open project tabs.
 *
 * Uses Zustand `persist` middleware with a custom Tauri LazyStore-backed storage
 * adapter so tabs survive app restarts. Only the `tabs` array is persisted
 * (via `partialize`); actions are excluded.
 *
 * Key behaviors:
 * - `openProject` deduplicates by `projectPath` -- opening the same path twice
 *   simply activates the existing tab.
 * - `closeTab` auto-activates the first remaining tab when the closed tab was active.
 */
export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>()(
  persist(
    (set, get) => ({
      tabs: [],
      pinnedParked: [],
      zoomTabOrders: {},

      openProject: async (path: string) => {
        // Deduplicate: if path already open, just activate that tab
        const existing = get().tabs.find((t) => t.projectPath === path);
        if (existing) {
          set((state) => ({
            tabs: state.tabs.map((t) => ({ ...t, active: t.id === existing.id })),
          }));
          return;
        }

        const id = crypto.randomUUID();
        const name = basename(path);

        // Detect workspace type
        let workspaceType: WorkspaceType;
        let repositories: RepositoryInfo[] = [];
        let selectedRepoPath: string | null = null;

        try {
          const isRepo = await invoke<boolean>("is_git_repository", { path });

          if (isRepo) {
            // Single repository - existing behavior
            workspaceType = "single-repo";
            selectedRepoPath = path;
          } else {
            // Check for nested repositories; include the parent folder itself
            // as a selectable root so the user isn't forced into a subfolder.
            const detected = await invoke<RepositoryInfo[]>("detect_repositories", { path });
            repositories = withWorkspaceRoot(path, detected);
            workspaceType = repositories.length > 0 ? "multi-repo" : "non-git";
            selectedRepoPath = repositories[0]?.path ?? null;
          }
        } catch (err) {
          console.error("Failed to detect workspace type:", err);
          // Fall back to single-repo for backward compatibility
          workspaceType = "single-repo";
          selectedRepoPath = path;
        }

        // Functional update: the awaits above can take seconds (repo scan),
        // and a snapshot captured before them would clobber any tab change
        // that landed meanwhile (concurrent CLI opens, session assignment).
        // Re-check the dedup against current state for the same reason.
        set((state) => {
          const opened = state.tabs.find((t) => t.projectPath === path);
          if (opened) {
            return {
              tabs: state.tabs.map((t) => ({ ...t, active: t.id === opened.id })),
            };
          }
          return {
            tabs: [
              ...state.tabs.map((t) => ({ ...t, active: false })),
              {
                id,
                name,
                projectPath: path,
                active: true,
                sessionIds: [],
                sessionsLaunched: false,
                workspaceType,
                repositories,
                selectedRepoPath,
                worktreeBasePath: null,
                // Appending an unpinned tab keeps the pinned-first invariant.
                pinned: false,
              },
            ],
          };
        });
      },

      selectTab: (id: string) => {
        const { tabs } = get();
        if (!tabs.some((t) => t.id === id)) return;
        set({
          tabs: tabs.map((t) => ({ ...t, active: t.id === id })),
        });
      },

      closeTab: (id: string) => {
        const tabToClose = get().tabs.find((t) => t.id === id);

        // Kill all sessions belonging to this project and remove from backend
        if (tabToClose && tabToClose.sessionIds.length > 0) {
          // Kill PTY processes
          Promise.allSettled(tabToClose.sessionIds.map((sessionId) => killSession(sessionId))).then(
            (results) => {
              for (const result of results) {
                if (result.status === "rejected") {
                  console.error("Failed to kill session on tab close:", result.reason);
                }
              }
            },
          );
          // Remove sessions from backend SessionManager AND prune the frontend
          // session store (sessions/parkedSessionIds/flaggedSessionIds) —
          // a raw invoke here left ghost rows behind: stale parked chips in the
          // eagle shelf and dead sessions the agent store never pruned.
          void useSessionStore.getState().removeSessionsForProject(tabToClose.projectPath);
        }

        const remaining = get().tabs.filter((t) => t.id !== id);

        if (remaining.length === 0) {
          set({ tabs: [] });
          return;
        }

        // If the closed tab was active, activate the first remaining tab
        const needsActivation = !remaining.some((t) => t.active);
        set({
          tabs: needsActivation
            ? remaining.map((t, i) => (i === 0 ? { ...t, active: true } : t))
            : remaining,
        });
      },

      addSessionToProject: (tabId: string, sessionId: number) => {
        set({
          tabs: get().tabs.map((t) =>
            t.id === tabId && !t.sessionIds.includes(sessionId)
              ? { ...t, sessionIds: [...t.sessionIds, sessionId] }
              : t,
          ),
        });
      },

      removeSessionFromProject: (tabId: string, sessionId: number) => {
        set({
          tabs: get().tabs.map((t) =>
            t.id === tabId
              ? { ...t, sessionIds: t.sessionIds.filter((id) => id !== sessionId) }
              : t,
          ),
        });
      },

      setSessionsLaunched: (tabId: string, launched: boolean) => {
        set({
          tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, sessionsLaunched: launched } : t)),
        });
      },

      getTabByPath: (projectPath: string) => {
        return get().tabs.find((t) => t.projectPath === projectPath);
      },

      setSelectedRepo: (tabId: string, repoPath: string) => {
        set({
          tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, selectedRepoPath: repoPath } : t)),
        });
      },

      updateRepositories: (tabId: string, repositories: RepositoryInfo[]) => {
        set({
          tabs: get().tabs.map((t) => {
            if (t.id !== tabId) return t;
            // Re-add the workspace root so a rescan doesn't drop it.
            const withRoot = withWorkspaceRoot(t.projectPath, repositories);
            return {
              ...t,
              repositories: withRoot,
              workspaceType: withRoot.length > 0 ? "multi-repo" : "non-git",
              // Auto-select first repo if current selection is no longer valid
              selectedRepoPath:
                withRoot.find((r) => r.path === t.selectedRepoPath)?.path ??
                withRoot[0]?.path ??
                null,
            };
          }),
        });
      },

      setWorktreeBasePath: (tabId: string, path: string | null) => {
        set({
          tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, worktreeBasePath: path } : t)),
        });
      },

      // A reorder across the pinned boundary is refused rather than silently
      // re-sorted: dragging a tab past the last pinned one must never read as
      // "you just pinned it", and snapping it back is the honest answer.
      reorderTabs: (activeId: string, overId: string) => {
        if (activeId === overId) return;
        const { tabs } = get();
        const oldIndex = tabs.findIndex((t) => t.id === activeId);
        const newIndex = tabs.findIndex((t) => t.id === overId);
        if (oldIndex === -1 || newIndex === -1) return;
        if (tabs[oldIndex].pinned !== tabs[newIndex].pinned) return;
        set({ tabs: arrayMove(tabs, oldIndex, newIndex) });
      },

      moveTab: (tabId: string, direction: "left" | "right") => {
        const { tabs } = get();
        const index = tabs.findIndex((t) => t.id === tabId);
        if (index === -1) return;
        const newIndex = direction === "left" ? index - 1 : index + 1;
        if (newIndex < 0 || newIndex >= tabs.length) return;
        // Same boundary rule as the drag path (see reorderTabs).
        if (tabs[index].pinned !== tabs[newIndex].pinned) return;
        set({ tabs: arrayMove(tabs, index, newIndex) });
      },

      toggleTabPin: (tabId: string) => {
        const { tabs } = get();
        if (!tabs.some((t) => t.id === tabId)) return;
        set({
          tabs: sortPinnedFirst(
            tabs.map((t) => (t.id === tabId ? { ...t, pinned: !t.pinned } : t)),
          ),
        });
      },

      togglePinnedParked: (pin: ParkedPin) => {
        const { pinnedParked } = get();
        const key = parkedPinKey(pin);
        set({
          pinnedParked: isParkedPinned(pinnedParked, pin)
            ? pinnedParked.filter((p) => parkedPinKey(p) !== key)
            : [...pinnedParked, pin],
        });
      },

      setZoomTabOrder: (tabId: string, order: string[]) => {
        set({ zoomTabOrders: { ...get().zoomTabOrders, [tabId]: order } });
      },

      rehydrateRepositories: async () => {
        // Runs on every launch: each tab's scan walks a directory tree, so
        // they go out together rather than queueing behind one another. Each
        // still handles its own failure, so one bad path can't sink the rest.
        const multiRepoTabs = get().tabs.filter((t) => t.workspaceType === "multi-repo");
        await Promise.all(
          multiRepoTabs.map(async (tab) => {
            try {
              const repos = await invoke<RepositoryInfo[]>("detect_repositories", {
                path: tab.projectPath,
              });
              get().updateRepositories(tab.id, repos);
            } catch (err) {
              console.error(`Failed to rehydrate repos for ${tab.projectPath}:`, err);
            }
          }),
        );
      },
    }),
    {
      name: "maestro-workspace",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({ tabs: state.tabs, pinnedParked: state.pinnedParked }),
      version: 5,
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            // Clear stale sessionIds - sessions don't survive app restarts
            // This prevents session ID collision between persisted tabs and new sessions
            state.tabs = sortPinnedFirst(
              state.tabs.map((t) => ({
                ...t,
                sessionIds: [],
                sessionsLaunched: false,
              })),
            );
            // Persisted before pinnedParked existed, or written by a build
            // that stored nothing: the rail must still have an array to read.
            state.pinnedParked = state.pinnedParked ?? [];
          }
        };
      },
      migrate: (persistedState, version) => {
        const state = persistedState as WorkspaceState;
        // biome-ignore lint/suspicious/noExplicitAny: migrates persisted state of unknown historical shape across schema versions; fields are read defensively with `??` fallbacks below.
        let tabs = state.tabs as any[];

        // v1 -> v2: Add sessionIds and sessionsLaunched
        if (version < 2) {
          tabs = tabs.map((t) => ({
            ...t,
            sessionIds: t.sessionIds ?? [],
            sessionsLaunched: t.sessionsLaunched ?? false,
          }));
        }

        // v2 -> v3: Add multi-repo fields
        if (version < 3) {
          tabs = tabs.map((t) => ({
            ...t,
            workspaceType: (t.workspaceType as WorkspaceType) ?? "single-repo",
            repositories: t.repositories ?? [],
            selectedRepoPath: t.selectedRepoPath ?? t.projectPath,
          }));
        }

        // v3 -> v4: Add worktreeBasePath
        if (version < 4) {
          tabs = tabs.map((t) => ({
            ...t,
            worktreeBasePath: t.worktreeBasePath ?? null,
          }));
        }

        // v4 -> v5: Add tab pinning and the pinned-parked rail list
        if (version < 5) {
          tabs = tabs.map((t) => ({ ...t, pinned: t.pinned ?? false }));
        }

        return {
          ...state,
          tabs: sortPinnedFirst(tabs as WorkspaceTab[]),
          pinnedParked: state.pinnedParked ?? [],
        };
      },
    },
  ),
);
