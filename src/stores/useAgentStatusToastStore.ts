import { create } from "zustand";
import type { BackendSessionStatus, SessionConfig } from "./useSessionStore";
import { useSessionStore } from "./useSessionStore";
import { useToastStore } from "./useToastStore";

/**
 * Agent-status toast tracker.
 *
 * Watches `useSessionStore` for per-session status transitions and emits two
 * persistent toasts (model the PR-movement toasts in `usePRTrackingStore`):
 *
 *  1. Long-running toast — fires when a session has been continuously in the
 *     "Working" (thinking) state for `LONG_RUN_THRESHOLD_MS`. Fires at most
 *     once per thinking episode; a new episode only begins after the session
 *     leaves "Working" and re-enters it.
 *
 *  2. Done-thinking toast — fires when a session transitions from "Working" to
 *     a "result-ready" state (Idle / NeedsInput / Done). To avoid spam from
 *     trivially short episodes, we suppress this toast unless the thinking
 *     episode lasted at least `DONE_MIN_DURATION_MS`.
 *
 * Both toasts include the terminal/session display name *captured at fire
 * time*. If the user later renames the session, in-flight toasts keep the
 * original name — this is intentional, since the toast describes a past event.
 */

/** Five minutes — long-running threshold. */
export const LONG_RUN_THRESHOLD_MS = 5 * 60_000;
/** Five seconds — minimum episode length to bother surfacing a done-thinking toast. */
export const DONE_MIN_DURATION_MS = 5_000;

/** Backend statuses that mean "the agent is actively thinking". */
const THINKING_STATUSES: ReadonlySet<BackendSessionStatus> = new Set(["Working"]);

/** Backend statuses that mean "a result is ready / agent is awaiting input". */
const RESULT_READY_STATUSES: ReadonlySet<BackendSessionStatus> = new Set([
  "Idle",
  "NeedsInput",
  "Done",
]);

function isThinking(status: BackendSessionStatus): boolean {
  return THINKING_STATUSES.has(status);
}

function isResultReady(status: BackendSessionStatus): boolean {
  return RESULT_READY_STATUSES.has(status);
}

/** Human-friendly session label, mirroring the convention in Sidebar/TerminalHeader. */
export function sessionLabel(session: Pick<SessionConfig, "id" | "name">): string {
  return session.name && session.name.trim().length > 0 ? session.name : `#${session.id}`;
}

/** Per-session tracking record used while an episode is in flight. */
interface ThinkingEpisode {
  startedAt: number;
  /** True once we've emitted the long-run toast for this episode. */
  longRunFired: boolean;
  /** setTimeout handle for the long-run toast; cleared on episode end. */
  longRunTimer: ReturnType<typeof setTimeout> | null;
  /** Captured display name at episode start — survives rename. */
  capturedLabel: string;
}

/** Decision returned by the pure transition reducer; the caller performs the side effects. */
export type TransitionAction =
  | { kind: "none" }
  | { kind: "start-episode"; startedAt: number; label: string }
  | { kind: "end-episode"; durationMs: number; label: string; fireDoneToast: boolean }
  | { kind: "fire-long-run"; label: string };

interface TransitionInput {
  prev: BackendSessionStatus | undefined;
  next: BackendSessionStatus;
  label: string;
  now: number;
  /** Tracked episode for this session, if any. */
  episode: ThinkingEpisode | null;
}

/**
 * Pure reducer for a single session-status transition.
 *
 * Returned action describes what the surrounding tracker should *do* (start a
 * timer, fire a toast, etc.) — it does not perform side effects itself, which
 * keeps this function trivially unit-testable.
 *
 * Note: the `fire-long-run` action is produced by the timer firing, not by a
 * status transition, but we model it here for completeness in the test surface.
 */
