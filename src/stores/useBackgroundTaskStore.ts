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
  /** Epoch ms the task reported back or was cancelled; null while pending. */
  finishedAt: number | null;
}

interface BackgroundTaskState {
  tasks: BackgroundTaskInfo[];
  /** Fold a whole `claude-events` batch in ONE set() call. */
  handleEvents: (events: ClaudeEvent[]) => void;
}

/** The tool that `BackgroundLoopStopped` of each kind cancels. */
const LOOP_TOOL: Record<"wakeup" | "cron", string> = {
  wakeup: "ScheduleWakeup",
  cron: "CronCreate",
};

/** Transcript timestamp as epoch ms; a replay must keep its own dates. */
function eventTime(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** Marks every pending task of `sessionId` that `matches` as finished at `at`. */
function finishWhere(
  tasks: BackgroundTaskInfo[],
  sessionId: number,
  at: number,
  matches: (task: BackgroundTaskInfo) => boolean,
): BackgroundTaskInfo[] {
  if (!tasks.some((t) => t.sessionId === sessionId && t.finishedAt === null && matches(t))) {
    return tasks;
  }
  return tasks.map((t) =>
    t.sessionId === sessionId && t.finishedAt === null && matches(t) ? { ...t, finishedAt: at } : t,
  );
}

/**
 * Apply one event, returning the SAME array when nothing changed so `set` can
 * skip notifying subscribers (same contract as the agent store's applyEvent).
 */
function applyEvent(tasks: BackgroundTaskInfo[], event: ClaudeEvent): BackgroundTaskInfo[] {
  switch (event.event_type) {
    case "BackgroundTaskStarted": {
      if (tasks.some((t) => t.toolUseId === event.tool_use_id && t.sessionId === event.session_id))
        return tasks;
      const startedAt = eventTime(event.timestamp);
      return [
        ...tasks,
        {
          toolUseId: event.tool_use_id,
          sessionId: event.session_id,
          toolName: event.tool_name,
          description: event.description,
          startedAt,
          expiresAt: event.expires_in_ms === null ? null : startedAt + event.expires_in_ms,
          finishedAt: null,
        },
      ];
    }
    case "BackgroundTaskFinished":
      return finishWhere(
        tasks,
        event.session_id,
        eventTime(event.timestamp),
        (t) => t.toolUseId === event.tool_use_id,
      );
    // The wakeup's own prompt arrives as a user entry, and a user typing also
    // means the agent runs again. A tool_result entry (no text) and a task
    // notification are neither, so they leave the wakeup scheduled.
    case "UserMessage":
      if (!event.text.trim() || event.text.includes("<task-notification>")) return tasks;
      return finishWhere(
        tasks,
        event.session_id,
        eventTime(event.timestamp),
        (t) => t.toolName === LOOP_TOOL.wakeup,
      );
    // The parser cannot name the cancelled items, so every one of the kind goes.
    case "BackgroundLoopStopped":
      return finishWhere(
        tasks,
        event.session_id,
        eventTime(event.timestamp),
        (t) => t.toolName === LOOP_TOOL[event.kind],
      );
    // The claude process exited, taking its background work with it. The Stop
    // hook reports every turn end under the same variant as `reason: "stop"`.
    case "SessionEnded":
      if (event.reason === "stop" || !tasks.some((t) => t.sessionId === event.session_id))
        return tasks;
      return tasks.filter((t) => t.sessionId !== event.session_id);
    default:
      return tasks;
  }
}

/**
 * Epoch ms after which `task` stops counting as pending, or null when it never
 * expires on its own (a cron job runs until deleted or the session ends).
 * A task whose tool states no bound gets `unboundedLimitMs` from its start.
 */
function taskDeadline(task: BackgroundTaskInfo, unboundedLimitMs: number): number | null {
  if (task.expiresAt !== null) return task.expiresAt;
  if (task.toolName === LOOP_TOOL.cron) return null;
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

  handleEvents: (events: ClaudeEvent[]) => {
    if (events.length === 0) return;
    set((state) => {
      let tasks = state.tasks;
      for (const event of events) {
        tasks = applyEvent(tasks, event);
      }
      return tasks === state.tasks ? state : { tasks };
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
