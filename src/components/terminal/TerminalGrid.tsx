import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { GripVertical, LayoutGrid } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEagleTerminalKeyboard } from "@/hooks/useEagleTerminalKeyboard";
import { usePendingLaunch } from "@/hooks/usePendingLaunch";
import { useSamuraiAutoPark } from "@/hooks/useSamuraiAutoPark";
import { useSlotLaunch } from "@/hooks/useSlotLaunch";
import { useTerminalDragDrop } from "@/hooks/useTerminalDragDrop";
import { useTerminalKeyboard } from "@/hooks/useTerminalKeyboard";
import {
  dropBesideTile,
  EAGLE_UNITS,
  fitsFree,
  insertColumnAtEdge,
  placeTileAt,
  type TileRect,
} from "@/lib/eagleLayout";
import {
  type BranchWithWorktreeStatus,
  getBranchesWithWorktreeStatus,
  invalidateCurrentBranchCache,
} from "@/lib/git";
import { type McpServerConfig, removeOpenCodeMcpConfig, removeSessionMcpConfig } from "@/lib/mcp";
import {
  type MoveDirection,
  neighbourInDirection,
  type PaneDropZone,
  type PaneEdge,
  paneDropZone,
  STAGE_EDGE_RATIO,
  stageEdgeAt,
} from "@/lib/paneMoves";
import {
  loadBranchConfig,
  type PluginConfig,
  removeSessionPluginConfig,
  type SkillConfig,
  saveBranchConfig,
} from "@/lib/plugins";
import { projectColorFor } from "@/lib/projectColor";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { altLabel, modLabel, titleWithShortcut } from "@/lib/shortcuts";
import { successorLaunchImminent } from "@/lib/spawnSession";
import {
  killSession,
  pathsForTerminalInput,
  removeSessionHooksConfig,
  writeStdin,
} from "@/lib/terminal";
import { useProjectColors } from "@/lib/useProjectColors";
import { cleanupSessionWorktree } from "@/lib/worktreeManager";
import { useActivityStore } from "@/stores/useActivityStore";
import { useMcpStore } from "@/stores/useMcpStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { usePluginStore } from "@/stores/usePluginStore";
import type { AiMode } from "@/stores/useSessionStore";
import { useSessionStore } from "@/stores/useSessionStore";
import {
  type RepositoryInfo,
  useWorkspaceStore,
  type WorkspaceType,
} from "@/stores/useWorkspaceStore";
import { useWorktreeSettingsStore } from "@/stores/useWorktreeSettingsStore";
import { ParkedShelf } from "./ParkedShelf";
import { PreLaunchCard, type SessionSlot } from "./PreLaunchCard";
import { SplitPaneView } from "./SplitPaneView";
import { createEmptySlot, occupiedSlotCount, sessionConfigDir } from "./slots";
import {
  buildGridTree,
  collectSlotIds,
  createLeaf,
  equalizeTree,
  findSiblingSlotId,
  MAX_SESSIONS,
  moveSlotToSide,
  moveSlotToTreeEdge,
  type PaneSide,
  removeLeaf,
  swapSlots,
  type TreeNode,
  updateRatio,
} from "./splitTree";
import { TerminalView } from "./TerminalView";
import { SessionStatusDot } from "./ThinkingIndicator";

export { MAX_RETAINED_PARKED_SAMURAI_TILES } from "@/hooks/useSamuraiAutoPark";

/** Stable empty arrays to avoid infinite re-render loops in Zustand selectors. */
const EMPTY_MCP_SERVERS: McpServerConfig[] = [];
const EMPTY_SKILLS: SkillConfig[] = [];
const EMPTY_PLUGINS: PluginConfig[] = [];

/**
 * Move keyboard focus into a pane's xterm textarea. Double rAF: the caller
 * often just changed React state that reveals the pane (un-zoom, tab switch),
 * so wait for that render to commit before querying the DOM.
 */
function focusSlotTextarea(slotId: string): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLElement>(
        `[data-slot-id="${slotId}"] .xterm-helper-textarea`,
      );
      textarea?.focus();
    });
  });
}

/**
 * Move keyboard focus into a pre-launch card's Window Name input, so a new
 * terminal can be named, Tabbed to Launch and started without the mouse.
 * Double rAF for the same reason as `focusSlotTextarea`: the card mounts in
 * the render the caller just triggered.
 */
function focusSlotNameInput(slotId: string): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.getElementById(`session-name-${slotId}`)?.focus();
    });
  });
}

/**
 * Imperative handle exposed via `useImperativeHandle` so parent components
 * (e.g. a toolbar button) can add sessions or launch all without lifting state up.
 */
export interface TerminalGridHandle {
  addSession: () => void;
  launchAll: () => Promise<void>;
  refreshBranches: () => void;
  /** Focus the pane running the given session. Returns false if this grid doesn't own it. */
  focusSession: (sessionId: number) => boolean;
  /** Zoom into the pane running the given session (and focus it). Returns false if this grid doesn't own it. */
  zoomSession: (sessionId: number) => boolean;
  /** Kill the given session and clean up its pane. Returns false if this grid doesn't own it. */
  killSessionById: (sessionId: number) => boolean;
  /** Whether this grid is currently showing its per-project zoom-in view. */
  isZoomed: () => boolean;
  /** Tidy up: give every pane an even share of the layout, keeping the arrangement. */
  tidyLayout: () => void;
}

/**
 * @property projectPath - Working directory passed to `spawnShell`; when absent the backend
 *   uses its own default cwd.
 * @property repoPath - Git repository path for branch/worktree operations. Defaults to projectPath.
 *   For multi-repo workspaces, this is the selected repository path.
 * @property repositories - List of all repositories in the workspace (for multi-repo workspaces).
 * @property workspaceType - Type of workspace: "single-repo" | "multi-repo" | "non-git".
 * @property onRepoChange - Callback to change the selected repository in multi-repo workspaces.
 * @property tabId - Workspace tab ID for session-project association.
 * @property preserveOnHide - If true, don't kill sessions when component unmounts (for project switching).
 * @property onSessionCountChange - Fires whenever session counts change,
 *   providing the total slot count, the launched session count, and the count
 *   that weighs against MAX_SESSIONS (parked samurai terminal-state tiles exempt).
 */
interface TerminalGridProps {
  projectPath?: string;
  repoPath?: string;
  repositories?: RepositoryInfo[];
  workspaceType?: WorkspaceType;
  onRepoChange?: (path: string) => void;
  tabId?: string;
  preserveOnHide?: boolean;
  isActive?: boolean;
  onSessionCountChange?: (slotCount: number, launchedCount: number, occupiedCount: number) => void;
  onAllSessionsClosed?: () => void;
  /**
   * Focus the initial card's Window Name input on mount. Set when Cmd/Ctrl+T
   * (or the landing page's add button) mounts the grid for an idle project,
   * so naming and launching the first terminal needs no mouse.
   */
  focusNameOnMount?: boolean;
  /**
   * Eagle view: this grid's launched panes AND pre-launch cards become items
   * of the global all-projects grid (via `display: contents` flattening)
   * instead of using the local split-tree layout. Per-project zoom and pane
   * drag/split are suspended.
   */
  eagleMode?: boolean;
  /** Project name shown on each pane header in eagle mode. */
  projectName?: string;
  /**
   * Session currently zoomed in eagle view (owned by MultiProjectView).
   * Keyed by backend session ID — globally unique across projects — so the
   * owner can drive the global zoom tab bar straight from the stores.
   */
  eagleZoomedSessionId?: number | null;
  /**
   * A pane somewhere (any project) is eagle-zoomed. Non-zoomed tiles hide
   * (visibility) so their xterm/WebGL renderers stop painting behind the
   * opaque zoom overlay.
   */
  eagleAnyZoomed?: boolean;
  /** Toggles eagle zoom for a session (owned by MultiProjectView). */
  onEagleZoomToggle?: (sessionId: number) => void;
  /**
   * Total visible (unparked) tiles across ALL projects in eagle view. The
   * move handle must show whenever the global grid has 2+ tiles — the old
   * per-project count hid it in the common 1-terminal-per-project layout.
   */
  eagleTileCount?: number;
  /**
   * Pinned-strip placement for THIS grid's pinned terminals, keyed by session
   * id (owned by MultiProjectView, non-eagle only). A non-empty map puts the
   * grid in "spotlight" mode: it flattens exactly like eagle view
   * (`display: contents`), every tile that is not in the map is hidden, and
   * each listed one is absolutely positioned into the strip under the active
   * project's grid. The active project's own grid never gets one — its pinned
   * terminals are already on screen.
   */
  pinnedTileStyles?: ReadonlyMap<number, React.CSSProperties> | null;
  /** Eagle view: each launched tile's place and size in the grid (session id → rect). */
  eagleTileRects?: ReadonlyMap<number, TileRect>;
  /** Eagle view: rects for this project's pre-launch cards, in card order. */
  eaglePendingRects?: readonly TileRect[];
  /** Eagle view: every placed tile of every project — what a move or resize must not overlap. */
  eagleOccupied?: readonly EagleOccupiedTile[];
  /** Eagle view: a tile was dropped onto another tile (swap) or onto empty grid space. */
  onEagleDrop?: (sessionId: number, target: EagleDropTarget) => void;
  /** Eagle view: Alt+Shift+Arrow — swap a tile with its neighbour in that direction. */
  onEagleMoveTile?: (sessionId: number, direction: MoveDirection) => void;
  /**
   * Eagle view: an edge of a tile is being dragged. `start` is the rect when
   * the drag began, `delta` the cells travelled since, `others` the tiles
   * that were in the grid at that moment.
   */
  onEagleResizeTile?: (
    sessionId: number,
    start: TileRect,
    edge: PaneEdge,
    delta: number,
    others: readonly TileRect[],
  ) => void;
}

/** A placed eagle tile: a launched session, or a pre-launch card (null id). */
export interface EagleOccupiedTile {
  sessionId: number | null;
  rect: TileRect;
}

/**
 * Where an eagle tile was dropped: on another tile's middle (swap), on its
 * outer quarter (beside it, taking half its room), on free grid cells, or on
 * the grid's outer edge (a new full-height column / full-width row).
 */
export type EagleDropTarget =
  | { kind: "swap"; sessionId: number }
  | { kind: "beside"; sessionId: number; side: PaneEdge }
  | { kind: "place"; rect: TileRect }
  | { kind: "edge"; edge: PaneEdge };

/**
 * Manages a dynamic grid of session slots that can be either:
 * - Pre-launch cards (allowing user to configure AI mode and branch before launching)
 * - Active terminal views (connected to a backend PTY session)
 *
 * Lifecycle:
 * - On mount, creates a single empty slot for the user to configure.
 * - User configures AI mode and branch, then clicks "Launch" to spawn a shell.
 * - `addSession` creates new pre-launch slots up to MAX_SESSIONS.
 * - "Launch All" spawns all unlaunched slots with their configured settings.
 * - When all sessions are killed by the user, an auto-respawn effect creates
 *   a fresh slot so the user is never left with an empty grid.
 */
