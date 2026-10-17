import { Loader2, Play } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { dialogButtonClass, dialogInputClass } from "@/components/shared/DialogShell";
import {
  clampRunEveryHours,
  MAX_RUN_EVERY_HOURS,
  useWorkJournalCandidateRunStore,
} from "@/stores/useWorkJournalCandidateRunStore";

/** "15 Oct 2026, 12:34" in the user's locale; the raw text if unparsable. */
function formatRunTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * "Last run: <when it started> (covered up to <how far it got>)". The start time
 * counts failed runs too; "not recorded" for a journal from before it was kept.
 * The "covered up to" part is left out when it reads the same as the start time.
 */
function lastRunLabel(lastAttemptAt: string | null, lastRunAt: string | null): string {
  const attempt = lastAttemptAt
    ? formatRunTime(lastAttemptAt)
    : lastRunAt
      ? "not recorded"
      : "never";
  const coveredTime = lastRunAt ? formatRunTime(lastRunAt) : null;
  const covered = coveredTime && coveredTime !== attempt ? ` (covered up to ${coveredTime})` : "";
  return `Last run: ${attempt}${covered}`;
}

/** Hover help for the rows, in plain language. */
const HINTS = {
  runEvery:
    "How often Claude looks through your recent activity and suggests lines for today's " +
    `journal page. Between 1 and ${MAX_RUN_EVERY_HOURS} hours.`,
  model:
    "Which Claude model writes the suggestions and the supervisor report. Leave it empty to " +
    "use the same model your " +
    "Claude setup uses by default.",
  runNow: "Look for journal suggestions right away instead of waiting for the next scheduled run.",
};

/** Commits the field on Enter by blurring it. */
function blurOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === "Enter") event.currentTarget.blur();
}

/**
 * The candidate-run rows of the Work Journal settings section: "Run every X
 * hours", the model, the last run time and "Run now". Errors show in the
 * section's error line. The settings are read by the app's background timer
 * on start; they are read again here only after that read failed.
 */
export function WorkJournalCandidateRunRows(): JSX.Element {
  const runEveryHours = useWorkJournalCandidateRunStore((s) => s.runEveryHours);
  const model = useWorkJournalCandidateRunStore((s) => s.model);
  const lastRunAt = useWorkJournalCandidateRunStore((s) => s.lastRunAt);
  const lastAttemptAt = useWorkJournalCandidateRunStore((s) => s.lastAttemptAt);
  const running = useWorkJournalCandidateRunStore((s) => s.running);
  const runNotice = useWorkJournalCandidateRunStore((s) => s.runNotice);
  const settingsError = useWorkJournalCandidateRunStore((s) => s.settingsError);
  const load = useWorkJournalCandidateRunStore((s) => s.load);
  const runNow = useWorkJournalCandidateRunStore((s) => s.runNow);
  const setRunEveryHours = useWorkJournalCandidateRunStore((s) => s.setRunEveryHours);
  const setModel = useWorkJournalCandidateRunStore((s) => s.setModel);

  const [hoursDraft, setHoursDraft] = useState(String(runEveryHours));
  const [modelDraft, setModelDraft] = useState(model);
  // Why the model shown in the field was not saved; kept after another save
  // clears the shared settings error, until the field is edited again.
  const [modelNote, setModelNote] = useState<string | null>(null);
  useEffect(() => setHoursDraft(String(runEveryHours)), [runEveryHours]);
  useEffect(() => {
    setModelDraft(model);
    setModelNote(null);
  }, [model]);

  // Retry once on open when the start-up read failed (the read error is the
  // only settings error present at mount).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only retry
  useEffect(() => {
    if (settingsError) void load();
  }, []);

  // After a commit the field always shows the clamped value, and once saved
  // the stored one (the store keeps the old value when the save fails).
  const commitHours = (): void => {
    const hours = Number(hoursDraft);
    if (hoursDraft.trim() === "" || !Number.isFinite(hours)) {
      setHoursDraft(String(runEveryHours));
      return;
    }
    const clamped = clampRunEveryHours(hours);
    setHoursDraft(String(clamped));
    if (clamped === runEveryHours) return;
    void setRunEveryHours(clamped).then(() => {
      setHoursDraft(String(useWorkJournalCandidateRunStore.getState().runEveryHours));
    });
  };

  const commitModel = (): void => {
    if (modelDraft.trim() === model.trim()) return;
    void setModel(modelDraft).then((saved) => {
      setModelNote(saved ? null : useWorkJournalCandidateRunStore.getState().settingsError);
    });
  };

  const handleRunNow = (): void => {
    void runNow(useWorkJournalCandidateRunStore.getState().projects);
  };

  return (
    <>
      <div className="flex items-center gap-2 text-xs" title={HINTS.runEvery}>
        <label htmlFor="work-journal-run-every" className="flex-1 cursor-help text-maestro-text">
          Run every
        </label>
        <input
          id="work-journal-run-every"
          type="number"
          min={1}
          max={MAX_RUN_EVERY_HOURS}
          step={1}
          value={hoursDraft}
          onChange={(e) => setHoursDraft(e.target.value)}
          onBlur={commitHours}
          onKeyDown={blurOnEnter}
          className={`w-16 text-right ${dialogInputClass}`}
        />
        <span className="shrink-0 text-maestro-muted">hours</span>
      </div>
      <div className="flex items-center gap-2 text-xs" title={HINTS.model}>
        <label htmlFor="work-journal-model" className="shrink-0 cursor-help text-maestro-text">
          Model
        </label>
        <input
          id="work-journal-model"
          type="text"
          value={modelDraft}
          placeholder="Your default Claude model"
          onChange={(e) => {
            setModelDraft(e.target.value);
            setModelNote(null);
          }}
          onBlur={commitModel}
          onKeyDown={blurOnEnter}
          className={`min-w-0 flex-1 text-right ${dialogInputClass}`}
        />
      </div>
      {modelNote && modelNote !== settingsError && (
        <p role="alert" className="text-[10px] text-maestro-red">
          {modelNote} Runs still use {model ? `"${model}"` : "your default model"}.
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] text-maestro-muted">
          {lastRunLabel(lastAttemptAt, lastRunAt)}
        </span>
        <button
          type="button"
          onClick={handleRunNow}
          disabled={running}
          title={HINTS.runNow}
          className={dialogButtonClass("primary")}
        >
          {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          Run now
        </button>
      </div>
      {runNotice && <p className="text-[10px] text-maestro-muted">{runNotice}</p>}
    </>
  );
}
