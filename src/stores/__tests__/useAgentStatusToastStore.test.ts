import { describe, expect, it } from "vitest";
import { DONE_MIN_DURATION_MS, reduceTransition, sessionLabel } from "../useAgentStatusToastStore";

describe("sessionLabel", () => {
  it("uses the session name when present", () => {
    expect(sessionLabel({ id: 7, name: "build-agent" })).toBe("build-agent");
  });

  it("falls back to #id when name is null/empty/whitespace", () => {
    expect(sessionLabel({ id: 4, name: null })).toBe("#4");
    expect(sessionLabel({ id: 4, name: "" })).toBe("#4");
    expect(sessionLabel({ id: 4, name: "   " })).toBe("#4");
  });
});

describe("reduceTransition", () => {
  const baseLabel = "agent-a";

  it("starts an episode when entering Working from a non-thinking state", () => {
    const action = reduceTransition({
      prev: "Idle",
      next: "Working",
      label: baseLabel,
      now: 1_000,
      episode: null,
    });
    expect(action).toEqual({
      kind: "start-episode",
      startedAt: 1_000,
      label: baseLabel,
    });
  });

  it("starts an episode when the session first appears as Working (no prev)", () => {
    const action = reduceTransition({
      prev: undefined,
      next: "Working",
      label: baseLabel,
      now: 1_000,
      episode: null,
    });
    expect(action.kind).toBe("start-episode");
  });

  it("does not re-start an episode if one is already tracked", () => {
    const action = reduceTransition({
      prev: "Idle",
      next: "Working",
      label: baseLabel,
      now: 1_000,
      episode: {
        startedAt: 500,
        longRunFired: false,
        longRunTimer: null,
        capturedLabel: baseLabel,
      },
    });
    expect(action.kind).toBe("none");
  });

  it("ends the episode and fires done-toast for sufficiently long thinking", () => {
    const startedAt = 0;
    const now = startedAt + DONE_MIN_DURATION_MS + 1;
    const action = reduceTransition({
      prev: "Working",
      next: "Idle",
      label: "renamed",
      now,
      episode: {
        startedAt,
        longRunFired: false,
        longRunTimer: null,
        capturedLabel: "original",
      },
    });
    expect(action).toMatchObject({
      kind: "end-episode",
      fireDoneToast: true,
      // Captured label survives rename — toast keeps the original.
      label: "original",
    });
  });

  it("ends the episode but suppresses done-toast for very short thinking", () => {
    const action = reduceTransition({
      prev: "Working",
      next: "Idle",
      label: baseLabel,
      now: 100, // started at 0, only 100 ms — way below the 5 s threshold
      episode: {
        startedAt: 0,
        longRunFired: false,
        longRunTimer: null,
        capturedLabel: baseLabel,
      },
    });
    expect(action).toMatchObject({ kind: "end-episode", fireDoneToast: false });
  });

  it("ends episode without done-toast when transitioning Working -> Error", () => {
    const action = reduceTransition({
      prev: "Working",
      next: "Error",
      label: baseLabel,
      now: DONE_MIN_DURATION_MS * 10,
      episode: {
        startedAt: 0,
        longRunFired: false,
        longRunTimer: null,
        capturedLabel: baseLabel,
      },
    });
    expect(action).toMatchObject({ kind: "end-episode", fireDoneToast: false });
  });

  it("returns none for an unrelated transition (Idle -> NeedsInput)", () => {
    const action = reduceTransition({
      prev: "Idle",
      next: "NeedsInput",
      label: baseLabel,
      now: 0,
      episode: null,
    });
    expect(action.kind).toBe("none");
  });

  it("treats NeedsInput and Done the same as Idle for end-of-episode purposes", () => {
    for (const next of ["NeedsInput", "Done"] as const) {
      const action = reduceTransition({
        prev: "Working",
        next,
        label: baseLabel,
        now: DONE_MIN_DURATION_MS + 1,
        episode: {
          startedAt: 0,
          longRunFired: false,
          longRunTimer: null,
          capturedLabel: baseLabel,
        },
      });
      expect(action).toMatchObject({ kind: "end-episode", fireDoneToast: true });
    }
  });
});
