import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { samePath } from "@/lib/path";
import { samuraiListSessions, type SamuraiSupervisorState } from "@/lib/samurai";
import { useAgentStore } from "@/stores/useAgentStore";
import type { ClaudeEvent } from "@/types/claude-events";

export type { SamuraiSupervisorState };

/** AI provider variants supported by the backend orchestrator. */
export type AiMode = "Claude" | "Gemini" | "Codex" | "OpenCode" | "Plain";

/**
 * Backend-emitted session lifecycle states.
 * Must stay in sync with the Rust `SessionStatus` enum.
 * "Timeout" is a frontend-only status for sessions stuck in Starting state.
 */
export type BackendSessionStatus =
  | "Starting"
  | "Idle"
  | "Working"
  | "NeedsInput"
  | "Done"
  | "Error"
  | "Timeout";

/** Timeout in milliseconds for sessions stuck in Starting state (Bug #74) */
const SESSION_STARTUP_TIMEOUT_MS = 30000;

/**
 * Mirrors the Rust `SessionConfig` struct returned by `get_sessions`.
 *
 * @property id - Unique numeric session ID assigned by the backend.
 * @property branch - Git branch the session operates on, or null for the default branch.
 * @property worktree_path - Filesystem path to the git worktree, if one was created.
 * @property project_path - Canonicalized project directory this session belongs to.
 * @property statusMessage - Brief description of what the agent is doing (from MCP status).
 * @property needsInputPrompt - When status is NeedsInput, the specific question for the user.
 */
export interface SessionConfig {
  id: number;
  mode: AiMode;
  name?: string | null;
  branch: string | null;
  status: BackendSessionStatus;
  worktree_path: string | null;
  project_path: string;
  /** The actual directory the shell was spawned in (may differ from project_path in multi-repo workspaces). */
  working_directory?: string | null;
  statusMessage?: string;
  needsInputPrompt?: string;
  /** Timestamp of the last MCP-driven status update (used by activity heuristic). */
  lastMcpUpdateTime?: number;
  /**
   * Derived context-window usage % (0-100, one decimal) of the session's
   * Claude conversation, from the transcript watcher's ContextUsageUpdate
   * events. Frontend-only — not part of the Rust SessionConfig. Undefined
   * until the first assistant message with usage data arrives; idle sessions
   * keep their last-known value (no decay).
   */
  contextPercent?: number;
  /** Tokens in the latest API call's context (input + cache read + cache creation). */
  contextTokens?: number;
  /** The model's context window in tokens (e.g. 200000 or 1000000). */
  contextWindow?: number;
}

/** Shape of the Tauri `session-status-changed` event payload. */
interface SessionStatusPayload {
  session_id: number;
  project_path: string;
  status: BackendSessionStatus;
  message?: string;
  needs_input_prompt?: string;
}

/**
 * Raw wire payload for `session-status-changed`. The Claude Stop hook emits
 * "AwaitingInput" (agent ended its turn, user's move); it is normalized to
 * NeedsInput before it reaches the store, so it never appears in a session.
 */
type RawSessionStatusPayload = Omit<SessionStatusPayload, "status"> & {
  status: BackendSessionStatus | "AwaitingInput";
};

/**
 * What the badge UI (issue #46) needs to know about one Samurai-supervised
 * session: which project it belongs to (ids alone are not trusted to be
 * unique across projects), its epic, and the latest generation + state.
 */
export interface SamuraiSessionInfo {
  /** Canonical project path, `\\?\` prefix already stripped by the backend. */
  project: string;
  epic: string;
  generation: number;
  state: SamuraiSupervisorState;
}

/**
 * Zustand store slice for session metadata (not PTY I/O -- that lives in terminal.ts).
 *
 * @property sessions - Authoritative list of sessions fetched from the backend.
 * @property fetchSessions - Performs a one-shot IPC fetch to replace the session list.
 * @property initListeners - Subscribes to the global `session-status-changed` Tauri event.
 *   Returns an unlisten function; callers must invoke the cleanup to decrement
 *   a reference count and remove the listener when the last subscriber exits.
 */
