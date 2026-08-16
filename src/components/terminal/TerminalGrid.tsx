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
import { GripVertical } from "lucide-react";
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
import { useTerminalDragDrop } from "@/hooks/useTerminalDragDrop";
import { useTerminalKeyboard } from "@/hooks/useTerminalKeyboard";
import {
  type BranchWithWorktreeStatus,
  getBranchesWithWorktreeStatus,
  invalidateCurrentBranchCache,
} from "@/lib/git";
import {
  type McpServerConfig,
  removeOpenCodeMcpConfig,
  removeSessionMcpConfig,
  setSessionMcpServers,
  writeOpenCodeMcpConfig,
  writeSessionMcpConfig,
} from "@/lib/mcp";
import { checkFullDiskAccess, pathRequiresFDA } from "@/lib/permissions";
import {
  loadBranchConfig,
  type PluginConfig,
  removeSessionPluginConfig,
  type SkillConfig,
  saveBranchConfig,
  setSessionPlugins,
  setSessionSkills,
  writeSessionPluginConfig,
} from "@/lib/plugins";
import { projectColorFor } from "@/lib/projectColor";
import { samuraiHarvestArm } from "@/lib/samurai";
import { shellEscapePaths } from "@/lib/shellEscape";
import {
  registerSamuraiSuccessor,
  samuraiSuccessorCliFlags,
  successorLaunchImminent,
} from "@/lib/spawnSession";
import {
  AI_CLI_CONFIG,
  assignSessionBranch,
  buildCliCommand,
  checkCliAvailable,
  createSession,
  killSession,
  removeSessionHooksConfig,
  spawnShell,
  waitForTerminalReady,
  writeSessionHooksConfig,
  writeStdin,
} from "@/lib/terminal";
import { terminalArmInitialPrompt } from "@/lib/terminalPrompt";
import { useProjectColors } from "@/lib/useProjectColors";
import { cleanupSessionWorktree, prepareSessionWorktree } from "@/lib/worktreeManager";
import { useActivityStore } from "@/stores/useActivityStore";
import { useCliSettingsStore } from "@/stores/useCliSettingsStore";
import { useFDAStore } from "@/stores/useFDAStore";
import { useMcpStore } from "@/stores/useMcpStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { usePluginStore } from "@/stores/usePluginStore";
import type { AiMode } from "@/stores/useSessionStore";
import { SAMURAI_TERMINAL_STATES, useSessionStore } from "@/stores/useSessionStore";
import {
  type RepositoryInfo,
  useWorkspaceStore,
  type WorkspaceType,
} from "@/stores/useWorkspaceStore";
import { useWorktreeSettingsStore } from "@/stores/useWorktreeSettingsStore";
import { ParkedShelf } from "./ParkedShelf";
import { PreLaunchCard, type SessionSlot } from "./PreLaunchCard";
import { SplitPaneView } from "./SplitPaneView";
import {
  buildGridTree,
  collectSlotIds,
  createLeaf,
  findSiblingSlotId,
  MAX_SESSIONS,
  removeLeaf,
  swapSlots,
  type TreeNode,
  updateRatio,
} from "./splitTree";
import { TerminalView } from "./TerminalView";
import { SessionStatusDot, ThinkingIndicator } from "./ThinkingIndicator";

/**
 * How many parked samurai transcripts one grid keeps mounted (issue #122).
 *
 * A parked tile stays MOUNTED — it renders `display: none`, so its
 * TerminalView and xterm scrollback live on — and since the cap no longer
 * bounds them (see `occupiedSlotCount`) nothing else reaps them: an overnight
 * run at 30-minute handoffs would accrue ~48 of them plus a shelf chip each.
 * The newest few are what anyone actually reads back, so the rest are
 * disposed (PR #131 review M5).
 */
export const MAX_RETAINED_PARKED_SAMURAI_TILES = 3;

/** The parked samurai terminal-state session ids among these slots, oldest
 *  first — session ids are assigned in launch order and never reused. */
function parkedSamuraiSessionIds(slots: SessionSlot[]): number[] {
  const { samuraiBySessionId, parkedSessionIds } = useSessionStore.getState();
  return slots
    .flatMap((slot) => (slot.sessionId === null ? [] : [slot.sessionId]))
    .filter((sessionId) => {
      const info = samuraiBySessionId[sessionId];
      return (
        info !== undefined &&
        SAMURAI_TERMINAL_STATES.has(info.state) &&
        parkedSessionIds.includes(sessionId)
      );
    })
    .sort((a, b) => a - b);
}

/**
 * How many of these slots count against `MAX_SESSIONS`.
 *
 * Parked samurai terminal-state tiles (issue #122) are dead weight: the PTY
 * is gone and only the transcript remains. A long autonomous run leaves one
 * per generation, so counting them would first drop a successor's launch
 * AFTER `consume` claimed it (silently stalling the run) and then make the
 * "+" button a silent no-op for the whole project. Both call sites — the
 * pending-launch claim and `addSession` — go through here so the exemption
 * cannot drift apart again (PR #131 review M4/F4).
 */
function occupiedSlotCount(slots: SessionSlot[]): number {
  const { samuraiBySessionId, parkedSessionIds } = useSessionStore.getState();
  return slots.filter((slot) => {
    if (slot.sessionId === null) return true;
    const info = samuraiBySessionId[slot.sessionId];
    return !(
      info !== undefined &&
      SAMURAI_TERMINAL_STATES.has(info.state) &&
      parkedSessionIds.includes(slot.sessionId)
    );
  }).length;
}

