import { Check, X } from "lucide-react";
import { useEffect } from "react";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import {
  candidateLine,
  useWorkJournalCandidatesStore,
  WORK_JOURNAL_SOURCE_LABELS,
  type WorkJournalCandidate,
} from "@/stores/useWorkJournalCandidatesStore";

/** Stable empty list, so the selector does not return a new array each render. */
const NO_CANDIDATES: WorkJournalCandidate[] = [];

const ICON_BUTTON =
  "rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

export interface SuggestionsBoxProps {
  /** The viewed day (`YYYY-MM-DD`). */
  date: string;
  /** Whether that day has a page; Accept needs one to add the line to. */
  hasPage: boolean;
  /** The page is shown read-only (this build cannot read it), so Accept cannot add to it. */
  readOnly?: boolean;
}

/** "next run" text: "soon" before the start-up catch-up run, HH:MM, or "—" when unknown. */
function nextRunLabel(catchUpPending: boolean, nextRunAt: number | null): string {
  if (catchUpPending) return "soon";
  if (nextRunAt === null) return "—";
  const at = new Date(nextRunAt);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * The suggestions box under a Work Journal page: the day's pending
 * candidates, each with its text, source tag, and Accept and Reject icons,
 * and a footer "next run · run now". With nothing pending only the footer
 * shows, so "run now" is always reachable.
 */
export function SuggestionsBox({ date, hasPage, readOnly = false }: SuggestionsBoxProps) {
  const candidates = useWorkJournalCandidatesStore((s) => s.byDate[date] ?? NO_CANDIDATES);
  const busyIds = useWorkJournalCandidatesStore((s) => s.busyIds);
  const error = useWorkJournalCandidatesStore((s) => s.error);
  const refresh = useWorkJournalCandidatesStore((s) => s.refresh);
  const accept = useWorkJournalCandidatesStore((s) => s.accept);
  const reject = useWorkJournalCandidatesStore((s) => s.reject);
  const clearError = useWorkJournalCandidatesStore((s) => s.clearError);

  const running = useWorkJournalCandidateRunStore((s) => s.running);
  const runNotice = useWorkJournalCandidateRunStore((s) => s.runNotice);
  const runError = useWorkJournalCandidateRunStore((s) => s.runError);
  const nextRunAt = useWorkJournalCandidateRunStore((s) => s.nextRunAt);
  const catchUpPending = useWorkJournalCandidateRunStore((s) => s.catchUpPending);

  useEffect(() => {
    void refresh(date);
  }, [date, refresh]);

  const pending = candidates.filter((c) => c.state === "pending");
  const acceptHint = !hasPage
    ? "Create the page first"
    : readOnly
      ? "This page is read-only here"
      : running
        ? "Wait for the run to finish"
        : null;

  const runNow = (): void => {
    const store = useWorkJournalCandidateRunStore.getState();
    void store.runNow(store.projects);
  };

  return (
    <section
      aria-label="Suggestions"
      className="max-h-[38%] shrink-0 overflow-y-auto border-t border-maestro-border px-2.5 py-1.5 text-xs"
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-maestro-muted">
        <span className="font-semibold">
          {pending.length > 0 ? `Suggestions (${pending.length})` : "Suggestions"}
        </span>
        <span>
          next run {nextRunLabel(catchUpPending, nextRunAt)} ·{" "}
          <button
            type="button"
            onClick={runNow}
            disabled={running}
            className="text-maestro-accent hover:underline disabled:cursor-not-allowed disabled:text-maestro-muted disabled:no-underline"
          >
            {running ? "running…" : "run now"}
          </button>
        </span>
      </div>

      {(runNotice || runError) && (
        <p className={`mt-1 text-[10px] ${runError ? "text-maestro-red" : "text-maestro-muted"}`}>
          {runError ?? runNotice}
        </p>
      )}

      {error && (
        <div className="mt-1 flex items-start gap-1 text-[10px] text-maestro-red">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="rounded p-0.5 hover:bg-maestro-red/20"
            aria-label="Dismiss suggestion error"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {pending.length > 0 && !hasPage && (
        <p className="mt-1 text-[10px] text-maestro-muted">
          Create the page first to accept a suggestion.
        </p>
      )}

      {pending.length > 0 && hasPage && readOnly && (
        <p className="mt-1 text-[10px] text-maestro-muted">
          This page is read-only here, so a suggestion cannot be added to it.
        </p>
      )}

      {pending.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {pending.map((candidate) => {
            const busy = busyIds.includes(candidate.id);
            return (
              <li
                key={candidate.id}
                className="flex items-center gap-2 rounded-md border border-maestro-border bg-maestro-card px-1.5 py-1"
              >
                <span className="min-w-0 flex-1 break-words text-maestro-text">
                  {candidateLine(candidate)}
                </span>
                <span className="shrink-0 rounded border border-maestro-border px-1 text-[10px] text-maestro-muted">
                  {WORK_JOURNAL_SOURCE_LABELS[candidate.source] ?? candidate.source}
                </span>
                <button
                  type="button"
                  onClick={() => void accept(candidate)}
                  disabled={busy || acceptHint !== null}
                  className={`${ICON_BUTTON} hover:text-maestro-green`}
                  aria-label="Accept suggestion"
                  title={acceptHint ?? "Accept: add this line to the page"}
                >
                  <Check size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => void reject(candidate)}
                  disabled={busy}
                  className={`${ICON_BUTTON} hover:text-maestro-red`}
                  aria-label="Reject suggestion"
                  title="Reject: hide it for today"
                >
                  <X size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
