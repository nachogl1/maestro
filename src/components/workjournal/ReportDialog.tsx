import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissable } from "@/hooks/useDismissable";
import { daysBetween, isValidJournalDate, localDateString } from "@/lib/workJournalDates";
import { type ReportOutcome, useWorkJournalReportStore } from "@/stores/useWorkJournalReportStore";
import { flushWorkJournalSaves } from "@/stores/useWorkJournalStore";

/** How many days the default range covers, ending today. */
const DEFAULT_RANGE_DAYS = 7;

/** Shown when no page in the range has anything to report. */
export const NOTHING_TO_REPORT = "Nothing to report for these dates.";

/** Shown while the start date is after the end date. */
export const RANGE_REVERSED = "The start date must not be after the end date.";

/** The longest range one report covers, both ends included (the backend's MAX_REPORT_DAYS). */
export const MAX_REPORT_DAYS = 92;

/** Shown while the range is longer than MAX_REPORT_DAYS (the backend's own wording). */
export const RANGE_TOO_LONG = `Choose a range of at most ${MAX_REPORT_DAYS} days.`;

/** Where a Generate is: not running, getting the folder ready, or writing the report. */
type ReportPhase = "idle" | "preparing" | "writing";

/** What the last Generate ended with. */
type ReportResultState =
  | { kind: "saved"; path: string }
  | { kind: "nothing" }
  | { kind: "error"; message: string }
  // The saved folder is gone: offers "Choose folder" next to the message.
  | { kind: "folder_missing"; message: string }
  | { kind: "folder_chosen"; path: string };

