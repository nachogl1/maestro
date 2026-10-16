import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkJournalSuggestionsBadge } from "@/components/shared/WorkJournalSuggestionsBadge";
import { WORK_JOURNAL_CHANGED_EVENT } from "@/lib/workJournalWindow";
import {
  candidateLine,
  pendingCountsByDate,
  pendingTodayCount,
  useWorkJournalCandidatesStore,
  WORK_JOURNAL_BADGE_DATE_CHECK_MS,
  WORK_JOURNAL_CANDIDATES_EVENT,
  type WorkJournalCandidate,
} from "@/stores/useWorkJournalCandidatesStore";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const INITIAL = useWorkJournalCandidatesStore.getState();

const TODAY = "2026-10-14";

let candidates: WorkJournalCandidate[];
let emit: ((event: { payload: { dates: string[]; added: number } }) => void) | null;
let emitChanged:
  | ((event: { payload: { source: string | null; replaced: boolean; kind?: string } }) => void)
  | null;
const unlisten = vi.fn();

function candidate(
  id: string,
  date: string,
  state: WorkJournalCandidate["state"] = "pending",
): WorkJournalCandidate {
  return {
    id,
    date,
    time: "09:00",
    text: `line ${id}`,
    source: "git",
    state,
    createdAt: "2026-10-14T09:05:00+01:00",
  };
}

function listCalls(): unknown[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "list_work_journal_candidates")
    .map(([, args]) => args);
}

/** Stop functions of the listeners each test started. */
let stops: Array<() => void> = [];

/** Starts the store's listeners; stopped after the test. */
async function start(): Promise<() => void> {
  let stop: () => void = () => {};
  await act(async () => {
    stop = await useWorkJournalCandidatesStore.getState().initListeners();
  });
  stops.push(stop);
  return stop;
}

