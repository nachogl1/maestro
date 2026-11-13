import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { localDateString, msUntilNextLocalMidnight } from "@/lib/workJournalDates";
import {
  normalizeEntryTime,
  oneLine,
  type WorkJournalEntryDraft,
  type WorkJournalEntryTarget,
} from "@/lib/workJournalEntry";
import { listenWorkJournalChanged } from "@/lib/workJournalWindow";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import {
  appendWorkJournalEntry,
  updateWorkJournalEntry,
  useWorkJournalStore,
  type WorkJournalUpdateResult,
} from "@/stores/useWorkJournalStore";

/**
 * Where a candidate's activity came from (backend `CandidateSource`). `git`
 * (a commit), `pr` and `issue` are the git family; `github` is the older tag
 * for a PR or issue, still found on candidates stored before the split.
 */
export type WorkJournalCandidateSource =
  | "github"
  | "git"
  | "pr"
  | "issue"
  | "claude"
  | "terminal"
  | "granola";

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
  /**
   * The project the work was in (its folder name); absent for a source with
   * no project (a meeting) and for candidates stored before projects were.
   */
  project?: string | null;
  state: WorkJournalCandidateState;
  createdAt: string;
  /**
   * For an update suggestion, the entry card it rewrites as the card read
   * when the suggestion was made (its project is the candidate's); absent
   * for a new entry.
   */
  updates?: WorkJournalCandidateUpdates | null;
}

/** The card an update suggestion rewrites (backend `UpdatedCard`). */
export interface WorkJournalCandidateUpdates {
  time?: string | null;
  text: string;
}

/** Emitted by the backend when a candidate run added candidates. */
export const WORK_JOURNAL_CANDIDATES_EVENT = "work-journal:candidates";

/** Payload of {@link WORK_JOURNAL_CANDIDATES_EVENT}. */
interface CandidatesAddedPayload {
  dates: string[];
  added: number;
}

/** The source tag shown for each source: the git family says what in git it came from. */
export const WORK_JOURNAL_SOURCE_LABELS: Record<WorkJournalCandidateSource, string> = {
  github: "Git · GitHub",
  git: "Git · commit",
  pr: "Git · PR",
  issue: "Git · issue",
  claude: "Claude",
  terminal: "Terminal",
  granola: "Granola",
};

/** Shown when Accept finds no editable page for the candidate's day. */
export const ACCEPT_NO_EDITOR_ERROR =
  "Could not add the line: open this day's page (it must be editable) and try again.";

/** Shown when the page save failed during Accept (the line was taken back out). */
export const ACCEPT_SAVE_FAILED_ERROR = "The line could not be saved; the suggestion stays.";

/** Shown when an update suggestion no longer fits its card (the card was left as it is). */
export const ACCEPT_CARD_CHANGED_ERROR =
  "Your entry changed or is gone since this update was suggested, so it was left as it is. " +
  "Reject the update to clear it.";

/** The error Accept shows for each way adding or rewriting the card can fail. */
const ACCEPT_ERRORS: Record<Exclude<WorkJournalUpdateResult, "saved">, string> = {
  refused: ACCEPT_NO_EDITOR_ERROR,
  save_failed: ACCEPT_SAVE_FAILED_ERROR,
  card_changed: ACCEPT_CARD_CHANGED_ERROR,
};

/**
 * The start of the error line after a bulk Accept or Reject left suggestions
 * behind: how many, and that they stay ticked. The first failure's own error
 * follows it.
 */
export function bulkFailureSummary(count: number, done: "accepted" | "rejected"): string {
  return count === 1
    ? `1 suggestion was not ${done} and stays ticked.`
    : `${count} suggestions were not ${done} and stay ticked.`;
}

/**
 * Slack after local midnight before the badge moves to the new day, so a
 * timer that fires a moment early still sees the new date.
 */
const MIDNIGHT_SLACK_MS = 1_000;

/**
 * How often the local date is compared with the badge's day. Catches what the
 * midnight timer misses: a PC that slept through midnight (timers pause) or a
 * clock or time-zone change.
 */
export const WORK_JOURNAL_BADGE_DATE_CHECK_MS = 60_000;

/**
 * The page line for a candidate: `HH:MM - action`, or the text as given when
 * it has no time (an untimed meeting already reads `Meeting - ...`).
 */
export function candidateLine(candidate: WorkJournalCandidate): string {
  return candidate.time ? `${candidate.time} - ${candidate.text}` : candidate.text;
}

/** The candidate's project name, or null when it has none (a meeting, an older suggestion). */
export function candidateProject(candidate: WorkJournalCandidate): string | null {
  const project = candidate.project;
  return typeof project === "string" && project.trim() !== "" ? project.trim() : null;
}

