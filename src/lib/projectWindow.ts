/**
 * Project pop-out windows: a project tab moved out of the main window into
 * its own OS window (e.g. to put it on another monitor).
 *
 * The main window stays the single owner of workspace state. A pop-out loads
 * the same frontend with `?projectWindow=<tabId>`, asks the main window for
 * the project (tab + terminal layout), and streams every change back so the
 * main window can dock the tab again — with its running terminals — when the
 * pop-out closes. PTY sessions are never respawned, only re-attached with
 * scrollback replay (`attachPtyOutput`).
 *
 * Handshake:
 *   pop-out → main  `ready`    { tabId }
 *   main → pop-out  `handoff`  ProjectHandoff
 *   pop-out → main  `update`   ProjectWindowUpdate   (on every change)
 *   backend → main  `closed`   tabId                 (pop-out destroyed)
 */

import { invoke } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";
import type { SessionSlot } from "@/components/terminal/PreLaunchCard";
import type { TreeNode } from "@/components/terminal/splitTree";
import type { WorkspaceTab } from "@/stores/useWorkspaceStore";

/** Label of the window that owns workspace state (matches the Rust side). */
export const MAIN_WINDOW_LABEL = "main";

/** Event names for the main ↔ pop-out handshake. */
export const PROJECT_WINDOW_EVENTS = {
  ready: "project-window-ready",
  handoff: "project-window-handoff",
  update: "project-window-update",
  closed: "project-window-closed",
  /** pop-out → main: the user closed the project itself (its terminals are already stopped). */
  closeTab: "project-window-close-tab",
} as const;

/** What a pop-out window's host gives `<App />` so it runs as a secondary window. */
export interface ProjectWindowHost {
  /** The project this window shows. */
  tabId: string;
  /** Report the project's grid after any pane or layout change. */
  onGridStateChange: (tabId: string, snapshot: GridSnapshot) => void;
  /** The user closed the project here: tell the main window, then close this window. */
  onProjectClosed: (tabId: string) => void;
  /**
   * The project's tab was dragged out of this window and dropped at `point`:
   * over the main window it docks back there; anywhere else nothing happens.
   */
  onTabDroppedOutside: (tabId: string, point: ScreenPoint) => Promise<void>;
}

/** A TerminalGrid's panes and split layout — enough to rebuild it elsewhere. */
export interface GridSnapshot {
  slots: SessionSlot[];
  layoutTree: TreeNode;
}

/** Tab fields a pop-out may change and reports back to the main window. */
export type ProjectWindowTabFields = Pick<
  WorkspaceTab,
  | "sessionIds"
  | "sessionsLaunched"
  | "selectedRepoPath"
  | "repositories"
  | "workspaceType"
  | "worktreeBasePath"
>;

/** Everything a pop-out needs to show a project. */
export interface ProjectHandoff {
  tab: WorkspaceTab;
  /** The project's grid at the moment it left the main window (null: not launched). */
  grid: GridSnapshot | null;
  /** Parked sessions among this project's sessions, so they stay parked. */
  parkedSessionIds: number[];
}

/** Pop-out → main: the project's latest state. */
export interface ProjectWindowUpdate {
  tabId: string;
  tab: ProjectWindowTabFields;
  grid: GridSnapshot | null;
  /** Parked sessions among this project's sessions. */
  parkedSessionIds: number[];
}

/** Tab id this window was opened for, or null in the main window. */
export function getProjectWindowTabId(search: string = window.location.search): string | null {
  const tabId = new URLSearchParams(search).get("projectWindow");
  return tabId ? tabId : null;
}

/** Whether this webview is a project pop-out (not the main window). */
export function isProjectWindow(): boolean {
  return getProjectWindowTabId() !== null;
}

/** Window label of a tab's pop-out (mirrors `project_window_label` in Rust). */
export function projectWindowLabel(tabId: string): string {
  return `project-${tabId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** A point in logical screen coordinates (spans every monitor). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Opens (or focuses) the pop-out window for a tab. Resolves to its label.
 * `position` places a new window's top-left corner on screen.
 */
export function openProjectWindow(
  tabId: string,
  title: string,
  position?: ScreenPoint,
): Promise<string> {
  return invoke<string>("open_project_window", {
    tabId,
    title,
    x: position?.x ?? null,
    y: position?.y ?? null,
  });
}

/** Picks the tab fields a pop-out reports back. */
export function projectWindowTabFields(tab: WorkspaceTab): ProjectWindowTabFields {
  return {
    sessionIds: tab.sessionIds,
    sessionsLaunched: tab.sessionsLaunched,
    selectedRepoPath: tab.selectedRepoPath,
    repositories: tab.repositories,
    workspaceType: tab.workspaceType,
    worktreeBasePath: tab.worktreeBasePath,
  };
}

/** Whether a screen point lies on the main window (title bar included). */
export async function isOverMainWindow(point: ScreenPoint): Promise<boolean> {
  const main = await Window.getByLabel(MAIN_WINDOW_LABEL);
  if (!main) return false;
  const [position, size, scale] = await Promise.all([
    main.outerPosition(),
    main.outerSize(),
    main.scaleFactor(),
  ]);
  // Window geometry comes in physical pixels; drop points are logical.
  const left = position.x / scale;
  const top = position.y / scale;
  return (
    point.x >= left &&
    point.y >= top &&
    point.x <= left + size.width / scale &&
    point.y <= top + size.height / scale
  );
}
