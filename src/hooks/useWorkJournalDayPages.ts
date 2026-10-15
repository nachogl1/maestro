import { useEffect } from "react";
import { localDateString, msUntilNextLocalMidnight } from "@/lib/workJournalDates";
import { isWorkJournalWindowView } from "@/lib/workJournalWindow";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";

/**
 * Slack after local midnight before the day pages are created, so a timer
 * that fires a moment early still sees the new date.
 */
const MIDNIGHT_SLACK_MS = 1_000;

/**
 * How often the local date is compared. A cheap string compare that catches
 * what the midnight timer misses: a PC that slept through midnight (timers
 * pause) or a clock or time-zone change.
 */
export const WORK_JOURNAL_DATE_CHECK_MS = 60_000;

/**
 * Work Journal day pages, mounted once via `useBackgroundPollers` in the main
 * window: creates the missing day pages up to today on start, and again when
 * the local date changes while Maestro runs (midnight timer, a once-a-minute
 * date compare, window focus or visibility), with the pane open or closed.
 * The pane keeps its own calls; the store shares a call for the same date
 * while it runs. The pop-out window never runs this.
 */
export function useWorkJournalDayPages(): void {
  useEffect(() => {
    if (isWorkJournalWindowView(window.location.search)) return;
    let knownDate = localDateString(new Date());
    void useWorkJournalStore.getState().ensurePages(knownDate);

    const checkDate = (): void => {
      const now = localDateString(new Date());
      if (now === knownDate) return;
      knownDate = now;
      void useWorkJournalStore.getState().ensurePages(now);
    };
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => {
        checkDate();
        arm();
      }, msUntilNextLocalMidnight(new Date()) + MIDNIGHT_SLACK_MS);
    };
    arm();
    const interval = setInterval(checkDate, WORK_JOURNAL_DATE_CHECK_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") checkDate();
    };
    window.addEventListener("focus", checkDate);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("focus", checkDate);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