/** Lets queued promise callbacks run. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useWorkJournalCandidatesStore and the badge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0, 0));
    candidates = [
      candidate("a", TODAY),
      candidate("b", TODAY),
      candidate("c", TODAY),
      candidate("r", TODAY, "rejected"),
      candidate("y", "2026-10-13"),
    ];
    emit = null;
    emitChanged = null;
    unlisten.mockReset();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_work_journal_candidates") {
        const date = (args as { date: string }).date;
        return structuredClone(candidates.filter((c) => c.date === date));
      }
      if (cmd === "work_journal_pending_counts") {
        const counts: Record<string, number> = {};
        for (const c of candidates) {
          if (c.state === "pending") counts[c.date] = (counts[c.date] ?? 0) + 1;
        }
        return counts;
      }
      return undefined;
    });
    listenMock.mockReset();
    listenMock.mockImplementation(async (event, handler) => {
      if (event === WORK_JOURNAL_CHANGED_EVENT) {
        emitChanged = handler as typeof emitChanged;
        return unlisten;
      }
      expect(event).toBe(WORK_JOURNAL_CANDIDATES_EVENT);
      emit = handler as typeof emit;
      return unlisten;
    });
    useWorkJournalCandidatesStore.setState({ ...INITIAL, byDate: {}, today: TODAY }, true);
  });

  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
    vi.useRealTimers();
  });

  it("formats the page line with and without a time", () => {
    expect(candidateLine(candidate("a", TODAY))).toBe("09:00 - line a");
    expect(candidateLine({ ...candidate("m", TODAY), time: null, text: "Meeting - Sync" })).toBe(
      "Meeting - Sync",
    );
  });

  it("badge shows today's 3 pending, ignoring rejected ones and other days", async () => {
    const stop = await start();
    await settle();
    render(<WorkJournalSuggestionsBadge />);

    expect(listCalls()).toEqual([{ date: TODAY }]);
    expect(pendingTodayCount(useWorkJournalCandidatesStore.getState())).toBe(3);
    expect(
      screen.getByRole("img", { name: "3 Work Journal suggestions for today" }),
    ).toHaveTextContent("3");

    // Yesterday loaded too (say the pane looked at it): still not counted.
    await act(async () => useWorkJournalCandidatesStore.getState().refresh("2026-10-13"));
    expect(screen.getByRole("img")).toHaveTextContent("3");
    stop();
    expect(unlisten).toHaveBeenCalled();
  });

  it("is hidden at zero", async () => {
    candidates = [candidate("r", TODAY, "rejected"), candidate("y", "2026-10-13")];
    await act(async () => useWorkJournalCandidatesStore.getState().refreshToday());
    render(<WorkJournalSuggestionsBadge />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("the candidates event refreshes the list and the badge", async () => {
    candidates = [candidate("a", TODAY)];
    await start();
    await settle();
    render(<WorkJournalSuggestionsBadge />);
    expect(screen.getByRole("img")).toHaveTextContent("1");

    candidates.push(candidate("b", TODAY), candidate("y", "2026-10-13"));
    await act(async () => {
      emit?.({ payload: { dates: [TODAY, "2026-10-13"], added: 2 } });
    });
    await settle();
    expect(screen.getByRole("img")).toHaveTextContent("2");
    expect(useWorkJournalCandidatesStore.getState().byDate[TODAY]).toHaveLength(2);
    // An event date the user never looked at is not fetched.
    expect(listCalls()).not.toContainEqual({ date: "2026-10-13" });
  });

  it("an event for a loaded day refreshes that day too", async () => {
    await start();
    await act(async () => useWorkJournalCandidatesStore.getState().refresh("2026-10-13"));
    candidates.push(candidate("y2", "2026-10-13"));
    await act(async () => {
      emit?.({ payload: { dates: ["2026-10-13"], added: 1 } });
    });
    await settle();
    expect(useWorkJournalCandidatesStore.getState().byDate["2026-10-13"]).toHaveLength(2);
  });

  it("counts the new day after the date changes (window focus)", async () => {
    await start();
    await settle();
    expect(pendingTodayCount(useWorkJournalCandidatesStore.getState())).toBe(3);

    vi.setSystemTime(new Date(2026, 9, 15, 0, 5, 0));
    candidates.push(candidate("n", "2026-10-15"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(useWorkJournalCandidatesStore.getState().today).toBe("2026-10-15");
    expect(pendingTodayCount(useWorkJournalCandidatesStore.getState())).toBe(1);
  });

  it("an accept or reject in the other window re-reads the loaded dates", async () => {
    await start();
    await act(async () => useWorkJournalCandidatesStore.getState().refresh("2026-10-13"));
    expect(useWorkJournalCandidatesStore.getState().byDate[TODAY]).toHaveLength(4);
    candidates = candidates.filter((c) => c.id !== "a" && c.id !== "y");
    await act(async () => {
      emitChanged?.({ payload: { source: "work-journal", replaced: false } });
    });
    await settle();
    expect(useWorkJournalCandidatesStore.getState().byDate[TODAY]).toHaveLength(3);
    expect(useWorkJournalCandidatesStore.getState().byDate["2026-10-13"]).toHaveLength(0);
    expect(pendingTodayCount(useWorkJournalCandidatesStore.getState())).toBe(2);
  });

  it("re-reads only for changes that can touch the suggestions", async () => {
    await start();
    await settle();
    const reads = (): number => listCalls().length;
    const before = reads();
    // A page save or a settings change in the other window: nothing to re-read.
    for (const kind of ["page", "settings"]) {
      await act(async () => {
        emitChanged?.({ payload: { source: "work-journal", replaced: false, kind } });
      });
      await settle();
    }
    expect(reads()).toBe(before);
    // Suggestions, a run, a restore, and an older payload without a kind do.
    const payloads = [
      { source: "work-journal", replaced: false, kind: "candidates" },
      { source: null, replaced: false, kind: "run" },
      { source: "work-journal", replaced: true, kind: "replaced" },
      { source: "work-journal", replaced: false },
    ];
    for (const [i, payload] of payloads.entries()) {
      await act(async () => emitChanged?.({ payload }));
      await settle();
      expect(reads()).toBe(before + i + 1);
    }
  });

  it("counts every day's pending suggestions in one call, kept current by changes", async () => {
    await start();
    await settle();
    // Yesterday was never opened, yet the day list can show its count.
    expect(pendingCountsByDate(useWorkJournalCandidatesStore.getState())).toEqual({
      [TODAY]: 3,
      "2026-10-13": 1,
    });
    expect(listCalls()).toEqual([{ date: TODAY }]);

    // A catch-up run adds two to a day before yesterday.
    candidates.push(candidate("p1", "2026-10-12"), candidate("p2", "2026-10-12"));
    await act(async () => {
      emitChanged?.({ payload: { source: null, replaced: false } });
    });
    await settle();
    expect(pendingCountsByDate(useWorkJournalCandidatesStore.getState())["2026-10-12"]).toBe(2);
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "work_journal_pending_counts"),
    ).toHaveLength(2);
  });

  it("a restore or undo re-reads the loaded dates", async () => {
    await start();
    await settle();
    const before = listCalls().length;
    act(() => useWorkJournalStore.setState((s) => ({ revision: s.revision + 1 })));
    await settle();
    expect(listCalls().length).toBe(before + 1);
  });

  it("a slower, older reply never puts back a candidate removed meanwhile", async () => {
    let release: (value: WorkJournalCandidate[]) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_work_journal_candidates") {
        return new Promise<WorkJournalCandidate[]>((resolve) => {
          release = resolve;
        });
      }
      if (cmd === "reject_work_journal_candidate") return candidate("a", TODAY, "rejected");
      return undefined;
    });
    useWorkJournalCandidatesStore.setState({ byDate: { [TODAY]: [candidate("a", TODAY)] } });
    const slow = useWorkJournalCandidatesStore.getState().refresh(TODAY);
    const staleRelease = release;
    await act(async () => useWorkJournalCandidatesStore.getState().reject(candidate("a", TODAY)));
    // The reply of the read started before the reject still lists it pending.
    await act(async () => {
      staleRelease([candidate("a", TODAY)]);
      await slow;
    });
    expect(useWorkJournalCandidatesStore.getState().byDate[TODAY]).toEqual([]);
  });
  it("moves the badge to the new day at local midnight with no pane open, every day", async () => {
    vi.setSystemTime(new Date(2026, 9, 14, 23, 59, 50));
    candidates.push(candidate("n1", "2026-10-15"), candidate("n2", "2026-10-15"));
    candidates.push(candidate("m1", "2026-10-16"));
    const stop = await start();
    await settle();
    expect(pendingTodayCount(useWorkJournalCandidatesStore.getState())).toBe(3);

    await act(async () => vi.advanceTimersByTime(11_000));
    await settle();
    expect(useWorkJournalCandidatesStore.getState().today).toBe("2026-10-15");
    expect(pendingTodayCount(useWorkJournalCandidatesStore.getState())).toBe(2);

    // Re-armed for the next midnight.
    await act(async () => vi.advanceTimersByTime(24 * 60 * 60 * 1000));
    await settle();
    expect(useWorkJournalCandidatesStore.getState().today).toBe("2026-10-16");
    expect(pendingTodayCount(useWorkJournalCandidatesStore.getState())).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves the badge to the new day within a minute after sleeping through midnight", async () => {
    candidates.push(candidate("n1", "2026-10-15"), candidate("n2", "2026-10-15"));
    await start();
    await settle();
    expect(pendingTodayCount(useWorkJournalCandidatesStore.getState())).toBe(3);

    // The PC slept through midnight: the clock jumps, no timer fired, no focus event.
    vi.setSystemTime(new Date(2026, 9, 15, 8, 0, 0));
    await act(async () => vi.advanceTimersByTime(WORK_JOURNAL_BADGE_DATE_CHECK_MS));
    await settle();
    expect(listCalls().filter((a) => (a as { date: string }).date === "2026-10-15")).toHaveLength(
      1,
    );
    expect(useWorkJournalCandidatesStore.getState().today).toBe("2026-10-15");
    expect(pendingTodayCount(useWorkJournalCandidatesStore.getState())).toBe(2);

    // Later checks see the same date: no further reads.
    await act(async () => vi.advanceTimersByTime(3 * WORK_JOURNAL_BADGE_DATE_CHECK_MS));
    await settle();
    expect(listCalls().filter((a) => (a as { date: string }).date === "2026-10-15")).toHaveLength(
      1,
    );
  });

  it("does not re-read today on the minute check while the date is unchanged", async () => {
    await start();
    await settle();
    invokeMock.mockClear();

    await act(async () => vi.advanceTimersByTime(5 * WORK_JOURNAL_BADGE_DATE_CHECK_MS));
    await settle();
    expect(listCalls()).toEqual([]);
  });

  it("stops the minute date check when the listeners stop", async () => {
    const stop = await start();
    await settle();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    invokeMock.mockClear();

    vi.setSystemTime(new Date(2026, 9, 15, 8, 0, 0));
    await act(async () => vi.advanceTimersByTime(2 * WORK_JOURNAL_BADGE_DATE_CHECK_MS));
    await settle();
    expect(listCalls()).toEqual([]);
    expect(useWorkJournalCandidatesStore.getState().today).toBe(TODAY);
  });
});
