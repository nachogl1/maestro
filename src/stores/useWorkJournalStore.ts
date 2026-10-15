import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/react";
import { create } from "zustand";
import {
  daysBetween,
  defaultWorkJournalTitle,
  isWeekend,
  localDateString,
} from "@/lib/workJournalDates";

/** How a page came to exist (backend `PageOrigin`). */
export type WorkJournalPageOrigin = "auto" | "manual";

/** One day's page, as the backend stores it in `work-journal.json`. */
export interface WorkJournalPage {
  /** Local calendar date `YYYY-MM-DD`, the page's unique key. */
  date: string;
  title: string;
  /** TipTap editor JSON (`editor.getJSON()`), stored as-is. */
  body: JSONContent;
  origin: WorkJournalPageOrigin;
}

/** The whole journal as every backend command returns it. */
export interface WorkJournalFile {
  layout_version: number;
  pages: Record<string, WorkJournalPage>;
  deleted_dates: string[];
  last_auto_created_date: string | null;
  settings: Record<string, unknown>;
}

/** Fields of a page the user can change. */
export interface WorkJournalPagePatch {
  title?: string;
  body?: JSONContent;
}

interface WorkJournalState {
  /** Pages keyed by date. */
  pages: Record<string, WorkJournalPage>;
  /** The date the pane shows; it may have no page (an empty day). */
  viewedDate: string | null;
  loading: boolean;
  error: string | null;
  /**
   * Bumped when the whole journal is replaced (restore or undo). The pane puts
   * it in each editor's React key, so open editors remount with the new body,
   * and an editor from an older revision never saves.
   */
  revision: number;
  /**
   * True while a restore or undo is replacing the journal: page saves are
   * dropped and editors are read-only, so nothing typed meanwhile can land
   * over the new journal.
   */
  replacing: boolean;
  /**
   * Sorted dates with text whose last save failed. Only a later save that
   * lands (or the page going away) clears a date; it is retried meanwhile.
   */
  unsavedDates: string[];
  /**
   * Sorted dates among `unsavedDates` whose field the other window changed
   * since the failed save: never retried on its own, only overwritten or
   * discarded by the user.
   */
  conflictDates: string[];
  /** Reads the journal file. */
  load: () => Promise<void>;
  /**
   * Re-reads the journal after another window (or the backend) changed it;
   * `replaced` when that was a restore or undo. No loading state, so the
   * page stays on screen.
   */
  sync: (replaced: boolean) => Promise<void>;
  /**
   * Auto-creates missing day pages up to `today` (local `YYYY-MM-DD`). A call
   * for a date that is still in flight shares it, so the pane and the start-up
   * hook do not both run it.
   */
  ensurePages: (today: string) => Promise<void>;
  selectDate: (date: string) => void;
  /** Moves to the nearest existing page before the viewed date. */
  goPrev: () => void;
  /** Moves to the nearest existing page after the viewed date. */
  goNext: () => void;
  /** Creates a manual page for `date` with the default title and shows it. */
  createPage: (date: string) => Promise<void>;
  /**
   * Saves a title and/or body change; ignored for a date with no page.
   * Resolves true once the backend saved it, false when skipped or failed.
   */
  updatePage: (date: string, patch: WorkJournalPagePatch) => Promise<boolean>;
  /** Deletes the page for `date` and shows the nearest remaining page. */
  deletePage: (date: string) => Promise<void>;
  clearError: () => void;
  /**
   * Starts a restore or undo: sends every open editor's unsaved text, sets
   * `replacing` (so every later save is dropped), then waits until all
   * queued saves have landed.
   */
  beginReplace: () => Promise<void>;
  /**
   * Ends a restore or undo that failed: clears `replacing` (the journal is
   * unchanged) and sends text whose save the restore refused.
   */
  endReplace: () => void;
  /**
   * Shows a journal that replaced the whole file (restore or undo); bumps
   * `revision` and clears `replacing`.
   */
  replaceJournal: (journal: WorkJournalFile) => void;
}

/** A journal with no pages. */
const EMPTY_JOURNAL: WorkJournalFile = {
  layout_version: 1,
  pages: {},
  deleted_dates: [],
  last_auto_created_date: null,
  settings: {},
};

/** A new weekday page's body: what an empty TipTap editor returns. */
export const EMPTY_PAGE_BODY: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/** A new weekend page's body, matching the backend's auto-created weekend page. */
export const WEEKEND_PAGE_BODY: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Weekend" }] }],
};