interface SessionState {
  sessions: SessionConfig[];
  /**
   * Sessions hidden ("parked") from the terminal grids. The PTY keeps
   * running; only the pane is CSS-hidden. In-memory only — session IDs are
   * ephemeral (reassigned each app launch), so persisting them to disk would
   * hide unrelated future sessions that reuse the same numbers.
   */
  parkedSessionIds: number[];
  /**
   * Sessions the user flagged as "warning" by clicking the terminal header or
   * tab strip — their chrome renders yellow. In-memory only, same rationale
   * as parkedSessionIds: session IDs are reassigned each app launch.
   */
  flaggedSessionIds: number[];
  /**
   * Sessions that were auto-unparked because their agent stopped and asked
   * for input while parked. Rendered as a yellow "attention" highlight on the
   * session's header and tabs (same styling as the manual warning flag) until
   * the user focuses/selects the session. In-memory only, same rationale as
   * parkedSessionIds.
   */
  attentionSessionIds: number[];
  /**
   * Samurai-supervised sessions, keyed by session id — fed by
   * `samurai-supervisor-event` and seeded from `samurai_list_sessions` on
   * listener init. Sessions absent from this map are not supervised and
   * render no Samurai chrome (issue #46: non-supervised sessions unchanged).
   */
  samuraiBySessionId: Record<number, SamuraiSessionInfo>;
  isLoading: boolean;
  error: string | null;
  parkSession: (sessionId: number) => void;
  unparkSession: (sessionId: number) => void;
  toggleSessionFlag: (sessionId: number) => void;
  clearSessionAttention: (sessionId: number) => void;
  fetchSessions: () => Promise<void>;
  fetchSessionsForProject: (projectPath: string) => Promise<void>;
  addSession: (session: SessionConfig) => void;
  removeSession: (sessionId: number) => void;
  removeSessionsForProject: (projectPath: string) => Promise<SessionConfig[]>;
  updateSession: (sessionId: number, updates: Partial<SessionConfig>) => void;
  renameSession: (sessionId: number, name: string | null) => Promise<void>;
  getSessionsByProject: (projectPath: string) => SessionConfig[];
  initListeners: () => Promise<UnlistenFn>;
}

/**
 * Global session store. Not persisted — sessions are ephemeral and
 * re-fetched from the backend on app launch via `fetchSessions`.
 */
let listenerCount = 0;
let pendingInit: Promise<void> | null = null;
let activeUnlisten: UnlistenFn | null = null;

/**
 * Buffer for status events that arrive before their session is added to the store.
 * Key is "session_id:project_path", value is the latest status payload for that session.
 */
const pendingStatusUpdates: Map<string, SessionStatusPayload> = new Map();

/**
 * Tracks startup timeout timers for sessions (Bug #74).
 * Key is session ID, value is the timeout handle.
 * When a session transitions out of "Starting" state, its timer is cleared.
 */
const startupTimeouts: Map<number, ReturnType<typeof setTimeout>> = new Map();

/** Last-known context-window usage of one session (see lastContextUsage). */
interface ContextUsage {
  percent: number;
  tokens: number;
  window: number;
}

/**
 * Last-known context usage per session id, fed by the claude-events listener
 * (initContextUsageListener). Kept outside the store — same rationale as
 * pendingStatusUpdates — so a fetchSessions() replacing the session list, or
 * an event arriving before its session is added, cannot lose the value: it is
 * re-applied on fetch and on addSession. In-memory only; session IDs are
 * ephemeral (reassigned each app launch).
 */
const lastContextUsage: Map<number, ContextUsage> = new Map();

/** Merge the remembered context usage into a (freshly fetched) session. */
function withContextUsage(session: SessionConfig): SessionConfig {
  const usage = lastContextUsage.get(session.id);
  if (!usage) return session;
  return {
    ...session,
    contextPercent: usage.percent,
    contextTokens: usage.tokens,
    contextWindow: usage.window,
  };
}

/** Generate a unique key for buffering status updates */
function statusBufferKey(sessionId: number, projectPath: string): string {
  return `${sessionId}:${projectPath}`;
}

/**
 * Clears the startup timeout for a session.
 * Called when session transitions out of "Starting" state.
 */
