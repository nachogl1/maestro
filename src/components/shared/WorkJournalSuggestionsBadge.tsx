import {
  pendingTodayCount,
  useWorkJournalCandidatesStore,
} from "@/stores/useWorkJournalCandidatesStore";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";

/**
 * The top-bar Work Journal button's accessible name. The button's label hides
 * its badge and dot from screen readers, so it says what they show, e.g.
 * "Work Journal, 3 suggestions waiting, unsaved changes".
 */
export function useWorkJournalButtonLabel(): string {
  const count = useWorkJournalCandidatesStore(pendingTodayCount);
  const unsaved = useWorkJournalStore((s) => s.unsavedDates.length > 0);
  let label = "Work Journal";
  if (count > 0) label += `, ${count} ${count === 1 ? "suggestion" : "suggestions"} waiting`;
  if (unsaved) label += ", unsaved changes";
  return label;
}

/**
 * Count badge on the top-bar Work Journal button: today's pending
 * suggestions. Other days and rejected ones do not count; renders nothing at
 * zero. The parent button must be `relative`.
 */
export function WorkJournalSuggestionsBadge() {
  const count = useWorkJournalCandidatesStore(pendingTodayCount);
  if (count === 0) return null;
  return (
    <span
      role="img"
      className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-[13px] rounded-full bg-maestro-accent px-1 text-center text-[8px] font-bold leading-[13px] text-maestro-bg"
      aria-label={`${count} Work Journal ${count === 1 ? "suggestion" : "suggestions"} for today`}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * Dot on the top-bar Work Journal button while some page text could not be
 * saved (it is being retried). Shown with the pane closed too. The parent
 * button must be `relative`.
 */
export function WorkJournalUnsavedDot() {
  const unsaved = useWorkJournalStore((s) => s.unsavedDates.length > 0);
  if (!unsaved) return null;
  return (
    <span
      role="img"
      className="pointer-events-none absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-maestro-orange"
      aria-label="Work Journal has unsaved changes"
    />
  );
}
