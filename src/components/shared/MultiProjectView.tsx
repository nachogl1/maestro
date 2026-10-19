import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Pin } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  compareRowMajor,
  dropBesideTile,
  EAGLE_UNITS,
  type EagleLayout,
  insertColumnAtEdge,
  layoutEagleTiles,
  rectsEqual,
  resizeTile,
  type TileRect,
} from "@/lib/eagleLayout";
import { type MoveDirection, neighbourInDirection, type PaneEdge } from "@/lib/paneMoves";
import { PIN_STRIP_HEIGHT, PIN_STRIP_LABEL, pinnedStripLayout } from "@/lib/pinnedStrip";
import { projectColorFor } from "@/lib/projectColor";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { useProjectColors } from "@/lib/useProjectColors";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { ParkedShelf } from "../terminal/ParkedShelf";
import {
  type EagleDropTarget,
  TerminalGrid,
  type TerminalGridHandle,
} from "../terminal/TerminalGrid";
import { SessionStatusDot } from "../terminal/ThinkingIndicator";
import { IdleLandingView } from "./IdleLandingView";

/** Stable empty record so the names selector doesn't re-render grids while the bar is hidden. */
const EMPTY_SESSION_NAMES: Record<number, string> = {};

/**
 * Visual gap between eagle tiles in px. The grid itself has no gap (it has
 * EAGLE_UNITS tracks per axis, so a track gap would eat the screen); each
 * tile pads itself by half of this, and the grid pads its border by half too.
 */
export const EAGLE_GAP_PX = 8;

/** Layout outside eagle view: nothing placed. */
const EMPTY_EAGLE_LAYOUT: EagleLayout = {
  tiles: new Map(),
  pending: new Map(),
  occupied: [],
  reset: false,
};

/** Stable empty array so the parked selector doesn't re-render grids outside eagle view. */
const EMPTY_PARKED: number[] = [];

/**
 * Reads a per-tab callback built from the same `tabs` array being rendered —
 * every tab id is guaranteed to be a key, so a miss means the two fell out of sync.
 */
function mustCallback<T>(callbacks: Map<string, T>, tabId: string): T {
  const cb = callbacks.get(tabId);
  if (!cb) throw new Error(`no callback registered for tab "${tabId}"`);
  return cb;
}

interface MultiProjectViewProps {
  onSessionCountChange?: (
    tabId: string,
    slotCount: number,
    launchedCount: number,
    occupiedCount: number,
  ) => void;
  /**
   * Eagle view: show every project's terminals at once in one flat grid
   * (tiles color-coded by project) instead of only the active project.
   */
  eagleView?: boolean;
}

export interface MultiProjectViewHandle {
  addSessionToActiveProject: () => void;
  /** Add a pre-launch slot to the given project (mounting its grid if idle). False if the tab doesn't exist. */
  addSessionInProject: (tabId: string) => boolean;
  launchAllInActiveProject: () => Promise<void>;
  refreshBranchesInActiveProject: () => void;
  /**
   * Tidy up: give every terminal of the active project an even share of its
   * grid — in eagle view, put every tile back on the automatic even layout.
   */
  tidyActiveProject: () => void;
  /** Focus the pane running the given session. False if that grid isn't mounted or doesn't own it. */
  focusSessionInProject: (tabId: string, sessionId: number) => boolean;
  /** Zoom into the pane running the given session (eagle zoom in eagle view, per-project zoom otherwise). False if no grid owns it. */
  zoomSessionInProject: (tabId: string, sessionId: number) => boolean;
  /** Kill the given session (with full pane cleanup). False if that grid isn't mounted or doesn't own it. */
  killSessionInProject: (tabId: string, sessionId: number) => boolean;
  /**
   * Footer navigator: bring the given session in front of the user. Parked
   * sessions are restored first. If a zoom-in view is showing (eagle or
   * per-project) the session is zoomed; otherwise the project is selected and
   * the cursor lands in that terminal. False if no grid owns the session.
   */
  navigateToSession: (tabId: string, sessionId: number) => boolean;
}

/**
 * Root content view that renders ALL open projects simultaneously.
 * Uses CSS display/opacity/pointer-events to show only the active project
 * while keeping terminal state alive in inactive projects (ZStack pattern).
 *
 * This is modeled after the Swift app's MultiProjectContentView which
 * uses a ZStack to preserve terminal NSView state across project switches.
 */