function clearStartupTimeout(sessionId: number): void {
  const timer = startupTimeouts.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    startupTimeouts.delete(sessionId);
  }
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  parkedSessionIds: [],
  flaggedSessionIds: [],
  attentionSessionIds: [],
  samuraiBySessionId: {},
  isLoading: false,
  error: null,

  parkSession: (sessionId: number) => {
    set((state) => {
      const alreadyParked = state.parkedSessionIds.includes(sessionId);
      const hasAttention = state.attentionSessionIds.includes(sessionId);
      // No-op guard: don't replace arrays (and re-render subscribers)
      // when nothing changes.
      if (alreadyParked && !hasAttention) return state;
      return {
        parkedSessionIds: alreadyParked
          ? state.parkedSessionIds
          : [...state.parkedSessionIds, sessionId],
        // Parking is a deliberate act on the session — an auto-unpark
        // attention highlight would be stale once it's hidden again.
        attentionSessionIds: hasAttention
          ? state.attentionSessionIds.filter((id) => id !== sessionId)
          : state.attentionSessionIds,
      };
    });
  },

  unparkSession: (sessionId: number) => {
    set((state) => ({
      parkedSessionIds: state.parkedSessionIds.filter((id) => id !== sessionId),
    }));
  },

  toggleSessionFlag: (sessionId: number) => {
    set((state) => ({
      flaggedSessionIds: state.flaggedSessionIds.includes(sessionId)
        ? state.flaggedSessionIds.filter((id) => id !== sessionId)
        : [...state.flaggedSessionIds, sessionId],
    }));
  },

  clearSessionAttention: (sessionId: number) => {
    set((state) =>
      state.attentionSessionIds.includes(sessionId)
        ? {
            attentionSessionIds: state.attentionSessionIds.filter(
              (id) => id !== sessionId
            ),
          }
        : state
    );
  },

  fetchSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const fetched = await invoke<SessionConfig[]>("get_sessions");
      // Re-apply last-known context usage — the backend doesn't carry it.
      const sessions = fetched.map(withContextUsage);
      set((state) => ({
        sessions,
        isLoading: false,
        // Prune parked/flagged/attention IDs that no longer exist in the fetched list
        parkedSessionIds: state.parkedSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
        flaggedSessionIds: state.flaggedSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
        attentionSessionIds: state.attentionSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
      }));
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
      set({ error: String(err), isLoading: false });
    }
  },

  fetchSessionsForProject: async (projectPath: string) => {
    set({ isLoading: true, error: null });
    try {
      const fetched = await invoke<SessionConfig[]>("get_sessions_for_project", {
        projectPath,
      });
      // Re-apply last-known context usage — the backend doesn't carry it.
      const sessions = fetched.map(withContextUsage);
      set((state) => ({
        sessions,
        isLoading: false,
        // Prune parked/flagged/attention IDs that no longer exist in the fetched list
        parkedSessionIds: state.parkedSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
        flaggedSessionIds: state.flaggedSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
        attentionSessionIds: state.attentionSessionIds.filter((id) =>
          sessions.some((s) => s.id === id)
        ),
      }));
    } catch (err) {
      console.error("Failed to fetch sessions for project:", err);
      set({ error: String(err), isLoading: false });
    }
  },

  addSession: (session: SessionConfig) => {
    // Clear any stale buffered status for this session ID across ALL projects
    // This prevents pollution from old sessions with the same ID
    for (const key of pendingStatusUpdates.keys()) {
      if (key.startsWith(`${session.id}:`)) {
        console.log(`[SessionStore] Clearing stale buffered status for key: '${key}'`);
        pendingStatusUpdates.delete(key);
      }
    }

    // Check if we have a buffered status update for this session
    const bufferKey = statusBufferKey(session.id, session.project_path);
    const bufferedStatus = pendingStatusUpdates.get(bufferKey);

    console.log(`[SessionStore] addSession id=${session.id} project_path='${session.project_path}'`);
    console.log(`[SessionStore] Buffer key: '${bufferKey}', has buffered status: ${!!bufferedStatus}`);
    if (pendingStatusUpdates.size > 0) {
      console.log("[SessionStore] All buffered keys:", Array.from(pendingStatusUpdates.keys()));
    }

    if (bufferedStatus) {
      pendingStatusUpdates.delete(bufferKey);
      console.log(`[SessionStore] Applying buffered status: ${bufferedStatus.status}`);
      // Apply the buffered status to the session before adding
      session = {
        ...session,
        status: bufferedStatus.status,
        statusMessage: bufferedStatus.message,
        needsInputPrompt: bufferedStatus.needs_input_prompt,
      };
    }

    // Start a timeout timer for sessions in "Starting" state (Bug #74)
    // If no status update is received within the timeout, mark as "Timeout"
    if (session.status === "Starting") {
      // Clear any existing timeout for this session (shouldn't happen, but be safe)
      clearStartupTimeout(session.id);

      const timeoutTimer = setTimeout(() => {
        startupTimeouts.delete(session.id);
        // Check if session is still in Starting state
        const currentState = get();
        const currentSession = currentState.sessions.find((s) => s.id === session.id);
        if (currentSession && currentSession.status === "Starting") {
          console.warn(`[SessionStore] Session ${session.id} startup timeout after ${SESSION_STARTUP_TIMEOUT_MS}ms`);
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === session.id
                ? {
                    ...s,
                    status: "Timeout" as BackendSessionStatus,
                    statusMessage: "CLI failed to start - check terminal for errors",
                  }
                : s
            ),
          }));
        }
      }, SESSION_STARTUP_TIMEOUT_MS);

      startupTimeouts.set(session.id, timeoutTimer);
    }

    set((state) => {
      // Don't add if session already exists
      if (state.sessions.some((s) => s.id === session.id)) {
        return state;
      }
      // Apply context usage that arrived before the session was added
      // (transcript catch-up can beat addSession).
      return { sessions: [...state.sessions, withContextUsage(session)] };
    });
  },

  updateSession: (sessionId: number, updates: Partial<SessionConfig>) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...updates } : s
      ),
    }));
  },

  renameSession: async (sessionId: number, name: string | null) => {
    try {
      const updated = await invoke<SessionConfig>("rename_session", {
        sessionId,
        name,
      });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, name: updated.name } : s
        ),
      }));
    } catch (err) {
      console.error("Failed to rename session:", err);
    }
  },

  removeSession: (sessionId: number) => {
    // Clear any startup timeout for this session
    clearStartupTimeout(sessionId);

    // Forget the context usage so a future session reusing this id doesn't
    // inherit a stale percentage.
    lastContextUsage.delete(sessionId);

    // Clear any buffered status for this session to prevent pollution on restart
    const sessionsToRemove = get().sessions.filter((s) => s.id === sessionId);
    for (const session of sessionsToRemove) {
      const bufferKey = statusBufferKey(session.id, session.project_path);
      pendingStatusUpdates.delete(bufferKey);
    }

    set((state) => {
      // Same stale-id hygiene for the supervision map: a future session
      // reusing this id must not inherit a Samurai badge.
      const samuraiBySessionId = { ...state.samuraiBySessionId };
      delete samuraiBySessionId[sessionId];
      return {
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        parkedSessionIds: state.parkedSessionIds.filter((id) => id !== sessionId),
        flaggedSessionIds: state.flaggedSessionIds.filter((id) => id !== sessionId),
        attentionSessionIds: state.attentionSessionIds.filter((id) => id !== sessionId),
        samuraiBySessionId,
      };
    });
  },

  removeSessionsForProject: async (projectPath: string) => {
    try {
      const removed = await invoke<SessionConfig[]>("remove_sessions_for_project", {
        projectPath,
      });
      // Same stale-id hygiene as removeSession.
      for (const session of removed) {
        lastContextUsage.delete(session.id);
      }
      // Remove the sessions from local state
      set((state) => {
        const samuraiBySessionId = { ...state.samuraiBySessionId };
        for (const session of removed) {
          delete samuraiBySessionId[session.id];
        }
        return {
          sessions: state.sessions.filter(
            (s) => !removed.some((r) => r.id === s.id)
          ),
          parkedSessionIds: state.parkedSessionIds.filter(
            (id) => !removed.some((r) => r.id === id)
          ),
          flaggedSessionIds: state.flaggedSessionIds.filter(
            (id) => !removed.some((r) => r.id === id)
          ),
          attentionSessionIds: state.attentionSessionIds.filter(
            (id) => !removed.some((r) => r.id === id)
          ),
          samuraiBySessionId,
        };
      });
      return removed;
    } catch (err) {
      console.error("Failed to remove sessions for project:", err);
      return [];
    }
  },

  getSessionsByProject: (projectPath: string) => {
    return get().sessions.filter((s) => samePath(s.project_path, projectPath));
  },

  initListeners: async () => {
    listenerCount += 1;
    try {
      if (!activeUnlisten) {
        if (!pendingInit) {
          pendingInit = listen<RawSessionStatusPayload>("session-status-changed", (event) => {
            const { session_id, project_path, message, needs_input_prompt } = event.payload;

            // Normalize the Stop-hook signal: treat "AwaitingInput" as
            // NeedsInput, but never downgrade an explicit terminal state
            // (Done/Error) or a startup Timeout the agent/frontend already set.
            let status: BackendSessionStatus;
            let statusMessage = message;
            if (event.payload.status === "AwaitingInput") {
              const existing = get().sessions.find(
                (s) => s.id === session_id && s.project_path === project_path
              );
              if (existing && ["Done", "Error", "Timeout"].includes(existing.status)) {
                return;
              }
              // The Stop hook fires whenever the agent ends its turn — including
              // when it ends the turn precisely because it handed work off to
              // background subagents. Those are still running, so the session is
              // working, not waiting on the user. Self-correcting: the next turn
              // end, once no subagent is running, reports NeedsInput as normal.
              const runningSubagents = useAgentStore
                .getState()
                .agents.filter((a) => a.sessionId === session_id && a.completedAt === null).length;
              if (runningSubagents > 0) {
                status = "Working";
                statusMessage = `${runningSubagents} subagent${
                  runningSubagents === 1 ? "" : "s"
                } running`;
              } else {
                status = "NeedsInput";
              }
            } else {
              status = event.payload.status;
            }

            // Check if session exists in store
            const sessionExists = get().sessions.some(
              (s) => s.id === session_id && s.project_path === project_path
            );

            if (!sessionExists) {
              // Buffer this status update - it will be applied when the session is added
              const bufferKey = statusBufferKey(session_id, project_path);
              console.log(`[SessionStore] Buffering status for non-existent session. Key: '${bufferKey}'`);
              pendingStatusUpdates.set(bufferKey, {
                ...event.payload,
                status,
                message: statusMessage,
              });
              return;
            }

            // Clear startup timeout when session transitions out of Starting state (Bug #74)
            if (status !== "Starting") {
              clearStartupTimeout(session_id);
            }

            set((state) => {
              // Auto-unpark on the TRANSITION into NeedsInput: a parked agent
              // that stops and asks for the user must come back into view,
              // marked for attention (yellow chrome) until the user selects
              // it. Edge-triggered on purpose — if the user re-parks the
              // still-NeedsInput session, repeated NeedsInput events are not
              // a new transition and must not undo that manual choice.
              const existing = state.sessions.find(
                (s) => s.id === session_id && s.project_path === project_path
              );
              const autoUnpark =
                existing !== undefined &&
                status === "NeedsInput" &&
                existing.status !== "NeedsInput" &&
                state.parkedSessionIds.includes(session_id);

              return {
                sessions: state.sessions.map((s) =>
                  s.id === session_id && s.project_path === project_path
                    ? {
                        ...s,
                        status,
                        statusMessage,
                        needsInputPrompt: needs_input_prompt,
                        lastMcpUpdateTime: Date.now(),
                      }
                    : s
                ),
                ...(autoUnpark
                  ? {
                      parkedSessionIds: state.parkedSessionIds.filter(
                        (id) => id !== session_id
                      ),
                      attentionSessionIds: state.attentionSessionIds.includes(
                        session_id
                      )
                        ? state.attentionSessionIds
                        : [...state.attentionSessionIds, session_id],
                    }
                  : {}),
              };
            });
          })
            .then((unlisten) => {
              activeUnlisten = unlisten;
            })
            .finally(() => {
              pendingInit = null;
            });
        }
        await pendingInit;
      }
    } catch (err) {
      listenerCount = Math.max(0, listenerCount - 1);
      throw err;
    }

    return () => {
      listenerCount = Math.max(0, listenerCount - 1);
      if (listenerCount === 0 && activeUnlisten) {
        activeUnlisten();
        activeUnlisten = null;
      }
    };
  },
}));

