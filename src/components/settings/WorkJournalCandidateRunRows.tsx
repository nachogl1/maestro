import { Loader2, Play } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import {
  MAX_RUN_EVERY_HOURS,
  useWorkJournalCandidateRunStore,
} from "@/stores/useWorkJournalCandidateRunStore";

/** "15 Oct 2026, 12:34" in the user's locale; the raw text if unparsable. */
function formatRunTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

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
  const running = useWorkJournalCandidateRunStore((s) => s.running);
  const settingsError = useWorkJournalCandidateRunStore((s) => s.settingsError);
  const load = useWorkJournalCandidateRunStore((s) => s.load);
  const runNow = useWorkJournalCandidateRunStore((s) => s.runNow);
  const setRunEveryHours = useWorkJournalCandidateRunStore((s) => s.setRunEveryHours);
  const setModel = useWorkJournalCandidateRunStore((s) => s.setModel);

  const [hoursDraft, setHoursDraft] = useState(String(runEveryHours));
  const [modelDraft, setModelDraft] = useState(model);
  useEffect(() => setHoursDraft(String(runEveryHours)), [runEveryHours]);
  useEffect(() => setModelDraft(model), [model]);

  // Retry once on open when the start-up read failed (the read error is the
  // only settings error present at mount).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only retry
  useEffect(() => {
    if (settingsError) void load();
  }, []);

  const commitHours = (): void => {
    const hours = Number(hoursDraft);
    if (hoursDraft.trim() === "" || !Number.isFinite(hours)) {
      setHoursDraft(String(runEveryHours));
      return;
    }
    if (hours === runEveryHours) return;
    void setRunEveryHours(hours);
  };

  const commitModel = (): void => {
    if (modelDraft.trim() === model.trim()) return;
    void setModel(modelDraft);
  };

  const handleRunNow = (): void => {
    void runNow(useWorkJournalCandidateRunStore.getState().projects);
  };

  return (
    <>
      <div className="flex items-center gap-2 text-xs">
        <label htmlFor="work-journal-run-every" className="flex-1 text-maestro-muted">
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
          className="w-14 rounded border border-maestro-border bg-maestro-surface px-1.5 py-0.5 text-right text-[11px] text-maestro-text outline-none focus:border-maestro-accent"
        />
        <span className="shrink-0 text-maestro-muted">hours</span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <label htmlFor="work-journal-model" className="shrink-0 text-maestro-muted">
          Model
        </label>
        <input
          id="work-journal-model"
          type="text"
          value={modelDraft}
          placeholder="Your default Claude model"
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={commitModel}
          onKeyDown={blurOnEnter}
          className="min-w-0 flex-1 rounded border border-maestro-border bg-maestro-surface px-1.5 py-0.5 text-right text-[11px] text-maestro-text placeholder-maestro-muted/50 outline-none focus:border-maestro-accent"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[10px] text-maestro-muted">
          {`Last run: ${lastRunAt ? formatRunTime(lastRunAt) : "never"}`}
        </span>
        <button
          type="button"
          onClick={handleRunNow}
          disabled={running}
          className="flex items-center gap-1 rounded border border-maestro-accent/50 bg-maestro-accent/10 px-3 py-1 text-[11px] font-medium text-maestro-accent hover:bg-maestro-accent/20 disabled:opacity-50"
        >
          {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          Run now
        </button>
      </div>
    </>
  );
}
