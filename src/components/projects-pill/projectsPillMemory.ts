/**
 * The PROJECTS pill's memory of each project tab's last finished load, so a
 * later open shows it at once while it refreshes. Memory only: it is gone when
 * Maestro closes, and a newly opened tab starts with nothing.
 */

import type { PillProjectData } from "./projectsPillData";

/** What a project's last finished load found. A failed load is never remembered. */
export type RememberedProject = { kind: "no-repo" } | { kind: "ready"; data: PillProjectData };

interface MemoryEntry {
  /** The folder the load asked GitHub about; a tab can switch repositories. */
  repoPath: string;
  last: RememberedProject;
}

const memory = new Map<string, MemoryEntry>();

/** The tab's last finished load, or null when there is none for this folder. */
export function recallProject(tabId: string, repoPath: string): RememberedProject | null {
  const entry = memory.get(tabId);
  return entry && entry.repoPath === repoPath ? entry.last : null;
}

export function rememberProject(tabId: string, repoPath: string, last: RememberedProject): void {
  memory.set(tabId, { repoPath, last });
}

/** Forget every project, as a fresh start of Maestro does. */
export function forgetRememberedProjects(): void {
  memory.clear();
}
