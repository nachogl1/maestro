import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const play = vi.fn();
const dispose = vi.fn();
vi.mock("@/lib/particleEngine", () => ({
  createParticleEngine: vi.fn(() => ({ play, dispose })),
}));

import { emitParticleEffect } from "@/lib/particleEffects";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { ParticleEffectsLayer } from "../ParticleEffectsLayer";

function session(id: number, status: SessionConfig["status"]): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: "C:/proj",
  };
}

describe("ParticleEffectsLayer", () => {
  beforeEach(() => {
    play.mockReset();
    dispose.mockReset();
    useSessionStore.setState({ sessions: [session(1, "Working")], parkedSessionIds: [] });
  });

  it("renders a hidden, click-through canvas", () => {
    render(<ParticleEffectsLayer />);
    const canvas = screen.getByTestId("particle-effects-layer");
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas.className).toContain("pointer-events-none");
    expect(canvas.style.display).toBe("none");
  });

  it("forwards bus effects to the engine", () => {
    render(<ParticleEffectsLayer />);
    emitParticleEffect({ kind: "park", sessionId: 1 });
    expect(play).toHaveBeenCalledWith({ kind: "park", sessionId: 1 });
  });

  it("flares when a session starts waiting for input, once per transition", () => {
    render(<ParticleEffectsLayer />);
    act(() => {
      useSessionStore.setState({ sessions: [session(1, "NeedsInput")] });
    });
    act(() => {
      useSessionStore.setState({ sessions: [session(1, "NeedsInput")] });
    });
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith({ kind: "attention", sessionId: 1 });
  });

  it("stays quiet for parked sessions and brand-new ones", () => {
    render(<ParticleEffectsLayer />);
    act(() => {
      useSessionStore.setState({
        sessions: [session(1, "NeedsInput"), session(2, "NeedsInput")],
        parkedSessionIds: [1],
      });
    });
    expect(play).not.toHaveBeenCalled();
  });

  it("disposes the engine on unmount", () => {
    const { unmount } = render(<ParticleEffectsLayer />);
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
