import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { listen } from "@tauri-apps/api/event";

import type { ClaudeEvent } from "@/types/claude-events";
import { type SubagentInfo, useAgentStore } from "../useAgentStore";
import { useBackgroundTaskStore } from "../useBackgroundTaskStore";
import { type BackendSessionStatus, type SessionConfig, useSessionStore } from "../useSessionStore";

const listenMock = vi.mocked(listen);

const PROJECT = "C:/proj";

function session(id: number, status: BackendSessionStatus = "Working"): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: PROJECT,
  };
}

/**
 * A subagent of `sessionId`. `spawnedAt` defaults to "just now" because the
 * running-subagent heuristic ages agents out (see SUBAGENT_STALE_MS): a
 * hardcoded date would read as stale the day after it was written.
 */
function agent(
  sessionId: number,
  agentId: string,
  completedAt: number | null,
  spawnedAt: string = new Date().toISOString(),
): SubagentInfo {
  return {
    agentId,
    sessionId,
    agentType: "Explore",
    description: "look around",
    prompt: "go",
    runInBackground: true,
    spawnedAt,
    completedAt,
    success: completedAt === null ? null : true,
    report: "",
    status: null,
    model: null,
    durationMs: null,
    totalTokens: null,
    toolUseCount: null,
    toolStats: null,
    agentRunId: null,
  };
}

/** The transcript reporting that the agent started background work just now. */
function backgroundStarted(
  sessionId: number,
  toolUseId: string,
  toolName: string,
  expiresInMs: number | null = null,
  options: { recurring?: boolean; timestamp?: string } = {},
): void {
  useBackgroundTaskStore.getState().handleEvents([
    {
      event_type: "BackgroundTaskStarted",
      session_id: sessionId,
      tool_use_id: toolUseId,
      tool_name: toolName,
      description: toolName,
      expires_in_ms: expiresInMs,
      recurring: options.recurring ?? toolName === "CronCreate",
      timestamp: options.timestamp ?? new Date().toISOString(),
    },
  ]);
}

/** The transcript's task notification for a finished background task. */
function backgroundFinished(sessionId: number, toolUseId: string): void {
  const finished: ClaudeEvent = {
    event_type: "BackgroundTaskFinished",
    session_id: sessionId,
    tool_use_id: toolUseId,
    timestamp: new Date().toISOString(),
  };
  useBackgroundTaskStore.getState().handleEvents([finished]);
}

/**
 * Feeds a payload to the store's `session-status-changed` handler, the way the
 * Tauri event would.
 *
 * The store registers that listener exactly once per module lifetime (it
 * ref-counts subscribers), so the handler is captured once in `beforeAll` and
 * reused — re-running `initListeners` per test would never call `listen` again.
 */
let handler: ((event: { payload: unknown }) => void) | null = null;

function emit(payload: Record<string, unknown>): void {
  if (!handler) throw new Error("session-status-changed listener was never registered");
  handler({ payload });
}

function awaitingInput(sessionId: number) {
  return {
    session_id: sessionId,
    project_path: PROJECT,
    status: "AwaitingInput",
    message: "Waiting for your input",
    needs_input_prompt: null,
  };
}

/** The CLI's 60s idle_prompt Notification, as the status server forwards it. */
function idleReminder(sessionId: number) {
  return {
    session_id: sessionId,
    project_path: PROJECT,
    status: "IdleReminder",
    message: "Claude is waiting for your input",
    needs_input_prompt: null,
  };
}

/** A status the agent reported itself over MCP. */
function mcpStatus(sessionId: number, status: BackendSessionStatus, message: string) {
  return {
    session_id: sessionId,
    project_path: PROJECT,
    status,
    message,
    needs_input_prompt: null,
  };
}

