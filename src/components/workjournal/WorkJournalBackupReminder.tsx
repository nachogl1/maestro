import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { MaestroSettingsModal } from "@/components/settings/MaestroSettingsModal";
import { listenWorkJournalChanged } from "@/lib/workJournalWindow";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";

/** The reminder's text while no backup folder is chosen. */
export const BACKUP_REMINDER_TEXT =
  "No backup folder yet. Pick one in Settings to turn on the daily backup.";

/**
 * One-line reminder under the Work Journal header while no backup folder is
 * chosen, in the pane and the pop-out window, since the user may never open
 * Settings. "Open Settings" opens Maestro Settings at the Work Journal
 * section; the close button hides it for this app session. It reads the
 * backup settings on mount and again when another window changed the
 * journal, so it goes away as soon as a folder is chosen anywhere.
 */
export function WorkJournalBackupReminder() {
  const backupFolder = useWorkJournalBackupStore((s) => s.backupFolder);
  const loadError = useWorkJournalBackupStore((s) => s.loadError);
  const dismissed = useWorkJournalBackupStore((s) => s.reminderDismissed);
  const dismissReminder = useWorkJournalBackupStore((s) => s.dismissReminder);
  // Hidden until the first read, so it never flashes for a folder that is set.
  const [checked, setChecked] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const load = (): Promise<void> => useWorkJournalBackupStore.getState().load();
    void load().then(() => setChecked(true));
    const stop = listenWorkJournalChanged(() => void load()).catch((err) => {
      console.error("Failed to follow Work Journal backup settings:", err);
      return () => {};
    });
    return () => {
      void stop.then((fn) => fn());
    };
  }, []);

  // A failed read is not proof that no folder is set, so it stays quiet.
  const show = checked && !loadError && !backupFolder && !dismissed;

  return (
    <>
      {show && (
        <div className="flex shrink-0 items-center gap-2 border-b border-maestro-border/60 bg-maestro-orange/10 px-3 py-1.5 text-xs text-maestro-orange">
          <span className="flex-1">{BACKUP_REMINDER_TEXT}</span>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-maestro-orange/20"
          >
            Open Settings
          </button>
          <button
            type="button"
            onClick={dismissReminder}
            className="rounded p-0.5 hover:bg-maestro-orange/20"
            aria-label="Dismiss backup reminder"
            title="Hide until Maestro starts again"
          >
            <X size={12} />
          </button>
        </div>
      )}
      {settingsOpen && (
        <MaestroSettingsModal focusSection="work-journal" onClose={() => setSettingsOpen(false)} />
      )}
    </>
  );
}