/** Stable empty arrays to avoid infinite re-render loops in Zustand selectors. */
const EMPTY_MCP_SERVERS: McpServerConfig[] = [];
const EMPTY_SKILLS: SkillConfig[] = [];
const EMPTY_PLUGINS: PluginConfig[] = [];

/**
 * Launch mutex to serialize session launches within the same project.
 * This prevents race conditions where multiple sessions share the same .mcp.json file.
 * Without worktrees, sessions can overwrite each other's MCP config before Claude CLI reads it.
 */
const projectLaunchLocks = new Map<string, Promise<void>>();

async function withProjectLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any pending launches to complete.
  // Use a while loop because multiple waiters may wake up when a lock resolves.
  // After waking, we must re-check if another waiter grabbed the lock first.
  while (projectLaunchLocks.has(projectPath)) {
    await projectLaunchLocks.get(projectPath);
  }

  // Now we're guaranteed to be the only one proceeding
  // The Promise executor runs synchronously, so `resolve` is always assigned
  // before this function can reach the `finally` block below.
  let resolve!: () => void;
  const newLock = new Promise<void>((r) => {
    resolve = r;
  });
  projectLaunchLocks.set(projectPath, newLock);

  try {
    return await fn();
  } finally {
    resolve();
    if (projectLaunchLocks.get(projectPath) === newLock) {
      projectLaunchLocks.delete(projectPath);
    }
  }
}

