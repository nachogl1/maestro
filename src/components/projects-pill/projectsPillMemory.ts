/**
 * The PROJECTS pill's memory of each project tab's last finished load, so a
 * later open shows it at once while it refreshes. Filled by the background fetch
 * too. Memory only: it is gone when Maestro closes.
 */

import type { PillProjectData } from "./projectsPillData";

/** A load that found something to show. */
export type LoadedProject = { kind: "no-repo" } | { kind: "ready"; data: PillProjectData };

/**
 * What a project's last finished load found. A failure is kept only while
 * nothing has loaded, so a project that keeps failing is known as tried.
 */
export type RememberedProject = LoadedProject | { kind: "failed"; message: string };

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

/** Remember a finished load; a failure never replaces something that loaded. */
export function rememberProject(tabId: string, repoPath: string, last: RememberedProject): void {
  const kept = recallProject(tabId, repoPath);
  if (last.kind === "failed" && kept && kept.kind !== "failed") return;
  memory.set(tabId, { repoPath, last });
}

/** Forget every project, as a fresh start of Maestro does. */
export function forgetRememberedProjects(): void {
  memory.clear();
}
