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
  /** Reads the journal file. */
  load: () => Promise<void>;
  /** Auto-creates missing day pages up to `today` (local `YYYY-MM-DD`). */
  ensurePages: (today: string) => Promise<void>;
  selectDate: (date: string) => void;
  /** Moves to the nearest existing page before the viewed date. */
  goPrev: () => void;
  /** Moves to the nearest existing page after the viewed date. */
  goNext: () => void;
  /** Creates a manual page for `date` with the default title and shows it. */
  createPage: (date: string) => Promise<void>;
  /** Saves a title and/or body change; ignored for a date with no page. */
  updatePage: (date: string, patch: WorkJournalPagePatch) => Promise<void>;
  /** Deletes the page for `date` and shows the nearest remaining page. */
  deletePage: (date: string) => Promise<void>;
  clearError: () => void;
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
    const page = get().pages[date];
    if (!page) return;
    // Optimistic: the store holds what the user sees right away. The reply
    // is not applied, so an older reply can never overwrite newer typing.
    set((s) => ({ pages: { ...s.pages, [date]: { ...page, ...patch } } }));
    pendingUpdates.set(date, (pendingUpdates.get(date) ?? 0) + 1);
    try {
      await invoke<WorkJournalFile>("update_work_journal_page", {
        date,
        title: patch.title ?? null,
        body: patch.body ?? null,
      });
    } catch (error) {
      console.error("Failed to save the Work Journal page:", error);
      set({ error: errorMessage(error) });
    } finally {
      const left = (pendingUpdates.get(date) ?? 1) - 1;
      if (left > 0) pendingUpdates.set(date, left);
      else pendingUpdates.delete(date);
    }
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
      const journal = await invoke<WorkJournalFile>("delete_work_journal_page", { date });
      set((s) => ({ pages: mergePages(s.pages, journal.pages) }));
    } catch (error) {
      console.error("Failed to delete the Work Journal page:", error);
      set({ error: errorMessage(error) });
      await get().load();
    }
  },

  clearError: () => set({ error: null }),
}));
