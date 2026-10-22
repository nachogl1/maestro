import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { ClaudeEvent } from "@/types/claude-events";

/**
 * Work a session's agent started that outlives its turn and re-invokes it
 * later (issue #469): a background shell command, a Monitor, a Workflow, a
 * scheduled wakeup (`/loop`) or a cron job. While one is pending, a Stop hook
 * means "handed off", not "waiting on you".
 */
export interface BackgroundTaskInfo {
  /** The tool_use id that started the task. */
  toolUseId: string;
  /** Maestro session (terminal) the task belongs to. */
  sessionId: number;
  /** `Bash`, `PowerShell`, `Monitor`, `Workflow`, `ScheduleWakeup` or `CronCreate`. */
  toolName: string;
  description: string;
  /** Epoch ms of the start, from the transcript timestamp. */
  startedAt: number;
  /** Epoch ms past which the task no longer counts, when the tool states a bound. */
  expiresAt: number | null;
  /** A recurring cron job, which runs until deleted or the session ends. */
  recurring: boolean;
  /** Epoch ms the task reported back or was cancelled; null while pending. */
  finishedAt: number | null;
}

/** What the store tracks; every event folds into a new one of these. */
interface TrackedWork {
  tasks: BackgroundTaskInfo[];
  /**
   * Epoch ms of each session's latest `SessionStarted`: a new claude process.
   * Work started before it belonged to an earlier process and is gone with it.
   */
  sessionStarts: Record<number, number>;
}

interface BackgroundTaskState extends TrackedWork {
  /** Fold a whole `claude-events` batch in ONE set() call. */
  handleEvents: (events: ClaudeEvent[]) => void;
}

/** The tool that `BackgroundLoopStopped` of each kind cancels. */
const LOOP_TOOL: Record<"wakeup" | "cron", string> = {
  wakeup: "ScheduleWakeup",
  cron: "CronCreate",
};

/**
 * A task that fires the agent's next prompt once: a `/loop` wakeup, or a
 * one-shot cron job (Claude Code removes it after it fires, with no
 * `CronDelete`). The next real prompt of the session means it has fired.
 */
export function isScheduledWakeup(task: BackgroundTaskInfo): boolean {
  return (
    task.toolName === LOOP_TOOL.wakeup || (task.toolName === LOOP_TOOL.cron && !task.recurring)
  );
}