export const TerminalGrid = forwardRef<TerminalGridHandle, TerminalGridProps>(function TerminalGrid(
  {
    projectPath,
    repoPath,
    repositories,
    workspaceType,
    onRepoChange,
    tabId,
    preserveOnHide = false,
    isActive = true,
    onSessionCountChange,
    onAllSessionsClosed,
    focusNameOnMount = false,
    eagleMode = false,
    projectName,
    eagleZoomedSessionId = null,
    eagleAnyZoomed = false,
    onEagleZoomToggle,
    eagleTileCount = 0,
    pinnedTileStyles = null,
    eagleTileRects,
    eaglePendingRects,
    eagleOccupied,
    onEagleDrop,
    onEagleMoveTile,
    onEagleResizeTile,
  },
  ref,
) {
  // Use repoPath for git operations, falling back to projectPath
  const effectiveRepoPath = repoPath ?? projectPath;
  // Identifies this grid's split area in the DOM (pane drags and keyboard moves).
  const stageId = tabId ?? "grid";

  const addSessionToProject = useWorkspaceStore((s) => s.addSessionToProject);
  const removeSessionFromProject = useWorkspaceStore((s) => s.removeSessionFromProject);
  const setZoomTabOrder = useWorkspaceStore((s) => s.setZoomTabOrder);
  // Array reference is stable per tab (only replaced by setZoomTabOrder), so no useShallow needed.
  const zoomTabOrder = useWorkspaceStore((s) => (tabId ? s.zoomTabOrders[tabId] : undefined));
  const worktreeBasePath = useWorkspaceStore((s) =>
    tabId ? (s.tabs.find((t) => t.id === tabId)?.worktreeBasePath ?? null) : null,
  );

  // MCP store - use stable empty array reference to avoid infinite re-render loops
  const mcpServers = useMcpStore((s) =>
    projectPath ? (s.projectServers[projectPath] ?? EMPTY_MCP_SERVERS) : EMPTY_MCP_SERVERS,
  );
  const fetchMcpServers = useMcpStore((s) => s.fetchProjectServers);

  // Plugin store - use stable empty array references
  const skills = usePluginStore((s) =>
    projectPath ? (s.projectSkills[projectPath] ?? EMPTY_SKILLS) : EMPTY_SKILLS,
  );
  const plugins = usePluginStore((s) =>
    projectPath ? (s.projectPlugins[projectPath] ?? EMPTY_PLUGINS) : EMPTY_PLUGINS,
  );
  const fetchPlugins = usePluginStore((s) => s.fetchProjectPlugins);

  // Track session slots (pre-launch and launched)
  const [slots, setSlots] = useState<SessionSlot[]>(() => [createEmptySlot()]);
  const [error, setError] = useState<string | null>(null);

  // Track which terminal slot is focused (by slot ID)
  const [focusedSlotId, setFocusedSlotId] = useState<string | null>(null);

  // Read once: only the mount that the add request caused should take focus.
  const focusNameOnMountRef = useRef(focusNameOnMount);
  const initialSlotIdRef = useRef(slots[0]?.id);
  useEffect(() => {
    const slotId = initialSlotIdRef.current;
    if (focusNameOnMountRef.current && slotId) focusSlotNameInput(slotId);
  }, []);

  // Track which terminal slot is zoomed (takes full screen)
  const [zoomedSlotId, setZoomedSlotId] = useState<string | null>(null);

  // Session name lookup so the zoomed-tab bar can show real names instead of just indices.
  const allSessions = useSessionStore((s) => s.sessions);
  const sessionNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const sess of allSessions) {
      if (sess.name) map.set(sess.id, sess.name);
    }
    return map;
  }, [allSessions]);

  // Parked terminals: hidden from the grid (CSS-only, PTY keeps running).
  // Selector returns the stored array reference; Sets are built in useMemo.
  const parkedSessionIds = useSessionStore((s) => s.parkedSessionIds);
  const parkedSet = useMemo(() => new Set(parkedSessionIds), [parkedSessionIds]);
  const parkedSlotIds = useMemo(
    () =>
      new Set(
        slots.filter((s) => s.sessionId !== null && parkedSet.has(s.sessionId)).map((s) => s.id),
      ),
    [slots, parkedSet],
  );

  // Pinned terminals (see `pinnedSessionIds` in the session store). The set
  // only drives the header's pin button here — WHERE a pinned tile lands is
  // decided by MultiProjectView and arrives as `pinnedTileStyles`.
  const pinnedSessionIds = useSessionStore((s) => s.pinnedSessionIds);
  const pinnedSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds]);

  /**
   * Spotlight: this grid belongs to an inactive project that owns a pinned
   * terminal, so it renders nothing but that terminal, in the pinned strip.
   */
  const pinnedSpotlight = !eagleMode && !!pinnedTileStyles && pinnedTileStyles.size > 0;

  /**
   * "Flat" = the grid gives up its own layout (`display: contents`) and lets an
   * ancestor place the tiles: eagle view tiles them, spotlight absolutely
   * positions them. Everything layout-shaped keys off this; everything that is
   * genuinely about eagle view (project labels aside) keeps using `eagleMode`.
   */
  const flatLayout = eagleMode || pinnedSpotlight;

  // Binary split tree layout (drives pane arrangement)
  const [layoutTree, setLayoutTree] = useState<TreeNode>(() => createLeaf(slots[0].id));

  // Track whether a divider is being dragged (disables xterm pointer events)
  const [isDragging, setIsDragging] = useState(false);

  // Git branch data
  const [branches, setBranches] = useState<BranchWithWorktreeStatus[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(true);
  const [hasManagedWorktree, setHasManagedWorktree] = useState(false);

  // Refs for cleanup
  const slotsRef = useRef<SessionSlot[]>([]);
  const mounted = useRef(false);
  // Track debounce timers for saving branch config (keyed by slot ID)
  const branchConfigSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Ref to access latest onAllSessionsClosed without adding it to callback deps
  const onAllSessionsClosedRef = useRef(onAllSessionsClosed);
  onAllSessionsClosedRef.current = onAllSessionsClosed;
  // Slots configured from consumed pending launches (History tab / samurai
  // successor) whose deferred launch has not fired yet. An array, not a
  // single id: the FIFO pending-launch store can deliver several claims
  // before the first launch fires (fresh-eyes finding B). Also feeds the
  // landing-view guard in handleKill (finding A) — a claimed-but-unlaunched
  // successor must keep this grid mounted.
  const autoLaunchSlotIdsRef = useRef<string[]>([]);
  // Slots whose deferred launch HAS fired but has not yet written a
  // sessionId. `launchSlotInner` only sets sessionId after ~8 awaited IPC
  // round-trips, and the id leaves autoLaunchSlotIdsRef the moment the launch
  // starts — so without this second marker a slot mid-launch looks pristine
  // to the reuse guard below, and a claim arriving in that window would
  // overwrite it and have its own launch silently dropped (the launch
  // early-returns once sessionId is set). Also counts toward the landing-view
  // guard in handleKill: unmounting the grid mid-launch destroys it.
  const launchingSlotIdsRef = useRef<Set<string>>(new Set());

  // Clear a pane's yellow attention highlight (set when it was auto-unparked
  // because its agent asked for input). Called only from USER-driven selection
  // paths — programmatic focus (e.g. the auto-unpark restore itself) must
  // keep the highlight until the user actually looks at the session.
  const clearSlotAttention = useCallback((slotId: string) => {
    const slot = slotsRef.current.find((s) => s.id === slotId);
    if (slot && slot.sessionId !== null) {
      useSessionStore.getState().clearSessionAttention(slot.sessionId);
    }
  }, []);

  // Stable per-slot focus callbacks — avoids creating new arrow functions on every render,
  // which would defeat React.memo on TerminalView.
  const focusCallbacksRef = useRef(new Map<string, () => void>());
  const getFocusCallback = useCallback(
    (slotId: string) => {
      let cb = focusCallbacksRef.current.get(slotId);
      if (!cb) {
        cb = () => {
          // Clicking the pane is the user selecting it — attention is served.
          clearSlotAttention(slotId);
          setFocusedSlotId(slotId);
        };
        focusCallbacksRef.current.set(slotId, cb);
      }
      return cb;
    },
    [clearSlotAttention],
  );

  // Ordered slot IDs from the split tree (defines Cmd+1-9 ordering)
  const orderedSlotIds = useMemo(() => collectSlotIds(layoutTree), [layoutTree]);

  // Zoom tab strip display order: the user-dragged order (store) wins; slots
  // not in the stored order keep tree order (Array.sort is stable). Self-heals:
  // killed slots drop out, newly added slots append in tree order. Only the
  // zoom strip and Alt+Arrow cycling use this — grid layout stays tree-ordered.
  const displaySlotIds = useMemo(() => {
    if (!zoomTabOrder?.length) return orderedSlotIds;
    const rank = new Map(zoomTabOrder.map((id, i) => [id, i]));
    return [...orderedSlotIds].sort(
      (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity),
    );
  }, [orderedSlotIds, zoomTabOrder]);

  // Drag-to-reorder for the zoom tab strip (same dnd-kit setup as ProjectTabs).
  const zoomTabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const handleZoomTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!tabId || !over || active.id === over.id) return;
      const from = displaySlotIds.indexOf(active.id as string);
      const to = displaySlotIds.indexOf(over.id as string);
      if (from === -1 || to === -1) return;
      setZoomTabOrder(tabId, arrayMove(displaySlotIds, from, to));
    },
    [tabId, displaySlotIds, setZoomTabOrder],
  );

  // Compute launched slots in tree order for keyboard navigation.
  // Parked panes are hidden, so Cmd+1-9 and cycling skip them.
  const launchedSlots = useMemo(() => {
    const slotMap = new Map(slots.map((s) => [s.id, s]));
    return orderedSlotIds
      .map((id) => slotMap.get(id))
      .filter(
        (s): s is SessionSlot => s != null && s.sessionId !== null && !parkedSet.has(s.sessionId),
      );
  }, [slots, orderedSlotIds, parkedSet]);

  // Zoom navigation order with parked panes removed — they are unreachable
  // while hidden (the shelf is the only way back).
  const visibleDisplaySlotIds = useMemo(
    () => displaySlotIds.filter((id) => !parkedSlotIds.has(id)),
    [displaySlotIds, parkedSlotIds],
  );

  // Fresh zoom state for close paths that resolve after an async gap (the
  // kill-confirm dialog, the kill IPC): a click-time closure could stomp a
  // zoom requested while the dialog was open. Render-phase sync, same
  // pattern as onAllSessionsClosedRef above — and keeping these out of
  // callback deps stops zoom toggles from invalidating onKill/onRemove
  // (which would defeat React.memo on TerminalView/PreLaunchCard).
  const zoomedSlotIdRef = useRef<string | null>(null);
  zoomedSlotIdRef.current = zoomedSlotId;
  const visibleDisplaySlotIdsRef = useRef<string[]>([]);
  visibleDisplaySlotIdsRef.current = visibleDisplaySlotIds;

  // Map focusedSlotId to an index in launchedSlots
  const focusedIndex = useMemo(() => {
    if (!focusedSlotId) return null;
    const idx = launchedSlots.findIndex((s) => s.id === focusedSlotId);
    return idx >= 0 ? idx : null;
  }, [focusedSlotId, launchedSlots]);

  // Ref-based park callback: handlePark is defined further down the render
  // body (it needs handleKill/removeSlot-adjacent state), so the hook gets a
  // stable closure that dereferences the ref at call time.
  const parkFocusedRef = useRef<() => void>(() => {});

  const zoomedNext = useCallback(() => {
    if (!zoomedSlotId) return;
    const idx = visibleDisplaySlotIds.indexOf(zoomedSlotId);
    if (idx < 0) return;
    const next = visibleDisplaySlotIds[(idx + 1) % visibleDisplaySlotIds.length];
    clearSlotAttention(next);
    setZoomedSlotId(next);
    // Focus follows the zoomed terminal — the zoom view no longer remounts
    // (which used to force focus via a fresh isFocused render).
    setFocusedSlotId(next);
    focusSlotTextarea(next);
  }, [zoomedSlotId, visibleDisplaySlotIds, clearSlotAttention]);

  const zoomedPrev = useCallback(() => {
    if (!zoomedSlotId) return;
    const idx = visibleDisplaySlotIds.indexOf(zoomedSlotId);
    if (idx < 0) return;
    const prev =
      visibleDisplaySlotIds[
        (idx - 1 + visibleDisplaySlotIds.length) % visibleDisplaySlotIds.length
      ];
    clearSlotAttention(prev);
    setZoomedSlotId(prev);
    setFocusedSlotId(prev);
    focusSlotTextarea(prev);
  }, [zoomedSlotId, visibleDisplaySlotIds, clearSlotAttention]);

  // Terminal keyboard navigation hook
  // Same deferred-ref pattern as parkFocusedRef: the move handler is defined
  // further down (it needs handleSwapSlots), so the hook reads it at call time.
  const moveFocusedRef = useRef<(direction: MoveDirection) => void>(() => {});

  /** Tidy up: every pane gets an even share of the layout; the arrangement stays. */
  const handleTidyLayout = useCallback(() => setLayoutTree(equalizeTree), []);

  useTerminalKeyboard({
    terminalCount: launchedSlots.length,
    // While zoomed, focus-cycling follows the zoom-tab order so Cmd/Ctrl+Alt+
    // Arrow never lands on a pane the zoom view is hiding.
    onCycleNext: useCallback(() => {
      if (zoomedSlotId) {
        zoomedNext();
        return;
      }
      if (launchedSlots.length === 0) return;
      const currentIdx = focusedIndex ?? -1;
      const nextIdx = (currentIdx + 1) % launchedSlots.length;
      clearSlotAttention(launchedSlots[nextIdx].id);
      setFocusedSlotId(launchedSlots[nextIdx].id);
    }, [zoomedSlotId, zoomedNext, launchedSlots, focusedIndex, clearSlotAttention]),
    onCyclePrevious: useCallback(() => {
      if (zoomedSlotId) {
        zoomedPrev();
        return;
      }
      if (launchedSlots.length === 0) return;
      const currentIdx = focusedIndex ?? 0;
      const prevIdx = (currentIdx - 1 + launchedSlots.length) % launchedSlots.length;
      clearSlotAttention(launchedSlots[prevIdx].id);
      setFocusedSlotId(launchedSlots[prevIdx].id);
    }, [zoomedSlotId, zoomedPrev, launchedSlots, focusedIndex, clearSlotAttention]),
    // Dereference the ref at call time, not render time: parkFocusedRef.current
    // is reassigned further down the render body, so passing its value here
    // hands the hook the closure from the PREVIOUS render (stale focusedSlotId
    // — Alt+P would park the pane focused one render ago).
    onParkFocused: useCallback(() => parkFocusedRef.current(), []),
    onMoveFocused: useCallback((direction: MoveDirection) => moveFocusedRef.current(direction), []),
    onTidyLayout: handleTidyLayout,
    onToggleZoomFocused: useCallback(() => {
      const targetId = focusedSlotId ?? slotsRef.current[0]?.id;
      if (!targetId) return;
      if (parkedSlotIds.has(targetId)) return; // parked panes can't be zoomed
      setZoomedSlotId((prev) => (prev === targetId ? null : targetId));
    }, [focusedSlotId, parkedSlotIds]),
    onZoomedNext: zoomedNext,
    onZoomedPrev: zoomedPrev,
    // When a terminal is zoomed the tab strip is the navigation UI, so
    // Alt+Left/Right should cycle tabs (handled in capture phase so xterm
    // doesn't swallow them). In normal split-pane mode Alt+Arrow stays as
    // xterm's word-movement.
    isZoomed: zoomedSlotId !== null,
    // Zoom/focus/park shortcuts act on the per-project layout, which is
    // suspended while the global eagle grid is showing.
    enabled: isActive && !eagleMode,
  });

  /**
   * Inserts file paths into a session's terminal input, quoted for the
   * session's shell (cmd.exe on Windows takes double quotes, not POSIX ones).
   * Shared by drag-and-drop and the attach-file button so both take the
   * exact same code path.
   */
  const insertPathsIntoSession = useCallback(
    (sessionId: number, paths: string[], slotId: string) => {
      // Trailing space separates this insertion from whatever comes next —
      // without it two consecutive drops produce adjacent quoted strings
      // ('/a/one.png''/b/two.png') that shells join into one bogus path.
      pathsForTerminalInput(paths)
        .then((quoted) => writeStdin(sessionId, `${quoted} `))
        .catch(console.error);
      // Focus the pane that received the paths so the user can keep typing
      // right after the path. setFocusedSlotId updates the grid's focus ring;
      // the direct DOM focus covers the already-focused pane (no isFocused
      // transition for TerminalView's focus effect to react to).
      setFocusedSlotId(slotId);
      focusSlotTextarea(slotId);
    },
    [],
  );

  /**
   * Opens the native file picker and inserts the chosen paths into the
   * session, reusing the drag-drop insertion path above.
   */
  const handleAttachFiles = useCallback(
    async (sessionId: number, slotId: string) => {
      const selected = await open({ multiple: true, title: "Attach Files" });
      if (!selected) return; // user cancelled
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;
      insertPathsIntoSession(sessionId, paths, slotId);
    },
    [insertPathsIntoSession],
  );

  // Drag-and-drop files from Finder/Explorer onto terminal panes.
  // Only the active project's grid handles window drop events — inactive
  // grids stay mounted (ZStack) and would otherwise swallow the drop.
  // In eagle view every project's panes are visible, so every grid listens;
  // a drop on a foreign pane is ignored (its slot isn't in this grid's map).
  const { dropTargetSlotId, isDraggingFiles } = useTerminalDragDrop({
    slots,
    enabled: isActive || eagleMode,
    onDrop: insertPathsIntoSession,
  });

  // Selected as a number so a park/unpark or a samurai state change re-reports
  // the count without re-rendering the grid on every unrelated store update.
  const occupiedCount = useSessionStore(() => occupiedSlotCount(slots));

  // Sync refs with state and report counts to parent
  useEffect(() => {
    slotsRef.current = slots;
    const launchedCount = slots.filter((s) => s.sessionId !== null).length;
    onSessionCountChange?.(slots.length, launchedCount, occupiedCount);
  }, [slots, onSessionCountChange, occupiedCount]);

  // Refresh branches callback (used by useEffect and exposed via handle)
  const refreshBranches = useCallback(() => {
    if (!effectiveRepoPath) {
      setIsGitRepo(false);
      return;
    }

    setIsLoadingBranches(true);
    getBranchesWithWorktreeStatus(effectiveRepoPath)
      .then((branchList) => {
        setBranches(branchList);
        setIsGitRepo(true);
        setIsLoadingBranches(false);
      })
      .catch((err) => {
        console.error("Failed to fetch branches:", err);
        setIsGitRepo(false);
        setIsLoadingBranches(false);
      });

    invoke<boolean>("has_managed_worktree", { projectPath: effectiveRepoPath })
      .then(setHasManagedWorktree)
      .catch(() => setHasManagedWorktree(false));
  }, [effectiveRepoPath]);

  // Fetch branches when effectiveRepoPath is available
  // Lazy Load: Only fetch project metadata if the tab is active.
  // This prevents background projects from triggering macOS permission prompts on boot.
  useEffect(() => {
    if (!isActive) return;
    refreshBranches();
  }, [refreshBranches, isActive]);

  // Fetch MCP servers and plugins when projectPath is available
  // biome-ignore lint/correctness/useExhaustiveDependencies: isActive is a deliberate extra dep — flipping back to this tab re-runs the fetch so the MCP/plugin lists refresh on re-activation (#88: risky lint fixes get an ignore, never a behavior change)
  useEffect(() => {
    if (!projectPath) return;

    // Fetch MCP servers
    fetchMcpServers(projectPath).catch(console.error);

    // Fetch plugins/skills
    fetchPlugins(projectPath).catch(console.error);
  }, [projectPath, isActive, fetchMcpServers, fetchPlugins]);

  // Update slot enabled MCP servers when servers are fetched.
  // Refill only slots created before the first fetch landed (flag unset AND
  // list still empty) — after that, an empty list is the user's explicit
  // "Unselect All" and refetches must not revert it.
  useEffect(() => {
    if (mcpServers.length > 0) {
      setSlots((prev) =>
        prev.map((slot) => {
          if (!slot.mcpDefaultsApplied && slot.enabledMcpServers.length === 0) {
            return {
              ...slot,
              enabledMcpServers: mcpServers.map((s) => s.name),
              mcpDefaultsApplied: true,
            };
          }
          return slot;
        }),
      );
    }
  }, [mcpServers]);

  // Update slot enabled skills/plugins when they are fetched (same
  // fresh-slot-only rule as the MCP refill above)
  useEffect(() => {
    if (skills.length > 0 || plugins.length > 0) {
      setSlots((prev) =>
        prev.map((slot) => {
          let updated = slot;
          if (!slot.skillsDefaultsApplied && slot.enabledSkills.length === 0 && skills.length > 0) {
            updated = {
              ...updated,
              enabledSkills: skills.map((s) => s.id),
              skillsDefaultsApplied: true,
            };
          }
          if (
            !slot.pluginsDefaultsApplied &&
            slot.enabledPlugins.length === 0 &&
            plugins.length > 0
          ) {
            updated = {
              ...updated,
              enabledPlugins: plugins.filter((p) => p.enabled_by_default).map((p) => p.id),
              pluginsDefaultsApplied: true,
            };
          }
          return updated;
        }),
      );
    }
  }, [skills, plugins]);

  // Mark as mounted after first render
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Clear any pending branch config save timers
      for (const timer of branchConfigSaveTimers.current.values()) {
        clearTimeout(timer);
      }
      branchConfigSaveTimers.current.clear();
      // Kill all launched sessions on unmount (unless preserving)
      if (!preserveOnHide) {
        for (const slot of slotsRef.current) {
          if (slot.sessionId !== null) {
            killSession(slot.sessionId).catch(console.error);
            // Also remove from session store to prevent orphaned entries
            useSessionStore.getState().removeSession(slot.sessionId);
          }
        }
      }
    };
  }, [preserveOnHide]);

  // Latest MCP servers/skills/plugins for the respawn below, read through a ref
  // so a late fetch of any of them cannot re-fire onAllSessionsClosed.
  const slotDefaultsRef = useRef({ mcpServers, skills, plugins });
  slotDefaultsRef.current = { mcpServers, skills, plugins };

  // When all slots are removed: either return to idle landing view or respawn a slot.
  // Keyed on slots.length/error only — the callback and slot defaults come from refs.
  useEffect(() => {
    if (slots.length === 0 && mounted.current && !error) {
      if (onAllSessionsClosedRef.current) {
        onAllSessionsClosedRef.current();
      } else {
        const defaults = slotDefaultsRef.current;
        const freshSlot = createEmptySlot(defaults.mcpServers, defaults.skills, defaults.plugins);
        setSlots([freshSlot]);
        setLayoutTree(createLeaf(freshSlot.id));
      }
    }
  }, [slots.length, error]);

  /**
   * Saves branch config with debouncing.
   * Called when slot config changes (plugins, skills, MCP servers).
   */
  const debouncedSaveBranchConfig = useCallback(
    (slot: SessionSlot) => {
      // Slots are replaced wholesale on update (never mutated in place), so
      // this branch stays valid for the life of this specific slot object —
      // safe to capture now for the callback that fires after the debounce.
      const branch = slot.branch;
      if (!effectiveRepoPath || !branch) return;

      // Clear existing timer for this slot
      const existingTimer = branchConfigSaveTimers.current.get(slot.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new timer
      const timer = setTimeout(() => {
        saveBranchConfig(effectiveRepoPath, branch, {
          enabled_plugins: slot.enabledPlugins,
          enabled_skills: slot.enabledSkills,
          enabled_mcp_servers: slot.enabledMcpServers,
        }).catch((err) => {
          console.error("Failed to save branch config:", err);
        });
        branchConfigSaveTimers.current.delete(slot.id);
      }, 500);

      branchConfigSaveTimers.current.set(slot.id, timer);
    },
    [effectiveRepoPath],
  );

  // Save branch config when slot config changes (debounced)
  // Track previous slots to detect config changes
  const prevSlotsRef = useRef<SessionSlot[]>([]);
  useEffect(() => {
    // Compare each slot's config with previous state
    for (const slot of slots) {
      // Skip slots without a branch (non-worktree sessions)
      if (!slot.branch) continue;
      // Skip already-launched sessions (no need to save pre-launch config)
      if (slot.sessionId !== null) continue;

      const prevSlot = prevSlotsRef.current.find((s) => s.id === slot.id);
      if (!prevSlot) continue; // New slot, no previous state

      // Check if config changed (but not the branch itself - that's handled by updateSlotBranch)
      const configChanged =
        prevSlot.branch === slot.branch && // Same branch
        (JSON.stringify(prevSlot.enabledPlugins) !== JSON.stringify(slot.enabledPlugins) ||
          JSON.stringify(prevSlot.enabledSkills) !== JSON.stringify(slot.enabledSkills) ||
          JSON.stringify(prevSlot.enabledMcpServers) !== JSON.stringify(slot.enabledMcpServers));

      if (configChanged) {
        debouncedSaveBranchConfig(slot);
      }
    }

    prevSlotsRef.current = slots;
  }, [slots, debouncedSaveBranchConfig]);

  const { launchSlot, launchAll } = useSlotLaunch({
    projectPath,
    effectiveRepoPath,
    worktreeBasePath,
    tabId,
    addSessionToProject,
    refreshBranches,
    slotsRef,
    setSlots,
    setError,
  });

  /**
   * Launch from a pre-launch card's button and hand keyboard focus to the new
   * terminal so the user can start typing. Marking the slot focused up front
   * lets the TerminalView grab focus as soon as its xterm mounts, instead of
   * after the whole CLI launch. The trailing focus is only a fallback for when
   * focus is still nowhere (the launch button unmounted under it) — it must
   * not steal focus the user moved elsewhere while the CLI was starting. A
   * failed launch has no xterm textarea, so the fallback is then a no-op.
   */
  const launchSlotAndFocus = useCallback(
    async (slotId: string) => {
      setFocusedSlotId(slotId);
      await launchSlot(slotId);
      const active = document.activeElement;
      if (!active || active === document.body) focusSlotTextarea(slotId);
    },
    [launchSlot],
  );

  /**
   * Closing/removing the zoomed pane keeps the user in zoom-in: the next
   * pane in zoom-strip order takes over the zoom, same as parking/unparking
   * (grid view only when nothing else is left to zoom). Without this the
   * render-phase stale-zoom guard drops the user back to the grid. Returns
   * true when a neighbor took over — zoom AND focus already moved.
   */
  const passZoomToNeighbor = useCallback(
    (slotId: string): boolean => {
      // Read through refs, not the render closure: kill paths call this after
      // an async gap (confirm dialog / kill IPC), and a zoom requested during
      // that gap must not be stomped by click-time state.
      if (zoomedSlotIdRef.current !== slotId) return false;
      const visible = visibleDisplaySlotIdsRef.current;
      const idx = visible.indexOf(slotId);
      const next = visible[(idx + 1) % visible.length];
      // Eagle mode suspends the per-project zoom — clear the stale zoom so
      // leaving eagle view doesn't land on a pane the user never chose.
      if (!eagleMode && next !== undefined && next !== slotId) {
        setZoomedSlotId(next);
        setFocusedSlotId(next);
        focusSlotTextarea(next);
        return true;
      }
      setZoomedSlotId(null);
      return false;
    },
    [eagleMode],
  );

  /**
   * Handles killing/closing a session, updating the slot state.
   * Also cleans up any associated worktree and session-specific MCP config.
   *
   * `opts.keepDirArtifacts` (samurai kills, issue #55) skips every
   * working-directory cleanup — MCP/plugin/hooks config removal and the
   * worktree prompt/delete — because the successor launches into the SAME
   * directory moments later (stable epic worktree, PRD §5.9) and a
   * fire-and-forget remove racing its config writes would strip the hooks
   * the successor depends on.
   */
  const handleKill = useCallback(
    (sessionId: number, opts?: { keepDirArtifacts?: boolean }) => {
      const keepDirArtifacts = opts?.keepDirArtifacts ?? false;
      // Find the slot to get worktree path before removing
      const slot = slotsRef.current.find((s) => s.sessionId === sessionId);
      const worktreePath = slot?.worktreePath;
      // The folder launch wrote config into (the repo folder in a multi-repo project).
      const workingDir = sessionConfigDir(slot, projectPath);

      // If this is the last slot, return to idle landing view immediately —
      // UNLESS a queued/claimed launch is about to land in this grid (samurai
      // successor spawn, issue #55 — fresh-eyes finding A; History-tab resume
      // shares the mechanism). Dropping to the landing view unmounts the grid,
      // which would destroy that launch: a successor whose predecessor was the
      // project's only session would never spawn. In that case fall through to
      // the normal in-place removal and let the pending-launch effects (below)
      // spawn the successor into the surviving grid.
      // Both markers count: a claim that has already STARTED launching left
      // autoLaunchSlotIdsRef, and unmounting the grid under an in-flight launch
      // destroys it just as thoroughly as unmounting under a queued one.
      const launchImminent = successorLaunchImminent(
        usePendingLaunchStore.getState().pending,
        autoLaunchSlotIdsRef.current.length + launchingSlotIdsRef.current.size,
        tabId,
      );
      if (slotsRef.current.length <= 1 && !launchImminent && onAllSessionsClosedRef.current) {
        // Clean up focus callback
        if (slot) {
          focusCallbacksRef.current.delete(slot.id);
        }
        // This branch skips setSlots, so the count-reporting effect never fires
        // with 0 — report it explicitly or the parent keeps stale counts
        // (e.g. the sidebar's "Stop All (1)" with nothing running).
        onSessionCountChange?.(0, 0, 0);
        onAllSessionsClosedRef.current();
      } else {
        // Clean up cached focus callback for this slot
        if (slot) {
          focusCallbacksRef.current.delete(slot.id);

          // Closing the zoomed pane keeps the user in zoom view
          const zoomMoved = passZoomToNeighbor(slot.id);

          // If the closed pane was focused, focus its sibling
          if (!zoomMoved && focusedSlotId === slot.id) {
            const sibling = findSiblingSlotId(layoutTree, slot.id);
            setFocusedSlotId(sibling);
          }

          // Remove leaf from split tree
          setLayoutTree((prev) => {
            const result = removeLeaf(prev, slot.id);
            return result ?? prev;
          });
        }

        setSlots((prev) => prev.filter((s) => s.sessionId !== sessionId));
      }

      // Remove session from the session store
      useSessionStore.getState().removeSession(sessionId);

      // Drop the dead session's activity feed (session ids are never reused,
      // so without this every killed terminal retains up to 500 events —
      // including full subagent prompts — for the app's lifetime).
      useActivityStore.getState().clearSession(sessionId);

      // Unregister session from the project
      if (tabId) {
        removeSessionFromProject(tabId, sessionId);
      }

      // Clean up session-specific MCP config (fire-and-forget)
      if (workingDir && !keepDirArtifacts) {
        if (slot?.mode === "OpenCode") {
          removeOpenCodeMcpConfig(workingDir, sessionId).catch(console.error);
        } else {
          removeSessionMcpConfig(workingDir, sessionId).catch(console.error);
        }
      }

      // Clean up session-specific plugin config (fire-and-forget)
      if (workingDir && !keepDirArtifacts) {
        removeSessionPluginConfig(workingDir).catch(console.error);
      }

      // Clean up session-specific hooks config (fire-and-forget)
      if (workingDir && slot?.mode === "Claude" && !keepDirArtifacts) {
        removeSessionHooksConfig(workingDir).catch(console.error);
      }

      // Clean up worktree based on session close action setting
      if (effectiveRepoPath && worktreePath && !keepDirArtifacts) {
        const closeAction = useWorktreeSettingsStore.getState().worktreeCloseAction;
        if (closeAction === "delete") {
          cleanupSessionWorktree(effectiveRepoPath, worktreePath, worktreeBasePath)
            .then(() => refreshBranches())
            .catch(console.error);
        } else if (closeAction === "ask") {
          ask("Delete the worktree for this session?", {
            title: "Clean Up Worktree",
            kind: "info",
          })
            .then((confirmed) => {
              if (confirmed) {
                cleanupSessionWorktree(effectiveRepoPath, worktreePath, worktreeBasePath)
                  .then(() => refreshBranches())
                  .catch(console.error);
              }
            })
            .catch(console.error);
        }
        // "keep" (default): do nothing — worktree persists
      }
    },
    [
      tabId,
      effectiveRepoPath,
      projectPath,
      removeSessionFromProject,
      refreshBranches,
      focusedSlotId,
      layoutTree,
      onSessionCountChange,
      worktreeBasePath,
      passZoomToNeighbor,
    ],
  );

  /**
   * Removes a pre-launch slot (before it's launched).
   */
  const removeSlot = useCallback(
    (slotId: string) => {
      focusCallbacksRef.current.delete(slotId);

      // If removing the last slot, return to idle landing view immediately
      // rather than going through an intermediate empty state
      if (slotsRef.current.length <= 1 && onAllSessionsClosedRef.current) {
        onSessionCountChange?.(0, 0, 0);
        onAllSessionsClosedRef.current();
        return;
      }

      // Removing the zoomed pre-launch card keeps the user in zoom view
      const zoomMoved = passZoomToNeighbor(slotId);

      // If the removed pane was focused, focus its sibling
      if (!zoomMoved && focusedSlotId === slotId) {
        const sibling = findSiblingSlotId(layoutTree, slotId);
        setFocusedSlotId(sibling);
      }

      // Remove leaf from split tree
      setLayoutTree((prev) => {
        const result = removeLeaf(prev, slotId);
        return result ?? prev;
      });

      setSlots((prev) => prev.filter((s) => s.id !== slotId));
    },
    [focusedSlotId, layoutTree, onSessionCountChange, passZoomToNeighbor],
  );

  /** Kill a session's PTY and clean up its pane. False if this grid doesn't own it. */
  const killSessionById = useCallback(
    (sessionId: number): boolean => {
      const slot = slotsRef.current.find((s) => s.sessionId === sessionId);
      if (!slot) return false;
      // Kill the backend PTY process (fire-and-forget)
      killSession(sessionId).catch(console.error);
      handleKill(sessionId);
      return true;
    },
    [handleKill],
  );

  /** Unpark a session if it is parked — focus/zoom targets must be visible. */
  const unparkIfParked = useCallback((sessionId: number) => {
    const store = useSessionStore.getState();
    if (store.parkedSessionIds.includes(sessionId)) {
      store.unparkSession(sessionId);
    }
  }, []);

  /** Focus the pane running a session. False if this grid doesn't own it. */
  const focusSession = useCallback(
    (sessionId: number): boolean => {
      const slot = slotsRef.current.find((s) => s.sessionId === sessionId);
      if (!slot) return false;
      unparkIfParked(sessionId);
      // Callers are user navigation (terminal navigator, eagle zoom, sidebar) —
      // selecting the session clears its attention highlight.
      useSessionStore.getState().clearSessionAttention(sessionId);
      // Leave zoom if a different pane is zoomed, so the target is visible.
      setZoomedSlotId((prev) => (prev === slot.id ? prev : null));
      setFocusedSlotId(slot.id);
      focusSlotTextarea(slot.id);
      return true;
    },
    [unparkIfParked],
  );

  /** Zoom into the pane running a session (and focus it). False if this grid doesn't own it. */
  const zoomSession = useCallback(
    (sessionId: number): boolean => {
      const slot = slotsRef.current.find((s) => s.sessionId === sessionId);
      if (!slot) return false;
      unparkIfParked(sessionId);
      // User navigation — selecting the session clears its attention highlight.
      useSessionStore.getState().clearSessionAttention(sessionId);
      // Set (not toggle): repeated calls stay zoomed on the same pane, and any
      // other pane's zoom is replaced.
      setZoomedSlotId(slot.id);
      setFocusedSlotId(slot.id);
      focusSlotTextarea(slot.id);
      return true;
    },
    [unparkIfParked],
  );

  /**
   * Parks a launched pane: hides it from the grid (CSS-only — the PTY and
   * xterm instance keep running) and moves zoom/focus off it. Parking the
   * zoomed pane keeps the user in zoom-in: the next pane in zoom-strip order
   * takes over the zoom (grid view only when nothing is left to zoom). Never
   * calls killSession — restoring via the shelf brings the terminal back intact.
   */
  const handlePark = useCallback(
    (slotId: string) => {
      const slot = slotsRef.current.find((s) => s.id === slotId);
      if (!slot || slot.sessionId === null) return;
      useSessionStore.getState().parkSession(slot.sessionId);
      // Parking the zoomed pane: the next pane in zoom-strip order takes over
      // the zoom (helper clears the zoom and falls through when nothing is
      // left to zoom, so the focus fallback below still runs).
      if (passZoomToNeighbor(slotId)) return;
      if (focusedSlotId === slotId) {
        const parked = useSessionStore.getState().parkedSessionIds;
        const fallback = slotsRef.current.find(
          (s) => s.id !== slotId && s.sessionId !== null && !parked.includes(s.sessionId),
        );
        setFocusedSlotId(fallback ? fallback.id : findSiblingSlotId(layoutTree, slotId));
      }
    },
    [focusedSlotId, layoutTree, passZoomToNeighbor],
  );

  /**
   * Restores a parked session's pane into the view the user is in: while a
   * terminal is zoomed the restored one takes over the zoom view (the user
   * stays in zoom-in), otherwise it reappears in the split grid. Focused
   * either way.
   */
  const handleUnpark = useCallback((sessionId: number) => {
    useSessionStore.getState().unparkSession(sessionId);
    const slot = slotsRef.current.find((s) => s.sessionId === sessionId);
    if (!slot) return;
    setZoomedSlotId((prev) => (prev === null ? null : slot.id));
    setFocusedSlotId(slot.id);
    focusSlotTextarea(slot.id);
  }, []);

  // NOTE: auto-unpark (agent asked for input while parked) deliberately does
  // NOT route through handleUnpark. The store's unpark alone restores the
  // pane's visibility (hiding derives from parkedSessionIds); stealing focus
  // or the zoom view at an arbitrary async moment would inject the user's
  // in-flight keystrokes into the restored session's PTY. The yellow
  // attention chrome on the header/tabs/navigator is the notice — the user's
  // own click brings the pane forward and clears it.

  // Keep parkFocusedRef in sync with the latest handlePark/focusedSlotId.
  // Only an explicitly focused, launched pane parks — handlePark ignores
  // pre-launch slots itself.
  parkFocusedRef.current = () => {
    if (!focusedSlotId) return;
    handlePark(focusedSlotId);
  };

  // Eagle view: Cmd/Ctrl+1 and Alt+P act on the pane holding keyboard focus.
  // Only launched panes this grid owns are handled; the rest fall through to
  // the grid that does own them.
  useEagleTerminalKeyboard({
    enabled: eagleMode,
    onToggleZoom: useCallback(
      (slotId: string) => {
        const sessionId = slotsRef.current.find((s) => s.id === slotId)?.sessionId ?? null;
        if (sessionId === null || !onEagleZoomToggle) return false;
        onEagleZoomToggle(sessionId);
        return true;
      },
      [onEagleZoomToggle],
    ),
    onPark: useCallback(
      (slotId: string) => {
        const slot = slotsRef.current.find((s) => s.id === slotId);
        if (!slot || slot.sessionId === null) return false;
        handlePark(slotId);
        return true;
      },
      [handlePark],
    ),
    onMove: useCallback(
      (slotId: string, direction: MoveDirection) => {
        const sessionId = slotsRef.current.find((s) => s.id === slotId)?.sessionId ?? null;
        if (sessionId === null || !onEagleMoveTile) return false;
        onEagleMoveTile(sessionId, direction);
        return true;
      },
      [onEagleMoveTile],
    ),
  });

  /**
   * Updates the AI mode for a slot.
   */
  const updateSlotMode = useCallback((slotId: string, mode: AiMode) => {
    setSlots((prev) =>
      prev.map((s) =>
        s.id === slotId
          ? { ...s, mode, resumeSessionId: mode !== "Claude" ? null : s.resumeSessionId }
          : s,
      ),
    );
  }, []);

  const updateSlotCustomName = useCallback((slotId: string, name: string) => {
    setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, customName: name } : s)));
  }, []);

  const updateSlotResumeSession = useCallback((slotId: string, sessionId: string | null) => {
    setSlots((prev) =>
      prev.map((s) =>
        s.id === slotId
          ? {
              ...s,
              resumeSessionId: sessionId,
              // `claude --resume` only finds the conversation from the
              // transcript's own cwd — any worktree mode would move the
              // shell elsewhere and the resume would silently fail. Same
              // rule the History-tab launch already applies.
              worktreeMode: sessionId ? "project" : s.worktreeMode,
            }
          : s,
      ),
    );
  }, []);

  /**
   * Updates the branch for a slot.
   * When a branch is selected, loads any saved config for that branch.
   */
  const updateSlotBranch = useCallback(
    async (slotId: string, branch: string | null) => {
      // First update the branch
      setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, branch } : s)));

      // If a branch is selected and we have a repo path, try to load saved config
      if (branch && effectiveRepoPath) {
        try {
          const savedConfig = await loadBranchConfig(effectiveRepoPath, branch);
          if (savedConfig) {
            // Apply saved config to the slot
            setSlots((prev) =>
              prev.map((s) => {
                if (s.id !== slotId) return s;
                return {
                  ...s,
                  enabledPlugins: savedConfig.enabled_plugins,
                  enabledSkills: savedConfig.enabled_skills,
                  enabledMcpServers: savedConfig.enabled_mcp_servers,
                };
              }),
            );
          }
        } catch (err) {
          console.error("Failed to load branch config:", err);
          // Non-fatal - continue with current slot config
        }
      }
    },
    [effectiveRepoPath],
  );

  /**
   * Updates the worktree mode for a slot.
   */
  const updateSlotWorktreeMode = useCallback(
    (slotId: string, mode: import("./PreLaunchCard").WorktreeMode) => {
      setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, worktreeMode: mode } : s)));
    },
    [],
  );

  /**
   * Toggles an MCP server for a slot.
   */
  const toggleSlotMcp = useCallback((slotId: string, serverName: string) => {
    setSlots((prev) =>
      prev.map((s) => {
        if (s.id !== slotId) return s;
        const isEnabled = s.enabledMcpServers.includes(serverName);
        const newEnabled = isEnabled
          ? s.enabledMcpServers.filter((n) => n !== serverName)
          : [...s.enabledMcpServers, serverName];
        return { ...s, enabledMcpServers: newEnabled };
      }),
    );
  }, []);

  /**
   * Toggles a skill for a slot.
   */
  const toggleSlotSkill = useCallback((slotId: string, skillId: string) => {
    setSlots((prev) =>
      prev.map((s) => {
        if (s.id !== slotId) return s;
        const isEnabled = s.enabledSkills.includes(skillId);
        const newEnabled = isEnabled
          ? s.enabledSkills.filter((id) => id !== skillId)
          : [...s.enabledSkills, skillId];
        return { ...s, enabledSkills: newEnabled };
      }),
    );
  }, []);

  /**
   * Selects all MCP servers for a slot.
   */
  const selectAllMcp = useCallback(
    (slotId: string) => {
      setSlots((prev) =>
        prev.map((s) => {
          if (s.id !== slotId) return s;
          return { ...s, enabledMcpServers: mcpServers.map((server) => server.name) };
        }),
      );
    },
    [mcpServers],
  );

  /**
   * Unselects all MCP servers for a slot.
   */
  const unselectAllMcp = useCallback((slotId: string) => {
    setSlots((prev) =>
      prev.map((s) => {
        if (s.id !== slotId) return s;
        return { ...s, enabledMcpServers: [] };
      }),
    );
  }, []);

  /**
   * Selects all plugins and skills for a slot.
   */
  const selectAllPlugins = useCallback(
    (slotId: string) => {
      setSlots((prev) =>
        prev.map((s) => {
          if (s.id !== slotId) return s;
          return {
            ...s,
            enabledPlugins: plugins.map((p) => p.id),
            enabledSkills: skills.map((sk) => sk.id),
          };
        }),
      );
    },
    [plugins, skills],
  );

  /**
   * Unselects all plugins and skills for a slot.
   */
  const unselectAllPlugins = useCallback((slotId: string) => {
    setSlots((prev) =>
      prev.map((s) => {
        if (s.id !== slotId) return s;
        return { ...s, enabledPlugins: [], enabledSkills: [] };
      }),
    );
  }, []);

  /**
   * Toggles a plugin for a slot.
   * Also toggles all skills belonging to that plugin.
   */
  const toggleSlotPlugin = useCallback(
    (slotId: string, pluginId: string) => {
      // Find the plugin and its associated skills
      const plugin = plugins.find((p) => p.id === pluginId);
      if (!plugin) return;

      // Helper to extract base name from skill ID
      const getSkillBaseName = (skillId: string): string => {
        const colonIndex = skillId.indexOf(":");
        return colonIndex >= 0 ? skillId.slice(colonIndex + 1) : skillId;
      };

      // Build map of base name -> skill for lookup
      const skillByBaseName = new Map(skills.map((s) => [getSkillBaseName(s.id), s]));

      // Find all skill IDs that belong to this plugin
      const pluginSkillIds: string[] = [];
      for (const skillId of plugin.skills) {
        const baseName = getSkillBaseName(skillId);
        const skill = skillByBaseName.get(baseName);
        if (skill) {
          pluginSkillIds.push(skill.id);
        }
      }

      setSlots((prev) =>
        prev.map((s) => {
          if (s.id !== slotId) return s;
          const isEnabled = s.enabledPlugins.includes(pluginId);

          // Toggle plugin
          const newEnabledPlugins = isEnabled
            ? s.enabledPlugins.filter((id) => id !== pluginId)
            : [...s.enabledPlugins, pluginId];

          // Toggle all associated skills
          let newEnabledSkills: string[];
          if (isEnabled) {
            // Disabling plugin - remove all its skills
            newEnabledSkills = s.enabledSkills.filter((id) => !pluginSkillIds.includes(id));
          } else {
            // Enabling plugin - add all its skills (avoid duplicates)
            const skillsToAdd = pluginSkillIds.filter((id) => !s.enabledSkills.includes(id));
            newEnabledSkills = [...s.enabledSkills, ...skillsToAdd];
          }

          return { ...s, enabledPlugins: newEnabledPlugins, enabledSkills: newEnabledSkills };
        }),
      );
    },
    [plugins, skills],
  );

  /**
   * Creates a new branch and optionally checks it out.
   * Passed to PreLaunchCard for inline branch creation.
   */
  const handleCreateBranch = useCallback(
    async (name: string, andCheckout: boolean, repoPath?: string) => {
      const targetRepo = repoPath ?? effectiveRepoPath;
      if (!targetRepo) return;
      await invoke("git_create_branch", {
        repoPath: targetRepo,
        branchName: name,
        startPoint: null,
      });
      if (andCheckout) {
        await invoke("git_checkout_branch", {
          repoPath: targetRepo,
          branchName: name,
        });
        // HEAD moved, so the shared branch TTL cache is stale — drop it or the
        // terminal headers keep showing the previous branch for up to 10 s.
        invalidateCurrentBranchCache(targetRepo);
      }
      refreshBranches();
    },
    [effectiveRepoPath, refreshBranches],
  );

  /**
   * Adds a new pre-launch slot to the grid.
   */
  const addSession = useCallback(() => {
    if (occupiedSlotCount(slotsRef.current) >= MAX_SESSIONS) return;
    const newSlot = createEmptySlot(mcpServers, skills, plugins);
    setSlots((prev) => {
      if (occupiedSlotCount(prev) >= MAX_SESSIONS) return prev;
      return [...prev, newSlot];
    });
    // Rebuild layout as a clean 2D grid (matching old CSS grid dimensions)
    setLayoutTree(() => buildGridTree([...orderedSlotIds, newSlot.id]));
    setFocusedSlotId(newSlot.id);
    focusSlotNameInput(newSlot.id);
    // Stay in zoom-in view: the new pre-launch card takes over the zoom as
    // the last tab in the strip (mirrors handleUnpark's behavior).
    setZoomedSlotId((prev) => (prev === null ? null : newSlot.id));
    // Refresh branch list so new slots see the latest branches
    refreshBranches();
  }, [mcpServers, skills, plugins, refreshBranches, orderedSlotIds]);

  useImperativeHandle(
    ref,
    () => ({
      addSession,
      launchAll,
      refreshBranches,
      focusSession,
      zoomSession,
      killSessionById,
      isZoomed: () => zoomedSlotId !== null,
      tidyLayout: handleTidyLayout,
    }),
    [
      addSession,
      launchAll,
      refreshBranches,
      focusSession,
      zoomSession,
      killSessionById,
      zoomedSlotId,
      handleTidyLayout,
    ],
  );

  // History-tab / samurai-successor launches: consume the pending-launch
  // store and launch each claimed slot once it has committed to state.
  usePendingLaunch({
    tabId,
    slots,
    slotsRef,
    autoLaunchSlotIdsRef,
    launchingSlotIdsRef,
    mcpServers,
    skills,
    plugins,
    orderedSlotIds,
    launchSlot,
    setSlots,
    setLayoutTree,
    setFocusedSlotId,
    setError,
  });

  // Deliberately called AFTER usePendingLaunch (fresh-eyes finding A):
  // effects run in definition order, so when a KILLED update and the
  // successor's queued launch land in the same commit, the consume effect
  // claims and appends the successor slot first.
  useSamuraiAutoPark({ slotsRef, parkedSet, handlePark, handleKill });

  // Handle zoom toggle for a slot
  const handleToggleZoom = useCallback(
    (slotId: string) => {
      const zoomingIn = zoomedSlotId !== slotId;
      setZoomedSlotId(zoomingIn ? slotId : null);
      if (zoomingIn) {
        // Zooming in is the user selecting the pane — clear its attention
        // highlight and focus it (parity with the old dedicated zoom render,
        // which hardcoded isFocused).
        clearSlotAttention(slotId);
        setFocusedSlotId(slotId);
        focusSlotTextarea(slotId);
      }
    },
    [zoomedSlotId, clearSlotAttention],
  );

  // Esc deliberately does NOT exit zoom: the focused terminal needs it
  // (e.g. interrupting Claude). Exit via the header button or Cmd/Ctrl+1.

  /** Swap the contents of two leaves so the user can rearrange panes. */
  const handleSwapSlots = useCallback(
    (srcSlotId: string, destSlotId: string) => {
      if (!srcSlotId || !destSlotId || srcSlotId === destSlotId) return;
      setLayoutTree((prev) => swapSlots(prev, srcSlotId, destSlotId));
      // SplitPaneView may reorder the keyed pane hosts in the DOM to match the
      // new traversal order, which blurs a focused terminal — restore it.
      if (focusedSlotId) focusSlotTextarea(focusedSlotId);
    },
    [focusedSlotId],
  );

  /**
   * Drop a pane on the edge of another: the moved pane leaves its place and
   * takes half of the target's room on that side.
   */
  const handleMoveSlotToSide = useCallback(
    (srcSlotId: string, destSlotId: string, side: PaneSide) => {
      if (!srcSlotId || !destSlotId || srcSlotId === destSlotId) return;
      setLayoutTree((prev) => moveSlotToSide(prev, srcSlotId, destSlotId, side));
      focusSlotTextarea(srcSlotId);
    },
    [],
  );

  /** Drop a pane on the split area's outer edge: it becomes a full column/row. */
  const handleMoveSlotToStageEdge = useCallback((srcSlotId: string, side: PaneSide) => {
    setLayoutTree((prev) => moveSlotToTreeEdge(prev, srcSlotId, side, STAGE_EDGE_RATIO));
    focusSlotTextarea(srcSlotId);
  }, []);

  /**
   * Alt+Shift+Arrow: swap the focused pane with its nearest neighbour in that
   * direction (measured on screen, so it follows whatever shape the layout has).
   */
  const handleMoveFocusedPane = useCallback(
    (direction: MoveDirection) => {
      if (!focusedSlotId || zoomedSlotId !== null) return;
      const stage = document.querySelector<HTMLElement>(`[data-split-stage="${stageId}"]`);
      const self = stage?.querySelector<HTMLElement>(`[data-slot-id="${focusedSlotId}"]`);
      if (!stage || !self) return;
      const others: { id: string; rect: DOMRect }[] = [];
      for (const el of stage.querySelectorAll<HTMLElement>("[data-slot-id]")) {
        const id = el.dataset.slotId;
        if (!id || id === focusedSlotId) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue; // parked (hidden) panes
        others.push({ id, rect });
      }
      const dest = neighbourInDirection(self.getBoundingClientRect(), others, direction);
      if (dest) handleSwapSlots(focusedSlotId, dest);
    },
    [focusedSlotId, zoomedSlotId, stageId, handleSwapSlots],
  );
  moveFocusedRef.current = handleMoveFocusedPane;

  // Stable per-project accent color for eagle mode tiles (clash-resolved
  // against the other open projects).
  const projectColors = useProjectColors();
  const eagleColor = useMemo(
    () =>
      projectName ? (projectColors.get(projectName) ?? projectColorFor(projectName)) : undefined,
    [projectName, projectColors],
  );

  const renderLeaf = useCallback(
    (slotId: string) => {
      const slot = slots.find((s) => s.id === slotId);
      if (!slot) return null;

      const dropOverlay = isDraggingFiles &&
        dropTargetSlotId === slot.id &&
        slot.sessionId !== null && (
          <div className="drop-zone-overlay">
            <span>Drop to paste path</span>
          </div>
        );

      // Eagle counts tiles across ALL projects (eagleTileCount) — the common
      // 1-terminal-per-project layout must still be reorderable; while
      // eagle-zoomed all other tiles are visibility:hidden, so handles are moot.
      // Same while per-project zoomed: only the zoomed pane is visible.
      const showReorderHandle = pinnedSpotlight
        ? false
        : eagleMode
          ? eagleTileCount > 1 && !eagleAnyZoomed
          : slots.length > 1 && zoomedSlotId === null;
      const isEagleZoomed =
        eagleMode && slot.sessionId !== null && eagleZoomedSessionId === slot.sessionId;
      const isEagleObscured = eagleMode && eagleAnyZoomed && !isEagleZoomed;
      const isSlotZoomed = eagleMode ? isEagleZoomed : !pinnedSpotlight && zoomedSlotId === slot.id;
      // Spotlight: only the pinned tiles paint, each into its strip cell.
      const pinnedStyle =
        pinnedSpotlight && slot.sessionId !== null
          ? (pinnedTileStyles?.get(slot.sessionId) ?? null)
          : null;
      const spotlightHidden = pinnedSpotlight && pinnedStyle === null;

      if (slot.sessionId !== null) {
        // TS narrowing on slot.sessionId doesn't survive into the closure below.
        const sessionId = slot.sessionId;
        return (
          <DraggablePane
            slotId={slot.id}
            gridId={tabId}
            sessionId={sessionId}
            projectName={projectName}
            showHandle={showReorderHandle}
            onSwap={handleSwapSlots}
            onMoveToSide={handleMoveSlotToSide}
            onMoveToStageEdge={handleMoveSlotToStageEdge}
            onEagleDrop={onEagleDrop}
            onEagleResize={onEagleResizeTile}
            eagleRect={eagleMode ? eagleTileRects?.get(sessionId) : undefined}
            eagleOccupied={eagleMode ? eagleOccupied : undefined}
            eagleMode={flatLayout}
            eagleHidden={spotlightHidden}
            eagleZoomed={isEagleZoomed}
            eagleObscured={isEagleObscured}
            eagleReserveShelf={parkedSessionIds.length > 0}
            pinnedStyle={pinnedStyle}
          >
            <TerminalView
              key={slot.id}
              sessionId={slot.sessionId}
              isFocused={focusedSlotId === slot.id}
              isActive={isActive}
              onFocus={getFocusCallback(slot.id)}
              onKill={handleKill}
              terminalCount={slots.length}
              isZoomed={isSlotZoomed}
              onToggleZoom={
                pinnedSpotlight
                  ? undefined
                  : () => (eagleMode ? onEagleZoomToggle?.(sessionId) : handleToggleZoom(slot.id))
              }
              onPark={() => handlePark(slot.id)}
              // The pin is offered where the terminal is big enough to act on:
              // zoomed in, in eagle view, or already pinned (so the strip tile
              // carries its own way back out).
              isPinned={pinnedSet.has(sessionId)}
              onTogglePin={
                eagleMode || isSlotZoomed || pinnedSet.has(sessionId)
                  ? () => useSessionStore.getState().toggleSessionPin(sessionId)
                  : undefined
              }
              onAttachFiles={() => {
                handleAttachFiles(sessionId, slot.id).catch(console.error);
              }}
              // The color is always on: a terminal's border tells you which
              // project it belongs to in every view, not just eagle. The written
              // label stays eagle-only — inside a single project's grid every
              // tile would repeat the same name.
              projectLabel={flatLayout ? projectName : undefined}
              projectColor={eagleColor}
              hasMoveHandle={showReorderHandle}
              showShortcutHints={!pinnedSpotlight}
            />
            {dropOverlay}
          </DraggablePane>
        );
      }

      return (
        <DraggablePane
          slotId={slot.id}
          gridId={tabId}
          // A card has no session yet, so it cannot be moved or resized in the
          // eagle grid; MultiProjectView hands this project one rect per card.
          showHandle={showReorderHandle && !eagleMode}
          onSwap={handleSwapSlots}
          onMoveToSide={handleMoveSlotToSide}
          onMoveToStageEdge={handleMoveSlotToStageEdge}
          eagleRect={
            eagleMode
              ? eaglePendingRects?.[
                  slots.filter((s) => s.sessionId === null).findIndex((s) => s.id === slot.id)
                ]
              : undefined
          }
          eagleMode={flatLayout}
          eagleHidden={spotlightHidden}
          eagleZoomed={false}
          eagleObscured={isEagleObscured}
          eagleReserveShelf={parkedSessionIds.length > 0}
        >
          <PreLaunchCard
            key={slot.id}
            slot={slot}
            projectPath={projectPath ?? ""}
            branches={branches}
            isLoadingBranches={isLoadingBranches}
            isGitRepo={isGitRepo}
            repositories={repositories}
            workspaceType={workspaceType}
            selectedRepoPath={effectiveRepoPath}
            onRepoChange={onRepoChange}
            fetchBranchesForRepo={getBranchesWithWorktreeStatus}
            mcpServers={mcpServers}
            skills={skills}
            plugins={plugins}
            hasManagedWorktree={hasManagedWorktree}
            onCreateBranch={handleCreateBranch}
            onCustomNameChange={(name) => updateSlotCustomName(slot.id, name)}
            onModeChange={(mode) => updateSlotMode(slot.id, mode)}
            onBranchChange={(branch) => updateSlotBranch(slot.id, branch)}
            onWorktreeModeChange={(mode) => updateSlotWorktreeMode(slot.id, mode)}
            onRefreshBranches={refreshBranches}
            onMcpToggle={(serverName) => toggleSlotMcp(slot.id, serverName)}
            onSkillToggle={(skillId) => toggleSlotSkill(slot.id, skillId)}
            onPluginToggle={(pluginId) => toggleSlotPlugin(slot.id, pluginId)}
            onMcpSelectAll={() => selectAllMcp(slot.id)}
            onMcpUnselectAll={() => unselectAllMcp(slot.id)}
            onPluginsSelectAll={() => selectAllPlugins(slot.id)}
            onPluginsUnselectAll={() => unselectAllPlugins(slot.id)}
            onLaunch={() => launchSlotAndFocus(slot.id)}
            onRemove={() => removeSlot(slot.id)}
            onResumeSessionChange={(sessionId) => updateSlotResumeSession(slot.id, sessionId)}
            isZoomed={isSlotZoomed}
            onToggleZoom={() => handleToggleZoom(slot.id)}
            showShortcutHints={!flatLayout}
          />
        </DraggablePane>
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Deps cover all render-affecting state
    },
    [
      slots,
      focusedSlotId,
      isActive,
      isDraggingFiles,
      dropTargetSlotId,
      getFocusCallback,
      handleKill,
      handleToggleZoom,
      handlePark,
      handleAttachFiles,
      handleSwapSlots,
      handleMoveSlotToSide,
      handleMoveSlotToStageEdge,
      onEagleDrop,
      onEagleResizeTile,
      eagleTileRects,
      eaglePendingRects,
      eagleOccupied,
      projectPath,
      branches,
      isLoadingBranches,
      isGitRepo,
      hasManagedWorktree,
      repositories,
      workspaceType,
      effectiveRepoPath,
      onRepoChange,
      mcpServers,
      skills,
      plugins,
      handleCreateBranch,
      updateSlotCustomName,
      updateSlotMode,
      updateSlotBranch,
      updateSlotWorktreeMode,
      refreshBranches,
      toggleSlotMcp,
      toggleSlotSkill,
      toggleSlotPlugin,
      selectAllMcp,
      unselectAllMcp,
      selectAllPlugins,
      unselectAllPlugins,
      launchSlotAndFocus,
      removeSlot,
      updateSlotResumeSession,
      eagleMode,
      eagleZoomedSessionId,
      eagleAnyZoomed,
      onEagleZoomToggle,
      projectName,
      eagleColor,
      tabId,
      eagleTileCount,
      parkedSessionIds,
      zoomedSlotId,
      pinnedSpotlight,
      pinnedTileStyles,
      pinnedSet,
      flatLayout,
    ],
  );

  const handleRatioChange = useCallback((nodeId: string, ratio: number) => {
    setLayoutTree((prev) => updateRatio(prev, nodeId, ratio));
  }, []);

  // A launch failure must not unmount a grid with live sessions: every
  // unmounted xterm loses its scrollback, and the full-screen card's Retry
  // (which resets to a single fresh slot) would orphan the running PTYs.
  // The card is reserved for grids with nothing running; otherwise the error
  // renders as a dismissible toast over the intact grid (see main return).
  const hasLiveSessions = slots.some((s) => s.sessionId !== null);
  if (error && !hasLiveSessions) {
    return (
      // In eagle mode this renders as a labeled tile of the global grid
      // (the wrapper above is display:contents), not an anonymous full-flex div.
      <div
        className="flex h-full flex-col items-center justify-center gap-3 text-maestro-muted rounded-md"
        style={eagleMode && eagleColor ? { border: `2px solid ${eagleColor}` } : undefined}
      >
        {eagleMode && projectName && (
          <span className="text-xs font-bold" style={{ color: eagleColor }}>
            {projectName}
          </span>
        )}
        <span className="text-sm text-maestro-red">{error}</span>
        <button
          type="button"
          onClick={() => {
            setError(null);
            const freshSlot = createEmptySlot();
            setSlots([freshSlot]);
            setLayoutTree(createLeaf(freshSlot.id));
          }}
          className="rounded bg-maestro-border px-3 py-1.5 text-xs text-maestro-text hover:bg-maestro-muted/20"
        >
          Retry
        </button>
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center text-maestro-muted text-sm rounded-md"
        style={eagleMode && eagleColor ? { border: `2px solid ${eagleColor}` } : undefined}
      >
        Initializing...
      </div>
    );
  }

  // Stale-zoom guard: if the zoomed slot disappeared (killed/removed), drop
  // the zoom. Render-phase state reset — React re-renders immediately.
  if (zoomedSlotId && !eagleMode && !slots.some((s) => s.id === zoomedSlotId)) {
    setZoomedSlotId(null);
  }
  // Per-project zoom is CSS-only: the SAME element tree renders in both
  // states (SplitPaneView overlays the zoomed host and hides the others), so
  // zooming in/out never remounts an xterm. Only the navigation strip mounts
  // and unmounts — it holds no terminal state.
  const zoomActive =
    !flatLayout && zoomedSlotId !== null && slots.some((s) => s.id === zoomedSlotId);

  // Both wrappers exist in BOTH modes (display:contents in eagle) so toggling
  // eagle view never changes the element tree shape — a structural difference
  // would remount every xterm and lose all scrollback. The shelf only ever
  // appends/removes as a trailing sibling, which leaves the split tree alone.
  const allParked =
    !flatLayout && slots.every((s) => s.sessionId !== null && parkedSet.has(s.sessionId));
  return (
    <div
      className={
        flatLayout
          ? "contents"
          : `flex h-full flex-col bg-maestro-bg ${zoomActive ? "" : "p-2"} ${isDragging ? "split-dragging" : ""}`
      }
    >
      {zoomActive &&
        (() => {
          // zoomActive's own definition already guarantees this, but narrowing
          // doesn't survive through it into this closure — check directly.
          if (zoomedSlotId === null) return null;
          const orderedSlots = visibleDisplaySlotIds
            .map((id) => slots.find((s) => s.id === id))
            .filter(Boolean) as SessionSlot[];
          const zoomedIndex = orderedSlots.findIndex((s) => s.id === zoomedSlotId);
          return (
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-maestro-border bg-maestro-surface px-3">
              <button
                type="button"
                onClick={handleTidyLayout}
                className="rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
                title={titleWithShortcut(
                  "Tidy up: give every terminal an even share of the screen",
                  altLabel(),
                  "T",
                )}
                aria-label="Tidy up terminals"
              >
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span className="text-[11px] font-medium uppercase tracking-wider text-maestro-muted">
                Terminal {zoomedIndex + 1}/{orderedSlots.length}
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
                  sensors={zoomTabSensors}
                  collisionDetection={closestCenter}
                  modifiers={[restrictToHorizontalAxis]}
                  onDragEnd={handleZoomTabDragEnd}
                >
                  <SortableContext
                    items={orderedSlots.map((s) => s.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    {orderedSlots.map((slot, index) => {
                      const isTabActive = slot.id === zoomedSlotId;
                      // Slots are replaced wholesale on update (never mutated in place),
                      // so this stays valid for the onToggleFlag closure below.
                      const sessionId = slot.sessionId;
                      const liveName =
                        sessionId !== null ? sessionNameById.get(sessionId) : undefined;
                      // A pre-launch slot has no session id yet, so it keeps its strip position.
                      const label =
                        sessionId !== null
                          ? sessionDisplayName({
                              id: sessionId,
                              name: liveName?.trim() || slot.customName,
                            })
                          : slot.customName.trim() || `Terminal ${index + 1}`;

                      return (
                        <ZoomTab
                          key={slot.id}
                          slotId={slot.id}
                          index={index}
                          isActive={isTabActive}
                          label={label}
                          hasSession={sessionId !== null}
                          sessionId={sessionId}
                          onSelect={() => handleToggleZoom(slot.id)}
                          onToggleFlag={
                            sessionId !== null
                              ? () => useSessionStore.getState().toggleSessionFlag(sessionId)
                              : undefined
                          }
                        />
                      );
                    })}
                  </SortableContext>
                </DndContext>
              </div>
              <button
                type="button"
                onClick={() => handleToggleZoom(zoomedSlotId)}
                className="rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
                title={titleWithShortcut("Exit zoom", modLabel(), "1")}
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
      <div
        className={
          flatLayout ? "contents" : `relative flex min-h-0 flex-1 ${zoomActive ? "p-2" : ""}`
        }
      >
        <SplitPaneView
          node={layoutTree}
          renderLeaf={renderLeaf}
          onRatioChange={handleRatioChange}
          onDragStateChange={setIsDragging}
          eagleMode={flatLayout}
          hiddenSlotIds={parkedSlotIds}
          zoomedSlotId={zoomActive ? zoomedSlotId : null}
          stageId={stageId}
        />
        {allParked && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-maestro-muted">
            All terminals parked — click a chip below to restore
          </div>
        )}
      </div>
      {/* Parked terminals stay reachable from the zoom-in view too (unpark
          makes the restored terminal the zoomed one — the user stays in zoom) */}
      {!flatLayout && <ParkedShelf projectPath={projectPath} onUnpark={handleUnpark} />}
      {/* Launch errors while sessions run: fixed-position toast (works under
          the eagle display:contents wrapper too) instead of the full-screen
          card, so the running terminals stay mounted. */}
      {error && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-md border border-maestro-border bg-maestro-surface px-3 py-2 shadow-lg">
          <span className="text-sm text-maestro-red">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded bg-maestro-border px-2 py-1 text-xs text-maestro-text hover:bg-maestro-muted/20"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
});

/** Pointer travel before a title-bar press turns into a drag (a plain click stays a click). */
const DRAG_START_PX = 4;

/** What the drop-zone overlay says for each zone. */
const DROP_ZONE_LABELS: Record<PaneDropZone, string> = {
  swap: "Swap",
  left: "Move here (left half)",
  right: "Move here (right half)",
  top: "Move here (top half)",
  bottom: "Move here (bottom half)",
};

/** Where a dragged pane would land right now. */
type DropTarget =
  | {
      kind: "pane";
      el: HTMLElement;
      slotId: string;
      sessionId: number | null;
      zone: PaneDropZone;
    }
  | { kind: "stage"; edge: PaneSide }
  | { kind: "cell"; rect: TileRect }
  /** Eagle view: the grid's outer edge; `rect` is the column/row the tile would take. */
  | { kind: "gridEdge"; edge: PaneEdge; rect: TileRect };

/** The eagle grid's content box in CSS px (its padding excluded), or null outside eagle view. */
function eagleGridBox(): {
  el: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
} | null {
  const el = document.querySelector<HTMLElement>("[data-eagle-grid]");
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const padX = Number.parseFloat(style.paddingLeft) || 0;
  const padY = Number.parseFloat(style.paddingTop) || 0;
  return {
    el,
    left: rect.left + padX,
    top: rect.top + padY,
    width: rect.width - 2 * padX,
    height: rect.height - 2 * padY,
  };
}

/** The four edges of an eagle tile a resize can grab, and where each handle sits. */
const EAGLE_RESIZE_EDGES: readonly { edge: PaneEdge; className: string }[] = [
  { edge: "left", className: "left-0 top-2 bottom-2 w-1.5 cursor-col-resize" },
  { edge: "right", className: "right-0 top-2 bottom-2 w-1.5 cursor-col-resize" },
  { edge: "top", className: "top-0 left-2 right-2 h-1.5 cursor-row-resize" },
  { edge: "bottom", className: "bottom-0 left-2 right-2 h-1.5 cursor-row-resize" },
];

/**
 * Wraps a terminal pane in a relative container that supports drag-to-move.
 *
 * Pick a pane up by its title bar (any part that is not a button) or by the
 * grip in the corner, and drop it:
 * - split layout: on the outer quarter of another pane to move next to it
 *   (it takes half that pane's room), on the middle to swap, or on the outer
 *   edge of the whole split area to become a full column/row;
 * - eagle view: on the outer quarter of another tile to move beside it
 *   (taking half its cells), on the middle to swap, on free cells to move
 *   there, or on the outer edge of the grid to become a full column/row.
 *
 * Uses pointer events (mousedown/move/up) instead of HTML5 DnD because
 * Tauri's WebView2 keeps showing the "no drop" cursor when custom MIME
 * types aren't surfaced in `dataTransfer.types` during dragover. Pointer
 * events are also lighter — no drag image, no system cursor switching —
 * and let us use `document.elementFromPoint` to find the destination pane.
 * The hover highlight is written straight into the hovered pane's DOM
 * (`data-drop-zone` + the overlay every pane renders) — React state would
 * re-render every grid on each pointer tick.
 *
 * `min-h-0 min-w-0` keep the flex/overflow chain working so children with
 * `overflow-y-auto` (e.g. PreLaunchCard) can shrink past their intrinsic
 * content size and become scrollable.
 */
function DraggablePane({
  slotId,
  gridId,
  sessionId = null,
  projectName,
  showHandle,
  onSwap,
  onMoveToSide,
  onMoveToStageEdge,
  onEagleDrop,
  onEagleResize,
  children,
  eagleMode = false,
  eagleHidden = false,
  eagleZoomed = false,
  eagleObscured = false,
  eagleReserveShelf = false,
  pinnedStyle = null,
  eagleRect,
  eagleOccupied,
}: {
  slotId: string;
  /** Owning grid (tab) id — identifies the source project for eagle drops. */
  gridId?: string;
  /** Launched session in this pane (null for a pre-launch card). */
  sessionId?: number | null;
  /** Project name for the drag label. */
  projectName?: string;
  showHandle: boolean;
  onSwap: (srcSlotId: string, destSlotId: string) => void;
  /** Split layout: pane dropped on the edge of another pane. */
  onMoveToSide: (srcSlotId: string, destSlotId: string, side: PaneSide) => void;
  /** Split layout: pane dropped on the outer edge of the split area. */
  onMoveToStageEdge: (srcSlotId: string, side: PaneSide) => void;
  /** Eagle view: tile dropped onto another tile (swap) or onto free grid cells. */
  onEagleDrop?: (sessionId: number, target: EagleDropTarget) => void;
  /** Eagle view: an edge of this tile is being dragged (see TerminalGridProps). */
  onEagleResize?: (
    sessionId: number,
    start: TileRect,
    edge: PaneEdge,
    delta: number,
    others: readonly TileRect[],
  ) => void;
  children: ReactNode;
  /** Eagle view: this pane is a tile of the global all-projects grid. */
  eagleMode?: boolean;
  /**
   * Pane is excluded from layout entirely (`display:none`). Set in pinned
   * spotlight mode on every non-pinned pane of an inactive project, so only its
   * pinned terminals paint.
   */
  eagleHidden?: boolean;
  /** Eagle view: pane is zoomed to fill the main content area (position: absolute). */
  eagleZoomed?: boolean;
  /** Eagle view: another pane is zoomed — stop painting under its overlay. */
  eagleObscured?: boolean;
  /** Eagle view while zoomed: leave room for the parked shelf (h-8) below. */
  eagleReserveShelf?: boolean;
  /**
   * Pinned strip: absolute placement for this tile, computed by
   * MultiProjectView. Set only in spotlight mode, and it wins over the eagle
   * tile class — the tile is positioned against the content area, not tiled.
   */
  pinnedStyle?: React.CSSProperties | null;
  /** Eagle view: this tile's place and size in the grid. Undefined = not placed yet (hidden). */
  eagleRect?: TileRect;
  /** Eagle view: every placed tile — the collision set for a move or resize of this one. */
  eagleOccupied?: readonly EagleOccupiedTile[];
}) {
  const [isDragging, setIsDragging] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  /**
   * Runs one drag from the given pointer position. `immediate` starts it on
   * the spot (the grip); otherwise it starts once the pointer has travelled
   * DRAG_START_PX, so a plain click on the title bar is still a click.
   */
  const runDrag = useCallback(
    (startX: number, startY: number, immediate: boolean) => {
      // The split area (non-eagle): drops on its outer edge make a full column/row.
      const stage =
        !eagleMode && gridId
          ? document.querySelector<HTMLElement>(`[data-split-stage="${gridId}"]`)
          : null;
      // Eagle view: the grid box turns pointer positions into cells, and the
      // tiles already placed are what a drop on free cells must not overlap.
      const grid = eagleMode ? eagleGridBox() : null;
      const eagleOthers =
        eagleMode && eagleOccupied
          ? eagleOccupied.filter((o) => o.sessionId !== sessionId).map((o) => o.rect)
          : [];
      // The launched tiles by id — what a drop beside a tile or on the grid's
      // edge rearranges (pre-launch cards have no stored rect and re-pack).
      const eagleTiles = new Map<number, TileRect>();
      if (eagleMode && eagleOccupied) {
        for (const o of eagleOccupied)
          if (o.sessionId !== null) eagleTiles.set(o.sessionId, o.rect);
      }
      let active = false;
      let ghost: HTMLDivElement | null = null;
      let stageHighlight: HTMLDivElement | null = null;
      let cellHighlight: HTMLDivElement | null = null;
      let hovered: HTMLElement | null = null;

      const begin = () => {
        active = true;
        setIsDragging(true);
        document.body.classList.add("pane-dragging");
        wrapperRef.current?.classList.add("pane-drag-source");
        ghost = document.createElement("div");
        ghost.className = "pane-drag-ghost";
        const name =
          sessionId !== null
            ? useSessionStore
                .getState()
                .sessions.find((sess) => sess.id === sessionId)
                ?.name?.trim()
            : undefined;
        ghost.textContent = `${projectName ? `${projectName} · ` : ""}${name || "Terminal"}`;
        ghost.style.left = `${startX + 14}px`;
        ghost.style.top = `${startY + 10}px`;
        document.body.appendChild(ghost);
      };

      const findTarget = (x: number, y: number): DropTarget | null => {
        if (stage) {
          const edge = stageEdgeAt(stage.getBoundingClientRect(), x, y);
          if (edge) return { kind: "stage", edge };
        }
        const elem = document.elementFromPoint(x, y) as HTMLElement | null;
        const el = elem?.closest<HTMLElement>("[data-slot-id]") ?? null;
        if (eagleMode) {
          // Only launched tiles move in eagle view: a pre-launch card has no
          // stored rect, so it gets no drop highlight either.
          if (sessionId === null) return null;
          // The grid's outer edge: the tile becomes a full column/row there
          // and the other tiles make room — when they all stay big enough.
          // An edge that cannot make room is a dead zone, not a swap.
          if (grid) {
            const edge = stageEdgeAt(grid, x, y);
            if (edge) {
              const rect = insertColumnAtEdge(eagleTiles, sessionId, edge)?.get(sessionId);
              return rect ? { kind: "gridEdge", edge, rect } : null;
            }
          }
          // Another launched tile (it carries grid + session ids): its outer
          // quarter moves the dragged tile beside it (half its cells), the
          // middle swaps. The pointer over the dragged tile itself (a short
          // move) falls through to the free-cell placement below.
          const self = el !== null && el.dataset.slotId === slotId;
          if (!self && el?.dataset.gridId && el.dataset.sessionId) {
            const targetId = Number(el.dataset.sessionId);
            const zone = paneDropZone(el.getBoundingClientRect(), x, y);
            if (zone !== "swap" && !dropBesideTile(eagleTiles, sessionId, targetId, zone)) {
              return null;
            }
            return {
              kind: "pane",
              el,
              slotId: el.dataset.slotId ?? "",
              sessionId: targetId,
              zone,
            };
          }
          // Free grid cells: the tile moves there if it fits (same size).
          if (!grid || !eagleRect) return null;
          if (
            x < grid.left ||
            y < grid.top ||
            x > grid.left + grid.width ||
            y > grid.top + grid.height
          ) {
            return null;
          }
          const cx = ((x - grid.left) / grid.width) * EAGLE_UNITS;
          const cy = ((y - grid.top) / grid.height) * EAGLE_UNITS;
          const rect = placeTileAt(eagleRect, cx, cy);
          return fitsFree(rect, eagleOthers) ? { kind: "cell", rect } : null;
        }
        if (!el || el.dataset.slotId === slotId) return null;
        if (stage && !stage.contains(el)) return null;
        return {
          kind: "pane",
          el,
          slotId: el.dataset.slotId ?? "",
          sessionId: null,
          zone: paneDropZone(el.getBoundingClientRect(), x, y),
        };
      };

      const clearHighlight = () => {
        if (hovered) {
          delete hovered.dataset.dropZone;
          hovered = null;
        }
        stageHighlight?.remove();
        stageHighlight = null;
        cellHighlight?.remove();
        cellHighlight = null;
      };

      const showTarget = (target: DropTarget | null) => {
        clearHighlight();
        if (!target) return;
        if (target.kind === "cell" || target.kind === "gridEdge") {
          // The grid is deliberately unpositioned (zoomed panes resolve to
          // App's <main>), so the highlight is positioned against the grid's
          // offsetParent, like a zoomed pane — appending it to the grid
          // itself would make it a grid item.
          if (!grid) return;
          const parent = grid.el.offsetParent as HTMLElement | null;
          if (!parent) return;
          cellHighlight = document.createElement("div");
          cellHighlight.className = "pane-stage-drop";
          const padX = grid.left - grid.el.getBoundingClientRect().left;
          const padY = grid.top - grid.el.getBoundingClientRect().top;
          const unitW = grid.width / EAGLE_UNITS;
          const unitH = grid.height / EAGLE_UNITS;
          const style = cellHighlight.style;
          style.left = `${grid.el.offsetLeft + padX + target.rect.x * unitW}px`;
          style.top = `${grid.el.offsetTop + padY + target.rect.y * unitH}px`;
          style.width = `${target.rect.w * unitW}px`;
          style.height = `${target.rect.h * unitH}px`;
          parent.appendChild(cellHighlight);
          return;
        }
        if (target.kind === "stage") {
          if (!stage) return;
          stageHighlight = document.createElement("div");
          stageHighlight.className = "pane-stage-drop";
          const share = `${Math.round(STAGE_EDGE_RATIO * 100)}%`;
          const style = stageHighlight.style;
          if (target.edge === "left" || target.edge === "right") {
            style.top = "0";
            style.bottom = "0";
            style.width = share;
          } else {
            style.left = "0";
            style.right = "0";
            style.height = share;
          }
          style[target.edge] = "0";
          stage.appendChild(stageHighlight);
          return;
        }
        hovered = target.el;
        hovered.dataset.dropZone = target.zone;
        const label = hovered.querySelector<HTMLElement>(".pane-drop-zone > span");
        if (label) label.textContent = DROP_ZONE_LABELS[target.zone];
      };

      const onMove = (ev: PointerEvent) => {
        if (!active) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_PX) return;
          begin();
        }
        if (ghost) {
          ghost.style.left = `${ev.clientX + 14}px`;
          ghost.style.top = `${ev.clientY + 10}px`;
        }
        showTarget(findTarget(ev.clientX, ev.clientY));
      };

      const finish = (ev: PointerEvent, drop: boolean) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (!active) return;
        const target = drop ? findTarget(ev.clientX, ev.clientY) : null;
        clearHighlight();
        ghost?.remove();
        document.body.classList.remove("pane-dragging");
        wrapperRef.current?.classList.remove("pane-drag-source");
        setIsDragging(false);
        // Releasing also fires a click on whatever is under the pointer (the
        // title bar toggles its warning flag on click) — swallow that one.
        const swallowClick = (e: MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
        };
        window.addEventListener("click", swallowClick, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
        if (!target) return;
        if (target.kind === "stage") {
          onMoveToStageEdge(slotId, target.edge);
          return;
        }
        if (target.kind === "cell") {
          if (sessionId !== null) onEagleDrop?.(sessionId, { kind: "place", rect: target.rect });
          return;
        }
        if (target.kind === "gridEdge") {
          if (sessionId !== null) onEagleDrop?.(sessionId, { kind: "edge", edge: target.edge });
          return;
        }
        if (eagleMode) {
          if (sessionId !== null && target.sessionId !== null) {
            onEagleDrop?.(
              sessionId,
              target.zone === "swap"
                ? { kind: "swap", sessionId: target.sessionId }
                : { kind: "beside", sessionId: target.sessionId, side: target.zone },
            );
          }
          return;
        }
        if (target.zone === "swap") onSwap(slotId, target.slotId);
        else onMoveToSide(slotId, target.slotId, target.zone as PaneSide);
      };
      const onUp = (ev: PointerEvent) => finish(ev, true);
      const onCancel = (ev: PointerEvent) => finish(ev, false);

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      if (immediate) begin();
    },
    [
      slotId,
      gridId,
      sessionId,
      projectName,
      eagleMode,
      onSwap,
      onMoveToSide,
      onMoveToStageEdge,
      onEagleDrop,
      eagleRect,
      eagleOccupied,
    ],
  );

  /**
   * Eagle view: drag one edge of the tile. The start rect and the collision
   * set are captured here so the drag stays consistent while the layout
   * re-renders under it; the pointer travel is turned into whole cells.
   */
  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, edge: PaneEdge) => {
      if (e.button !== 0 && e.pointerType !== "touch") return;
      if (!eagleRect || sessionId === null || !onEagleResize) return;
      const grid = eagleGridBox();
      if (!grid || grid.width <= 0 || grid.height <= 0) return;
      e.preventDefault();
      e.stopPropagation();
      const start = eagleRect;
      const others = (eagleOccupied ?? [])
        .filter((o) => o.sessionId !== sessionId)
        .map((o) => o.rect);
      const horizontal = edge === "left" || edge === "right";
      const unitPx = horizontal ? grid.width / EAGLE_UNITS : grid.height / EAGLE_UNITS;
      const origin = horizontal ? e.clientX : e.clientY;
      let lastDelta = 0;
      document.body.classList.add("pane-resizing");
      document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
      const onMove = (ev: PointerEvent) => {
        const delta = Math.round(((horizontal ? ev.clientX : ev.clientY) - origin) / unitPx);
        if (delta === lastDelta) return;
        lastDelta = delta;
        onEagleResize(sessionId, start, edge, delta, others);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.classList.remove("pane-resizing");
        document.body.style.cursor = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [eagleRect, eagleOccupied, sessionId, onEagleResize],
  );

  /** The grip: picks the pane up at once. */
  const handleGripPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType !== "touch") return;
      e.preventDefault();
      e.stopPropagation();
      runDrag(e.clientX, e.clientY, true);
    },
    [runDrag],
  );

  /**
   * The title bar (`[data-pane-drag-handle]`, rendered by TerminalHeader):
   * picks the pane up once the pointer moves. Buttons and inputs on it keep
   * their own behaviour, and no default is prevented here so a plain click
   * still reaches the header.
   */
  const handleWrapperPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!showHandle) return;
      if (e.button !== 0 && e.pointerType !== "touch") return;
      const target = e.target as HTMLElement;
      if (target.closest("button, input, a, select, textarea, [contenteditable='true']")) return;
      const handle = target.closest<HTMLElement>("[data-pane-drag-handle]");
      if (!handle || !e.currentTarget.contains(handle)) return;
      runDrag(e.clientX, e.clientY, false);
    },
    [showHandle, runDrag],
  );

  // Eagle view restyles this container purely with CSS so the children
  // (the live xterm instance) never remount:
  // - hidden:   pinned spotlight — a non-pinned pane of an inactive project
  //             renders nothing (eagleHidden), so only the pinned tiles paint
  //             over the active project; TerminalGrid.pinnedSpotlight.test
  //             guards this branch
  // - zoomed:   position:absolute overlays the main content area (resolves to
  //             App's <main>, the nearest positioned ancestor — every eagle
  //             wrapper in between is display:contents), so the sidebar and
  //             git panel stay usable while zoomed; the header button returns
  // - obscured: another pane is zoomed — visibility:hidden stops WebGL paints
  //             behind the opaque overlay (also excludes it from drop hit-tests)
  // - tile:     plain grid item placed by `grid-column/row` from its rect; the
  //             project-colored border is painted by the terminal cell itself
  //             (TerminalView's projectColor override); p-1 is half the
  //             visual gap between tiles (the grid has no track gap)
  const eagleClass = eagleHidden
    ? "hidden"
    : pinnedStyle
      ? "absolute z-30 min-h-0 min-w-0 overflow-hidden rounded-md"
      : eagleZoomed
        ? // top-8 leaves room for MultiProjectView's global tab bar (h-8, z-50);
          // bottom-8 leaves the parked shelf (h-8) visible when chips exist.
          `absolute inset-x-0 top-8 z-40 bg-maestro-bg p-2 min-h-0 min-w-0 ${
            eagleReserveShelf ? "bottom-8" : "bottom-0"
          }`
        : "relative h-full w-full min-h-0 min-w-0 overflow-hidden rounded-md p-1";
  let eagleStyle: React.CSSProperties | undefined;
  if (eagleMode && !eagleHidden) {
    if (pinnedStyle) {
      eagleStyle = pinnedStyle;
    } else {
      eagleStyle = {};
      if (eagleObscured) eagleStyle.visibility = "hidden";
      if (!eagleZoomed) {
        if (eagleRect) {
          eagleStyle.gridColumn = `${eagleRect.x + 1} / span ${eagleRect.w}`;
          eagleStyle.gridRow = `${eagleRect.y + 1} / span ${eagleRect.h}`;
        } else {
          // Not placed yet (the layout learns about a new card one render
          // late): park it in the corner, invisible, so it takes no real cell.
          eagleStyle.gridArea = "1 / 1 / 2 / 2";
          eagleStyle.visibility = "hidden";
        }
      }
    }
  }
  const carriesIds = eagleMode && !eagleHidden && !pinnedStyle;
  // Resize handles: launched eagle tiles only, and only while the grid shows
  // more than one tile (same rule as the move grip).
  const showResizeHandles =
    eagleMode && showHandle && !eagleZoomed && !pinnedStyle && !!eagleRect && !!onEagleResize;
  return (
    <div
      ref={wrapperRef}
      className={eagleMode ? eagleClass : "relative h-full w-full min-h-0 min-w-0"}
      onPointerDown={handleWrapperPointerDown}
      // In eagle mode the normal [data-slot-id] wrapper (SplitPaneView's leaf)
      // is display:contents, whose rect is 0x0 — carrying the id here keeps
      // file drag-and-drop hit-testing working on the visible tile box.
      // A spotlight (pinned-strip) tile deliberately carries neither: it is
      // not a drop target of the active project's grid, whose pane-swap drag
      // hit-tests every [data-slot-id] and would otherwise "swap" with a slot
      // that does not exist in it.
      data-slot-id={carriesIds ? slotId : undefined}
      data-grid-id={carriesIds ? gridId : undefined}
      data-session-id={carriesIds && sessionId !== null ? sessionId : undefined}
      style={eagleStyle}
    >
      {children}
      {/* Drop-zone overlay: hidden until a drag sets data-drop-zone on this
          pane's [data-slot-id] element (see globals.css). */}
      <div className="pane-drop-zone">
        <span />
      </div>
      {showResizeHandles &&
        EAGLE_RESIZE_EDGES.map(({ edge, className }) => (
          <div
            key={edge}
            data-testid={`eagle-resize-${edge}`}
            title="Drag to resize this terminal (only this one changes)"
            className={`absolute z-20 rounded-sm transition-colors hover:bg-maestro-accent/60 ${className}`}
            onPointerDown={(e) => handleResizePointerDown(e, edge)}
          />
        ))}
      {showHandle && (
        <div
          onPointerDown={handleGripPointerDown}
          title={
            eagleMode
              ? "Drag to move this terminal — onto another terminal swaps, onto empty space moves"
              : "Drag to move this pane — edges move it there, middle swaps"
          }
          className={`absolute left-1 top-1 z-20 flex h-5 w-4 items-center justify-center rounded transition-colors hover:bg-maestro-card/80 hover:text-maestro-text ${
            isDragging ? "cursor-grabbing text-maestro-blue" : "cursor-grab text-maestro-muted/40"
          }`}
        >
          <GripVertical size={12} />
        </div>
      )}
    </div>
  );
}

