import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  sessions: [] as { id: number; status: string; lastMcpUpdateTime?: number }[],
  updateSession: vi.fn(),
}));

vi.mock("@/stores/useSessionStore", () => ({
  useSessionStore: { getState: () => store },
}));

import { createActivityStatusTracker } from "../activityStatusTracker";

describe("createActivityStatusTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.sessions = [{ id: 1, status: "Idle" }];
    store.updateSession = vi.fn((id: number, patch: { status: string }) => {
      const s = store.sessions.find((x) => x.id === id);
      if (s) s.status = patch.status;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks Working after sustained output, then Idle after silence", () => {
    const tracker = createActivityStatusTracker(1, () => false);
    tracker.onOutput();
    vi.advanceTimersByTime(500);
    expect(store.updateSession).toHaveBeenLastCalledWith(1, { status: "Working" });

    vi.advanceTimersByTime(5_000);
    expect(store.updateSession).toHaveBeenLastCalledWith(1, { status: "Idle" });
  });

  it("never overrides a NeedsInput status", () => {
    store.sessions = [{ id: 1, status: "NeedsInput" }];
    const tracker = createActivityStatusTracker(1, () => false);
    tracker.onOutput();
    vi.advanceTimersByTime(6_000);
    expect(store.updateSession).not.toHaveBeenCalled();
  });

  it("defers to a recent MCP status update", () => {
    store.sessions = [{ id: 1, status: "Idle", lastMcpUpdateTime: Date.now() }];
    const tracker = createActivityStatusTracker(1, () => false);
    tracker.onOutput();
    vi.advanceTimersByTime(6_000);
    expect(store.updateSession).not.toHaveBeenCalled();
  });

  it("dispose cancels pending status changes", () => {
    const tracker = createActivityStatusTracker(1, () => false);
    tracker.onOutput();
    tracker.dispose();
    vi.advanceTimersByTime(6_000);
    expect(store.updateSession).not.toHaveBeenCalled();
  });

  it("markWorking lets silence fall back to Idle without a Working debounce", () => {
    store.sessions = [{ id: 1, status: "Working" }];
    const tracker = createActivityStatusTracker(1, () => false);
    tracker.markWorking();
    tracker.onOutput();
    vi.advanceTimersByTime(5_000);
    expect(store.updateSession).toHaveBeenCalledTimes(1);
    expect(store.updateSession).toHaveBeenCalledWith(1, { status: "Idle" });
  });
});
