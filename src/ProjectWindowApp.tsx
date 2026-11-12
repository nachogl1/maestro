import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GridSnapshot,
  isOverMainWindow,
  MAIN_WINDOW_LABEL,
  PROJECT_WINDOW_EVENTS,
  type ProjectHandoff,
  type ProjectWindowHost,
  type ProjectWindowUpdate,
  projectWindowTabFields,
} from "@/lib/projectWindow";
import { useProjectWindowStore } from "@/stores/useProjectWindowStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import App from "./App";

/** How long to wait for the main window's handoff before showing an error. */
const HANDOFF_TIMEOUT_MS = 5000;

const THEME_STORAGE_KEY = "maestro-theme";

interface ProjectWindowAppProps {
  tabId: string;
}

/**
 * Root of a project pop-out window: the full Maestro layout (sidebar, top
 * bar, git and utility panels, bottom bar) for the one project it holds.
 *
 * It fetches the project from the main window, then renders `<App />` in
 * pop-out mode, which leaves app-wide jobs to the main window. Every change
 * streams back (see `lib/projectWindow`), so closing this window — or
 * dragging its tab onto the main window — docks the project in the main
 * window again with its terminals still running.
 */
export function ProjectWindowApp({ tabId }: ProjectWindowAppProps) {
  const [handedOff, setHandedOff] = useState(false);
  const [handoffFailed, setHandoffFailed] = useState(false);
  const gridStateRef = useRef<GridSnapshot | null>(null);
  const tab = useWorkspaceStore((s) => s.tabs.find((t) => t.id === tabId) ?? null);
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

  // Ask the main window for the project, then seed this window's stores.
  useEffect(() => {
    let received = false;
    const unlistenPromise = listen<ProjectHandoff>(PROJECT_WINDOW_EVENTS.handoff, (event) => {
      if (received || event.payload.tab.id !== tabId) return;
      received = true;
      const { tab: handedTab, parkedSessionIds: parked, grid } = event.payload;
      // The grid is rebuilt from this snapshot and re-attaches to the running
      // terminals, replaying their output.
      if (grid) useProjectWindowStore.getState().seedGrid(tabId, grid);
      gridStateRef.current = grid;
      useWorkspaceStore.setState({ tabs: [{ ...handedTab, active: true }] });
      useSessionStore.setState((state) => ({
        parkedSessionIds: Array.from(new Set([...state.parkedSessionIds, ...parked])),
      }));
      setHandedOff(true);
      getCurrentWindow()
        .setTitle(`${handedTab.name} — Maestro`)
        .catch(() => {});
    });
    unlistenPromise
      .then(() => emitTo(MAIN_WINDOW_LABEL, PROJECT_WINDOW_EVENTS.ready, { tabId }))
      .catch((err) => console.error("Failed to request project from main window:", err));
    const timeout = setTimeout(() => {
      if (!received) setHandoffFailed(true);
    }, HANDOFF_TIMEOUT_MS);
    return () => {
      clearTimeout(timeout);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [tabId]);

  // Stream the project's state to the main window on every change, so the
  // tab docks back intact however this window ends up closing.
  const sendUpdate = useCallback(() => {
    const current = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
    if (!current) return;
    const update: ProjectWindowUpdate = {
      tabId,
      tab: projectWindowTabFields(current),
      grid: current.sessionsLaunched ? gridStateRef.current : null,
      parkedSessionIds: useSessionStore
        .getState()
        .parkedSessionIds.filter((sid) => current.sessionIds.includes(sid)),
    };
    emitTo(MAIN_WINDOW_LABEL, PROJECT_WINDOW_EVENTS.update, update).catch((err) => {
      console.error("Failed to send project update to main window:", err);
    });
  }, [tabId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tab` and `parkedSessionIds` aren't read here (sendUpdate reads fresh state) but are the triggers — any change to the tab or its parked set must reach the main window.
  useEffect(() => {
    if (handedOff) sendUpdate();
  }, [handedOff, tab, parkedSessionIds, sendUpdate]);

  const host = useMemo<ProjectWindowHost>(
    () => ({
      tabId,
      onGridStateChange: (id, snapshot) => {
        if (id !== tabId) return;
        gridStateRef.current = snapshot;
        sendUpdate();
      },
      onProjectClosed: (id) => {
        if (id !== tabId) return;
        emitTo(MAIN_WINDOW_LABEL, PROJECT_WINDOW_EVENTS.closeTab, tabId)
          .catch((err) => console.error("Failed to tell main window the project closed:", err))
          .finally(() => {
            getCurrentWindow()
              .close()
              .catch((err) => console.error("Failed to close project window:", err));
          });
      },
      onTabDroppedOutside: async (id, point) => {
        if (id !== tabId) return;
        try {
          if (!(await isOverMainWindow(point))) return;
          // Closing the pop-out docks the project back in the main window.
          await getCurrentWindow().close();
        } catch (err) {
          console.error("Failed to dock project window:", err);
        }
      },
    }),
    [tabId, sendUpdate],
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
