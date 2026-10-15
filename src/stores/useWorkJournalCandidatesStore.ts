import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { localDateString, msUntilNextLocalMidnight } from "@/lib/workJournalDates";
import { listenWorkJournalChanged } from "@/lib/workJournalWindow";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import { appendWorkJournalLine, useWorkJournalStore } from "@/stores/useWorkJournalStore";

/** Where a candidate's activity came from (backend `CandidateSource`). */
export type WorkJournalCandidateSource = "github" | "git" | "claude" | "terminal" | "granola";

/** Pending (waiting for the user) or rejected (backend `CandidateState`). */
export type WorkJournalCandidateState = "pending" | "rejected";

/** One proposed journal line, as `list_work_journal_candidates` returns it. */
export interface WorkJournalCandidate {
  id: string;
  /** The day page it belongs to, `YYYY-MM-DD`. */
  date: string;
  /** When the activity happened, `HH:MM`; absent for an untimed meeting. */
  time?: string | null;
  text: string;
  source: WorkJournalCandidateSource;
  state: WorkJournalCandidateState;
  createdAt: string;
}

/** Emitted by the backend when a candidate run added candidates. */
export const WORK_JOURNAL_CANDIDATES_EVENT = "work-journal:candidates";

/** Payload of {@link WORK_JOURNAL_CANDIDATES_EVENT}. */
interface CandidatesAddedPayload {
  dates: string[];
  added: number;
}

/** The source tag shown for each source. */
export const WORK_JOURNAL_SOURCE_LABELS: Record<WorkJournalCandidateSource, string> = {
  github: "GitHub",
  git: "Git",
  claude: "Claude",
  terminal: "Terminal",
  granola: "Granola",
};

/** Shown when Accept finds no editable page for the candidate's day. */
export const ACCEPT_NO_EDITOR_ERROR =
  "Could not add the line: open this day's page (it must be editable) and try again.";

/** Shown when the page save failed during Accept (the line was taken back out). */
export const ACCEPT_SAVE_FAILED_ERROR = "The line could not be saved; the suggestion stays.";

/**
 * Slack after local midnight before the badge moves to the new day, so a
 * timer that fires a moment early still sees the new date.
 */
const MIDNIGHT_SLACK_MS = 1_000;

/**
 * The page line for a candidate: `HH:MM - action`, or the text as given when
 * it has no time (an untimed meeting already reads `Meeting - ...`).
 */
export function candidateLine(candidate: WorkJournalCandidate): string {
  return candidate.time ? `${candidate.time} - ${candidate.text}` : candidate.text;
}

interface WorkJournalCandidatesState {
  /** Candidates (pending and rejected) per loaded date. */
  byDate: Record<string, WorkJournalCandidate[]>;
  /** The local date the badge counts for, set on every today refresh. */
  today: string;
  /** Ids with an accept or reject in flight (their buttons are disabled). */
  busyIds: string[];
  /**
   * Ids whose line is already saved on the page while their removal from
   * the activity file failed: Accept then only retries the removal, so the
   * line is never added twice.
   */
  landedIds: string[];
  /** The last accept or reject failure; cleared by the next success. */
  error: string | null;
  /** Re-reads the candidates of `date`. */
  refresh: (date: string) => Promise<void>;
  /** Re-reads today's candidates (local date now), for the badge. */
  refreshToday: () => Promise<void>;
  /**
   * Adds the candidate's line to its page through the open editor, then
   * removes it from the activity file. Nothing is removed when the line
   * could not be added.
   */
  accept: (candidate: WorkJournalCandidate) => Promise<void>;
  /** Marks the candidate rejected: it leaves the box and is not proposed again that day. */
  reject: (candidate: WorkJournalCandidate) => Promise<void>;
  clearError: () => void;
  /**
   * Starts the app-lifetime refreshers, once (from `useBackgroundPollers`,
   * and in the pop-out window): the candidates event, an accept or reject
   * in the other window, window focus, local midnight, and a journal
   * restore or undo.
   * Also loads today's candidates. Returns the stop function.
   */
  initListeners: () => Promise<UnlistenFn>;
}