// ---------------------------------------------------------------------------
// Context usage listener (claude-events -> per-session context %)
// ---------------------------------------------------------------------------

/**
 * Fold a claude-events batch into per-session context usage.
 *
 * Events arrive in transcript order, so within a batch the last
 * ContextUsageUpdate per session wins — that is the latest assistant
 * message's context. Sessions without new events are left untouched, which
 * is what keeps idle sessions at their last-known percentage.
 */
function applyContextUsageEvents(events: ClaudeEvent[]): void {
  const updates = new Map<number, ContextUsage>();
  for (const event of events) {
    if (event.event_type === "ContextUsageUpdate") {
      updates.set(event.session_id, {
        percent: event.percent,
        tokens: event.context_tokens,
        window: event.context_window,
      });
    }
  }
  if (updates.size === 0) return;

  for (const [sessionId, usage] of updates) {
    lastContextUsage.set(sessionId, usage);
  }

  useSessionStore.setState((state) => {
    let changed = false;
    const sessions = state.sessions.map((s) => {
      const usage = updates.get(s.id);
      if (
        !usage ||
        (s.contextPercent === usage.percent && s.contextTokens === usage.tokens)
      ) {
        return s;
      }
      changed = true;
      return {
        ...s,
        contextPercent: usage.percent,
        contextTokens: usage.tokens,
        contextWindow: usage.window,
      };
    });
    // No-op guard: don't replace the array (and re-render subscribers) when
    // nothing changed — e.g. the session isn't in the store yet (the map
    // buffers the value for addSession/fetchSessions to apply).
    return changed ? { sessions } : state;
  });
}

