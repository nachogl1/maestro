import { useEffect, useRef } from "react";
import { useWorkJournalBackupTimer } from "@/hooks/useWorkJournalBackupTimer";
import { useWorkJournalCandidateTimer } from "@/hooks/useWorkJournalCandidateTimer";
import { useWorkJournalDayPages } from "@/hooks/useWorkJournalDayPages";
import { closeWorkJournalWindow } from "@/lib/workJournalWindow";
import { useWorkJournalCandidatesStore } from "@/stores/useWorkJournalCandidatesStore";
import { useWorkJournalEnabled } from "@/stores/useWorkJournalSettingsStore";

type JournalTabs = Parameters<typeof useWorkJournalCandidateTimer>[0];

export interface WorkJournalBackgroundWorkProps {
  tabs: JournalTabs;
}

/**
 * App-lifetime Work Journal background work, mounted once by `App`: runs
 * only while the user has the journal turned on, and stops (closing the
 * pop-out journal window) when they turn it off.
 */
export function WorkJournalBackgroundWork({ tabs }: WorkJournalBackgroundWorkProps) {
  const enabled = useWorkJournalEnabled();
  const wasEnabled = useRef(enabled);

  useEffect(() => {
    if (wasEnabled.current && !enabled) {
      closeWorkJournalWindow().catch((err) => {
        console.error("Failed to close the Work Journal window:", err);
      });
    }
    wasEnabled.current = enabled;
  }, [enabled]);

  return enabled ? <WorkJournalPollers tabs={tabs} /> : null;
}

/**
 * The day pages (on start and when the date changes), the daily backup
 * check, the candidate run and its suggestions badge listeners.
 */
function WorkJournalPollers({ tabs }: WorkJournalBackgroundWorkProps) {
  // Work Journal suggestions: keep the top-bar badge current whether or not
  // the pane is open (candidates event, window focus, restore or undo).
  useEffect(() => {
    const stopPromise = useWorkJournalCandidatesStore
      .getState()
      .initListeners()
      .catch((err) => {
        console.error("Failed to initialize Work Journal suggestion listeners:", err);
        return () => {};
      });
    return () => {
      stopPromise.then((stop) => stop());
    };
  }, []);

  useWorkJournalDayPages();
  useWorkJournalBackupTimer();
  useWorkJournalCandidateTimer(tabs);
  return null;
}
