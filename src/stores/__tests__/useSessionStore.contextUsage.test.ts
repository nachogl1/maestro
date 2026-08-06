import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { ClaudeEvent } from "@/types/claude-events";
import {
  initContextUsageListener,
  useSessionStore,
  type BackendSessionStatus,
  type SessionConfig,
} from "../useSessionStore";

const listenMock = vi.mocked(listen);
const invokeMock = vi.mocked(invoke);

function session(
  id: number,
  status: BackendSessionStatus = "Idle",
  projectPath = "C:/proj"
): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: projectPath,
  };
}

function contextEvent(
  sessionId: number,
  percent: number,
  contextTokens: number,
  contextWindow = 1_000_000
): ClaudeEvent {
  return {
    event_type: "ContextUsageUpdate",
    session_id: sessionId,
    model: "claude-fable-5",
    context_tokens: contextTokens,
    context_window: contextWindow,
    percent,
    timestamp: "2026-08-06T10:00:00Z",
  };
}

/** Captured `claude-events` handler, so tests can emit event batches. */
let emitClaudeEvents: (events: ClaudeEvent[]) => void;

beforeAll(async () => {
  listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
    if (event === "claude-events") {
      emitClaudeEvents = (events) => handler({ payload: events });
    }
    return Promise.resolve(() => {});
  }) as typeof listen);
  await initContextUsageListener();
});

describe("useSessionStore context usage (issue #41)", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
    // Drain the module-level last-known map via the public removal path.
    for (let id = 0; id < 20; id++) {
      useSessionStore.getState().removeSession(id);
    }
  });

  it("applies ContextUsageUpdate events to the matching session", () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });

    emitClaudeEvents([contextEvent(1, 10.1, 100_631)]);

    const [s1, s2] = useSessionStore.getState().sessions;
    expect(s1.contextPercent).toBe(10.1);
    expect(s1.contextTokens).toBe(100_631);
    expect(s1.contextWindow).toBe(1_000_000);
    expect(s2.contextPercent).toBeUndefined();
  });

  it("the last event per session in a batch wins (latest assistant message)", () => {
    useSessionStore.setState({ sessions: [session(1)] });

    emitClaudeEvents([
      contextEvent(1, 10.1, 100_631),
      contextEvent(1, 12.5, 125_000),
    ]);

    expect(useSessionStore.getState().sessions[0].contextPercent).toBe(12.5);
  });

  it("keeps the last-known value when later batches carry no context events (idle: no decay, no flapping)", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    emitClaudeEvents([contextEvent(1, 42.0, 420_000)]);

    const before = useSessionStore.getState().sessions;
    emitClaudeEvents([
      {
        event_type: "UserMessage",
        session_id: 1,
        uuid: "u1",
        text: "hi",
        timestamp: "t",
      },
    ]);

    const after = useSessionStore.getState().sessions;
    expect(after[0].contextPercent).toBe(42.0);
    // No context events in the batch: the array must not even be replaced.
    expect(after).toBe(before);
  });

  it("buffers events that arrive before the session exists and applies them on addSession", () => {
    emitClaudeEvents([contextEvent(7, 33.3, 333_000)]);
    expect(useSessionStore.getState().sessions).toEqual([]);

    useSessionStore.getState().addSession(session(7));

    expect(useSessionStore.getState().sessions[0].contextPercent).toBe(33.3);
  });

  it("fetchSessions re-applies the last-known percentage (backend doesn't carry it)", async () => {
    useSessionStore.setState({ sessions: [session(1)] });
    emitClaudeEvents([contextEvent(1, 55.5, 555_000)]);

    // Backend refetch returns sessions without any context fields.
    invokeMock.mockResolvedValueOnce([session(1)]);
    await useSessionStore.getState().fetchSessions();

    const s = useSessionStore.getState().sessions[0];
    expect(s.contextPercent).toBe(55.5);
    expect(s.contextTokens).toBe(555_000);
  });

  it("removeSession forgets the value so a reused id starts fresh", () => {
    useSessionStore.setState({ sessions: [session(3)] });
    emitClaudeEvents([contextEvent(3, 60.0, 600_000)]);

    useSessionStore.getState().removeSession(3);
    useSessionStore.getState().addSession(session(3));

    expect(useSessionStore.getState().sessions[0].contextPercent).toBeUndefined();
  });
});
