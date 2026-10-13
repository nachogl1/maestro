import { beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));

// Tauri APIs must be mocked before importing the store module.
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import type { ClaudeEvent } from "@/types/claude-events";
import { initActivityListener, stopActivityListener, useActivityStore } from "../useActivityStore";

const T = "2026-01-01T00:00:00Z";

function started(sessionId: number, uuid: string): ClaudeEvent {
  return {
    event_type: "SessionStarted",
    session_id: sessionId,
    claude_session_uuid: uuid,
    transcript_path: "/t.jsonl",
    timestamp: T,
  };
}

function tokens(sessionId: number, input: number, output: number): ClaudeEvent {
  return {
    event_type: "TokenUsageUpdate",
    session_id: sessionId,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    timestamp: T,
  };
}

function edited(sessionId: number, path: string): ClaudeEvent {
  return {
    event_type: "FileEdited",
    session_id: sessionId,
    file_path: path,
    tool: "Edit",
    timestamp: T,
  };
}

function created(sessionId: number, path: string): ClaudeEvent {
  return { event_type: "FileCreated", session_id: sessionId, file_path: path, timestamp: T };
}

function user(sessionId: number, text: string): ClaudeEvent {
  return { event_type: "UserMessage", session_id: sessionId, uuid: text, text, timestamp: T };
}

describe("useActivityStore", () => {
  beforeEach(() => {
    stopActivityListener();
    listenMock.mockReset();
    useActivityStore.setState({ sessions: {} });
  });

  it("getSession returns one stable empty object for unknown sessions", () => {
    const a = useActivityStore.getState().getSession(42);
    const b = useActivityStore.getState().getSession(43);

    expect(a).toBe(b);
    expect(a.events).toEqual([]);
    expect(a.totalInputTokens).toBe(0);
  });

  it("addEvents with an empty batch does not change state", () => {
    const before = useActivityStore.getState().sessions;
    useActivityStore.getState().addEvents([]);
    expect(useActivityStore.getState().sessions).toBe(before);
  });

  it("aggregates tokens and de-duplicates modified files", () => {
    useActivityStore
      .getState()
      .addEvents([
        tokens(1, 10, 5),
        edited(1, "a.ts"),
        tokens(1, 3, 2),
        created(1, "b.ts"),
        edited(1, "a.ts"),
      ]);

    const s = useActivityStore.getState().getSession(1);
    expect(s.events).toHaveLength(5);
    expect(s.totalInputTokens).toBe(13);
    expect(s.totalOutputTokens).toBe(7);
    expect(s.filesModified).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps sessions separate within one batch and across batches", () => {
    useActivityStore.getState().addEvents([tokens(1, 1, 1), tokens(2, 5, 5)]);
    useActivityStore.getState().addEvents([tokens(1, 1, 1)]);

    expect(useActivityStore.getState().getSession(1).totalInputTokens).toBe(2);
    expect(useActivityStore.getState().getSession(2).totalInputTokens).toBe(5);
  });

  it("does not mutate the previous session state", () => {
    useActivityStore.getState().addEvents([user(1, "a")]);
    const before = useActivityStore.getState().getSession(1);

    useActivityStore.getState().addEvents([user(1, "b")]);

    expect(before.events).toHaveLength(1);
    expect(useActivityStore.getState().getSession(1).events).toHaveLength(2);
  });

  it("SessionStarted resets activity but keeps conversation UUIDs", () => {
    useActivityStore
      .getState()
      .addEvents([started(1, "u1"), tokens(1, 100, 100), edited(1, "x.ts"), started(1, "u2")]);
    useActivityStore.getState().addEvents([started(1, "u1")]);

    const s = useActivityStore.getState().getSession(1);
    expect(s.events).toHaveLength(1);
    expect(s.events[0].event_type).toBe("SessionStarted");
    expect(s.totalInputTokens).toBe(0);
    expect(s.filesModified).toEqual([]);
    expect(s.conversationUuids).toEqual(["u1", "u2"]);
  });

  it("caps events at 500, keeping the newest", () => {
    const batch = Array.from({ length: 510 }, (_, i) => user(1, `m${i}`));
    useActivityStore.getState().addEvents(batch);

    const events = useActivityStore.getState().getSession(1).events;
    expect(events).toHaveLength(500);
    expect(events[0]).toMatchObject({ text: "m10" });
    expect(events[499]).toMatchObject({ text: "m509" });
  });

  it("clearSession removes only that session", () => {
    useActivityStore.getState().addEvents([user(1, "a"), user(2, "b")]);

    useActivityStore.getState().clearSession(1);

    expect(Object.keys(useActivityStore.getState().sessions)).toEqual(["2"]);
  });

  describe("listener", () => {
    it("subscribes once and folds incoming batches into the store", async () => {
      let handler: ((e: { payload: ClaudeEvent[] }) => void) | undefined;
      const unlisten = vi.fn();
      listenMock.mockImplementation(async (_name: string, cb: typeof handler) => {
        handler = cb;
        return unlisten;
      });

      await initActivityListener();
      await initActivityListener();

      expect(listenMock).toHaveBeenCalledTimes(1);
      expect(listenMock).toHaveBeenCalledWith("claude-events", expect.any(Function));
      handler?.({ payload: [tokens(7, 4, 1)] });
      expect(useActivityStore.getState().getSession(7).totalInputTokens).toBe(4);

      stopActivityListener();
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("unregisters a listener that resolves after stop was called", async () => {
      const unlisten = vi.fn();
      let resolveListen!: (fn: () => void) => void;
      listenMock.mockReturnValue(
        new Promise((r) => {
          resolveListen = r;
        }),
      );

      const pending = initActivityListener();
      stopActivityListener();
      resolveListen(unlisten);
      await pending;

      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });
});
