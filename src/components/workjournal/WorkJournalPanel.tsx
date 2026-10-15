import { ask } from "@tauri-apps/plugin-dialog";
import { CalendarPlus, CalendarSearch, ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { WorkJournalEditor } from "@/components/workjournal/WorkJournalEditor";
import {
  defaultWorkJournalTitle,
  isValidJournalDate,
  localDateString,
  msUntilNextLocalMidnight,
} from "@/lib/workJournalDates";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";

/**
 * Slack after local midnight before the day pages are refreshed, so a timer
 * that fires a moment early still sees the new date.
 */
const MIDNIGHT_SLACK_MS = 1_000;

/** Which date form is open under the header, if any. */
type DateFormMode = "jump" | "new";

const ICON_BUTTON =
  "rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * Right-pane Work Journal view: one day page at a time. The header has
 * previous/next day arrows, the editable title, a jump-to-date picker, "new
 * page for a date" and delete; the page body is a TipTap editor below.
 *
 * Opens on today's page (local date). On open and at every local midnight
 * while open, it asks the backend to create any missing day pages.
 */
export function WorkJournalPanel() {
  const pages = useWorkJournalStore((s) => s.pages);
  const viewedDate = useWorkJournalStore((s) => s.viewedDate);
  const loading = useWorkJournalStore((s) => s.loading);
  const error = useWorkJournalStore((s) => s.error);
  const ensurePages = useWorkJournalStore((s) => s.ensurePages);
  const selectDate = useWorkJournalStore((s) => s.selectDate);
  const goPrev = useWorkJournalStore((s) => s.goPrev);
  const goNext = useWorkJournalStore((s) => s.goNext);
  const createPage = useWorkJournalStore((s) => s.createPage);
  const updatePage = useWorkJournalStore((s) => s.updatePage);
  const deletePage = useWorkJournalStore((s) => s.deletePage);
  const clearError = useWorkJournalStore((s) => s.clearError);

  const page = viewedDate ? (pages[viewedDate] ?? null) : null;
  const dates = Object.keys(pages);
  const hasPrev = viewedDate !== null && dates.some((d) => d < viewedDate);
  const hasNext = viewedDate !== null && dates.some((d) => d > viewedDate);

  // Open on today's page and make sure every day up to today has one.
  useEffect(() => {
    const today = localDateString(new Date());
    selectDate(today);
    void ensurePages(today);
  }, [selectDate, ensurePages]);

  // While open, create the new day's page at each local midnight. The view
  // stays where the user is; the arrows reach the new page.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => {
        void ensurePages(localDateString(new Date()));
        arm();
      }, msUntilNextLocalMidnight(new Date()) + MIDNIGHT_SLACK_MS);
    };
    arm();
    return () => clearTimeout(timer);
  }, [ensurePages]);

  // Title draft: committed on blur or Enter, reverted on Escape.
  const [titleDraft, setTitleDraft] = useState("");
  const pageTitle = page?.title ?? "";
  useEffect(() => {
    setTitleDraft(pageTitle);
  }, [pageTitle]);

  const commitTitle = (): void => {
    if (!page) return;
    const next = titleDraft.trim();
    if (!next || next === page.title) {
      setTitleDraft(page.title);
      return;
    }
    void updatePage(page.date, { title: next });
  };

  const handleTitleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setTitleDraft(pageTitle);
      // Blur after the reset lands, so the commit sees the original title.
      const input = e.currentTarget;
      setTimeout(() => input.blur(), 0);
    }
  };

  // Jump-to-date and new-page forms share one row under the header.
  const [formMode, setFormMode] = useState<DateFormMode | null>(null);
  const [formDate, setFormDate] = useState("");
  const toggleForm = (mode: DateFormMode): void => {
    setFormMode((prev) => (prev === mode ? null : mode));
    setFormDate(viewedDate ?? "");
  };

  const handleJump = (value: string): void => {
    setFormDate(value);
    if (!isValidJournalDate(value)) return;
    selectDate(value);
    setFormMode(null);
  };

  const newDateTaken = formDate !== "" && pages[formDate] !== undefined;
  const canCreate = isValidJournalDate(formDate) && !newDateTaken;
  const handleCreate = async (): Promise<void> => {
    if (!canCreate) return;
    setFormMode(null);
    await createPage(formDate);
  };

  const handleDelete = async (): Promise<void> => {
    if (!page) return;
    const confirmed = await ask(
      `Delete the Work Journal page "${page.title}"? It will not be created again on its own.`,
      { title: "Delete Work Journal Page", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    await deletePage(page.date);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: arrows, title, jump, new page, delete */}
      <div className="flex shrink-0 items-center gap-1 border-b border-maestro-border px-2 py-1.5">
        <button
          type="button"
          onClick={goPrev}
          disabled={!hasPrev}
          className={ICON_BUTTON}
          aria-label="Previous day"
          title="Previous day"
        >
          <ChevronLeft size={14} />
        </button>
        <input
          type="text"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={handleTitleKey}
          disabled={!page}
          aria-label="Page title"
          placeholder={viewedDate ? defaultWorkJournalTitle(viewedDate) : ""}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-medium text-maestro-text outline-none hover:border-maestro-border focus:border-maestro-accent disabled:hover:border-transparent"
        />
        <button
          type="button"
          onClick={goNext}
          disabled={!hasNext}
          className={ICON_BUTTON}
          aria-label="Next day"
          title="Next day"
        >
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => toggleForm("jump")}
          className={`${ICON_BUTTON} ${formMode === "jump" ? "text-maestro-accent" : ""}`}
          aria-label="Jump to date"
          title="Jump to date"
        >
          <CalendarSearch size={14} />
        </button>
        <button
          type="button"
          onClick={() => toggleForm("new")}
          className={`${ICON_BUTTON} ${formMode === "new" ? "text-maestro-accent" : ""}`}
          aria-label="New page for a date"
          title="New page for a date"
        >
          <CalendarPlus size={14} />
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={!page}
          className={`${ICON_BUTTON} hover:text-maestro-red`}
          aria-label="Delete page"
          title="Delete page"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {formMode && (
        <div className="flex shrink-0 items-center gap-2 border-b border-maestro-border/60 px-3 py-1.5 text-xs text-maestro-muted">
          <span>{formMode === "jump" ? "Go to" : "New page for"}</span>
          <input
            type="date"
            value={formDate}
            onChange={(e) =>
              formMode === "jump" ? handleJump(e.target.value) : setFormDate(e.target.value)
            }
            aria-label={formMode === "jump" ? "Date to jump to" : "Date for the new page"}
            className="rounded border border-maestro-border bg-maestro-card px-1.5 py-0.5 text-xs text-maestro-text outline-none focus:border-maestro-accent"
          />
          {formMode === "new" && (
            <>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={!canCreate}
                className="rounded bg-maestro-card px-2 py-0.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create
              </button>
              {newDateTaken && <span>That date already has a page.</span>}
            </>
          )}
        </div>
      )}

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-maestro-border/60 bg-maestro-red/10 px-3 py-1.5 text-xs text-maestro-red">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="rounded p-0.5 hover:bg-maestro-red/20"
            aria-label="Dismiss error"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {page ? (
        <WorkJournalEditor
          // One editor per date, so each page keeps its own undo history and
          // the previous page's unsaved text is flushed on the switch.
          key={page.date}
          date={page.date}
          initialBody={page.body}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          {loading || !viewedDate ? (
            <p className="text-xs text-maestro-muted/60">Loading…</p>
          ) : (
            <div className="flex flex-col items-center gap-2 text-maestro-muted/60">
              <p className="text-xs">No page for {defaultWorkJournalTitle(viewedDate)}.</p>
              <button
                type="button"
                onClick={() => void createPage(viewedDate)}
                className="flex items-center gap-1 rounded bg-maestro-card px-2 py-1 text-xs text-maestro-text transition-colors hover:bg-maestro-border"
              >
                <CalendarPlus size={12} />
                <span>Create a page for this day</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