export function reduceTransition(input: TransitionInput): TransitionAction {
  const { prev, next, label, now, episode } = input;
  const prevThinking = prev !== undefined && isThinking(prev);
  const nextThinking = isThinking(next);

  // Entering a thinking episode (was not thinking, now is).
  if (!prevThinking && nextThinking && !episode) {
    return { kind: "start-episode", startedAt: now, label };
  }

  // Leaving a thinking episode into a result-ready state.
  if (prevThinking && !nextThinking && isResultReady(next) && episode) {
    const durationMs = now - episode.startedAt;
    return {
      kind: "end-episode",
      durationMs,
      label: episode.capturedLabel,
      fireDoneToast: durationMs >= DONE_MIN_DURATION_MS,
    };
  }

  // Leaving thinking into a non-result-ready state (Error, Starting, Timeout).
  // We still want to close the episode — but without a done-thinking toast,
  // since the session didn't actually produce a result.
  if (prevThinking && !nextThinking && episode) {
    return {
      kind: "end-episode",
      durationMs: now - episode.startedAt,
      label: episode.capturedLabel,
      fireDoneToast: false,
    };
  }

  return { kind: "none" };
}

interface AgentStatusToastState {
  /** Begin watching the session store. Returns a cleanup function. */
  start: () => () => void;
}

/** Per-session episode store kept module-private; not part of the zustand state. */
const episodes = new Map<number, ThinkingEpisode>();

/** Last-seen statuses, keyed by session id. */
const lastStatus = new Map<number, BackendSessionStatus>();

function clearEpisode(sessionId: number): void {
  const ep = episodes.get(sessionId);
  if (ep?.longRunTimer) clearTimeout(ep.longRunTimer);
  episodes.delete(sessionId);
}

export const useAgentStatusToastStore = create<AgentStatusToastState>()(() => ({
  start: () => {
    // Seed lastStatus from any sessions that are already present — we don't
    // want to fire a toast for a transition that happened before we started.
    for (const s of useSessionStore.getState().sessions) {
      lastStatus.set(s.id, s.status);
    }

    const unsubscribe = useSessionStore.subscribe((state) => {
      const pushToast = useToastStore.getState().pushToast;

      // Detect sessions that have been removed; clear their episodes.
      const seen = new Set<number>();

      for (const session of state.sessions) {
        seen.add(session.id);
        const prev = lastStatus.get(session.id);
        const next = session.status;
        if (prev === next) continue;

        const label = sessionLabel(session);
        const action = reduceTransition({
          prev,
          next,
          label,
          now: Date.now(),
          episode: episodes.get(session.id) ?? null,
        });

        switch (action.kind) {
          case "start-episode": {
            const timer = setTimeout(() => {
              const ep = episodes.get(session.id);
              if (!ep || ep.longRunFired) return;
              ep.longRunFired = true;
              pushToast(
                {
                  tone: "warning",
                  title: `${ep.capturedLabel} running for ${Math.round(LONG_RUN_THRESHOLD_MS / 60_000)}+ min`,
                  body: "Agent has been thinking continuously without producing a result.",
                },
                0,
              );
            }, LONG_RUN_THRESHOLD_MS);
            episodes.set(session.id, {
              startedAt: action.startedAt,
              longRunFired: false,
              longRunTimer: timer,
              capturedLabel: action.label,
            });
            break;
          }
          case "end-episode": {
            if (action.fireDoneToast) {
              pushToast(
                {
                  tone: "success",
                  title: `${action.label} finished thinking`,
                  body: "Result is ready — agent is awaiting input.",
                },
                0,
              );
            }
            clearEpisode(session.id);
            break;
          }
          case "none":
            break;
        }

        lastStatus.set(session.id, next);
      }

      // Garbage-collect episodes/status for sessions that no longer exist.
      for (const id of Array.from(episodes.keys())) {
        if (!seen.has(id)) clearEpisode(id);
      }
      for (const id of Array.from(lastStatus.keys())) {
        if (!seen.has(id)) lastStatus.delete(id);
      }
    });

    return () => {
      unsubscribe();
      for (const id of Array.from(episodes.keys())) clearEpisode(id);
      lastStatus.clear();
    };
  },
}));
