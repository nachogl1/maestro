import { invoke } from "@tauri-apps/api/core";
import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import {
  candidateLine,
  useWorkJournalCandidatesStore,
  WORK_JOURNAL_SOURCE_LABELS,
  type WorkJournalCandidate,
  type WorkJournalCandidateSource,
} from "@/stores/useWorkJournalCandidatesStore";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";

/** Stable empty list, so the selector does not return a new array each render. */
const NO_CANDIDATES: WorkJournalCandidate[] = [];

const GIT_TAG_COLOR = "border-maestro-orange/50 text-maestro-orange";

/** Source tag colours: one per source, one shared by the whole git family. */
const SOURCE_TAG_COLORS: Record<WorkJournalCandidateSource, string> = {
  github: GIT_TAG_COLOR,
  git: GIT_TAG_COLOR,
  pr: GIT_TAG_COLOR,
  issue: GIT_TAG_COLOR,
  claude: "border-maestro-blue/50 text-maestro-blue",
  terminal: "border-maestro-green/50 text-maestro-green",
  granola: "border-maestro-purple/50 text-maestro-purple",
};

/** For a source tag this build does not know. */
const DEFAULT_TAG_COLOR = "border-maestro-border text-maestro-muted";

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

/** The one-time Granola opt-in question (PRD "Granola connector"). */
export const GRANOLA_OPT_IN_QUESTION =
  "Use your Granola meeting notes for suggestions? Notes are sent to Claude and not stored.";

/** What `work_journal_granola_status` answers. */
interface GranolaStatus {
  connected: boolean;
}

/**
 * Whether to ask the Granola question: once per mount, only after the run
 * settings were read and while the choice was never made, ask the backend
 * whether Granola is connected (it runs `claude mcp get granola`, which checks
 * only that server; no meeting is read). Any failure counts as not connected.
 */
function useGranolaQuestion(): boolean {
  const granolaOptIn = useWorkJournalCandidateRunStore((s) => s.granolaOptIn);
  const settingsLoaded = useWorkJournalCandidateRunStore((s) => s.settingsLoaded);
  const checked = useRef(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!settingsLoaded || granolaOptIn !== null || checked.current) return;
    checked.current = true;
    invoke<GranolaStatus>("work_journal_granola_status")
      .then((status) => setConnected(status?.connected === true))
      .catch((error) => console.error("Failed to check whether Granola is connected:", error));
  }, [settingsLoaded, granolaOptIn]);

  return connected && granolaOptIn === null;
}

/** How much of a suggestion's line its Accept and Reject labels quote. */
const LABEL_TEXT_MAX = 60;

/** The suggestion's line for its button labels, cut to {@link LABEL_TEXT_MAX} characters. */
function labelText(candidate: WorkJournalCandidate): string {
  // Code points, so an emoji is never cut in half.
  const chars = Array.from(candidateLine(candidate));
  return chars.length > LABEL_TEXT_MAX
    ? `${chars.slice(0, LABEL_TEXT_MAX - 1).join("")}…`
    : chars.join("");
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
  const replacing = useWorkJournalStore((s) => s.replacing);

  const running = useWorkJournalCandidateRunStore((s) => s.running);
  const runNotice = useWorkJournalCandidateRunStore((s) => s.runNotice);
  const runError = useWorkJournalCandidateRunStore((s) => s.runError);
  const nextRunAt = useWorkJournalCandidateRunStore((s) => s.nextRunAt);
  const catchUpPending = useWorkJournalCandidateRunStore((s) => s.catchUpPending);
  const setGranolaOptIn = useWorkJournalCandidateRunStore((s) => s.setGranolaOptIn);
  const askGranola = useGranolaQuestion();
  const [granolaSaving, setGranolaSaving] = useState(false);
  const [granolaSaveFailed, setGranolaSaveFailed] = useState(false);

  useEffect(() => {
    void refresh(date);
  }, [date, refresh]);

  const pending = candidates.filter((c) => c.state === "pending");
  const acceptHint = !hasPage
    ? "Create the page first"
    : readOnly
      ? "This page is read-only here"
      : replacing
        ? "Wait for the restore to finish"
        : running
          ? "Wait for the run to finish"
          : null;

  const runNow = (): void => {
    const store = useWorkJournalCandidateRunStore.getState();
    void store.runNow(store.projects);
  };

  const answerGranola = async (optIn: boolean): Promise<void> => {
    setGranolaSaving(true);
    await setGranolaOptIn(optIn);
    setGranolaSaving(false);
    setGranolaSaveFailed(useWorkJournalCandidateRunStore.getState().granolaOptIn === null);
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

      {askGranola && (
        <div className="mt-1.5 rounded-md border border-maestro-accent/40 bg-maestro-accent/10 px-1.5 py-1 text-[11px] text-maestro-text">
          <p>{GRANOLA_OPT_IN_QUESTION}</p>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void answerGranola(true)}
              disabled={granolaSaving}
              className="rounded border border-maestro-accent/50 px-2 text-maestro-accent hover:bg-maestro-accent/20 disabled:opacity-50"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => void answerGranola(false)}
              disabled={granolaSaving}
              className="rounded border border-maestro-border px-2 text-maestro-muted hover:bg-maestro-card disabled:opacity-50"
            >
              No
            </button>
            {granolaSaveFailed && (
              <span className="text-[10px] text-maestro-red">
                Could not save your choice. Try again.
              </span>
            )}
          </div>
        </div>
      )}

      {runNotice && <p className="mt-1 text-[10px] text-maestro-muted">{runNotice}</p>}
      {runError && <p className="mt-1 text-[10px] text-maestro-red">{runError}</p>}

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
            const label = labelText(candidate);
            return (
              <li
                key={candidate.id}
                className="flex items-center gap-2 rounded-md border border-maestro-border bg-maestro-card px-1.5 py-1"
              >
                <span className="min-w-0 flex-1 break-words text-maestro-text">
                  {candidateLine(candidate)}
                </span>
                <span
                  className={`shrink-0 rounded border px-1 text-[10px] ${
                    SOURCE_TAG_COLORS[candidate.source] ?? DEFAULT_TAG_COLOR
                  }`}
                >
                  {WORK_JOURNAL_SOURCE_LABELS[candidate.source] ?? candidate.source}
                </span>
                <button
                  type="button"
                  onClick={() => void accept(candidate)}
                  disabled={busy || acceptHint !== null}
                  className={`${ICON_BUTTON} hover:text-maestro-green`}
                  aria-label={`Accept suggestion: ${label}`}
                  title={acceptHint ?? "Accept: add this line to the page"}
                >
                  <Check size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => void reject(candidate)}
                  disabled={busy || replacing}
                  className={`${ICON_BUTTON} hover:text-maestro-red`}
                  aria-label={`Reject suggestion: ${label}`}
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
