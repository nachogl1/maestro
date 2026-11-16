import { create } from "zustand";
import { isNoRepositoryError, loadProjectPrs, type PillPrsResult } from "./prsPillData";

/** One open project the pill reads, deduplicated by its normalized repo path (`key`). */
export interface PrsPillProject {
  key: string;
  name: string;
  repoPath: string;
}

/** The last settled fetch of one project. */
export type PrsLoad =
  | ({ kind: "ready" } & PillPrsResult)
  | { kind: "error"; message: string }
  | { kind: "no-repo" };

interface PrsPillState {
  /** Last results per project key, kept in memory while Maestro runs (never on disk). */
  loads: Record<string, PrsLoad>;
  /** Project keys with a fetch in flight. */
  refreshing: Record<string, boolean>;
  /** Fetches every given project not already in flight; keeps the last results meanwhile. */
  refresh: (projects: PrsPillProject[]) => Promise<void>;
}

export const usePrsPillStore = create<PrsPillState>((set, get) => {
  const settle = (key: string, load: PrsLoad) =>
    set((s) => ({
      loads: { ...s.loads, [key]: load },
      refreshing: { ...s.refreshing, [key]: false },
    }));

  const fetchOne = async (project: PrsPillProject): Promise<void> => {
    try {
      settle(project.key, { kind: "ready", ...(await loadProjectPrs(project.repoPath)) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isNoRepositoryError(message)) {
        settle(project.key, { kind: "no-repo" });
        return;
      }
      console.error(`Failed to load the open pull requests of ${project.name}:`, err);
      settle(project.key, { kind: "error", message });
    }
  };

  return {
    loads: {},
    refreshing: {},
    refresh: async (projects) => {
      const due = projects.filter((p) => !get().refreshing[p.key]);
      if (due.length === 0) return;
      set((s) => ({
        refreshing: { ...s.refreshing, ...Object.fromEntries(due.map((p) => [p.key, true])) },
      }));
      await Promise.all(due.map(fetchOne));
    },
  };
});
