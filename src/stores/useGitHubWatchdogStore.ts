import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { normalizePath } from "@/lib/path";
import type { IssueInfo, PullRequestInfo } from "@/stores/useGitHubStore";

// --- Types (mirror src-tauri/src/github/watchdog.rs) ---

/** Global `gh` health reported with every watchdog snapshot. */
export type GhWatchdogStatus = "ok" | "gh-missing" | "not-authenticated";

/**
 * Poll results for one watched project.
 *
 * The `*Errored` flags carry two closely-related meanings:
 * - on the wire (from Rust): this cycle's fetch for the list failed, its
 *   contents are meaningless (empty is NOT "zero items");
 * - in the store (after {@link carryForwardErroredLists}): no trustworthy
 *   baseline exists yet for the list — its first successful data must not
 *   be treated as "new" transitions.
 */
export interface WatchdogProjectResult {
  name: string;
  repoPath: string;
  /** Open PRs where the user's review is requested. */
  reviewRequests: PullRequestInfo[];
  /** Open issues assigned to the user. */
  assignedIssues: IssueInfo[];
  reviewRequestsErrored: boolean;
  assignedIssuesErrored: boolean;
}

/** Payload of the `github-watchdog-update` Tauri event (one poll cycle). */
export interface WatchdogSnapshot {
  status: GhWatchdogStatus;
  projects: WatchdogProjectResult[];
  polledAt: number;
}

/** A queued toast for a newly-appeared review request / assigned issue. */
export interface WatchdogToast {
  id: string;
  projectName: string;
  repoPath: string;
  kind: "pr" | "issue";
  number: number;
  title: string;
  url: string;
}

/** Search filters the watchdog polls with; the badge navigation applies the
 *  same filters to the git panel so both show the same items. */
export const WATCHDOG_PR_SEARCH = "review-requested:@me";
export const WATCHDOG_ISSUE_SEARCH = "assignee:@me";

/** Keep at most this many queued toasts; oldest are dropped first. */
const MAX_TOASTS = 6;

// --- Transition helpers (pure; exported for tests) ---

/**
 * Replaces errored lists in `next` with the last-known-good data from
 * `prev`, so a transient `gh` failure (laptop sleep/resume, network blip)
 * neither zeroes the badge nor makes every still-open item look "new" on
 * the next successful poll.
 *
 * A carried-forward list gets its errored flag CLEARED — the data is a real
 * baseline. A list that errored with no baseline (first poll failed, or the
 * previous entry was itself baseline-less) stays flagged so its first
 * successful data is treated like a first poll (no toasts).
 */
export function carryForwardErroredLists(
  prev: WatchdogProjectResult | undefined,
  next: WatchdogProjectResult,
): WatchdogProjectResult {
  if (!next.reviewRequestsErrored && !next.assignedIssuesErrored) return next;
  const merged = { ...next };
  if (next.reviewRequestsErrored && prev && !prev.reviewRequestsErrored) {
    merged.reviewRequests = prev.reviewRequests;
    merged.reviewRequestsErrored = false;
  }
  if (next.assignedIssuesErrored && prev && !prev.assignedIssuesErrored) {
    merged.assignedIssues = prev.assignedIssues;
    merged.assignedIssuesErrored = false;
  }
  return merged;
}

/**
 * Items in `next` that were absent from `prev`, keyed by number.
 *
 * `prev === undefined` means this is the first poll result ever seen for the
 * project (app start, or a newly-opened project tab): everything would be
 * "new", so nothing is reported. A prev list still flagged as errored has no
 * trustworthy baseline and is treated the same way. Disappearing items never
 * toast.
 */
export function diffNewItems(
  prev: WatchdogProjectResult | undefined,
  next: WatchdogProjectResult,
): { newPrs: PullRequestInfo[]; newIssues: IssueInfo[] } {
  if (!prev) return { newPrs: [], newIssues: [] };
  const prevPrs = new Set(prev.reviewRequests.map((pr) => pr.number));
  const prevIssues = new Set(prev.assignedIssues.map((issue) => issue.number));
  return {
    newPrs: prev.reviewRequestsErrored
      ? []
      : next.reviewRequests.filter((pr) => !prevPrs.has(pr.number)),
    newIssues: prev.assignedIssuesErrored
      ? []
      : next.assignedIssues.filter((issue) => !prevIssues.has(issue.number)),
  };
}