export const MultiProjectView = forwardRef<MultiProjectViewHandle, MultiProjectViewProps>(
  function MultiProjectView({ onSessionCountChange, eagleView = false }, ref) {
    const tabs = useWorkspaceStore((s) => s.tabs);
    const setSessionsLaunched = useWorkspaceStore((s) => s.setSessionsLaunched);
    const setSelectedRepo = useWorkspaceStore((s) => s.setSelectedRepo);
    const gridRefs = useRef<Map<string, TerminalGridHandle>>(new Map());

    // Eagle view: which session (if any) is zoomed to fill the window.
    // Keyed by backend session ID (globally unique across projects) so the
    // global zoom tab bar can be built purely from the stores.
    const [eagleZoom, setEagleZoom] = useState<number | null>(null);

    // Idle project whose grid is mounting because the user asked for a new
    // terminal: that grid focuses its first card's name input on mount. A ref,
    // not state: the store update that mounts the grid can render on its own
    // (sync lane) before a state update would. Cleared after every commit, so
    // a later remount (e.g. a History launch) won't take focus.
    const nameFocusTabIdRef = useRef<string | null>(null);
    useEffect(() => {
      nameFocusTabIdRef.current = null;
    });

    // Pending (unlaunched) slot count per tab, kept in sync from each grid's
    // onSessionCountChange. A visible pre-launch tile needs a grid column same
    // as a launched session, so eagleTileCount below adds this to
    // liveSessionCount. Stale tabs aren't deleted here — eagleTileCount only
    // sums over the current `tabs`, so a closed project's leftover entry is
    // simply never counted.
    const [pendingCounts, setPendingCounts] = useState<Map<string, number>>(new Map());

    // Live session count drives the eagle grid's column count. Gated on
    // eagleView so session launches/kills don't re-render every project's grid
    // while the eagle grid isn't even showing. Parked tiles are display:none,
    // so they must not reserve grid columns.
    const liveSessionCount = useSessionStore((s) =>
      eagleView ? s.sessions.filter((x) => !s.parkedSessionIds.includes(x.id)).length : 0,
    );

    // Pinned terminals — the ones that follow the user across projects.
    const pinnedSessionIds = useSessionStore((s) => s.pinnedSessionIds);

    // Parked sessions feed the eagle shelf and are skipped by the zoom tab bar.
    // Also needed outside eagle view once anything is pinned: a parked pane is
    // hidden, so it must not claim a cell in the pinned strip.
    const parkedSessionIds = useSessionStore((s) =>
      eagleView || s.pinnedSessionIds.length > 0 ? s.parkedSessionIds : EMPTY_PARKED,
    );

    // Leaving eagle view always drops the zoom.
    useEffect(() => {
      if (!eagleView) setEagleZoom(null);
    }, [eagleView]);

    // All running sessions across projects in tab/launch order — drives the
    // global zoom tab bar and Alt+Arrow cycling.
    const projectColors = useProjectColors();
    const eagleSessions = useMemo(() => {
      if (!eagleView) return [];
      const list: { sessionId: number; projectName: string; color: string }[] = [];
      for (const tab of tabs) {
        if (!tab.sessionsLaunched) continue;
        for (const sessionId of tab.sessionIds) {
          // Parked tiles are hidden — skipping them here also triggers the
          // stale-zoom guard below when the zoomed session itself parks.
          if (parkedSessionIds.includes(sessionId)) continue;
          list.push({
            sessionId,
            projectName: tab.name,
            color: projectColors.get(tab.name) ?? projectColorFor(tab.name),
          });
        }
      }
      return list;
    }, [eagleView, tabs, projectColors, parkedSessionIds]);

    // Session names for the tab labels. Derived record + shallow compare so the
    // raw sessions array (replaced on every status update) doesn't re-render
    // every grid; only visible while the bar is showing.
    const sessionNames = useSessionStore(
      useShallow((s) => {
        if (!eagleView || eagleZoom === null) return EMPTY_SESSION_NAMES;
        const names: Record<number, string> = {};
        for (const sess of s.sessions) {
          if (sess.name) names[sess.id] = sess.name;
        }
        return names;
      }),
    );

    // Pending (unlaunched) tiles, summed only over tabs that still exist —
    // this is what keeps a closed project's leftover pendingCounts entry from
    // being counted. A visible pre-launch card needs a place in the grid like
    // a launched tile does.
    const pendingTileCount = tabs.reduce((sum, tab) => sum + (pendingCounts.get(tab.id) ?? 0), 0);

    // The user's tile placements (store, runtime-only — session ids don't
    // survive restarts). The layout is derived from them: a stored rect is
    // kept while it still fits, everything else (new sessions, pre-launch
    // cards) goes into the largest hole; with nothing stored it is the
    // automatic square-ish grid in project tab order (see eagleLayout.ts).
    const eagleTileRects = useWorkspaceStore((s) => s.eagleTileRects);
    const setEagleTileRects = useWorkspaceStore((s) => s.setEagleTileRects);
    const eagleLayout = useMemo(
      () =>
        eagleView
          ? layoutEagleTiles({
              sessionIds: eagleSessions.map((sess) => sess.sessionId),
              pendingByTab: tabs.map((tab) => [tab.id, pendingCounts.get(tab.id) ?? 0] as const),
              stored: eagleTileRects,
            })
          : EMPTY_EAGLE_LAYOUT,
      [eagleView, eagleSessions, tabs, pendingCounts, eagleTileRects],
    );
    // The stored placements could not be honoured at all: the view fell back
    // to the automatic layout, so make the store say so too.
    useEffect(() => {
      if (eagleLayout.reset) setEagleTileRects({});
    }, [eagleLayout.reset, setEagleTileRects]);

    // Reading order of the tiles (top to bottom, left to right) — drives the
    // zoom tab strip and Alt+Arrow cycling, so they follow what is on screen.
    const orderedEagleSessions = useMemo(() => {
      const { tiles } = eagleLayout;
      return [...eagleSessions].sort((a, b) => {
        const ra = tiles.get(a.sessionId);
        const rb = tiles.get(b.sessionId);
        return ra && rb ? compareRowMajor(ra, rb) : 0;
      });
    }, [eagleSessions, eagleLayout]);

    // Moves and resizes commit the WHOLE layout (every launched tile's rect),
    // so the first change freezes the automatic placement the user started from.
    const commitEagleRects = useCallback(
      (tiles: ReadonlyMap<number, TileRect>) => setEagleTileRects(Object.fromEntries(tiles)),
      [setEagleTileRects],
    );
    const handleEagleDrop = useCallback(
      (sessionId: number, target: EagleDropTarget) => {
        const tiles = new Map(eagleLayout.tiles);
        const own = tiles.get(sessionId);
        if (!own) return;
        if (target.kind === "swap") {
          const other = tiles.get(target.sessionId);
          if (!other || target.sessionId === sessionId) return;
          tiles.set(sessionId, other);
          tiles.set(target.sessionId, own);
        } else if (target.kind === "beside") {
          const next = dropBesideTile(tiles, sessionId, target.sessionId, target.side);
          if (!next) return;
          commitEagleRects(next);
          return;
        } else if (target.kind === "edge") {
          const next = insertColumnAtEdge(tiles, sessionId, target.edge);
          if (!next) return;
          commitEagleRects(next);
          return;
        } else {
          tiles.set(sessionId, target.rect);
        }
        commitEagleRects(tiles);
      },
      [eagleLayout, commitEagleRects],
    );
    const handleEagleMoveTile = useCallback(
      (sessionId: number, direction: MoveDirection) => {
        const own = eagleLayout.tiles.get(sessionId);
        if (!own) return;
        const others = [...eagleLayout.tiles]
          .filter(([id]) => id !== sessionId)
          .map(([id, r]) => ({ id, rect: { left: r.x, top: r.y, width: r.w, height: r.h } }));
        const dest = neighbourInDirection(
          { left: own.x, top: own.y, width: own.w, height: own.h },
          others,
          direction,
        );
        if (dest !== null) handleEagleDrop(sessionId, { kind: "swap", sessionId: dest });
      },
      [eagleLayout, handleEagleDrop],
    );
    // `others` is the collision set the pane captured when the drag started,
    // so a card re-placed mid-drag cannot block the edge on the way back.
    const handleEagleResizeTile = useCallback(
      (
        sessionId: number,
        start: TileRect,
        edge: PaneEdge,
        delta: number,
        others: readonly TileRect[],
      ) => {
        const current = eagleLayout.tiles.get(sessionId);
        if (!current) return;
        const next = resizeTile(start, edge, delta, others);
        if (rectsEqual(next, current)) return;
        const tiles = new Map(eagleLayout.tiles);
        tiles.set(sessionId, next);
        commitEagleRects(tiles);
      },
      [eagleLayout, commitEagleRects],
    );

    // Stale-zoom guard: if the zoomed session disappears from the strip
    // (parked, killed or closed), keep the user in zoom-in — the next terminal
    // (same order as Alt+Arrow, via the previous strip order) takes over the
    // zoom, matching the per-project zoom's passZoomToNeighbor. Drop the zoom
    // only when nothing is left to zoom — otherwise every tile stays
    // visibility:hidden and the view blanks.
    const prevEagleOrderRef = useRef<number[]>([]);
    useEffect(() => {
      if (eagleZoom !== null && !eagleSessions.some((s) => s.sessionId === eagleZoom)) {
        let next: number | null = null;
        if (orderedEagleSessions.length > 0) {
          const prevIds = prevEagleOrderRef.current;
          const oldIdx = prevIds.indexOf(eagleZoom);
          for (let step = 1; oldIdx >= 0 && step <= prevIds.length; step++) {
            const cand = prevIds[(oldIdx + step) % prevIds.length];
            if (orderedEagleSessions.some((s) => s.sessionId === cand)) {
              next = cand;
              break;
            }
          }
          if (next === null) next = orderedEagleSessions[0].sessionId;
        }
        setEagleZoom(next);
      }
      prevEagleOrderRef.current = orderedEagleSessions.map((s) => s.sessionId);
    }, [eagleZoom, eagleSessions, orderedEagleSessions]);

    // Pinned terminals of the OTHER projects, placed into the strip. `null`
    // means no strip: eagle view already shows every project at once.
    const pinnedStrip = useMemo(
      () => (eagleView ? null : pinnedStripLayout(tabs, pinnedSessionIds, parkedSessionIds)),
      [eagleView, tabs, pinnedSessionIds, parkedSessionIds],
    );

    const eagleTabSensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    );
    const handleEagleTabDragEnd = useCallback(
      (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        // Dropping a tab on another swaps the two tiles' places in the grid.
        handleEagleDrop(Number(active.id), { kind: "swap", sessionId: Number(over.id) });
      },
      [handleEagleDrop],
    );

    // Keyboard while eagle-zoomed. Capture phase: xterm stops propagation on
    // keys it handles, so bubble-phase Alt+Arrow would never fire while a
    // terminal has focus. Esc deliberately does NOT exit zoom — the focused
    // terminal needs it (e.g. interrupting Claude); exit via the tab bar's
    // close button or by clicking the active tab.
    useEffect(() => {
      if (!eagleView || eagleZoom === null) return;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const idx = orderedEagleSessions.findIndex((s) => s.sessionId === eagleZoom);
        if (idx < 0 || orderedEagleSessions.length === 0) return;
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const next =
          orderedEagleSessions[
            (idx + delta + orderedEagleSessions.length) % orderedEagleSessions.length
          ];
        setEagleZoom(next.sessionId);
      };
      window.addEventListener("keydown", handleKeyDown, { capture: true });
      return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
    }, [eagleView, eagleZoom, orderedEagleSessions]);

    // Alt+T in eagle view: tidy up — every tile back on the automatic even
    // layout (the per-project Alt+T in useTerminalKeyboard is off here).
    // Capture phase for the same xterm reason as above.
    useEffect(() => {
      if (!eagleView) return;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.code !== "KeyT") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setEagleTileRects({});
      };
      window.addEventListener("keydown", handleKeyDown, { capture: true });
      return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
    }, [eagleView, setEagleTileRects]);

    // Focus follows the zoomed terminal (tab click / Alt+Arrow). Only the grid
    // that owns the session accepts the call, same pattern as killSessionInProject.
    useEffect(() => {
      if (!eagleView || eagleZoom === null) return;
      for (const handle of gridRefs.current.values()) {
        if (handle.focusSession(eagleZoom)) break;
      }
    }, [eagleView, eagleZoom]);

    // Single stable toggle shared by every grid — session IDs are global, so
    // no per-tab closure is needed.
    const handleEagleZoomToggle = useCallback((sessionId: number) => {
      setEagleZoom((prev) => (prev === sessionId ? null : sessionId));
    }, []);

    // Restore a parked terminal from the eagle shelf into the view the user is
    // in: while eagle-zoomed the restored terminal takes over the zoom (its
    // tile would otherwise stay hidden behind the zoom overlay and the click
    // would appear to do nothing); otherwise it reappears as a grid tile. Only
    // the grid that owns the session accepts the focus call, same pattern as
    // the zoom-focus effect.
    const handleEagleUnpark = useCallback((sessionId: number) => {
      useSessionStore.getState().unparkSession(sessionId);
      setEagleZoom((prev) => (prev === null ? null : sessionId));
      for (const handle of gridRefs.current.values()) {
        if (handle.focusSession(sessionId)) break;
      }
    }, []);

    // Expose methods to parent
    useImperativeHandle(
      ref,
      () => ({
        addSessionToActiveProject: () => {
          const activeTab = tabs.find((t) => t.active);
          if (activeTab) {
            const gridRef = gridRefs.current.get(activeTab.id);
            gridRef?.addSession();
          }
        },
        addSessionInProject: (tabId: string) => {
          // Drop any eagle zoom first — otherwise the new pre-launch tile
          // mounts behind the zoomed pane's opaque overlay, invisible to the
          // user until they exit zoom themselves.
          if (eagleView) setEagleZoom(null);
          const gridRef = gridRefs.current.get(tabId);
          if (gridRef) {
            gridRef.addSession();
            return true;
          }
          // Idle project: no grid mounted yet. Mark it as launched so the grid
          // mounts with its initial pre-launch card.
          const tab = tabs.find((t) => t.id === tabId);
          if (!tab) return false;
          nameFocusTabIdRef.current = tabId;
          setSessionsLaunched(tabId, true);
          return true;
        },
        launchAllInActiveProject: async () => {
          const activeTab = tabs.find((t) => t.active);
          if (activeTab) {
            const gridRef = gridRefs.current.get(activeTab.id);
            await gridRef?.launchAll();
          }
        },
        refreshBranchesInActiveProject: () => {
          const activeTab = tabs.find((t) => t.active);
          if (activeTab) {
            const gridRef = gridRefs.current.get(activeTab.id);
            gridRef?.refreshBranches();
          }
        },
        tidyActiveProject: () => {
          if (eagleView) {
            setEagleTileRects({});
            return;
          }
          const activeTab = tabs.find((t) => t.active);
          if (activeTab) gridRefs.current.get(activeTab.id)?.tidyLayout();
        },
        focusSessionInProject: (tabId: string, sessionId: number) => {
          return gridRefs.current.get(tabId)?.focusSession(sessionId) ?? false;
        },
        zoomSessionInProject: (tabId: string, sessionId: number) => {
          if (eagleView) {
            setEagleZoom(sessionId);
            // Focus directly too: if this session is ALREADY eagle-zoomed the
            // focus-follows-zoom effect won't re-run (state unchanged).
            for (const handle of gridRefs.current.values()) {
              if (handle.focusSession(sessionId)) break;
            }
            return true;
          }
          return gridRefs.current.get(tabId)?.zoomSession(sessionId) ?? false;
        },
        killSessionInProject: (tabId: string, sessionId: number) => {
          return gridRefs.current.get(tabId)?.killSessionById(sessionId) ?? false;
        },
        navigateToSession: (tabId: string, sessionId: number) => {
          // Restore a parked session first so its pane exists to focus/zoom.
          const sessionStore = useSessionStore.getState();
          if (sessionStore.parkedSessionIds.includes(sessionId)) {
            sessionStore.unparkSession(sessionId);
          }

          if (eagleView) {
            if (eagleZoom !== null) {
              // Already in eagle zoom: swap the zoomed session.
              setEagleZoom(sessionId);
              for (const handle of gridRefs.current.values()) {
                if (handle.focusSession(sessionId)) break;
              }
              return true;
            }
            for (const handle of gridRefs.current.values()) {
              if (handle.focusSession(sessionId)) return true;
            }
            return false;
          }

          // Non-eagle: keep the user's current zoom-in/grid context. Read the
          // *active* grid's zoom state before switching projects.
          const activeTab = useWorkspaceStore.getState().tabs.find((t) => t.active);
          const wasZoomed = activeTab
            ? (gridRefs.current.get(activeTab.id)?.isZoomed() ?? false)
            : false;
          if (activeTab?.id !== tabId) {
            useWorkspaceStore.getState().selectTab(tabId);
          }
          const grid = gridRefs.current.get(tabId);
          if (!grid) return false;
          return wasZoomed ? grid.zoomSession(sessionId) : grid.focusSession(sessionId);
        },
      }),
      [tabs, setSessionsLaunched, eagleView, eagleZoom, setEagleTileRects],
    );

    // Create stable callbacks per tab to avoid infinite re-render loops
    // The callbacks are memoized by tab.id so they don't change on every render
    const sessionCountChangeCallbacks = useMemo(() => {
      const callbacks = new Map<
        string,
        (slotCount: number, launchedCount: number, occupiedCount: number) => void
      >();
      for (const tab of tabs) {
        callbacks.set(tab.id, (slotCount: number, launchedCount: number, occupiedCount: number) => {
          onSessionCountChange?.(tab.id, slotCount, launchedCount, occupiedCount);
          // Track this tab's pending (not-yet-launched) slots for eagleTileCount.
          // Bail out with the SAME map when the value didn't change so React
          // skips the re-render instead of looping on every report.
          const pending = slotCount - launchedCount;
          setPendingCounts((prev) => {
            if (prev.get(tab.id) === pending) return prev;
            const next = new Map(prev);
            next.set(tab.id, pending);
            return next;
          });
        });
      }
      return callbacks;
    }, [tabs, onSessionCountChange]);

    // Stable launch callbacks per tab
    const launchCallbacks = useMemo(() => {
      const callbacks = new Map<string, () => void>();
      for (const tab of tabs) {
        callbacks.set(tab.id, () => {
          nameFocusTabIdRef.current = tab.id;
          setSessionsLaunched(tab.id, true);
        });
      }
      return callbacks;
    }, [tabs, setSessionsLaunched]);

    // Stable all-sessions-closed callbacks per tab
    const allSessionsClosedCallbacks = useMemo(() => {
      const callbacks = new Map<string, () => void>();
      for (const tab of tabs) {
        callbacks.set(tab.id, () => {
          setSessionsLaunched(tab.id, false);
        });
      }
      return callbacks;
    }, [tabs, setSessionsLaunched]);

    // Stable repo change callbacks per tab
    const repoChangeCallbacks = useMemo(() => {
      const callbacks = new Map<string, (path: string) => void>();
      for (const tab of tabs) {
        callbacks.set(tab.id, (path: string) => {
          setSelectedRepo(tab.id, path);
        });
      }
      return callbacks;
    }, [tabs, setSelectedRepo]);

    // Stable ref setters per tab
    const gridRefSetters = useMemo(() => {
      const setters = new Map<string, (handle: TerminalGridHandle | null) => void>();
      for (const tab of tabs) {
        setters.set(tab.id, (handle: TerminalGridHandle | null) => {
          if (handle) {
            gridRefs.current.set(tab.id, handle);
          } else {
            gridRefs.current.delete(tab.id);
          }
        });
      }
      return setters;
    }, [tabs]);

    // No projects open - show simple message
    if (tabs.length === 0) {
      return (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-maestro-muted">
            Select a directory to launch Claude Code instances
          </p>
        </div>
      );
    }

    // Eagle view lays every launched pane AND every visible pre-launch card of
    // every project into one flat grid. The per-project wrappers and split
    // trees flatten out via `display:contents` (className "contents"), so the
    // SAME mounted xterm elements become direct grid items — no remount,
    // scrollback and PTY wiring survive the toggle. Tiles are placed by their
    // their rect in the EAGLE_UNITS × EAGLE_UNITS grid (see eagleLayout above).
    const eagleTileCount = liveSessionCount + pendingTileCount;

    // The outer column wrapper is permanent (both modes) so toggling eagle view
    // never changes the tree shape around the grids — that would remount every
    // xterm. It is deliberately NOT positioned: eagle-zoomed panes and the zoom
    // tab bar resolve their absolute positioning to App's <main>. The inner div
    // keeps `relative` in the non-eagle branch — the ZStack's absolute inset-0
    // project divs depend on it.
    return (
      <div className="flex h-full w-full flex-col">
        <div
          // The panes find the grid by this attribute to turn pointer
          // positions into grid cells (moves and resizes).
          data-eagle-grid={eagleView ? "" : undefined}
          className={
            eagleView ? "min-h-0 w-full flex-1 bg-maestro-bg" : "relative min-h-0 w-full flex-1"
          }
          style={
            eagleView
              ? {
                  display: "grid",
                  gridTemplateColumns: `repeat(${EAGLE_UNITS}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${EAGLE_UNITS}, minmax(0, 1fr))`,
                  padding: EAGLE_GAP_PX / 2,
                }
              : undefined
          }
        >
          {/* Global zoom tab bar: all running terminals across all projects,
          color-coded by project. position:absolute (resolving to App's <main>,
          the nearest positioned ancestor — this grid container is static) lifts
          it out of the grid flow and above the zoomed pane (z-40); the pane
          leaves top-8 for it. Staying inside <main> keeps the sidebar and git
          panel usable while zoomed, same as the per-project zoom. */}
          {eagleView &&
            eagleZoom !== null &&
            (() => {
              const zoomedIndex = orderedEagleSessions.findIndex((s) => s.sessionId === eagleZoom);
              return (
                <div className="absolute inset-x-0 top-0 z-50 flex h-8 items-center gap-2 border-b border-maestro-border bg-maestro-surface px-3">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-maestro-muted">
                    Terminal {zoomedIndex + 1}/{orderedEagleSessions.length}
                  </span>
                  <div className="h-3.5 w-px bg-maestro-border" />
                  <div
                    className="scrollbar-none flex flex-1 gap-0.5 overflow-x-auto"
                    onWheel={(e) => {
                      // Vertical wheel input scrolls the strip horizontally (scrollbar is hidden).
                      if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY;
                    }}
                  >
                    <DndContext
                      sensors={eagleTabSensors}
                      collisionDetection={closestCenter}
                      modifiers={[restrictToHorizontalAxis]}
                      onDragEnd={handleEagleTabDragEnd}
                    >
                      <SortableContext
                        items={orderedEagleSessions.map((s) => s.sessionId)}
                        strategy={horizontalListSortingStrategy}
                      >
                        {orderedEagleSessions.map((session, index) => (
                          <EagleZoomTab
                            key={session.sessionId}
                            sessionId={session.sessionId}
                            index={index}
                            isActive={session.sessionId === eagleZoom}
                            label={sessionDisplayName({
                              id: session.sessionId,
                              name: sessionNames[session.sessionId],
                            })}
                            projectName={session.projectName}
                            color={session.color}
                            onSelect={() => handleEagleZoomToggle(session.sessionId)}
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEagleZoom(null)}
                    className="rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
                    title="Exit zoom"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              );
            })()}

          {/* Eagle view with nothing running or pending: every tile is hidden,
          so give the empty grid a hint instead of a blank screen. */}
          {eagleView && eagleTileCount === 0 && (
            <div
              className="flex h-full items-center justify-center"
              style={{ gridColumn: "1 / -1" }}
            >
              <p className="text-sm text-maestro-muted">
                No running terminals — launch sessions to see them here
              </p>
            </div>
          )}

          {/* Pinned strip backdrop. Sits above the active project's stack
          (z-10) and below the pinned tiles themselves (z-30), which the owning
          grids position into it. */}
          {pinnedStrip && (
            <div
              className="absolute inset-x-0 bottom-0 z-20 border-t border-maestro-border bg-maestro-bg"
              style={{ height: PIN_STRIP_HEIGHT }}
            >
              <div
                className="flex items-center gap-1 px-2 text-[10px] font-medium uppercase tracking-wider text-maestro-muted"
                style={{ height: PIN_STRIP_LABEL }}
              >
                <Pin size={10} />
                <span>Pinned</span>
              </div>
            </div>
          )}

          {/* Render ALL project views in a stacked container (ZStack equivalent).
          In eagle view the stack flattens: launched projects become transparent
          (display:contents) so their panes tile into the grid above; idle
          projects are hidden entirely. */}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              // The active project gives up the strip's height so its own grid
              // (and parked shelf) never sit underneath the pinned tiles.
              style={
                !eagleView && pinnedStrip && tab.active ? { bottom: PIN_STRIP_HEIGHT } : undefined
              }
              className={
                eagleView
                  ? tab.sessionsLaunched
                    ? "contents"
                    : "hidden"
                  : pinnedStrip?.has(tab.id)
                    ? // Owns a pinned terminal: flatten the wrapper so the grid
                      // can position that one tile into the strip. Every other
                      // pane of this project stays hidden.
                      "contents"
                    : // Inactive projects are `display:none`, NOT `visibility:hidden`.
                      // xterm.js pauses its render loop from an IntersectionObserver,
                      // which never fires for visibility:hidden — every background
                      // terminal would keep a live WebGL render loop burning GPU and
                      // main-thread time for zero visible pixels, and the terminal the
                      // user is typing in competes with all of them. display:none is
                      // the only thing that makes the element non-intersecting.
                      //
                      // Cost: the crossfade is gone in BOTH directions — display isn't
                      // animatable, and an element flipped from display:none has no
                      // before-change style, so the opacity transition never starts.
                      // Switching projects is an instant cut. Deliberate trade.
                      //
                      // Re-showing still refits: a display:none pane reports a 0x0
                      // content box, so the pane's ResizeObserver fires on the
                      // none → block transition — including at a new size after a
                      // window resize that happened while the project was hidden
                      // (see TerminalView's runFit).
                      `absolute inset-0 transition-opacity duration-150 ${
                        tab.active
                          ? "opacity-100 pointer-events-auto z-10"
                          : "hidden opacity-0 pointer-events-none z-0"
                      }`
              }
            >
              {tab.sessionsLaunched ? (
                <TerminalGrid
                  ref={gridRefSetters.get(tab.id)}
                  tabId={tab.id}
                  projectPath={tab.projectPath}
                  repoPath={tab.selectedRepoPath ?? undefined}
                  repositories={tab.repositories}
                  workspaceType={tab.workspaceType}
                  onRepoChange={repoChangeCallbacks.get(tab.id)}
                  preserveOnHide={true}
                  isActive={tab.active}
                  onSessionCountChange={sessionCountChangeCallbacks.get(tab.id)}
                  onAllSessionsClosed={allSessionsClosedCallbacks.get(tab.id)}
                  focusNameOnMount={nameFocusTabIdRef.current === tab.id}
                  eagleMode={eagleView}
                  projectName={tab.name}
                  eagleZoomedSessionId={eagleZoom}
                  eagleAnyZoomed={eagleView && eagleZoom !== null}
                  onEagleZoomToggle={handleEagleZoomToggle}
                  eagleTileCount={eagleTileCount}
                  pinnedTileStyles={pinnedStrip?.get(tab.id) ?? null}
                  eagleTileRects={eagleLayout.tiles}
                  eaglePendingRects={eagleLayout.pending.get(tab.id)}
                  eagleOccupied={eagleLayout.occupied}
                  onEagleDrop={handleEagleDrop}
                  onEagleMoveTile={handleEagleMoveTile}
                  onEagleResizeTile={handleEagleResizeTile}
                />
              ) : (
                <IdleLandingView onAdd={mustCallback(launchCallbacks, tab.id)} />
              )}
            </div>
          ))}
        </div>
        {/* Eagle shelf: parked chips across ALL projects, labeled by project. */}
        {eagleView && <ParkedShelf showProjectLabels onUnpark={handleEagleUnpark} />}
      </div>
    );
  },
);

