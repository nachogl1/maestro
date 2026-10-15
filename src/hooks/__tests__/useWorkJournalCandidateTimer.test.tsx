import { invoke } from "@tauri-apps/api/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useWorkJournalCandidateTimer,
  WORK_JOURNAL_CATCH_UP_DELAY_MS,
} from "@/hooks/useWorkJournalCandidateTimer";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";

const invokeMock = vi.mocked(invoke);
const HOUR_MS = 60 * 60 * 1000;
const RUN_INITIAL = useWorkJournalCandidateRunStore.getState();

type Tabs = Parameters<typeof useWorkJournalCandidateTimer>[0];

const TABS: Tabs = [
  { name: "a", projectPath: "C:\\git\\a", selectedRepoPath: null },
  { name: "b", projectPath: "C:\\git\\b", selectedRepoPath: null },
];

function runCalls(): unknown[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "work_journal_run_candidates")
    .map(([, args]) => args);
}

describe("useWorkJournalCandidateTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    useWorkJournalCandidateRunStore.setState(RUN_INITIAL, true);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "load_work_journal") return { settings: { run_every_hours: 2 } };
      if (cmd === "work_journal_run_candidates") {
        return { status: "ran", added: 0, dates: [], lastRunAt: "2026-10-15T12:00:00Z" };
      }
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the settings, runs once shortly after start, then at the configured interval", async () => {
    const { unmount } = renderHook(() => useWorkJournalCandidateTimer(TABS));
    // Let the settings load land (run every 2 hours).
    await act(async () => {});
    expect(invokeMock).toHaveBeenCalledWith("load_work_journal");
    expect(useWorkJournalCandidateRunStore.getState().runEveryHours).toBe(2);
    expect(runCalls()).toHaveLength(0);

    await act(async () => vi.advanceTimersByTime(WORK_JOURNAL_CATCH_UP_DELAY_MS));
    expect(runCalls()).toEqual([{ projects: ["C:\\git\\a", "C:\\git\\b"] }]);

    await act(async () => vi.advanceTimersByTime(HOUR_MS));
    expect(runCalls()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(HOUR_MS - WORK_JOURNAL_CATCH_UP_DELAY_MS));
    expect(runCalls()).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(2 * HOUR_MS));
    expect(runCalls()).toHaveLength(3);

    unmount();
    await act(async () => vi.advanceTimersByTime(10 * HOUR_MS));
    expect(runCalls()).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the interval when the setting changes, without another catch-up run", async () => {
    renderHook(() => useWorkJournalCandidateTimer(TABS));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTime(WORK_JOURNAL_CATCH_UP_DELAY_MS));
    expect(runCalls()).toHaveLength(1);

    act(() => useWorkJournalCandidateRunStore.setState({ runEveryHours: 5 }));
    await act(async () => vi.advanceTimersByTime(5 * HOUR_MS - 1));
    expect(runCalls()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(runCalls()).toHaveLength(2);
  });

  it("uses the tabs open at the time of each run", async () => {
    const { rerender } = renderHook(({ tabs }) => useWorkJournalCandidateTimer(tabs), {
      initialProps: { tabs: TABS },
    });
    await act(async () => {});
    rerender({ tabs: [{ name: "c", projectPath: "/home/me/c", selectedRepoPath: null }] });

    await act(async () => vi.advanceTimersByTime(WORK_JOURNAL_CATCH_UP_DELAY_MS));
    expect(runCalls()).toEqual([{ projects: ["/home/me/c"] }]);
  });
});
