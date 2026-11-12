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
 * A pop-out can hold several projects: a tab dragged from one pop-out onto
 * another joins it, and a tab dragged onto the main window docks there alone.
 * Each pop-out has its own window id; the main window records which window
 * holds each popped-out tab.
 *
 * Handshake (every pop-out-bound payload names its window, so a window only
 * acts on its own):
 *   pop-out → main  `ready`    { tabId }
 *   main → pop-out  `handoff`  ProjectHandoff        (also: a tab joining it)
 *   pop-out → main  `update`   ProjectWindowUpdate   (on every change)
 *   pop-out → main  `dockTab`  TabInWindow           (tab dropped on the main window)
 *   pop-out → main  `moveTab`  TabMove               (tab dropped on another pop-out)
 *   main → pop-out  `release`  TabInWindow           (the tab left that window)
 *   backend → main  `closed`   windowId              (pop-out destroyed)
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
  dockTab: "project-window-dock-tab",
  moveTab: "project-window-move-tab",
  release: "project-window-release-tab",
} as const;

/** What a pop-out window's host gives `<App />` so it runs as a secondary window. */
export interface ProjectWindowHost {
  /** The project this window was opened for (it may hold more since). */
  tabId: string;
  /** Report the project's grid after any pane or layout change. */
  onGridStateChange: (tabId: string, snapshot: GridSnapshot) => void;
  /** The user closed the project here: tell the main window, then close this window. */
  onProjectClosed: (tabId: string) => void;
  /**
   * A project's tab was dragged out of this window and dropped at `point`:
   * over another pop-out it joins that window, over the main window it docks
   * back there; anywhere else nothing happens.
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
  /** The pop-out this project is for. */
  windowId: string;
  tab: WorkspaceTab;
  /** The project's grid at the moment it left the main window (null: not launched). */
  grid: GridSnapshot | null;
  /** Parked sessions among this project's sessions, so they stay parked. */
  parkedSessionIds: number[];
}

/** Pop-out → main: the project's latest state. */
export interface ProjectWindowUpdate {
  tabId: string;
  /** The pop-out sending it; the main window ignores a window that no longer holds the tab. */
  windowId: string;
  tab: ProjectWindowTabFields;
  grid: GridSnapshot | null;
  /** Parked sessions among this project's sessions. */
  parkedSessionIds: number[];
}

/** A tab and the pop-out window it is in. */
export interface TabInWindow {
  tabId: string;
  windowId: string;
}

/** Pop-out → main: move a tab from one pop-out window into another. */
export interface TabMove {
  tabId: string;
  fromWindowId: string;
  toWindowId: string;
}

/** Main window: which pop-out window holds each popped-out tab. */
export type PoppedOutTabs = Readonly<Record<string, string>>;

/** The tabs pop-out `windowId` holds (all of them dock when it closes). */
export function tabsInWindow(poppedOut: PoppedOutTabs, windowId: string): string[] {
  return Object.keys(poppedOut).filter((tabId) => poppedOut[tabId] === windowId);
}

/** Whether a pop-out still holds a tab, so it may dock it or report on it. */
export function windowHoldsTab(
  poppedOut: PoppedOutTabs,
  { tabId, windowId }: TabInWindow,
): boolean {
  return poppedOut[tabId] === windowId;
}

/** Whether a tab may move: from the window holding it into another open pop-out. */
export function canMoveTab(poppedOut: PoppedOutTabs, move: TabMove): boolean {
  return (
    poppedOut[move.tabId] === move.fromWindowId &&
    move.fromWindowId !== move.toWindowId &&
    Object.values(poppedOut).includes(move.toWindowId)
  );
}

/** Tab id this window was opened for, or null in the main window. */
export function getProjectWindowTabId(search: string = window.location.search): string | null {
  const tabId = new URLSearchParams(search).get("projectWindow");
  return tabId ? tabId : null;
}

/** This pop-out's window id, or null in the main window. */
export function getProjectWindowId(search: string = window.location.search): string | null {
  const windowId = new URLSearchParams(search).get("windowId");
  return windowId ? windowId : null;
}

/** A fresh id for a new pop-out window. */
export function newProjectWindowId(): string {
  return crypto.randomUUID();
}

/** Whether this webview is a project pop-out (not the main window). */
export function isProjectWindow(): boolean {
  return getProjectWindowTabId() !== null;
}

/** Label of pop-out window `windowId` (mirrors `project_window_label` in Rust). */
export function projectWindowLabel(windowId: string): string {
  return `${PROJECT_WINDOW_LABEL_PREFIX}${windowId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Label prefix of every pop-out window (mirrors `PROJECT_WINDOW_PREFIX` in Rust). */
const PROJECT_WINDOW_LABEL_PREFIX = "project-";

/** A point in logical screen coordinates (spans every monitor). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Opens (or focuses) pop-out window `windowId`, showing `tabId` first.
 * Resolves to its label. `position` places a new window's top-left corner on
 * screen.
 */
export function openProjectWindow(
  windowId: string,
  tabId: string,
  title: string,
  position?: ScreenPoint,
): Promise<string> {
  return invoke<string>("open_project_window", {
    windowId,
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

/** Where a dropped tab landed: the main window, another pop-out, or neither. */
export type DropTarget = { kind: "main" } | { kind: "popout"; windowId: string } | null;

/**
 * The Maestro window under a screen point, leaving out pop-out `ownWindowId`
 * (the window the tab was dragged from). A pop-out wins over the main window
 * when both are under the point, since pop-outs usually sit on top of it.
 */
export async function dropTargetAt(point: ScreenPoint, ownWindowId: string): Promise<DropTarget> {
  const ownLabel = projectWindowLabel(ownWindowId);
  const windows = await Window.getAll();
  // Released over its own window (e.g. its title bar, outside the page): no move.
  const own = windows.find((win) => win.label === ownLabel);
  if (own && (await windowContains(own, point))) return null;
  let overMain = false;
  for (const win of windows) {
    const isPopOut = win.label.startsWith(PROJECT_WINDOW_LABEL_PREFIX);
    if (win.label === ownLabel || (!isPopOut && win.label !== MAIN_WINDOW_LABEL)) continue;
    if (!(await windowContains(win, point))) continue;
    if (isPopOut) {
      return { kind: "popout", windowId: win.label.slice(PROJECT_WINDOW_LABEL_PREFIX.length) };
    }
    overMain = true;
  }
  return overMain ? { kind: "main" } : null;
}

/** Whether a screen point lies on a window (title bar included). */
async function windowContains(win: Window, point: ScreenPoint): Promise<boolean> {
  const [position, size, scale] = await Promise.all([
    win.outerPosition(),
    win.outerSize(),
    win.scaleFactor(),
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