/**
 * Updates sent but not yet confirmed, per date. While a date has one, a whole
 * journal coming back from another command (ensure, create, delete) keeps the
 * local copy of that page, so a reply that raced the save cannot put an older
 * body back into the store.
 */
const pendingUpdates = new Map<string, number>();

/**
 * Fields (`<date>:body`, `<date>:title`) whose last save failed. Their text
 * lives only here until a later save of that field lands, so a journal read
 * back from disk keeps the local copy of that page.
 */
const failedSaves = new Set<string>();

/** The page fields (`body`, `title`) of `date` whose last save failed. */
function failedFields(date: string): Set<string> {
  const fields = new Set<string>();
  for (const key of failedSaves) {
    if (key.startsWith(`${date}:`)) {
      for (const field of key.slice(date.length + 1).split(",")) fields.add(field);
    }
  }
  return fields;
}

/** Forgets the failed saves of `date`: its page is gone, so their text is too. */
function clearFailedSaves(date: string): void {
  for (const key of [...failedSaves]) if (key.startsWith(`${date}:`)) forgetFailedSave(key);
}

/** Drops one failed field and what is known about its conflict. */
function forgetFailedSave(key: string): void {
  failedSaves.delete(key);
  failedBases.delete(key);
  conflictSaves.delete(key);
}

/** The pages as last read from the backend, to tell whether a field changed on disk. */
let diskPages: Record<string, WorkJournalPage> = {};

/**
 * Per failed field, the disk text it was based on (see `fieldsJson`). When
 * the disk text moves away from it, the other window saved that field since.
 */
const failedBases = new Map<string, string>();

/**
 * Failed fields the other window changed since: an automatic retry would
 * overwrite newer text, so only the user's choice sends or drops them.
 */
const conflictSaves = new Set<string>();

/** JSON with sorted object keys, so the same text compares equal however it was built. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function keyDate(key: string): string {
  return key.slice(0, key.indexOf(":"));
}

/** The fields (`body`, `title`) a failed-save key covers. */
function keyFields(key: string): Array<keyof WorkJournalPagePatch> {
  return key.slice(keyDate(key).length + 1).split(",") as Array<keyof WorkJournalPagePatch>;
}

/** The fields of a failed-save key's page, as comparable JSON. */
function fieldsJson(key: string, page: WorkJournalPage | undefined): string {
  const fields: Record<string, unknown> = {};
  for (const field of keyFields(key)) fields[field] = page?.[field] ?? null;
  return stableJson(fields);
}

/**
 * Takes in a journal read from the backend before it is merged: failed saves
 * of a page that is gone are dropped, and a failed field the other window
 * changed since becomes a conflict. `tick` is `saveTick` when the read
 * started: a date saved here since then may be older in the reply than on
 * disk, so it keeps what the save put there and is not checked.
 */
function absorbDiskPages(incoming: Record<string, WorkJournalPage>, tick: number): void {
  const savedSince = (date: string): boolean => (lastLocalSave.get(date) ?? 0) > tick;
  for (const key of [...failedSaves]) {
    const date = keyDate(key);
    if (savedSince(date)) continue;
    const page = incoming[date];
    if (!page) {
      forgetFailedSave(key);
      continue;
    }
    // A failure whose disk text was never read here cannot be checked, so
    // it is not retried on its own.
    const base = failedBases.get(key);
    if (base === undefined || base !== fieldsJson(key, page)) conflictSaves.add(key);
  }
  const next = { ...incoming };
  for (const date of Object.keys(diskPages)) {
    if (!savedSince(date)) continue;
    next[date] = diskPages[date];
  }
  diskPages = next;
  publishFailedSaves();
}

/** The sorted dates of some failed-save keys. */
function failedDates(keys: Iterable<string>): string[] {
  return [...new Set([...keys].map(keyDate))].sort();
}

/** Whether a failed field may be retried without asking (not a conflict). */
function hasRetryableSaves(): boolean {
  for (const key of failedSaves) if (!conflictSaves.has(key)) return true;
  return false;
}

/**
 * Waits before each automatic retry of failed saves: 5 s, then every 30 s
 * until they land.
 */
export const WORK_JOURNAL_SAVE_RETRY_DELAYS_MS = [5_000, 30_000];

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

