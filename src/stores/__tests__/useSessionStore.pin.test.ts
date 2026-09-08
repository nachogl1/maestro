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

function session(id: number, projectPath = "C:/proj"): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status: "Idle",
    worktree_path: null,
    project_path: projectPath,
  };
}

describe("useSessionStore pinned terminals", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [session(1), session(2)],
      parkedSessionIds: [],
      flaggedSessionIds: [],
      attentionSessionIds: [],
      pinnedSessionIds: [],
    });
  });

  it("pins a terminal", () => {
    useSessionStore.getState().toggleSessionPin(1);

    expect(useSessionStore.getState().pinnedSessionIds).toEqual([1]);
  });

  it("unpins on a second toggle", () => {
    useSessionStore.getState().toggleSessionPin(1);
    useSessionStore.getState().toggleSessionPin(1);

    expect(useSessionStore.getState().pinnedSessionIds).toEqual([]);
  });

  it("keeps several pins side by side", () => {
    useSessionStore.getState().toggleSessionPin(1);
    useSessionStore.getState().toggleSessionPin(2);

    expect(useSessionStore.getState().pinnedSessionIds).toEqual([1, 2]);
  });

  it("drops the pin when the session is removed — ids are reused next launch", () => {
    useSessionStore.setState({ pinnedSessionIds: [1, 2] });

    useSessionStore.getState().removeSession(1);

    expect(useSessionStore.getState().pinnedSessionIds).toEqual([2]);
  });

  it("drops pins of every session in a removed project", async () => {
    useSessionStore.setState({
      sessions: [session(1, "C:/gone"), session(2, "C:/kept")],
      pinnedSessionIds: [1, 2],
    });
    invokeMock.mockResolvedValueOnce([
      { id: 1, mode: "Claude", branch: null, status: "Idle", project_path: "C:/gone" },
    ]);

    await useSessionStore.getState().removeSessionsForProject("C:/gone");

    expect(useSessionStore.getState().pinnedSessionIds).toEqual([2]);
  });
});