/**
 * Single tab of the eagle zoom navigation strip: drag-reorderable via dnd-kit
 * (PointerSensor's 5px activation lets plain clicks through), shows the
 * session's warning flag and live status dot, and — matching the header and
 * per-project zoom strip — clicking the already-active tab toggles the
 * warning flag instead of exiting zoom (exit stays on the × button).
 */
function EagleZoomTab({
  sessionId,
  index,
  isActive,
  label,
  projectName,
  color,
  onSelect,
}: {
  sessionId: number;
  index: number;
  isActive: boolean;
  label: string;
  projectName: string;
  color: string;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sessionId,
  });

  // The strip scrolls horizontally with a hidden scrollbar, so a tab activated
  // by keyboard (Alt+Arrow) can sit outside the visible range. "nearest" on
  // both axes limits the scroll to the strip itself.
  const nodeRef = useRef<HTMLElement | null>(null);
  const combinedRef = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      nodeRef.current = node;
    },
    [setNodeRef],
  );
  useEffect(() => {
    if (isActive) nodeRef.current?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [isActive]);

  const isFlagged = useSessionStore((s) => s.flaggedSessionIds.includes(sessionId));
  // Attention highlight (auto-unparked because the agent needs input) —
  // same yellow chrome as the warning flag, cleared by selecting the session.
  const hasAttention = useSessionStore((s) => s.attentionSessionIds.includes(sessionId));
  // Attention-first click semantics on the active tab: the first click only
  // acknowledges the attention highlight — it must not also set the warning
  // flag. Subsequent clicks toggle the flag as before.
  const handleClick = isActive
    ? () => {
        if (hasAttention) {
          useSessionStore.getState().clearSessionAttention(sessionId);
          return;
        }
        useSessionStore.getState().toggleSessionFlag(sessionId);
      }
    : onSelect;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    ...(isActive && !isFlagged && !hasAttention
      ? {
          backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
          color,
        }
      : {}),
  };

  return (
    <button
      ref={combinedRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      className={`flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
        isFlagged || hasAttention ? "warning-flag" : ""
      } ${isActive ? "" : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"}`}
      title={
        isActive
          ? hasAttention
            ? `${projectName} · ${label} (needs input — click to clear the attention highlight)`
            : `${projectName} · ${label} (click to ${isFlagged ? "clear" : "set"} warning flag)`
          : `Switch to ${projectName} · ${label}`
      }
    >
      <span className="font-mono text-[10px] opacity-60">{index + 1}</span>
      <span className="font-bold" style={{ color }}>
        {projectName}
      </span>
      <span className="max-w-[180px] truncate">{label}</span>
      <SessionStatusDot sessionId={sessionId} />
    </button>
  );
}

/**
 * Get a grid handle for a specific tab to call addSession.
 */
export function useMultiProjectGridRef() {
  const gridRefs = useRef<Map<string, TerminalGridHandle>>(new Map());

  return {
    getGridRef: (tabId: string) => gridRefs.current.get(tabId),
    setGridRef: (tabId: string, handle: TerminalGridHandle | null) => {
      if (handle) {
        gridRefs.current.set(tabId, handle);
      } else {
        gridRefs.current.delete(tabId);
      }
    },
  };
}