/**
 * Arms the next automatic retry, unless one is already waiting. The retry
 * re-reads the file first (`sync`), so it hears what the other window saved
 * even with the pane closed, and only re-sends fields nobody changed since.
 */
function scheduleRetry(): void {
  if (retryTimer || !hasRetryableSaves()) return;
  const delays = WORK_JOURNAL_SAVE_RETRY_DELAYS_MS;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      retryAttempt += 1;
      // Rearmed when the read failed or a retry was skipped (say during a restore).
      void useWorkJournalStore
        .getState()
        .sync(false)
        .then(() => scheduleRetry());
    },
    delays[Math.min(retryAttempt, delays.length - 1)],
  );
}

/**
 * Puts the failed saves into `unsavedDates` and `conflictDates`; stops
 * retrying once none is left to retry.
 */
function publishFailedSaves(): void {
  if (!hasRetryableSaves()) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
  }
  const unsavedDates = failedDates(failedSaves);
  const conflictDates = failedDates(conflictSaves);
  const current = useWorkJournalStore.getState();
  if (
    unsavedDates.join() !== current.unsavedDates.join() ||
    conflictDates.join() !== current.conflictDates.join()
  ) {
    useWorkJournalStore.setState({ unsavedDates, conflictDates });
  }
}

/** Counts local page saves; `lastLocalSave` holds the count at each date's latest save. */
let saveTick = 0;

/** The day-pages call still running and the date it is for, if any. */
let ensureInFlight: { today: string; done: Promise<void> } | null = null;
const lastLocalSave = new Map<string, number>();

/**
 * The last queued backend write per date and field (`<date>:body`,
 * `<date>:title`). Each save waits for the previous one of the same field,
 * so the backend writes them in the order they were made and the newest
 * text wins on disk. Title and body saves touch different fields, so they
 * do not wait for each other.
 */
const saveChains = new Map<string, Promise<void>>();

function chainKey(date: string, patch: WorkJournalPagePatch): string {
  return `${date}:${Object.keys(patch).sort().join(",")}`;
}

/** Resolves once every save queued so far for `date` has finished. */
function savesSettled(date: string): Promise<void> {
  const queued = [...saveChains.entries()]
    .filter(([key]) => key.startsWith(`${date}:`))
    .map(([, chain]) => chain);
  return Promise.all(queued).then(() => undefined);
}

/** Resolves once every save queued so far, for any date, has finished. */
function allSavesSettled(): Promise<void> {
  return Promise.all([...saveChains.values()]).then(() => undefined);
}

/** Each open editor's "send my unsaved text now" function. */
const editorFlushes = new Set<() => void>();

/**
 * Registers an open editor's flush, so a restore can save typing that is
 * still waiting for the debounce. Returns the unregister function.
 */
export function registerWorkJournalEditorFlush(flush: () => void): () => void {
  editorFlushes.add(flush);
  return () => {
    editorFlushes.delete(flush);
  };
}

/**
 * Sends every open editor's unsaved text now and resolves once every save
 * has finished, so a reader of the file (the report) sees the latest typing.
 */
export function flushWorkJournalSaves(): Promise<void> {
  for (const flush of editorFlushes) flush();
  void retryWorkJournalSaves();
  return allSavesSettled();
}

/**
 * Sends the text of every field whose last save failed again (the store keeps
 * that text). A field with a save already queued is skipped: that save carries
 * newer text and clears or keeps the mark itself. A field the other window
 * changed since is sent only with `overwrite` (the user chose to).
 */
export function retryWorkJournalSaves(overwrite = false): Promise<void> {
  const { pages, updatePage } = useWorkJournalStore.getState();
  const retries: Promise<boolean>[] = [];
  for (const key of [...failedSaves]) {
    if (saveChains.has(key) || (conflictSaves.has(key) && !overwrite)) continue;
    const date = keyDate(key);
    const page = pages[date];
    // The page is gone, and its text with it.
    if (!page) {
      forgetFailedSave(key);
      continue;
    }
    const patch: WorkJournalPagePatch = {};
    for (const field of keyFields(key)) {
      if (field === "body") patch.body = page.body;
      if (field === "title") patch.title = page.title;
    }
    retries.push(updatePage(date, patch));
  }
  publishFailedSaves();
  return Promise.all(retries).then(() => undefined);
}

