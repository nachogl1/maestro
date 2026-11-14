import {
  WorkJournalSuggestionsBadge,
  WorkJournalUnsavedDot,
} from "@/components/shared/WorkJournalSuggestionsBadge";

/** The Work Journal icon's waiting-suggestions count and unsaved-changes dot. */
export function WorkJournalBadge() {
  return (
    <>
      <WorkJournalSuggestionsBadge />
      <WorkJournalUnsavedDot />
    </>
  );
}