/** Today's pending candidates: the Work Journal button's badge count. */
export function pendingTodayCount(state: WorkJournalCandidatesState): number {
  return (state.byDate[state.today] ?? []).filter((c) => c.state === "pending").length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The latest request per date. A reply from an older request is dropped, so
 * a slow read can never put back a candidate that was accepted meanwhile.
 */
const requestSeq = new Map<string, number>();

function nextSeq(date: string): number {
  const seq = (requestSeq.get(date) ?? 0) + 1;
  requestSeq.set(date, seq);
  return seq;
}

/**
 * Work Journal candidates for the suggestions box and the top-bar badge.
 * The activity file is the source of truth; this is a per-date read cache.
 */
export const useWorkJournalCandidatesStore = create<WorkJournalCandidatesState>((set, get) => {
  const drop = (candidate: WorkJournalCandidate): void => {
    nextSeq(candidate.date);
    set((s) => ({
      byDate: {
        ...s.byDate,
        [candidate.date]: (s.byDate[candidate.date] ?? []).filter((c) => c.id !== candidate.id),
      },
    }));
  };
  const setBusy = (id: string, busy: boolean): void =>
    set((s) => ({
      busyIds: busy ? [...s.busyIds, id] : s.busyIds.filter((other) => other !== id),
    }));

  return {
    byDate: {},
    today: localDateString(new Date()),
    busyIds: [],
    landedIds: [],
    error: null,

    refresh: async (date: string) => {
      const seq = nextSeq(date);
      try {
        const listed = await invoke<WorkJournalCandidate[]>("list_work_journal_candidates", {
          date,
        });
        if (requestSeq.get(date) !== seq) return;
        set((s) => ({
          byDate: { ...s.byDate, [date]: Array.isArray(listed) ? listed : [] },
        }));
      } catch (error) {
        console.error("Failed to load the Work Journal suggestions:", error);
      }
    },

    refreshToday: async () => {
      const today = localDateString(new Date());
      if (today !== get().today) set({ today });
      await get().refresh(today);
    },

    accept: async (candidate: WorkJournalCandidate) => {
      if (get().busyIds.includes(candidate.id)) return;
      // A running candidate run read the page before this line; it could
      // propose the same thing again.
      if (useWorkJournalCandidateRunStore.getState().running) return;
      setBusy(candidate.id, true);
      let added = get().landedIds.includes(candidate.id);
      try {
        if (!added) {
          const result = await appendWorkJournalLine(candidate.date, candidateLine(candidate));
          if (result !== "saved") {
            set({
              error: result === "save_failed" ? ACCEPT_SAVE_FAILED_ERROR : ACCEPT_NO_EDITOR_ERROR,
            });
            return;
          }
          added = true;
          set((s) => ({ landedIds: [...s.landedIds, candidate.id] }));
        }
        // Resolves null when the candidate was already gone: done as well.
        await invoke("accept_work_journal_candidate", { id: candidate.id });
        set((s) => ({ landedIds: s.landedIds.filter((id) => id !== candidate.id), error: null }));
        drop(candidate);
      } catch (error) {
        console.error("Failed to accept the Work Journal suggestion:", error);
        set({
          error: added
            ? `The line is on the page, but the suggestion stayed (Accept again to clear it): ${errorMessage(error)}`
            : `Could not add the line: ${errorMessage(error)}`,
        });
      } finally {
        setBusy(candidate.id, false);
        void get().refresh(candidate.date);
      }
    },

    reject: async (candidate: WorkJournalCandidate) => {
      if (get().busyIds.includes(candidate.id)) return;
      setBusy(candidate.id, true);
      try {
        await invoke("reject_work_journal_candidate", { id: candidate.id });
        drop(candidate);
        set({ error: null });
      } catch (error) {
        console.error("Failed to reject the Work Journal suggestion:", error);
        set({ error: `Could not reject the suggestion: ${errorMessage(error)}` });
      } finally {
        setBusy(candidate.id, false);
        void get().refresh(candidate.date);
      }
    },

    clearError: () => set({ error: null }),

    initListeners: async () => {
      const refreshLoaded = (dates: string[]): void => {
        const today = localDateString(new Date());
        const loaded = get().byDate;
        if (today !== get().today) set({ today });
        const wanted = new Set([today, ...dates.filter((d) => loaded[d] !== undefined)]);
        for (const date of wanted) void get().refresh(date);
      };
      const unlisten = await listen<CandidatesAddedPayload>(
        WORK_JOURNAL_CANDIDATES_EVENT,
        (event) => refreshLoaded(event.payload?.dates ?? []),
      );
      // The pane and the pop-out window each keep a copy: re-read it when the
      // other one accepted or rejected (or anything else changed).
      const unlistenChanged = await listenWorkJournalChanged(() =>
        refreshLoaded(Object.keys(get().byDate)),
      );
      // Back to the window: the date may have changed while it was away.
      const onFocus = (): void => void get().refreshToday();
      const onVisibility = (): void => {
        if (document.visibilityState === "visible") onFocus();
      };
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisibility);
      // Midnight: the badge moves to the new day even with the pane closed.
      let midnight: ReturnType<typeof setTimeout>;
      const armMidnight = (): void => {
        midnight = setTimeout(() => {
          void get().refreshToday();
          armMidnight();
        }, msUntilNextLocalMidnight(new Date()) + MIDNIGHT_SLACK_MS);
      };
      armMidnight();
      // A restore or undo replaced the journal: re-read every loaded date.
      const unsubscribe = useWorkJournalStore.subscribe((s, prev) => {
        if (s.revision !== prev.revision) refreshLoaded(Object.keys(get().byDate));
      });
      void get().refreshToday();
      return () => {
        unlisten();
        unlistenChanged();
        unsubscribe();
        clearTimeout(midnight);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
  };
});