export interface ReportDialogProps {
  /** Closes the dialog. */
  onClose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The local date `days` days before `now`, as `YYYY-MM-DD`. */
function localDateDaysBefore(now: Date, days: number): string {
  return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
}

const DATE_INPUT =
  "rounded border border-maestro-border bg-maestro-card px-1.5 py-0.5 text-xs text-maestro-text outline-none focus:border-maestro-accent";

/**
 * The supervisor report dialog: from and to dates (default: the last seven
 * days ending today), Generate, and the result. Before the first report,
 * Generate asks for the report folder and saves it. The report is written
 * by the backend straight into that folder; "Open folder" reveals the file.
 * When the saved folder is gone, the dialog offers "Choose folder"; choosing
 * one never starts a report by itself.
 * The dialog cannot be closed while a report runs (nothing would cancel it).
 */
export function ReportDialog({ onClose }: ReportDialogProps): JSX.Element {
  const [from, setFrom] = useState(() => localDateDaysBefore(new Date(), DEFAULT_RANGE_DAYS - 1));
  const [to, setTo] = useState(() => localDateString(new Date()));
  const [phase, setPhase] = useState<ReportPhase>("idle");
  const [result, setResult] = useState<ReportResultState | null>(null);
  // Claimed synchronously on Generate, so a second click before the next
  // render cannot start a second run.
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const running = phase !== "idle";

  // Closing is off while a report runs: nothing would cancel it, and its
  // result would be lost.
  useDismissable(onClose, { ref: dialogRef, enabled: !running });

  useEffect(() => {
    fromRef.current?.focus();
  }, []);

  const datesValid = isValidJournalDate(from) && isValidJournalDate(to);
  const reversed = datesValid && from > to;
  const tooLong = datesValid && !reversed && daysBetween(from, to) + 1 > MAX_REPORT_DAYS;
  const canGenerate = datesValid && !reversed && !tooLong && !running;

  /** Asks for the report folder and saves it; null when cancelled or not saved. */
  const pickFolder = async (): Promise<string | null> => {
    let picked: string | string[] | null;
    try {
      picked = await open({
        directory: true,
        multiple: false,
        title: "Choose the folder for Work Journal reports",
      });
    } catch (error) {
      console.error("Failed to open the folder picker:", error);
      setResult({ kind: "error", message: "The folder picker could not be opened." });
      return null;
    }
    if (typeof picked !== "string") return null;
    const store = useWorkJournalReportStore.getState();
    if (!(await store.chooseFolder(picked))) {
      setResult({
        kind: "error",
        message: useWorkJournalReportStore.getState().error ?? "Could not save the folder.",
      });
      return null;
    }
    return picked;
  };

  const handleGenerate = async (): Promise<void> => {
    if (!canGenerate || busyRef.current) return;
    busyRef.current = true;
    setPhase("preparing");
    setResult(null);
    try {
      await generate();
    } finally {
      busyRef.current = false;
      setPhase("idle");
    }
  };

  /** One Generate: folder (asked for when unset), pending saves, the report. */
  const generate = async (): Promise<void> => {
    const store = useWorkJournalReportStore.getState();
    // Read the folder fresh: it may have been chosen in Settings meanwhile.
    if (!(await store.load())) {
      setResult({
        kind: "error",
        message: useWorkJournalReportStore.getState().error ?? "Could not read the settings.",
      });
      return;
    }
    if (!useWorkJournalReportStore.getState().reportFolder && !(await pickFolder())) return;
    setPhase("writing");
    try {
      // The report reads the file, so typing still waiting to be saved goes in first.
      await flushWorkJournalSaves();
      const outcome = await invoke<ReportOutcome>("work_journal_generate_report", { from, to });
      if (outcome?.status === "saved") {
        setResult({ kind: "saved", path: outcome.path });
      } else if (outcome?.status === "nothing_to_report") {
        setResult({ kind: "nothing" });
      } else if (outcome?.status === "no_folder") {
        await store.load();
        setResult({
          kind: "error",
          message: "No report folder is set. Press Generate again to choose one.",
        });
      } else if (outcome?.status === "folder_missing") {
        setResult({ kind: "folder_missing", message: outcome.message });
      } else if (outcome?.status === "busy") {
        setResult({
          kind: "error",
          message: "A report is already being made. Try again when it is done.",
        });
      }
    } catch (error) {
      console.error("Work Journal report failed:", error);
      // The backend's messages are already plain sentences.
      setResult({ kind: "error", message: errorMessage(error) });
    }
  };

  /** "Choose folder" after the saved folder went missing; never starts a report itself. */
  const handleChooseFolder = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const picked = await pickFolder();
      if (picked) setResult({ kind: "folder_chosen", path: picked });
    } finally {
      busyRef.current = false;
    }
  };

  const handleOpenFolder = async (path: string): Promise<void> => {
    try {
      await revealItemInDir(path);
    } catch (error) {
      console.error("Failed to open the report folder:", error);
      setResult({ kind: "error", message: `Could not open the folder: ${errorMessage(error)}` });
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-journal-report-title"
        className="w-full max-w-sm rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-maestro-border px-4 py-3">
          <h2 id="work-journal-report-title" className="text-sm font-semibold text-maestro-text">
            Work report
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded p-1 text-maestro-muted hover:bg-maestro-border/40 disabled:opacity-40"
            aria-label="Close report dialog"
          >
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 px-4 py-3 text-xs text-maestro-muted">
          <p>A summary of what your journal pages say for these dates, saved as an HTML file.</p>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5">
              <span>From</span>
              <input
                ref={fromRef}
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                disabled={running}
                aria-label="From date"
                className={DATE_INPUT}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span>To</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                disabled={running}
                aria-label="To date"
                className={DATE_INPUT}
              />
            </label>
          </div>
          {reversed && <p className="text-maestro-red">{RANGE_REVERSED}</p>}
          {tooLong && <p className="text-maestro-red">{RANGE_TOO_LONG}</p>}
          {phase === "writing" && (
            <output className="flex items-center gap-1.5 text-maestro-text">
              <Loader2 size={12} className="animate-spin" />
              Writing the report… this can take a minute. You can close this when it is done.
            </output>
          )}
          {result?.kind === "saved" && (
            <div className="flex items-center gap-2">
              <output className="min-w-0 flex-1 break-all text-maestro-green">
                Saved to {result.path}
              </output>
              <button
                type="button"
                onClick={() => void handleOpenFolder(result.path)}
                className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] text-maestro-accent hover:bg-maestro-border/40"
              >
                <FolderOpen size={11} />
                Open folder
              </button>
            </div>
          )}
          {result?.kind === "nothing" && (
            <output className="block text-maestro-text">{NOTHING_TO_REPORT}</output>
          )}
          {result?.kind === "folder_missing" && (
            <div className="flex items-center gap-2">
              <div role="alert" className="min-w-0 flex-1 break-all text-maestro-red">
                {result.message}
              </div>
              <button
                type="button"
                onClick={() => void handleChooseFolder()}
                className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] text-maestro-accent hover:bg-maestro-border/40"
              >
                <FolderOpen size={11} />
                Choose folder
              </button>
            </div>
          )}
          {result?.kind === "folder_chosen" && (
            <output className="block break-all text-maestro-text">
              Reports will be saved to {result.path}. Press Generate to make the report.
            </output>
          )}
          {result?.kind === "error" && (
            <div role="alert" className="text-maestro-red">
              {result.message}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-maestro-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded px-3 py-1 text-xs text-maestro-muted hover:bg-maestro-border/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {result ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={!canGenerate}
            className="flex items-center gap-1 rounded border border-maestro-accent/50 bg-maestro-accent/10 px-3 py-1 text-xs font-medium text-maestro-accent hover:bg-maestro-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running && <Loader2 size={11} className="animate-spin" />}
            Generate
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