// Global claude-events listener. `active` tracks the *desired* state so an
// init/stop pair that races the pending listen() promise (React StrictMode's
// dev double-mount) can't leak a second listener. Mirrors useActivityStore.
let contextUnlisten: UnlistenFn | null = null;
let contextStarting: Promise<void> | null = null;
let contextActive = false;

export async function initContextUsageListener(): Promise<void> {
  contextActive = true;
  if (contextUnlisten || contextStarting) return;
  contextStarting = listen<ClaudeEvent[]>("claude-events", (event) => {
    applyContextUsageEvents(event.payload);
  })
    .then((fn) => {
      if (!contextActive) {
        fn();
        return;
      }
      contextUnlisten = fn;
    })
    .finally(() => {
      contextStarting = null;
    });
  await contextStarting;
}

export function stopContextUsageListener(): void {
  contextActive = false;
  if (contextUnlisten) {
    contextUnlisten();
    contextUnlisten = null;
  }
}

// ---------------------------------------------------------------------------
// Samurai supervisor listener (samurai-supervisor-event + samurai-allowance-
// event -> badge map, DEAD => error chrome, allowance => attention)
// ---------------------------------------------------------------------------

/**
 * Subset of the backend's `SessionSnapshot` payload (emitted on every Samurai
 * supervisor state change) that the listener uses.
 */
