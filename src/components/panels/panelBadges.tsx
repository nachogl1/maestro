import { HealthAttentionBadge } from "@/components/shared/HealthAttentionBadge";
import {
  WorkJournalSuggestionsBadge,
  WorkJournalUnsavedDot,
} from "@/components/shared/WorkJournalSuggestionsBadge";

/** The Second Brain icon's health count, as the top-bar button showed it. */
export function SecondBrainBadge() {
  return <HealthAttentionBadge area="secondbrain" />;
}

/** The Work Journal icon's waiting-suggestions count and unsaved-changes dot. */
export function WorkJournalBadge() {
  return (
    <>
      <WorkJournalSuggestionsBadge />
      <WorkJournalUnsavedDot />
    </>
  );
}
