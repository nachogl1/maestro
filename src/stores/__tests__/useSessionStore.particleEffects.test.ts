import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { subscribeParticleEffects } from "@/lib/particleEffects";
import { type SessionConfig, useSessionStore } from "../useSessionStore";

function session(id: number): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status: "Idle",
    worktree_path: null,
    project_path: "C:/proj",
  };
}

describe("useSessionStore particle effects", () => {
  const seen = vi.fn();
  let unsubscribe: () => void = () => {};

  beforeEach(() => {
    useSessionStore.setState({ sessions: [session(1)], parkedSessionIds: [] });
    seen.mockReset();
    unsubscribe();
    unsubscribe = subscribeParticleEffects(seen);
  });

  it("announces a park once, before the pane leaves the store", () => {
    let parkedAtEmit: number[] | null = null;
    seen.mockImplementation(() => {
      parkedAtEmit = [...useSessionStore.getState().parkedSessionIds];
    });

    useSessionStore.getState().parkSession(1);
    useSessionStore.getState().parkSession(1);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ kind: "park", sessionId: 1 });
    expect(parkedAtEmit).toEqual([]);
  });

  it("announces a resume only for a session that was parked", () => {
    useSessionStore.getState().unparkSession(1);
    expect(seen).not.toHaveBeenCalled();

    useSessionStore.getState().parkSession(1);
    seen.mockClear();
    useSessionStore.getState().unparkSession(1);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ kind: "resume", sessionId: 1 });
  });
});