describe("session status: the Stop hook vs. running subagents", () => {
  beforeAll(async () => {
    listenMock.mockImplementation((async (
      _name: string,
      cb: (event: { payload: unknown }) => void,
    ) => {
      handler = cb;
      return () => {};
    }) as unknown as typeof listen);
    await useSessionStore.getState().initListeners();
  });

  beforeEach(() => {
    // removeSession is what drops the per-session turn bookkeeping (pending
    // subagent re-checks, "already reported done" marks) that lives outside the
    // store state, so one test cannot leak into the next.
    for (const id of [1, 2, 9]) useSessionStore.getState().removeSession(id);
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      attentionSessionIds: [],
      flaggedSessionIds: [],
    });
    useAgentStore.setState({ agents: [] });
    useBackgroundTaskStore.setState({ tasks: [], sessionStarts: {} });
  });

  it("reports NeedsInput when nothing else is running", () => {
    useSessionStore.setState({ sessions: [session(1)] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("reports Working when the agent handed off to background subagents", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({ agents: [agent(1, "a1", null), agent(1, "a2", null)] });

    emit(awaitingInput(1));

    const updated = useSessionStore.getState().sessions[0];
    expect(updated.status).toBe("Working");
    expect(updated.statusMessage).toBe("2 subagents running");
  });

  it("goes back to NeedsInput once the subagents have finished", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useAgentStore.setState({ agents: [agent(1, "a1", Date.parse("2026-08-05T10:05:00Z"))] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("ignores subagents belonging to a different terminal", () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    useAgentStore.setState({ agents: [agent(2, "a1", null)] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("keeps a terminal state the agent reported during this same turn", () => {
    useSessionStore.setState({ sessions: [session(1)] });

    emit(mcpStatus(1, "Done", "all finished"));
    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("Done");
  });

  /**
   * Issue #77 cause 1. The old rule read the session's *current* status, so a
   * session that had ever reported `Done` swallowed every later turn end — it
   * kept saying "done" while the agent sat waiting for an answer.
   */
  it("flags NeedsInput when the stop closes a later turn than the Done", () => {
    useSessionStore.setState({ sessions: [session(1)] });

    emit(mcpStatus(1, "Done", "all finished"));
    emit(awaitingInput(1)); // end of the turn that reported Done
    emit(awaitingInput(1)); // a later turn, with no fresh report

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("flags NeedsInput on a stop for a session sitting at a stale Done", () => {
    useSessionStore.setState({ sessions: [session(1, "Done")] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("flags NeedsInput on a stop for a session that timed out starting", () => {
    useSessionStore.setState({ sessions: [session(1, "Timeout")] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  /**
   * Issue #77 cause 3: the backend buffers a turn end for a session it has not
   * registered yet, and the frontend does the same — the status must survive
   * until the session shows up rather than being dropped on the floor.
   */
  it("keeps a stop that beats its session into the store", () => {
    emit(awaitingInput(9));

    useSessionStore.getState().addSession(session(9, "Starting"));

    const added = useSessionStore.getState().sessions.find((s) => s.id === 9);
    expect(added?.status).toBe("NeedsInput");
  });

  /** Issue #77 cause 4: a completion event that never arrived. */
  it("does not trust a subagent that has been running implausibly long", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    useAgentStore.setState({ agents: [agent(1, "a1", null, anHourAgo)] });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("stops holding Working once its subagents age out without completing", () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ sessions: [session(1)] });
      useAgentStore.setState({ agents: [agent(1, "a1", null)] });

      emit(awaitingInput(1));
      expect(useSessionStore.getState().sessions[0].status).toBe("Working");

      // Nothing ever reports the subagent finished.
      vi.advanceTimersByTime(31 * 60 * 1000);

      const updated = useSessionStore.getState().sessions[0];
      expect(updated.status).toBe("NeedsInput");
      expect(updated.statusMessage).toContain("Subagents stopped reporting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the session alone when the subagents are still fresh", () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ sessions: [session(1)] });
      useAgentStore.setState({ agents: [agent(1, "a1", null)] });

      emit(awaitingInput(1));
      vi.advanceTimersByTime(5 * 60 * 1000);

      expect(useSessionStore.getState().sessions[0].status).toBe("Working");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Issue #77 cause 5: the event and the session can spell the same directory
   * differently (Windows canonical `\\?\` prefix, drive-letter case, trailing
   * separator). Matching on the raw string dropped the update entirely.
   */
  it("applies a status whose project path is only spelled differently", () => {
    useSessionStore.setState({ sessions: [session(1, "Idle")] });

    emit({
      session_id: 1,
      project_path: "\\\\?\\c:\\PROJ\\",
      status: "Working",
      message: "building",
    });

    expect(useSessionStore.getState().sessions[0].status).toBe("Working");
  });

  it("applies a stop whose project path is only spelled differently", () => {
    useSessionStore.setState({ sessions: [session(1, "Idle")] });

    emit({
      session_id: 1,
      project_path: "\\\\?\\c:\\PROJ\\",
      status: "AwaitingInput",
      message: "Waiting for your input",
    });

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  /**
   * A parked terminal whose Stop was read as "handed off" (subagents still
   * running) was painted Working, so the user never heard the turn ended. When
   * the subagent completion lands afterwards and the CLI's 60s idle reminder
   * repaints NeedsInput, that reminder IS the news — the terminal must come
   * back into the grid, not just turn red inside the parking tray.
   */
  it("the idle reminder unparks a session whose stop was read as handed off", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useSessionStore.getState().parkSession(1);
    useAgentStore.setState({ agents: [agent(1, "a1", null)] });

    emit(awaitingInput(1));
    expect(useSessionStore.getState().sessions[0].status).toBe("Working");
    expect(useSessionStore.getState().parkedSessionIds).toEqual([1]);

    useAgentStore.setState({ agents: [agent(1, "a1", Date.now())] });
    emit(idleReminder(1));

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("NeedsInput");
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  /**
   * PR #345 still holds: a turn end the user already saw and parked away is
   * not re-surfaced by the reminder, even after a late tool hook repainted the
   * session Working in between.
   */
  it("the idle reminder still leaves a re-parked session alone after a late Working repaint", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useSessionStore.getState().parkSession(1);

    emit(awaitingInput(1));
    expect(useSessionStore.getState().parkedSessionIds).toEqual([]);
    useSessionStore.getState().parkSession(1);

    emit(mcpStatus(1, "Working", "late PostToolUse"));
    emit(idleReminder(1));

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("NeedsInput");
    expect(state.parkedSessionIds).toEqual([1]);
  });

  it("a fresh turn after the hand-off resets the reminder back to repaint-only", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useSessionStore.getState().parkSession(1);
    useAgentStore.setState({ agents: [agent(1, "a1", null)] });

    emit(awaitingInput(1));
    // The agent resumed (UserPromptSubmit / PreToolUse paint Working) and its
    // next stop found nothing running: the turn end reached the user there.
    emit(mcpStatus(1, "Working", "Processing your prompt"));
    useAgentStore.setState({ agents: [agent(1, "a1", Date.now())] });
    emit(awaitingInput(1));
    expect(useSessionStore.getState().parkedSessionIds).toEqual([]);
    useSessionStore.getState().parkSession(1);

    emit(idleReminder(1));

    expect(useSessionStore.getState().parkedSessionIds).toEqual([1]);
  });

  /**
   * Same gap on the other exit from the handed-off state: the 30-minute
   * re-check that stops trusting silent subagents painted NeedsInput straight
   * into the store, bypassing the auto-unpark rule.
   */
  it("the subagent re-check unparks a parked session when it flips it to NeedsInput", () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ sessions: [session(1)] });
      useSessionStore.getState().parkSession(1);
      useAgentStore.setState({ agents: [agent(1, "a1", null)] });

      emit(awaitingInput(1));
      expect(useSessionStore.getState().sessions[0].status).toBe("Working");

      vi.advanceTimersByTime(31 * 60 * 1000);

      const state = useSessionStore.getState();
      expect(state.sessions[0].status).toBe("NeedsInput");
      expect(state.parkedSessionIds).toEqual([]);
      expect(state.attentionSessionIds).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Issue #469: an agent that ends its turn to wait on a background command
   * (CI, a build) is still working. The parked terminal stays parked and quiet
   * until the command reports back and the agent truly stops.
   */
  it("a parked session waiting on a background command stays parked until the agent stops", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    useSessionStore.getState().parkSession(1);
    backgroundStarted(1, "toolu_ci", "Bash");

    emit(awaitingInput(1));

    let state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("Working");
    expect(state.sessions[0].statusMessage).toBe("Waiting on 1 background command");
    expect(state.parkedSessionIds).toEqual([1]);
    expect(state.attentionSessionIds).toEqual([]);

    // The command's notification wakes the agent; its next Stop finds nothing pending.
    backgroundFinished(1, "toolu_ci");
    emit(awaitingInput(1));

    state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("NeedsInput");
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it("stops holding Working once background work passes its expiry without reporting", () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ sessions: [session(1)] });
      useSessionStore.getState().parkSession(1);
      backgroundStarted(1, "toolu_monitor", "Monitor", 6 * 60 * 1000);

      emit(awaitingInput(1));
      expect(useSessionStore.getState().sessions[0].status).toBe("Working");

      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(useSessionStore.getState().sessions[0].status).toBe("Working");

      // The monitor never reports back.
      vi.advanceTimersByTime(2 * 60 * 1000);

      const state = useSessionStore.getState();
      expect(state.sessions[0].status).toBe("NeedsInput");
      expect(state.sessions[0].statusMessage).toBe(
        "Background work stopped reporting - waiting for your input",
      );
      expect(state.parkedSessionIds).toEqual([]);
      expect(state.attentionSessionIds).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a one-shot cron job that has fired no longer holds the session at Working", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    backgroundStarted(1, "toolu_once", "CronCreate", null, { recurring: false });

    emit(awaitingInput(1));
    expect(useSessionStore.getState().sessions[0].status).toBe("Working");
    expect(useSessionStore.getState().sessions[0].statusMessage).toBe("Scheduled to wake up");

    // The job fires its prompt; the agent handles it and stops.
    useBackgroundTaskStore.getState().handleEvents([
      {
        event_type: "UserMessage",
        session_id: 1,
        uuid: "u-fired",
        text: "check the deploy",
        timestamp: new Date().toISOString(),
      },
    ]);
    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("a resumed session is not pinned by a cron loop its earlier process started", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    useBackgroundTaskStore.getState().handleEvents([
      {
        event_type: "SessionStarted",
        session_id: 1,
        claude_session_uuid: "00000000-0000-4000-8000-000000000001",
        transcript_path: "C:/synthetic/transcript.jsonl",
        timestamp: new Date().toISOString(),
      },
    ]);
    // The watcher replays the transcript from its first byte.
    backgroundStarted(1, "toolu_old_cron", "CronCreate", null, { timestamp: anHourAgo });

    emit(awaitingInput(1));

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });
});
