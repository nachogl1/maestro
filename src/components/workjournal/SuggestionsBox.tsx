import { invoke } from "@tauri-apps/api/core";
import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import {
  candidateLine,
  candidateProject,
  isUpdateCandidate,
  useWorkJournalCandidatesStore,
  type WorkJournalCandidate,
} from "@/stores/useWorkJournalCandidatesStore";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";
import { WorkJournalSourceTag } from "./WorkJournalSourceTag";

/** Stable empty list, so the selector does not return a new array each render. */
const NO_CANDIDATES: WorkJournalCandidate[] = [];

const ICON_BUTTON =
  "rounded p-0.5 transition-colors hover:bg-maestro-card disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

/** The header's small text buttons (bulk Accept and Reject, and the reject question's Yes / No). */
const HEADER_BUTTON =
  "rounded border px-1.5 font-normal transition-colors disabled:cursor-not-allowed disabled:opacity-40";

/** From how many pending suggestions the bulk buttons show (the tick boxes show from one). */
const BULK_MIN_PENDING = 2;

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

/**
 * An update suggestion's heading, "Updates your HH:MM <project> entry", with no
 * time for an untimed card.
 */
function updateLabel(candidate: WorkJournalCandidate): string {
  const time = candidate.updates?.time ?? candidate.time;
  const project = candidateProject(candidate);
  return ["Updates your", time, project, "entry"].filter(Boolean).join(" ");
}

/**
 * What a tick remembers of its suggestion: the text it showed when ticked. A
 * suggestion a run rewrote in place no longer matches, so it loses its tick
 * and text the person never read is never accepted.
 */
function tickKey(candidate: WorkJournalCandidate): string {
  return JSON.stringify([
    candidate.time ?? null,
    candidate.text,
    candidate.updates?.time ?? null,
    candidate.updates?.text ?? null,
  ]);
}

/** Ticked suggestions: id to {@link tickKey} at the time of the tick. */
type Ticks = Record<string, string>;

/** The ticks for `list`, each as it reads now. */
function ticksFor(list: WorkJournalCandidate[]): Ticks {
  return Object.fromEntries(list.map((c) => [c.id, tickKey(c)]));
}