/**
 * Drops this window's unsaved text where the other window changed the same
 * field, and shows the other window's text instead.
 */
export function discardWorkJournalConflicts(): void {
  const changed: Record<string, WorkJournalPage> = {};
  for (const key of [...conflictSaves]) {
    const date = keyDate(key);
    const disk = diskPages[date];
    const local = changed[date] ?? useWorkJournalStore.getState().pages[date];
    forgetFailedSave(key);
    if (!disk || !local) continue;
    const page = { ...local };
    for (const field of keyFields(key)) {
      if (field === "body") page.body = disk.body;
      if (field === "title") page.title = disk.title;
    }
    changed[date] = page;
  }
  useWorkJournalStore.setState((s) => ({ pages: { ...s.pages, ...changed } }));
  publishFailedSaves();
}

/**
 * What adding a line did: `saved`; `refused` (no editable editor, nothing
 * changed); or `save_failed` (the save failed and the line was taken back
 * out of the editor).
 */
export type WorkJournalAppendResult = "saved" | "refused" | "save_failed";

/**
 * Adds one line as a new paragraph at the end of a page and saves it.
 * Provided by the open editor for that date.
 */
export type WorkJournalLineAppender = (line: string) => Promise<WorkJournalAppendResult>;

/** The open editor's appender per date. */
const editorAppenders = new Map<string, WorkJournalLineAppender>();

/**
 * Registers the open editor's appender for `date`, so an accepted
 * suggestion goes through the editor (which owns the text while mounted)
 * instead of past it. Returns the unregister function.
 */
export function registerWorkJournalEditorAppend(
  date: string,
  append: WorkJournalLineAppender,
): () => void {
  editorAppenders.set(date, append);
  return () => {
    if (editorAppenders.get(date) === append) editorAppenders.delete(date);
  };
}

/**
 * Adds `line` to the end of the page for `date` through its open editor and
 * saves it. Anything but `saved` leaves the page without the line.
 */
