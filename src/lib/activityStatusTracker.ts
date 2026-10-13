/**
 * Activity-based status detection for one terminal: sustained PTY output marks
 * the session "Working", silence marks it "Idle" again. Defers to MCP status
 * updates while they are fresh. Extracted verbatim from TerminalView's mount effect.
 */
import { type BackendSessionStatus, useSessionStore } from "@/stores/useSessionStore";

/** Defer to MCP for 10s after last MCP update. */
const MCP_GRACE_PERIOD_MS = 10_000;
/** Sustained output before marking "Working". */
const WORKING_DEBOUNCE_MS = 500;
/** No output before marking "Idle". */
const IDLE_TIMEOUT_MS = 5_000;
/** Only overwrite "safe" states — never revert terminal states like Done/Error/NeedsInput/Timeout. */
const SAFE_TO_OVERRIDE: BackendSessionStatus[] = ["Working", "Idle", "Starting"];

export interface ActivityStatusTracker {
  /** Call on every PTY output chunk. */
  onOutput: () => void;
  /** Records that the session was set to Working elsewhere (the user answered a prompt). */
  markWorking: () => void;
  /** Clears pending timers. */
  dispose: () => void;
}

/**
 * Creates the heuristic status tracker for a session.
 * @param sessionId - Session whose status is updated in the session store.
 * @param isDisposed - True once the owning view has unmounted.
 */
export function createActivityStatusTracker(
  sessionId: number,
  isDisposed: () => boolean,
): ActivityStatusTracker {
  let activityWorkingTimer: ReturnType<typeof setTimeout> | null = null;
  let activityIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHeuristicStatus: string | null = null;

  const onOutput = (): void => {
    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
    if (!session) return; // Session was removed, skip heuristic

    const lastMcp = session.lastMcpUpdateTime ?? 0;
    const mcpIsActive = Date.now() - lastMcp < MCP_GRACE_PERIOD_MS;

    if (!mcpIsActive) {
      // Debounce: set "Working" after sustained output
      if (!activityWorkingTimer && lastHeuristicStatus !== "Working") {
        activityWorkingTimer = setTimeout(() => {
          if (isDisposed()) return;
          activityWorkingTimer = null;
          const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
          if (!current || !SAFE_TO_OVERRIDE.includes(current.status)) return;
          lastHeuristicStatus = "Working";
          useSessionStore.getState().updateSession(sessionId, {
            status: "Working" as BackendSessionStatus,
          });
        }, WORKING_DEBOUNCE_MS);
      }

      // Reset idle timer on every output chunk
      if (activityIdleTimer) clearTimeout(activityIdleTimer);
      activityIdleTimer = setTimeout(() => {
        if (isDisposed()) return;
        activityIdleTimer = null;
        if (lastHeuristicStatus === "Working") {
          const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
          if (!current || !SAFE_TO_OVERRIDE.includes(current.status)) return;
          lastHeuristicStatus = "Idle";
          useSessionStore.getState().updateSession(sessionId, {
            status: "Idle" as BackendSessionStatus,
          });
        }
      }, IDLE_TIMEOUT_MS);
    }
  };

  return {
    onOutput,
    markWorking: () => {
      lastHeuristicStatus = "Working";
    },
    dispose: () => {
      if (activityWorkingTimer) clearTimeout(activityWorkingTimer);
      if (activityIdleTimer) clearTimeout(activityIdleTimer);
    },
  };
}