/** Generates a unique ID for a new session slot. */
function generateSlotId(): string {
  return `slot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

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

/** Creates a new empty session slot with default configuration. */
function createEmptySlot(
  mcpServers: McpServerConfig[] = [],
  skills: SkillConfig[] = [],
  plugins: PluginConfig[] = [],
): SessionSlot {
  return {
    id: generateSlotId(),
    mode: "Claude",
    branch: null,
    customName: "",
    worktreeMode: "project",
    sessionId: null,
    worktreePath: null,
    worktreeWarning: null,
    enabledMcpServers: mcpServers.map((s) => s.name), // All enabled by default
    enabledSkills: skills.map((s) => s.id), // All enabled by default
    enabledPlugins: plugins.filter((p) => p.enabled_by_default).map((p) => p.id),
    mcpDefaultsApplied: mcpServers.length > 0,
    skillsDefaultsApplied: skills.length > 0,
    pluginsDefaultsApplied: plugins.length > 0,
  };
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
 *   providing both total slot count and launched session count.
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
  onSessionCountChange?: (slotCount: number, launchedCount: number) => void;
  onAllSessionsClosed?: () => void;
  /**
   * Eagle view: this grid's launched panes become items of the global
   * all-projects grid (via `display: contents` flattening) instead of using
   * the local split-tree layout. Pre-launch cards are hidden, per-project
   * zoom and pane drag/split are suspended.
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
}

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
    eagleMode = false,
    projectName,
    eagleZoomedSessionId = null,
    eagleAnyZoomed = false,
    onEagleZoomToggle,
    eagleTileCount = 0,
  },
  ref,
) {
  // Use repoPath for git operations, falling back to projectPath
  const effectiveRepoPath = repoPath ?? projectPath;

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
   * Inserts file paths into a session's terminal input, shell-escaped.
   * Shared by drag-and-drop and the attach-file button so both take the
   * exact same code path.
   */
  const insertPathsIntoSession = useCallback(
    (sessionId: number, paths: string[], slotId: string) => {
      // Trailing space separates this insertion from whatever comes next —
      // without it two consecutive drops produce adjacent quoted strings
      // ('/a/one.png''/b/two.png') that shells join into one bogus path.
      const escaped = `${shellEscapePaths(paths)} `;
      writeStdin(sessionId, escaped).catch(console.error);
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

  // Sync refs with state and report counts to parent
  useEffect(() => {
    slotsRef.current = slots;
    const launchedCount = slots.filter((s) => s.sessionId !== null).length;
    onSessionCountChange?.(slots.length, launchedCount);
  }, [slots, onSessionCountChange]);

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

  // When all slots are removed: either return to idle landing view or respawn a slot
  useEffect(() => {
    if (slots.length === 0 && mounted.current && !error) {
      if (onAllSessionsClosed) {
        onAllSessionsClosed();
      } else {
        const freshSlot = createEmptySlot(mcpServers, skills, plugins);
        setSlots([freshSlot]);
        setLayoutTree(createLeaf(freshSlot.id));
      }
    }
  }, [slots.length, error, mcpServers, skills, plugins, onAllSessionsClosed]);

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

  /**
   * Inner implementation of launchSlot, called within the project lock.
   * Spawns a shell with the configured settings. If a branch is selected,
   * prepares a worktree for that branch first.
   */
  const launchSlotInner = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((s) => s.id === slotId);
      if (!slot || slot.sessionId !== null) return;

      try {
        // Save branch config before launching (ensures it's persisted)
        if (effectiveRepoPath && slot.branch) {
          await saveBranchConfig(effectiveRepoPath, slot.branch, {
            enabled_plugins: slot.enabledPlugins,
            enabled_skills: slot.enabledSkills,
            enabled_mcp_servers: slot.enabledMcpServers,
          }).catch((err) => {
            console.error("Failed to save branch config on launch:", err);
            // Non-fatal - continue with launch
          });
        }

        // Determine the working directory
        // If a branch is selected, prepare a worktree first
        // For multi-repo workspaces, use effectiveRepoPath for git operations
        let workingDirectory = slot.workingDirOverride ?? effectiveRepoPath ?? projectPath;
        let worktreePath: string | null = null;
        let worktreeWarning: string | null = null;
        let detectedBranch: string | null = null;

        if (
          slot.workingDirOverride &&
          slot.workingDirOverride !== (effectiveRepoPath ?? projectPath)
        ) {
          // Recovered worktree from the History tab: run there as-is, no
          // preparation. Close-time deletion of a hand-made worktree is
          // prevented by the backend's managed-base guard.
          worktreePath = slot.workingDirOverride;
        } else if (effectiveRepoPath && slot.worktreeMode !== "project" && !slot.resumeSessionId) {
          // resumeSessionId pins the project dir: `claude --resume` cannot
          // find the conversation from a worktree (see updateSlotResumeSession).
          try {
            const result = await prepareSessionWorktree(
              effectiveRepoPath,
              slot.branch ?? null,
              worktreeBasePath,
              slot.worktreeMode === "new",
            );
            workingDirectory = result.working_directory;
            worktreePath = result.worktree_path;
            worktreeWarning = result.warning;
            detectedBranch = result.branch;

            if (worktreeWarning) {
              console.error(
                `[Worktree] Warning for branch "${slot.branch ?? "auto"}": ${worktreeWarning}`,
              );
            }
            if (worktreePath) {
              refreshBranches();
            }
          } catch (err) {
            console.warn(
              `[Worktree] Failed to prepare worktree, falling back to project path:`,
              err,
            );
            workingDirectory = effectiveRepoPath;
          }
        }

        // Generate project hash for MCP status identification
        // This is passed as MAESTRO_PROJECT_HASH env var to enable process-isolated
        // session identification (avoiding .mcp.json race conditions)
        let envVars: Record<string, string> | undefined;
        if (projectPath) {
          const projectHash = await invoke<string>("generate_project_hash", { projectPath });
          envVars = { MAESTRO_PROJECT_HASH: projectHash };
        }

        // Spawn the shell in the correct directory (worktree or project path)
        // MAESTRO_SESSION_ID is automatically injected by the backend
        const sessionId = await spawnShell(workingDirectory, envVars);

        // Register the session in SessionManager (required before assigning branch)
        if (projectPath) {
          const sessionConfig = await createSession(
            sessionId,
            slot.mode,
            projectPath,
            workingDirectory,
          );

          // Apply optional custom window name. Empty/whitespace is treated as "no
          // custom name" — the backend normalizes it back to None.
          const trimmedName = slot.customName.trim();
          let finalName: string | null | undefined = sessionConfig.name;
          if (trimmedName) {
            try {
              const renamed = await invoke<{ name?: string | null }>("rename_session", {
                sessionId,
                name: trimmedName,
              });
              finalName = renamed.name;
            } catch (err) {
              console.warn(`[Session] Failed to set custom name for session ${sessionId}:`, err);
            }
          }

          // Add project to MCP status monitor for polling status updates
          await invoke("add_mcp_project", { projectPath });
          // Add session to store directly (don't refetch all sessions to avoid status reset)
          useSessionStore.getState().addSession({
            ...sessionConfig,
            name: finalName,
            status: sessionConfig.status as import("@/stores/useSessionStore").BackendSessionStatus,
          });
        }

        // Assign the branch to the session so the header displays it.
        // Use the explicitly selected branch, or the one detected from the worktree.
        const effectiveBranch = slot.branch ?? detectedBranch;
        if (effectiveBranch && worktreePath) {
          const updatedConfig = await assignSessionBranch(sessionId, effectiveBranch, worktreePath);
          useSessionStore.getState().updateSession(sessionId, {
            branch: updatedConfig.branch,
            worktree_path: updatedConfig.worktree_path,
          });
        } else if (effectiveBranch) {
          useSessionStore.getState().updateSession(sessionId, { branch: effectiveBranch });
        }

        // Save enabled MCP servers for this session
        if (projectPath) {
          await setSessionMcpServers(projectPath, sessionId, slot.enabledMcpServers);
        }

        // Save enabled skills and plugins for this session
        if (projectPath) {
          await setSessionSkills(projectPath, sessionId, slot.enabledSkills);
          await setSessionPlugins(projectPath, sessionId, slot.enabledPlugins);
        }

        // Update slot state FIRST to mount TerminalView and initialize xterm.js.
        // This MUST happen before sending any commands to the PTY, otherwise
        // xterm.js won't be listening when output arrives and it will be lost.
        // This is also critical because CLIs like Codex send DSR (cursor position)
        // queries on startup, and xterm.js must be mounted to respond to them.
        setSlots((prev) =>
          prev.map((s) =>
            s.id === slotId ? { ...s, sessionId, worktreePath, worktreeWarning } : s,
          ),
        );

        // Register session with the project
        if (tabId) {
          addSessionToProject(tabId, sessionId);
        }

        // Auto-launch AI CLI after shell initializes
        // IMPORTANT: For Claude mode, we must write MCP config and launch CLI atomically
        // to prevent race conditions when multiple sessions launch without worktrees.
        // Without worktrees, all sessions share the same .mcp.json file, so we must:
        // 1. Write .mcp.json for this session
        // 2. Launch CLI immediately (before any other session can overwrite .mcp.json)
        // 3. Wait for CLI to read the config
        if (slot.mode !== "Plain") {
          const cliConfig = AI_CLI_CONFIG[slot.mode];
          if (cliConfig.command) {
            const isAvailable = await checkCliAvailable(cliConfig.command);

            if (isAvailable) {
              // Write MCP config IMMEDIATELY before launching CLI
              // This allows the CLI to discover MCP servers including the Maestro status server
              if (workingDirectory && slot.mode === "Claude") {
                try {
                  await writeSessionMcpConfig(
                    workingDirectory,
                    sessionId,
                    projectPath ?? workingDirectory,
                    slot.enabledMcpServers,
                  );
                } catch (err) {
                  console.error("Failed to write MCP config:", err);
                  // Non-fatal - continue with CLI launch, MCP servers just won't be available
                }

                // Write plugin enabled/disabled state to settings.local.json
                // Uses enabledPlugins format (not the legacy plugins array)
                try {
                  await writeSessionPluginConfig(
                    workingDirectory,
                    projectPath ?? workingDirectory,
                    slot.enabledPlugins,
                  );
                } catch (err) {
                  console.error("Failed to write plugin config:", err);
                  // Non-fatal - continue with CLI launch
                }

                // Write hooks config for Claude sessions
                // This configures Claude Code to POST hook events back to Maestro's status server
                try {
                  await writeSessionHooksConfig(workingDirectory, sessionId);
                } catch (err) {
                  console.warn("Failed to write hooks config:", err);
                  // Non-fatal: hooks are enhancement, session can work without them
                }
              } else if (workingDirectory && slot.mode === "OpenCode") {
                // Write OpenCode MCP config (opencode.json format)
                try {
                  await writeOpenCodeMcpConfig(
                    workingDirectory,
                    sessionId,
                    projectPath ?? workingDirectory,
                    slot.enabledMcpServers,
                  );
                } catch (err) {
                  console.error("Failed to write OpenCode MCP config:", err);
                  // Non-fatal - continue with CLI launch
                }

                // Write plugin enabled/disabled state to settings.local.json
                try {
                  await writeSessionPluginConfig(
                    workingDirectory,
                    projectPath ?? workingDirectory,
                    slot.enabledPlugins,
                  );
                } catch (err) {
                  console.error("Failed to write plugin config:", err);
                  // Non-fatal - continue with CLI launch
                }
              }

              // Wait for xterm.js to mount and start listening for PTY output
              // This ensures we don't send CLI commands before the terminal is ready
              // (which would cause output to be lost since Tauri events aren't buffered)
              try {
                await waitForTerminalReady(sessionId);
              } catch (err) {
                console.warn("Terminal ready timeout, proceeding anyway:", err);
              }

              // Brief delay for shell to initialize
              await new Promise((resolve) => setTimeout(resolve, 100));

              // Build CLI command with user-configured flags. A samurai
              // successor (issue #55) additionally forces skip-permissions —
              // an autonomous generation cannot answer permission prompts —
              // and carries the run config's model preference (review F4).
              const cliFlags = useCliSettingsStore.getState().getFlags(slot.mode);
              const effectiveFlags = slot.samurai
                ? samuraiSuccessorCliFlags(cliFlags, slot.samurai.model)
                : cliFlags;
              const cliCommand = buildCliCommand(
                slot.mode,
                effectiveFlags,
                slot.resumeSessionId ?? undefined,
              );

              // Samurai successor: register under supervision BEFORE the CLI
              // launches, so the backend's verify-ritual delivery is armed
              // strictly ahead of claude's SessionStart hook. Registration
              // failure is logged, not fatal — the session still launches and
              // the backend's successor_no_start ALERT surfaces the gap.
              if (slot.samurai) {
                try {
                  await registerSamuraiSuccessor(sessionId, slot.samurai);
                } catch (err) {
                  console.error("[Samurai] Failed to register successor session:", err);
                }
              }

              // Harvest triage launch (issue #98): arm the backend BEFORE
              // the CLI launches, so the journal-prompt injection gate is
              // set strictly ahead of claude's SessionStart hook. Failure is
              // logged, not fatal — the terminal still opens, just without
              // the injected prompt.
              if (slot.harvest) {
                try {
                  await samuraiHarvestArm(sessionId);
                } catch (err) {
                  console.error("[Harvest] Failed to arm the triage prompt:", err);
                }
              }

              // Generic initial prompt: same gate as harvest — arm the
              // backend BEFORE the CLI launches so the injection is set
              // strictly ahead of claude's SessionStart hook, which is what
              // types the prompt in. Claude only: no other CLI posts that
              // hook, so an armed non-Claude session would never inject.
              // Failure is logged, not fatal — the terminal still opens, the
              // user just types the prompt themselves.
              if (slot.initialPrompt && slot.mode === "Claude") {
                try {
                  await terminalArmInitialPrompt(sessionId, slot.initialPrompt);
                } catch (err) {
                  console.error("[InitialPrompt] Failed to arm the initial prompt:", err);
                }
              }

              // Send CLI launch command
              await writeStdin(sessionId, `${cliCommand}\r`);

              // Brief delay for CLI initialization.
              // With session-specific MCP server names (maestro-1, maestro-2, etc.),
              // we no longer have race conditions on .mcp.json, so we only need
              // a minimal delay for general CLI startup.
              await new Promise((resolve) => setTimeout(resolve, 500));
            } else {
              console.warn(
                `CLI '${cliConfig.command}' not found. Install with: ${cliConfig.installHint}`,
              );
            }
          }
        }
      } catch (err) {
        console.error("Failed to spawn shell:", err);
        setError("Failed to start terminal session");
      }
    },
    [projectPath, effectiveRepoPath, worktreeBasePath, tabId, addSessionToProject, refreshBranches],
  );

  /**
   * Launches a single slot by spawning a shell with the configured settings.
   *
   * NOTE: Uses withProjectLock to serialize launches within the same project.
   * This prevents race conditions where multiple sessions share the same .mcp.json file.
   */
  const launchSlot = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((s) => s.id === slotId);
      if (!slot || slot.sessionId !== null) return;

      // Gate on FDA: if the project is in a TCC-protected directory, check
      // Full Disk Access before any Rust-side filesystem operations.
      if (projectPath && pathRequiresFDA(projectPath)) {
        const hasAccess = await checkFullDiskAccess();
        if (!hasAccess) {
          useFDAStore.getState().requireAccess(projectPath, () => launchSlot(slotId));
          return;
        }
      }

      // Serialize launches within the same project to prevent .mcp.json race conditions
      const lockPath = projectPath ?? "no-project";
      await withProjectLock(lockPath, async () => {
        await launchSlotInner(slotId);
      });
    },
    [projectPath, launchSlotInner],
  );

  /**
   * Launches all unlaunched slots sequentially.
   * Note: launchSlot already uses withProjectLock, so launches are serialized.
   */
  const launchAll = useCallback(async () => {
    const unlaunchedSlots = slotsRef.current.filter((s) => s.sessionId === null);
    for (const slot of unlaunchedSlots) {
      await launchSlot(slot.id);
    }
  }, [launchSlot]);

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
      const workingDir = worktreePath || projectPath;

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
        onSessionCountChange?.(0, 0);
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
        onSessionCountChange?.(0, 0);
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
    }),
    [
      addSession,
      launchAll,
      refreshBranches,
      focusSession,
      zoomSession,
      killSessionById,
      zoomedSlotId,
    ],
  );

  // ── History-tab / samurai-successor launches ─────────────────────
  // The sidebar History tab (and the samurai successor spawn listener)
  // queues a pre-configured launch (resume id and/or worktree dir) in
  // usePendingLaunchStore because this grid may not even be mounted when
  // the request lands. Consume it here: configure a slot, then let the
  // effect below launch it once the slot has committed to state. One claim
  // per run — a FIFO store (finding B) with several entries for this tab
  // re-triggers this effect (the selector returns the next head entry) and
  // each claim gets its own slot.
  const pendingLaunch = usePendingLaunchStore((s) =>
    tabId ? (s.pending.find((p) => p.tabId === tabId) ?? null) : null,
  );

  useEffect(() => {
    if (!pendingLaunch || !tabId) return;
    const launch = usePendingLaunchStore.getState().consume(tabId);
    if (!launch) return;

    // Reuse the pristine initial slot when it's the only one — unless an
    // earlier claim already configured it and is merely waiting for its
    // deferred launch (finding B: two claims must never share one slot);
    // otherwise append.
    const current = slotsRef.current;
    const reusable =
      current.length === 1 &&
      current[0].sessionId === null &&
      !autoLaunchSlotIdsRef.current.includes(current[0].id) &&
      !launchingSlotIdsRef.current.has(current[0].id)
        ? current[0]
        : null;
    // Parked samurai terminal-state tiles do not count — see
    // `occupiedSlotCount`, shared with `addSession`.
    if (!reusable && occupiedSlotCount(current) >= MAX_SESSIONS) {
      setError(`Cannot resume: maximum of ${MAX_SESSIONS} sessions per project`);
      return;
    }
    const base = reusable ?? createEmptySlot(mcpServers, skills, plugins);
    const slot: SessionSlot = {
      ...base,
      mode: launch.mode,
      branch: launch.branch,
      resumeSessionId: launch.resumeSessionId,
      workingDirOverride: launch.workingDirOverride,
      // Samurai successor launches (issue #55) name their session and carry
      // the registration metadata; History launches leave both unset.
      customName: launch.customName ?? base.customName,
      samurai: launch.samurai ?? null,
      // Harvest triage launches (issue #98) arm the backend's journal
      // prompt injection right before the CLI launches.
      harvest: launch.harvest ?? false,
      // Generic initial prompt (any caller): armed right before the CLI
      // launches, typed into the PTY on the session's first SessionStarted.
      initialPrompt: launch.initialPrompt ?? null,
      // The History tab always names the exact directory to run in. Reusing the
      // pristine slot would otherwise inherit its worktreeMode, and any mode but
      // "project" sends launchSlotInner into prepareSessionWorktree — moving the
      // session into a worktree where `claude --resume` cannot find the session.
      worktreeMode: "project",
    };
    autoLaunchSlotIdsRef.current = [...autoLaunchSlotIdsRef.current, slot.id];
    // Advance slotsRef EAGERLY, before the setSlots below (bug: a samurai
    // launch opened an unsupervised terminal in the main checkout, and the
    // backend re-emitted 180s later). On the grid's MOUNT commit this effect
    // and the auto-launch effect below run in the SAME passive-effect flush:
    // React cannot re-render between them, so the ref sync at line 574 has
    // not run and launchSlot would read the PRISTINE slot — project dir, no
    // samurai payload, no registration. The next commit's sync re-derives
    // the ref from state, so an eager advance is self-healing.
    //
    // The setSlots calls stay FUNCTIONAL updaters on purpose: replacing them
    // with this ref-derived array would clobber a concurrent functional
    // update (launchSlotInner writes sessionId into another in-flight slot).
    slotsRef.current = reusable
      ? slotsRef.current.map((s) => (s.id === reusable.id ? slot : s))
      : slotsRef.current.some((s) => s.id === slot.id)
        ? slotsRef.current
        : [...slotsRef.current, slot];
    if (reusable) {
      setSlots((prev) => prev.map((s) => (s.id === reusable.id ? slot : s)));
    } else {
      // Dedupe by id instead of re-checking MAX_SESSIONS: the cap was already
      // enforced against current state above, and a refusal here would strand
      // the claim registered in autoLaunchSlotIdsRef forever (nothing clears a
      // claim whose slot never appears), permanently latching
      // successorLaunchImminent. A pathological same-batch double-claim now
      // overshoots the cap by one instead — transient and recoverable.
      setSlots((prev) => (prev.some((s) => s.id === slot.id) ? prev : [...prev, slot]));
      setLayoutTree(() => buildGridTree([...orderedSlotIds, slot.id]));
    }
    setFocusedSlotId(slot.id);
  }, [pendingLaunch, tabId, mcpServers, skills, plugins, orderedSlotIds]);

  // Launch queued slots only after they exist in committed state — calling
  // launchSlot in the effect above would race slotsRef against the setSlots.
  useEffect(() => {
    const ids = autoLaunchSlotIdsRef.current;
    if (ids.length === 0) return;
    const ready = ids.filter((id) => slots.some((s) => s.id === id));
    if (ready.length === 0) return;
    autoLaunchSlotIdsRef.current = ids.filter((id) => !ready.includes(id));
    // Hand the claim from the queued marker to the in-flight one in the same
    // statement — a slot must never be unmarked while its launch is running,
    // or the reuse guard treats it as pristine. `launchSlot` always settles
    // (withProjectLock releases in a finally, launchSlotInner swallows its
    // own errors), so the marker cannot latch.
    for (const id of ready) {
      launchingSlotIdsRef.current.add(id);
      void launchSlot(id).finally(() => launchingSlotIdsRef.current.delete(id));
    }
  }, [slots, launchSlot]);

  // Samurai kills (issue #55), parks (issue #60) and deaths (issue #44):
  // once a session reaches a terminal supervisor state (KILLED/PARKED/DEAD,
  // `SAMURAI_TERMINAL_STATES`) the session is announced on the
  // samurai-supervisor-event channel. No PTY-exit event exists and terminal
  // teardown is otherwise always frontend-initiated, so without this the
  // tile would linger, live, forever. Per issue #122's decided policy this
  // reuses the EXISTING park mechanism (`handlePark`, the same one the P
  // button drives) rather than closing the tile: the terminal moves into the
  // footer parking tray, and its transcript stays reachable by unparking it
  // — resuming is always a fresh spawn either way, so nothing is lost by
  // keeping the old terminal around instead of destroying it.
  //
  // Deliberately placed AFTER the pending-launch consume/launch effects
  // (fresh-eyes finding A): effects run in definition order, so when a
  // KILLED update and the successor's queued launch land in the same commit,
  // the consume effect claims and appends the successor slot first.
  const samuraiBySessionId = useSessionStore((s) => s.samuraiBySessionId);
  // One-shot guard (PR #131 review H2): the effect re-runs whenever
  // `parkedSet` changes, and the samurai entry keeps its terminal state
  // forever — so a user unpark from the tray would immediately re-trigger
  // the park (and a redundant re-kill) without this. Session ids are never
  // reused (resume is always a fresh spawn), so once handled is handled.
  const samuraiAutoParkedSessionIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const slot of slotsRef.current) {
      if (slot.sessionId === null) continue;
      if (samuraiAutoParkedSessionIdsRef.current.has(slot.sessionId)) continue;
      const info = samuraiBySessionId[slot.sessionId];
      if (info && SAMURAI_TERMINAL_STATES.has(info.state)) {
        samuraiAutoParkedSessionIdsRef.current.add(slot.sessionId);
        // The replicator/parker paths already tore the PTY down, and a DEAD
        // session's process is already gone by definition — but the Phase-2
        // circuit breaker (samurai_progress.rs) only transitions to PARKED,
        // leaving the PTY running. Kill it there so no path can orphan a
        // live agent running with --dangerously-skip-permissions; skip the
        // redundant IPC call for DEAD, whose process is confirmed gone.
        //
        // The kill is decided by the SUPERVISOR STATE alone, never by
        // `parkedSet` (PR #131 review H1): a tile the user already parked
        // with the P button still has a LIVE PTY — park is CSS-only — so
        // skipping it there is exactly the case that orphans an agent.
        // The one-shot ref above is what stops a redundant re-kill.
        if (info.state !== "DEAD") {
          killSession(slot.sessionId).catch(console.error);
        }
        // Only the tile move is conditional: parking an already-parked tile
        // would steal zoom/focus from wherever the user moved them.
        if (!parkedSet.has(slot.sessionId)) {
          handlePark(slot.id);
        }
      }
    }
    // Dispose everything past the retention cap, oldest first: a parked tile
    // is still mounted, so an unbounded run would hoard a TerminalView + xterm
    // buffer per generation. `keepDirArtifacts` is essential — the worktree,
    // MCP and hooks config belong to the RUN, which the next generation is
    // still working in.
    const retired = parkedSamuraiSessionIds(slotsRef.current);
    const excess = retired.length - MAX_RETAINED_PARKED_SAMURAI_TILES;
    for (const sessionId of retired.slice(0, Math.max(0, excess))) {
      handleKill(sessionId, { keepDirArtifacts: true });
    }
  }, [samuraiBySessionId, parkedSet, handlePark, handleKill]);

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
   * Eagle view: dropping a tile onto another project's tile reorders the
   * project tabs (tile order = tab order × per-project pane order, so
   * cross-project placement can only be expressed as a tab move).
   */
  const handleEagleCrossReorder = useCallback((srcTabId: string, destTabId: string) => {
    useWorkspaceStore.getState().reorderTabs(srcTabId, destTabId);
  }, []);

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
      const showReorderHandle = eagleMode
        ? eagleTileCount > 1 && !eagleAnyZoomed
        : slots.length > 1 && zoomedSlotId === null;
      const isEagleZoomed =
        eagleMode && slot.sessionId !== null && eagleZoomedSessionId === slot.sessionId;
      const isEagleObscured = eagleMode && eagleAnyZoomed && !isEagleZoomed;
      const isSlotZoomed = eagleMode ? isEagleZoomed : zoomedSlotId === slot.id;

      if (slot.sessionId !== null) {
        // TS narrowing on slot.sessionId doesn't survive into the closure below.
        const sessionId = slot.sessionId;
        return (
          <DraggablePane
            slotId={slot.id}
            gridId={tabId}
            showHandle={showReorderHandle}
            onSwap={handleSwapSlots}
            onCrossGridReorder={handleEagleCrossReorder}
            eagleMode={eagleMode}
            eagleHidden={false}
            eagleZoomed={isEagleZoomed}
            eagleObscured={isEagleObscured}
            eagleReserveShelf={parkedSessionIds.length > 0}
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
              onToggleZoom={() =>
                eagleMode ? onEagleZoomToggle?.(sessionId) : handleToggleZoom(slot.id)
              }
              onPark={() => handlePark(slot.id)}
              onAttachFiles={() => {
                handleAttachFiles(sessionId, slot.id).catch(console.error);
              }}
              // The color is always on: a terminal's border tells you which
              // project it belongs to in every view, not just eagle. The written
              // label stays eagle-only — inside a single project's grid every
              // tile would repeat the same name.
              projectLabel={eagleMode ? projectName : undefined}
              projectColor={eagleColor}
              hasMoveHandle={showReorderHandle}
              showShortcutHints={!eagleMode}
            />
            {dropOverlay}
          </DraggablePane>
        );
      }

      return (
        <DraggablePane
          slotId={slot.id}
          gridId={tabId}
          showHandle={showReorderHandle}
          onSwap={handleSwapSlots}
          onCrossGridReorder={handleEagleCrossReorder}
          eagleMode={eagleMode}
          eagleHidden={eagleMode}
          eagleZoomed={false}
          eagleObscured={false}
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
            onLaunch={() => launchSlot(slot.id)}
            onRemove={() => removeSlot(slot.id)}
            onResumeSessionChange={(sessionId) => updateSlotResumeSession(slot.id, sessionId)}
            isZoomed={isSlotZoomed}
            onToggleZoom={() => handleToggleZoom(slot.id)}
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
      handleEagleCrossReorder,
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
      launchSlot,
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
    !eagleMode && zoomedSlotId !== null && slots.some((s) => s.id === zoomedSlotId);

  // Both wrappers exist in BOTH modes (display:contents in eagle) so toggling
  // eagle view never changes the element tree shape — a structural difference
  // would remount every xterm and lose all scrollback. The shelf only ever
  // appends/removes as a trailing sibling, which leaves the split tree alone.
  const allParked =
    !eagleMode && slots.every((s) => s.sessionId !== null && parkedSet.has(s.sessionId));
  return (
    <div
      className={
        eagleMode
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
                      const label =
                        liveName?.trim() || slot.customName.trim() || `Terminal ${index + 1}`;

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
      <div
        className={
          eagleMode ? "contents" : `relative flex min-h-0 flex-1 ${zoomActive ? "p-2" : ""}`
        }
      >
        <SplitPaneView
          node={layoutTree}
          renderLeaf={renderLeaf}
          onRatioChange={handleRatioChange}
          onDragStateChange={setIsDragging}
          eagleMode={eagleMode}
          hiddenSlotIds={parkedSlotIds}
          zoomedSlotId={zoomActive ? zoomedSlotId : null}
        />
        {allParked && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-maestro-muted">
            All terminals parked — click a chip below to restore
          </div>
        )}
      </div>
      {/* Parked terminals stay reachable from the zoom-in view too (unpark
          makes the restored terminal the zoomed one — the user stays in zoom) */}
      {!eagleMode && <ParkedShelf projectPath={projectPath} onUnpark={handleUnpark} />}
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

/**
 * Wraps a terminal pane in a relative container that supports drag-to-reorder.
 *
 * Uses pointer events (mousedown/move/up) instead of HTML5 DnD because
 * Tauri's WebView2 keeps showing the "no drop" cursor when custom MIME
 * types aren't surfaced in `dataTransfer.types` during dragover. Pointer
 * events are also lighter — no drag image, no system cursor switching —
 * and let us use `document.elementFromPoint` to find the destination pane.
 *
 * `min-h-0 min-w-0` keep the flex/overflow chain working so children with
 * `overflow-y-auto` (e.g. PreLaunchCard) can shrink past their intrinsic
 * content size and become scrollable.
 */
function DraggablePane({
  slotId,
  gridId,
  showHandle,
  onSwap,
  onCrossGridReorder,
  children,
  eagleMode = false,
  eagleHidden = false,
  eagleZoomed = false,
  eagleObscured = false,
  eagleReserveShelf = false,
}: {
  slotId: string;
  /** Owning grid (tab) id — identifies the source project for eagle drops. */
  gridId?: string;
  showHandle: boolean;
  onSwap: (srcSlotId: string, destSlotId: string) => void;
  /** Eagle view: tile dropped onto another project's tile → reorder tabs. */
  onCrossGridReorder?: (srcTabId: string, destTabId: string) => void;
  children: ReactNode;
  /** Eagle view: this pane is a tile of the global all-projects grid. */
  eagleMode?: boolean;
  /** Eagle view: pane has no live terminal (pre-launch) — not shown. */
  eagleHidden?: boolean;
  /** Eagle view: pane is zoomed to fill the main content area (position: absolute). */
  eagleZoomed?: boolean;
  /** Eagle view: another pane is zoomed — stop painting under its overlay. */
  eagleObscured?: boolean;
  /** Eagle view while zoomed: leave room for the parked shelf (h-8) below. */
  eagleReserveShelf?: boolean;
}) {
  const [isDragging, setIsDragging] = useState(false);

  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.pointerType !== "touch") return;
      e.preventDefault();
      e.stopPropagation();

      setIsDragging(true);

      // Outline every other pane so the user can see they're valid drop targets.
      // In eagle mode every visible tile (any project) is a target: same-grid
      // drops swap panes, cross-grid drops reorder the project tabs. The
      // [data-grid-id] filter keeps 0×0 display:contents leaf wrappers out.
      const allWrappers = Array.from(
        document.querySelectorAll<HTMLElement>(
          eagleMode ? "[data-slot-id][data-grid-id]" : "[data-slot-id]",
        ),
      );
      const decorate = (el: HTMLElement, hovered: boolean) => {
        el.style.outline = hovered
          ? "2px solid rgb(var(--maestro-blue))"
          : "1px dashed rgb(var(--maestro-border))";
        el.style.outlineOffset = "-2px";
      };
      const cleanup = () => {
        for (const el of allWrappers) {
          el.style.outline = "";
          el.style.outlineOffset = "";
        }
      };
      for (const el of allWrappers) {
        if (el.getAttribute("data-slot-id") !== slotId) decorate(el, false);
      }

      const findTarget = (clientX: number, clientY: number): HTMLElement | null => {
        const elem = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        const target = elem?.closest("[data-slot-id]") as HTMLElement | null;
        // Eagle: only visible tiles (which carry data-grid-id) are targets.
        if (eagleMode && !target?.dataset.gridId) return null;
        return target;
      };

      const onMove = (ev: PointerEvent) => {
        const target = findTarget(ev.clientX, ev.clientY);
        const targetId = target?.getAttribute("data-slot-id");
        for (const el of allWrappers) {
          const id = el.getAttribute("data-slot-id");
          if (id === slotId) continue;
          decorate(el, id === targetId && id !== slotId);
        }
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        cleanup();
        setIsDragging(false);
        const target = findTarget(ev.clientX, ev.clientY);
        const dest = target?.getAttribute("data-slot-id");
        if (!dest || dest === slotId) return;
        const destGridId = target?.dataset.gridId;
        if (eagleMode && gridId && destGridId && destGridId !== gridId) {
          // Different project: express the move as a project-tab reorder.
          onCrossGridReorder?.(gridId, destGridId);
        } else {
          onSwap(slotId, dest);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [slotId, onSwap, onCrossGridReorder, eagleMode, gridId],
  );

  // Eagle view restyles this container purely with CSS so the children
  // (the live xterm instance) never remount:
  // - hidden:   pre-launch panes don't belong in a terminals-only overview
  // - zoomed:   position:absolute overlays the main content area (resolves to
  //             App's <main>, the nearest positioned ancestor — every eagle
  //             wrapper in between is display:contents), so the sidebar and
  //             git panel stay usable while zoomed; the header button returns
  // - obscured: another pane is zoomed — visibility:hidden stops WebGL paints
  //             behind the opaque overlay (also excludes it from drop hit-tests)
  // - tile:     plain grid item — the project-colored border is painted by the
  //             terminal cell itself (TerminalView's projectColor override)
  const eagleClass = eagleHidden
    ? "hidden"
    : eagleZoomed
      ? // top-8 leaves room for MultiProjectView's global tab bar (h-8, z-50);
        // bottom-8 leaves the parked shelf (h-8) visible when chips exist.
        `absolute inset-x-0 top-8 z-40 bg-maestro-bg p-2 min-h-0 min-w-0 ${
          eagleReserveShelf ? "bottom-8" : "bottom-0"
        }`
      : "relative h-full w-full min-h-0 min-w-0 overflow-hidden rounded-md";
  return (
    <div
      className={eagleMode ? eagleClass : "relative h-full w-full min-h-0 min-w-0"}
      // In eagle mode the normal [data-slot-id] wrapper (SplitPaneView's leaf)
      // is display:contents, whose rect is 0x0 — carrying the id here keeps
      // file drag-and-drop hit-testing working on the visible tile box.
      data-slot-id={eagleMode && !eagleHidden ? slotId : undefined}
      data-grid-id={eagleMode && !eagleHidden ? gridId : undefined}
      style={eagleMode && !eagleHidden && eagleObscured ? { visibility: "hidden" } : undefined}
    >
      {children}
      {showHandle && (
        <div
          onPointerDown={startDrag}
          title={
            eagleMode
              ? "Drag to swap panes — drop on another project to reorder projects"
              : "Drag to swap with another pane"
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
      {hasSession && sessionId !== null && (
        <>
          <ThinkingIndicator sessionId={sessionId} size={3} />
          <SessionStatusDot sessionId={sessionId} />
        </>
      )}
    </button>
  );
}
