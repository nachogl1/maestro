import { ask } from "@tauri-apps/plugin-dialog";
import {
  CalendarPlus,
  CalendarSearch,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Trash2,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ReportDialog } from "@/components/workjournal/ReportDialog";
import { SuggestionsBox } from "@/components/workjournal/SuggestionsBox";
import { WorkJournalBackupReminder } from "@/components/workjournal/WorkJournalBackupReminder";
import {
  canReadWorkJournalBody,
  WorkJournalEditor,
} from "@/components/workjournal/WorkJournalEditor";
import {
  defaultWorkJournalTitle,
  isValidJournalDate,
  localDateString,
  msUntilNextLocalMidnight,
} from "@/lib/workJournalDates";
import {
  listenWorkJournalChanged,
  listenWorkJournalReplacing,
  openWorkJournalWindow,
} from "@/lib/workJournalWindow";
import { useWorkJournalCandidatesStore } from "@/stores/useWorkJournalCandidatesStore";
import {
  discardWorkJournalConflicts,
  retryWorkJournalSaves,
  useWorkJournalStore,
} from "@/stores/useWorkJournalStore";

/**
 * Slack after local midnight before the day pages are refreshed, so a timer
 * that fires a moment early still sees the new date.
 */
const MIDNIGHT_SLACK_MS = 1_000;

/**
 * How often the local date is compared while open. A cheap string compare
 * that catches what the midnight timer misses: a PC that slept through
 * midnight (timers pause) or a clock or time-zone change.
 */
const DATE_CHECK_INTERVAL_MS = 60_000;

/** Which date form is open under the header, if any. */
type DateFormMode = "jump" | "new";

const ICON_BUTTON =
  "rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

export interface WorkJournalPanelProps {
  /** Shown inside the pop-out window, which has no pop-out button of its own. */
  inWindow?: boolean;
}

/**
 * Right-pane Work Journal view: one day page at a time. The header has
 * previous/next day arrows, the editable title, a jump-to-date picker, "new
 * page for a date", delete, Report (the supervisor report dialog) and
 * pop-out (the journal in its own window); the page body is a TipTap editor
 * below, and the day's suggestions box under it.
 *
 * Opens on today's page (local date). On open, and whenever the local date
 * changes while open (midnight timer, window focus or visibility, a
 * once-a-minute check), it asks the backend to create any missing day pages.
 * A change made in the other window (pane or pop-out) is re-read at once.
 */