/** The suggestions of `list` that `ticks` holds as they read now, in list order. */
function tickedIn(list: WorkJournalCandidate[], ticks: Ticks): WorkJournalCandidate[] {
  return list.filter((c) => ticks[c.id] === tickKey(c));
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
 * candidates, each with its text, its project (in that project's colour, when
 * it has one), its source tag, and green Accept and red Reject icons kept apart,
 * and a footer "next run · run now". An update suggestion says which entry it
 * updates and shows that entry's current text grey and struck through above
 * the new text. With nothing pending only the footer shows, so "run now" is
 * always reachable.
 */
export function SuggestionsBox({ date, hasPage, readOnly = false }: SuggestionsBoxProps) {
  const candidates = useWorkJournalCandidatesStore((s) => s.byDate[date] ?? NO_CANDIDATES);
  const busyIds = useWorkJournalCandidatesStore((s) => s.busyIds);
  const error = useWorkJournalCandidatesStore((s) => s.error);
  const refresh = useWorkJournalCandidatesStore((s) => s.refresh);
  const accept = useWorkJournalCandidatesStore((s) => s.accept);
  const reject = useWorkJournalCandidatesStore((s) => s.reject);
  const acceptMany = useWorkJournalCandidatesStore((s) => s.acceptMany);
  const rejectMany = useWorkJournalCandidatesStore((s) => s.rejectMany);
  const clearError = useWorkJournalCandidatesStore((s) => s.clearError);
  const replacing = useWorkJournalStore((s) => s.replacing);
  const projectColors = useProjectColors();

  const running = useWorkJournalCandidateRunStore((s) => s.running);
  const runNotice = useWorkJournalCandidateRunStore((s) => s.runNotice);
  const granolaNotice = useWorkJournalCandidateRunStore((s) => s.granolaNotice);
  const runError = useWorkJournalCandidateRunStore((s) => s.runError);
  const nextRunAt = useWorkJournalCandidateRunStore((s) => s.nextRunAt);
  const catchUpPending = useWorkJournalCandidateRunStore((s) => s.catchUpPending);
  const setGranolaOptIn = useWorkJournalCandidateRunStore((s) => s.setGranolaOptIn);
  const askGranola = useGranolaQuestion();
  const [granolaSaving, setGranolaSaving] = useState(false);
  const [granolaSaveFailed, setGranolaSaveFailed] = useState(false);
  const [ticks, setTicks] = useState<Ticks>({});
  /** The suggestions the in-place "Reject N?" question is about; null when not asking. */
  const [rejectAsk, setRejectAsk] = useState<Ticks | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  // Another day clears the ticks and the question (set during render, so the
  // new day never shows the old day's ticks).
  const [ticksDate, setTicksDate] = useState(date);
  if (ticksDate !== date) {
    setTicksDate(date);
    setTicks({});
    setRejectAsk(null);
  }
  const dateRef = useRef(date);
  dateRef.current = date;

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
  const ticked = tickedIn(pending, ticks);
  const bulkTargets = ticked.length > 0 ? ticked : pending;
  const showBulk = pending.length >= BULK_MIN_PENDING;
  const allTicked = pending.length > 0 && ticked.length === pending.length;
  const ticksLocked = bulkRunning || rejectAsk !== null;
  const bulkCount = ticked.length > 0 ? String(ticked.length) : "all";

  const toggleTick = (candidate: WorkJournalCandidate): void =>
    setTicks((current) => {
      const next = { ...current };
      if (next[candidate.id] === tickKey(candidate)) delete next[candidate.id];
      else next[candidate.id] = tickKey(candidate);
      return next;
    });

  /** Runs a bulk action; the suggestions it could not do stay (or become) ticked. */
  const runBulk = async (
    action: (list: WorkJournalCandidate[]) => Promise<string[]>,
    targets: WorkJournalCandidate[],
  ): Promise<void> => {
    const startedOn = date;
    setBulkRunning(true);
    const failed = await action(targets);
    setBulkRunning(false);
    if (dateRef.current !== startedOn) return;
    setTicks(ticksFor(targets.filter((c) => failed.includes(c.id))));
  };

  const confirmReject = (): void => {
    const targets = rejectAsk ? tickedIn(pending, rejectAsk) : [];
    setRejectAsk(null);
    if (targets.length > 0) void runBulk(rejectMany, targets);
  };

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
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-maestro-muted">
        <div className="flex items-center gap-1.5">
          {pending.length > 0 && (
            <input
              type="checkbox"
              className="m-0 shrink-0"
              aria-label="Select all suggestions"
              checked={allTicked}
              ref={(el) => {
                if (el) el.indeterminate = ticked.length > 0 && !allTicked;
              }}
              onChange={() => setTicks(allTicked ? {} : ticksFor(pending))}
              disabled={ticksLocked}
            />
          )}
          <span className="font-semibold">
            {pending.length > 0 ? `Suggestions (${pending.length})` : "Suggestions"}
          </span>
          {rejectAsk !== null ? (
            <fieldset
              aria-label="Confirm reject"
              className="m-0 flex items-center gap-1.5 border-0 p-0"
            >
              <span className="text-maestro-text">{`Reject ${Object.keys(rejectAsk).length}?`}</span>
              <button
                type="button"
                onClick={confirmReject}
                disabled={replacing}
                className={`${HEADER_BUTTON} border-maestro-red/50 text-maestro-red hover:bg-maestro-red/20`}
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setRejectAsk(null)}
                className={`${HEADER_BUTTON} border-maestro-border hover:bg-maestro-card`}
              >
                No
              </button>
            </fieldset>
          ) : (
            showBulk && (
              <>
                <button
                  type="button"
                  onClick={() => void runBulk(acceptMany, bulkTargets)}
                  disabled={bulkRunning || acceptHint !== null}
                  className={`${HEADER_BUTTON} border-maestro-green/50 text-maestro-green hover:bg-maestro-green/20`}
                  title={
                    acceptHint ??
                    (ticked.length > 0
                      ? "Accept the ticked suggestions, in list order"
                      : "Accept every suggestion of this day, in list order")
                  }
                >
                  {`Accept ${bulkCount}`}
                </button>
                <button
                  type="button"
                  onClick={() => setRejectAsk(ticksFor(bulkTargets))}
                  disabled={bulkRunning || replacing}
                  className={`${HEADER_BUTTON} border-maestro-red/50 text-maestro-red hover:bg-maestro-red/20`}
                  title={
                    ticked.length > 0
                      ? "Reject the ticked suggestions: hide them for today"
                      : "Reject every suggestion of this day: hide them for today"
                  }
                >
                  {`Reject ${bulkCount}`}
                </button>
              </>
            )
          )}
        </div>
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
      {granolaNotice && <p className="mt-1 text-[10px] text-maestro-muted">{granolaNotice}</p>}
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
            const update = isUpdateCandidate(candidate);
            const label = labelText(candidate);
            const project = candidateProject(candidate);
            const projectColor = project
              ? (projectColors.get(project) ?? projectColorFor(project))
              : null;
            return (
              <li
                key={candidate.id}
                className="flex flex-col gap-1 rounded-md border border-maestro-border bg-maestro-card px-1.5 py-1"
              >
                {/* The text gets the full width; pills and buttons share the row beneath it. */}
                {update ? (
                  <>
                    <span className="text-[10px] font-semibold text-maestro-muted">
                      {updateLabel(candidate)}
                    </span>
                    <span
                      data-testid="suggestion-old-text"
                      className="break-words text-maestro-muted line-through"
                    >
                      {candidate.updates?.text}
                    </span>
                    <span className="break-words text-maestro-text">{candidate.text}</span>
                  </>
                ) : (
                  <span className="break-words text-maestro-text">{candidateLine(candidate)}</span>
                )}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      className="m-0 shrink-0"
                      aria-label={`Select suggestion: ${label}`}
                      checked={ticks[candidate.id] === tickKey(candidate)}
                      onChange={() => toggleTick(candidate)}
                      disabled={ticksLocked}
                    />
                    {project && projectColor && (
                      <span
                        data-testid="suggestion-project"
                        className="max-w-[10rem] shrink-0 truncate rounded-full border px-1.5 text-[10px]"
                        style={{ color: projectColor, borderColor: projectColor }}
                        title={`Project: ${project}`}
                      >
                        {project}
                      </span>
                    )}
                    <WorkJournalSourceTag source={candidate.source} />
                  </div>
                  {/* gap-6 (24px) is wider than one button (17px), so one is not hit for the other. */}
                  <div className="flex shrink-0 items-center gap-6">
                    <button
                      type="button"
                      onClick={() => void accept(candidate)}
                      disabled={busy || bulkRunning || acceptHint !== null}
                      className={`${ICON_BUTTON} text-maestro-green`}
                      aria-label={`Accept suggestion: ${label}`}
                      title={
                        acceptHint ??
                        (update
                          ? "Accept: rewrite your entry with this text"
                          : "Accept: add a card at the end of the page")
                      }
                    >
                      <Check size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void reject(candidate)}
                      disabled={busy || bulkRunning || replacing}
                      className={`${ICON_BUTTON} text-maestro-red`}
                      aria-label={`Reject suggestion: ${label}`}
                      title={
                        update
                          ? "Reject: keep your entry as it is and hide this for today"
                          : "Reject: hide it for today"
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
