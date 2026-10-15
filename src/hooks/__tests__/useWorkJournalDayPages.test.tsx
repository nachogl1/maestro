import { invoke } from "@tauri-apps/api/core";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalDayPages, WORK_JOURNAL_DATE_CHECK_MS } from "@/hooks/useWorkJournalDayPages";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";

const invokeMock = vi.mocked(invoke);

function ensureCalls(): unknown[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "work_journal_ensure_pages")
    .map(([, a]) => a);
}

describe("useWorkJournalDayPages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 23, 58, 0));
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ pages: {} });
    useWorkJournalStore.setState({ pages: {}, viewedDate: null, loading: false, error: null });
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.useRealTimers();
  });

  it("creates today's page once on start in the main window", async () => {
    renderHook(() => useWorkJournalDayPages());
    await vi.advanceTimersByTimeAsync(WORK_JOURNAL_DATE_CHECK_MS);
    window.dispatchEvent(new Event("focus"));
    expect(ensureCalls()).toEqual([{ today: "2026-10-15" }]);
  });

  it("shares the start-up call with the pane's call for the same date", async () => {
    renderHook(() => useWorkJournalDayPages());
    await useWorkJournalStore.getState().ensurePages("2026-10-15");
    expect(ensureCalls()).toHaveLength(1);
  });

  it("creates the new day's page at midnight and stops on unmount", async () => {
    const { unmount } = renderHook(() => useWorkJournalDayPages());
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000);
    expect(ensureCalls()).toEqual([{ today: "2026-10-15" }, { today: "2026-10-16" }]);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches a date change missed by the timer on focus", async () => {
    renderHook(() => useWorkJournalDayPages());
    await vi.advanceTimersByTimeAsync(0);
    // The PC slept through midnight: the clock jumps without timers firing.
    vi.setSystemTime(new Date(2026, 9, 16, 8, 0, 0));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(ensureCalls()).toEqual([{ today: "2026-10-15" }, { today: "2026-10-16" }]);
  });

  it("does nothing in the pop-out Work Journal window", async () => {
    window.history.replaceState(null, "", "/?view=work-journal");
    const { unmount } = renderHook(() => useWorkJournalDayPages());
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(ensureCalls()).toEqual([]);
    unmount();
  });
});
