import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/react";
import { create } from "zustand";
import { daysBetween, defaultWorkJournalTitle, isWeekend } from "@/lib/workJournalDates";

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
  /** Reads the journal file. */
  load: () => Promise<void>;
  /**
   * Re-reads the journal after another window (or the backend) changed it;
   * `replaced` when that was a restore or undo. No loading state, so the
   * page stays on screen.
   */
  sync: (replaced: boolean) => Promise<void>;
  /** Auto-creates missing day pages up to `today` (local `YYYY-MM-DD`). */
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
  /** Ends a restore or undo that failed: clears `replacing`; the journal is unchanged. */
  endReplace: () => void;
  /**
   * Shows a journal that replaced the whole file (restore or undo); bumps
   * `revision` and clears `replacing`.
   */
  replaceJournal: (journal: WorkJournalFile) => void;
}

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

/** Counts local page saves; `lastLocalSave` holds the count at each date's latest save. */
let saveTick = 0;
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
  return allSavesSettled();
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

/** Pages from a backend reply, keeping pages that still have a save in flight. */
function mergePages(
  local: Record<string, WorkJournalPage>,
  incoming: Record<string, WorkJournalPage>,
): Record<string, WorkJournalPage> {
  const merged = { ...incoming };
  for (const date of pendingUpdates.keys()) {
    if (local[date] && merged[date]) merged[date] = local[date];
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

  sync: async (replaced: boolean) => {
    const tick = saveTick;
    try {
      const journal = await invoke<WorkJournalFile>("load_work_journal");
      if (replaced) {
        get().replaceJournal(journal);
        return;
      }
      set((s) => {
        const pages = mergePages(s.pages, journal.pages);
        // A save made here after the read started is newer than the reply.
        for (const [date, at] of lastLocalSave) {
          if (at > tick && s.pages[date] && pages[date]) pages[date] = s.pages[date];
        }
        return { pages };
      });
    } catch (error) {
      console.error("Failed to re-read the Work Journal:", error);
    }
  },

  load: async () => {
    set({ loading: true, error: null });
    try {
      const journal = await invoke<WorkJournalFile>("load_work_journal");
      set((s) => ({ pages: mergePages(s.pages, journal.pages), loading: false }));
    } catch (error) {
      console.error("Failed to load the Work Journal:", error);
      set({ loading: false, error: errorMessage(error) });
    }
  },

  ensurePages: async (today: string) => {
    set({ loading: true, error: null });
    try {
      const journal = await invoke<WorkJournalFile>("work_journal_ensure_pages", { today });
      set((s) => ({ pages: mergePages(s.pages, journal.pages), loading: false }));
    } catch (error) {
      console.error("Failed to create the Work Journal day pages:", error);
      set({ loading: false, error: errorMessage(error) });
    }
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
    try {
      const journal = await invoke<WorkJournalFile>("create_work_journal_page", {
        date,
        title: defaultWorkJournalTitle(date),
        body: isWeekend(date) ? WEEKEND_PAGE_BODY : EMPTY_PAGE_BODY,
        origin: "manual",
      });
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
      } catch (error) {
        console.error("Failed to save the Work Journal page:", error);
        set({ error: errorMessage(error) });
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
      const journal = await invoke<WorkJournalFile>("delete_work_journal_page", { date });
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

  endReplace: () => set({ replacing: false }),

  // Every save was settled before the restore, so the reply replaces the
  // pages outright (no merge with local copies).

  replaceJournal: (journal: WorkJournalFile) =>
    set((s) => ({
      pages: journal.pages,
      revision: s.revision + 1,
      replacing: false,
      error: null,
    })),
}));
