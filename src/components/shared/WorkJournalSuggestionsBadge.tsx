import {
  pendingTodayCount,
  useWorkJournalCandidatesStore,
} from "@/stores/useWorkJournalCandidatesStore";

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
