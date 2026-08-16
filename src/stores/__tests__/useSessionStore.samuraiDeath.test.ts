import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { listen } from "@tauri-apps/api/event";

import {
  type BackendSessionStatus,
  initSamuraiSupervisorListener,
  type SessionConfig,
  useSessionStore,
} from "../useSessionStore";

const listenMock = vi.mocked(listen);

function session(
  id: number,
  status: BackendSessionStatus = "Working",
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

/** Captured `samurai-supervisor-event` handler, so tests can emit events. */
let emitSupervisorEvent: (sessionId: number, state: string, project?: string) => void;

beforeAll(async () => {
  listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
    if (event === "samurai-supervisor-event") {
      emitSupervisorEvent = (sessionId, state, project = "C:/proj") => {
        handler({ payload: { session_id: sessionId, project, state } });
      };
    }
    return Promise.resolve(() => {});
  }) as typeof listen);
  await initSamuraiSupervisorListener();
});

describe("useSessionStore samurai death listener (issue #44)", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      attentionSessionIds: [],
      samuraiBySessionId: {},
    });
  });

  // Issue #122: DEAD is now a terminal state like KILLED/PARKED — the store
  // only flips status/chrome here, TerminalGrid's samurai-park effect is what
  // moves the tile into the footer tray. ParkedShelf reads its attention
  // border straight off the session's Error status (see chipAttentionClass /
  // ATTENTION_STATUSES in ParkedShelf.tsx), so this listener no longer needs
  // to touch attentionSessionIds too.
  it("flips a DEAD session to Error, leaving attention tracking to the tray's own status read", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    emitSupervisorEvent(1, "DEAD");

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("Error");
    expect(state.sessions[0].statusMessage).toBe("claude process died (Samurai watchdog)");
    expect(state.attentionSessionIds).toEqual([]);
  });

  it("leaves an already-parked session parked on DEAD — the tray chip's Error border is the signal", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });
    useSessionStore.getState().parkSession(1);

    emitSupervisorEvent(1, "DEAD");

    const state = useSessionStore.getState();
    expect(state.parkedSessionIds).toEqual([1]);
    expect(state.sessions[0].status).toBe("Error");
  });

  it("ignores non-DEAD supervisor states", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    for (const s of ["WORKING", "HANDOFF_REQUESTED", "PARKED", "KILLED"]) {
      emitSupervisorEvent(1, s);
    }

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("Working");
    expect(state.attentionSessionIds).toEqual([]);
  });

  it("ignores DEAD events for sessions not in the store", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    emitSupervisorEvent(99, "DEAD");

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("Working");
    expect(state.attentionSessionIds).toEqual([]);
  });

  it("matches on project path, not just session id", () => {
    useSessionStore.setState({
      sessions: [session(1, "Working", "C:/proj"), session(1, "Working", "C:/other")],
    });

    emitSupervisorEvent(1, "DEAD", "C:/other");

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("Working");
    expect(state.sessions[1].status).toBe("Error");
  });

  it("matches project paths across separator spellings", () => {
    // Backend snapshots carry canonicalized Windows paths; samePath must
    // bridge the backslash/forward-slash spelling difference.
    useSessionStore.setState({ sessions: [session(1, "Working", "C:/proj")] });

    emitSupervisorEvent(1, "DEAD", "C:\\proj");

    expect(useSessionStore.getState().sessions[0].status).toBe("Error");
  });

  it("repeated DEAD events stay idempotent (status stable, no attention churn)", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    emitSupervisorEvent(1, "DEAD");
    emitSupervisorEvent(1, "DEAD");

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe("Error");
    expect(state.attentionSessionIds).toEqual([]);
  });
});
