import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { notifyOs } from "@/lib/osNotification";
import { formatResumeAt } from "@/lib/parkTime";
import { normalizePath, samePath } from "@/lib/path";
import {
  isBreakerParked,
  isParkEntry,
  type SamuraiAuditEventPayload,
  type SamuraiRunListEntry,
  type SamuraiScheduleEntry,
  type SamuraiSupervisorState,
  samuraiListRuns,
  samuraiListSessions,
  samuraiRunFatalLabel,
  samuraiScheduleList,
} from "@/lib/samurai";
import { useAgentStore } from "@/stores/useAgentStore";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import type { ClaudeEvent } from "@/types/claude-events";

export type { SamuraiScheduleEntry, SamuraiSupervisorState };

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
 * How long a subagent may sit un-completed before the Stop-hook heuristic
 * stops believing it is still running (issue #77).
 *
 * The heuristic below holds a session at `Working` while any subagent it
 * spawned has no completion recorded. A completion event that never arrives
 * (missed notification, transcript gap) used to pin the session — and its
 * animated dots — at `Working` forever. Subagents are always spawned within
 * the turn the Stop hook is closing, i.e. seconds to minutes old, so half an
 * hour is far more than any legitimate hand-off needs while still bounding
 * the stale state instead of leaving it permanent.
 */
const SUBAGENT_STALE_MS = 30 * 60 * 1000;

/**
 * Statuses that mean the terminal is done running and the next move is the
 * user's — the "ready to go" states. Reaching one of these while parked brings
 * the session back into the grid (see the auto-unpark rule in `initListeners`).
 *
 * `Done` and `Error` matter as much as `NeedsInput`: an agent that reports
 * `finished` or `error` over MCP never emits NeedsInput afterwards, so a parked
 * session that completed its work used to stay hidden indefinitely.
 */
const READY_FOR_USER_STATUSES: BackendSessionStatus[] = ["NeedsInput", "Done", "Error", "Timeout"];

/**
 * Mirrors the Rust `SessionConfig` struct returned by `get_sessions`.
 *
 * Status is deliberately absent (issue #134): the Rust `SessionManager` is an
 * in-memory `DashMap` with no persistence, so it has nothing authoritative to
 * say about a session's lifecycle state. Status is owned here, fed by the MCP
 * `session-status-changed` stream.
 *
 * @property id - Unique numeric session ID assigned by the backend.
 * @property branch - Git branch the session operates on, or null for the default branch.
 * @property worktree_path - Filesystem path to the git worktree, if one was created.
 * @property project_path - Canonicalized project directory this session belongs to.
 */
export interface BackendSessionRow {
  id: number;
  mode: AiMode;
  name?: string | null;
  branch: string | null;
  worktree_path: string | null;
  project_path: string;
  /** The actual directory the shell was spawned in (may differ from project_path in multi-repo workspaces). */
  working_directory?: string | null;
}

/**
 * A session as the store holds it: the backend row plus the frontend-owned
 * lifecycle state.
 *
 * @property status - Frontend-owned lifecycle state (see {@link BackendSessionRow}).
 * @property statusMessage - Brief description of what the agent is doing (from MCP status).
 * @property needsInputPrompt - When status is NeedsInput, the specific question for the user.
 */
export interface SessionConfig extends BackendSessionRow {
  status: BackendSessionStatus;
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
 * Statuses that exist only on the `session-status-changed` wire, never on a
 * session — hook-derived signals the store interprets against the session's
 * current state (see resolveStatusEvent):
 * - "AwaitingInput": Stop hook — the agent ended its turn, user's move.
 * - "SessionEnded": SessionEnd hook — the claude process exited.
 */
type WireOnlyStatus = "AwaitingInput" | "SessionEnded";

/**
 * Raw wire payload for `session-status-changed`. Wire-only statuses are
 * normalized by resolveStatusEvent before they reach a session, so they
 * never appear in the store.
 */
type RawSessionStatusPayload = Omit<SessionStatusPayload, "status"> & {
  status: BackendSessionStatus | WireOnlyStatus;
};

/** Output of resolveStatusEvent: what to write onto the session. */
interface ResolvedStatus {
  status: BackendSessionStatus;
  statusMessage?: string;
  needsInputPrompt?: string;
}

/**
 * The single signal→state merge rule for `session-status-changed` events
 * (issue #105). Pure so the mapping is unit-testable as a table.
 *
 * @param payload - The raw wire payload (status + message + prompt).
 * @param existingStatus - The session's current status, or undefined when the
 *   session isn't in the store yet (the event will be buffered).
 * @param runningSubagents - Count of this session's still-running background
 *   subagents (only consulted for "AwaitingInput").
 * @returns The fields to write, or null when the event must be DROPPED.
 *
 * Rules, in order:
 * 1. "AwaitingInput" (Stop hook, fires on every turn end):
 *    - dropped when the agent reported Done/Error during THIS very turn
 *      (`terminalReportedThisTurn`) — the Stop hook is the tail of that same
 *      turn and must not overwrite what it said. The session's *current*
 *      status is deliberately not consulted: one stale Done would otherwise
 *      swallow every later turn end, forever (issue #77 cause 1), and a live
 *      Stop is better evidence than a startup Timeout heuristic;
 *    - while background subagents still run it means "handed off", not
 *      "waiting on you" → Working;
 *    - otherwise → NeedsInput.
 * 2. "SessionEnded" (SessionEnd hook, the claude process exited): whatever
 *    the session showed is stale → Idle, clearing any needs-input prompt.
 *    Done/Error survive — the user still wants to see the outcome.
 * 3. "NeedsInput" (Notification hook, AskUserQuestion, or the MCP tool):
 *    dropped on Done/Error — the CLI's 60s idle-prompt reminder fires after
 *    every turn and must not repaint a finished session red. Timeout is
 *    deliberately NOT protected: an explicit needs-input proves the CLI is
 *    alive, recovering a false startup timeout.
 * 4. Everything else applies verbatim (last writer wins).
 */
export function resolveStatusEvent(
  payload: Pick<RawSessionStatusPayload, "status" | "message" | "needs_input_prompt">,
  existingStatus: BackendSessionStatus | undefined,
  runningSubagents: number,
  terminalReportedThisTurn = false,
): ResolvedStatus | null {
  const terminal: BackendSessionStatus[] = ["Done", "Error"];

  if (payload.status === "AwaitingInput") {
    if (terminalReportedThisTurn) {
      return null;
    }
    // The Stop hook fires whenever the agent ends its turn — including when
    // it ends the turn precisely because it handed work off to background
    // subagents. Those are still running, so the session is working, not
    // waiting on the user. Self-correcting: the next turn end, once no
    // subagent is running, reports NeedsInput as normal.
    if (runningSubagents > 0) {
      return {
        status: "Working",
        statusMessage: `${runningSubagents} subagent${runningSubagents === 1 ? "" : "s"} running`,
        needsInputPrompt: payload.needs_input_prompt,
      };
    }
    return {
      status: "NeedsInput",
      statusMessage: payload.message,
      needsInputPrompt: payload.needs_input_prompt,
    };
  }

  if (payload.status === "SessionEnded") {
    if (existingStatus !== undefined && terminal.includes(existingStatus)) {
      return null;
    }
    return { status: "Idle", statusMessage: payload.message, needsInputPrompt: undefined };
  }

  if (payload.status === "NeedsInput") {
    if (existingStatus !== undefined && terminal.includes(existingStatus)) {
      return null;
    }
  }

  return {
    status: payload.status,
    statusMessage: payload.message,
    needsInputPrompt: payload.needs_input_prompt,
  };
}

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
 * A queued samurai toast — a run-fatal event (issue #174) or an allowance
 * park. Both queue through the same slice so the stack has one cap, one
 * dismiss path and one priority order; only the tint and the wording differ.
 */
export interface SamuraiToast {
  id: string;
  /**
   * `allowance` is the account-wide crossing raised when NOTHING is
   * supervised (see {@link applySamuraiAllowanceEvent}) — it carries no run,
   * so it renders with the fatal chrome rather than the park chrome, which
   * would claim a run went away.
   */
  kind: "fatal" | "park" | "allowance";
  /** Canonical project path the event belongs to. */
  project: string;
  epic: string;
  /** Orchestrator generation; 0 on park toasts (a resume timer has none). */
  generation: number;
  /** What happened: the fatal label, or the park's resume reading. */
  label: string;
}

/** Keep at most this many queued samurai toasts; oldest are dropped first. */
const MAX_SAMURAI_TOASTS = 6;

/** What the startup seed calls an already-interrupted run — the same wording
 *  `samuraiRunFatalLabel` gives the live `reconcile_interrupted` row, so the
 *  two paths never describe the same state two ways. */
const INTERRUPTED_RUN_LABEL = "Run was interrupted — resume or abandon it";

/** What the startup seed calls a breaker-parked run (issue #209). Distinct
 *  wording from the interrupted one because the cause is different: nothing
 *  crashed, supervision stopped it on purpose and only a human restarts it. */
const BREAKER_PARK_LABEL = "Circuit breaker parked this run — resume or abandon it";

/**
 * One run the circuit breaker parked (issue #209), as the chips read it.
 *
 * Kept in the store rather than derived from `samuraiSchedule` because a
 * breaker park arms NO timer — that is the whole point of it — so the
 * schedule, which is the source for every other park surface, knows nothing
 * about it. Seeded from the run list at startup and refreshed by the Active
 * Runs panel, so a resume or an abandon takes the chip with it.
 */
/** Shared identity of one run across the surfaces that can resume it. */
export function samuraiRunKey(project: string, epic: string): string {
  return `${normalizePath(project)}|${epic.trim()}`;
}

export interface SamuraiBreakerPark {
  /** Canonical project path of the parked run. */
  project: string;
  /** The run's identity string — what the resume command is called with. */
  epic: string;
  /** RFC 3339 UTC time of the park. */
  at: string;
}

let samuraiToastSeq = 0;

/**
 * One allowance-parked Samurai run the user has not looked at yet.
 *
 * A park is not fatal — it resumes on its own — so it deliberately raises no
 * error chrome. But it can last a week, and the user is away for most of it:
 * this marker is what makes a park still visible when they come back, long
 * after the toast is gone. It is derived from (and pruned to) the live
 * resume-timer list, so a fired or cancelled timer takes its marker with it.
 */
export interface SamuraiParkAlert {
  /** Dedupe + acknowledge key: normalized project, epic and fire time. */
  key: string;
  /** Canonical project path of the parked run. */
  project: string;
  epic: string;
  /** RFC 3339 resume time — every reading goes through `lib/parkTime`. */
  fireAt: string;
  /** Seen by the user: the surfaces stay legible but stop shining. */
  acknowledged: boolean;
}

/** Identity of a park across schedule events (the list re-emits in full). */
function parkAlertKey(entry: SamuraiScheduleEntry): string {
  return `${normalizePath(entry.project_path)}|${entry.epic}|${entry.fire_at}`;
}

/** Last path segment — the name the tab strip and the toast kicker use. */
function projectLabel(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
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
   * Subset of `attentionSessionIds` that was set by a run-fatal audit row
   * (issue #174) rather than the auto-unpark-while-parked flow above.
   * Tracked separately so `parkSession` can tell the two attention flavors
   * apart: the auto-unpark highlight is stale once the session is hidden
   * again by a fresh park, but a run-fatal highlight IS the point of that
   * park (the session was just auto-parked because the run died) and must
   * survive it so the parked shelf can still show it.
   */
  runFatalSessionIds: number[];
  /**
   * Terminals the user pinned. A pinned terminal keeps showing in the pinned
   * strip under the grid even while ANOTHER project is the active one — the
   * only way to watch project A's agent while working in project B.
   *
   * In-memory only, same rationale as parkedSessionIds: session IDs are
   * reassigned each app launch, so a persisted pin would come back pointing
   * at an unrelated new terminal.
   */
  pinnedSessionIds: number[];
  /**
   * Samurai-supervised sessions, keyed by session id — fed by
   * `samurai-supervisor-event` and seeded from `samurai_list_sessions` on
   * listener init. Sessions absent from this map are not supervised and
   * render no Samurai chrome (issue #46: non-supervised sessions unchanged).
   */
  samuraiBySessionId: Record<number, SamuraiSessionInfo>;
  /**
   * Every pending Samurai resume timer, all projects (issue #61; PRD §9 park
   * countdown) — fed by `samurai-schedule-event` (full list per event) and
   * seeded from `samurai_schedule_list` on listener init. Drives the
   * project-level "parked — resumes at HH:MM" chip.
   */
  samuraiSchedule: SamuraiScheduleEntry[];
  /**
   * Queued toasts for RUN-FATAL samurai events (issue #174) — a supervised
   * run that died or stranded silently must come to the human. Transition-
   * only by construction (each audit row is emitted once), queued only while
   * notifications are enabled; the attention badge is set regardless.
   */
  samuraiToasts: SamuraiToast[];
  /**
   * Allowance parks awaiting the user's eye (see {@link SamuraiParkAlert}) —
   * derived from `samuraiSchedule`, and the one park surface that survives an
   * app restart's worth of absence.
   */
  samuraiParkAlerts: SamuraiParkAlert[];
  /**
   * Runs the circuit breaker parked (see {@link SamuraiBreakerPark}) — the
   * one park kind that arms no timer, so it appears nowhere in
   * `samuraiSchedule` and needs its own list.
   */
  samuraiBreakerParks: SamuraiBreakerPark[];
  /**
   * Runs whose resume is in flight right now, as {@link samuraiRunKey}s.
   *
   * SHARED, because two surfaces offer the same one-click resume — the
   * Active Runs row and the park chip — and each only knew about its own
   * click. `recover_run_inner` takes no lock and its "no live session" check
   * cannot bite until the successor registers, so the second click staged a
   * duplicate gen-N+1 into the same worktree (the hazard PR #131 review F2
   * closed for two clicks on ONE surface).
   */
  samuraiResumingRuns: string[];
  isLoading: boolean;
  error: string | null;
  parkSession: (sessionId: number) => void;
  unparkSession: (sessionId: number) => void;
  toggleSessionFlag: (sessionId: number) => void;
  /** Pin/unpin a terminal so it stays visible from every project. */
  toggleSessionPin: (sessionId: number) => void;
  clearSessionAttention: (sessionId: number) => void;
  dismissSamuraiToast: (id: string) => void;
  /** Clears the queue outright — used when notifications are switched off. */
  dismissAllSamuraiToasts: () => void;
  /** Marks parks seen — one project's, or every project's when omitted. */
  acknowledgeSamuraiParks: (projectPath?: string) => void;
  /** Replaces the breaker-park list wholesale — the run list is the truth,
   *  and a resumed or abandoned run must lose its chip. */
  setSamuraiBreakerParks: (parks: SamuraiBreakerPark[]) => void;
  /** Marks one run's resume as in flight, or done — see
   *  {@link SessionStore.samuraiResumingRuns}. */
  setSamuraiRunResuming: (project: string, epic: string, resuming: boolean) => void;
  fetchSessions: () => Promise<void>;
  fetchSessionsForProject: (projectPath: string) => Promise<void>;
  addSession: (session: SessionConfig) => void;
  removeSession: (sessionId: number) => void;
  removeSessionsForProject: (projectPath: string) => Promise<BackendSessionRow[]>;
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

/**
 * Fold one freshly fetched backend row into the store's view of that session.
 *
 * Status is frontend-owned (issue #134), so a row for a session already in the
 * store keeps its live `status`, `statusMessage` and `needsInputPrompt` — a
 * refetch used to clobber them back to the backend's phantom `Idle`. A row new
 * to the store has no live state to preserve and starts at `Idle`.
 */
function mergeFetchedSession(row: BackendSessionRow, current: SessionConfig[]): SessionConfig {
  const existing = current.find((s) => s.id === row.id);
  // Backend-owned fields (branch, worktree, name, paths) always win; the
  // frontend-owned status fields survive because `row` does not carry them.
  const merged: SessionConfig = existing ? { ...existing, ...row } : { ...row, status: "Idle" };
  return withContextUsage(merged);
}

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

/**
 * Generate a unique key for buffering status updates.
 *
 * The path is normalized (issue #77): the session and the status event can
 * spell the same directory differently (Windows `\\?\` prefix, drive-letter
 * case, trailing separator), and a raw-string key would park the update under
 * a name the session lookup never asks for — losing it permanently.
 */
function statusBufferKey(sessionId: number, projectPath: string): string {
  return `${sessionId}:${normalizePath(projectPath)}`;
}

/**
 * Sessions whose agent reported a terminal state (`Done`/`Error`) over MCP
 * during the turn that is currently ending.
 *
 * The Stop hook fires at every turn end. Honouring the session's *current*
 * status instead used to drop every stop for a session that had ever reported
 * `Done` — it stayed "done" through all later work and never flagged that it
 * was waiting on the user (issue #77 cause 1). The entry is consumed by the
 * Stop hook that closes the same turn, so the next turn starts clean.
 */
const terminalReportedThisTurn: Set<number> = new Set();

/**
 * Pending re-checks for sessions held at `Working` by subagents that never
 * reported completion. Key is session ID (see `SUBAGENT_STALE_MS`).
 */
const subagentWatchdogs: Map<number, ReturnType<typeof setTimeout>> = new Map();

/** Subagents of a session that are still plausibly running (see SUBAGENT_STALE_MS). */
function countRunningSubagents(sessionId: number): number {
  const now = Date.now();
  return useAgentStore.getState().agents.filter((a) => {
    if (a.sessionId !== sessionId || a.completedAt !== null) return false;
    const spawned = Date.parse(a.spawnedAt);
    // An unreadable spawn timestamp cannot be aged out, so it is not
    // trusted to keep a session pinned at Working.
    if (Number.isNaN(spawned)) return false;
    return now - spawned < SUBAGENT_STALE_MS;
  }).length;
}

/**
 * Milliseconds until the last of this session's running subagents goes stale,
 * or null when none of them counts as running right now.
 */
function msUntilSubagentsGoStale(sessionId: number): number | null {
  const now = Date.now();
  let longest: number | null = null;
  for (const a of useAgentStore.getState().agents) {
    if (a.sessionId !== sessionId || a.completedAt !== null) continue;
    const spawned = Date.parse(a.spawnedAt);
    if (Number.isNaN(spawned)) continue;
    const remaining = SUBAGENT_STALE_MS - (now - spawned);
    if (remaining <= 0) continue;
    if (longest === null || remaining > longest) longest = remaining;
  }
  return longest;
}

/** Cancels a pending subagent re-check (fresher news arrived, or the session went away). */
function clearSubagentWatchdog(sessionId: number): void {
  const timer = subagentWatchdogs.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    subagentWatchdogs.delete(sessionId);
  }
}

/**
 * Schedules the re-check that bounds a subagent-driven `Working` state.
 *
 * When it fires, subagents still without a completion have aged past
 * `SUBAGENT_STALE_MS`: either newer ones are genuinely running (re-arm), or
 * the session has actually stopped and its dots must stop with it, so it lands
 * on the `NeedsInput` the Stop hook would have produced.
 */
function armSubagentWatchdog(sessionId: number, projectPath: string): void {
  clearSubagentWatchdog(sessionId);
  const delay = msUntilSubagentsGoStale(sessionId);
  if (delay === null) return;

  const timer = setTimeout(() => {
    subagentWatchdogs.delete(sessionId);
    if (countRunningSubagents(sessionId) > 0) {
      armSubagentWatchdog(sessionId, projectPath);
      return;
    }
    useSessionStore.setState((state) => {
      const target = state.sessions.find(
        (s) => s.id === sessionId && samePath(s.project_path, projectPath),
      );
      // Anything else that moved the session on already knows better.
      if (target?.status !== "Working") return state;
      return {
        sessions: state.sessions.map((s) =>
          s === target
            ? {
                ...s,
                status: "NeedsInput" as BackendSessionStatus,
                statusMessage: "Subagents stopped reporting - waiting for your input",
              }
            : s,
        ),
      };
    });
  }, delay);

  subagentWatchdogs.set(sessionId, timer);
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
  runFatalSessionIds: [],
  pinnedSessionIds: [],
  samuraiBySessionId: {},
  samuraiSchedule: [],
  samuraiToasts: [],
  samuraiParkAlerts: [],
  samuraiBreakerParks: [],
  samuraiResumingRuns: [],
  isLoading: false,
  error: null,

  parkSession: (sessionId: number) => {
    set((state) => {
      const alreadyParked = state.parkedSessionIds.includes(sessionId);
      const hasAttention = state.attentionSessionIds.includes(sessionId);
      const isRunFatal = state.runFatalSessionIds.includes(sessionId);
      // No-op guard: don't replace arrays (and re-render subscribers)
      // when nothing changes.
      if (alreadyParked && !hasAttention) return state;
      return {
        parkedSessionIds: alreadyParked
          ? state.parkedSessionIds
          : [...state.parkedSessionIds, sessionId],
        // Parking is a deliberate act on the session — an auto-unpark
        // attention highlight would be stale once it's hidden again. A
        // run-fatal highlight (issue #174) is the opposite: TerminalGrid's
        // auto-park effect IS the fatal event playing out, so wiping the
        // badge here erased it milliseconds after it was set — keep it so
        // the parked shelf can still show it.
        attentionSessionIds:
          hasAttention && !isRunFatal
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

  toggleSessionPin: (sessionId: number) => {
    set((state) => ({
      pinnedSessionIds: state.pinnedSessionIds.includes(sessionId)
        ? state.pinnedSessionIds.filter((id) => id !== sessionId)
        : [...state.pinnedSessionIds, sessionId],
    }));
  },

  clearSessionAttention: (sessionId: number) => {
    set((state) =>
      state.attentionSessionIds.includes(sessionId)
        ? {
            attentionSessionIds: state.attentionSessionIds.filter((id) => id !== sessionId),
            runFatalSessionIds: state.runFatalSessionIds.includes(sessionId)
              ? state.runFatalSessionIds.filter((id) => id !== sessionId)
              : state.runFatalSessionIds,
          }
        : state,
    );
  },

  dismissSamuraiToast: (id: string) => {
    set((state) => ({
      samuraiToasts: state.samuraiToasts.filter((t) => t.id !== id),
    }));
  },

  dismissAllSamuraiToasts: () => {
    set((state) => (state.samuraiToasts.length === 0 ? state : { samuraiToasts: [] }));
  },

  acknowledgeSamuraiParks: (projectPath?: string) => {
    set((state) => {
      let changed = false;
      const samuraiParkAlerts = state.samuraiParkAlerts.map((alert) => {
        if (alert.acknowledged) return alert;
        if (projectPath !== undefined && !samePath(alert.project, projectPath)) return alert;
        changed = true;
        return { ...alert, acknowledged: true };
      });
      // No-op guard: nothing left to acknowledge — don't re-render the chips.
      return changed ? { samuraiParkAlerts } : state;
    });
  },

  setSamuraiBreakerParks: (parks: SamuraiBreakerPark[]) => {
    set((state) => {
      // No-op guard: this runs on every Active Runs refresh, and the list is
      // empty on virtually all of them.
      const same =
        state.samuraiBreakerParks.length === parks.length &&
        state.samuraiBreakerParks.every(
          (p, i) => samePath(p.project, parks[i].project) && p.epic === parks[i].epic,
        );
      return same ? state : { samuraiBreakerParks: parks };
    });
  },

  setSamuraiRunResuming: (project: string, epic: string, resuming: boolean) => {
    set((state) => {
      const key = samuraiRunKey(project, epic);
      const present = state.samuraiResumingRuns.includes(key);
      if (present === resuming) return state;
      return {
        samuraiResumingRuns: resuming
          ? [...state.samuraiResumingRuns, key]
          : state.samuraiResumingRuns.filter((k) => k !== key),
      };
    });
  },

  fetchSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const fetched = await invoke<BackendSessionRow[]>("get_sessions");
      set((state) => {
        // Keep live status (and last-known context usage) — the backend
        // carries neither.
        const sessions = fetched.map((row) => mergeFetchedSession(row, state.sessions));
        return {
          sessions,
          isLoading: false,
          // Prune parked/flagged/attention IDs that no longer exist in the fetched list
          parkedSessionIds: state.parkedSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
          flaggedSessionIds: state.flaggedSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
          attentionSessionIds: state.attentionSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
          runFatalSessionIds: state.runFatalSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
          pinnedSessionIds: state.pinnedSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
        };
      });
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
      set({ error: String(err), isLoading: false });
    }
  },

  fetchSessionsForProject: async (projectPath: string) => {
    set({ isLoading: true, error: null });
    try {
      const fetched = await invoke<BackendSessionRow[]>("get_sessions_for_project", {
        projectPath,
      });
      set((state) => {
        // Keep live status (and last-known context usage) — the backend
        // carries neither.
        const sessions = fetched.map((row) => mergeFetchedSession(row, state.sessions));
        return {
          sessions,
          isLoading: false,
          // Prune parked/flagged/attention IDs that no longer exist in the fetched list
          parkedSessionIds: state.parkedSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
          flaggedSessionIds: state.flaggedSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
          attentionSessionIds: state.attentionSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
          runFatalSessionIds: state.runFatalSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
          pinnedSessionIds: state.pinnedSessionIds.filter((id) =>
            sessions.some((s) => s.id === id),
          ),
        };
      });
    } catch (err) {
      console.error("Failed to fetch sessions for project:", err);
      set({ error: String(err), isLoading: false });
    }
  },

  addSession: (session: SessionConfig) => {
    // Take this session's own buffered status FIRST: the purge below matches
    // every key for the id, so reading afterwards always found nothing and the
    // whole buffer was dead weight — a status that beat its session into the
    // store (a turn end during startup, say) was silently dropped (issue #77).
    const bufferKey = statusBufferKey(session.id, session.project_path);
    const bufferedStatus = pendingStatusUpdates.get(bufferKey);

    // Clear any stale buffered status for this session ID across ALL projects
    // This prevents pollution from old sessions with the same ID
    for (const key of pendingStatusUpdates.keys()) {
      if (key.startsWith(`${session.id}:`)) {
        console.log(`[SessionStore] Clearing stale buffered status for key: '${key}'`);
        pendingStatusUpdates.delete(key);
      }
    }

    console.log(
      `[SessionStore] addSession id=${session.id} project_path='${session.project_path}'`,
    );
    console.log(
      `[SessionStore] Buffer key: '${bufferKey}', has buffered status: ${!!bufferedStatus}`,
    );
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
          console.warn(
            `[SessionStore] Session ${session.id} startup timeout after ${SESSION_STARTUP_TIMEOUT_MS}ms`,
          );
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === session.id
                ? {
                    ...s,
                    status: "Timeout" as BackendSessionStatus,
                    statusMessage: "CLI failed to start - check terminal for errors",
                  }
                : s,
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
      sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, ...updates } : s)),
    }));
  },

  renameSession: async (sessionId: number, name: string | null) => {
    try {
      const updated = await invoke<BackendSessionRow>("rename_session", {
        sessionId,
        name,
      });
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, name: updated.name } : s,
        ),
      }));
    } catch (err) {
      console.error("Failed to rename session:", err);
    }
  },

  removeSession: (sessionId: number) => {
    // Clear any startup timeout for this session
    clearStartupTimeout(sessionId);

    // Same stale-id hygiene for the turn bookkeeping: a future session reusing
    // this id must not inherit a pending re-check or a "reported done" mark.
    clearSubagentWatchdog(sessionId);
    terminalReportedThisTurn.delete(sessionId);

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
        runFatalSessionIds: state.runFatalSessionIds.filter((id) => id !== sessionId),
        pinnedSessionIds: state.pinnedSessionIds.filter((id) => id !== sessionId),
        samuraiBySessionId,
      };
    });
  },

  removeSessionsForProject: async (projectPath: string) => {
    try {
      const removed = await invoke<BackendSessionRow[]>("remove_sessions_for_project", {
        projectPath,
      });
      // Same stale-id hygiene as removeSession.
      for (const session of removed) {
        lastContextUsage.delete(session.id);
        clearSubagentWatchdog(session.id);
        terminalReportedThisTurn.delete(session.id);
      }
      // Remove the sessions from local state
      set((state) => {
        const samuraiBySessionId = { ...state.samuraiBySessionId };
        for (const session of removed) {
          delete samuraiBySessionId[session.id];
        }
        return {
          sessions: state.sessions.filter((s) => !removed.some((r) => r.id === s.id)),
          parkedSessionIds: state.parkedSessionIds.filter(
            (id) => !removed.some((r) => r.id === id),
          ),
          flaggedSessionIds: state.flaggedSessionIds.filter(
            (id) => !removed.some((r) => r.id === id),
          ),
          attentionSessionIds: state.attentionSessionIds.filter(
            (id) => !removed.some((r) => r.id === id),
          ),
          runFatalSessionIds: state.runFatalSessionIds.filter(
            (id) => !removed.some((r) => r.id === id),
          ),
          pinnedSessionIds: state.pinnedSessionIds.filter(
            (id) => !removed.some((r) => r.id === id),
          ),
          samuraiBySessionId,
        };
      });
      return removed;
    } catch (err) {
      console.error("Failed to remove sessions for project:", err);
      // The backend rejects whenever `canonicalize` fails on the project path
      // — a directory that was moved, deleted, or sits on a drive that went
      // away — and `closeTab` drops the tab either way. Returning early left
      // that project's sessions in the store with no tab left to reach them:
      // stale parked chips in the eagle shelf and inflated session/agent
      // counts, forever (issue #76). Prune them locally instead; their PTYs
      // were already killed alongside this call.
      const orphaned = get().sessions.filter((s) => samePath(s.project_path, projectPath));
      if (orphaned.length === 0) return [];
      const isOrphan = (id: number) => orphaned.some((s) => s.id === id);
      // Same stale-id hygiene as the success path.
      for (const session of orphaned) {
        lastContextUsage.delete(session.id);
        clearSubagentWatchdog(session.id);
        terminalReportedThisTurn.delete(session.id);
      }
      set((state) => {
        const samuraiBySessionId = { ...state.samuraiBySessionId };
        for (const session of orphaned) {
          delete samuraiBySessionId[session.id];
        }
        return {
          sessions: state.sessions.filter((s) => !isOrphan(s.id)),
          parkedSessionIds: state.parkedSessionIds.filter((id) => !isOrphan(id)),
          flaggedSessionIds: state.flaggedSessionIds.filter((id) => !isOrphan(id)),
          attentionSessionIds: state.attentionSessionIds.filter((id) => !isOrphan(id)),
          runFatalSessionIds: state.runFatalSessionIds.filter((id) => !isOrphan(id)),
          pinnedSessionIds: state.pinnedSessionIds.filter((id) => !isOrphan(id)),
          samuraiBySessionId,
        };
      });
      // The backend still holds them: nothing was removed there.
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
            const { session_id, project_path } = event.payload;

            // samePath, not strict equality: the backend canonicalizes paths
            // (`\\?\C:\…` on Windows) and a form mismatch here silently
            // buffers every status event forever — the session then never
            // updates (issues #77/#105).
            const existing = get().sessions.find(
              (s) => s.id === session_id && samePath(s.project_path, project_path),
            );

            // Subagent count is only consulted for the Stop-hook signal.
            // Bounded by SUBAGENT_STALE_MS (and the watchdog armed below), so
            // a completion event that never arrives cannot pin the session at
            // Working (issue #77 cause 4).
            const runningSubagents =
              event.payload.status === "AwaitingInput" ? countRunningSubagents(session_id) : 0;

            // Same-turn terminal bookkeeping (issue #77 cause 1): the Stop
            // hook consumes the mark of the turn it closes; every other
            // applied event either sets the mark (Done/Error) or proves the
            // turn moved on (clear it).
            let resolved: ResolvedStatus | null;
            if (event.payload.status === "AwaitingInput") {
              const reportedThisTurn = terminalReportedThisTurn.has(session_id);
              if (reportedThisTurn) {
                terminalReportedThisTurn.delete(session_id);
              }
              resolved = resolveStatusEvent(
                event.payload,
                existing?.status,
                runningSubagents,
                reportedThisTurn,
              );
            } else {
              resolved = resolveStatusEvent(event.payload, existing?.status, runningSubagents);
              if (resolved) {
                if (resolved.status === "Done" || resolved.status === "Error") {
                  terminalReportedThisTurn.add(session_id);
                } else {
                  terminalReportedThisTurn.delete(session_id);
                }
              }
            }
            if (!resolved) return;

            if (!existing) {
              // Buffer this status update - it will be applied when the session is added
              const bufferKey = statusBufferKey(session_id, project_path);
              console.log(
                `[SessionStore] Buffering status for non-existent session. Key: '${bufferKey}'`,
              );
              pendingStatusUpdates.set(bufferKey, {
                ...event.payload,
                status: resolved.status,
                message: resolved.statusMessage,
                needs_input_prompt: resolved.needsInputPrompt,
              });
              return;
            }

            // Clear startup timeout when session transitions out of Starting state (Bug #74)
            if (resolved.status !== "Starting") {
              clearStartupTimeout(session_id);
            }

            // This event is fresher than any pending subagent re-check.
            clearSubagentWatchdog(session_id);
            if (resolved.status === "Working" && event.payload.status === "AwaitingInput") {
              armSubagentWatchdog(session_id, project_path);
            }

            set((state) => {
              // Auto-unpark on the TRANSITION into a ready-for-the-user state:
              // a parked agent that stops — because it needs an answer, or
              // because it finished or failed — must come back into view,
              // marked for attention (yellow chrome) until the user selects
              // it. Edge-triggered on purpose — if the user re-parks the
              // still-stopped session, repeated events for the same status are
              // not a new transition and must not undo that manual choice.
              const current = state.sessions.find(
                (s) => s.id === session_id && samePath(s.project_path, project_path),
              );
              const autoUnpark =
                current !== undefined &&
                READY_FOR_USER_STATUSES.includes(resolved.status) &&
                current.status !== resolved.status &&
                state.parkedSessionIds.includes(session_id);

              return {
                sessions: state.sessions.map((s) =>
                  s.id === session_id && samePath(s.project_path, project_path)
                    ? {
                        ...s,
                        status: resolved.status,
                        statusMessage: resolved.statusMessage,
                        needsInputPrompt: resolved.needsInputPrompt,
                        lastMcpUpdateTime: Date.now(),
                      }
                    : s,
                ),
                ...(autoUnpark
                  ? {
                      parkedSessionIds: state.parkedSessionIds.filter((id) => id !== session_id),
                      attentionSessionIds: state.attentionSessionIds.includes(session_id)
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
      if (!usage || (s.contextPercent === usage.percent && s.contextTokens === usage.tokens)) {
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
// event -> badge map, DEAD => error chrome, allowance => attention;
// samurai-schedule-event -> pending resume timers for the countdown chip)
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

/**
 * Terminal supervisor states — the run is over, one way or another: KILLED
 * (replication, issue #55), PARKED (allowance park, issue #60), DEAD (the
 * watchdog declared the process gone, issue #44). No allowance attention
 * (see {@link applySamuraiAllowanceEvent}), and — per issue #122's decided
 * policy — every one of them moves its terminal into the existing footer
 * parking tray (TerminalGrid's samurai-park effect) instead of leaving it in
 * the grid: resuming is always a fresh spawn, so the old terminal has
 * nothing left to do live, but its transcript stays one unpark away.
 */
export const SAMURAI_TERMINAL_STATES: ReadonlySet<string> = new Set(["KILLED", "PARKED", "DEAD"]);

/**
 * Tracks every supervisor state change into `samuraiBySessionId` (the badge
 * data for issue #46), and surfaces a watchdog-declared death (issue #44):
 * a crashed claude fires no hook, so without this the session would sit on
 * its last MCP status — usually "Working" — forever. On a DEAD supervisor
 * event the session flips to Error chrome (the parked-shelf chip picks that
 * up as its attention border, issue #122) — moving the tile to the parking
 * tray is TerminalGrid's samurai-park effect's job, keyed off
 * `SAMURAI_TERMINAL_STATES`, same as KILLED/PARKED.
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
      (s) => s.id === payload.session_id && samePath(s.project_path, payload.project),
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
          : s,
      ),
    };
  });
}

/**
 * The `samurai-allowance-event` payload — the TS mirror of the backend's
 * `AllowanceEvent` (`core/allowance_watcher.rs`), which is serialized tagged
 * by `kind`. Every field is optional here: only `allowance_threshold` carries
 * the reading, and `allowance_recovered` / `no_governing_window` carry none.
 */
interface SamuraiAllowanceEventPayload {
  kind?: string;
  window?: string;
  threshold_kind?: string;
  value?: number;
  threshold?: number;
}

/**
 * The pseudo-project the backend writes account-wide ALERT rows to when
 * nothing is supervised — the TS mirror of `allowance_watcher::ACCOUNT_PROJECT`.
 * It is a real key for `samurai_audit_read`, not a path: the Second Brain's
 * "Account-wide" card and the audit stream both read it with this exact
 * string, and an account-wide toast names it so the user knows which card
 * holds the rows.
 */
export const SAMURAI_ACCOUNT_PROJECT = "samurai-account";

/**
 * The run id those account-wide rows carry — the TS mirror of
 * `allowance_watcher::ACCOUNT_RUN`, the pseudo-run paired with
 * {@link SAMURAI_ACCOUNT_PROJECT}. `AuditSection` re-exports it, which is
 * where audit-row grouping consumes it.
 */
export const SAMURAI_ACCOUNT_RUN = "account";

/** One plain-language line for a crossing, for the toast title / OS body. */
function allowanceCrossingLabel(payload: SamuraiAllowanceEventPayload): string {
  const subject = typeof payload.window === "string" ? `${payload.window} usage` : "Usage";
  const reading =
    typeof payload.value === "number" ? `hit ${payload.value}%` : "crossed a threshold";
  const threshold =
    payload.threshold_kind === "hard"
      ? " — hard (park) threshold"
      : payload.threshold_kind === "soft"
        ? " — soft (wind-down) threshold"
        : "";
  return `${subject} ${reading}${threshold}`;
}

/**
 * Allowance threshold crossed (issue #45, edge-triggered ~once per window):
 * flag every live supervised session with the existing attention highlight —
 * those are the runs the crossing is about (issue #46: existing attention
 * mechanism, no new alert UI). Details land as ALERT rows in the audit
 * stream; non-supervised sessions stay untouched.
 *
 * With NOTHING supervised the badge has nowhere to land — the state the last
 * real crossing happened in (the run had already died), where the whole event
 * used to vanish: no toast, no OS notification, and its ALERT rows filed under
 * the account-wide pseudo-project. So a crossing with no live run raises the
 * loud surfaces itself — the same toast + OS pair the run-fatal path uses, on
 * the same notifications toggle — naming {@link SAMURAI_ACCOUNT_PROJECT}, the
 * card whose audit rows carry the detail. Only an `allowance_threshold`
 * crossing announces: a recovery or a missing window is not news.
 */
function applySamuraiAllowanceEvent(payload: SamuraiAllowanceEventPayload): void {
  const crossing = payload?.kind === "allowance_threshold";
  const notify = crossing && useGitHubWatchdogStore.getState().notificationsEnabled;
  const label = crossing ? allowanceCrossingLabel(payload) : "";
  let announced = false;
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
    if (flagged.length > 0) {
      return { attentionSessionIds: [...state.attentionSessionIds, ...flagged] };
    }
    // No-op guard: nothing supervised (or all already flagged) — don't
    // replace the array and re-render subscribers. The account-wide
    // announcement below is the one thing that still has to happen.
    if (!notify) return state;
    announced = true;
    samuraiToastSeq += 1;
    return {
      samuraiToasts: [
        ...state.samuraiToasts,
        {
          id: `samurai-${samuraiToastSeq}`,
          kind: "allowance" as const,
          project: SAMURAI_ACCOUNT_PROJECT,
          epic: SAMURAI_ACCOUNT_RUN,
          generation: 0,
          label,
        },
      ].slice(-MAX_SAMURAI_TOASTS),
    };
  });
  if (announced) {
    void notifyOs("Samurai — token allowance", label);
  }
}

/**
 * Run-fatal audit rows (issue #174): a supervised, autonomous run can die
 * silently — the whole point of supervision is that the human does not watch
 * the terminal, so these events must come TO the human instead of waiting in
 * the sidebar audit list.
 *
 * Three surfaces, deliberately independent:
 * - a persistent attention badge (the existing yellow highlight, cleared
 *   when the user focuses the session) on the session the row names — set
 *   REGARDLESS of the notifications toggle, so nothing is silently missed;
 * - a toast, queued only while notifications are enabled (the same toggle
 *   the GitHub watchdog and health checker honour);
 * - a native OS notification (same toggle), which is the one surface that
 *   reaches the user while Maestro is minimized — the situation the Nido
 *   run actually died in. Best effort (`notifyOs` swallows failures).
 *
 * One notification per event by construction: each audit row is appended
 * (and therefore emitted on `samurai-audit-event`) exactly once — the
 * backend's give-up/trip paths already fire their ALERT once, not per tick.
 */
function applySamuraiFatalAuditEvent(payload: SamuraiAuditEventPayload): void {
  const label = samuraiRunFatalLabel(payload.event);
  if (label === null) return;
  const { session_id, epic, generation } = payload.event;
  // Lazy require would be overkill: the watchdog store has no dependency
  // back on this module, so the import is safe (see the module imports).
  const notify = useGitHubWatchdogStore.getState().notificationsEnabled;
  useSessionStore.setState((state) => {
    // The badge: only when the row names a real, known session (a
    // successor_no_start for a never-registered spawn carries the 0
    // sentinel — the toast still says which epic stranded).
    const knownSession =
      session_id > 0 &&
      state.sessions.some((s) => s.id === session_id && samePath(s.project_path, payload.project));
    // A fatal event must UPGRADE an existing non-fatal attention flag. The
    // guard used to skip the whole branch whenever the session already
    // carried attention — an allowance crossing flags exactly that way — so
    // a genuinely fatal row on such a session never reached
    // `runFatalSessionIds`, and `parkSession` wiped its badge on the auto-park
    // that follows: a dead run looked like an ordinary parked terminal.
    const needsAttention = knownSession && !state.attentionSessionIds.includes(session_id);
    const needsFatal = knownSession && !state.runFatalSessionIds.includes(session_id);
    if (!needsAttention && !needsFatal && !notify) return state;
    samuraiToastSeq += 1;
    return {
      ...(knownSession
        ? {
            attentionSessionIds: needsAttention
              ? [...state.attentionSessionIds, session_id]
              : state.attentionSessionIds,
            // Marks this badge as run-fatal (issue #174) so `parkSession`
            // preserves it instead of wiping it when the auto-park effect
            // parks the session moments later.
            runFatalSessionIds: needsFatal
              ? [...state.runFatalSessionIds, session_id]
              : state.runFatalSessionIds,
          }
        : {}),
      ...(notify
        ? {
            samuraiToasts: [
              ...state.samuraiToasts,
              {
                id: `samurai-${samuraiToastSeq}`,
                kind: "fatal" as const,
                project: payload.project,
                epic,
                generation,
                label,
              },
            ].slice(-MAX_SAMURAI_TOASTS),
          }
        : {}),
    };
  });
  if (notify) {
    const project = projectLabel(payload.project);
    void notifyOs(`Samurai run needs you — ${project}`, `${label} (${epic} · gen-${generation})`);
  }
}

/**
 * Review F8: whether a live `samurai-schedule-event` has been applied since
 * this listener lifetime started. The seed's IPC round-trip can resolve
 * AFTER a live event already delivered a newer list — applying the stale
 * snapshot then would resurrect a fired timer's countdown chip. Reset on
 * listener init so the restart-seed case still works.
 */
let samuraiScheduleEventApplied = false;

/**
 * Whether a timer list has been folded into `samuraiParkAlerts` yet in this
 * listener lifetime. The FIRST one — the seed, or a live event that beat it —
 * is the startup baseline: those parks already existed when the app opened,
 * so they get their persistent marker (coming back to them is the whole
 * point) but no toast, which would otherwise fire on every launch for a park
 * the user has known about for days.
 */
let samuraiParkBaselineApplied = false;

/**
 * Folds a full timer list into the park alerts: new parks raise the loud
 * surfaces, known ones keep their acknowledged flag, and vanished ones are
 * dropped — a fired or cancelled timer must not leave a "parked" marker.
 *
 * The alerts ride the SCHEDULE rather than the `PARKED` supervisor event
 * because only the timer carries the resume time, and a park announced
 * without one is exactly the unreadable "parked, back at 09:05" the
 * park-time formatters exist to prevent. A park that arms no timer at all is
 * a circuit-breaker trip, which already comes through the run-fatal path.
 *
 * `isParkEntry` gates the list: scheduled launches (issue #129) share it and
 * would otherwise announce a park for a run that does not exist yet.
 */
function applySamuraiParkAlerts(entries: SamuraiScheduleEntry[]): void {
  const announce = samuraiParkBaselineApplied;
  samuraiParkBaselineApplied = true;

  const known = new Map(useSessionStore.getState().samuraiParkAlerts.map((a) => [a.key, a]));
  const fresh: SamuraiParkAlert[] = [];
  const samuraiParkAlerts = entries.filter(isParkEntry).map((entry) => {
    const key = parkAlertKey(entry);
    const existing = known.get(key);
    if (existing) return existing;
    const alert: SamuraiParkAlert = {
      key,
      project: entry.project_path,
      epic: entry.epic,
      fireAt: entry.fire_at,
      acknowledged: false,
    };
    fresh.push(alert);
    return alert;
  });

  const notify =
    announce && fresh.length > 0 && useGitHubWatchdogStore.getState().notificationsEnabled;
  useSessionStore.setState((state) => ({
    samuraiParkAlerts,
    samuraiToasts: notify
      ? [
          ...state.samuraiToasts,
          ...fresh.map((alert): SamuraiToast => {
            samuraiToastSeq += 1;
            return {
              id: `samurai-${samuraiToastSeq}`,
              kind: "park",
              project: alert.project,
              epic: alert.epic,
              generation: 0,
              label: `resumes ${formatResumeAt(alert.fireAt) ?? alert.fireAt}`,
            };
          }),
        ].slice(-MAX_SAMURAI_TOASTS)
      : state.samuraiToasts,
  }));

  if (!notify) return;
  for (const alert of fresh) {
    void notifyOs(
      `Samurai parked — ${projectLabel(alert.project)}`,
      `${alert.epic} · resumes ${formatResumeAt(alert.fireAt) ?? alert.fireAt}`,
    );
  }
}

/**
 * Replaces the pending-timer list (issue #61). The backend sends the FULL
 * current list on every arm/cancel/fire, so this is a plain replace — no
 * merging, no ordering assumptions.
 */
function applySamuraiScheduleEvent(payload: SamuraiScheduleEntry[]): void {
  // Defensive: a mocked/failed IPC layer may hand back a non-array.
  if (!Array.isArray(payload)) return;
  samuraiScheduleEventApplied = true;
  useSessionStore.setState({ samuraiSchedule: payload });
  applySamuraiParkAlerts(payload);
}

/**
 * Seeds `samuraiSchedule` from the backend's current timers, so timers armed
 * before this frontend mounted (app restart with parked epics) still show
 * their countdown chip. Live events always carry the full current list, so
 * once one has been applied the seed's snapshot is stale by definition and
 * is dropped (review F8).
 */
async function seedSamuraiSchedule(): Promise<void> {
  try {
    const entries = await samuraiScheduleList();
    if (samuraiScheduleEventApplied) return;
    if (!Array.isArray(entries)) return;
    // Baselined even when empty: otherwise this session's first real park
    // would be mistaken for the startup snapshot and announce nothing.
    applySamuraiParkAlerts(entries);
    if (entries.length === 0) return;
    useSessionStore.setState({ samuraiSchedule: entries });
  } catch (err) {
    console.error("Failed to seed samurai resume timers:", err);
  }
}

/**
 * Raises the loud surfaces for runs that are ALREADY interrupted when this
 * listener starts.
 *
 * Cold-start reconciliation runs in the Tauri setup closure, with no delay,
 * long before App mounts this listener — and Tauri buffers no events. So the
 * `reconcile_interrupted` ALERT it emits is delivered to nobody: the toast
 * that `applySamuraiFatalAuditEvent` would raise for it can never fire on
 * the one path that matters, a cold start. That is not a race to widen; the
 * fix is to stop depending on catching the event at all.
 *
 * The reconciler also LATCHES its verdict onto the run config
 * (`interrupted_at`, PR #185), and that is durable state this seed can just
 * read. Every ACTIVE run carrying the stamp is a run with no owner and no
 * timer, so it gets the same toast + OS notification a live fatal row would
 * have raised — from the run list, whenever the app happens to start.
 *
 * It repeats on every launch, deliberately: an interrupted run stays dead
 * until a human recovers or abandons it, and the alert that fired once and
 * was missed is exactly how the real Nido run went unnoticed for three
 * weeks. Both actions are one click away in Active Runs, and both clear the
 * stamp.
 *
 * No attention badge: an interrupted run has no live session to badge — the
 * red INTERRUPTED row in Active Runs is its persistent surface.
 */
async function seedSamuraiInterruptedRuns(): Promise<void> {
  try {
    const runs = await samuraiListRuns();
    // Defensive: a mocked/failed IPC layer may hand back a non-array.
    if (!Array.isArray(runs)) return;
    // Issue #209: a breaker park is the same shape of problem from a
    // different cause — an ACTIVE run with no owner and nothing that will
    // ever restart it — so it seeds through the same door. Its list is also
    // published, because the park chip has no other source: a breaker trip
    // arms no timer, so `samuraiSchedule` never hears about it.
    const breaker = runs.filter(isBreakerParked);
    useSessionStore.getState().setSamuraiBreakerParks(
      breaker.map((run: SamuraiRunListEntry) => ({
        project: run.project_path,
        epic: run.epic,
        at: run.parked?.at ?? "",
      })),
    );
    const dead = runs.filter(
      (run: SamuraiRunListEntry) =>
        run.status === "ACTIVE" && run.interrupted_at != null && !isBreakerParked(run),
    );
    const needy: [SamuraiRunListEntry, string, number][] = [
      ...dead.map((run: SamuraiRunListEntry): [SamuraiRunListEntry, string, number] => [
        run,
        INTERRUPTED_RUN_LABEL,
        run.interrupted_at?.prior_generation ?? 0,
      ]),
      ...breaker.map((run: SamuraiRunListEntry): [SamuraiRunListEntry, string, number] => [
        run,
        BREAKER_PARK_LABEL,
        run.parked?.generation ?? 0,
      ]),
    ];
    if (needy.length === 0) return;
    const notify = useGitHubWatchdogStore.getState().notificationsEnabled;
    if (!notify) return;
    useSessionStore.setState((state) => {
      const toasts = needy.map(([run, label, generation]) => {
        samuraiToastSeq += 1;
        return {
          id: `samurai-${samuraiToastSeq}`,
          kind: "fatal" as const,
          project: run.project_path,
          epic: run.epic,
          generation,
          label,
        };
      });
      return { samuraiToasts: [...state.samuraiToasts, ...toasts].slice(-MAX_SAMURAI_TOASTS) };
    });
    for (const [run, label] of needy) {
      void notifyOs(
        `Samurai run needs you — ${projectLabel(run.project_path)}`,
        `${label} (${run.epic})`,
      );
    }
  } catch (err) {
    console.error("Failed to seed interrupted samurai runs:", err);
  }
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
  // Review F8: fresh listener lifetime — the seed may apply until the first
  // live schedule event of THIS lifetime lands.
  samuraiScheduleEventApplied = false;
  samuraiParkBaselineApplied = false;
  samuraiStarting = Promise.all([
    listen<SamuraiSupervisorEvent>("samurai-supervisor-event", (event) => {
      applySamuraiSupervisorEvent(event.payload);
    }),
    listen<SamuraiAllowanceEventPayload>("samurai-allowance-event", (event) => {
      applySamuraiAllowanceEvent(event.payload ?? {});
    }),
    listen<SamuraiScheduleEntry[]>("samurai-schedule-event", (event) => {
      applySamuraiScheduleEvent(event.payload);
    }),
    // Issue #174: run-fatal rows raise a toast + persistent attention badge.
    listen<SamuraiAuditEventPayload>("samurai-audit-event", (event) => {
      applySamuraiFatalAuditEvent(event.payload);
    }),
  ])
    .then((fns) => {
      const unlistenAll = () =>
        fns.forEach((fn) => {
          fn();
        });
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
  void seedSamuraiSchedule();
  void seedSamuraiInterruptedRuns();
}

export function stopSamuraiSupervisorListener(): void {
  samuraiActive = false;
  if (samuraiUnlisten) {
    samuraiUnlisten();
    samuraiUnlisten = null;
  }
}