interface SamuraiSupervisorEvent {
  session_id: number;
  /** Canonical project path, `\\?\` prefix already stripped by the backend. */
  project: string;
  epic: string;
  generation: number;
  state: string;
}

/** Terminal supervisor states — sessions past saving, no allowance attention. */
const SAMURAI_TERMINAL_STATES = new Set(["KILLED", "PARKED", "DEAD"]);

/**
 * Supervisor states whose backend teardown already ran, so the frontend must
 * close the tile (TerminalGrid's samurai-close effect): KILLED (replication,
 * issue #55) and PARKED (allowance park, issue #60 — resume is always a fresh
 * spawn, a parked terminal serves no purpose). DEAD deliberately stays open:
 * that tile shows the error until a human dismisses it.
 */
export const SAMURAI_TILE_CLOSE_STATES: ReadonlySet<string> = new Set(["KILLED", "PARKED"]);

/**
 * Tracks every supervisor state change into `samuraiBySessionId` (the badge
 * data for issue #46), and surfaces a watchdog-declared death (issue #44):
 * a crashed claude fires no hook, so without this the session would sit on
 * its last MCP status — usually "Working" — forever. On a DEAD supervisor
 * event the session flips to Error chrome and gets the same unpark +
 * attention treatment as an auto-unparked NeedsInput session.
 */
