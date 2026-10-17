import { BookOpen } from "lucide-react";
import { DialogShell, dialogButtonClass } from "@/components/shared/DialogShell";
import { useUpdateStore } from "@/stores/useUpdateStore";
import {
  useWorkJournalSettingsLoaded,
  useWorkJournalSettingsStore,
} from "@/stores/useWorkJournalSettingsStore";

/**
 * First-run question, shown once after the app has loaded: turn the Work
 * Journal on or not. Any answer (closing counts as "Not now") is saved, so
 * the question never comes back; Maestro Settings can change it later.
 * Waits for the automatic-updates question to be answered first, so the two
 * first-run dialogs never stack (one Escape would otherwise answer both).
 */
export function WorkJournalOptInDialog() {
  const enabled = useWorkJournalSettingsStore((s) => s.enabled);
  const settingsLoaded = useWorkJournalSettingsLoaded();
  const setEnabled = useWorkJournalSettingsStore((s) => s.setEnabled);
  const updateQuestionAnswered = useUpdateStore((s) => s.autoInstallOnLaunch !== null);
  if (!settingsLoaded || !updateQuestionAnswered || enabled !== null) return null;

  const decline = () => setEnabled(false);

  return (
    <DialogShell
      title="Enable the Work Journal?"
      icon={<BookOpen size={14} />}
      onClose={decline}
      size="sm"
      closeOnOutsideClick={false}
      footer={
        <>
          <button type="button" onClick={decline} className={dialogButtonClass("ghost")}>
            Not now
          </button>
          <button
            type="button"
            onClick={() => setEnabled(true)}
            className={dialogButtonClass("primary")}
          >
            Enable
          </button>
        </>
      }
    >
      <p className="text-xs text-maestro-text">
        The Work Journal is a day-by-day diary of your work in Maestro, with suggested lines written
        by Claude from your activity.
      </p>
      <p className="text-[11px] text-maestro-muted">
        You can turn it on or off at any time in Maestro Settings.
      </p>
    </DialogShell>
  );
}
