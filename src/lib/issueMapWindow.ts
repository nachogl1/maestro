import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

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

export interface IssueMapTarget {
  repoPath: string;
  search: string;
}

export interface IssueMapSelection {
  repoPath: string;
  number: number;
}

/** The repo/search the map window was opened with, read from its URL. */
export function readIssueMapTarget(query: string): IssueMapTarget | null {
  const params = new URLSearchParams(query);
  if (params.get("view") !== ISSUE_MAP_VIEW) return null;
  return { repoPath: params.get("repo") ?? "", search: params.get("search") ?? "" };
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
  const created = new WebviewWindow(ISSUE_MAP_WINDOW_LABEL, {
    url: `index.html?${params.toString()}`,
    title: "Maestro: Issue map",
    width: 1400,
    height: 900,
    minWidth: 640,
    minHeight: 400,
  });
  created.once("tauri://error", (event) => {
    console.error("Failed to open the issue map window:", event.payload);
  });
}
