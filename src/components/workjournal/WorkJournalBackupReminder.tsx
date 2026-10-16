import { X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  listenWorkJournalChanged,
  openWorkJournalSettingsInMainWindow,
} from "@/lib/workJournalWindow";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";

/** The reminder's text while no backup folder is chosen. */
export const BACKUP_REMINDER_TEXT =
  "No backup folder yet. Pick one in Settings to turn on the daily backup.";

export interface WorkJournalBackupReminderProps {
  /** Shown in the pop-out window: Settings then opens in the main window. */
  inWindow?: boolean;
}

/**
 * One-line reminder under the Work Journal header while no backup folder is
 * chosen, in the pane and the pop-out window, since the user may never open
 * Settings. "Open Settings" opens Maestro Settings in the main window at the
 * Work Journal section; the close button hides it in this window until it
 * closes or Maestro restarts. It reads the backup settings on mount and again
 * when another window changed the journal while it can still matter, so it
 * goes away as soon as a folder is chosen anywhere.
 */
export function WorkJournalBackupReminder({ inWindow = false }: WorkJournalBackupReminderProps) {
  const backupFolder = useWorkJournalBackupStore((s) => s.backupFolder);
  const loadError = useWorkJournalBackupStore((s) => s.loadError);
  const dismissed = useWorkJournalBackupStore((s) => s.reminderDismissed);
  const dismissReminder = useWorkJournalBackupStore((s) => s.dismissReminder);
  const openSettings = useWorkJournalBackupStore((s) => s.openSettings);
  // Hidden until the first read, so it never flashes for a folder that is set.
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const load = (): Promise<void> => useWorkJournalBackupStore.getState().load();
    void load().then(() => setChecked(true));
    // Re-read only while it can change what is shown: no folder yet, or a
    // restore or undo replaced the whole journal (and its settings); and
    // only when the settings changed.
    const stop = listenWorkJournalChanged((change) => {
      const state = useWorkJournalBackupStore.getState();
      if (!state.reminderDismissed && (!state.backupFolder || change.replaced)) void load();
    }, "settings").catch((err) => {
      console.error("Failed to follow Work Journal backup settings:", err);
      return () => {};
    });
    return () => {
      void stop.then((fn) => fn());
    };
  }, []);

  const handleOpenSettings = (): void => {
    if (!inWindow) {
      openSettings();
      return;
    }
    void openWorkJournalSettingsInMainWindow().catch((err) =>
      console.error("Failed to open Settings in the main window:", err),
    );
  };

  // A failed read is not proof that no folder is set, so it stays quiet.
  if (!checked || loadError || backupFolder || dismissed) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-maestro-border/60 bg-maestro-orange/10 px-3 py-1.5 text-xs text-maestro-orange">
      <span className="flex-1">{BACKUP_REMINDER_TEXT}</span>
      <button
        type="button"
        onClick={handleOpenSettings}
        className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-maestro-orange/20"
      >
        Open Settings
      </button>
      <button
        type="button"
        onClick={dismissReminder}
        className="rounded p-0.5 hover:bg-maestro-orange/20"
        aria-label="Dismiss backup reminder"
        title="Hidden in this window until it closes or Maestro restarts"
      >
        <X size={12} />
      </button>
    </div>
  );
}