/** The entry card an accepted candidate becomes: its time, project, source and text. */
export function candidateEntry(candidate: WorkJournalCandidate): WorkJournalEntryDraft {
  return {
    time: candidate.time ?? null,
    project: candidateProject(candidate),
    source: candidate.source,
    text: candidate.text,
  };
}

/** Whether the candidate is an update suggestion: it rewrites a card instead of adding one. */
export function isUpdateCandidate(candidate: WorkJournalCandidate): boolean {
  return candidate.updates != null;
}

/**
 * The card an update suggestion rewrites: its time, the candidate's project
 * and the card's text. Null when the candidate is not an update, or its card
 * or new text cannot be read (no project, a blank text, a time that is not
 * one), so Accept never guesses which card to rewrite.
 */
export function candidateUpdateTarget(
  candidate: WorkJournalCandidate,
): WorkJournalEntryTarget | null {
  const updates = candidate.updates;
  const project = candidateProject(candidate);
  if (!updates || typeof updates !== "object" || !project) return null;
  if (typeof updates.text !== "string" || oneLine(updates.text) === "") return null;
  if (typeof candidate.text !== "string" || oneLine(candidate.text) === "") return null;
  const time =
    updates.time == null
      ? null
      : typeof updates.time === "string"
        ? normalizeEntryTime(updates.time)
        : undefined;
  if (time === undefined) return null;
  return { time, project, text: updates.text };
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
  /** Pending candidates per date over the whole activity file (dates with none left out). */
  pendingCounts: Record<string, number>;
  /** Re-reads `pendingCounts` in one backend call. */
  refreshCounts: () => Promise<void>;
  /** Re-reads the candidates of `date`. */
  refresh: (date: string) => Promise<void>;
  /** Re-reads today's candidates (local date now), for the badge. */
  refreshToday: () => Promise<void>;
  /**
   * Adds the candidate as an entry card at the end of its page through the
   * open editor (an update suggestion rewrites its card's text instead), then
   * removes it from the activity file. Nothing is removed when the card could
   * not be added or rewritten. Resolves whether the candidate is done.
   */
  accept: (candidate: WorkJournalCandidate) => Promise<boolean>;
  /**
   * Marks the candidate rejected: it leaves the box and is not proposed again
   * that day. Resolves whether it is done.
   */
  reject: (candidate: WorkJournalCandidate) => Promise<boolean>;
  /**
   * Accepts the candidates one at a time, in the order given, each through
   * `accept` with its own checks. A failure does not stop the rest; the error
   * line then counts the failures and shows the first one's error. Resolves
   * the ids that were not accepted.
   */
  acceptMany: (candidates: WorkJournalCandidate[]) => Promise<string[]>;
  /** Rejects the candidates one at a time, like `acceptMany`. Resolves the ids not rejected. */
  rejectMany: (candidates: WorkJournalCandidate[]) => Promise<string[]>;
  clearError: () => void;
  /**
   * Starts the app-lifetime refreshers, once (from `useBackgroundPollers`,
   * and in the pop-out window): the candidates event, an accept or reject
   * in the other window, window focus, local midnight (plus a once-a-minute
   * date compare for a PC that slept through it), and a journal
   * restore or undo.
   * Also loads today's candidates. Returns the stop function.
   */
  initListeners: () => Promise<UnlistenFn>;
}

/**
 * Pending suggestions per date for the day list: the loaded lists (kept
 * current by accept and reject here) over the backend's per-date counts.
 */