export function WorkJournalPanel({ inWindow = false }: WorkJournalPanelProps) {
  const pages = useWorkJournalStore((s) => s.pages);
  const viewedDate = useWorkJournalStore((s) => s.viewedDate);
  const loading = useWorkJournalStore((s) => s.loading);
  const error = useWorkJournalStore((s) => s.error);
  const revision = useWorkJournalStore((s) => s.revision);
  const replacing = useWorkJournalStore((s) => s.replacing);
  const unsavedDates = useWorkJournalStore((s) => s.unsavedDates);
  const conflictDates = useWorkJournalStore((s) => s.conflictDates);
  const ensurePages = useWorkJournalStore((s) => s.ensurePages);
  const selectDate = useWorkJournalStore((s) => s.selectDate);
  const goPrev = useWorkJournalStore((s) => s.goPrev);
  const goNext = useWorkJournalStore((s) => s.goNext);
  const createPage = useWorkJournalStore((s) => s.createPage);
  const updatePage = useWorkJournalStore((s) => s.updatePage);
  const deletePage = useWorkJournalStore((s) => s.deletePage);
  const clearError = useWorkJournalStore((s) => s.clearError);
  const sync = useWorkJournalStore((s) => s.sync);
  const beginReplace = useWorkJournalStore((s) => s.beginReplace);
  const endReplace = useWorkJournalStore((s) => s.endReplace);

  const page = viewedDate ? (pages[viewedDate] ?? null) : null;
  const dates = Object.keys(pages);
  const hasPrev = viewedDate !== null && dates.some((d) => d < viewedDate);
  const hasNext = viewedDate !== null && dates.some((d) => d > viewedDate);

  // The local date the day pages were last ensured for.
  const knownDateRef = useRef<string | null>(null);

  // Open on today's page and make sure every day up to today has one.
  useEffect(() => {
    const today = localDateString(new Date());
    knownDateRef.current = today;
    selectDate(today);
    void ensurePages(today);
  }, [selectDate, ensurePages]);

  // While open, create the new day's page when the local date changes. The
  // view stays where the user is; the arrows reach the new page.
  useEffect(() => {
    const checkDate = (): void => {
      const now = localDateString(new Date());
      if (now === knownDateRef.current) return;
      knownDateRef.current = now;
      void ensurePages(now);
      // The top-bar badge counts the new day's suggestions from now on.
      void useWorkJournalCandidatesStore.getState().refreshToday();
    };
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => {
        checkDate();
        arm();
      }, msUntilNextLocalMidnight(new Date()) + MIDNIGHT_SLACK_MS);
    };
    arm();
    const interval = setInterval(checkDate, DATE_CHECK_INTERVAL_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") checkDate();
    };
    window.addEventListener("focus", checkDate);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("focus", checkDate);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ensurePages]);

  // The pane and the pop-out window share the journal file: re-read it when
  // the other one (or a candidate run) changed it.
  useEffect(() => {
    const stop = listenWorkJournalChanged((change) => void sync(change.replaced)).catch((err) => {
      console.error("Failed to follow Work Journal changes:", err);
      return () => {};
    });
    return () => {
      void stop.then((fn) => fn());
    };
  }, [sync]);

  // A restore or undo started in the other window freezes this one too: its
  // unsaved text is sent first (into the safety copy), then nothing is saved
  // until the restored journal is read back (`sync(true)`) or the restore fails.
  useEffect(() => {
    const stop = listenWorkJournalReplacing((active) => {
      if (active) void beginReplace();
      else endReplace();
    }).catch((err) => {
      console.error("Failed to follow Work Journal restores:", err);
      return () => {};
    });
    return () => {
      void stop.then((fn) => fn());
    };
  }, [beginReplace, endReplace]);

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

  // Best effort when the window closes: save a title still being edited. The
  // OS may still end the process before the backend writes it.
  const commitTitleRef = useRef(commitTitle);
  commitTitleRef.current = commitTitle;
  useEffect(() => {
    const onLeave = (): void => commitTitleRef.current();
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("pagehide", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("pagehide", onLeave);
    };
  }, []);

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

  // Jump only on Enter or Go: the date input reports a value on every typed
  // digit (typing "12" in the day field passes through "01" first).
  const canJump = isValidJournalDate(formDate);
  const handleJump = (): void => {
    if (!canJump) return;
    selectDate(formDate);
    setFormMode(null);
  };

  // One create at a time, so a double-click cannot send two.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const runCreate = async (date: string): Promise<void> => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      await createPage(date);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const newDateTaken = formDate !== "" && pages[formDate] !== undefined;
  const canCreate = isValidJournalDate(formDate) && !newDateTaken && !creating && !replacing;
  const handleCreate = async (): Promise<void> => {
    if (!canCreate) return;
    setFormMode(null);
    await runCreate(formDate);
  };

  const handleFormKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (formMode === "jump") handleJump();
    else void handleCreate();
  };

  const [reportOpen, setReportOpen] = useState(false);

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
      {/* Header: arrows, title, jump, new page, delete, report */}
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
          disabled={!page || replacing}
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
          disabled={replacing}
          className={`${ICON_BUTTON} ${formMode === "new" ? "text-maestro-accent" : ""}`}
          aria-label="New page for a date"
          title="New page for a date"
        >
          <CalendarPlus size={14} />
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={!page || replacing}
          className={`${ICON_BUTTON} hover:text-maestro-red`}
          aria-label="Delete page"
          title="Delete page"
        >
          <Trash2 size={14} />
        </button>
        <button
          type="button"
          onClick={() => setReportOpen(true)}
          className={ICON_BUTTON}
          aria-label="Report"
          title="Work report for a date range"
        >
          <FileText size={14} />
        </button>
        {!inWindow && (
          <button
            type="button"
            onClick={() =>
              void openWorkJournalWindow().catch((err) =>
                console.error("Failed to open the Work Journal window:", err),
              )
            }
            className={ICON_BUTTON}
            aria-label="Pop out"
            title="Open the journal in its own window"
          >
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      {/* Stays until the text is saved: closing and reopening the pane does not clear it. */}
      {unsavedDates.length > 0 && (
        <output className="flex shrink-0 items-center gap-2 border-b border-maestro-border/60 bg-maestro-orange/10 px-3 py-1.5 text-xs text-maestro-orange">
          {conflictDates.length > 0 ? (
            // The other window saved the same field since: only the user decides.
            <>
              <span className="flex-1">
                Unsaved changes ({conflictDates.map(defaultWorkJournalTitle).join(", ")}): the other
                window changed this text too.
              </span>
              <button
                type="button"
                onClick={() => void retryWorkJournalSaves(true)}
                className="rounded px-1.5 py-0.5 hover:bg-maestro-orange/20"
              >
                Overwrite with mine
              </button>
              <button
                type="button"
                onClick={discardWorkJournalConflicts}
                className="rounded px-1.5 py-0.5 hover:bg-maestro-orange/20"
              >
                Discard mine
              </button>
            </>
          ) : (
            <>
              <span className="flex-1">
                Unsaved changes, retrying ({unsavedDates.map(defaultWorkJournalTitle).join(", ")})
              </span>
              <button
                type="button"
                onClick={() => void retryWorkJournalSaves()}
                className="rounded px-1.5 py-0.5 hover:bg-maestro-orange/20"
              >
                Retry now
              </button>
            </>
          )}
        </output>
      )}

      <WorkJournalBackupReminder inWindow={inWindow} />

      {reportOpen && <ReportDialog onClose={() => setReportOpen(false)} />}

      {formMode && (
        <div className="flex shrink-0 items-center gap-2 border-b border-maestro-border/60 px-3 py-1.5 text-xs text-maestro-muted">
          <span>{formMode === "jump" ? "Go to" : "New page for"}</span>
          <input
            type="date"
            value={formDate}
            onChange={(e) => setFormDate(e.target.value)}
            onKeyDown={handleFormKey}
            aria-label={formMode === "jump" ? "Date to jump to" : "Date for the new page"}
            className="rounded border border-maestro-border bg-maestro-card px-1.5 py-0.5 text-xs text-maestro-text outline-none focus:border-maestro-accent"
          />
          {formMode === "jump" && (
            <button
              type="button"
              onClick={handleJump}
              disabled={!canJump}
              className="rounded bg-maestro-card px-2 py-0.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border disabled:cursor-not-allowed disabled:opacity-50"
            >
              Go
            </button>
          )}
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
          // the previous page's unsaved text is flushed on the switch. A
          // restore bumps the revision, remounting it with the new body.
          key={`${page.date}:${revision}`}
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
                onClick={() => void runCreate(viewedDate)}
                disabled={creating || replacing}
                className="flex items-center gap-1 rounded bg-maestro-card px-2 py-1 text-xs text-maestro-text transition-colors hover:bg-maestro-border disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CalendarPlus size={12} />
                <span>Create a page for this day</span>
              </button>
            </div>
          )}
        </div>
      )}

      {viewedDate && (
        <SuggestionsBox
          date={viewedDate}
          hasPage={page !== null}
          readOnly={page !== null && !canReadWorkJournalBody(page.body)}
        />
      )}
    </div>
  );
}
