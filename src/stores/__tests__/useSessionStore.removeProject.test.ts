import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";

import { type SessionConfig, useSessionStore } from "../useSessionStore";

const invokeMock = vi.mocked(invoke);

function session(id: number, projectPath: string): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status: "Idle",
    worktree_path: null,
    project_path: projectPath,
  };
}

const GONE = "C:/gone";
const KEPT = "C:/kept";

describe("useSessionStore removeSessionsForProject", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [session(1, GONE), session(2, GONE), session(3, KEPT)],
      parkedSessionIds: [1, 3],
      flaggedSessionIds: [2, 3],
      attentionSessionIds: [1, 2, 3],
    });
    invokeMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("prunes the project's sessions when the backend accepts", async () => {
    invokeMock.mockResolvedValue([session(1, GONE), session(2, GONE)]);

    await useSessionStore.getState().removeSessionsForProject(GONE);

    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([3]);
  });

  /**
   * `remove_sessions_for_project` rejects whenever `std::fs::canonicalize`
   * fails on the project path — a directory that was moved, deleted or is
   * temporarily unreachable. `closeTab` drops the tab either way, so
   * swallowing the rejection stranded every one of that project's sessions in
   * the store forever: stale parked chips in the eagle shelf and inflated
   * session/agent counts with no tab left to clear them (issue #76).
   */
  it("still prunes the project's sessions when the backend rejects", async () => {
    invokeMock.mockRejectedValue(
      new Error("Invalid project path 'C:/gone': The system cannot find the path specified."),
    );

    const removed = await useSessionStore.getState().removeSessionsForProject(GONE);

    expect(removed).toEqual([]);
    const state = useSessionStore.getState();
    expect(state.sessions.map((s) => s.id)).toEqual([3]);
    expect(state.parkedSessionIds).toEqual([3]);
    expect(state.flaggedSessionIds).toEqual([3]);
    expect(state.attentionSessionIds).toEqual([3]);
  });

  it("leaves other projects alone when the backend rejects", async () => {
    invokeMock.mockRejectedValue(new Error("Invalid project path"));

    await useSessionStore.getState().removeSessionsForProject("C:/never-opened");

    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([1, 2, 3]);
  });
});