export function pendingCountsByDate(state: WorkJournalCandidatesState): Record<string, number> {
  const counts = { ...state.pendingCounts };
  for (const [date, list] of Object.entries(state.byDate)) {
    counts[date] = list.filter((c) => c.state === "pending").length;
  }
  return counts;
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

/** The latest counts request; an older reply is dropped. */
let countsSeq = 0;

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
  /**
   * Runs `act` on each candidate in turn; a failure does not stop the rest.
   * Each one starts with no error, so a later success cannot hide an earlier
   * failure: the error line is set once at the end.
   */
  const each = async (
    candidates: WorkJournalCandidate[],
    act: (candidate: WorkJournalCandidate) => Promise<boolean>,
    done: "accepted" | "rejected",
  ): Promise<string[]> => {
    const failed: string[] = [];
    let firstError: string | null = null;
    for (const candidate of candidates) {
      set({ error: null });
      if (await act(candidate)) continue;
      failed.push(candidate.id);
      firstError ??= get().error;
    }
    set({
      error:
        failed.length === 0
          ? null
          : [bulkFailureSummary(failed.length, done), firstError].filter(Boolean).join(" "),
    });
    return failed;
  };

  return {
    byDate: {},
    today: localDateString(new Date()),
    busyIds: [],
    landedIds: [],
    error: null,
    pendingCounts: {},

    refreshCounts: async () => {
      const seq = ++countsSeq;
      try {
        const counts = await invoke<Record<string, number>>("work_journal_pending_counts");
        if (seq !== countsSeq) return;
        set({ pendingCounts: counts && typeof counts === "object" ? counts : {} });
      } catch (error) {
        console.error("Failed to count the Work Journal suggestions:", error);
      }
    },

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
      if (get().busyIds.includes(candidate.id)) return false;
      // A running candidate run read the page before this line; it could
      // propose the same thing again.
      if (useWorkJournalCandidateRunStore.getState().running) return false;
      setBusy(candidate.id, true);
      let added = get().landedIds.includes(candidate.id);
      try {
        if (!added) {
          const result = isUpdateCandidate(candidate)
            ? await updateWorkJournalEntry(
                candidate.date,
                candidateUpdateTarget(candidate),
                candidate.text,
              )
            : await appendWorkJournalEntry(candidate.date, candidateEntry(candidate));
          if (result !== "saved") {
            set({ error: ACCEPT_ERRORS[result] });
            return false;
          }
          added = true;
          set((s) => ({ landedIds: [...s.landedIds, candidate.id] }));
        }
        // Resolves null when the candidate was already gone: done as well.
        await invoke("accept_work_journal_candidate", { id: candidate.id });
        set((s) => ({ landedIds: s.landedIds.filter((id) => id !== candidate.id), error: null }));
        drop(candidate);
        return true;
      } catch (error) {
        console.error("Failed to accept the Work Journal suggestion:", error);
        set({
          error: added
            ? `The line is on the page, but the suggestion stayed (Accept again to clear it): ${errorMessage(error)}`
            : `Could not add the line: ${errorMessage(error)}`,
        });
        return false;
      } finally {
        setBusy(candidate.id, false);
        void get().refresh(candidate.date);
      }
    },

    reject: async (candidate: WorkJournalCandidate) => {
      if (get().busyIds.includes(candidate.id)) return false;
      setBusy(candidate.id, true);
      try {
        await invoke("reject_work_journal_candidate", { id: candidate.id });
        drop(candidate);
        set({ error: null });
        return true;
      } catch (error) {
        console.error("Failed to reject the Work Journal suggestion:", error);
        set({ error: `Could not reject the suggestion: ${errorMessage(error)}` });
        return false;
      } finally {
        setBusy(candidate.id, false);
        void get().refresh(candidate.date);
      }
    },

    acceptMany: (candidates: WorkJournalCandidate[]) =>
      each(candidates, (candidate) => get().accept(candidate), "accepted"),

    rejectMany: (candidates: WorkJournalCandidate[]) =>
      each(candidates, (candidate) => get().reject(candidate), "rejected"),

    clearError: () => set({ error: null }),

    initListeners: async () => {
      const refreshLoaded = (dates: string[]): void => {
        const today = localDateString(new Date());
        const loaded = get().byDate;
        if (today !== get().today) set({ today });
        const wanted = new Set([today, ...dates.filter((d) => loaded[d] !== undefined)]);
        for (const date of wanted) void get().refresh(date);
        void get().refreshCounts();
      };
      const unlisten = await listen<CandidatesAddedPayload>(
        WORK_JOURNAL_CANDIDATES_EVENT,
        (event) => refreshLoaded(event.payload?.dates ?? []),
      );
      // The pane and the pop-out window each keep a copy: re-read it when the
      // other one accepted or rejected (or a run or restore changed them).
      const unlistenChanged = await listenWorkJournalChanged(
        () => refreshLoaded(Object.keys(get().byDate)),
        "candidates",
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
      // Once a minute: the date moved on without a midnight timer, focus or
      // visibility event (the PC slept through midnight with the window open).
      const dateCheck = setInterval(() => {
        if (localDateString(new Date()) !== get().today) void get().refreshToday();
      }, WORK_JOURNAL_BADGE_DATE_CHECK_MS);
      // A restore or undo replaced the journal: re-read every loaded date.
      const unsubscribe = useWorkJournalStore.subscribe((s, prev) => {
        if (s.revision !== prev.revision) refreshLoaded(Object.keys(get().byDate));
      });
      void get().refreshToday();
      void get().refreshCounts();
      return () => {
        unlisten();
        unlistenChanged();
        unsubscribe();
        clearTimeout(midnight);
        clearInterval(dateCheck);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
  };
});