/**
 * Single tab of the zoomed-terminal navigation strip, drag-reorderable via
 * dnd-kit (same pattern as ProjectTabs' TabItem). PointerSensor's 5px
 * activation constraint lets plain clicks through to onSelect.
 */
function ZoomTab({
  slotId,
  index,
  isActive,
  label,
  hasSession,
  sessionId,
  onSelect,
  onToggleFlag,
}: {
  slotId: string;
  index: number;
  isActive: boolean;
  label: string;
  hasSession: boolean;
  sessionId: number | null;
  onSelect: () => void;
  /** Clicking the already-active tab toggles the warning flag (header parity). */
  onToggleFlag?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slotId,
  });

  // The strip scrolls horizontally with a hidden scrollbar, so a tab activated
  // by keyboard (Alt+Arrow / number keys) can sit outside the visible range.
  // "nearest" on both axes limits the scroll to the strip itself.
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

  // Warning flag: visible on the tab, and toggleable by clicking the
  // already-active tab (matches the header / TerminalView tab bar behavior).
  const isFlagged = useSessionStore(
    (s) => sessionId !== null && s.flaggedSessionIds.includes(sessionId),
  );
  // Attention highlight (auto-unparked because the agent needs input) —
  // same yellow chrome as the warning flag, cleared by selecting the session.
  const hasAttention = useSessionStore(
    (s) => sessionId !== null && s.attentionSessionIds.includes(sessionId),
  );

  // Attention-first click semantics on the active tab: the first click only
  // acknowledges the attention highlight — it must not also set the warning
  // flag (the chrome would stay yellow and the user would have flagged the
  // session without knowing). Subsequent clicks toggle the flag as before.
  const handleActiveClick = () => {
    if (hasAttention && sessionId !== null) {
      useSessionStore.getState().clearSessionAttention(sessionId);
      return;
    }
    onToggleFlag?.();
  };

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <button
      ref={combinedRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={isActive && onToggleFlag ? handleActiveClick : onSelect}
      className={`
        flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors
        ${isFlagged || hasAttention ? "warning-flag" : ""}
        ${
          isActive
            ? "bg-maestro-blue/15 text-maestro-blue"
            : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
        }
      `}
      title={
        isActive
          ? onToggleFlag
            ? hasAttention
              ? `${label} (needs input — click to clear the attention highlight)`
              : `${label} (click to ${isFlagged ? "clear" : "set"} warning flag)`
            : `${label} (click to exit zoom)`
          : `Switch to ${label}`
      }
    >
      <span className="font-mono text-[10px] opacity-60">{index + 1}</span>
      <span className="max-w-[180px] truncate">{label}</span>
      {hasSession && sessionId !== null && <SessionStatusDot sessionId={sessionId} />}
    </button>
  );
}
