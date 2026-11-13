import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { samePath } from "@/lib/path";
import { WEBVIEW_WINDOW_OPTIONS } from "@/lib/touchTextMenu";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

/**
 * The issue map lives in its own OS window (not a modal inside Maestro), so
 * it can be moved to a second screen and is never hidden behind other views.
 */
export const ISSUE_MAP_WINDOW_LABEL = "issue-map";

/** Query value of `?view=` that makes `main.tsx` render the map window. */
export const ISSUE_MAP_VIEW = "issue-map";

/** Main → map window: show this repo/search (the window was already open). */
export const ISSUE_MAP_OPEN_EVENT = "issue-map:open";
/** Map window → main window: "Show in sidebar" was clicked. */
export const ISSUE_MAP_SELECT_EVENT = "issue-map:select";
/** Map window → main window: the map closed, so refresh the issue list. */
export const ISSUE_MAP_CLOSED_EVENT = "issue-map:closed";
/** Main → map window: the open projects changed, so refresh the picker. */
export const ISSUE_MAP_PROJECTS_EVENT = "issue-map:projects";

/** An open Maestro project the map can switch to. */
export interface IssueMapProject {
  name: string;
  repoPath: string;
}

export interface IssueMapTarget {
  repoPath: string;
  search: string;
  /** The open projects, for the map's project picker. */
  projects?: IssueMapProject[];
}

export interface IssueMapSelection {
  repoPath: string;
  number: number;
}

type IssueMapTab = Pick<WorkspaceTab, "name" | "projectPath" | "workspaceType" | "repositories">;

/**
 * Every open project the map can show, in tab order: each git repository of a
 * multi-repository tab, and the folder of every other tab. A tab marked
 * "not git" is kept, since a failed detection can mark a real repository so.
 */
export function issueMapProjects(tabs: IssueMapTab[]): IssueMapProject[] {
  return tabs.flatMap((tab) => {
    const repos =
      tab.workspaceType === "multi-repo" ? tab.repositories.filter((r) => r.isGitRepo) : [];
    if (repos.length === 0) return [{ name: tab.name, repoPath: tab.projectPath }];
    return repos.map((repo) => ({
      name: samePath(repo.path, tab.projectPath) ? tab.name : `${tab.name} / ${repo.name}`,
      repoPath: repo.path,
    }));
  });
}

/** Open the map on this repo, with every open project in its picker. */
export function openIssueMapFor(repoPath: string, search: string): void {
  const projects = issueMapProjects(useWorkspaceStore.getState().tabs);
  openIssueMapWindow({ repoPath, search, projects }).catch((err) =>
    console.error("Failed to open the issue map window:", err),
  );
}

/**
 * Keep an open map window's picker in step with the open tabs: each time the
 * project list changes, send it to the window. Returns the unsubscribe.
 */
export function syncIssueMapProjects(): () => void {
  let sent = JSON.stringify(issueMapProjects(useWorkspaceStore.getState().tabs));
  return useWorkspaceStore.subscribe((state) => {
    const projects = issueMapProjects(state.tabs);
    const key = JSON.stringify(projects);
    if (key === sent) return;
    sent = key;
    emitTo(ISSUE_MAP_WINDOW_LABEL, ISSUE_MAP_PROJECTS_EVENT, projects).catch((err) =>
      console.error("Failed to send the open projects to the issue map:", err),
    );
  });
}

/** The repo/search the map window was opened with, read from its URL. */
export function readIssueMapTarget(query: string): IssueMapTarget | null {
  const params = new URLSearchParams(query);
  if (params.get("view") !== ISSUE_MAP_VIEW) return null;
  const target: IssueMapTarget = {
    repoPath: params.get("repo") ?? "",
    search: params.get("search") ?? "",
  };
  const projects = parseProjects(params.get("projects"));
  if (projects) target.projects = projects;
  return target;
}

/** The project list from the URL; null when missing or malformed. */
function parseProjects(raw: string | null): IssueMapProject[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (p): p is IssueMapProject => typeof p?.name === "string" && typeof p?.repoPath === "string",
    );
  } catch {
    return null;
  }
}

/** Window title naming the project whose issues the map shows. */
export function issueMapWindowTitle(repoPath: string): string {
  const name = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return name ? `Maestro: Issue map - ${name}` : "Maestro: Issue map";
}

/** Open the map window, or point the open one at this repo and bring it forward. */
export async function openIssueMapWindow(target: IssueMapTarget): Promise<void> {
  const existing = await WebviewWindow.getByLabel(ISSUE_MAP_WINDOW_LABEL);
  if (existing) {
    await emitTo(ISSUE_MAP_WINDOW_LABEL, ISSUE_MAP_OPEN_EVENT, target);
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const params = new URLSearchParams({
    view: ISSUE_MAP_VIEW,
    repo: target.repoPath,
    search: target.search,
  });
  if (target.projects) params.set("projects", JSON.stringify(target.projects));
  const created = new WebviewWindow(ISSUE_MAP_WINDOW_LABEL, {
    ...WEBVIEW_WINDOW_OPTIONS,
    url: `index.html?${params.toString()}`,
    title: issueMapWindowTitle(target.repoPath),
    width: 1400,
    height: 900,
    minWidth: 640,
    minHeight: 400,
  });
  created.once("tauri://error", (event) => {
    console.error("Failed to open the issue map window:", event.payload);
  });
}
