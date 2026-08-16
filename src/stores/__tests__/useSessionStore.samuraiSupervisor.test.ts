import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  type BackendSessionStatus,
  initSamuraiSupervisorListener,
  SAMURAI_TERMINAL_STATES,
  type SessionConfig,
  stopSamuraiSupervisorListener,
  useSessionStore,
} from "../useSessionStore";

const listenMock = vi.mocked(listen);
const invokeMock = vi.mocked(invoke);

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

function snapshot(sessionId: number, overrides: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    project: "C:/proj",
    epic: "#36",
    generation: 1,
    state: "WORKING",
    previous_state: null,
    in_flight: null,
    ts: "2026-08-06T12:00:00Z",
    ...overrides,
  };
}

/** Captured event handlers, so tests can emit supervisor/allowance events. */
let emitSupervisorEvent: (payload: Record<string, unknown>) => void;
let emitAllowanceEvent: () => void;

beforeAll(async () => {
  // The seed on init must find nothing supervised — individual tests emit
  // their own events instead.
  invokeMock.mockResolvedValue([]);
  listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
    if (event === "samurai-supervisor-event") {
      emitSupervisorEvent = (payload) => handler({ payload });
    }
    if (event === "samurai-allowance-event") {
      emitAllowanceEvent = () => handler({ payload: {} });
    }
    return Promise.resolve(() => {});
  }) as typeof listen);
  await initSamuraiSupervisorListener();
});

describe("useSessionStore samurai supervisor tracking (issue #46)", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      attentionSessionIds: [],
      samuraiBySessionId: {},
    });
  });

  it("records a supervised session's project, epic, generation and state", () => {
    emitSupervisorEvent(snapshot(1, { generation: 2, state: "WORKING" }));

    expect(useSessionStore.getState().samuraiBySessionId[1]).toEqual({
      project: "C:/proj",
      epic: "#36",
      generation: 2,
      state: "WORKING",
    });
  });

  it("updates the state on every transition event", () => {
    emitSupervisorEvent(snapshot(1, { state: "WORKING" }));
    emitSupervisorEvent(snapshot(1, { state: "HANDOFF_REQUESTED", previous_state: "WORKING" }));

    expect(useSessionStore.getState().samuraiBySessionId[1].state).toBe("HANDOFF_REQUESTED");
  });

  it("tracks sessions independently by id", () => {
    emitSupervisorEvent(snapshot(1, { generation: 1 }));
    emitSupervisorEvent(snapshot(2, { generation: 3, state: "PARKED" }));

    const map = useSessionStore.getState().samuraiBySessionId;
    expect(map[1].generation).toBe(1);
    expect(map[2]).toMatchObject({ generation: 3, state: "PARKED" });
  });

  it("removeSession drops the supervision entry (stale-id hygiene)", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    emitSupervisorEvent(snapshot(1));

    useSessionStore.getState().removeSession(1);

    expect(useSessionStore.getState().samuraiBySessionId[1]).toBeUndefined();
  });

  it("seeds supervised sessions from samurai_list_sessions on init", async () => {
    // stop + init re-runs the whole init path, including the seed — this is
    // the "session supervised before the frontend mounted" case.
    stopSamuraiSupervisorListener();
    invokeMock.mockResolvedValueOnce([snapshot(7, { generation: 4, state: "PARKED" })]);
    await initSamuraiSupervisorListener();
    // Seeding is fire-and-forget after init resolves; flush the microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useSessionStore.getState().samuraiBySessionId[7]).toEqual({
      project: "C:/proj",
      epic: "#36",
      generation: 4,
      state: "PARKED",
    });
  });

  it("allowance events flag live supervised sessions via the existing attention list", () => {
    useSessionStore.setState({
      sessions: [session(1), session(2), session(3, "Working", "C:/other")],
    });
    emitSupervisorEvent(snapshot(1, { state: "WORKING" }));
    emitSupervisorEvent(snapshot(2, { state: "PARKED" })); // terminal — not flagged

    emitAllowanceEvent();

    // Session 3 is not supervised: untouched. Session 2 is parked (terminal).
    expect(useSessionStore.getState().attentionSessionIds).toEqual([1]);
  });

  it("allowance events do not duplicate attention ids", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    emitSupervisorEvent(snapshot(1, { state: "WORKING" }));

    emitAllowanceEvent();
    emitAllowanceEvent();

    expect(useSessionStore.getState().attentionSessionIds).toEqual([1]);
  });

  it("allowance events are a no-op with nothing supervised", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    const before = useSessionStore.getState().attentionSessionIds;

    emitAllowanceEvent();

    expect(useSessionStore.getState().attentionSessionIds).toBe(before);
  });

  // Issue #122: every terminal supervisor state — KILLED (replication),
  // PARKED (allowance park), and now DEAD (watchdog) — parks its tile into
  // the existing footer tray (TerminalGrid's samurai-park effect) instead of
  // leaving it live in the grid. Live states never park a tile.
  it("terminal states are exactly KILLED, PARKED and DEAD", () => {
    expect(SAMURAI_TERMINAL_STATES.has("KILLED")).toBe(true);
    expect(SAMURAI_TERMINAL_STATES.has("PARKED")).toBe(true);
    expect(SAMURAI_TERMINAL_STATES.has("DEAD")).toBe(true);
    for (const live of ["WORKING", "HANDOFF_REQUESTED", "HANDOFF_WRITTEN", "PARK_REQUESTED"]) {
      expect(SAMURAI_TERMINAL_STATES.has(live)).toBe(false);
    }
  });

  it("a park chain lands PARKED in samuraiBySessionId for the samurai-park effect", () => {
    useSessionStore.setState({ sessions: [session(1)] });
    emitSupervisorEvent(snapshot(1, { state: "PARK_REQUESTED", previous_state: "WORKING" }));
    expect(
      SAMURAI_TERMINAL_STATES.has(useSessionStore.getState().samuraiBySessionId[1].state),
    ).toBe(false);

    emitSupervisorEvent(snapshot(1, { state: "PARKED", previous_state: "PARK_REQUESTED" }));

    const info = useSessionStore.getState().samuraiBySessionId[1];
    expect(info.state).toBe("PARKED");
    expect(SAMURAI_TERMINAL_STATES.has(info.state)).toBe(true);
  });
});