/**
 * Maps open workspace tabs to the watchdog's project set, deduplicating by
 * repo path (first tab wins): several tabs can point at the same repo (e.g.
 * a multi-repo workspace root also opened directly), and polling it twice
 * would double the badge counts and duplicate toasts.
 */
export function watchedProjectsFromTabs(
  tabs: ReadonlyArray<{ name: string; projectPath: string; selectedRepoPath: string | null }>,
): Array<{ name: string; repoPath: string }> {
  const seen = new Set<string>();
  const projects: Array<{ name: string; repoPath: string }> = [];
  for (const tab of tabs) {
    const repoPath = tab.selectedRepoPath ?? tab.projectPath;
    // Normalized key: the same repo can be open under two spellings
    // (e.g. a CLI-opened \\?\ path), and must still be polled once.
    const key = normalizePath(repoPath);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push({ name: tab.name, repoPath });
  }
  return projects;
}

// --- Tauri LazyStore-backed StateStorage adapter ---

const lazyStore = new LazyStore("github-watchdog-settings.json");

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

// --- Store ---

/** Persisted settings. */
type WatchdogSettings = {
  /** OFF mutes toasts only; polling and the top-bar badge keep working. */
  notificationsEnabled: boolean;
};

type WatchdogState = WatchdogSettings & {
  status: GhWatchdogStatus;
  projects: WatchdogProjectResult[];
  lastPolledAt: number | null;
  toasts: WatchdogToast[];
};

type WatchdogActions = {
  /** Reducer for one poll snapshot: stores it and queues transition toasts. */
  applySnapshot: (snapshot: WatchdogSnapshot) => void;
  dismissToast: (id: string) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  /** Pushes the watched project set to the Rust poller. */
  syncProjects: (projects: Array<{ name: string; repoPath: string }>) => Promise<void>;
  initListeners: () => Promise<UnlistenFn>;
};

let toastSeq = 0;

export const useGitHubWatchdogStore = create<WatchdogState & WatchdogActions>()(
  persist(
    (set, get) => ({
      // Persisted settings
      notificationsEnabled: true,

      // Transient state
      status: "ok",
      projects: [],
      lastPolledAt: null,
      toasts: [],

      applySnapshot: (snapshot: WatchdogSnapshot) => {
        const { projects: prevProjects, notificationsEnabled, toasts } = get();
        const prevByPath = new Map(prevProjects.map((p) => [p.repoPath, p]));

        // Errored lists keep the last-known-good data (see the helper docs);
        // the merged results are what gets diffed AND stored.
        const mergedProjects = snapshot.projects.map((project) =>
          carryForwardErroredLists(prevByPath.get(project.repoPath), project),
        );

        const newToasts: WatchdogToast[] = [];
        if (notificationsEnabled) {
          for (const project of mergedProjects) {
            const { newPrs, newIssues } = diffNewItems(prevByPath.get(project.repoPath), project);
            for (const pr of newPrs) {
              newToasts.push({
                id: `watchdog-${++toastSeq}`,
                projectName: project.name,
                repoPath: project.repoPath,
                kind: "pr",
                number: pr.number,
                title: pr.title,
                url: pr.url,
              });
            }
            for (const issue of newIssues) {
              newToasts.push({
                id: `watchdog-${++toastSeq}`,
                projectName: project.name,
                repoPath: project.repoPath,
                kind: "issue",
                number: issue.number,
                title: issue.title,
                url: issue.url,
              });
            }
          }
        }

        set({
          status: snapshot.status,
          projects: mergedProjects,
          lastPolledAt: snapshot.polledAt,
          toasts: [...toasts, ...newToasts].slice(-MAX_TOASTS),
        });
      },

      dismissToast: (id: string) => {
        set({ toasts: get().toasts.filter((t) => t.id !== id) });
      },

      setNotificationsEnabled: (enabled: boolean) => {
        // Muting also clears anything currently on screen.
        set(enabled ? { notificationsEnabled: true } : { notificationsEnabled: false, toasts: [] });
      },

      syncProjects: async (projects) => {
        try {
          await invoke("github_watchdog_set_projects", { projects });
        } catch (err) {
          console.error("Failed to sync watchdog projects:", err);
        }
      },

      initListeners: async () => {
        return listen<WatchdogSnapshot>("github-watchdog-update", (event) => {
          get().applySnapshot(event.payload);
        });
      },
    }),
    {
      name: "maestro-github-watchdog-settings",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        notificationsEnabled: state.notificationsEnabled,
      }),
      version: 1,
    },
  ),
);
