import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import type { ClaudeEvent } from "@/types/claude-events";
import { pendingBackgroundTasks, useBackgroundTaskStore } from "../useBackgroundTaskStore";

const STARTED_AT = "2026-10-22T10:00:00.000Z";
const T0 = Date.parse(STARTED_AT);
const MINUTE = 60 * 1000;
/** The limit for tasks that state no bound of their own. */
const STALE_MS = 30 * MINUTE;

function started(
  sessionId: number,
  toolUseId: string,
  toolName: string,
  expiresInMs: number | null = null,
): ClaudeEvent {
  return {
    event_type: "BackgroundTaskStarted",
    session_id: sessionId,
    tool_use_id: toolUseId,
    tool_name: toolName,
    description: toolName,
    expires_in_ms: expiresInMs,
    timestamp: STARTED_AT,
  };
}

function userMessage(sessionId: number, text: string): ClaudeEvent {
  return {
    event_type: "UserMessage",
    session_id: sessionId,
    uuid: `u-${sessionId}-${text.length}`,
    text,
    timestamp: "2026-10-22T10:01:00.000Z",
  };
}

/** Tool-use ids of the session's pending tasks, `minutesLater` after T0. */
function pendingIds(sessionId: number, minutesLater = 1): string[] {
  return pendingBackgroundTasks(
    useBackgroundTaskStore.getState().tasks,
    sessionId,
    T0 + minutesLater * MINUTE,
    STALE_MS,
  ).map((t) => t.toolUseId);
}

describe("useBackgroundTaskStore", () => {
  beforeEach(() => {
    useBackgroundTaskStore.setState({ tasks: [] });
  });

  it("a started task is pending until its notification finishes it", () => {
    const store = useBackgroundTaskStore.getState();
    store.handleEvents([started(1, "toolu_ci", "Bash")]);
    expect(pendingIds(1)).toEqual(["toolu_ci"]);

    store.handleEvents([
      {
        event_type: "BackgroundTaskFinished",
        session_id: 1,
        tool_use_id: "toolu_ci",
        timestamp: "2026-10-22T10:04:00.000Z",
      },
    ]);
    expect(pendingIds(1)).toEqual([]);
    expect(useBackgroundTaskStore.getState().tasks[0].finishedAt).toBe(T0 + 4 * MINUTE);
  });

  it("a scheduled wakeup is cleared by a user message of its own session only", () => {
    const store = useBackgroundTaskStore.getState();
    store.handleEvents([
      started(1, "toolu_wake1", "ScheduleWakeup", 21 * MINUTE),
      started(2, "toolu_wake2", "ScheduleWakeup", 21 * MINUTE),
      started(1, "toolu_ci", "Bash"),
    ]);

    // A tool_result entry (no text) and a task notification are not the
    // wakeup firing, and another terminal's prompt is not this one's.
    store.handleEvents([
      userMessage(1, ""),
      userMessage(1, "<task-notification>\n<task-id>x</task-id>\n</task-notification>"),
      userMessage(2, "check CI again"),
    ]);
    expect(pendingIds(1)).toEqual(["toolu_wake1", "toolu_ci"]);
    expect(pendingIds(2)).toEqual([]);

    store.handleEvents([userMessage(1, "check CI again")]);
    expect(pendingIds(1)).toEqual(["toolu_ci"]);
  });

  it("a stopped loop clears only the tasks of its own kind", () => {
    const store = useBackgroundTaskStore.getState();
    const all = [
      started(1, "toolu_wake", "ScheduleWakeup", 21 * MINUTE),
      started(1, "toolu_cron", "CronCreate"),
      started(1, "toolu_ci", "Bash"),
    ];
    store.handleEvents(all);

    store.handleEvents([
      { event_type: "BackgroundLoopStopped", session_id: 1, kind: "cron", timestamp: STARTED_AT },
    ]);
    expect(pendingIds(1)).toEqual(["toolu_wake", "toolu_ci"]);

    store.handleEvents([
      { event_type: "BackgroundLoopStopped", session_id: 1, kind: "wakeup", timestamp: STARTED_AT },
    ]);
    expect(pendingIds(1)).toEqual(["toolu_ci"]);
  });

  it("an expired task is not pending; a cron job never expires on its own", () => {
    useBackgroundTaskStore
      .getState()
      .handleEvents([
        started(1, "toolu_monitor", "Monitor", 6 * MINUTE),
        started(1, "toolu_ci", "Bash"),
        started(1, "toolu_cron", "CronCreate"),
      ]);

    expect(pendingIds(1, 5)).toEqual(["toolu_monitor", "toolu_ci", "toolu_cron"]);
    expect(pendingIds(1, 7)).toEqual(["toolu_ci", "toolu_cron"]);
    expect(pendingIds(1, 31)).toEqual(["toolu_cron"]);
    expect(pendingIds(1, 24 * 60)).toEqual(["toolu_cron"]);
  });

  it("a session that ends drops its tasks; a turn end does not", () => {
    const store = useBackgroundTaskStore.getState();
    store.handleEvents([started(1, "toolu_ci", "Bash"), started(2, "toolu_other", "Bash")]);

    store.handleEvents([
      { event_type: "SessionEnded", session_id: 1, reason: "stop", timestamp: STARTED_AT },
    ]);
    expect(pendingIds(1)).toEqual(["toolu_ci"]);

    store.handleEvents([
      { event_type: "SessionEnded", session_id: 1, reason: "other", timestamp: STARTED_AT },
    ]);
    expect(pendingIds(1)).toEqual([]);
    expect(pendingIds(2)).toEqual(["toolu_other"]);
  });
});
