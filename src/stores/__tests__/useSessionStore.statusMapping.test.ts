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
  type PendingWork,
  resolveStatusEvent,
  type SessionConfig,
  useSessionStore,
} from "../useSessionStore";

const listenMock = vi.mocked(listen);

const PROJECT = "C:/proj";

/** Pending work of the kinds given, zero of every other kind. */
function pending(work: Partial<PendingWork>): PendingWork {
  return { subagents: 0, commands: 0, monitors: 0, workflows: 0, wakeups: 0, loops: 0, ...work };
}

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

/** Captured `session-status-changed` handler (registered once per module). */
let handler: ((event: { payload: unknown }) => void) | null = null;

function emit(payload: Record<string, unknown>): void {
  if (!handler) throw new Error("session-status-changed listener was never registered");
  handler({ payload });
}

function wire(
  sessionId: number,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: sessionId,
    project_path: PROJECT,
    status,
    message: "msg",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Pure signal→state mapping (issue #105) — table-driven.
// ---------------------------------------------------------------------------

describe("resolveStatusEvent: signal → state table", () => {
  type Row = {
    name: string;
    existing: BackendSessionStatus | undefined;
    incoming: string;
    subagents?: number;
    /** Pending background work (issue #469); overrides `subagents` when set. */
    work?: Partial<PendingWork>;
    /** The agent reported Done/Error during the turn this Stop closes. */
    reportedThisTurn?: boolean;
    expected: BackendSessionStatus | null;
  };

  const rows: Row[] = [
    // Plain statuses apply verbatim (last writer wins).
    {
      name: "Working onto unknown session",
      existing: undefined,
      incoming: "Working",
      expected: "Working",
    },
    {
      name: "Idle onto Starting (SessionStart hook)",
      existing: "Starting",
      incoming: "Idle",
      expected: "Idle",
    },
    {
      name: "Working onto Done (UserPromptSubmit exits a finished state)",
      existing: "Done",
      incoming: "Working",
      expected: "Working",
    },
    {
      name: "Working onto Error (new turn after a failure)",
      existing: "Error",
      incoming: "Working",
      expected: "Working",
    },
    // Stop hook (AwaitingInput): NeedsInput unless the agent reported a
    // terminal state during this very turn, or it handed off to subagents.
    {
      name: "Stop hook onto Working",
      existing: "Working",
      incoming: "AwaitingInput",
      expected: "NeedsInput",
    },
    {
      name: "Stop hook onto Idle",
      existing: "Idle",
      incoming: "AwaitingInput",
      expected: "NeedsInput",
    },
    {
      name: "Stop hook dropped when Done was reported this turn",
      existing: "Done",
      incoming: "AwaitingInput",
      reportedThisTurn: true,
      expected: null,
    },
    {
      name: "Stop hook dropped when Error was reported this turn",
      existing: "Error",
      incoming: "AwaitingInput",
      reportedThisTurn: true,
      expected: null,
    },
    // Issue #77 cause 1: a STALE terminal state — no fresh report in the
    // turn this stop closes — must not swallow the turn end.
    {
      name: "Stop hook onto a stale Done",
      existing: "Done",
      incoming: "AwaitingInput",
      expected: "NeedsInput",
    },
    {
      name: "Stop hook onto a stale Error",
      existing: "Error",
      incoming: "AwaitingInput",
      expected: "NeedsInput",
    },
    {
      name: "Stop hook recovers a startup Timeout (the CLI is alive)",
      existing: "Timeout",
      incoming: "AwaitingInput",
      expected: "NeedsInput",
    },
    {
      name: "Stop hook with running subagents",
      existing: "Working",
      incoming: "AwaitingInput",
      subagents: 2,
      expected: "Working",
    },
    {
      name: "Stop hook with a pending background command and no subagents",
      existing: "Working",
      incoming: "AwaitingInput",
      work: { commands: 1 },
      expected: "Working",
    },
    {
      name: "Stop hook with an active cron loop",
      existing: "Working",
      incoming: "AwaitingInput",
      work: { loops: 1 },
      expected: "Working",
    },
    // SessionEnd hook (SessionEnded): process gone → Idle; outcome survives.
    {
      name: "SessionEnd onto Working",
      existing: "Working",
      incoming: "SessionEnded",
      expected: "Idle",
    },
    {
      name: "SessionEnd onto NeedsInput",
      existing: "NeedsInput",
      incoming: "SessionEnded",
      expected: "Idle",
    },
    { name: "SessionEnd keeps Done", existing: "Done", incoming: "SessionEnded", expected: null },
    { name: "SessionEnd keeps Error", existing: "Error", incoming: "SessionEnded", expected: null },
    // NeedsInput (Notification / AskUserQuestion / MCP): dropped on Done and
    // Error (the CLI's 60s idle reminder must not repaint a finished
    // session), but allowed to recover a false startup Timeout.
    {
      name: "NeedsInput onto Working (permission prompt)",
      existing: "Working",
      incoming: "NeedsInput",
      expected: "NeedsInput",
    },
    {
      name: "NeedsInput dropped on Done",
      existing: "Done",
      incoming: "NeedsInput",
      expected: null,
    },
    {
      name: "NeedsInput dropped on Error",
      existing: "Error",
      incoming: "NeedsInput",
      expected: null,
    },
    {
      name: "NeedsInput recovers a Timeout",
      existing: "Timeout",
      incoming: "NeedsInput",
      expected: "NeedsInput",
    },
    // IdleReminder (Notification idle_prompt): repaints a lost or overwritten
    // turn end, dropped on Done/Error and while subagents still run.
    {
      name: "Idle reminder onto Working (turn end lost or overwritten)",
      existing: "Working",
      incoming: "IdleReminder",
      expected: "NeedsInput",
    },
    {
      name: "Idle reminder onto Idle",
      existing: "Idle",
      incoming: "IdleReminder",
      expected: "NeedsInput",
    },
    {
      name: "Idle reminder dropped on Done",
      existing: "Done",
      incoming: "IdleReminder",
      expected: null,
    },
    {
      name: "Idle reminder dropped on Error",
      existing: "Error",
      incoming: "IdleReminder",
      expected: null,
    },
    {
      name: "Idle reminder dropped while subagents run",
      existing: "Working",
      incoming: "IdleReminder",
      subagents: 1,
      expected: null,
    },
    {
      name: "Idle reminder dropped while background work is pending",
      existing: "Working",
      incoming: "IdleReminder",
      work: { wakeups: 1 },
      expected: null,
    },
  ];

  it("the idle reminder is marked so it never auto-unparks", () => {
    const resolved = resolveStatusEvent(
      { status: "IdleReminder" as BackendSessionStatus, message: "msg" },
      "Working",
      0,
    );
    expect(resolved?.suppressAutoUnpark).toBe(true);
    const stop = resolveStatusEvent(
      { status: "AwaitingInput" as BackendSessionStatus, message: "msg" },
      "Working",
      0,
    );
    expect(stop?.suppressAutoUnpark).toBeUndefined();
  });

  it.each(rows)("$name", ({ existing, incoming, subagents, work, reportedThisTurn, expected }) => {
    const resolved = resolveStatusEvent(
      { status: incoming as BackendSessionStatus, message: "msg" },
      existing,
      work ? pending(work) : (subagents ?? 0),
      reportedThisTurn ?? false,
    );
    if (expected === null) {
      expect(resolved).toBeNull();
    } else {
      expect(resolved?.status).toBe(expected);
    }
  });

  it.each([
    { work: { commands: 1 }, message: "Waiting on 1 background command" },
    { work: { commands: 2 }, message: "Waiting on 2 background commands" },
    { work: { monitors: 1 }, message: "Watching 1 monitor" },
    { work: { workflows: 1 }, message: "1 workflow running" },
    { work: { wakeups: 1 }, message: "Scheduled to wake up" },
    { work: { loops: 1 }, message: "Loop active" },
    { work: { subagents: 2 }, message: "2 subagents running" },
    {
      work: { subagents: 2, commands: 1, wakeups: 1 },
      message: "2 subagents running, waiting on 1 background command, scheduled to wake up",
    },
  ])("a Stop held at Working by pending work says: $message", ({ work, message }) => {
    const resolved = resolveStatusEvent(
      { status: "AwaitingInput", message: "Waiting for your input" },
      "Working",
      pending(work),
    );
    expect(resolved).toEqual({
      status: "Working",
      statusMessage: message,
      needsInputPrompt: undefined,
    });
  });

  it("labels the subagent hand-off and clears the prompt on SessionEnded", () => {
    const handedOff = resolveStatusEvent(
      { status: "AwaitingInput", message: "Waiting for your input" },
      "Working",
      1,
    );
    expect(handedOff).toEqual({
      status: "Working",
      statusMessage: "1 subagent running",
      needsInputPrompt: undefined,
    });

    const ended = resolveStatusEvent(
      { status: "SessionEnded", message: "Claude session ended", needs_input_prompt: "stale?" },
      "NeedsInput",
      0,
    );
    expect(ended).toEqual({
      status: "Idle",
      statusMessage: "Claude session ended",
      needsInputPrompt: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Signal sequences through the real listener (issue #105 classes 2/3).
// ---------------------------------------------------------------------------

describe("session status: signal sequences through the listener", () => {
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
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      flaggedSessionIds: [],
      attentionSessionIds: [],
    });
  });

  it("class 2 regression: a Done session works again on the next turn", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    // The agent reports `finished` over MCP, closing the turn as Done.
    emit(wire(1, "Done", { message: "all finished" }));
    expect(useSessionStore.getState().sessions[0].status).toBe("Done");

    // Stop hook right after the MCP `finished` report — same turn, so it is
    // dropped and Done stays.
    emit(wire(1, "AwaitingInput"));
    expect(useSessionStore.getState().sessions[0].status).toBe("Done");

    // The user submits a NEW prompt → UserPromptSubmit hook → Working.
    emit(wire(1, "Working", { message: "Processing your request" }));
    expect(useSessionStore.getState().sessions[0].status).toBe("Working");

    // That turn's Stop hook now normalizes to NeedsInput again.
    emit(wire(1, "AwaitingInput"));
    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });

  it("class 2 regression: process exit clears a stale NeedsInput", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    emit(wire(1, "NeedsInput", { needs_input_prompt: "Deploy to prod?" }));
    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
    expect(useSessionStore.getState().sessions[0].needsInputPrompt).toBe("Deploy to prod?");

    emit(wire(1, "SessionEnded", { message: "Claude session ended" }));
    const updated = useSessionStore.getState().sessions[0];
    expect(updated.status).toBe("Idle");
    expect(updated.needsInputPrompt).toBeUndefined();
  });

  it("class 2: process exit preserves a reported Done", () => {
    useSessionStore.setState({ sessions: [session(1, "Done")] });

    emit(wire(1, "SessionEnded"));

    expect(useSessionStore.getState().sessions[0].status).toBe("Done");
  });

  it("class 3 regression: a mid-turn permission prompt turns the session red", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    // Notification hook fires while the turn is still running (no Stop).
    emit(
      wire(1, "NeedsInput", {
        message: "Claude needs your permission to use Bash",
        needs_input_prompt: "Claude needs your permission to use Bash",
      }),
    );

    const updated = useSessionStore.getState().sessions[0];
    expect(updated.status).toBe("NeedsInput");
    expect(updated.needsInputPrompt).toBe("Claude needs your permission to use Bash");
  });

  it("the idle-prompt reminder does not repaint a finished session", () => {
    useSessionStore.setState({ sessions: [session(1, "Done")] });

    // 60s after the turn ended, the CLI's idle Notification fires.
    emit(wire(1, "NeedsInput", { message: "Claude is waiting for your input" }));

    expect(useSessionStore.getState().sessions[0].status).toBe("Done");
  });

  it("matches sessions across Windows path forms instead of buffering forever", () => {
    useSessionStore.setState({ sessions: [session(1, "Working")] });

    // Backend canonical form (`\\?\` prefix, backslashes) for the same project.
    emit({
      session_id: 1,
      project_path: "\\\\?\\C:\\proj",
      status: "AwaitingInput",
      message: "Waiting for your input",
    });

    expect(useSessionStore.getState().sessions[0].status).toBe("NeedsInput");
  });
});
