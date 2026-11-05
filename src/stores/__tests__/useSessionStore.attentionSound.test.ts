import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
// The Settings switch persists through the Tauri store plugin.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));
// Tests never make noise: the tone is mocked behind its own module.
vi.mock("@/lib/attentionSound", () => ({
  playAttentionTone: vi.fn(),
}));

import { listen } from "@tauri-apps/api/event";
import { playAttentionTone } from "@/lib/attentionSound";
import { type SubagentInfo, useAgentStore } from "../useAgentStore";
import { useAttentionSoundStore } from "../useAttentionSoundStore";
import { type BackendSessionStatus, type SessionConfig, useSessionStore } from "../useSessionStore";

const listenMock = vi.mocked(listen);
const toneMock = vi.mocked(playAttentionTone);

type WireStatus = BackendSessionStatus | "AwaitingInput" | "IdleReminder" | "SessionEnded";

function session(id: number, status: BackendSessionStatus): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: "C:/proj",
  };
}

function runningSubagent(sessionId: number): SubagentInfo {
  return {
    agentId: "a1",
    sessionId,
    agentType: "Explore",
    description: "look around",
    prompt: "go",
    runInBackground: true,
    spawnedAt: new Date().toISOString(),
    completedAt: null,
    success: null,
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

let emitStatus: (sessionId: number, status: WireStatus) => void;

beforeAll(async () => {
  listenMock.mockImplementation(((_event: string, handler: (e: unknown) => void) => {
    emitStatus = (sessionId, status) => {
      handler({ payload: { session_id: sessionId, project_path: "C:/proj", status } });
    };
    return Promise.resolve(() => {});
  }) as typeof listen);
  await useSessionStore.getState().initListeners();
});

/** A terminal that starts at `from`, optionally parked. */
function startTerminal(from: BackendSessionStatus, parked: boolean): void {
  useSessionStore.setState({ sessions: [session(1, from)] });
  if (parked) useSessionStore.getState().parkSession(1);
}

/** The moments the issue asks a sound for: each must sound exactly once. */
const CALLS_FOR_USER: {
  name: string;
  from: BackendSessionStatus;
  parked: boolean;
  to: WireStatus;
}[] = [
  { name: "a parked terminal needs input", from: "Working", parked: true, to: "NeedsInput" },
  { name: "a parked terminal's turn ends", from: "Working", parked: true, to: "AwaitingInput" },
  { name: "a parked terminal finishes", from: "Working", parked: true, to: "Done" },
  { name: "a visible terminal needs input", from: "Working", parked: false, to: "NeedsInput" },
];

describe("useSessionStore attention sound", () => {
  beforeEach(() => {
    useSessionStore.getState().removeSession(1);
    useSessionStore.setState({ sessions: [], parkedSessionIds: [], attentionSessionIds: [] });
    useAgentStore.setState({ agents: [] });
    useAttentionSoundStore.setState({ enabled: true });
    toneMock.mockClear();
  });

  it("is off until the user switches it on in Settings", () => {
    expect(useAttentionSoundStore.getInitialState().enabled).toBe(false);
  });

  it.each(CALLS_FOR_USER)("plays once when $name, and again never for the same event", (c) => {
    startTerminal(c.from, c.parked);

    emitStatus(1, c.to);
    emitStatus(1, c.to);

    expect(toneMock).toHaveBeenCalledTimes(1);
  });

  it.each(CALLS_FOR_USER)("stays silent when $name with the switch off", (c) => {
    useAttentionSoundStore.setState({ enabled: false });
    startTerminal(c.from, c.parked);

    emitStatus(1, c.to);

    expect(toneMock).not.toHaveBeenCalled();
  });

  it("stays silent for status changes that do not call the user", () => {
    startTerminal("Idle", false);
    emitStatus(1, "Working");
    emitStatus(1, "Done"); // finished while in view: no auto-unpark, not a question
    // An idle reminder repeats a turn end the user already saw.
    startTerminal("Working", false);
    emitStatus(1, "IdleReminder");

    expect(toneMock).not.toHaveBeenCalled();
  });

  it("plays once when a parked terminal whose subagents went silent comes back", () => {
    vi.useFakeTimers();
    try {
      startTerminal("Working", true);
      useAgentStore.setState({ agents: [runningSubagent(1)] });
      emitStatus(1, "AwaitingInput"); // handed off: still Working, no sound
      expect(toneMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(31 * 60 * 1000);

      expect(useSessionStore.getState().parkedSessionIds).toEqual([]);
      expect(toneMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
