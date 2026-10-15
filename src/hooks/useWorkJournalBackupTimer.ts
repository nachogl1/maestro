import { useEffect } from "react";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";

/** How often the Work Journal backup checks whether its daily backup is due. */
export const WORK_JOURNAL_BACKUP_CHECK_MS = 60 * 60 * 1000;

/**
 * Work Journal backup timer, mounted once via `useBackgroundPollers`: one
 * check on start, then one every hour. The backend backs up only when a
 * folder is set and the last backup is a day old, so most checks write
 * nothing. In-app only; no OS scheduler.
 */
export function useWorkJournalBackupTimer(): void {
  useEffect(() => {
    const runCheck = (): void => void useWorkJournalBackupStore.getState().backUpIfDue();
    runCheck();
    const interval = setInterval(runCheck, WORK_JOURNAL_BACKUP_CHECK_MS);
    return () => clearInterval(interval);
  }, []);
}
