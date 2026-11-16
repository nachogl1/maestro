/**
 * One project tab's load for the PROJECTS pill, shared by the background fetch
 * and the refresh an open starts: a load already running for the tab's folder
 * is reused instead of asking GitHub twice, and every load that finishes is
 * remembered (`projectsPillMemory.ts`).
 */

import type { WorkspaceTab } from "@/stores/useWorkspaceStore";
import { isNoRepositoryError, loadPillProject } from "./projectsPillData";
import { type RememberedProject, rememberProject } from "./projectsPillMemory";

/** One open project tab, as the pill loads and lists it. */
export interface PillProject {
  id: string;
  name: string;
  repoPath: string;
  /** The tab's folder is not a git repository, so there is nothing to ask GitHub. */
  nonGit: boolean;
}

export function toPillProject(tab: WorkspaceTab): PillProject {
  return {
    id: tab.id,
    name: tab.name,
    repoPath: tab.selectedRepoPath ?? tab.projectPath,
    nonGit: tab.workspaceType === "non-git",
  };
}

interface RunningLoad {
  repoPath: string;
  result: Promise<RememberedProject>;
}

/** The load running for each tab id; a load for the tab's newer folder replaces it. */
const running = new Map<string, RunningLoad>();

async function fetchProject(project: PillProject): Promise<RememberedProject> {
  if (project.nonGit) return { kind: "no-repo" };
  try {
    return { kind: "ready", data: await loadPillProject(project.repoPath) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isNoRepositoryError(message)) return { kind: "no-repo" };
    console.error(`Failed to load the PROJECTS list for ${project.name}:`, err);
    return { kind: "failed", message };
  }
}

/**
 * Load a project and remember what the load found, or join the load already
 * running for its folder. A load whose tab has since moved to another folder
 * is not remembered.
 */
export function loadAndRemember(project: PillProject): Promise<RememberedProject> {
  const current = running.get(project.id);
  if (current?.repoPath === project.repoPath) return current.result;
  const load: RunningLoad = {
    repoPath: project.repoPath,
    result: fetchProject(project).then((last) => {
      if (running.get(project.id) === load) {
        running.delete(project.id);
        rememberProject(project.id, project.repoPath, last);
      }
      return last;
    }),
  };
  running.set(project.id, load);
  return load.result;
}

/** Drop every running load, as a fresh start of Maestro does. */
export function forgetRunningLoads(): void {
  running.clear();
}