/** Transcript timestamp as epoch ms; a replay must keep its own dates. */
function eventTime(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Marks every pending task of `sessionId` that `matches` as finished at `at`.
 *
 * Only tasks started at or before `at`: a live re-read of the transcript from
 * its first byte replays old prompts and loop stops after the current loop's
 * start (skipped as a duplicate), and an older event cannot end newer work.
 */
function finishWhere(
  work: TrackedWork,
  sessionId: number,
  at: number,
  matches: (task: BackgroundTaskInfo) => boolean,
): TrackedWork {
  const finishes = (t: BackgroundTaskInfo) =>
    t.sessionId === sessionId && t.finishedAt === null && t.startedAt <= at && matches(t);
  if (!work.tasks.some(finishes)) return work;
  return {
    ...work,
    tasks: work.tasks.map((t) => (finishes(t) ? { ...t, finishedAt: at } : t)),
  };
}

/**
 * Apply one event, returning the SAME object when nothing changed so `set` can
 * skip notifying subscribers (same contract as the agent store's applyEvent).
 */
function applyEvent(work: TrackedWork, event: ClaudeEvent): TrackedWork {
  const { tasks } = work;
  switch (event.event_type) {
    case "BackgroundTaskStarted": {
      if (tasks.some((t) => t.toolUseId === event.tool_use_id && t.sessionId === event.session_id))
        return work;
      const startedAt = eventTime(event.timestamp);
      // Replayed from a resumed transcript: an earlier process started it.
      if (startedAt < (work.sessionStarts[event.session_id] ?? Number.NEGATIVE_INFINITY))
        return work;
      return {
        ...work,
        tasks: [
          ...tasks,
          {
            toolUseId: event.tool_use_id,
            sessionId: event.session_id,
            toolName: event.tool_name,
            description: event.description,
            startedAt,
            expiresAt: event.expires_in_ms === null ? null : startedAt + event.expires_in_ms,
            recurring: event.recurring,
            finishedAt: null,
          },
        ],
      };
    }
    case "BackgroundTaskFinished":
      return finishWhere(
        work,
        event.session_id,
        eventTime(event.timestamp),
        (t) => t.toolUseId === event.tool_use_id,
      );
    // The wakeup's own prompt arrives as a user entry, and a user typing also
    // means the agent runs again. A tool_result entry (no text) and a task
    // notification are neither, so they leave the wakeup scheduled.
    case "UserMessage":
      if (!event.text.trim() || event.text.includes("<task-notification>")) return work;
      return finishWhere(work, event.session_id, eventTime(event.timestamp), isScheduledWakeup);
    // The parser cannot name the cancelled items, so every one of the kind goes.
    case "BackgroundLoopStopped":
      return finishWhere(
        work,
        event.session_id,
        eventTime(event.timestamp),
        (t) => t.toolName === LOOP_TOOL[event.kind],
      );
    // A new claude process (startup, resume or /clear; compaction emits no
    // SessionStarted). The watcher re-reads the transcript from its first
    // byte, and that replay can land on either side of this event: drop what
    // is already here from before it, and remember it to ignore the rest.
    case "SessionStarted": {
      const startedAt = eventTime(event.timestamp);
      return {
        tasks: tasks.filter((t) => t.sessionId !== event.session_id || t.startedAt >= startedAt),
        sessionStarts: { ...work.sessionStarts, [event.session_id]: startedAt },
      };
    }
    // The claude process exited, taking its background work with it. The Stop
    // hook reports every turn end under the same variant as `reason: "stop"`.
    case "SessionEnded":
      if (event.reason === "stop" || !tasks.some((t) => t.sessionId === event.session_id))
        return work;
      return { ...work, tasks: tasks.filter((t) => t.sessionId !== event.session_id) };
    default:
      return work;
  }
}

/**
 * Epoch ms after which `task` stops counting as pending, or null when it never
 * expires on its own (a recurring cron job runs until deleted or the session
 * ends).
 * A task whose tool states no bound gets `unboundedLimitMs` from its start.
 */
function taskDeadline(task: BackgroundTaskInfo, unboundedLimitMs: number): number | null {
  if (task.expiresAt !== null) return task.expiresAt;
  if (task.toolName === LOOP_TOOL.cron && task.recurring) return null;
  return task.startedAt + unboundedLimitMs;
}

/** The session's tasks that have neither finished nor expired at `now`. */
export function pendingBackgroundTasks(
  tasks: readonly BackgroundTaskInfo[],
  sessionId: number,
  now: number,
  unboundedLimitMs: number,
): BackgroundTaskInfo[] {
  return tasks.filter((t) => {
    if (t.sessionId !== sessionId || t.finishedAt !== null) return false;
    const deadline = taskDeadline(t, unboundedLimitMs);
    return deadline === null || now < deadline;
  });
}

/**
 * Milliseconds until the last of the session's pending tasks expires; null
 * when none is pending, or when one never expires on its own.
 */
export function msUntilBackgroundTasksExpire(
  tasks: readonly BackgroundTaskInfo[],
  sessionId: number,
  now: number,
  unboundedLimitMs: number,
): number | null {
  let longest: number | null = null;
  for (const task of pendingBackgroundTasks(tasks, sessionId, now, unboundedLimitMs)) {
    const deadline = taskDeadline(task, unboundedLimitMs);
    if (deadline === null) return null;
    const remaining = deadline - now;
    if (longest === null || remaining > longest) longest = remaining;
  }
  return longest;
}

/** Store of the background work seen in each session's own transcript. In memory only. */
export const useBackgroundTaskStore = create<BackgroundTaskState>((set) => ({
  tasks: [],
  sessionStarts: {},

  handleEvents: (events: ClaudeEvent[]) => {
    if (events.length === 0) return;
    set((state) => {
      const before: TrackedWork = { tasks: state.tasks, sessionStarts: state.sessionStarts };
      let work = before;
      for (const event of events) {
        work = applyEvent(work, event);
      }
      return work === before ? state : work;
    });
  },
}));

// Global event listener, same lifecycle guard as `initAgentListener`: `active`
// tracks the desired state so a StrictMode init/stop race cannot leak one.
let unlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;
let active = false;

export async function initBackgroundTaskListener(): Promise<void> {
  active = true;
  if (unlisten || starting) return;
  starting = listen<ClaudeEvent[]>("claude-events", (event) => {
    useBackgroundTaskStore.getState().handleEvents(event.payload);
  })
    .then((fn) => {
      if (!active) {
        fn();
        return;
      }
      unlisten = fn;
    })
    .finally(() => {
      starting = null;
    });
  await starting;
}

export function stopBackgroundTaskListener(): void {
  active = false;
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
