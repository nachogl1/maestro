import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dropTargetAt,
  type GridSnapshot,
  MAIN_WINDOW_LABEL,
  PROJECT_WINDOW_EVENTS,
  type ProjectHandoff,
  type ProjectWindowHost,
  type ProjectWindowUpdate,
  projectWindowTabFields,
  type TabInWindow,
  type TabMove,
} from "@/lib/projectWindow";
import { useProjectWindowStore } from "@/stores/useProjectWindowStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import App from "./App";

/** How long to wait for the main window's handoff before showing an error. */
const HANDOFF_TIMEOUT_MS = 5000;

const THEME_STORAGE_KEY = "maestro-theme";

interface ProjectWindowAppProps {
  /** The project this window was opened for. */
  tabId: string;
  /** This pop-out's own id; the main window addresses it by this. */
  windowId: string;
}

function closeThisWindow() {
  getCurrentWindow()
    .close()
    .catch((err) => console.error("Failed to close project window:", err));
}

/**
 * Root of a project pop-out window: the full Maestro layout (sidebar, top
 * bar, git and utility panels, bottom bar) for the projects it holds.
 *
 * It fetches its first project from the main window, then renders `<App />`
 * in pop-out mode, which leaves app-wide jobs to the main window. More
 * projects join when their tabs are dragged here from another pop-out. Every
 * change streams back (see `lib/projectWindow`), so closing this window — or
 * dragging a tab onto the main window — docks projects in the main window
 * again with their terminals still running.
 */
export function ProjectWindowApp({ tabId, windowId }: ProjectWindowAppProps) {
  const [handedOff, setHandedOff] = useState(false);
  const [handoffFailed, setHandoffFailed] = useState(false);
  const gridStates = useRef(new Map<string, GridSnapshot | null>());
  const tabs = useWorkspaceStore((s) => s.tabs);
  const parkedSessionIds = useSessionStore((s) => s.parkedSessionIds);

  // Follow the main window's theme (localStorage is shared across windows).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return;
      document.documentElement.setAttribute(
        "data-theme",
        e.newValue === "light" ? "light" : "dark",
      );
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Projects arrive from the main window: the first one on request, more
  // when their tabs are dragged here. Each is added as the selected tab.
  useEffect(() => {
    const unlistenPromise = listen<ProjectHandoff>(PROJECT_WINDOW_EVENTS.handoff, (event) => {
      const { windowId: target, tab, parkedSessionIds: parked, grid } = event.payload;
      if (target !== windowId) return;
      if (useWorkspaceStore.getState().tabs.some((t) => t.id === tab.id)) return;
      // The grid is rebuilt from this snapshot and re-attaches to the running
      // terminals, replaying their output.
      if (grid) useProjectWindowStore.getState().seedGrid(tab.id, grid);
      gridStates.current.set(tab.id, grid);
      useWorkspaceStore.setState((state) => ({
        tabs: [...state.tabs.map((t) => ({ ...t, active: false })), { ...tab, active: true }],
      }));
      useSessionStore.setState((state) => ({
        parkedSessionIds: Array.from(new Set([...state.parkedSessionIds, ...parked])),
      }));
      setHandedOff(true);
      getCurrentWindow()
        .setTitle(`${tab.name} — Maestro`)
        .catch(() => {});
    });
    unlistenPromise
      .then(() => emitTo(MAIN_WINDOW_LABEL, PROJECT_WINDOW_EVENTS.ready, { tabId }))
      .catch((err) => console.error("Failed to request project from main window:", err));
    const timeout = setTimeout(() => {
      if (useWorkspaceStore.getState().tabs.length === 0) setHandoffFailed(true);
    }, HANDOFF_TIMEOUT_MS);
    return () => {
      clearTimeout(timeout);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [tabId, windowId]);

  // A project left this window (docked in the main window, or moved to
  // another pop-out): drop its tab without stopping its terminals, and close
  // the window once nothing is left in it.
  useEffect(() => {
    const unlistenPromise = listen<TabInWindow>(PROJECT_WINDOW_EVENTS.release, (event) => {
      const { tabId: leaving, windowId: target } = event.payload;
      if (target !== windowId) return;
      gridStates.current.delete(leaving);
      const remaining = useWorkspaceStore.getState().tabs.filter((t) => t.id !== leaving);
      if (remaining.length === 0) {
        closeThisWindow();
        return;
      }
      const hasActive = remaining.some((t) => t.active);
      useWorkspaceStore.setState({
        tabs: remaining.map((t, i) => (hasActive || i > 0 ? t : { ...t, active: true })),
      });
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [windowId]);

  // Stream a project's state to the main window, so it docks back intact
  // however it leaves this window.
  const sendUpdate = useCallback(
    (id: string) => {
      const current = useWorkspaceStore.getState().tabs.find((t) => t.id === id);
      if (!current) return;
      const update: ProjectWindowUpdate = {
        tabId: id,
        windowId,
        tab: projectWindowTabFields(current),
        grid: current.sessionsLaunched ? (gridStates.current.get(id) ?? null) : null,
        parkedSessionIds: useSessionStore
          .getState()
          .parkedSessionIds.filter((sid) => current.sessionIds.includes(sid)),
      };
      emitTo(MAIN_WINDOW_LABEL, PROJECT_WINDOW_EVENTS.update, update).catch((err) => {
        console.error("Failed to send project update to main window:", err);
      });
    },
    [windowId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `parkedSessionIds` isn't read here (sendUpdate reads fresh state) but is a trigger — any change to the parked set must reach the main window.
  useEffect(() => {
    if (!handedOff) return;
    for (const tab of tabs) sendUpdate(tab.id);
  }, [handedOff, tabs, parkedSessionIds, sendUpdate]);

  const host = useMemo<ProjectWindowHost>(
    () => ({
      tabId,
      onGridStateChange: (id, snapshot) => {
        if (!useWorkspaceStore.getState().tabs.some((t) => t.id === id)) return;
        gridStates.current.set(id, snapshot);
        sendUpdate(id);
      },
      onProjectClosed: (id) => {
        gridStates.current.delete(id);
        emitTo(MAIN_WINDOW_LABEL, PROJECT_WINDOW_EVENTS.closeTab, id)
          .catch((err) => console.error("Failed to tell main window the project closed:", err))
          .finally(() => {
            if (useWorkspaceStore.getState().tabs.length === 0) closeThisWindow();
          });
      },
      onTabDroppedOutside: async (id, point) => {
        try {
          const target = await dropTargetAt(point, windowId);
          if (target?.kind === "main") {
            const dock: TabInWindow = { tabId: id, windowId };
            await emitTo(MAIN_WINDOW_LABEL, PROJECT_WINDOW_EVENTS.dockTab, dock);
          } else if (target?.kind === "popout") {
            const move: TabMove = {
              tabId: id,
              fromWindowId: windowId,
              toWindowId: target.windowId,
            };
            await emitTo(MAIN_WINDOW_LABEL, PROJECT_WINDOW_EVENTS.moveTab, move);
          }
        } catch (err) {
          console.error("Failed to move project to another window:", err);
        }
      },
    }),
    [tabId, windowId, sendUpdate],
  );

  if (handedOff) return <App projectWindow={host} />;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-maestro-bg">
      <p className="text-sm text-maestro-muted">
        {handoffFailed
          ? "Couldn't load this project from the main window. Close this window to return it."
          : "Loading project…"}
      </p>
    </div>
  );
}
