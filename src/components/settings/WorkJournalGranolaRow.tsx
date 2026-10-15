import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";

/** The select's value while the choice was never made. */
const NOT_ASKED = "unset";

/**
 * The "Granola meeting notes" row of the Work Journal settings section: the
 * opt-in as Yes, No or "Not asked yet", changeable to Yes or No (the same
 * choice the suggestions box asks for once). Errors show in the section's
 * error line.
 */
export function WorkJournalGranolaRow(): JSX.Element {
  const granolaOptIn = useWorkJournalCandidateRunStore((s) => s.granolaOptIn);
  const setGranolaOptIn = useWorkJournalCandidateRunStore((s) => s.setGranolaOptIn);

  const value = granolaOptIn === null ? NOT_ASKED : granolaOptIn ? "yes" : "no";

  return (
    <div
      className="flex items-center gap-2 text-xs"
      title="When Granola is connected in your Claude setup, suggestions also cover your meetings. Notes are sent to Claude and not stored."
    >
      <label htmlFor="work-journal-granola" className="flex-1 text-maestro-muted">
        Granola meeting notes
      </label>
      <select
        id="work-journal-granola"
        value={value}
        onChange={(e) => {
          if (e.target.value !== NOT_ASKED) void setGranolaOptIn(e.target.value === "yes");
        }}
        className="rounded border border-maestro-border bg-maestro-surface px-1.5 py-0.5 text-[11px] text-maestro-text outline-none"
      >
        {granolaOptIn === null && (
          <option value={NOT_ASKED} disabled>
            Not asked yet
          </option>
        )}
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </div>
  );
}
