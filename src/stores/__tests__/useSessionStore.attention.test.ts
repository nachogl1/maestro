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

import { type BackendSessionStatus, type SessionConfig, useSessionStore } from "../useSessionStore";

const listenMock = vi.mocked(listen);
const invokeMock = vi.mocked(invoke);

function session(
  id: number,
  status: BackendSessionStatus = "Idle",
  projectPath = "C:/proj",
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

/** Captured `session-status-changed` handler, so tests can emit events. */
let emitStatus: (
  sessionId: number,
  status: BackendSessionStatus | "AwaitingInput" | "IdleReminder" | "SessionEnded",
  projectPath?: string,
  extra?: Record<string, unknown>,
) => void;

/** The question dialog's NeedsInput, marked by the PreToolUse hook (issue #502). */
function emitQuestionDialog(sessionId: number): void {
  emitStatus(sessionId, "NeedsInput", "C:/proj", { question_dialog: true });
}

beforeAll(async () => {
  listenMock.mockImplementation(((_event: string, handler: (e: unknown) => void) => {
    emitStatus = (sessionId, status, projectPath = "C:/proj", extra = {}) => {
      handler({
        payload: { session_id: sessionId, project_path: projectPath, status, ...extra },
      });
    };
    return Promise.resolve(() => {});
  }) as typeof listen);
  await useSessionStore.getState().initListeners();
});

describe("useSessionStore auto-unpark attention", () => {
  beforeEach(() => {
    // Drops the per-session turn bookkeeping kept outside the store state
    // (see removeSession), so a terminal report cannot leak between tests.
    for (const id of [1, 2, 3]) useSessionStore.getState().removeSession(id);
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      attentionSessionIds: [],
    });
  });

  it("auto-unparks a parked session on the transition into NeedsInput and marks attention", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "NeedsInput");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
    expect(state.sessions[0].status).toBe("NeedsInput");
  });

  it("auto-unparks on the normalized Stop-hook AwaitingInput signal too", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "AwaitingInput");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
    expect(state.sessions[0].status).toBe("NeedsInput");
  });

  it("does not mark attention for a NeedsInput transition on an unparked session", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    emitStatus(1, "NeedsInput");

    const state = useSessionStore.getState();
    expect(state.attentionSessionIds).toEqual([]);
    expect(state.sessions[0].status).toBe("NeedsInput");
  });

  /**
   * Issue #502 (issue #478 cause 4): the unpark used to need a status change,
   * so a terminal re-parked while its dot read NeedsInput stayed parked
   * through every later question. Each new "needs you" event after the
   * re-park brings it back.
   */
  it.each([
    { name: "the question dialog", send: () => emitQuestionDialog(1) },
    { name: "a permission prompt", send: () => emitStatus(1, "NeedsInput") },
    { name: "a Stop resolved to NeedsInput", send: () => emitStatus(1, "AwaitingInput") },
  ])("a terminal re-parked while waiting comes back on $name", ({ send }) => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);
    emitStatus(1, "AwaitingInput"); // auto-unparked
    useSessionStore.getState().parkSession(1); // the user re-parks it, still NeedsInput

    send();

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it.each([
    "Done",
    "Error",
  ] as const)("a terminal re-parked after a %s report comes back on the next one, with attention", (reported) => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);
    emitStatus(1, reported); // auto-unparked
    useSessionStore.getState().parkSession(1); // the user re-parks it, dot unchanged

    emitStatus(1, reported);

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it("a terminal parked while already waiting comes back on the question dialog", () => {
    useSessionStore.setState({ sessions: [session(1, "NeedsInput")] });
    useSessionStore.getState().parkSession(1);

    emitQuestionDialog(1);

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("NeedsInput");
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it("a terminal re-parked after a turn end stays parked on the idle reminder that follows", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);
    emitStatus(1, "AwaitingInput"); // auto-unparked
    useSessionStore.getState().parkSession(1); // the user re-parks it

    emitStatus(1, "IdleReminder");

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("NeedsInput");
    expect(state.parkedSessionIds).toEqual([1]);
    expect(state.attentionSessionIds).toEqual([]);
  });

  /** Issue #502 (issue #478 cause 6): a question right after a "finished" report. */
  it.each([
    "Done",
    "Error",
  ] as const)("the question dialog after a %s report paints NeedsInput and unparks", (reported) => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    emitStatus(1, reported);
    useSessionStore.getState().parkSession(1);

    emitQuestionDialog(1);

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("NeedsInput");
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it.each([
    { name: "no marker", extra: {} },
    { name: "a string marker", extra: { question_dialog: "true" } },
    { name: "a number marker", extra: { question_dialog: 1 } },
  ])("a NeedsInput with $name after a finished report is still dropped", ({ extra }) => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    emitStatus(1, "Done");
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "NeedsInput", "C:/proj", extra);

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("Done");
    expect(state.parkedSessionIds).toEqual([1]);
  });

  it("a NEW transition into NeedsInput after a manual re-park auto-unparks again", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);
    emitStatus(1, "NeedsInput"); // auto-unparked
    useSessionStore.getState().parkSession(1); // user re-parks it

    emitStatus(1, "Working"); // agent resumes...
    expect(useSessionStore.getState().parkedSessionIds).toEqual([1]);

    emitStatus(1, "NeedsInput"); // ...and stops again: a new edge

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it("auto-unparks a parked session that finishes its work (Done)", () => {
    // An agent reporting `finished` over MCP never emits NeedsInput after it,
    // so a parked session used to stay hidden once it was ready to go.
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "Done");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
    expect(state.sessions[0].status).toBe("Done");
  });

  it("auto-unparks a parked session that errors out", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "Error");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it("auto-unparks a parked working session whose claude process exits (Idle)", () => {
    // Working → Idle turns the session's dot from green to red.
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "SessionEnded");

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("Idle");
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it("does not auto-unpark a parked session that goes Idle after already waiting", () => {
    // NeedsInput → Idle (e.g. /clear) keeps the dot red: no new transition.
    useSessionStore.setState({ sessions: [session(1, "NeedsInput")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "SessionEnded");

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("Idle");
    expect(state.parkedSessionIds).toEqual([1]);
  });

  it("leaves a parked session alone while it is only working", () => {
    useSessionStore.setState({ sessions: [session(1, "Idle")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "Working");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([1]);
    expect(state.attentionSessionIds).toEqual([]);
  });

  it("parkSession clears a stale attention highlight", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);
    emitStatus(1, "NeedsInput");
    expect(useSessionStore.getState().attentionSessionIds).toEqual([1]);

    useSessionStore.getState().parkSession(1);

    expect(useSessionStore.getState().attentionSessionIds).toEqual([]);
  });

  it("clearSessionAttention removes only the given id and ignores unknown ids", () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1, 2],
    });

    useSessionStore.getState().clearSessionAttention(3); // no-op
    expect(useSessionStore.getState().attentionSessionIds).toEqual([1, 2]);

    useSessionStore.getState().clearSessionAttention(1);
    expect(useSessionStore.getState().attentionSessionIds).toEqual([2]);
  });

  it("removeSession prunes the attention id", () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1, 2],
    });

    useSessionStore.getState().removeSession(1);

    expect(useSessionStore.getState().attentionSessionIds).toEqual([2]);
  });

  it("does not auto-unpark when the agent reported Done/Error in the turn that just ended", () => {
    // The turn end that follows the agent's own terminal report changes
    // nothing — so no unpark and no attention either.
    useSessionStore.setState({
      sessions: [session(1, "Working"), session(2, "Working")],
    });
    emitStatus(1, "Done");
    emitStatus(2, "Error");
    useSessionStore.getState().parkSession(1);
    useSessionStore.getState().parkSession(2);

    emitStatus(1, "AwaitingInput");
    emitStatus(2, "AwaitingInput");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([1, 2]);
    expect(state.attentionSessionIds).toEqual([]);
    expect(state.sessions.map((s) => s.status)).toEqual(["Done", "Error"]);
  });

  /**
   * Issue #77: a session left at Done by an *earlier* turn is not evidence
   * about this one. The stop means the agent is waiting, so a parked session
   * must come back into view like any other NeedsInput transition.
   */
  it("auto-unparks a parked session whose Done is left over from an earlier turn", () => {
    useSessionStore.setState({ sessions: [session(1, "Done")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "AwaitingInput");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
    expect(state.sessions[0].status).toBe("NeedsInput");
  });

  /**
   * The CLI's 60s idle reminder repeats a turn end the user already saw. It
   * may repaint the status (so the shelf chip still turns red if the real
   * turn end was lost), but it must not pull the session out of the tray.
   */
  it("the idle reminder repaints a parked session but does not auto-unpark it", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "IdleReminder");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([1]);
    expect(state.attentionSessionIds).toEqual([]);
    expect(state.sessions[0].status).toBe("NeedsInput");
  });

  it("the idle reminder leaves a parked session that reported Done untouched", () => {
    useSessionStore.setState({ sessions: [session(1, "Done")] });
    useSessionStore.getState().parkSession(1);

    emitStatus(1, "IdleReminder");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([1]);
    expect(state.sessions[0].status).toBe("Done");
  });

  it("fetchSessions prunes attention ids absent from the fetched list", async () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1, 2],
    });

    // Backend now only knows about session 2.
    invokeMock.mockResolvedValueOnce([session(2, "NeedsInput")]);
    await useSessionStore.getState().fetchSessions();

    expect(useSessionStore.getState().attentionSessionIds).toEqual([2]);
  });

  it("fetchSessionsForProject prunes attention ids absent from the fetched list", async () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1],
    });

    invokeMock.mockResolvedValueOnce([session(2, "NeedsInput")]);
    await useSessionStore.getState().fetchSessionsForProject("C:/proj");

    expect(useSessionStore.getState().attentionSessionIds).toEqual([]);
  });

  it("removeSessionsForProject prunes attention ids of removed sessions", async () => {
    useSessionStore.setState({
      sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
      attentionSessionIds: [1, 2],
    });

    invokeMock.mockResolvedValueOnce([session(1, "NeedsInput")]);
    await useSessionStore.getState().removeSessionsForProject("C:/proj");

    expect(useSessionStore.getState().attentionSessionIds).toEqual([2]);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([2]);
  });
});