export function appendWorkJournalLine(
  date: string,
  line: string,
): Promise<WorkJournalAppendResult> {
  const append = editorAppenders.get(date);
  return append ? append(line) : Promise.resolve("refused");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The code that starts the backend's refusal of a write while a restore or
 * undo replaces the journal (`WorkJournalError::RestoreInProgress`).
 */
export const WORK_JOURNAL_RESTORE_IN_PROGRESS_CODE = "RESTORE_IN_PROGRESS:";

/**
 * Reads the journal file. After a restore or undo (`replaced`) a failed read
 * is tried once more, since this window stays frozen until it reads one.
 */
async function readJournal(replaced: boolean): Promise<WorkJournalFile> {
  try {
    return await invoke<WorkJournalFile>("load_work_journal");
  } catch (error) {
    if (!replaced) throw error;
    console.error("Failed to read the restored Work Journal, trying again:", error);
    return invoke<WorkJournalFile>("load_work_journal");
  }
}

/**
 * Pages from a backend reply, keeping pages that still have a save in flight
 * and the fields whose last save failed.
 */
function mergePages(
  local: Record<string, WorkJournalPage>,
  incoming: Record<string, WorkJournalPage>,
): Record<string, WorkJournalPage> {
  const merged = { ...incoming };
  for (const date of Object.keys(local)) {
    if (!merged[date]) continue;
    if (pendingUpdates.has(date)) {
      merged[date] = local[date];
      continue;
    }
    // Only the field whose save failed stays local; the other one takes
    // the incoming text.
    const failed = failedFields(date);
    if (failed.has("body")) merged[date] = { ...merged[date], body: local[date].body };
    if (failed.has("title")) merged[date] = { ...merged[date], title: local[date].title };
  }
  return merged;
}

/** Sorted dates that have a page. ISO dates sort correctly as strings. */
function sortedDates(pages: Record<string, WorkJournalPage>): string[] {
  return Object.keys(pages).sort();
}

/** The page date closest to `date` (ties go to the earlier one), or null. */
export function nearestPageDate(
  pages: Record<string, WorkJournalPage>,
  date: string,
): string | null {
  let best: string | null = null;
  for (const candidate of sortedDates(pages)) {
    if (best === null || daysBetween(candidate, date) < daysBetween(best, date)) {
      best = candidate;
    }
  }
  return best;
}

export const useWorkJournalStore = create<WorkJournalState>((set, get) => ({
  pages: {},
  viewedDate: null,
  loading: false,
  error: null,
  revision: 0,
  replacing: false,
  unsavedDates: [],
  conflictDates: [],

  sync: async (replaced: boolean) => {
    const tick = saveTick;
    const { revision } = get();
    try {
      const journal = await readJournal(replaced);
      // A restore or undo happened (or is running) since the read started:
      // the reply may hold the journal it replaced. The read that follows a
      // finished one (`replaced`) is what ends `replacing` here.
      if (get().revision !== revision || (get().replacing && !replaced)) return;
      if (replaced) {
        get().replaceJournal(journal);
        return;
      }
      // Pages deleted in the other window take their failed saves along; a
      // field it changed since a failed save here is no longer retried.
      absorbDiskPages(journal.pages, tick);
      set((s) => {
        const pages = mergePages(s.pages, journal.pages);
        // A save made here after the read started is newer than the reply.
        for (const [date, at] of lastLocalSave) {
          if (at > tick && s.pages[date] && pages[date]) pages[date] = s.pages[date];
        }
        // The viewed page was deleted in the other window: show the nearest
        // one, as a delete here does.
        const viewed = s.viewedDate;
        if (viewed && s.pages[viewed] && !pages[viewed]) {
          return { pages, viewedDate: nearestPageDate(pages, viewed) ?? viewed };
        }
        return { pages };
      });
      // Another window just saved, so the disk may take the failed saves
      // that nobody changed since.
      void retryWorkJournalSaves();
    } catch (error) {
      console.error("Failed to re-read the Work Journal:", error);
      // The restored journal cannot be read: unfreeze, but without the old
      // pages, whose text must not be saved over it. A later change re-reads.
      if (replaced && get().replacing) {
        get().replaceJournal({ ...EMPTY_JOURNAL });
        set({
          error: `The restored Work Journal could not be read: ${errorMessage(error)}. Close and reopen the Work Journal.`,
        });
      }
    }
  },

  load: async () => {
    set({ loading: true, error: null });
    const tick = saveTick;
    try {
      const journal = await invoke<WorkJournalFile>("load_work_journal");
      absorbDiskPages(journal.pages, tick);
      set((s) => ({ pages: mergePages(s.pages, journal.pages), loading: false }));
    } catch (error) {
      console.error("Failed to load the Work Journal:", error);
      set({ loading: false, error: errorMessage(error) });
    }
  },

  ensurePages: (today: string) => {
    if (ensureInFlight?.today === today) return ensureInFlight.done;
    const run = async (): Promise<void> => {
      set({ loading: true, error: null });
      const tick = saveTick;
      try {
        const journal = await invoke<WorkJournalFile>("work_journal_ensure_pages", { today });
        absorbDiskPages(journal.pages, tick);
        set((s) => ({ pages: mergePages(s.pages, journal.pages), loading: false }));
      } catch (error) {
        console.error("Failed to create the Work Journal day pages:", error);
        set({ loading: false, error: errorMessage(error) });
      }
    };
    const done = run().finally(() => {
      if (ensureInFlight?.done === done) ensureInFlight = null;
    });
    ensureInFlight = { today, done };
    return done;
  },

  selectDate: (date: string) => set({ viewedDate: date }),

  goPrev: () => {
    const { pages, viewedDate } = get();
    if (!viewedDate) return;
    const prev = sortedDates(pages)
      .filter((d) => d < viewedDate)
      .pop();
    if (prev) set({ viewedDate: prev });
  },

  goNext: () => {
    const { pages, viewedDate } = get();
    if (!viewedDate) return;
    const next = sortedDates(pages).find((d) => d > viewedDate);
    if (next) set({ viewedDate: next });
  },

  createPage: async (date: string) => {
    set({ error: null });
    const tick = saveTick;
    try {
      const journal = await invoke<WorkJournalFile>("create_work_journal_page", {
        date,
        title: defaultWorkJournalTitle(date),
        body: isWeekend(date) ? WEEKEND_PAGE_BODY : EMPTY_PAGE_BODY,
        origin: "manual",
      });
      absorbDiskPages(journal.pages, tick);
      set((s) => ({ pages: mergePages(s.pages, journal.pages), viewedDate: date }));
    } catch (error) {
      console.error("Failed to create the Work Journal page:", error);
      set({ error: errorMessage(error) });
    }
  },

  updatePage: async (date: string, patch: WorkJournalPagePatch) => {
    // Dropped while a restore or undo replaces the journal: the text belongs to
    // the journal being replaced.
    if (!get().pages[date] || get().replacing) return false;
    // Optimistic: the store holds what the user sees right away. The reply
    // is not applied, so an older reply can never overwrite newer typing.
    set((s) => {
      const current = s.pages[date];
      return current ? { pages: { ...s.pages, [date]: { ...current, ...patch } } } : {};
    });
    pendingUpdates.set(date, (pendingUpdates.get(date) ?? 0) + 1);
    saveTick += 1;
    lastLocalSave.set(date, saveTick);
    let saved = false;
    const run = async (): Promise<void> => {
      try {
        await invoke<WorkJournalFile>("update_work_journal_page", {
          date,
          title: patch.title ?? null,
          body: patch.body ?? null,
        });
        saved = true;
        forgetFailedSave(chainKey(date, patch));
        // The disk now holds this text: a later read showing other text
        // means the other window saved after it.
        const disk = diskPages[date];
        if (disk) diskPages = { ...diskPages, [date]: { ...disk, ...patch } };
        publishFailedSaves();
      } catch (error) {
        const key = chainKey(date, patch);
        failedSaves.add(key);
        if (!failedBases.has(key) && diskPages[date]) {
          failedBases.set(key, fieldsJson(key, diskPages[date]));
        }
        // A restore or undo refused it: kept quietly (no error, no retry). A
        // restore that lands drops it with the old journal; one that fails
        // sends it again (`endReplace`).
        if (errorMessage(error).startsWith(WORK_JOURNAL_RESTORE_IN_PROGRESS_CODE)) return;
        console.error("Failed to save the Work Journal page:", error);
        set({ error: errorMessage(error) });
        publishFailedSaves();
        scheduleRetry();
      } finally {
        const left = (pendingUpdates.get(date) ?? 1) - 1;
        if (left > 0) pendingUpdates.set(date, left);
        else pendingUpdates.delete(date);
      }
    };
    // Queue behind the previous save of this field (run never rejects). With
    // nothing queued it starts at once, so a flush on window close is sent
    // before the page goes away.
    const key = chainKey(date, patch);
    const previous = saveChains.get(key);
    const queued = previous ? previous.then(run) : run();
    saveChains.set(key, queued);
    await queued;
    if (saveChains.get(key) === queued) saveChains.delete(key);
    return saved;
  },

  deletePage: async (date: string) => {
    const { pages } = get();
    if (!pages[date]) return;
    // Optimistic: drop the page first, so a final save flushed by the
    // closing editor finds no page and is skipped.
    const remaining = { ...pages };
    delete remaining[date];
    set({ pages: remaining, viewedDate: nearestPageDate(remaining, date) ?? date, error: null });
    try {
      // A save queued just before the delete must land first, or the
      // backend would refuse it for a page that no longer exists.
      await savesSettled(date);
      clearFailedSaves(date);
      publishFailedSaves();
      const tick = saveTick;
      const journal = await invoke<WorkJournalFile>("delete_work_journal_page", {
        date,
        today: localDateString(new Date()),
      });
      absorbDiskPages(journal.pages, tick);
      set((s) => ({ pages: mergePages(s.pages, journal.pages) }));
    } catch (error) {
      console.error("Failed to delete the Work Journal page:", error);
      set({ error: errorMessage(error) });
      await get().load();
    }
  },

  clearError: () => set({ error: null }),

  // The flag is set before the wait, so a save made while earlier ones settle
  // is dropped rather than sent unawaited.
  beginReplace: async () => {
    for (const flush of editorFlushes) flush();
    set({ replacing: true });
    await allSavesSettled();
  },

  // Text a backend refusal kept during the restore is sent now.
  endReplace: () => {
    set({ replacing: false });
    void retryWorkJournalSaves();
  },

  // Every save was settled before the restore, so the reply replaces the
  // pages outright (no merge with local copies).

  // The text of failed saves belonged to the replaced journal.
  replaceJournal: (journal: WorkJournalFile) => {
    failedSaves.clear();
    failedBases.clear();
    conflictSaves.clear();
    diskPages = journal.pages;
    publishFailedSaves();
    set((s) => ({
      pages: journal.pages,
      revision: s.revision + 1,
      replacing: false,
      error: null,
    }));
  },
}));