function applySamuraiSupervisorEvent(payload: SamuraiSupervisorEvent): void {
  useSessionStore.setState((state) => {
    const samuraiBySessionId: Record<number, SamuraiSessionInfo> = {
      ...state.samuraiBySessionId,
      [payload.session_id]: {
        project: payload.project,
        epic: payload.epic,
        generation: payload.generation,
        state: payload.state as SamuraiSupervisorState,
      },
    };
    if (payload.state !== "DEAD") return { samuraiBySessionId };
    const session = state.sessions.find(
      (s) => s.id === payload.session_id && samePath(s.project_path, payload.project)
    );
    if (!session) return { samuraiBySessionId };
    return {
      samuraiBySessionId,
      sessions: state.sessions.map((s) =>
        s === session
          ? {
              ...s,
              status: "Error" as BackendSessionStatus,
              statusMessage: "claude process died (Samurai watchdog)",
            }
          : s
      ),
      parkedSessionIds: state.parkedSessionIds.filter((id) => id !== payload.session_id),
      attentionSessionIds: state.attentionSessionIds.includes(payload.session_id)
        ? state.attentionSessionIds
        : [...state.attentionSessionIds, payload.session_id],
    };
  });
}

/**
 * Allowance threshold crossed (issue #45, edge-triggered ~once per window):
 * flag every live supervised session with the existing attention highlight —
 * those are the runs the crossing is about (issue #46: existing attention
 * mechanism, no new alert UI). Details land as ALERT rows in the audit
 * stream; non-supervised sessions stay untouched.
 */
function applySamuraiAllowanceEvent(): void {
  useSessionStore.setState((state) => {
    const flagged = state.sessions
      .filter((s) => {
        const info = state.samuraiBySessionId[s.id];
        return (
          info !== undefined &&
          !SAMURAI_TERMINAL_STATES.has(info.state) &&
          samePath(s.project_path, info.project)
        );
      })
      .map((s) => s.id)
      .filter((id) => !state.attentionSessionIds.includes(id));
    // No-op guard: nothing supervised (or all already flagged) — don't
    // replace the array and re-render subscribers.
    if (flagged.length === 0) return state;
    return { attentionSessionIds: [...state.attentionSessionIds, ...flagged] };
  });
}

/**
 * Seeds `samuraiBySessionId` from the supervisor's current snapshots, so
 * sessions registered before this frontend mounted (dev reload, late mount)
 * still get badges. Live events won the race for any id already present.
 */
async function seedSamuraiSessions(): Promise<void> {
  try {
    const snapshots = await samuraiListSessions();
    // Defensive: a mocked/failed IPC layer may hand back a non-array.
    if (!Array.isArray(snapshots) || snapshots.length === 0) return;
    useSessionStore.setState((state) => {
      const samuraiBySessionId = { ...state.samuraiBySessionId };
      for (const snapshot of snapshots) {
        if (samuraiBySessionId[snapshot.session_id]) continue;
        samuraiBySessionId[snapshot.session_id] = {
          project: snapshot.project,
          epic: snapshot.epic,
          generation: snapshot.generation,
          state: snapshot.state,
        };
      }
      return { samuraiBySessionId };
    });
  } catch (err) {
    console.error("Failed to seed samurai supervised sessions:", err);
  }
}

// Same StrictMode-safe init/stop shape as the context usage listener above.
let samuraiUnlisten: UnlistenFn | null = null;
let samuraiStarting: Promise<void> | null = null;
let samuraiActive = false;

export async function initSamuraiSupervisorListener(): Promise<void> {
  samuraiActive = true;
  if (samuraiUnlisten || samuraiStarting) return;
  samuraiStarting = Promise.all([
    listen<SamuraiSupervisorEvent>("samurai-supervisor-event", (event) => {
      applySamuraiSupervisorEvent(event.payload);
    }),
    listen("samurai-allowance-event", () => {
      applySamuraiAllowanceEvent();
    }),
  ])
    .then((fns) => {
      const unlistenAll = () => fns.forEach((fn) => fn());
      if (!samuraiActive) {
        unlistenAll();
        return;
      }
      samuraiUnlisten = unlistenAll;
    })
    .finally(() => {
      samuraiStarting = null;
    });
  await samuraiStarting;
  void seedSamuraiSessions();
}

export function stopSamuraiSupervisorListener(): void {
  samuraiActive = false;
  if (samuraiUnlisten) {
    samuraiUnlisten();
    samuraiUnlisten = null;
  }
}

